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
});