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

  it('★ 材料本身不参与脉动 —— mono / 纸色 / 墨色 / 墨线阈值', () => {
    const still = resolveMedium({ mono: 0.5, inkThreshold: 0.08, pulse: 1 }, 0);
    const fast = resolveMedium({ mono: 0.5, inkThreshold: 0.08, pulse: 1 }, 1);

    // 让纸的底色随滚动变来变去，读起来是"曝光在抖"，不是"印刷在呼吸"
    expect(fast.mono).toBe(still.mono);
    expect(fast.inkThreshold).toBe(still.inkThreshold);
    expect(fast.paperColor).toBe(still.paperColor);
    expect(fast.inkColor).toBe(still.inkColor);
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
});
