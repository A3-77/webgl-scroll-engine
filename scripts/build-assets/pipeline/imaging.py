"""
图像算子 —— 只用 numpy 实现，不引 scipy
================================================================================
为什么自己实现而不装 scipy / opencv：
  1. 本流水线需要的算子只有 5 个（连通域、填洞、膨胀、腐蚀、金字塔填充），
     为它们引一个 40MB 的依赖，对"用户 clone 下来就能跑"这个目标是负担。
  2. 这几个算子本身都不复杂，而且**行为完全可控** ——
     调参时能确切知道阈值作用在哪一步，不用猜库内部的默认行为。

性能：1536x1024 的图，全流程（含金字塔填充）在本机约 1-3 秒。
      对构建期脚本完全够用。
================================================================================
"""

from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------- 连通域标记


def label_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """
    4-邻域连通域标记（run-length + 并查集）。

    为什么不用逐像素 BFS：
      1536x1024 = 157 万像素，纯 Python 的逐像素 BFS 要几十秒。
      按"行内的连续段"（run）做，段数比像素数少两三个数量级 —— 实测 <0.3 秒。

    @return (labels, count)，labels 是 int32，背景为 0，各连通域从 1 开始编号
    """
    H, W = mask.shape
    labels = np.zeros((H, W), dtype=np.int32)

    # 并查集
    parent: list[int] = [0]

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        # 路径压缩
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            # 小的当父节点，保证根的编号单调，便于后面一次性重映射
            if ra > rb:
                ra, rb = rb, ra
            parent[rb] = ra

    next_label = 1
    prev_runs: list[tuple[int, int, int]] = []

    for y in range(H):
        row = mask[y]
        if not row.any():
            prev_runs = []
            continue

        # 找出本行的所有连续段
        d = np.diff(row.view(np.int8))
        starts = (np.flatnonzero(d == 1) + 1).tolist()
        ends = (np.flatnonzero(d == -1) + 1).tolist()
        if row[0]:
            starts.insert(0, 0)
        if row[-1]:
            ends.append(W)

        cur_runs: list[tuple[int, int, int]] = []
        for s, e in zip(starts, ends):
            lbl = 0
            for ps, pe, pl in prev_runs:
                if ps >= e:
                    break  # prev_runs 按起点有序，后面的不可能再重叠
                if pe > s:
                    if lbl == 0:
                        lbl = pl
                    else:
                        union(lbl, pl)
            if lbl == 0:
                lbl = next_label
                parent.append(lbl)
                next_label += 1
            labels[y, s:e] = lbl
            cur_runs.append((s, e, lbl))

        prev_runs = cur_runs

    # 一次性把临时编号压成连续编号
    if next_label > 1:
        mapping = np.arange(next_label, dtype=np.int32)
        for i in range(1, next_label):
            mapping[i] = find(i)
        # 重新编号为 1..n
        uniq = np.unique(mapping[1:])
        remap = np.zeros(next_label, dtype=np.int32)
        remap[uniq] = np.arange(1, len(uniq) + 1, dtype=np.int32)
        labels = remap[mapping][labels]
        return labels, int(len(uniq))

    return labels, 0


# -------------------------------------------------------------------- 填洞


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """
    填充二值掩码内部的洞。

    做法：洞 = 「背景连通域里**不接触图像边界**的那些」。
      先把 ~mask 做连通域标记，然后看哪些标号出现在最外圈 ——
      没出现在最外圈的就是被前景完全包住的洞，填掉。

    这个定义比"逐行扫描左右边界"健壮得多（能处理任意形状的洞，
    且不会误填与外界连通的凹陷）。
    """
    inv = ~mask
    if not inv.any():
        return mask.copy()

    labels, n = label_components(inv)
    if n == 0:
        return mask.copy()

    # 最外圈出现过的标号 = 与外界连通 = 不是洞
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    outside = np.unique(border)
    outside = outside[outside > 0]

    is_hole = (labels > 0) & ~np.isin(labels, outside)
    return mask | is_hole


# ------------------------------------------------------- 形态学（可分离盒）


def _norm_axis(axis: int, ndim: int) -> int:
    """
    把负轴（-1 = 最后一轴）归一化成非负数。

    ★ 这个函数存在的唯一理由，是一个真实踩过的坑：
      `pad_width = [(r, r) if i == axis else (0, 0) for i in range(a.ndim)]`
      在 axis=-1 时**永远匹配不上** —— 因为 i 取 0..ndim-1，没有负数。
      结果是 padding 全为 (0,0)，数组根本没被 pad，
      随后 `arange(k, k+n)` 的上界就越过了 cumsum 的实际长度。

      报错信息极具误导性（`index 4 is out of bounds for axis 2 with size 4`），
      看起来像"公式差一位"，实际是"压根没 pad"。
      所有按 axis 索引的算子都必须先过这一层归一化。
    """
    return axis + ndim if axis < 0 else axis


def _box_dilate_1d(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    """
    一维盒状膨胀：沿 axis 取半径 r 内的最大值。

    ★ 必须用 edge padding，不能用 np.roll ——
      np.roll 是**环绕**的，会让图像最左列被最右列影响。
      对掩码来说这意味着一只猫的左边缘可能和右边缘"连"上，
      进而被连通域标记成同一个主体。这个 bug 很隐蔽，因为大多数图看不出来。
    """
    if r <= 0:
        return a
    axis = _norm_axis(axis, a.ndim)
    n = a.shape[axis]
    pad_width = [(r, r) if i == axis else (0, 0) for i in range(a.ndim)]
    padded = np.pad(a, pad_width, mode="edge")
    out = a.copy()
    for k in range(1, r + 1):
        hi = np.take(padded, np.arange(k + r, k + r + n), axis=axis)
        lo = np.take(padded, np.arange(r - k, r - k + n), axis=axis)
        out = out | hi | lo
    return out


def _box_erode_1d(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    if r <= 0:
        return a
    axis = _norm_axis(axis, a.ndim)
    n = a.shape[axis]
    pad_width = [(r, r) if i == axis else (0, 0) for i in range(a.ndim)]
    padded = np.pad(a, pad_width, mode="edge")
    out = a.copy()
    for k in range(1, r + 1):
        hi = np.take(padded, np.arange(k + r, k + r + n), axis=axis)
        lo = np.take(padded, np.arange(r - k, r - k + n), axis=axis)
        out = out & hi & lo
    return out


def dilate(mask: np.ndarray, r: int = 1) -> np.ndarray:
    """盒状膨胀（可分离：先横后竖，复杂度 O(r) 而不是 O(r²)）。"""
    if r <= 0:
        return mask.copy()
    out = _box_dilate_1d(mask, r, axis=1)
    return _box_dilate_1d(out, r, axis=0)


def erode(mask: np.ndarray, r: int = 1) -> np.ndarray:
    if r <= 0:
        return mask.copy()
    out = _box_erode_1d(mask, r, axis=1)
    return _box_erode_1d(out, r, axis=0)


def opening(mask: np.ndarray, r: int = 1) -> np.ndarray:
    """开运算：先腐蚀后膨胀。**去掉细小的毛刺和孤立噪点**。"""
    return dilate(erode(mask, r), r)


def closing(mask: np.ndarray, r: int = 1) -> np.ndarray:
    """闭运算：先膨胀后腐蚀。**弥合细小裂缝**。"""
    return erode(dilate(mask, r), r)


# ---------------------------------------------------------------- 模糊


def _box_blur_axis(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    """
    沿单一轴做盒状模糊（用前缀和，O(1) 每像素）。

    公式推导（这是最容易差一位的地方，写清楚）：
      设 pad 是 edge 填充后的数组，长度 n + 2r。
      输出位置 i 的窗口是 pad[i : i+k]（k = 2r+1），
      于是 out[i] = sum(pad[i : i+k]) = cs[i+k] - cs[i]，
      其中 cs 是**前置一个零**的 cumsum（这样 cs[j] = sum(pad[:j])）。
      cs 长度 = n + k，所以 cs[k : k+n] 与 cs[0 : n] 都合法。
    """
    if r <= 0:
        return a.astype(np.float32, copy=True)

    axis = _norm_axis(axis, a.ndim)
    k = 2 * r + 1
    n = a.shape[axis]

    pad_width = [(r, r) if i == axis else (0, 0) for i in range(a.ndim)]
    padded = np.pad(a, pad_width, mode="edge")

    cs = np.cumsum(padded, axis=axis, dtype=np.float32)
    zs = list(cs.shape)
    zs[axis] = 1
    cs = np.concatenate([np.zeros(zs, dtype=np.float32), cs], axis=axis)

    hi = np.take(cs, np.arange(k, k + n), axis=axis)
    lo = np.take(cs, np.arange(0, n), axis=axis)
    return (hi - lo) / k


def box_blur(a: np.ndarray, r: int) -> np.ndarray:
    """
    可分离盒状模糊（float32 数组，任意通道数）。

    跑两遍（横 + 竖），近似高斯。两次已经足够做 alpha 羽化，且比三次快。

    ★ 只模糊**空间轴**（0 和 1），通道轴永远不动。
      这一点对 2D 掩码和 3D RGB 是同一个答案 —— 空间轴永远是前两维。
      之前写死 `axis=-1` 在 3D 输入上会去模糊通道轴（语义错误），
      并且因为负轴没归一化而直接 IndexError。
    """
    if r <= 0:
        return a.astype(np.float32, copy=True)

    out = a.astype(np.float32, copy=True)
    out = _box_blur_axis(out, r, axis=1)  # 横向
    out = _box_blur_axis(out, r, axis=0)  # 纵向
    return out


# ---------------------------------------------------- 金字塔填充（inpaint）


def _downsample(img: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    2x2 盒降采样，按 valid 加权。返回 (图像, 权重和)。

    ★ 尺寸用 **ceil**（`(H+1)//2`），不是 `H//2`。
      这不是风格偏好，是一个真实踩过的 bug：

        用 `H//2` 时，奇数尺寸会**丢掉**最后一行/列 ——
          9 → 4（丢掉 1 行）
        而 `_upsample` 是 `repeat 2` ——
          4 → 8
        于是 pull 阶段 `pyr_img[lv][need] = coarse[need]` 两边形状对不上：
          IndexError: boolean index did not match indexed array along axis 0;
                      size of axis is 8 but size of corresponding boolean axis is 9

      **为什么一直没被发现**：原来的两张猫图是 1536×1024，
      金字塔各层（1536→768→384→192→96→48→24→12→6→3）恰好都是偶数，
      整除，没丢过东西。换成 1200×1200 立刻崩 ——
      而"用户提供任意尺寸的图"正是这个引擎的基本前提。

    ★ 奇数时在**右下补零**：
        img 补 0 → 被 valid=0 排除（`acc = sum(i4 * v4)`），不污染均值
        valid 补 0 → 权重 0，不参与归一化
      这样 ceil/floor 的差异就只体现在"多带一个无效格"，而不是丢数据。
    """
    H, W = valid.shape
    H2, W2 = (H + 1) // 2, (W + 1) // 2
    ph, pw = H2 * 2 - H, W2 * 2 - W

    if ph or pw:
        img = np.pad(img, ((0, ph), (0, pw), (0, 0)))
        valid = np.pad(valid, ((0, ph), (0, pw)))

    i4 = img.reshape(H2, 2, W2, 2, img.shape[2]).astype(np.float32)
    v4 = valid.reshape(H2, 2, W2, 2).astype(np.float32)

    wsum = v4.sum(axis=(1, 3))
    acc = (i4 * v4[..., None]).sum(axis=(1, 3))

    out = np.zeros((H2, W2, img.shape[2]), dtype=np.float32)
    nz = wsum > 1e-6
    out[nz] = acc[nz] / wsum[nz][:, None]
    return out, wsum


def _upsample(img: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """
    最近邻 2x 上采样并裁到目标尺寸。

    与 `_downsample` 的 ceil 语义配套：`_upsample(_downsample(x))` 的尺寸
    一定 >= 原尺寸（`2*ceil(H/2) >= H`），裁剪后正好还原 —— 不会出现"上采样
    出来的比目标还小"的情况。
    """
    up = np.repeat(np.repeat(img, 2, axis=0), 2, axis=1)
    return up[: shape[0], : shape[1]]


def pyramid_inpaint(img: np.ndarray, hole: np.ndarray, levels: int = 12) -> np.ndarray:
    """
    用金字塔扩散把 hole 区域填上（push-pull inpainting）。

    原理：
      1. push —— 逐级降采样，每级只统计"非洞"像素的加权均值。
         洞越大，能提供信息的层级越粗，但**每级一定有信息**（因为背景本身在图上）。
      2. pull —— 从最粗一级往上，用上一级的结果填补本级仍是洞的像素。

    为什么这对本项目的图片特别有效：
      影棚无缝背景本身就是**低频的**（一片平滑的浅灰渐变），
      金字塔填充本质上就是低频外推 —— 对这类背景几乎能得到完美的干净底。

    ⚠️ 局限（诚实声明）：
      对**高频复杂背景**（树叶、砖墙、人群），金字塔填充会糊成一片色块。
      那种情况下应该换用真正的 inpaint 模型（LaMa 等）。
      这也是为什么"背景生成"是 pipeline 里一个独立步骤、而不是写死在分割里。

    @param img  float32 (H, W, C)，0..255 或 0..1 都可以
    @param hole bool (H, W)，True = 需要填充的洞
    """
    H, W = hole.shape
    valid = (~hole).astype(np.float32)

    if valid.sum() == 0:
        # 整张图都是洞 —— 没有信息可外推，返回中灰
        return np.full_like(img, 128.0, dtype=np.float32)

    # ---- push ----
    pyr_img = [img.astype(np.float32)]
    pyr_val = [valid]
    while len(pyr_img) < levels and min(pyr_img[-1].shape[0], pyr_img[-1].shape[1]) >= 4:
        di, dv = _downsample(pyr_img[-1], pyr_val[-1])
        pyr_img.append(di)
        pyr_val.append(dv)

    # 最粗一级如果有洞，用它的均值兜底
    top = pyr_img[-1]
    tv = pyr_val[-1]
    if (tv <= 1e-6).any():
        m = top[tv > 1e-6].mean(axis=0) if (tv > 1e-6).any() else np.array([128.0] * img.shape[2])
        top[tv <= 1e-6] = m

    # ---- pull ----
    for lv in range(len(pyr_img) - 2, -1, -1):
        coarse = _upsample(pyr_img[lv + 1], pyr_img[lv].shape[:2])
        need = pyr_val[lv] <= 1e-6
        pyr_img[lv][need] = coarse[need]

    return pyr_img[0]


# ------------------------------------------------------- 主体边界反混合


def unmultiply_background(
    rgb: np.ndarray,
    alpha: np.ndarray,
    bg_color: np.ndarray,
    strength: float = 0.9,
) -> np.ndarray:
    """
    去掉主体边缘的"背景色渗色"（halo）。

    问题：边缘像素其实是 `observed = α·subject + (1-α)·background` 的混合结果。
      如果直接把 observed 当主体色、再配一个羽化 alpha，
      边缘就会残留一圈背景色 —— 浅灰背景上是"发白的光晕"，深色背景上是"黑边"。

    解法：反解 subject = (observed - (1-α)·bg) / α

    @param strength 0..1，1 = 完全反解。留一点余量（0.9）可以避免
                    α 很小时除法放大噪声。
    """
    a = np.clip(alpha, 1e-3, 1.0)[..., None]
    bg = bg_color.reshape(1, 1, -1).astype(np.float32)
    corrected = (rgb.astype(np.float32) - (1.0 - a) * bg) / a
    out = rgb.astype(np.float32) * (1.0 - strength) + corrected * strength
    return np.clip(out, 0.0, 255.0)
