/**
 * 媒介层契约的单元测试（PHASE 25）
 * ===========================================================================
 * 这里测的是**纯函数** `resolveMedium`，不是渲染。
 *
 * 为什么它值得单测：它是「内容包声明的旋钮」和「shader 实际吃到的数」之间
 * **唯一**的翻译点。翻译错了不会报错，只会让画面悄悄变样 ——
 * 而那种缺陷会伪装成"素材有问题"，极难定位（PHASE 18 就是这么栽的）。
 *
 * 所以这里钉死三件事：
 *   ① 零行为变更契约：什么都不声明时，所有强度必须是 0
 *   ② pulse 只该动该动的旋钮
 *   ③ 会当除数的旋钮必须钳住下界
 */

import { describe, expect, it } from 'vitest';
import { MEDIUM_PRINT, resolveMedium } from './medium';

describe('resolveMedium —— 零行为变更契约', () => {
  it('什么都不声明时，所有强度必须是 0（shader 退化成恒等）', () => {
    const r = resolveMedium({});

    // 这五个是 shader 里 `if (u > 0.0)` 的闸门。
    // 任何一个非 0，不声明媒介层的内容包画面就会变。
    expect(r.halftone).toBe(0);
    expect(r.dither).toBe(0);
    expect(r.inkEdge).toBe(0);
    expect(r.paper).toBe(0);
    expect(r.grain).toBe(0);
    expect(r.mono).toBe(0);
  });

  it('★ enabled 不是 resolveMedium 的事 —— 它决定要不要跑 pass，不影响数值', () => {
    // enabled:false 时引擎根本不调 resolveMedium（一个 pass 都不跑）。
    // 所以即使这里传了 enabled:false，数值也不该被"清零" ——
    // 那会让"关掉再打开"时旋钮值丢失。
    const off = resolveMedium({ enabled: false, halftone: 0.5 });
    expect(off.halftone).toBe(0.5);
  });

  it('所有旋钮为 0 时，活跃度再高也不会凭空长出效果', () => {
    const r = resolveMedium({ pulse: 1 }, 1);
    expect(r.halftone).toBe(0);
    expect(r.inkEdge).toBe(0);
    expect(r.paper).toBe(0);
    expect(r.grain).toBe(0);
    expect(r.dither).toBe(0);
  });
});

describe('resolveMedium —— pulse 展开', () => {
  it('pulse=0 时，活跃度完全不起作用', () => {
    const still = resolveMedium({ halftone: 0.4 }, 0);
    const fast = resolveMedium({ halftone: 0.4 }, 1);
    expect(fast.halftone).toBe(still.halftone);
  });

  it('实际强度 = base × (1 + pulse × 活跃度)', () => {
    const r = resolveMedium({ halftone: 0.4, pulse: 0.5 }, 1);
    expect(r.halftone).toBeCloseTo(0.4 * 1.5, 10);
  });

  it('活跃度被钳在 0..1 —— 传 5 不该变成 6 倍', () => {
    const r = resolveMedium({ halftone: 0.4, pulse: 1 }, 5);
    expect(r.halftone).toBeCloseTo(0.4 * 2, 10);
  });

  it('展开后超过 1 会被钳住（否则网点强度 1.8 会让画面全黑）', () => {
    const r = resolveMedium({ halftone: 0.9, pulse: 1 }, 1);
    expect(r.halftone).toBe(1);
  });

  it('★ 材料本身不参与脉动 —— mono / 分级 / 纸色 / 墨色 / 墨线阈值', () => {
    const still = resolveMedium({ mono: 0.5, inkThreshold: 0.08, pulse: 1 }, 0);
    const fast = resolveMedium({ mono: 0.5, inkThreshold: 0.08, pulse: 1 }, 1);

    // 让纸的底色随滚动变来变去，读起来是"曝光在抖"，不是"印刷在呼吸"
    expect(fast.mono).toBe(still.mono);
    expect(fast.inkThreshold).toBe(still.inkThreshold);
    expect(fast.paperColor).toBe(still.paperColor);
    expect(fast.inkColor).toBe(still.inkColor);
  });

  it('★ 分级（黑白场/对比）也不参与脉动 —— 它是"材料的密度"，不是"呼吸的幅度"', () => {
    const still = resolveMedium(
      { blackPoint: 0.3, whitePoint: 0.91, contrast: 0.15, pulse: 1 },
      0,
    );
    const fast = resolveMedium(
      { blackPoint: 0.3, whitePoint: 0.91, contrast: 0.15, pulse: 1 },
      1,
    );

    // 让黑场随滚动上下浮动，等于"整幅画的曝光在抽"，不是印刷在呼吸
    expect(fast.blackPoint).toBe(still.blackPoint);
    expect(fast.whitePoint).toBe(still.whitePoint);
    expect(fast.contrast).toBe(still.contrast);
  });
});

describe('resolveMedium —— 分级必须退化成恒等', () => {
  it('★ 不声明分级时必须是恒等映射（blackPoint 0 / whitePoint 1 / contrast 0）', () => {
    // shader 的 gradeTone 在这组值下是 f(l) = l：
    //   clamp((l - 0) / 1) → l，再 (l - 0.5) * 1 + 0.5 → l
    // 如果这里换成别的默认值，所有"只声明了 halftone 的旧配置"画面都会变 ——
    // 这正是 PHASE 18 那类"配置没动、结果变了"的缺陷。
    const r = resolveMedium({});
    expect(r.blackPoint).toBe(0);
    expect(r.whitePoint).toBe(1);
    expect(r.contrast).toBe(0);
  });

  it('★ 白场必须严格大于黑场 —— 否则 levels 的分母会变负，画面反相', () => {
    // shader 里 max(uWhitePoint - uBlackPoint, 1e-3) 兜住了 0，但兜不住负数
    const r = resolveMedium({ blackPoint: 0.8, whitePoint: 0.2 });
    expect(r.whitePoint).toBeGreaterThan(r.blackPoint);
    expect(r.whitePoint).toBeCloseTo(0.81, 10);
  });

  it('黑白场相等时也要被拉开 —— 否则分母趋 0，一个像素之差就是全黑或全白', () => {
    const r = resolveMedium({ blackPoint: 0.5, whitePoint: 0.5 });
    expect(r.whitePoint - r.blackPoint).toBeGreaterThanOrEqual(0.01);
  });

  it('黑场/白场/对比都被钳在 0..1', () => {
    const r = resolveMedium({ blackPoint: -1, whitePoint: 5, contrast: 3 });
    expect(r.blackPoint).toBe(0);
    expect(r.whitePoint).toBe(1);
    expect(r.contrast).toBe(1);
  });
});

describe('resolveMedium —— 会当除数的旋钮必须钳住', () => {
  it('★ halftoneScale 下界是 1 —— shader 里 gl_FragCoord / uHalftoneScale', () => {
    // 给 0 会得到 Inf 网格坐标，整屏变成一个颜色（且不报错）
    expect(resolveMedium({ halftoneScale: 0 }).halftoneScale).toBe(1);
    expect(resolveMedium({ halftoneScale: -3 }).halftoneScale).toBe(1);
    expect(resolveMedium({ halftoneScale: 6 }).halftoneScale).toBe(6);
  });

  it('★ ditherLevels 下界是 2 —— 给 1 会把画面压成纯黑或纯白', () => {
    expect(resolveMedium({ ditherLevels: 0 }).ditherLevels).toBe(2);
    expect(resolveMedium({ ditherLevels: 1 }).ditherLevels).toBe(2);
    expect(resolveMedium({ ditherLevels: 6 }).ditherLevels).toBe(6);
  });
});

describe('resolveMedium —— 出厂预设', () => {
  it('MEDIUM_PRINT 是一份可以直接用的配置', () => {
    const r = resolveMedium(MEDIUM_PRINT, 0);

    // 预设的意义就是"不调也能看"，所以每一项都该落在合理区间
    expect(r.halftone).toBeGreaterThan(0);
    expect(r.halftone).toBeLessThan(1);
    expect(r.inkEdge).toBeGreaterThan(0);
    expect(r.inkThreshold).toBeGreaterThan(0);
    expect(r.paper).toBeGreaterThan(0);
    expect(r.grain).toBeGreaterThan(0);
    expect(r.halftoneScale).toBeGreaterThanOrEqual(1);
    expect(r.ditherLevels).toBeGreaterThanOrEqual(2);
  });

  it('预设里 dither 是关的 —— 它和网点是两种语言，同时开会互相打架', () => {
    expect(resolveMedium(MEDIUM_PRINT, 0).dither).toBe(0);
  });

  it('预设带一个可用的分级 —— 不然预设印出来是一片浅灰', () => {
    const r = resolveMedium(MEDIUM_PRINT, 0);
    expect(r.whitePoint).toBeGreaterThan(r.blackPoint);
    // 至少要把 10% 的暗部压成实黑、10% 的亮部留成纸白
    expect(r.blackPoint).toBeGreaterThan(0.05);
    expect(r.whitePoint).toBeLessThan(0.95);
  });
});

describe('网点半径上限 —— 一个曾经印不出实黑的 bug', () => {
  /**
   * shader 里：radius = sqrt(1 - inkTone) * K
   *
   * 格子是 `fract(p) - 0.5`，所以格子内最远的点距中心 sqrt(0.5) ≈ 0.7071。
   * **K 必须 ≥ 0.7071**，否则 inkTone = 0（最黑）时半径也够不到角落，
   * 画面在数学上就印不出实黑 —— 只有一片灰。
   *
   * 这里不跑 shader，只把这个不等式钉住，防止有人"调小一点更柔和"。
   */
  const K = 0.78;
  const CELL_CIRCUMRADIUS = Math.SQRT1_2;

  it('★ K 必须大于等于格子外接圆半径，否则最黑的像素也铺不满', () => {
    expect(K).toBeGreaterThanOrEqual(CELL_CIRCUMRADIUS);
  });

  it('最黑处半径 ≥ 外接圆半径 → 全黑是可达的', () => {
    const radiusAtBlack = Math.sqrt(1 - 0) * K;
    expect(radiusAtBlack).toBeGreaterThanOrEqual(CELL_CIRCUMRADIUS);
  });

  it('最白处半径为 0 → 纸白是可达的', () => {
    expect(Math.sqrt(1 - 1) * K).toBe(0);
  });
});
