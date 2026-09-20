import { describe, it, expect } from 'vitest';
import {
  applyParallax,
  resolveParallax,
  DEFAULT_PARALLAX,
  type ParallaxLayer,
  type WorldOffset,
} from './ParallaxSystem';

const layer = (overrides: Partial<ParallaxLayer> = {}): ParallaxLayer => ({
  baseVisibleH: 10,
  parallax: 1,
  ...overrides,
});

const out = (): WorldOffset => ({ x: 0, y: 0 });

describe('ParallaxSystem.resolveParallax', () => {
  it('缺省值是 1（不放大也不缩小）', () => {
    expect(DEFAULT_PARALLAX).toBe(1);
  });

  it('config 写了 parallax=2.5 就用 2.5', () => {
    expect(resolveParallax({ parallax: 2.5 } as never)).toBe(2.5);
  });

  it('config 没写就用缺省值 1', () => {
    expect(resolveParallax({} as never)).toBe(1);
  });

  it('★ 一致性：缺省值永远等于 DEFAULT_PARALLAX（防止后续改一边忘了另一边）', () => {
    expect(resolveParallax({} as never)).toBe(DEFAULT_PARALLAX);
  });
});

describe('applyParallax —— 单位制与换算', () => {
  it('Y 方向：值 × baseVisibleH', () => {
    const o = out();
    applyParallax(layer({ baseVisibleH: 10 }), 0, 0.5, 2.0, o);
    expect(o.y).toBe(5); // 0.5 × 1 × 10
  });

  it('X 方向：值 × baseVisibleH × aspect（aspect 让横纵单位不同）', () => {
    const o = out();
    applyParallax(layer({ baseVisibleH: 10 }), 0.5, 0, 2.0, o);
    expect(o.x).toBe(10); // 0.5 × 1 × 10 × 2.0
  });

  it('★ 拆分前后行为契约：aspect=1 时 X 与 Y 同尺度', () => {
    // 拆分前 SceneBuilder.applyTime 闭包的 aspect 固定是 1（Composer 传 1，
    // 之后 setAspect 不更新它），所以本测试钉住的就是当前实际生效的换算，
    // 也是用户看见的观感。修复时把这个测试改掉再改 SceneBuilder。
    const o1 = out();
    const o2 = out();
    applyParallax(layer(), 0.3, 0, 1.0, o1); // aspect = 1
    applyParallax(layer(), 0, 0.3, 1.0, o2); // aspect = 1
    expect(o1.x).toBe(o2.y); // X 和 Y 在 aspect=1 时位移幅度一致
  });

  it('aspect=2 时 X 是 Y 的 2 倍（同轨道值横向走得更远，匹配屏幕更宽）', () => {
    const o = out();
    applyParallax(layer(), 0.3, 0.3, 2.0, o);
    expect(o.x / o.y).toBe(2);
  });

  it('parallax 倍率只放大位移，不影响 baseX/baseY（基线位置由 offset 单独算）', () => {
    const base = out();
    const doubled = out();
    applyParallax(layer({ parallax: 1 }), 0.2, 0.3, 1.5, base);
    applyParallax(layer({ parallax: 2 }), 0.2, 0.3, 1.5, doubled);
    expect(doubled.x).toBeCloseTo(base.x * 2);
    expect(doubled.y).toBeCloseTo(base.y * 2);
  });

  it('轨道值为 0 → 不产生位移', () => {
    const o = out();
    applyParallax(layer(), 0, 0, 2.5, o);
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
  });

  it('复用 out 容器，不分配新对象（GC 友好）', () => {
    const o = out();
    const lay = layer({ baseVisibleH: 1 }); // 简化为 1，方便看 vx/vy 直接落到 out
    applyParallax(lay, 1, 2, 1.0, o);
    expect(o.x).toBe(1);
    expect(o.y).toBe(2);
    const ref = o;
    applyParallax(lay, 3, 4, 1.0, o);
    expect(o).toBe(ref);
    expect(o.x).toBe(3);
    expect(o.y).toBe(4);
  });

  it('baseVisibleH = 0 时（极端错误配置）输出就是 0，不会爆 NaN', () => {
    const o = out();
    applyParallax(layer({ baseVisibleH: 0 }), 0.5, 0.5, 2.0, o);
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
  });
});