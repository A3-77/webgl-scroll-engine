"""
合成器 —— 掩码 → 可渲染素材
================================================================================
输入：原图 + 每个主体的掩码
输出：
    public/content/<scene>/background.webp      干净底（已抹掉主体）
    public/content/<scene>/subject-01.png ...   透明 PNG（带羽化 alpha）
    generated/preview-<scene>.png               校验预览（拼回去看对不对）

--------------------------------------------------------------------------------
【为什么背景必须"抹掉主体"而不是直接用原图】
  直接用原图当背景会有**重影**：主体被抠出来画在背景之上，
  而背景里原本那个主体还在原地 —— 稍微一动就会看到"两个自己"。
  所以必须生成一张干净底。

【干净底怎么来】
  用金字塔扩散填充（imaging.pyramid_inpaint）。
  对无缝影棚背景（低频、平滑渐变）效果接近完美；
  对高频复杂背景会糊成色块 —— 那种情况需要换真正的 inpaint 模型（LaMa 等）。
  这是**已知局限**，会写进 manifest 的 notes，不藏着。

【边缘为什么要羽化 + 反混合】
  见 imaging.unmultiply_background 的注释。
  一句话：边缘像素是"主体色和背景色的混合"，直接用会留一圈背景色光晕。
================================================================================
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from . import imaging as im


@dataclass
class CompositorParams:
    #: 羽化半径（像素）。1-2 足够抗锯齿；太大会让主体边缘"发虚"
    feather_radius: int = 2

    #: 反混合强度。0 = 不做（边缘留背景色光晕），1 = 完全反解（可能放大噪声）
    unmultiply_strength: float = 0.9

    #: 主体四周额外留白的比例（相对主体尺寸）。留一点余量，
    #: 让 WebGL 侧缩放/旋转时不会切到边缘
    subject_padding: float = 0.02

    #: 主体 PNG 的最长边上限（像素）。原图 1536 宽，单只猫约 350px 高，通常不触发
    max_subject_size: int = 1400

    #: 干净底的模糊半径。1-2 能让填充痕迹更自然（也更像"景深"），
    #: 但如果背景有需要保留的细节（室内、文字），设 0
    background_blur: int = 1

    #: 背景输出格式。webp 体积最小；png 无损但大 3-5 倍
    background_format: str = "webp"
    background_quality: int = 88

    #: 是否生成校验预览图
    write_preview: bool = True


@dataclass
class SubjectOutput:
    """一个主体落盘后的信息。"""

    id: str
    path: str  # 相对 public/ 的路径
    box: dict[str, float]  # 归一化到 0..1 的包围盒
    center: dict[str, float]  # 归一化中心
    aspect: float  # 像素宽高比
    area_ratio: float  # 占原图面积比
    pixel_count: int
    size: tuple[int, int]  # 像素尺寸


def feather_alpha(mask: np.ndarray, radius: int) -> np.ndarray:
    """
    把硬掩码变成带抗锯齿的 alpha。

    做法不是简单的"模糊一下"，而是 **模糊后再做对比度拉伸**：
      单纯模糊会让主体内部也变半透明（尤其细窄部位），
      拉伸（把 [lo, hi] 映射到 [0, 1]）能保证内部仍然是实心 1.0，
      只在真正的边缘保留 0..1 的过渡。
    """
    m = mask.astype(np.float32)
    if radius <= 0:
        return m

    soft = im.box_blur(m, radius)

    # 对比度拉伸：低于 lo 的压成 0，高于 hi 的提到 1
    lo, hi = 0.30, 0.72
    a = np.clip((soft - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
    return a


def build_subject(
    image: np.ndarray,
    mask: np.ndarray,
    bg_color: np.ndarray | None,
    out_path: Path,
    params: CompositorParams,
) -> SubjectOutput:
    """裁剪、羽化、反混合、落盘一个主体，返回它的元数据。"""
    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        raise ValueError("空的掩码 —— 该主体没有任何像素")

    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1

    # 加 padding
    ph = max(2, int((y1 - y0) * params.subject_padding))
    pw = max(2, int((x1 - x0) * params.subject_padding))
    y0 = max(0, y0 - ph)
    y1 = min(H, y1 + ph)
    x0 = max(0, x0 - pw)
    x1 = min(W, x1 + pw)

    sub_rgb = image[y0:y1, x0:x1].astype(np.float32)
    sub_mask = mask[y0:y1, x0:x1]

    alpha = feather_alpha(sub_mask, params.feather_radius)

    if bg_color is not None and params.unmultiply_strength > 0:
        sub_rgb = im.unmultiply_background(sub_rgb, alpha, bg_color, params.unmultiply_strength)

    rgba = np.dstack([np.clip(sub_rgb, 0, 255), alpha * 255.0]).astype(np.uint8)

    # 限制最大尺寸
    h, w = rgba.shape[:2]
    longest = max(h, w)
    if longest > params.max_subject_size:
        scale = params.max_subject_size / longest
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        rgba = np.asarray(
            Image.fromarray(rgba, "RGBA").resize((nw, nh), Image.LANCZOS)
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(out_path, "PNG", optimize=True)

    h, w = rgba.shape[:2]
    pixel_count = int(sub_mask.sum())

    return SubjectOutput(
        id="",  # 由调用方按面积排序后填
        path=str(out_path).replace("\\", "/"),
        box={
            "x": x0 / W,
            "y": y0 / H,
            "w": (x1 - x0) / W,
            "h": (y1 - y0) / H,
        },
        center={
            "x": ((x0 + x1) / 2.0) / W,
            "y": ((y0 + y1) / 2.0) / H,
        },
        aspect=w / max(h, 1),
        area_ratio=pixel_count / float(H * W),
        pixel_count=pixel_count,
        size=(w, h),
    )


def build_background(
    image: np.ndarray,
    mask: np.ndarray,
    out_path: Path,
    params: CompositorParams,
) -> tuple[str, list[str]]:
    """
    生成干净底（抹掉主体）。返回 (相对路径, notes)。
    """
    notes: list[str] = []
    img = image.astype(np.float32)

    if mask.any():
        # 稍微膨胀一下要填的区域：反混合后主体边缘会略微"薄"一点，
        # 不多填一点会在主体边缘露出一圈原图里的主体残影
        hole = im.dilate(mask, 3)
        filled = im.pyramid_inpaint(img, hole, levels=12)
        # 只替换洞内像素，洞外保持原图（避免填充算法改动不该动的区域）
        out = np.where(hole[..., None], filled, img)
        notes.append(
            f"背景已用金字塔扩散填充（抹掉 {hole.mean() * 100:.1f}% 面积）"
        )
        if hole.mean() > 0.45:
            notes.append(
                "⚠️ 主体占比超过 45%，填充区域很大 —— "
                "若背景不是平滑低频的，这里会出现明显糊块，建议换 inpaint 模型或手工掩码"
            )
    else:
        out = img
        notes.append("没有检测到主体，背景 = 原图")

    if params.background_blur > 0:
        out = im.box_blur(out, params.background_blur)
        notes.append(f"背景已做半径 {params.background_blur} 的柔化")

    arr = np.clip(out, 0, 255).astype(np.uint8)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if params.background_format == "png":
        Image.fromarray(arr, "RGB").save(out_path, "PNG", optimize=True)
    else:
        Image.fromarray(arr, "RGB").save(
            out_path, "WEBP", quality=params.background_quality, method=5
        )

    return str(out_path).replace("\\", "/"), notes


def write_preview(
    image: np.ndarray,
    background_path: Path,
    subjects: list[tuple[np.ndarray, SubjectOutput, Path]],
    out_path: Path,
) -> str:
    """
    拼一张校验图：干净底 + 所有抠出来的主体按原位贴回去。

    为什么值得多写一张图：
      这是**唯一能一眼看出分割对不对**的东西。光看 manifest 的数字
      （面积比、包围盒）看不出"猫耳朵被削掉了一块"或者"两只猫被粘成一只"。
      图放在 generated/ 下，不参与构建，纯粹给人看。
    """
    bg = Image.open(background_path).convert("RGB")
    W, H = bg.size
    canvas = bg.copy()

    for mask, meta, sub_path in subjects:
        sub = Image.open(sub_path).convert("RGBA")
        # 用 manifest 里的归一化包围盒反推贴回位置
        x = int(meta.box["x"] * W)
        y = int(meta.box["y"] * H)
        w = int(meta.box["w"] * W)
        h = int(meta.box["h"] * H)
        if w <= 0 or h <= 0:
            continue
        canvas.paste(sub.resize((w, h), Image.LANCZOS), (x, y), sub.resize((w, h), Image.LANCZOS))

    # 缩小到便于查看的尺寸
    if W > 1100:
        scale = 1100 / W
        canvas = canvas.resize((int(W * scale), int(H * scale)), Image.LANCZOS)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG", optimize=True)
    return str(out_path).replace("\\", "/")


def image_to_data_uri(path: Path) -> str:
    """把图片编码成 data URI（写进 HTML 报告用）。"""
    buf = io.BytesIO()
    Image.open(path).save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
