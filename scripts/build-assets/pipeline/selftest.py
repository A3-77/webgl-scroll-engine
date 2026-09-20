"""
图像算子自检 —— `npm run build-assets:selftest`
================================================================================
为什么值得常驻一个自检脚本：

  这些算子是**纯 numpy 手写**的（连通域、形态学、盒模糊、金字塔填充），
  不引 scipy/opencv。手写的代价就是"差一位"这类 bug 特别容易出，
  而且**症状极具误导性**。

  真实案例：`_box_blur_axis` 里
      pad_width = [(r, r) if i == axis else (0, 0) for i in range(a.ndim)]
  在 axis=-1 时永远匹配不上（i 取 0..ndim-1，没有负数），
  于是数组压根没被 pad，报错却是
      IndexError: index 4 is out of bounds for axis 2 with size 4
  —— 看起来像"公式差一位"，实际是"没 pad"。
  盯着报错改了三次都没对，写了个常量图断言一次就定位了。

  所以：**改这些算子之后跑一遍这个脚本**，比盯着下游的掩码猜要快得多。

  用法：
    npm run build-assets:selftest
================================================================================
"""

from __future__ import annotations

import sys

import numpy as np

from . import imaging as im

_FAILED: list[str] = []


def chk(name: str, cond: bool, extra: str = "") -> None:
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}" + (f"  {extra}" if extra else ""))
    if not cond:
        _FAILED.append(name)


def main() -> int:
    print("图像算子自检")
    print("=" * 60)

    # ---------------- 盒模糊 ----------------
    print("\nbox_blur")

    # 常量图必须逐像素不变 —— 这条断言能直接抓住"没 padding"的 bug，
    # 因为 edge padding 的意义就是让边界处窗口仍覆盖同样多的值。
    chk("2D 常量图不变", np.allclose(im.box_blur(np.full((20, 30), 7.0, np.float32), 2), 7.0))
    chk("3D 常量图不变", np.allclose(im.box_blur(np.full((20, 30, 3), 7.0, np.float32), 2), 7.0))

    # 通道轴不能被模糊
    a = np.zeros((20, 30, 3), np.float32)
    a[..., 0] = 100.0
    b = im.box_blur(a, 1)
    chk(
        "通道轴未被模糊",
        b[..., 1].max() == 0 and b[..., 2].max() == 0 and abs(b[10, 15, 0] - 100.0) < 1e-3,
    )

    # 与朴素实现的逐像素一致性
    rng = np.random.default_rng(0)
    x = rng.random((17, 23)).astype(np.float32)
    r = 2
    xp = np.pad(x, ((r, r), (r, r)), mode="edge")
    ref = np.array(
        [[xp[i : i + 2 * r + 1, j : j + 2 * r + 1].mean() for j in range(23)] for i in range(17)],
        dtype=np.float32,
    )
    err = float(np.abs(im.box_blur(x, r) - ref).max())
    chk("与朴素实现一致", err < 1e-4, f"maxerr={err:.2e}")

    # 能量守恒 —— 盒模糊不该缩放亮度
    imp = np.zeros((41, 41), np.float32)
    imp[20, 20] = 255.0
    chk("脉冲能量守恒", abs(im.box_blur(imp, 3).sum() - 255.0) < 1.0)

    # ---------------- 形态学 ----------------
    print("\ndilate / erode")

    m = np.zeros((10, 10), bool)
    m[5, 0] = True
    chk("膨胀不环绕（最左不影响到最右）", not im.dilate(m, 1)[5, 9])
    chk("膨胀确实向右生长", bool(im.dilate(m, 1)[5, 1] and im.dilate(m, 1)[4, 0]))

    m2 = np.ones((10, 10), bool)
    m2[5, 0] = False
    chk("腐蚀不环绕", bool(im.erode(m2, 1)[5, 9]))

    # 开运算去掉孤立噪点、保留主体
    m3 = np.zeros((30, 30), bool)
    m3[10:20, 10:20] = True
    m3[2, 2] = True
    op = im.opening(m3, 1)
    chk("开运算去孤立噪点", not op[2, 2] and op[15, 15])

    # ---------------- 连通域 ----------------
    print("\nlabel_components")

    m4 = np.zeros((20, 20), bool)
    m4[2:6, 2:6] = True
    m4[12:17, 12:17] = True
    _, n = im.label_components(m4)
    chk("两个分离块 = 2 个连通域", n == 2, f"n={n}")

    # 对角相邻不算连通（4-邻域语义）
    m5 = np.zeros((10, 10), bool)
    m5[2, 2] = True
    m5[3, 3] = True
    _, n5 = im.label_components(m5)
    chk("对角不算连通（4-邻域）", n5 == 2, f"n={n5}")

    # 同一行的连续段必须算 1 个
    m6 = np.zeros((5, 20), bool)
    m6[2, 3:15] = True
    _, n6 = im.label_components(m6)
    chk("行内连续段 = 1 个", n6 == 1, f"n={n6}")

    # ---------------- 填洞 ----------------
    print("\nfill_holes")

    ring = np.zeros((20, 20), bool)
    ring[5:15, 5:15] = True
    ring[7:13, 7:13] = False
    chk("闭合环内的洞被填上", bool(im.fill_holes(ring)[10, 10]))

    notch = np.zeros((20, 20), bool)
    notch[5:15, 5:15] = True
    notch[5:15, 5:10] = False
    chk("与外界连通的凹陷不被填", not im.fill_holes(notch)[10, 7])

    # ---------------- 金字塔填充 ----------------
    print("\npyramid_inpaint")

    flat = np.full((64, 64, 3), 200.0, np.float32)
    hole = np.zeros((64, 64), bool)
    hole[20:40, 20:40] = True
    chk("常量图挖洞后能还原", bool(np.allclose(im.pyramid_inpaint(flat, hole)[25, 25], 200.0, atol=1.0)))

    # 线性渐变图：金字塔填充对低频内容应该接近完美
    gy = np.linspace(0, 100, 64, dtype=np.float32)
    grad = np.repeat(gy[:, None, None], 64, axis=1).repeat(3, axis=2)
    rec = im.pyramid_inpaint(grad, hole)
    err_g = float(np.abs(rec[25, 25] - grad[25, 25]).max())
    chk("线性渐变挖洞后误差 < 8", err_g < 8.0, f"maxerr={err_g:.2f}")

    # ★ 任意尺寸 —— 这条是被一个真实崩溃逼出来的。
    #
    #   原实现 `_downsample` 用 `H // 2`（向下取整），而 `_upsample` 用 repeat 2。
    #   尺寸是奇数时两者不互逆：9 → 4 → 8，pull 阶段形状对不上直接 IndexError。
    #   猫图是 1536×1024，金字塔各层恰好都是偶数，所以一直没暴露；
    #   换成 1200×1200 立刻崩 —— 而"用户提供任意尺寸的图"是本引擎的基本前提。
    #
    #   所以这里**不测某个具体尺寸，而是扫一批**（含质数、含奇数、含极端长宽比）。
    print("\npyramid_inpaint · 任意尺寸")
    odd_sizes = [(9, 9), (17, 5), (75, 75), (101, 37), (1, 1), (3, 200), (200, 3)]
    shape_ok = True
    content_ok = True
    for hh, ww in odd_sizes:
        base = np.full((hh, ww, 3), 150.0, np.float32)
        # 洞不能是整张图（那样没有信息可外推），留出边缘
        hl = np.zeros((hh, ww), bool)
        if hh > 2 and ww > 2:
            hl[1 : hh - 1, 1 : ww - 1] = True
        try:
            got = im.pyramid_inpaint(base, hl)
            if got.shape != (hh, ww, 3):
                shape_ok = False
            # 常量图：填出来的也该是同一个常量（容许最粗层兜底的 128 边界情形）
            if hh > 2 and ww > 2 and not np.allclose(got, 150.0, atol=1.0):
                content_ok = False
        except Exception as exc:  # noqa: BLE001
            shape_ok = False
            print(f"      {hh}×{ww} 抛异常: {type(exc).__name__}: {exc}")
    chk("奇数/质数/极端尺寸都不崩且形状正确", shape_ok, f"扫了 {len(odd_sizes)} 种尺寸")
    chk("奇数尺寸下常量图仍能还原", content_ok)

    # 下采样与上采样必须互逆到"不小于原尺寸"
    inv_ok = True
    for hh, ww in odd_sizes + [(64, 64), (1200, 800)]:
        img = np.zeros((hh, ww, 3), np.float32)
        val = np.ones((hh, ww), np.float32)
        di, dv = im._downsample(img, val)
        up = im._upsample(di, (hh, ww))
        if up.shape != (hh, ww, 3):
            inv_ok = False
            print(f"      {hh}×{ww}: downsample→{di.shape[:2]} upsample→{up.shape[:2]}")
    chk("_upsample(_downsample(x)) 尺寸可还原", inv_ok)

    # ---------------- 反混合 ----------------
    print("\nunmultiply_background")

    bg = np.array([243.0, 243.0, 245.0], np.float32)
    subject = np.array([80.0, 60.0, 50.0], np.float32)
    alpha = 0.5
    observed = np.tile(alpha * subject + (1 - alpha) * bg, (4, 4, 1))
    alpha_map = np.full((4, 4), alpha, np.float32)
    fixed = im.unmultiply_background(observed, alpha_map, bg, strength=1.0)
    chk("反混合能还原真实主体色", bool(np.allclose(fixed[0, 0], subject, atol=1.5)),
        f"got={fixed[0,0].round(1).tolist()} want={subject.tolist()}")

    print("\n" + "=" * 60)
    if _FAILED:
        print(f"✗ {len(_FAILED)} 项失败: {', '.join(_FAILED)}")
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
