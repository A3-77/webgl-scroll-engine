import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ObjectAnimationSystem, type AnimatableLayer } from './ObjectAnimationSystem';
import type { SceneObjectConfig, Track } from '../../schema';

const config = (overrides: Partial<SceneObjectConfig> = {}): SceneObjectConfig => ({
  id: 'layer',
  asset: 'asset',
  z: 0,
  overscan: 1,
  offset: [0, 0],
  ...overrides,
});

const track = (path: string, points: Array<[number, number]>): Track => ({
  path,
  keyframes: points.map(([t, value]) => ({ t, value })),
});

/** 构造一个最小可用的图层：Object3D + 必要字段 */
function makeLayer(
  cfg: SceneObjectConfig,
  tracks: Track[],
  base = { baseVisibleH: 10, baseX: 1, baseY: 2, parallax: 1 },
): { layer: AnimatableLayer; object: THREE.Object3D } {
  const object = new THREE.Object3D();
  const layer: AnimatableLayer = {
    config: cfg,
    object,
    baseVisibleH: base.baseVisibleH,
    baseX: base.baseX,
    baseY: base.baseY,
    tracks,
    parallax: base.parallax,
    values: {},
  };
  return { layer, object };
}

describe('ObjectAnimationSystem.apply —— transform 写入', () => {
  it('无轨道时：t 怎么变，位置都不动（停在 baseX/baseY）', () => {
    const { layer, object } = makeLayer(config(), []);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    expect(object.position.x).toBeCloseTo(1);
    expect(object.position.y).toBeCloseTo(2);
    expect(object.position.z).toBe(0);
  });

  it('position.x 轨道 → 叠加到 baseX 上', () => {
    const { layer, object } = makeLayer(config(), [track('position.x', [[0, 0], [1, 0.5]])]);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    // aspect=1（默认），baseVisibleH=10，parallax=1
    // expected offset.x = 0.25 * 1 * 10 * 1 = 2.5
    // expected object.x = baseX(1) + 2.5 = 3.5
    expect(object.position.x).toBeCloseTo(3.5);
  });

  it('position.y 轨道不乘 aspect（与 X 区别对待）', () => {
    const { layer, object } = makeLayer(config(), [track('position.y', [[0, 0], [1, 1]])]);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    // offset.y = 0.5 * 1 * 10 = 5，object.y = 2 + 5 = 7
    expect(object.position.y).toBeCloseTo(7);
    expect(object.position.x).toBe(1); // 不动
  });

  it('position.z 轨道叠加到 config.z（不经过视差换算）', () => {
    const { layer, object } = makeLayer(
      config({ z: -5 }),
      [track('position.z', [[0, 0], [1, 3]])],
    );
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    expect(object.position.z).toBeCloseTo(-3.5); // -5 + 1.5
  });

  it('scale.x / scale.y 各自独立', () => {
    const { layer, object } = makeLayer(config(), [
      track('scale.x', [[0, 1], [1, 2]]),
      track('scale.y', [[0, 1], [1, 0.5]]),
    ]);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    expect(object.scale.x).toBeCloseTo(1.5);
    expect(object.scale.y).toBeCloseTo(0.75);
  });

  it('scale 没轨道时默认 1', () => {
    const { layer, object } = makeLayer(config(), []);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    expect(object.scale.x).toBe(1);
    expect(object.scale.y).toBe(1);
  });

  it('rotation.z 同步到 object.rotation.z', () => {
    const { layer, object } = makeLayer(config(), [track('rotation.z', [[0, 0], [1, 1]])]);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    expect(object.rotation.z).toBeCloseTo(0.5);
  });

  it('★ parallax 倍率只影响位移，不影响 base 位置', () => {
    const base = makeLayer(config(), [track('position.x', [[0, 0], [1, 1]])], {
      baseVisibleH: 10, baseX: 0, baseY: 0, parallax: 1,
    });
    const doubled = makeLayer(config(), [track('position.x', [[0, 0], [1, 1]])], {
      baseVisibleH: 10, baseX: 0, baseY: 0, parallax: 2,
    });
    const sys = new ObjectAnimationSystem([base.layer, doubled.layer]);
    sys.apply(0.5);
    // aspect=1, vx=0.5, baseH=10 → 0.5 * parallax * 10 * 1
    expect(base.object.position.x).toBeCloseTo(5);
    expect(doubled.object.position.x).toBeCloseTo(10);
  });
});

describe('ObjectAnimationSystem.apply —— visible / opacity / mixer', () => {
  it('visible 轨道：值 > 0.5 才显示', () => {
    const { layer, object } = makeLayer(config(), [track('visible', [[0, 0], [1, 1]])]);
    const sys = new ObjectAnimationSystem([layer]);
    object.visible = true;
    sys.apply(0); // visible=0 → false
    expect(object.visible).toBe(false);
    sys.apply(1); // visible=1 → true
    expect(object.visible).toBe(true);
  });

  it('visible 边界 = 0.5：刚好不显示（> 不包含 =）', () => {
    const { layer, object } = makeLayer(config(), [track('visible', [[0, 0.5], [1, 0.5]])]);
    const sys = new ObjectAnimationSystem([layer]);
    object.visible = true;
    sys.apply(0.5);
    expect(object.visible).toBe(false);
  });

  it('★ 没 visible 轨道时不动 object.visible（其它轨道也能改 visible=）', () => {
    const { layer, object } = makeLayer(config(), []);
    const sys = new ObjectAnimationSystem([layer]);
    object.visible = false;
    sys.apply(0.5);
    expect(object.visible).toBe(false);
  });

  it('opacity 轨道：仅 mesh 层写入 material.opacity', () => {
    const cfg = config();
    const object = new THREE.Object3D();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 }),
    );
    object.add(mesh);
    const layer: AnimatableLayer = {
      config: cfg,
      object,
      mesh,
      baseVisibleH: 10, baseX: 0, baseY: 0,
      tracks: [track('opacity', [[0, 0.2], [1, 0.8]])],
      parallax: 1,
      values: {},
    };
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.5);
    expect(mesh.material.opacity).toBeCloseTo(0.5);
  });

  it('★ 没 mesh 时 opacity 轨道被静默忽略（plane/model 都满足此契约）', () => {
    const { layer } = makeLayer(config(), [track('opacity', [[0, 0], [1, 0.5]])]);
    const sys = new ObjectAnimationSystem([layer]);
    // 没有 mesh，不会崩
    expect(() => sys.apply(0.5)).not.toThrow();
  });

  it('mixer + clipDuration 存在时调用 mixer.setTime(t * clipDuration)', () => {
    const cfg = config();
    const object = new THREE.Object3D();
    const mixer = new THREE.AnimationMixer(object);
    const clip = new THREE.AnimationClip('c', 2, [
      new THREE.NumberKeyframeTrack('.position[x]', [0, 1, 2], [0, 1, 2]),
    ]);
    mixer.clipAction(clip).play();
    const layer: AnimatableLayer = {
      config: cfg,
      object,
      mixer,
      clipDuration: 2,
      baseVisibleH: 10, baseX: 0, baseY: 0,
      tracks: [],
      parallax: 1,
      values: {},
    };
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0.25);
    // THREE.AnimationMixer 内部 _time 应该 = 0.25 * 2 = 0.5
    // 通过 mixer.time 公开字段读不到（private），改用 .update 后的属性值
    mixer.update(0);
    expect((object as never as { position: { x: number } }).position.x).toBeCloseTo(0.5, 1);
  });

  it('mixer 缺一就跳过（不会崩）', () => {
    const { layer } = makeLayer(config(), []);
    layer.mixer = undefined; // 显式留空
    const sys = new ObjectAnimationSystem([layer]);
    expect(() => sys.apply(0.5)).not.toThrow();
  });
});

describe('ObjectAnimationSystem —— 多图层与生命周期', () => {
  it('多图层独立求值，不互相串扰', () => {
    const zeroBase = { baseVisibleH: 10, baseX: 0, baseY: 0, parallax: 1 };
    const a = makeLayer(config({ id: 'a' }), [track('position.x', [[0, 0], [1, 1]])], zeroBase);
    const b = makeLayer(config({ id: 'b' }), [track('position.y', [[0, 0], [1, 1]])], zeroBase);
    const sys = new ObjectAnimationSystem([a.layer, b.layer]);
    sys.apply(0.5);
    // a 只动 X，b 只动 Y
    expect(a.object.position.x).toBeCloseTo(5 + 0); // 0.5*10 + baseX(0) = 5
    expect(a.object.position.y).toBe(0); // 没动
    expect(b.object.position.x).toBe(0); // 没动
    expect(b.object.position.y).toBeCloseTo(5 + 0); // 0.5*10 + baseY(0) = 5
  });

  it('每帧复用 values 缓存对象，不分配新字典（GC 友好）', () => {
    const { layer } = makeLayer(config(), [track('position.x', [[0, 0], [1, 1]])]);
    const sys = new ObjectAnimationSystem([layer]);
    sys.apply(0);
    const ref = layer.values;
    sys.apply(0.5);
    expect(layer.values).toBe(ref);
  });

  it('values 不在图层之间共享（避免状态泄漏）', () => {
    const a = makeLayer(config({ id: 'a' }), [track('position.x', [[0, 5], [1, 5]])]);
    const b = makeLayer(config({ id: 'b' }), []);
    expect(a.layer.values).not.toBe(b.layer.values);
  });

  it('dispose 调用 mixer.stopAllAction（不会崩）', () => {
    const { layer } = makeLayer(config(), []);
    layer.mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const sys = new ObjectAnimationSystem([layer]);
    expect(() => sys.dispose()).not.toThrow();
  });

  it('★ 拆分前后行为契约：aspect=1 时 X 与 Y 同尺度', () => {
    // 与 ParallaxSystem.test 同钉住当前实际生效的换算（Composre 传 1，
    // setAspect 不更新 objectSystem），是当前用户观感的契约。
    // 修复时改这里的期望再改 SceneBuilder.setAspect。
    const lx = makeLayer(config(), [track('position.x', [[0, 0], [1, 0.3]])]);
    const ly = makeLayer(config(), [track('position.y', [[0, 0], [1, 0.3]])]);
    const sys = new ObjectAnimationSystem([lx.layer, ly.layer]);
    sys.apply(1);
    // aspect=1 时 X 和 Y 位移量相等
    expect(lx.object.position.x - lx.layer.baseX).toBeCloseTo(ly.object.position.y - ly.layer.baseY);
  });
});