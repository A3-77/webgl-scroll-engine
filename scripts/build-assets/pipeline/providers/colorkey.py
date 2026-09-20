"""
ColorKeySegmentProvider —— 背景色键控 + 连通域拆分
================================================================================
【为什么这是默认 provider】
用户提供的两张猫图（以及绝大多数"影棚/无缝纸背景"商品图、宠物图、人像图）
都有一个共同特征：**背景是一大片接近均匀的低频区域**。

对这个前提，色键控是**最优解**，而不是"退而求其次"：
  ▸ 零模型依赖 —— 不用下载 176MB 的 onnx，不用 GPU，不联网
  ▸ 秒级出结果 —— 1536x1024 全流程约 1-3 秒
  ▸ 完全可解释 —— 每个参数的作用都能在图上指出来，出问题能调
  ▸ 边缘质量更好 —— 抠图模型在毛发边缘常出"糊边"，
                    而色键控 + 反混合（unmultiply）能得到更锐利的毛边

【它做不到什么】（诚实声明，见 notes 与 manifest）
  ▸ 背景有**高频**内容（树叶、砖墙、人群）→ 换 rembg provider
  ▸ 主体与背景在**亮度和色度上都**接近（纯白猫趴在纯白纸上）→ 无解，换 rembg
  ▸ 主体内部有大片与背景同色的区域 → 会被挖空
    （fill_holes 能救被包住的，救不了与外界连通的）

================================================================================
算法流程（每一步都可单独调参，见 ColorKeyParams）
================================================================================

  ① 估计背景色        —— 从图像四边取样，鲁棒中位数
  ② 计算背景距离      —— 逐像素「与背景色的最大通道差」
  ③ 自适应阈值        —— 用「边框带自身距离分布的高分位」抬升阈值
  ④ 色度门（按需）    —— 背景非均匀时，补回主体上与背景亮度接近、
                         但色度不同的区域
  ⑤ 形态学清理        —— 开运算去噪点 → 填洞 → 闭运算弥合裂缝
  ⑥ 连通域标记        —— run-length + 并查集
  ⑦ 拆分粘连主体      —— 列占用率的"腰部"检测
  ⑧ 过滤小碎块        —— 面积阈值

================================================================================
【③④ 两步是怎么来的 —— 来自两张真实猫图的实测，不是设计时的臆测】
================================================================================

只有 ①②⑤⑥⑦⑧ 时（最初的版本），两张图的表现是：

  scene01（5 只猫，无缝纸背景）
    边框带距离 p95 = 4  →  背景确实纯色  →  工作良好，拆出 5 只猫。

  scene02（1 只奶油猫，带渐晕的影棚布背景）
    边框带距离 p95 = 36，而**猫本身的距离**是 p10=14 / p25=22 / p50=27。
    也就是说：猫的弱对比区（被照亮的前胸、左脸）比背景自身的波动还要"像背景"。
    排序是**反的** —— 任何单一阈值都两头不讨好：
      T=20 → 背景误报 24%，猫召回 82%
      T=36 → 背景误报 0.3%，猫召回 40%
    结果：整张图 58.75% 被判成前景，主体 bbox 是 1168×1011（占了 76%×99%）。

  ▸ ③ 自适应阈值 解决的是"背景自身波动"这一半：
      把边框带的 p95 当作背景的正常波动幅度去抬阈值。
      scene01 边框 p95=4 < 14 → 阈值不动（零回归）；
      scene02 边框 p95=36     → 阈值抬到 36。

  ▸ ④ 色度门 解决的是"低对比主体"这一半：
      实测 scene02 各区域的**色度向量** (R−G, G−B) 与"到背景色度向量的距离" cdev：

        区域            R      G      B   R−G   G−B    cdev
        猫-前胸       215.8  195.3  178.8  20.5  16.5    21.3
        猫-前腿       205.0  182.1  164.4  22.9  17.7    23.9
        猫-左脸       191.8  162.3  146.9  29.5  15.4    28.9
        猫-头右       228.2  209.9  206.2  18.3   3.7    14.0
        猫-右身       239.2  230.6  227.7   8.6   2.9     5.2
        背景-猫左     248.2  242.2  242.2   6.0   0.0     1.1
        背景-猫上     253.0  251.7  251.4   1.3   0.3     5.8
        背景-左上角   221.1  213.4  212.1   7.7   1.3     2.0
        背景-底边      ——     ——     ——     9.0   2.0     3.1

        （背景色度向量是 (7.0, 0.0) —— 它不是纯灰，是**偏粉的灰**。）

      单看 dist，猫的前胸(39) 和背景顶部(34) 几乎分不开。
      但看 cdev：背景最大 5.8，主体弱对比区 21~29 —— 中间空得很干净。

      为什么不用更简单的 `G−B > 6`（"比背景更暖"）：那是有方向的，
      冷色主体配暖色背景时会把背景判成主体。cdev 是向量距离，方向无关。

  ★ 为什么色度门**只在背景非均匀时才开**（adaptive_on 为真）：
      背景纯色时（scene01）不需要它。实测 scene01 在 cdev 门全阈值下
      结果与纯 dist 逐位一致（同样 1 个连通域、同样 28.6% 覆盖），
      所以开着也无害；但把启用条件与 ③ 绑定，
      能保证"背景干净的图"的行为与最初版本**逐位可复现**，
      这对回归排查很重要。

================================================================================
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .. import imaging as im
from .base import SegmentProvider, SegmentResult, register


@dataclass
class ColorKeyParams:
    #: 背景距离阈值（0..255 的通道差）的**下限**。越大越严格，越容易漏掉主体。
    threshold: float = 14.0

    # ---- ③ 自适应阈值：处理"背景不是纯色" ----
    #: 是否启用。关掉就退回"固定阈值"的原始行为。
    adaptive: bool = True
    #: 取边框带距离分布的哪个分位作为"背景自身的波动幅度"
    adaptive_percentile: float = 95.0
    #: 波动幅度乘以这个系数才是阈值。>1 更保守（少误报、多漏检）
    adaptive_margin: float = 1.0
    #: 自适应阈值的**上限**。防止边框带里混进了主体（尾巴/耳朵伸出画外）
    #: 导致阈值失控、把主体整个吃掉。
    threshold_ceiling: float = 72.0

    # ---- ④ 色度门：处理"低对比主体" ----
    #: 判据：像素的**色度向量** (R−G, G−B) 与背景色度向量的欧氏距离。
    #:
    #: 为什么用色度向量而不是"饱和度 sat = (max−min)/max"：
    #:   实测背景不是纯灰而是**偏粉的灰**（R−G≈7, G−B≈0），
    #:   主体是**暖色毛发**（R−G≈20, G−B≈17）。
    #:   单看标量饱和度，背景 6 / 主体 44 —— 分得开；
    #:   但背景的亮区和暗区饱和度能差到 6~13，主体弱对比区只有 14，会撞上。
    #:   而色度**向量**同时保留了"偏哪个色"，把两者彻底分开：
    #:     背景的 cdev 最大 5.8（背景顶部），主体弱对比区 21~29。
    #:   阈值 8 正好落在中间，两侧都留了余量。
    #:
    #: 为什么不用更简单的 `G−B > 6`（"比背景更暖"）：
    #:   那是有方向的 —— 冷色主体配暖色背景时会把背景当成主体。
    #:   向量距离方向无关，两种配色都成立。
    #: 0 = 关闭。
    chroma_gate: float = 8.0

    #: 开运算半径（去噪点）。1 = 去掉 1px 级别的毛刺
    open_radius: int = 1
    #: 闭运算半径（弥合裂缝）。太大可能把两只猫之间的缝隙糊上
    close_radius: int = 1

    #: 小于「图像面积 × 该比例」的连通域直接丢弃
    min_area_ratio: float = 0.004

    #: 列占用率低于「该比例 × 峰值占用率」的列，视为两只主体之间的"腰部"
    waist_ratio: float = 0.30
    #: 腰部至少要有这么宽（占图宽比例）才认定为真实分隔，避免把猫耳朵之间的缝当成分隔
    min_waist_width_ratio: float = 0.012

    #: 拆分出的主体再小也要保留的最小面积比（防止腰部检测过灵敏把主体切碎）
    min_subject_area_ratio: float = 0.012

    #: ★ 拆出来的各段，最大面积 / 最小面积 超过这个倍数就**放弃拆分**。
    #:
    #: 存在的理由（来自一次真实的误切）：
    #:   scene02 是单只猫，但它的**尾巴**从身体右侧伸出去，
    #:   尾巴所在的那几列占用率很低 → 被腰部检测当成了"两只主体之间的缝"。
    #:   结果猫被切成 3 段、尾巴那 61px 被当作"过小碎片"丢掉，
    #:   主体 bbox 从 463×747 变成 398×753 —— 猫没了尾巴。
    #:
    #:   判据：**并排的两个主体，面积应该量级相当**；
    #:   而尾巴/耳朵/腿这种"突出物"只是身体的一小部分。
    #:   所以面积比悬殊就说明切错了，退回不拆更安全。
    #:   实测 scene01 的 5 只猫面积比 = 6.1/5.5 ≈ 1.1，远低于 3.0。
    max_part_ratio: float = 3.0


@register
class ColorKeySegmentProvider(SegmentProvider):
    name = "colorkey"

    def __init__(self, **kwargs: Any) -> None:
        self.params = ColorKeyParams(**{k: v for k, v in kwargs.items() if hasattr(ColorKeyParams, k)})

    def describe(self) -> str:
        p = self.params
        return f"colorkey(threshold={p.threshold}, min_area={p.min_area_ratio})"

    # ------------------------------------------------------------------ 主流程

    def segment(self, image: np.ndarray) -> SegmentResult:
        p = self.params
        H, W = image.shape[:2]
        img = image.astype(np.float32)
        notes: list[str] = []

        # ---- ① 估计背景色 ----
        bg_color = estimate_background_color(img)
        notes.append(
            f"背景色估计 RGB=({bg_color[0]:.0f}, {bg_color[1]:.0f}, {bg_color[2]:.0f})"
        )

        # ---- ② 背景距离 ----
        dist = np.abs(img - bg_color.reshape(1, 1, 3)).max(axis=2)
        notes.append(f"背景距离: 中位 {np.median(dist):.1f} / 95分位 {np.percentile(dist, 95):.1f}")

        # ---- ③ 自适应阈值 ----
        # 边框取样带在构图惯例上一定是背景，所以它上面的距离分布
        # 就是"背景自身的波动幅度"。用它抬升阈值，就能容忍渐变背景。
        ring = border_band_mask(H, W)
        ring_hi = float(np.percentile(dist[ring], p.adaptive_percentile))
        T = float(p.threshold)
        adaptive_on = False
        if p.adaptive and ring_hi > p.threshold:
            T = min(ring_hi * p.adaptive_margin, p.threshold_ceiling)
            adaptive_on = T > p.threshold + 1e-6
            if ring_hi * p.adaptive_margin > p.threshold_ceiling:
                notes.append(
                    f"边框带 p{p.adaptive_percentile:.0f}={ring_hi:.0f} 超过上限，"
                    f"阈值被钳在 {p.threshold_ceiling:.0f}（边框里可能混进了主体）"
                )

        if adaptive_on:
            notes.append(
                f"背景不是纯色（边框带 p{p.adaptive_percentile:.0f}={ring_hi:.0f}）—— "
                f"阈值 {p.threshold:.0f} → 自适应 {T:.0f}"
            )
        else:
            notes.append(
                f"背景较均匀（边框带 p{p.adaptive_percentile:.0f}={ring_hi:.0f}），"
                f"使用固定阈值 {T:.0f}"
            )

        fg = dist > T

        # ---- ④ 色度门（只在背景非均匀时才启用）----
        # 见模块头部的实测数据：低对比主体在亮度上贴着背景，但色度上不贴。
        chroma_gate_on = adaptive_on and p.chroma_gate > 0
        if chroma_gate_on:
            rg = img[..., 0] - img[..., 1]
            gb = img[..., 1] - img[..., 2]
            bg_rg = float(bg_color[0] - bg_color[1])
            bg_gb = float(bg_color[1] - bg_color[2])
            cdev = np.hypot(rg - bg_rg, gb - bg_gb)
            gate = cdev > p.chroma_gate
            added = float((gate & ~fg).mean())
            fg |= gate
            notes.append(
                f"启用色度门：色度向量偏离背景 >{p.chroma_gate:.0f}"
                f"（背景色度 ({bg_rg:.0f},{bg_gb:.0f})，补回 {added * 100:.2f}% 面积）"
            )

        raw_ratio = float(fg.mean())
        notes.append(f"原始前景占比 {raw_ratio * 100:.2f}%")

        # ---- ⑤ 形态学清理 ----
        if p.open_radius > 0:
            fg = im.opening(fg, p.open_radius)
        fg = im.fill_holes(fg)
        if p.close_radius > 0:
            fg = im.closing(fg, p.close_radius)

        # ---- ⑥ 连通域 ----
        labels, n = im.label_components(fg)
        if n == 0:
            notes.append("⚠️ 没有检测到任何前景 —— 阈值可能过高，或背景估计失败")
            return SegmentResult(
                mask=fg,
                subjects=[],
                background_color=bg_color,
                provider=self.name,
                params=self._params_dict(),
                notes=notes,
                confidence="low",
            )
        notes.append(f"连通域: {n} 个")

        # ---- ⑦ 过滤小碎块 ----
        min_area = p.min_area_ratio * H * W
        kept: list[int] = []
        for lab in range(1, n + 1):
            area = int((labels == lab).sum())
            if area >= min_area:
                kept.append(lab)
        dropped = n - len(kept)
        if dropped:
            notes.append(f"丢弃 {dropped} 个面积不足的小连通域（阈值 {min_area:.0f}px）")

        # ---- ⑧ 拆分粘连主体 ----
        subjects: list[np.ndarray] = []
        for lab in kept:
            comp = labels == lab
            parts = split_by_waist(comp, p)
            if len(parts) > 1:
                notes.append(f"连通域 #{lab} 检测到腰部，拆成 {len(parts)} 个主体")
            subjects.extend(parts)

        # 拆分后可能产生过小的碎片，再过滤一次
        min_sub = p.min_subject_area_ratio * H * W
        before = len(subjects)
        subjects = [s for s in subjects if int(s.sum()) >= min_sub]
        if len(subjects) != before:
            notes.append(f"拆分后丢弃 {before - len(subjects)} 个过小碎片")

        # 按面积降序 —— 保证 subject-01 是最大的那个（"主角"）
        subjects.sort(key=lambda s: -int(s.sum()))

        # 主体掩码合并回总 mask（可能与原始 fg 略有差异，以主体为准）
        merged = np.zeros((H, W), dtype=bool)
        for s in subjects:
            merged |= s

        # ---- ⑨ 置信度评估 ----
        # 目的是：**不要静默地产出垃圾掩码**。色键控有明确的适用边界，
        # 越界时必须让用户知道，而不是让他到渲染结果里才发现。
        #
        # 判据：主体自身的对比裕度 = 主体掩码上的 dist 中位数 / 实际阈值。
        #   > 2   主体明显区别于背景，可靠
        #   1~2   勉强分开，边缘可能不干净
        #   < 1   主体整体低于阈值（被色度门硬捞回来的），**不可靠**
        if subjects:
            margin = float(np.median(dist[merged])) / max(T, 1e-6)
        else:
            margin = 0.0
        if margin >= 2.0 and not adaptive_on:
            confidence = "high"
        elif margin >= 1.0:
            confidence = "medium"
        else:
            confidence = "low"

        if adaptive_on:
            notes.append(
                "⚠️ 背景非均匀 —— 色键控的可靠性下降。"
                "请打开 generated/report.html 核对掩码；"
                "若主体有明显缺失，改用 --provider rembg 或 input/masks/ 手工掩码。"
            )
        if confidence == "low":
            notes.append(
                f"⚠️ 置信度低：主体对比裕度仅 {margin:.2f}（<1 表示主体本身弱于阈值）。"
                "这个掩码很可能缺了主体的低对比区域，建议换 provider 或手工掩码。"
            )
        notes.append(f"置信度 {confidence}（对比裕度 {margin:.2f}）")

        return SegmentResult(
            mask=merged,
            subjects=subjects,
            background_color=bg_color,
            provider=self.name,
            params=self._params_dict(),
            notes=notes,
            confidence=confidence,
            diagnostics={
                "thresholdUsed": round(T, 2),
                "thresholdFloor": p.threshold,
                "adaptiveTriggered": adaptive_on,
                "borderBandP": round(ring_hi, 2),
                "chromaGateUsed": chroma_gate_on,
                "contrastMargin": round(margin, 3),
                "rawForegroundRatio": round(raw_ratio, 4),
            },
        )

    def _params_dict(self) -> dict[str, Any]:
        p = self.params
        return {
            "threshold": p.threshold,
            "adaptive": p.adaptive,
            "adaptive_percentile": p.adaptive_percentile,
            "adaptive_margin": p.adaptive_margin,
            "threshold_ceiling": p.threshold_ceiling,
            "chroma_gate": p.chroma_gate,
            "open_radius": p.open_radius,
            "close_radius": p.close_radius,
            "min_area_ratio": p.min_area_ratio,
            "waist_ratio": p.waist_ratio,
            "min_waist_width_ratio": p.min_waist_width_ratio,
            "min_subject_area_ratio": p.min_subject_area_ratio,
            "max_part_ratio": p.max_part_ratio,
        }


# ---------------------------------------------------------------- 背景估计


def border_band_mask(H: int, W: int) -> np.ndarray:
    """
    四边取样带的布尔掩码 —— 这些像素在构图惯例上**一定是背景**。

    为什么这件事值得单独抽一个函数：
      自适应阈值（③）需要知道"背景自身的波动幅度"，
      而它必须从一个**保证是背景**的样本上估计。
      边框带就是这个样本 —— 影棚图、商品图、宠物图的主体几乎从不贴边。
    """
    by = max(2, int(H * 0.06))  # 上下取样带高度
    bx = max(2, int(W * 0.04))  # 左右取样带宽度
    m = np.zeros((H, W), dtype=bool)
    m[:by, :] = True
    m[H - by :, :] = True
    m[:, :bx] = True
    m[:, W - bx :] = True
    return m


def estimate_background_color(img: np.ndarray) -> np.ndarray:
    """
    从图像四边取样估计背景色。

    为什么不用"整图的中位数"：主体占比可能很大（5 只猫占了接近一半），
    整图中位数会被主体带偏。四边则几乎一定是背景（影棚图的构图惯例）。

    为什么要两轮：
      第一轮的边框里可能混进了主体（比如猫尾巴伸到边缘、或者有投影）。
      第二轮只取"离第一轮结果近"的像素再求中位数，把离群点排除掉。

    ⚠️ 已知局限：这个估计是**全局单一颜色**。
      背景有渐晕/褶皱时（比如 scene02 的影棚布），
      估计值会被拉向"边缘那一侧的颜色"，导致图中心的背景天然带着偏差。
      这正是 ③ 自适应阈值存在的理由 —— 它不修背景色本身，
      而是把"背景自身的波动"计入阈值。
    """
    H, W = img.shape[:2]
    bands = [
        img[: max(2, int(H * 0.06)), :, :].reshape(-1, 3),  # 上
        img[H - max(2, int(H * 0.06)) :, :, :].reshape(-1, 3),  # 下
        img[:, : max(2, int(W * 0.04)), :].reshape(-1, 3),  # 左
        img[:, W - max(2, int(W * 0.04)) :, :].reshape(-1, 3),  # 右
    ]
    samples = np.concatenate(bands, axis=0)

    first = np.median(samples, axis=0)

    # 第二轮：剔除离群点
    d = np.abs(samples - first.reshape(1, 3)).max(axis=1)
    inliers = samples[d < 24.0]
    if inliers.shape[0] >= 64:
        return np.median(inliers, axis=0).astype(np.float32)
    return first.astype(np.float32)


# ------------------------------------------------------------ 腰部拆分


def split_by_waist(comp: np.ndarray, p: ColorKeyParams) -> list[np.ndarray]:
    """
    把一个连通域按"腰部"拆成多个主体。

    场景：5 只猫坐成一排，如果它们之间有投影相连，CCL 会把它们标成**一个**连通域。
    但"两只猫之间"的那几列，前景像素数会显著少于猫身中部的列 —— 这就是腰部。

    做法：
      1. 统计每一列的前景像素数 col[x]
      2. 用 col 的高分位数当作"满列"基准（不用 max，避免个别列异常）
      3. col[x] < waist_ratio × 基准 → 该列是腰部
      4. 找出足够宽的腰部区间，在区间中点切开

    ⚠️ 诚实声明：这是**启发式**，不是分割模型。
      它对"横向排布、彼此分离、形状高度相近"的主体（本项目的 5 只猫）很有效。
      对"纵向堆叠"或"形状差异极大"的主体无效 —— 那种情况应该换 provider，
      或者手工给 mask（见 ManualMaskProvider）。

    两道保险（都是被真实的误切逼出来的）：
      ▸ 段数 > 12 → 不拆。防止把毛发缝隙当分隔，把主体剁成几十块。
      ▸ 最大段/最小段面积 > max_part_ratio → 不拆。
        并排主体的面积应该量级相当；悬殊说明切到的是尾巴/耳朵/腿。
    """
    H, W = comp.shape
    if W < 8 or H < 8:
        return [comp]

    ys, xs = np.nonzero(comp)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    box = comp[y0:y1, x0:x1]

    # ★ 注意：下面所有列索引都基于 box（裁剪后），不是原图。
    #   混用会导致 IndexError（box 比原图窄）。
    bw = x1 - x0
    bh = y1 - y0

    col = box.sum(axis=0).astype(np.float32)
    if col.max() <= 0:
        return [comp]

    # 满列基准：非零列的高分位数（比 max 稳）
    nz = col[col > 0]
    full = float(np.percentile(nz, 88)) if nz.size else float(col.max())
    if full <= 1:
        return [comp]

    rel = col / full
    waist = rel < p.waist_ratio

    # 找出所有腰部区间
    cuts: list[int] = []
    min_w = max(1, int(p.min_waist_width_ratio * bw))
    i = 0
    while i < bw:
        if waist[i]:
            j = i
            while j < bw and waist[j]:
                j += 1
            if j - i >= min_w:
                cuts.append((i + j) // 2)
            i = j
        else:
            i += 1

    # 没有腰部，或切出来的段数不合理 → 不拆
    if not cuts:
        return [comp]

    # 按切点分段，落到原图坐标系
    bounds = [0] + cuts + [bw]
    parts: list[np.ndarray] = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a < 2:
            continue
        sub = np.zeros((H, W), dtype=bool)
        sub[y0 : y0 + bh, x0 + a : x0 + b] = box[:, a:b]
        if sub.any():
            parts.append(sub)

    # 段数太多说明腰部检测过灵敏（把毛发缝隙也当分隔了）——退回不拆更安全
    if len(parts) > 12:
        return [comp]

    # ★ 先丢掉明显过小的碎屑，**再**做面积比校验。
    #   顺序不能反 —— 实测踩过：scene01 的 5 只猫 + 2 个碎屑一起算面积比，
    #   碎屑把比值拉到远超阈值，于是整组放弃拆分，5 只猫被当成 1 个主体。
    min_sub = p.min_subject_area_ratio * H * W
    solid = [q for q in parts if int(q.sum()) >= min_sub]
    if len(solid) <= 1:
        return [comp]

    # 面积比校验：并排主体的面积应该量级相当。
    # 悬殊说明切到的是尾巴/耳朵/腿这类"突出物"，不是第二个主体。
    areas = [int(q.sum()) for q in solid]
    lo, hi = min(areas), max(areas)
    if lo <= 0 or hi / lo > p.max_part_ratio:
        return [comp]

    return solid
