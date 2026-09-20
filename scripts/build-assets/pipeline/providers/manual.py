"""
ManualMaskProvider —— 手工掩码
================================================================================
**这是最诚实、也是最后必须存在的 provider。**

自动分割一定会有它做不好的图。当用户遇到那种图时，唯一的出路是
"我自己在 Photoshop / GIMP / 任何画图工具里画一个 mask"。
如果架构里没有这条路径，用户就卡死了 —— 所以他必须存在。

用法：
    input/masks/scene01.png     ← 白 = 主体，黑 = 背景（灰度或带 alpha 都行）

约定（三条，都很宽松）：
  1. 文件名必须与源图同名（scene01.jpg → scene01.png）
  2. 尺寸不必与原图一致 —— 会自动缩放（最近邻，保持二值性）
  3. 灰度图按 >127 判定；带 alpha 的图按 alpha > 127 判定

它会做连通域拆分（和 colorkey 一样），这样你画一个大白块包住 5 只猫也行，
系统会帮你按连通性拆开。但**不会**做腰部拆分 —— 你既然手工画了，
就说明你希望精确控制，系统不该再自作主张。
================================================================================
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .. import imaging as im
from .base import SegmentProvider, SegmentResult, register


@register
class ManualMaskProvider(SegmentProvider):
    name = "manual"

    def __init__(self, masks_dir: str | Path | None = None, **_: Any) -> None:
        if masks_dir is None:
            raise SystemExit(
                "[segment] manual provider 需要 --masks-dir 参数。\n"
                "  → 例：--provider=manual --masks-dir=input/masks\n"
                "  约定：input/masks/<scene 名>.png，白=主体，黑=背景。"
            )
        self.masks_dir = Path(masks_dir)

    def describe(self) -> str:
        return f"manual(masks_dir={self.masks_dir})"

    def segment(self, image: np.ndarray) -> SegmentResult:
        raise NotImplementedError(
            "ManualMaskProvider 需要知道源图文件名才能找到对应 mask —— "
            "请改用 segment_named()。"
        )

    def segment_named(self, image: np.ndarray, stem: str) -> SegmentResult:
        """按源图名加载对应 mask。pipeline 对 manual provider 会调这个方法。"""
        path = self.masks_dir / f"{stem}.png"
        if not path.exists():
            raise SystemExit(
                f"[segment] 找不到手工掩码: {path}\n"
                f"  → manual provider 要求每张输入图都有同名 mask。\n"
                f"  → 缺哪张就画哪张：白 = 主体，黑 = 背景。"
            )

        # 延迟 import PIL，避免整个模块都依赖它（虽然 pillow 是必需依赖）
        from PIL import Image

        m = Image.open(path)
        arr = np.asarray(m)

        if arr.ndim == 2:
            binary = arr > 127
        elif arr.shape[2] == 4:
            binary = arr[:, :, 3] > 127
        else:
            binary = arr[:, :, 0] > 127

        H, W = image.shape[:2]
        if binary.shape != (H, W):
            # 最近邻缩放：保持二值，不做插值（插值会产生灰色中间值，语义不明）
            src = Image.fromarray((binary * 255).astype(np.uint8))
            src = src.resize((W, H), Image.NEAREST)
            binary = np.asarray(src) > 127

        binary = im.fill_holes(binary)
        labels, n = im.label_components(binary)

        subjects: list[np.ndarray] = []
        for lab in range(1, n + 1):
            sub = labels == lab
            if sub.any():
                subjects.append(sub)
        subjects.sort(key=lambda s: -int(s.sum()))

        return SegmentResult(
            mask=binary,
            subjects=subjects,
            background_color=None,
            provider=self.name,
            params={"mask_path": str(path), "components": n},
            notes=[f"载入手工掩码 {path.name}，拆出 {n} 个主体"],
        )
