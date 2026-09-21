/**
 * 指针契约测试（PHASE 26）
 * ===========================================================================
 * 这一份只测 `resolvePointer` —— 也就是"内容包声明 → 引擎能吃的配置"
 * 这一步的**折算规则**。真正的平滑与偏移计算在 PointerSystem.test.ts。
 *
 * 最要紧的一条是「零行为变更」：不声明 `site.pointer` 时必须是关的。
 */

import { describe, expect, it } from 'vitest';
import { POINTER_PARALLAX, resolvePointer } from './pointer';

describe('resolvePointer —— 零行为变更契约', () => {
  it('★ 不传配置 → 关。不声明 site.pointer 的内容包，相机一个像素都不动', () => {
    const r = resolvePointer();
    expect(r.enabled).toBe(false);
  });

  it('传 null → 同样是关', () => {
    expect(resolvePointer(null).enabled).toBe(false);
  });

  it('传空对象 → 还是关（enabled 默认 false，不是 true）', () => {
    expect(resolvePointer({}).enabled).toBe(false);
  });

  it('关的时候 parallax / damping 都退化成 0', () => {
    const r = resolvePointer();
    expect(r.parallax).toBe(0);
    expect(r.damping).toBe(0);
  });
});

describe('resolvePointer —— 默认值必须是中性的', () => {
  it('★ axis 默认 [1, 1]，不能是预设里那组不对称值', () => {
    // 预设的 [0.35, 0.25] 是"照搬参考站点"的审美选择，
    // 不该悄悄变成所有人的默认 —— 否则没声明 axis 的包会莫名其妙只有 1/3 幅度。
    expect(resolvePointer({ enabled: true }).axis).toEqual([1, 1]);
  });

  it('respectReducedMotion 默认 true（无障碍是默认开启的，不是可选加分项）', () => {
    expect(resolvePointer({ enabled: true }).respectReducedMotion).toBe(true);
  });
});

describe('resolvePointer —— prefers-reduced-motion', () => {
  it('★ 开了开关 + 系统要求减少动态 → 整条关掉，不是只调小', () => {
    const r = resolvePointer({ enabled: true, parallax: 0.035 }, true);
    expect(r.enabled).toBe(false);
  });

  it('系统没要求减少动态 → 正常开', () => {
    expect(resolvePointer({ enabled: true }, false).enabled).toBe(true);
  });

  it('显式声明 respectReducedMotion: false → 系统要求也照跑', () => {
    const r = resolvePointer(
      { enabled: true, respectReducedMotion: false },
      true,
    );
    expect(r.enabled).toBe(true);
  });

  it('reducedMotion 只在"本来就想开"时才有意义 —— 关着的不会因为 reducedMotion=false 被打开', () => {
    expect(resolvePointer({ enabled: false }, false).enabled).toBe(false);
  });

  it('respectReducedMotion 本身被如实回传（调用方要能看出来为什么关着）', () => {
    expect(resolvePointer({ enabled: true }, true).respectReducedMotion).toBe(true);
    expect(
      resolvePointer({ enabled: true, respectReducedMotion: false }, true)
        .respectReducedMotion,
    ).toBe(false);
  });
});

describe('resolvePointer —— 数值兜底', () => {
  it('负的 parallax / damping 被夹到 0（负幅度会让画面反向漂，是个 bug 不是风格）', () => {
    const r = resolvePointer({ enabled: true, parallax: -1, damping: -0.5 });
    expect(r.parallax).toBe(0);
    expect(r.damping).toBe(0);
  });

  it('0 是合法值（等于关掉幅度但保留配置结构）', () => {
    const r = resolvePointer({ enabled: true, parallax: 0, damping: 0 });
    expect(r.parallax).toBe(0);
    expect(r.damping).toBe(0);
  });

  it('只给 axis 的一半 → 另一半补 1', () => {
    expect(resolvePointer({ enabled: true, axis: [0.5, 0.5] }).axis).toEqual([0.5, 0.5]);
  });

  it('★ axis 允许负数（反向视差是个正当的创作选择，不该被夹掉）', () => {
    const r = resolvePointer({ enabled: true, axis: [-0.4, 0.2] });
    expect(r.axis[0]).toBe(-0.4);
    expect(r.axis[1]).toBe(0.2);
  });
});

describe('POINTER_PARALLAX 出厂预设', () => {
  it('是开着的', () => {
    expect(POINTER_PARALLAX.enabled).toBe(true);
  });

  it('parallax 与参考站点一致（0.035 ≈ 目标距离处 ±2°）', () => {
    expect(POINTER_PARALLAX.parallax).toBeCloseTo(0.035, 6);
  });

  it('横纵不对称，且横向大于纵向（人眼对横向更敏感，纵向给满会晕）', () => {
    const [ax, ay] = POINTER_PARALLAX.axis!;
    expect(ax).toBeGreaterThan(ay);
    expect(ay).toBeGreaterThan(0);
  });

  it('damping > 0 —— 指针是跳变输入，不平滑会"啪"地跳一下', () => {
    expect(POINTER_PARALLAX.damping!).toBeGreaterThan(0);
  });

  it('经 resolvePointer 之后仍然可用', () => {
    const r = resolvePointer(POINTER_PARALLAX);
    expect(r.enabled).toBe(true);
    expect(r.parallax).toBeCloseTo(0.035, 6);
    expect(r.axis).toEqual([0.35, 0.25]);
  });

  it('预设被 reducedMotion 关掉时也是整条关（预设不豁免无障碍）', () => {
    expect(resolvePointer(POINTER_PARALLAX, true).enabled).toBe(false);
  });
});
