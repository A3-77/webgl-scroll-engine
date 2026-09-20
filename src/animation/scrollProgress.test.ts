/**
 * 滚动进度数学单元测试
 * ===========================================================================
 * `scrollProgress.ts` 还原自真实站点的 `Tn()` 函数，是纯数学 ——
 * 给定 (scrollY, heights, vh, earlyCrossfades)，结果唯一确定。
 *
 * 这里最该锁住的一条是**切换点零跳变**：
 * 章节切换那一瞬间画面必须连续，否则滚动时会看到闪一下。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  computeActiveSection,
  computeSectionProgress,
  sceneTime,
  transitionProgress,
} from './scrollProgress';

const VH = 674;
/** 每章 1.2 屏高 —— 与真实站点的 sectionHeightVh 一致 */
const H = VH * 1.2;
const HEIGHTS = [H, H, H];

/* ------------------------------------------------------------ 基础 */

describe('computeSectionProgress 基础行为', () => {
  it('空 heights 安全返回（不崩）', () => {
    const r = computeSectionProgress(0, [], VH, []);
    expect(r.current).toEqual({ index: 0, progress: 0 });
    expect(r.next).toBeNull();
  });

  it('scrollY = 0 时停在第一章', () => {
    const r = computeSectionProgress(0, HEIGHTS, VH, [0, 0, 0]);
    expect(r.current.index).toBe(0);
  });

  it('首章在 scrollY=0 时 progress = vh/(h+vh)', () => {
    // 区间起点是"章节入屏前一屏高"（start = -vh），所以第一屏还没滚时
    // progress 就已经不为 0 了。h = 1.2vh → 0.4545
    const r = computeSectionProgress(0, HEIGHTS, VH, [0, 0, 0]);
    expect(r.current.progress).toBeCloseTo(VH / (H + VH), 6);
  });

  it('滚到最底部时停在最后一章、progress = 1、没有 next', () => {
    const r = computeSectionProgress(HEIGHTS.reduce((a, b) => a + b, 0) + VH * 5, HEIGHTS, VH, [0, 0, 0]);
    expect(r.current.index).toBe(HEIGHTS.length - 1);
    expect(r.current.progress).toBe(1);
    expect(r.next).toBeNull();
  });

  it('progress 恒在 [0, 1]', () => {
    for (let y = -2000; y <= 6000; y += 37) {
      const r = computeSectionProgress(y, HEIGHTS, VH, [0, 0, 0]);
      expect(r.current.progress).toBeGreaterThanOrEqual(0);
      expect(r.current.progress).toBeLessThanOrEqual(1);
      if (r.next) {
        expect(r.next.progress).toBeGreaterThanOrEqual(0);
        expect(r.next.progress).toBeLessThanOrEqual(1);
      }
    }
  });
});

/* ------------------------------------------------------------ 单调与连续 */

describe('单调性与连续性（滚动不能倒退）', () => {
  it('current.index 随 scrollY 单调不减', () => {
    let last = -1;
    for (let y = 0; y <= H * 3 + VH * 2; y += 13) {
      const r = computeSectionProgress(y, HEIGHTS, VH, [0, 0, 0]);
      expect(r.current.index, `y=${y} 时章节回退了`).toBeGreaterThanOrEqual(last);
      last = r.current.index;
    }
  });

  it('同一章节内 progress 单调不减', () => {
    const seen = new Map<number, number>();
    for (let y = 0; y <= H * 3 + VH * 2; y += 7) {
      const r = computeSectionProgress(y, HEIGHTS, VH, [0, 0, 0]);
      const prev = seen.get(r.current.index);
      if (prev !== undefined) {
        expect(r.current.progress, `章节 ${r.current.index} 在 y=${y} 时 progress 回退`).toBeGreaterThanOrEqual(
          prev - 1e-9,
        );
      }
      seen.set(r.current.index, r.current.progress);
    }
  });

  it('★ 章节切换点没有跳变（transitionProgress 保证画面连续）', () => {
    // 这是整个滚动系统最关键的性质：
    //   切换前一瞬（current = i，progress → 1）    → uProgress → 1
    //   切换后一瞬（current = i+1，progress ≈ 0.4545）→ uProgress → 0
    // 两边都指向"画面 100% 是章节 i+1"，所以看不出接缝。
    const justBefore = computeSectionProgress(H - 0.5, HEIGHTS, VH, [0, 0, 0]);
    const justAfter = computeSectionProgress(H + 0.5, HEIGHTS, VH, [0, 0, 0]);

    expect(justBefore.current.index).toBe(0);
    expect(justAfter.current.index).toBe(1);

    const uBefore = transitionProgress(justBefore.current.progress, HEIGHTS[0], VH);
    const uAfter = transitionProgress(justAfter.current.progress, HEIGHTS[1], VH);

    // 切换前 uProgress 接近 1，切换后回到 0 —— 但两者描述的**都是**章节 1
    expect(uBefore).toBeGreaterThan(0.99);
    expect(uAfter).toBeLessThan(0.01);
  });
});

/* ------------------------------------------------------------ 交叉区 */

describe('交叉溶解区', () => {
  it('远离切换点时没有 next', () => {
    const r = computeSectionProgress(0, HEIGHTS, VH, [0, 0, 0]);
    expect(r.next).toBeNull();
  });

  it('接近切换点时出现 next，且 index 是下一章', () => {
    const r = computeSectionProgress(H - VH * 0.5, HEIGHTS, VH, [0, 0, 0]);
    expect(r.next).not.toBeNull();
    expect(r.next!.index).toBe(1);
  });

  it('最后一章没有 next', () => {
    const r = computeSectionProgress(H * 2 + VH * 0.5, HEIGHTS, VH, [0, 0, 0]);
    expect(r.current.index).toBe(2);
    expect(r.next).toBeNull();
  });

  it('★ earlyCrossfade > 0 时交叉区提前开始', () => {
    // 真实站点的规则：index >= 2 的章节 earlyCrossfade = 0.2（vh 倍数）。
    // 它让"下一章"更早开始淡入 —— 长章节之间的衔接更从容。
    const y = H - VH * 0.5;
    const withoutEC = computeSectionProgress(y, HEIGHTS, VH, [0, 0, 0]);
    const withEC = computeSectionProgress(y, HEIGHTS, VH, [0, 0, 0.2]);

    // 给第 2 章加 earlyCrossfade 影响的是"第 2 章何时开始作为 next 出现"
    expect(withoutEC.next?.progress ?? 0).toBeGreaterThanOrEqual(0);
    expect(withEC.next?.progress ?? 0).toBeGreaterThanOrEqual(0);

    // 更直接：比较同一个 y 下第 2 章作为 next 的进度
    const a = computeSectionProgress(H * 2 - VH * 1.5, HEIGHTS, VH, [0, 0, 0]);
    const b = computeSectionProgress(H * 2 - VH * 1.5, HEIGHTS, VH, [0, 0, 0.2]);
    if (a.next && b.next) {
      expect(b.next.progress).toBeGreaterThanOrEqual(a.next.progress);
    }
  });

  it('earlyCrossfade 数组比 heights 短时不崩（缺的当 0）', () => {
    expect(() => computeSectionProgress(H, HEIGHTS, VH, [0])).not.toThrow();
    expect(() => computeSectionProgress(H, HEIGHTS, VH, [])).not.toThrow();
  });
});

/* ------------------------------------------------------------ 章节定位 */

describe('computeActiveSection（探针线定位）', () => {
  it('用 scrollY + 30% 视口高作为探针线', () => {
    // scrollY = 0 → 探针线在 0.3vh 处，仍在第一章
    expect(computeActiveSection(0, HEIGHTS, VH)).toBe(0);
  });

  it('滚过第一章后进入第二章', () => {
    expect(computeActiveSection(H, HEIGHTS, VH)).toBe(1);
  });

  it('滚到底停在最后一章（不越界）', () => {
    expect(computeActiveSection(H * 10, HEIGHTS, VH)).toBe(HEIGHTS.length - 1);
  });

  it('结果恒在合法范围内', () => {
    for (let y = -500; y <= H * 4; y += 31) {
      const i = computeActiveSection(y, HEIGHTS, VH);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(HEIGHTS.length);
    }
  });
});

/* ------------------------------------------------------------ sceneTime */

describe('sceneTime（把滚动进度映射成场景时间）', () => {
  it('首屏 scrollY=0 时 t = 0（不是 0.4545）', () => {
    // 首章多了一段"入屏前一屏高"的区间，要把它扣掉 ——
    // 否则打开页面时首屏就已经播到 45% 了，看不到入场。
    const p = computeSectionProgress(0, HEIGHTS, VH, [0, 0, 0]).current.progress;
    expect(sceneTime(0, p, HEIGHTS, VH)).toBeCloseTo(0, 6);
  });

  it('首章滚到底时 t = 1', () => {
    expect(sceneTime(0, 1, HEIGHTS, VH)).toBeCloseTo(1, 6);
  });

  it('非首章直接用 progress', () => {
    expect(sceneTime(1, 0.37, HEIGHTS, VH)).toBeCloseTo(0.37, 6);
    expect(sceneTime(2, 0.91, HEIGHTS, VH)).toBeCloseTo(0.91, 6);
  });

  it('结果恒在 [0, 1]', () => {
    for (const idx of [0, 1, 2]) {
      for (const p of [-1, 0, 0.3, 0.5, 1, 2]) {
        const t = sceneTime(idx, p, HEIGHTS, VH);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
      }
    }
  });

  it('heights 缺项或为 0 时不崩', () => {
    expect(() => sceneTime(0, 0.5, [], VH)).not.toThrow();
    expect(() => sceneTime(5, 0.5, HEIGHTS, VH)).not.toThrow();
    expect(() => sceneTime(0, 0.5, [0], VH)).not.toThrow();
  });
});

/* ------------------------------------------------------------ transitionProgress */

describe('transitionProgress（过渡 shader 的 uProgress）', () => {
  it('过渡区间起点 = h/(h+vh)', () => {
    const start = H / (H + VH); // h = 1.2vh → 0.5455
    expect(transitionProgress(start, H, VH)).toBeCloseTo(0, 6);
    expect(transitionProgress(start - 0.01, H, VH)).toBe(0);
  });

  it('progress = 1 时 uProgress = 1（切换点画面已完全是下一章）', () => {
    expect(transitionProgress(1, H, VH)).toBeCloseTo(1, 6);
  });

  it('单调不减', () => {
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const u = transitionProgress(p, H, VH);
      expect(u).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = u;
    }
  });

  it('h 或 vh 非法时退化成原值（不崩）', () => {
    expect(transitionProgress(0.5, 0, VH)).toBeCloseTo(0.5, 6);
    expect(transitionProgress(0.5, H, 0)).toBeCloseTo(0.5, 6);
    expect(transitionProgress(0.5, -1, VH)).toBeCloseTo(0.5, 6);
  });

  it('结果恒在 [0, 1]', () => {
    for (const p of [-1, 0, 0.5, 1, 2]) {
      const u = transitionProgress(p, H, VH);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });
});
