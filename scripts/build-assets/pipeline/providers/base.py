"""
★ SegmentProvider —— 主体分割的**可插拔接口**
================================================================================
这是整个素材流水线里最需要"可替换"的一环，因为分割质量强依赖于：
  ▸ 图片类型（无缝影棚背景 vs 复杂自然场景）
  ▸ 可用算力（本地 CPU / GPU / 远程 API）
  ▸ 精度要求（做 demo 还是做交付）

所以**不把任何一种算法写死在 pipeline 里**，而是定义这个接口，
pipeline 只依赖接口。想换算法就换一个 Provider，pipeline 一行不用改。

--------------------------------------------------------------------------------
【本文件为什么是 Python 而不是 TypeScript】
用户原始设计里写的是：
    interface SegmentProvider { segment(image): Promise<SegmentResult> }

这个**契约**是对的，但语言选 TS 会带来两个实际问题：
  1. 分割的实质是像素运算（连通域标记、形态学、金字塔填充），
     这些在 numpy/PIL 里是几十行，在 Node 里要自己实现或引重依赖。
  2. `npm run build-assets` 是构建期动作，Node 侧跑 TS 需要额外的 loader 或预编译，
     为了一次性脚本引入 tsx/esbuild 是净负担。

所以：**分割在 Python 侧实现**（本目录），
      **"manifest → SceneConfig" 的转换在 TS 侧实现**（src/asset-pipeline/）。
      两边通过 generated/content.json 这个中间契约对接 —— 都是类型化的，
      而且各自的工具链都是最顺手的。

接口语义与用户原始设计完全一致（segment(image) -> SegmentResult），只是换了语言。
================================================================================
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class SegmentResult:
    """一次分割的产物。"""

    #: 前景掩码，bool 数组，形状与原图 (H, W) 一致。
    #: True = 属于某个主体，False = 背景。
    mask: np.ndarray

    #: 每个主体的独立掩码（已按面积降序）。
    #: 长度 = 检测到的主体数。color-key provider 会把连通域拆开填在这里。
    subjects: list[np.ndarray] = field(default_factory=list)

    #: 背景估计色（0..255 的 float32，形状 (3,)）。仅色键类 provider 有值。
    background_color: np.ndarray | None = None

    #: provider 名 + 参数，写进 manifest 便于复现
    provider: str = "unknown"
    params: dict[str, Any] = field(default_factory=dict)

    #: 诊断信息：给人类看的，写进 manifest 和终端输出
    notes: list[str] = field(default_factory=list)

    #: 置信度："high" | "medium" | "low"
    #: ★ 存在的理由：**不要静默地产出垃圾掩码**。
    #:   色键控有明确的适用边界（背景非均匀、主体低对比时会失败），
    #:   越界时必须让用户知道，而不是让他到渲染结果里才发现。
    #:   pipeline 会把它透传到 manifest，报告页也会据此显示警告。
    confidence: str = "high"

    #: 机器可读的诊断量（阈值、是否触发自适应、对比裕度等）。
    #: 与 notes 的区别：notes 是给人看的叙述，diagnostics 是给报告/CI 判断用的。
    diagnostics: dict[str, Any] = field(default_factory=dict)


class SegmentProvider(ABC):
    """
    主体分割的抽象接口。

    实现者只需要关心"给一张图，返回掩码"，不需要知道：
      ▸ 图从哪来（input/ 目录？远程？）
      ▸ 结果往哪去（透明 PNG？WebP？）
      ▸ 后续怎么排布（那是 SceneGenerator 的事）

    这是标准的**单一职责 + 依赖倒置**：pipeline 依赖这个接口，不依赖任何具体算法。
    """

    #: 写进 manifest 的标识
    name: str = "abstract"

    @abstractmethod
    def segment(self, image: np.ndarray) -> SegmentResult:
        """
        @param image  RGB uint8 数组，形状 (H, W, 3)
        @return      SegmentResult
        """
        raise NotImplementedError

    def describe(self) -> str:
        return self.name


# ------------------------------------------------------------------ 注册表

_REGISTRY: dict[str, type[SegmentProvider]] = {}


def register(cls: type[SegmentProvider]) -> type[SegmentProvider]:
    """把 provider 类登记进注册表，供 --provider=xxx 按名选择。"""
    _REGISTRY[cls.name] = cls
    return cls


def get_provider(name: str, **kwargs: Any) -> SegmentProvider:
    """按名构造一个 provider。未知名字会给出可用列表而不是 KeyError。"""
    if name not in _REGISTRY:
        available = ", ".join(sorted(_REGISTRY)) or "(无)"
        raise SystemExit(
            f"[segment] 未知的 provider: {name!r}\n"
            f"  可用: {available}\n"
            f"  → 用 --provider=<name> 指定，或 --list-providers 查看详情。"
        )
    return _REGISTRY[name](**kwargs)


def list_providers() -> list[str]:
    return sorted(_REGISTRY)


def load_builtin_providers() -> None:
    """
    导入内置 provider 模块，触发 @register。

    为什么要显式调用而不是靠 import 副作用：
      provider 可能带重依赖（rembg 要 onnxruntime，几十 MB），
      不该在 `--list-providers` 时就把它们全 import 进来。
      所以这里只 import 无重依赖的那几个，重依赖的按需 import。
    """
    from . import colorkey, manual  # noqa: F401

    # rembg 按需加载：装了才注册
    try:
        from . import rembg_provider  # noqa: F401
    except ImportError:
        pass
