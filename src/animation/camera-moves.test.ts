/**
 * camera-moves 单元测试
 * ===========================================================================
 *     npm test
 *
 * ---------------------------------------------------------------------------
 * 【为什么这些用例值得写】
 *
 *   运镜展开是**纯函数**（CameraMoveSpec → Track[]），所以它的正确性
 *   完全可计算 —— 而它又恰恰是最容易"看起来对、实际错了"的地方：
 *
 *     ▸ 少发一条 `target.*` → 相机退回"永远朝 −Z 看"，
 *       整个运镜退化成"平移一张图"。画面不报错，只是**变平**。
 *     ▸ 幅度写成世界单位而不是 frame 的比例 → 镜头推近后主体被晃出画面。
 *     ▸ 曲线路径给每段标了缓动 → 一条弧被切成 8 次起停，看起来一顿一顿。
 *     ▸ `intensity: 0` 没真的退化 → "关掉运镜"这个契约失效。
 *
 *   这些症状全都不会抛异常，只会让效果变差 —— 所以必须用单测锁死。
 * ===========================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import type { CameraMoveKind, Track } from '../schema';
import { sampleTrack } from './timeline';
import {
  CAMERA_MOVES,
  cameraMoveNames,
  expandCameraMove,
  type CameraMoveContext,
} from './camera-moves';

/* ------------------------------------------------------------ fixture */

const BASE = {
  distance: 27,
  fov: 32,
  approach: 6,
  dir: 1 as const,
  subject: [1.5, -0.8, -21] as [number, number, number],
};

/** 展开一个运镜（走真实入口，保证 frame 的算法也被覆盖） */
function expand(
  kind: CameraMoveKind,
  overrides: Partial<{
    distance: number;
    fov: number;
    approach: number;
    dir: 1 | -1;
    subject: [number, number, number];
    intensity: number;
  }> = {},
) {
  const { intensity = 1, ...rest } = overrides;
  return expandCameraMove({ kind, intensity }, { ...BASE, ...rest });
}

/** 按 path 取轨道 */
function find(tracks: Track[], path: string): Track {
  const t = tracks.find((x) => x.path === path);
  if (!t) throw new Error(`缺少轨道 ${path}（实际有：${tracks.map((x) => x.path).join(', ')}）`);
  return t;
}

const val = (tracks: Track[], path: string, at: number): number =>
  sampleTrack(find(tracks, path).keyframes, at);

const ALL: readonly CameraMoveKind[] = [
  'hold',
  'dolly',
  'orbit',
  'whip',
  'crash',
  'rise',
];

/* ------------------------------------------------------------ 契约 */

describe('运镜表', () => {
  it('六种运镜全部实现，且和 cameraMoveNames 一致', () => {
    expect(new Set(cameraMoveNames())).toEqual(new Set(ALL));
    for (const k of ALL) expect(typeof CAMERA_MOVES[k]).toBe('function');
  });

  it('不声明 move → 空数组（相机走原分支，零行为变更）', () => {
    expect(expandCameraMove(undefined, BASE)).toEqual([]);
  });

  it('未知运镜 → 空数组 + 警告，不抛异常', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracks = expandCameraMove({ kind: 'zoomblur' as CameraMoveKind }, BASE);
    expect(tracks).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('★ 每种运镜都发 target.* —— 否则相机退回"永远朝 −Z 看"', () => {
    for (const kind of ALL) {
      const tracks = expand(kind);
      for (const p of ['target.x', 'target.y', 'target.z']) {
        expect(() => find(tracks, p), `${kind} 缺 ${p}`).not.toThrow();
      }
      // target.z 永远是主体所在的平面（运镜只在这个平面上取景）
      expect(val(tracks, 'target.z', 0.5), `${kind} 的 target.z 偏离了主体`).toBeCloseTo(
        BASE.subject[2],
        6,
      );
      // target.x 的**两端平均** = 主体 x。`whip` 会让目标跟着扫，
      // 所以不能断言"恒等于主体 x"，但扫动必须关于主体对称。
      const tx0 = val(tracks, 'target.x', 0);
      const tx1 = val(tracks, 'target.x', 1);
      expect((tx0 + tx1) / 2, `${kind} 的扫动不关于主体对称`).toBeCloseTo(BASE.subject[0], 6);
    }
  });

  it('同一运镜内没有重复属性路径（求值器按 path 覆盖，重复是静默 bug）', () => {
    for (const kind of ALL) {
      const paths = expand(kind).map((t) => t.path);
      expect(new Set(paths).size, `${kind} 有重复路径`).toBe(paths.length);
    }
  });

  it('★ look 决定"看向哪"，subject 决定"绕谁转"—— 两者可以不同', () => {
    const look: [number, number, number] = [0.4, 0.2, -18];
    const tracks = expandCameraMove(
      { kind: 'orbit', look },
      { ...BASE, look },
    );

    // 看向 look（而不是 subject）
    expect(val(tracks, 'target.x', 0.5)).toBeCloseTo(look[0], 9);
    expect(val(tracks, 'target.y', 0.5)).toBeCloseTo(look[1], 9);
    expect(val(tracks, 'target.z', 0.5)).toBeCloseTo(look[2], 9);

    // 但弧心仍然是 subject —— 半径恒等于相机到 subject 的距离
    for (const at of [0, 0.5, 1]) {
      const dx = val(tracks, 'position.x', at) - BASE.subject[0];
      const dz = val(tracks, 'position.z', at) - BASE.subject[2];
      expect(Math.hypot(dx, dz)).toBeCloseTo(BASE.distance, 6);
    }
  });

  it('不传 look 时默认看向 subject（内容自己写运镜的默认行为）', () => {
    for (const kind of ALL) {
      const tracks = expand(kind);
      // whip 会让目标跟着扫，所以取两端平均（扫动关于 look 对称）
      const mid = (val(tracks, 'target.x', 0) + val(tracks, 'target.x', 1)) / 2;
      expect(mid, `${kind} 的默认 look 不是 subject`).toBeCloseTo(BASE.subject[0], 9);
      expect(val(tracks, 'target.z', 0.5), `${kind} 的默认 look.z 不是 subject.z`).toBeCloseTo(
        BASE.subject[2],
        9,
      );
    }
  });

  it('★ intensity = 0 退化成静止（但依然 lookAt）', () => {
    for (const kind of ALL) {
      const tracks = expand(kind, { intensity: 0 });
      for (const path of ['position.x', 'position.y', 'position.z', 'rotation.z']) {
        const t = tracks.find((x) => x.path === path);
        if (!t) continue;
        const values = t.keyframes.map((k) => k.value);
        const spread = Math.max(...values) - Math.min(...values);
        expect(spread, `${kind} 的 ${path} 在 intensity=0 时仍有 ${spread} 的幅度`).toBeLessThan(
          1e-9,
        );
      }
    }
  });
});

/* ------------------------------------------------------------ 幅度单位 */

describe('幅度单位 = frame（主体处视口高度）的比例', () => {
  /**
   * ★ 这是文件头纪律①的守卫。
   *
   * 如果幅度写成了世界单位（或距离的比例），那么把相机拉远一倍，
   * 横向位移会跟着翻倍 —— 于是"镜头越远，晃动越大"，主体迟早被晃出画面。
   * 正确行为：拉远一倍 → frame 翻倍 → 位移也翻倍，**但屏幕上的位移不变**。
   */
  it('横向幅度随距离线性缩放（= 观感恒定）', () => {
    const near = expand('whip', { distance: 20 });
    const far = expand('whip', { distance: 40 });

    const nearPan = Math.abs(val(near, 'position.x', 1));
    const farPan = Math.abs(val(far, 'position.x', 1));

    // frame 与距离成正比 ⇒ 位移与距离成正比
    expect(farPan / nearPan).toBeCloseTo(2, 6);

    // 换算成"屏幕占比"后完全一致（这才是观感量）
    const frac = (pan: number, distance: number) =>
      pan / (2 * Math.tan((32 * Math.PI) / 180 / 2) * distance);
    expect(frac(farPan, 40)).toBeCloseTo(frac(nearPan, 20), 9);
  });

  it('横向幅度随 fov 缩放（视野越窄，同样的屏幕占比需要的世界位移越小）', () => {
    const wide = expand('whip', { fov: 50 });
    const tele = expand('whip', { fov: 25 });
    expect(Math.abs(val(tele, 'position.x', 1))).toBeLessThan(
      Math.abs(val(wide, 'position.x', 1)),
    );
  });

  it('距离为 0 不产生 NaN / Infinity', () => {
    const tracks = expand('whip', { distance: 0 });
    for (const t of tracks) {
      for (const k of t.keyframes) expect(Number.isFinite(k.value)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------ 各运镜的形状 */

describe('各运镜的形状', () => {
  it('hold：x 往返、中点最远、两端归零（否则章节首尾会跳）', () => {
    const tracks = expand('hold');
    expect(val(tracks, 'position.x', 0)).toBeCloseTo(0, 9);
    expect(val(tracks, 'position.x', 1)).toBeCloseTo(0, 9);
    expect(Math.abs(val(tracks, 'position.x', 0.5))).toBeGreaterThan(0);
    // 只做极轻的呼吸 —— 幅度必须是"几乎看不出来"的量级
    const frame = 2 * Math.tan((32 * Math.PI) / 180 / 2) * BASE.distance;
    expect(Math.abs(val(tracks, 'position.x', 0.5))).toBeLessThan(0.03 * frame);
  });

  it('dolly：只沿 z 推进，横向不动，且推近量 = approach', () => {
    const tracks = expand('dolly');
    const z0 = val(tracks, 'position.z', 0);
    const z1 = val(tracks, 'position.z', 1);

    expect(z0).toBeCloseTo(BASE.subject[2] + BASE.distance, 9);
    expect(z0 - z1).toBeCloseTo(BASE.approach, 6);
    expect(val(tracks, 'position.x', 1)).toBeCloseTo(0, 9);
    expect(val(tracks, 'position.y', 1)).toBeCloseTo(0, 9);
  });

  it('★ dolly 不受 dir 影响（永远推近）—— 拉远会让主体比构图设计的更小', () => {
    const a = expand('dolly', { dir: 1 });
    const b = expand('dolly', { dir: -1 });
    expect(val(b, 'position.z', 1)).toBeCloseTo(val(a, 'position.z', 1), 9);
  });

  it('orbit：弧长由 intensity 控制，起点终点关于主体对称，且中点在主体正前方', () => {
    const tracks = expand('orbit');
    const sx = BASE.subject[0];
    const sz = BASE.subject[2];

    const x0 = val(tracks, 'position.x', 0);
    const x1 = val(tracks, 'position.x', 1);
    const z0 = val(tracks, 'position.z', 0);
    const z1 = val(tracks, 'position.z', 1);

    // 对称
    expect(x0 - sx).toBeCloseTo(-(x1 - sx), 6);
    expect(z0 - sz).toBeCloseTo(z1 - sz, 6);

    // 半径恒定 = 距离
    for (const at of [0, 0.25, 0.5, 0.75, 1]) {
      const dx = val(tracks, 'position.x', at) - sx;
      const dz = val(tracks, 'position.z', at) - sz;
      expect(Math.hypot(dx, dz)).toBeCloseTo(BASE.distance, 6);
    }
  });

  it('★ orbit：段与段之间必须 linear，角度由缓动决定（非均匀采样）', () => {
    const tracks = expand('orbit');
    const xs = find(tracks, 'position.x').keyframes;
    const zs = find(tracks, 'position.z').keyframes;

    // ① 所有段都是 linear —— 逐段缓动会把一条弧切成 8 次起停
    for (const k of [...xs, ...zs]) expect(k.ease).toBe('linear');

    // ② 角度沿弧单调推进，且总弧长 = 18°
    const sx = BASE.subject[0];
    const sz = BASE.subject[2];
    const angles = xs.map((k, i) => Math.atan2(k.value - sx, zs[i].value - sz));
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]).toBeGreaterThan(angles[i - 1]);
    }
    expect(angles[angles.length - 1] - angles[0]).toBeCloseTo((18 * Math.PI) / 180, 9);

    // ③ ★ 角度的步长**不均匀** —— 这正是"缓动决定采样位置"的含义。
    //    如果步长均匀，就说明缓动没生效，弧的两端会突然起步/急停。
    const steps = angles.slice(1).map((a, i) => a - angles[i]);
    const mid = steps[Math.floor(steps.length / 2)];
    expect(mid).toBeGreaterThan(steps[0]);
    expect(mid).toBeGreaterThan(steps[steps.length - 1]);
    // 关于中点对称（easeInOut 的性质）
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i]).toBeCloseTo(steps[steps.length - 1 - i], 9);
    }
    // t 的步长是均匀的（非均匀的是角度，不是 t）
    const dts = xs.slice(1).map((k, i) => k.t - xs[i].t);
    for (const dt of dts) expect(dt).toBeCloseTo(1 / 8, 9);
  });

  it('whip：相机横扫的同时**目标也跟着扫**（否则读作平移而不是甩）', () => {
    const tracks = expand('whip');
    const camSweep = val(tracks, 'position.x', 1) - val(tracks, 'position.x', 0);
    const tgtSweep = val(tracks, 'target.x', 1) - val(tracks, 'target.x', 0);

    expect(camSweep).not.toBeCloseTo(0, 6);
    // 目标扫得比相机更远 —— 视线甩得比机身快
    expect(Math.abs(tgtSweep)).toBeGreaterThan(Math.abs(camSweep));
    // 同向
    expect(Math.sign(tgtSweep)).toBe(Math.sign(camSweep));
  });

  it('crash：z 用 easeOutCubic（快进慢停），fov 是**绝对值**且收窄', () => {
    const tracks = expand('crash');
    const zTrack = find(tracks, 'position.z');
    expect(zTrack.keyframes[1].ease).toBe('easeOutCubic');

    // ★ fov 轨道在引擎里是绝对值：CameraSystem 直接 `camera.fov = smooth.fov`
    const fovTrack = find(tracks, 'fov');
    expect(val(tracks, 'fov', 0)).toBeCloseTo(BASE.fov, 9);
    const fovEnd = val(tracks, 'fov', 1);
    expect(fovEnd).toBeLessThan(BASE.fov);
    // 收窄幅度必须小，而且不能收到负数
    expect(fovEnd).toBeGreaterThan(BASE.fov - 8);
    expect(fovEnd).toBeGreaterThan(0);
  });

  it('crash：推近量和 dolly 用同一个预算（不是自己拍脑袋推得更近）', () => {
    const crash = expand('crash');
    const dolly = expand('dolly');
    const crashDelta = val(crash, 'position.z', 0) - val(crash, 'position.z', 1);
    const dollyDelta = val(dolly, 'position.z', 0) - val(dolly, 'position.z', 1);
    expect(crashDelta).toBeCloseTo(dollyDelta, 9);
  });

  it('rise：相机抬高，同时视线下压（否则读作"抬头看天花板"）', () => {
    const tracks = expand('rise');
    const camY0 = val(tracks, 'position.y', 0);
    const camY1 = val(tracks, 'position.y', 1);
    const tgtY0 = val(tracks, 'target.y', 0);
    const tgtY1 = val(tracks, 'target.y', 1);

    expect(camY1).toBeGreaterThan(camY0);
    // 目标反而往下走 → 形成俯角
    expect(tgtY1).toBeLessThan(tgtY0);
    // 但目标抬降的幅度远小于相机，否则会变成"俯视地板"
    const camSpan = camY1 - camY0;
    const tgtSpan = tgtY0 - tgtY1;
    expect(tgtSpan).toBeGreaterThan(0);
    expect(tgtSpan).toBeLessThan(camSpan);
  });
});

/* ------------------------------------------------------------ dir 交替 */

describe('dir 交替', () => {
  it('横向运镜在 dir = ±1 下镜像', () => {
    // hold 的横向偏移在中点最大（两端归零）
    expect(val(expand('hold', { dir: 1 }), 'position.x', 0.5)).toBeCloseTo(
      -val(expand('hold', { dir: -1 }), 'position.x', 0.5),
      9,
    );

    // orbit / whip 的横扫关于**各自的中心**对称：
    //   orbit 绕主体（中心 = 主体 x），whip 绕相机初始 x（中心 = 0）。
    //   所以用"两端平均"当中心，比较偏离量的镜像。
    for (const kind of ['orbit', 'whip'] as const) {
      const p = expand(kind, { dir: 1 });
      const m = expand(kind, { dir: -1 });
      const centre = (val(p, 'position.x', 0) + val(p, 'position.x', 1)) / 2;
      const dev = val(p, 'position.x', 1) - centre;
      const devM = val(m, 'position.x', 1) - centre;

      expect(Math.abs(dev), `${kind} 没有横向扫动`).toBeGreaterThan(1e-6);
      expect(dev, `${kind} 没有随 dir 反向`).toBeCloseTo(-devM, 9);
    }
  });

  it('roll 也随 dir 反向（whip / rise）', () => {
    for (const kind of ['whip', 'rise'] as const) {
      const plus = val(expand(kind, { dir: 1 }), 'rotation.z', 0);
      const minus = val(expand(kind, { dir: -1 }), 'rotation.z', 0);
      expect(plus, `${kind} 的 roll 没有随 dir 反向`).toBeCloseTo(-minus, 9);
      expect(plus).not.toBeCloseTo(0, 6);
    }
  });
});
