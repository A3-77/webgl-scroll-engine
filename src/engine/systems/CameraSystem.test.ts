import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraSystem } from './CameraSystem';
import type { CameraConfig } from '../../schema';

const config = (overrides: Partial<CameraConfig> = {}): CameraConfig => ({
  fov: 32,
  z: 5,
  tracks: [],
  ...overrides,
});

function mk(cfg: CameraConfig): { sys: CameraSystem; cam: THREE.PerspectiveCamera } {
  const cam = new THREE.PerspectiveCamera(cfg.fov, 1, 0.1, 100);
  return { sys: new CameraSystem(cam, cfg), cam };
}

describe('CameraSystem.apply —— 无 damping（快路径）', () => {
  it('轨道值为 0 时相机停在 (0, 0, config.z)，无偏移', () => {
    const { sys, cam } = mk(config({ z: 5 }));
    sys.apply(0);
    expect(cam.position.x).toBe(0);
    expect(cam.position.y).toBe(0);
    expect(cam.position.z).toBe(5);
  });

  it('轨道 position.x 设了值就反映到 camera.position.x', () => {
    const { sys, cam } = mk(config({
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 2 }] },
      ],
    }));
    sys.apply(0.5);
    expect(cam.position.x).toBe(1);
  });

  it('轨道 fov 变化会触发 updateProjectionMatrix（修改了 cam.fov）', () => {
    const { sys, cam } = mk(config({
      fov: 32,
      tracks: [
        { path: 'fov', keyframes: [{ t: 0, value: 32 }, { t: 1, value: 48 }] },
      ],
    }));
    sys.apply(0.5);
    expect(cam.fov).toBe(40);
  });

  it('轨道 fov 与当前 cam.fov 相同时不调用 updateProjectionMatrix 的语义（值不变）', () => {
    const { sys, cam } = mk(config({ fov: 32 }));
    // 没有 fov 轨道 → 取 config.fov=32，与初始一致
    sys.apply(0);
    expect(cam.fov).toBe(32);
  });

  it('rotation.z 轨道同步到 camera.rotation.z', () => {
    const { sys, cam } = mk(config({
      tracks: [
        { path: 'rotation.z', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 0.5 }] },
      ],
    }));
    sys.apply(1);
    expect(cam.rotation.z).toBeCloseTo(0.5);
  });
});

describe('CameraSystem.apply —— 有 damping（一阶低通）', () => {
  it('★ 帧率无关：dt 越小，跟得越慢（首帧后 raw=smooth）', () => {
    const { sys } = mk(config({
      damping: 0.5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      ],
    }));
    sys.apply(1, 1 / 60); // 60fps
    const x60 = (sys as never as { smooth: Record<string, number> }).smooth['position.x'];
    // 第一帧：raw=1, smooth=1（首帧特殊路径）
    expect(x60).toBeCloseTo(1, 5);
  });

  it('第二帧：dt 小时平滑值跟不上 raw', () => {
    const { sys } = mk(config({
      damping: 0.5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      ],
    }));
    sys.apply(1, 1 / 60);
    // 强制把 raw 改成 0（模拟跳变），再以小 dt 平滑
    (sys as never as { raw: Record<string, number> }).raw['position.x'] = 0;
    sys.apply(1, 0.001); // dt 极小 → k≈0.002 → 几乎不动
    const smooth = (sys as never as { smooth: Record<string, number> }).smooth['position.x'];
    expect(smooth).toBeGreaterThan(0.99); // 还没追上
  });

  it('dt=0 时退化成直通（不衰减）', () => {
    const { sys } = mk(config({
      damping: 0.5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 5 }] },
      ],
    }));
    sys.apply(0.5, 0);
    sys.apply(1, 0); // dt=0 → 不衰减
    const smooth = (sys as never as { smooth: Record<string, number> }).smooth['position.x'];
    expect(smooth).toBe(5); // 等于 raw
  });

  it('damping=0 时也走直通（不会走低通分支）', () => {
    const { sys } = mk(config({
      damping: 0,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 3 }] },
      ],
    }));
    sys.apply(1, 1 / 60);
    const smooth = (sys as never as { smooth: Record<string, number> }).smooth['position.x'];
    expect(smooth).toBe(3);
  });
});

describe('CameraSystem.syncConfig', () => {
  it('替换 config 后用新轨道求值', () => {
    const { sys, cam } = mk(config({
      z: 5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 10 }] },
      ],
    }));
    sys.apply(1);
    expect(cam.position.x).toBe(10);

    sys.syncConfig(config({
      z: 5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: -10 }] },
      ],
    }));
    sys.apply(1);
    expect(cam.position.x).toBe(-10);
  });

  /**
   * ★ 实测踩到：`crash`（把 fov 收窄到 28°）之后换成没有 fov 轨道的 `rise`，
   *   相机一直停在 28°。原因是 `evaluateTracks` 只写不删，旧路径留在缓存里。
   */
  it('★ 换 config 后，新轨道不再产生的路径要从缓存里清掉', () => {
    const { sys, cam } = mk(config({
      fov: 32,
      tracks: [{ path: 'fov', keyframes: [{ t: 0, value: 28 }] }],
    }));
    sys.apply(0);
    expect(cam.fov).toBe(28);

    // 换成没有 fov 轨道的 config
    sys.syncConfig(config({ fov: 32, tracks: [{ path: 'position.z', keyframes: [{ t: 0, value: 5 }] }] }));
    sys.apply(0);
    expect(cam.fov).toBe(32);
  });

  it('★ 仍然存在的路径要保住阻尼状态（清空会让重新构图时相机跳一下）', () => {
    const { sys } = mk(config({
      z: 5,
      damping: 0.5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      ],
    }));
    sys.apply(1, 1 / 60);
    // 人为把平滑值压到一个中间态
    const smooth = (sys as never as { smooth: Record<string, number> }).smooth;
    smooth['position.x'] = 0.42;

    sys.syncConfig(config({
      z: 5,
      damping: 0.5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
        { path: 'rotation.z', keyframes: [{ t: 0, value: 0.1 }] },
      ],
    }));

    expect(smooth['position.x']).toBe(0.42);
  });
});

/* ------------------------------------------------------------ PHASE 26 会看 */

/** 相机当前朝向（世界空间单位向量，= 相机 −z 轴） */
function viewDir(cam: THREE.PerspectiveCamera): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
}

/** 相机到某点的方向 */
function dirTo(cam: THREE.PerspectiveCamera, p: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(p[0], p[1], p[2]).sub(cam.position).normalize();
}

describe('★ CameraSystem —— 会看（PHASE 26）', () => {
  const withTarget = (target: [number, number, number], extra: Partial<CameraConfig> = {}) =>
    config({ z: 6, target, ...extra });

  it('有 target 时相机真的朝它看（视线轴指向目标）', () => {
    const { sys, cam } = mk(withTarget([1.5, -0.8, -21]));
    sys.apply(0);

    const d = viewDir(cam);
    const want = dirTo(cam, [1.5, -0.8, -21]);
    expect(d.dot(want)).toBeCloseTo(1, 6);
  });

  it('target.* 轨道会动 —— 相机跟着转', () => {
    const { sys, cam } = mk(config({
      z: 6,
      tracks: [
        { path: 'target.x', keyframes: [{ t: 0, value: -5 }, { t: 1, value: 5 }] },
        { path: 'target.z', keyframes: [{ t: 0, value: -20 }] },
      ],
    }));

    sys.apply(0);
    const before = viewDir(cam).clone();
    sys.apply(1);
    const after = viewDir(cam).clone();

    expect(before.angleTo(after)).toBeGreaterThan(0.1);
    // 两端都真的指向各自的 target
    expect(after.dot(dirTo(cam, [5, 0, -20]))).toBeCloseTo(1, 6);
  });

  it('★ roll 在 lookAt 之后叠加 —— 绕视线轴滚转，视线方向不变', () => {
    const { sys, cam } = mk(withTarget([0, 0, -20], {
      tracks: [{ path: 'rotation.z', keyframes: [{ t: 0, value: 0.3 }] }],
    }));
    sys.apply(0);

    // 视线方向不受 roll 影响
    expect(viewDir(cam).dot(dirTo(cam, [0, 0, -20]))).toBeCloseTo(1, 6);
    // 但"上"方向被转了 0.3 弧度
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const axis = viewDir(cam);
    const expectedUp = new THREE.Vector3(0, 1, 0).applyAxisAngle(axis, -0.3);
    expect(up.dot(expectedUp)).toBeCloseTo(1, 5);
  });

  it('★ 零行为变更：没有 target 时走原分支（只写 position + rotation.z）', () => {
    const { sys, cam } = mk(config({
      z: 5,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 3 }] },
        { path: 'rotation.z', keyframes: [{ t: 0, value: 0.2 }] },
      ],
    }));
    sys.apply(0);

    expect(cam.position.x).toBe(3);
    expect(cam.rotation.z).toBeCloseTo(0.2, 9);
    // 原分支下相机永远朝 −Z 看
    expect(viewDir(cam).dot(new THREE.Vector3(0, 0, -1))).toBeCloseTo(1, 9);
  });

  it('★ target 与 position 各自独立平滑（位置急推时视线不跟着甩）', () => {
    const cfg = config({
      z: 6,
      damping: 0.2,
      tracks: [
        { path: 'position.x', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 12 }] },
        { path: 'target.x', keyframes: [{ t: 0, value: 0 }] },
        { path: 'target.z', keyframes: [{ t: 0, value: -20 }] },
      ],
    });
    const { sys, cam } = mk(cfg);

    // 先让两套状态都初始化
    sys.apply(0, 1 / 60);
    // 然后位置轨道跳一大步，只推进 1ms
    sys.apply(1, 0.001);

    const smooth = (sys as never as { smooth: Record<string, number> }).smooth;
    // 位置几乎没跟上（阻尼），但 target 是常量轨道，早就到位了
    expect(smooth['position.x']).toBeLessThan(1);
    expect(smooth['target.x']).toBeCloseTo(0, 9);
    // 相机仍然看向 target（而不是被位置的原始值带偏）
    expect(viewDir(cam).dot(dirTo(cam, [0, 0, -20]))).toBeCloseTo(1, 5);
  });

  it('move 声明的运镜会被展开（syncConfig 后仍然生效）', () => {
    const cfg = config({
      z: 6,
      target: [0, 0, -21],
      move: { kind: 'orbit', subject: [0, 0, -21], intensity: 1, dir: 1, approach: 6 },
    });
    const { sys, cam } = mk(cfg);

    sys.apply(0);
    const a = cam.position.clone();
    sys.apply(1);
    const b = cam.position.clone();

    expect(a.distanceTo(b)).toBeGreaterThan(1);
    // 绕行时始终看向主体
    expect(viewDir(cam).dot(dirTo(cam, [0, 0, -21]))).toBeCloseTo(1, 5);

    sys.syncConfig({ ...cfg, move: { kind: 'dolly', subject: [0, 0, -21], approach: 6 } });
    sys.apply(0);
    const c = cam.position.clone();
    sys.apply(1);
    // dolly 只在 z 上推进
    expect(cam.position.x).toBeCloseTo(c.x, 9);
    expect(cam.position.z).toBeLessThan(c.z);
  });
});