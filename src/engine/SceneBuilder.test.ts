/**
 * SceneBuilder —— 指针视差的两道门控（PHASE 26）
 * ===========================================================================
 * 这里只测**门控**，不测几何。
 *
 * 参考站点的原文规则（`portfolio/components/ShotDirector.tsx`）：
 *
 *     // pointer parallax: only inside settled shots, never in gutters/beats
 *     const parallaxOk = !reducedMotion && sample.transition === null &&
 *       (sample.shotKind === "hold" || sample.shotKind === "dolly");
 *
 * 本引擎把 `reducedMotion` 折进了 `pointerSystem.enabled`（见 schema/pointer.ts），
 * 剩下两条门控落在这里：
 *   ▸ `settled`      —— 由 Composer 每帧告知（过场中不叠指针）
 *   ▸ 镜头种类        —— 只有 hold / dolly 吃指针；orbit/whip/crash/rise 不吃
 *
 * 为什么这两条值得单独测：
 *   门控是**静默**的 —— 少了一边不会报错，只会让画面在镜头飞行时"发毛"，
 *   而这正是"看着不顺"最难定位的一类原因。
 *
 * ★ 写这组测试时踩到的坑（留着当提醒）：
 *   `offsetFor(distance)` 的 distance 是**相机当前 z**，而运镜本身会改 z
 *   （dolly/crash 推近 2 个单位）。所以期望偏移必须按**那个 t 的实际 z** 算，
 *   不能按 config.z 算 —— 第一版就是拿 config.z 算的，四条全红。
 * ===========================================================================
 */

import { describe, it, expect } from 'vitest';
import { buildScene } from './SceneBuilder';
import { PointerSystem } from './systems/PointerSystem';
import { POINTER_PARALLAX, resolvePointer } from '../schema/pointer';
import type { CameraMoveKind, SceneConfig } from '../schema';

/* ------------------------------------------------------------ 夹具 */

type Move = { kind: CameraMoveKind };

function sceneConfig(move?: Move): SceneConfig {
  return {
    id: 'test',
    handle: 'test',
    index: 0,
    eyebrow: '',
    title: '',
    body: '',
    accent: '#fff',
    background: '#000',
    heightVh: 2,
    earlyCrossfade: 0,
    transition: { mode: 'radial', fadeCenter: [0, 0, 0] },
    camera: {
      z: 6,
      fov: 32,
      tracks: [],
      target: [0, 0, -20],
      ...(move ? { move: { kind: move.kind, subject: [0, 0, -20], approach: 2 } } : {}),
    },
    objects: [],
  };
}

/** 一个"指针停在右上角"的 PointerSystem（已充分平滑，偏移稳定） */
function pointerAtCorner(): PointerSystem {
  const sys = new PointerSystem(resolvePointer(POINTER_PARALLAX));
  for (let i = 0; i < 200; i++) sys.apply(1 / 60, [1, 1]);
  return sys;
}

const POINTER_OFF = (): PointerSystem => new PointerSystem(resolvePointer());

function build(move: Move | undefined, pointer: PointerSystem) {
  return buildScene(sceneConfig(move), new Map(), new Map(), 1, pointer);
}

/**
 * 同一份配置的"有指针 / 无指针"两版，外加那个指针系统本身。
 * 门控的断言永远是「两版之差」—— 这样运镜本身的位移被自动消掉。
 */
function pair(move?: Move) {
  const pointer = pointerAtCorner();
  return {
    pointer,
    withP: build(move, pointer),
    without: build(move, POINTER_OFF()),
  };
}

/**
 * 该指针系统在 `baseline` 播到 t 时会给出的偏移。
 * ★ 距离取 **baseline 那一刻的相机 z**（运镜会改 z），不是 config.z。
 */
function expectedOffset(pointer: PointerSystem, baseline: ReturnType<typeof build>, t: number) {
  baseline.applyTime(t);
  return pointer.offsetFor(Math.abs(baseline.camera.position.z));
}

/* ------------------------------------------------------------ 测试 */

describe('SceneBuilder —— 指针视差门控（PHASE 26）', () => {
  it('指针真的在起作用：hold 镜头下相机被推离轨道位置', () => {
    const { pointer, withP, without } = pair({ kind: 'hold' });
    const off = expectedOffset(pointer, without, 0.5);

    withP.applyTime(0.5);

    expect(Math.abs(off.x)).toBeGreaterThan(0);
    expect(withP.camera.position.x - without.camera.position.x).toBeCloseTo(off.x, 9);
    expect(withP.camera.position.y - without.camera.position.y).toBeCloseTo(off.y, 9);
  });

  it('dolly 也吃指针（参考站点把 dolly 也算 settled）', () => {
    const { pointer, withP, without } = pair({ kind: 'dolly' });
    const off = expectedOffset(pointer, without, 0.5);

    withP.applyTime(0.5);

    expect(withP.camera.position.x - without.camera.position.x).toBeCloseTo(off.x, 9);
    expect(withP.camera.position.y - without.camera.position.y).toBeCloseTo(off.y, 9);
  });

  it.each<CameraMoveKind>(['orbit', 'whip', 'crash', 'rise'])(
    '★ %s 是"镜头在飞"，一像素都不叠指针',
    (kind) => {
      const { withP, without } = pair({ kind });

      withP.applyTime(0.5);
      without.applyTime(0.5);

      expect(withP.camera.position.x).toBeCloseTo(without.camera.position.x, 10);
      expect(withP.camera.position.y).toBeCloseTo(without.camera.position.y, 10);
    },
  );

  it('★ setSettled(false) 之后立刻停止叠加（过场中不叠指针）', () => {
    const { withP, without } = pair({ kind: 'hold' });

    withP.applyTime(0.5);
    without.applyTime(0.5);
    expect(Math.abs(withP.camera.position.x - without.camera.position.x)).toBeGreaterThan(0);

    // 进入过场
    withP.setSettled(false);
    withP.applyTime(0.5);
    without.applyTime(0.5);
    expect(withP.camera.position.x).toBeCloseTo(without.camera.position.x, 10);

    // 过场结束 → 恢复
    withP.setSettled(true);
    withP.applyTime(0.5);
    expect(Math.abs(withP.camera.position.x - without.camera.position.x)).toBeGreaterThan(0);
  });

  it('★ 零行为变更：没有声明 move 的旧内容包照旧吃指针', () => {
    // PHASE 26 之前没有任何镜头语言，指针就是唯一的环境运动。
    // 那条路径必须逐位保持 —— 门控不能把老内容包一起关掉。
    const { pointer, withP, without } = pair(undefined);
    const off = expectedOffset(pointer, without, 0.5);

    withP.applyTime(0.5);

    expect(Math.abs(off.x)).toBeGreaterThan(0);
    expect(withP.camera.position.x - without.camera.position.x).toBeCloseTo(off.x, 9);
  });

  it('★ 换运镜后门控立刻跟着换（不能是构建时算一次的常量）', () => {
    // 这是 PHASE 26 反复踩到的同一类 bug：缓存没跟着 config 走。
    // `applyCameraConfig` 会把整个 camera 配置换掉，门控必须现算。
    const { withP, without } = pair({ kind: 'hold' });

    withP.applyTime(0.5);
    without.applyTime(0.5);
    expect(Math.abs(withP.camera.position.x - without.camera.position.x)).toBeGreaterThan(0);

    // 两版同时换成 orbit —— 从这一帧起都不该再叠指针
    const orbit: Move = { kind: 'orbit' };
    withP.applyCameraConfig({ ...withP.config.camera, move: { ...orbit, subject: [0, 0, -20], approach: 2 } });
    without.applyCameraConfig({ ...without.config.camera, move: { ...orbit, subject: [0, 0, -20], approach: 2 } });

    withP.applyTime(0.5);
    without.applyTime(0.5);
    expect(withP.camera.position.x).toBeCloseTo(without.camera.position.x, 10);
    expect(withP.camera.position.y).toBeCloseTo(without.camera.position.y, 10);
  });

  it('指针关掉时门控无论如何都不改变相机（关掉 = 真的一个像素都不动）', () => {
    const built = build({ kind: 'hold' }, POINTER_OFF());
    built.applyTime(0.5);
    const x = built.camera.position.x;
    const y = built.camera.position.y;

    // 门控开与关都不该有任何差别
    built.setSettled(false);
    built.applyTime(0.5);
    expect(built.camera.position.x).toBe(x);
    expect(built.camera.position.y).toBe(y);
  });
});
