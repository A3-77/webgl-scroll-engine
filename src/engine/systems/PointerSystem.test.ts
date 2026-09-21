/**
 * 指针系统测试（PHASE 26）
 * ===========================================================================
 * 测两件事，各自对应一类真实的 bug：
 *
 *   ▸ 坐标翻转 —— 漏了它表现为"鼠标往下移画面往上走"，
 *     而且极难联想到是坐标系问题（看起来像"视差方向写反了"）
 *   ▸ 帧率无关 —— 用固定系数而不是 `1 - exp(-dt/damping)` 的话，
 *     144fps 下跟得比 30fps 紧得多，同一段代码在两台机器上手感不同
 */

import { describe, expect, it } from 'vitest';
import { resolvePointer, type ResolvedPointer } from '../../schema';
import { PointerSystem } from './PointerSystem';

/** 造一个确定性的配置，不受预设变化影响 */
function cfg(over: Partial<ResolvedPointer> = {}): ResolvedPointer {
  return {
    enabled: true,
    parallax: 0.035,
    axis: [1, 1],
    damping: 0,
    respectReducedMotion: true,
    ...over,
  };
}

describe('PointerSystem —— 关掉时必须是彻底不动', () => {
  it('★ enabled:false → 无论喂什么指针，偏移恒为 (0,0)', () => {
    const sys = new PointerSystem(cfg({ enabled: false }));
    sys.apply(1 / 60, [1, 0]); // 右上角，最极端的位置
    expect(sys.offsetFor(6)).toEqual({ x: 0, y: 0 });
  });

  it('关掉时 value 也恒为 0', () => {
    const sys = new PointerSystem(cfg({ enabled: false }));
    sys.apply(1 / 60, [0.9, 0.1]);
    expect(sys.value).toEqual([0, 0]);
  });

  it('运行中途被关掉 → 立刻归零，不会留一个残值卡在画面上', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1, [1, 1]); // 推到角落
    expect(sys.value[0]).not.toBe(0);
    sys.syncConfig(cfg({ enabled: false }));
    expect(sys.value).toEqual([0, 0]);
    expect(sys.offsetFor(6)).toEqual({ x: 0, y: 0 });
  });
});

describe('PointerSystem —— 坐标系翻转', () => {
  it('指针在屏幕正中 → 0', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [0.5, 0.5]);
    expect(sys.value[0]).toBeCloseTo(0, 6);
    expect(sys.value[1]).toBeCloseTo(0, 6);
  });

  it('★ 屏幕右上角 [1,0] → x 为正、y 为正（+y 向上）', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [1, 0]);
    expect(sys.value[0]).toBeCloseTo(1, 6);
    expect(sys.value[1]).toBeCloseTo(1, 6); // ★ 不是 -1 —— 这里就是最容易写反的地方
  });

  it('★ 屏幕左下角 [0,1] → x 为负、y 为负', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [0, 1]);
    expect(sys.value[0]).toBeCloseTo(-1, 6);
    expect(sys.value[1]).toBeCloseTo(-1, 6);
  });

  it('不喂输入 → 目标取中心（指针还没进过画面）', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60);
    expect(sys.value).toEqual([0, 0]);
  });
});

describe('PointerSystem —— 平滑', () => {
  it('damping 0 → 瞬时跟上', () => {
    const sys = new PointerSystem(cfg({ damping: 0 }));
    sys.apply(1 / 60, [1, 0.5]);
    expect(sys.value[0]).toBeCloseTo(1, 6);
  });

  it('damping > 0 → 一帧不会跟满', () => {
    const sys = new PointerSystem(cfg({ damping: 0.12 }));
    sys.apply(1 / 60, [1, 0.5]);
    expect(sys.value[0]).toBeGreaterThan(0);
    expect(sys.value[0]).toBeLessThan(1);
  });

  it('一步 dt = damping → 走完全程的 1 - 1/e ≈ 0.632', () => {
    const sys = new PointerSystem(cfg({ damping: 0.12 }));
    sys.apply(0.12, [1, 0.5]);
    expect(sys.value[0]).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('★★ 帧率无关：60fps 跑 1 秒 === 30fps 跑 1 秒', () => {
    // 这条是"固定系数"写法的照妖镜。用 k = damping 这种写法的话，
    // 下面两个数会明显不同（步数多的那个走得更远）。
    const a = new PointerSystem(cfg({ damping: 0.12 }));
    for (let i = 0; i < 60; i++) a.apply(1 / 60, [1, 0.5]);

    const b = new PointerSystem(cfg({ damping: 0.12 }));
    for (let i = 0; i < 30; i++) b.apply(1 / 30, [1, 0.5]);

    expect(a.value[0]).toBeCloseTo(b.value[0], 6);

    // 而且都收敛到 exp(-T/damping) 那个解析值
    expect(a.value[0]).toBeCloseTo(1 - Math.exp(-1 / 0.12), 4);
  });

  it('dt = 0 且 damping > 0 → 不动（首帧/暂停时不推进）', () => {
    const sys = new PointerSystem(cfg({ damping: 0.12 }));
    sys.apply(0, [1, 0.5]);
    expect(sys.value).toEqual([0, 0]);
  });

  it('reset() 归零', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1, [1, 1]);
    sys.reset();
    expect(sys.value).toEqual([0, 0]);
    expect(sys.offsetFor(6)).toEqual({ x: 0, y: 0 });
  });
});

describe('PointerSystem.offsetFor —— 幅度', () => {
  it('偏移 = 指针 × parallax × 距离 × axis', () => {
    const sys = new PointerSystem(cfg({ parallax: 0.035, axis: [0.35, 0.25] }));
    sys.apply(1 / 60, [1, 0]); // 右上角 → (1, 1)

    const off = sys.offsetFor(6);
    expect(off.x).toBeCloseTo(1 * 0.035 * 6 * 0.35, 6);
    expect(off.y).toBeCloseTo(1 * 0.035 * 6 * 0.25, 6);
  });

  it('★ 距离越大偏移越大 —— 这样观感才是恒定的角度偏移', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [1, 0.5]);
    const near = sys.offsetFor(2).x;
    const far = sys.offsetFor(12).x;
    expect(far).toBeCloseTo(near * 6, 6);
  });

  it('距离为 0 → 偏移为 0（相机贴在场景上时不该晃）', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [1, 0.5]);
    expect(sys.offsetFor(0)).toEqual({ x: 0, y: 0 });
  });

  it('负距离被夹到 0，不会算出反向偏移', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [1, 0.5]);
    expect(sys.offsetFor(-6)).toEqual({ x: 0, y: 0 });
  });

  it('axis 为负 → 该轴反向', () => {
    const sys = new PointerSystem(cfg({ axis: [-1, 1] }));
    sys.apply(1 / 60, [1, 0]);
    expect(sys.offsetFor(6).x).toBeLessThan(0);
    expect(sys.offsetFor(6).y).toBeGreaterThan(0);
  });

  it('★ 复用同一个对象，避免在渲染循环里每帧分配', () => {
    const sys = new PointerSystem(cfg());
    sys.apply(1 / 60, [1, 0.5]);
    expect(sys.offsetFor(6)).toBe(sys.offsetFor(6));
  });
});

describe('PointerSystem —— 与 resolvePointer 串起来', () => {
  it('★ 不声明 site.pointer 的完整链路 → 恒定 (0,0)', () => {
    const sys = new PointerSystem(resolvePointer());
    for (let i = 0; i < 10; i++) sys.apply(1 / 60, [1, 0]);
    expect(sys.offsetFor(6)).toEqual({ x: 0, y: 0 });
  });

  it('系统要求减少动态 → 完整链路同样恒定 (0,0)', () => {
    const sys = new PointerSystem(resolvePointer({ enabled: true }, true));
    for (let i = 0; i < 10; i++) sys.apply(1 / 60, [1, 0]);
    expect(sys.offsetFor(6)).toEqual({ x: 0, y: 0 });
  });
});
