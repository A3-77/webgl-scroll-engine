"""
RembgSegmentProvider —— 接 rembg / U²-Net 本地模型
================================================================================
【什么时候该用它】
  ▸ 背景不是纯色/平滑渐变（自然场景、街拍、复杂室内）
  ▸ 主体边缘复杂（毛发、半透明、网纱）
  ▸ 想一套参数吃所有图，不想为每张图调阈值

【代价】
  ▸ 首次运行会下载约 176MB 的 onnx 模型（之后离线可用）
  ▸ 需要 onnxruntime，安装体积较大
  ▸ 单张图约 1-5 秒（CPU）
  ▸ 边缘可能"糊" —— 模型输出的是概率图，毛发边缘常有半透明拖尾；
    如果目标是锐利毛边，colorkey + 反混合反而更好

【为什么默认不装】
  `pip install rembg` 会拉进 onnxruntime（几十 MB），
  而本项目的默认场景（无缝影棚背景的猫图）用 colorkey 已经能得到更好的结果。
  所以做成"装了才注册"，不强制所有人承担这个依赖。

【安装】
  <venv>/Scripts/pip install rembg onnxruntime
  （首次 segment 时会自动下载 u2net.onnx）

【实现要点】
  rembg 的 remove() 返回的是**带 alpha 的 PNG 字节流**，不是掩码数组。
  这里把它解码回 alpha 通道作为掩码 —— 也就是"把模型输出的软掩码当硬掩码用"。
  为什么不直接用软 alpha：软 alpha 边缘是模型的不确定性，不是真实的抗锯齿，
  直接用它会让主体边缘发灰。所以这里二值化后再走统一的羽化流程，
  保证和 colorkey 走同一条边缘处理路径，观感一致。
================================================================================
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np

from .. import imaging as im
from .base import SegmentProvider, SegmentResult, register


@register
class RembgSegmentProvider(SegmentProvider):
    name = "rembg"

    def __init__(
        self,
        model: str = "u2net",
        alpha_threshold: float = 0.5,
        min_area_ratio: float = 0.004,
        **_: Any,
    ) -> None:
        try:
            from rembg import new_session  # noqa: F401
        except ImportError as e:
            raise SystemExit(
                "[segment] rembg 未安装。\n"
                "  → <venv>/Scripts/pip install rembg onnxruntime\n"
                f"  → 原始错误: {e}"
            ) from e

        self.model_name = model
        self.alpha_threshold = alpha_threshold
        self.min_area_ratio = min_area_ratio
        self._session = None

    def describe(self) -> str:
        return f"rembg(model={self.model_name}, alpha_thresh={self.alpha_threshold})"

    def _ensure_session(self) -> Any:
        if self._session is None:
            from rembg import new_session

            self._session = new_session(self.model_name)
        return self._session

    def segment(self, image: np.ndarray) -> SegmentResult:
        from PIL import Image
        from rembg import remove

        session = self._ensure_session()
        H, W = image.shape[:2]

        out = remove(
            Image.fromarray(image.astype(np.uint8)),
            session=session,
            # 关掉 alpha matting：它会让边缘更软，与我们要的"锐利毛边"目标相反
            alpha_matting=False,
        )
        rgba = np.asarray(out)
        if rgba.shape[2] < 4:
            raise SystemExit("[segment] rembg 返回的不是 RGBA —— 无法取 alpha 通道")

        alpha = rgba[:, :, 3].astype(np.float32) / 255.0
        mask = alpha >= self.alpha_threshold

        mask = im.fill_holes(mask)
        mask = im.opening(mask, 1)

        labels, n = im.label_components(mask)
        min_area = self.min_area_ratio * H * W
        subjects: list[np.ndarray] = []
        for lab in range(1, n + 1):
            sub = labels == lab
            if int(sub.sum()) >= min_area:
                subjects.append(sub)
        subjects.sort(key=lambda s: -int(s.sum()))

        merged = np.zeros((H, W), dtype=bool)
        for s in subjects:
            merged |= s

        return SegmentResult(
            mask=merged,
            subjects=subjects,
            background_color=None,
            provider=self.name,
            params={
                "model": self.model_name,
                "alpha_threshold": self.alpha_threshold,
                "min_area_ratio": self.min_area_ratio,
            },
            notes=[
                f"rembg({self.model_name}) 输出 {n} 个连通域，保留 {len(subjects)} 个",
                "注意：模型输出的软 alpha 已被二值化，边缘由统一的羽化流程处理",
            ],
        )
