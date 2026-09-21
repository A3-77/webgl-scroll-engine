/**
 * PHASE 18 后处理 —— 语义映射层的契约测试
 * ===========================================================================
 * 这组测试钉住的**不是**渲染结果，而是一个曾经真实翻车的地方：
 *
 *   schema 用的是人类直觉的语义（倍率 1 = 原样），
 *   pmndrs/postprocessing 的 uniform 用的是偏移量语义（0 才是原样）。
 *
 * 2026-09-20 实测：cats 包声明 `saturation: 0.92`（本意"略降饱和"）被直接
 * 透传进 shader，走成 `diff * (1 - 1/(1.001-0.92))` ≈ `diff * -998`，
 * 整屏炸成霓虹色；再叠上 `brightness: 0.02 → color - 0.48` 压黑、
 * `contrast: 1.06 → color / -0.06` 反相，画面彻底报废。
 *
 * 因为映射是纯函数，这里可以直接把「schema 的值 → 库的值 → 实际效果」
 * 整条链算一遍，不需要 WebGL 上下文。这样下一个改这层的人
 * 只要把映射写错，测试立刻红 —— 而不是等到肉眼看画面才发现。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';
import {
  brightnessToLevel,
  contrastOffsetToGain,
  contrastToOffset,
  saturationToOffset,
} from './PostSystem';

describe('饱和度映射：schema 倍率 → pmndrs 偏移', () => {
  it('倍率 1（schema 的"原样"）必须映射到 pmndrs 的 0', () => {
    expect(saturationToOffset(1)).toBe(0);
  });

  it('倍率 0（schema 的"灰度"）必须映射到 pmndrs 的 -1', () => {
    expect(saturationToOffset(0)).toBe(-1);
  });

  it('★ 回归：0.92 绝不能原样透传', () => {
    // 这是 cats 包实际写的值。原样透传会让 shader 里的 1.001 - s 变成 0.081，
    // 分母级放大。修好之后它应该落在"轻微降饱和"的 -0.08。
    const offset = saturationToOffset(0.92);
    expect(offset).toBeCloseTo(-0.08, 6);
    expect(offset).not.toBe(0.92);
  });

  it('提升饱和时偏移为正，且永不触到 shader 的除零点（s < 1.001）', () => {
    expect(saturationToOffset(1.5)).toBeCloseTo(0.5, 6);
    // 无论倍率多大，偏移都要钳在 0.999 以下
    expect(saturationToOffset(1000)).toBeLessThanOrEqual(0.999);
    expect(1.001 - saturationToOffset(1000)).toBeGreaterThan(0);
  });
});

describe('对比度映射：schema 倍率 → pmndrs 偏移 → 实际增益', () => {
  it('倍率 1（schema 的"原样"）必须映射到 pmndrs 的 0，且增益恰好是 1', () => {
    const c = contrastToOffset(1);
    expect(c).toBe(0);
    expect(contrastOffsetToGain(c)).toBeCloseTo(1, 6);
  });

  it('★ 核心契约：映射回来的实际增益 == schema 承诺的倍率', () => {
    // 库内 shader 是两段式（c>0 走 1/(1-c)，c≤0 走 1+c），
    // 这里把两侧都覆盖到。
    for (const mult of [0.25, 0.5, 0.8, 1, 1.06, 1.5, 2, 4]) {
      const gain = contrastOffsetToGain(contrastToOffset(mult));
      expect(gain).toBeCloseTo(mult, 6);
    }
  });

  it('★ 回归：1.06 绝不能原样透传（会走成 color / -0.06 反相）', () => {
    const offset = contrastToOffset(1.06);
    expect(offset).toBeCloseTo(1 - 1 / 1.06, 6);
    // 原样透传会让 1 - c 变成负数，直接反相
    expect(1 - offset).toBeGreaterThan(0);
  });

  it('永不产生 c >= 1 的除零点', () => {
    for (const mult of [1, 2, 10, 100, 1e6]) {
      expect(contrastToOffset(mult)).toBeLessThan(1);
    }
  });
});

describe('亮度映射：schema 偏移 → pmndrs 电平', () => {
  it('是恒等映射 —— 这一项不需要平移', () => {
    for (const offset of [-1, -0.5, 0, 0.02, 0.25, 1]) {
      expect(brightnessToLevel(offset)).toBe(offset);
    }
  });

  it('★ 回归：绝不能平移 0.5（会把整屏推过 1.0 过曝）', () => {
    // 第一版修法以为 0.5 是中性，实测整屏过曝成白。
    expect(brightnessToLevel(0)).not.toBe(0.5);
  });
});

/**
 * 把库内 BrightnessContrast shader 的算式逐字抄成 JS。
 *
 *   color       = inputColor + (brightness - 0.5)
 *   color       = contrast > 0 ? color / (1 - contrast) : color * (1 + contrast)
 *   outputColor = color + 0.5
 *
 * 有了它，就可以断言「schema 语义 → uniform → 实际像素」整条链，
 * 而不只是断言中间那个数字。
 */
const applyBrightnessContrast = (
  input: number,
  brightnessOffset: number,
  contrastMult: number,
): number => {
  const b = brightnessToLevel(brightnessOffset);
  const c = contrastToOffset(contrastMult);
  let color = input + (b - 0.5);
  color = c > 0 ? color / (1 - c) : color * (1 + c);
  return color + 0.5;
};

describe('亮度/对比度：端到端恒等性', () => {
  it('★ schema 的中性值（brightness 0 / contrast 1）必须逐像素恒等', () => {
    for (const input of [0, 0.15, 0.5, 0.72, 1]) {
      expect(applyBrightnessContrast(input, 0, 1)).toBeCloseTo(input, 9);
    }
  });

  it('★ 回归：cats 包的 (0.02, 1.06) 必须只是轻微提亮，绝不能过曝', () => {
    // 修复前：contrast 1.06 透传 → color / (1 - 1.06) = color / -0.06 → 反相
    // 修复后：增益 1.06、偏移 +0.02。
    // 注意 shader 首尾的 -0.5 / +0.5 在增益 ≠ 1 时**不会**抵消，
    // 所以亮度偏移实际是按增益放大后参与：
    //   out = gain × (in + b − 0.5) + 0.5
    const gain = 1.06;
    const out = applyBrightnessContrast(0.8, 0.02, 1.06);
    expect(out).toBeCloseTo(gain * (0.8 + 0.02 - 0.5) + 0.5, 6); // ≈ 0.839
    expect(out).toBeLessThan(1);
  });

  it('★ 回归：brightness 平移 0.5 会让中灰直接过曝（证明那版修法错在哪）', () => {
    // 复现错误映射：把 brightness 当成"0.5 才是中性"
    const wrongLevel = 0.5 + 0.02;
    let color = 0.5 + (wrongLevel - 0.5); // = 0.52
    color = color / (1 - contrastToOffset(1.06));
    const out = color + 0.5; // = 1.051
    expect(out).toBeGreaterThan(1); // 中灰已经越界 —— 这就是当时的白屏
  });
});
