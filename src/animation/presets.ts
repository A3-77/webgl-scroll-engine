/**
 * ★ Motion Presets —— 内容侧的糖
 * ---------------------------------------------------------------------------
 * 为什么要预设：
 *   手写关键帧表达力最强，但"让一只猫轻轻上下浮动"要写 5 个关键帧 × 2 条轨道，
 *   而这件事在 5 个主体 × 3 个场景里要重复十几次。预设把这层重复消掉。
 *
 * ---------------------------------------------------------------------------
 * 【预设在哪一层展开 —— 这个决定很重要】
 *
 *   schema 里 `ObjectAnimation` 有两种形态：`{ preset: 'float' }` 或 `{ tracks: [...] }`。
 *   展开发生在**内容侧**（本文件被 asset-pipeline / 手写内容包调用），
 *   所以**引擎永远只见到 tracks 一种形态** —— SceneBuilder 不需要 import 本文件。
 *
 *   这不是洁癖：预设名（'float' / 'scatter'）是内容语汇，
 *   如果引擎认识它们，就等于引擎知道了"内容里有哪些动画"，
 *   那内容与引擎又耦合回去了。
 *
 * ---------------------------------------------------------------------------
 * 【位移数值的单位 —— 一个反直觉但很好用的性质】
 *
 *   SceneBuilder 里：
 *     position.x 的世界位移 = 值 × visibleH × aspect
 *     position.y 的世界位移 = 值 × visibleH
 *   而屏幕上的可见宽度 = visibleH × aspect、可见高度 = visibleH。
 *   两边一除就发现：
 *
 *     ★ position.x 的轨道值 **就是**「屏幕宽度的比例」
 *     ★ position.y 的轨道值 **就是**「屏幕高度的比例」
 *
 *   所以 0.02 = 屏幕的 2%，与视口宽高比无关，不需要任何换算。
 *   下面所有预设的幅度都按这个单位写。
 */

import type { Ease, Keyframe, ObjectAnimation, Track } from '../schema/animation';

/* ------------------------------------------------------------ 上下文 */

export interface PresetContext {
  /** 生效的滚动区间 [start, end]，默认 [0, 1] */
  range: [number, number];
  /** 幅度倍率。1 = 预设默认 */
  intensity: number;
}

export type PresetBuilder = (ctx: PresetContext) => Track[];

/* ------------------------------------------------------------ 工具 */

/**
 * 把「局部 0..1 的位置」映射成「全局滚动进度」。
 *
 * 预设内部只关心"在我这段窗口里的第几成"，不关心窗口本身在哪 ——
 * 这样同一个预设套在 [0,1] 和 [0.6,0.9] 上都对。
 */
function mapper(range: [number, number]): (u: number) => number {
  const [a, b] = range;
  return (u) => a + u * (b - a);
}

/** 造一个关键帧。at = 窗口内的局部位置 */
function kf(at: number, value: number, ease: Ease, map: (u: number) => number): Keyframe {
  return { t: map(at), value, ease };
}

/** 把一组 (局部位置, 值) 变成一条轨道 */
function track(
  path: string,
  points: Array<[number, number, Ease?]>,
  map: (u: number) => number,
): Track {
  return {
    path,
    keyframes: points.map(([at, value, ease]) => kf(at, value, ease ?? 'easeInOut', map)),
  };
}

/**
 * 振荡：0 → +A → 0 → −A → 0
 *
 * 为什么要回到 0 收尾：预设窗口之外求值器是**钳制**的（见 timeline.ts）。
 * 如果收尾不回 0，窗口一结束对象就会"咔"地跳回基准位置。
 * 所有周期性预设都遵守这条。
 */
function oscillate(
  path: string,
  amp: number,
  map: (u: number) => number,
  offsetAt = 0.25,
): Track {
  return track(
    path,
    [
      [0, 0, 'easeInOut'],
      [offsetAt, amp, 'easeInOut'],
      [0.5, 0, 'easeInOut'],
      [0.5 + offsetAt, -amp, 'easeInOut'],
      [1, 0, 'easeInOut'],
    ],
    map,
  );
}

/* ------------------------------------------------------------ 预设表 */

/**
 * 每个预设的**默认幅度**。
 *
 * 这些数值不是随便定的：它们是"看得到但不会喧宾夺主"的量级。
 * 屏幕上 2% 的位移在 1080p 下约 20px —— 刚好能察觉到"活的"，但不会让人分心。
 * 想更明显就传 intensity。
 */
export const PRESETS: Record<string, PresetBuilder> = {
  /** 钉死不动。背景用 —— 它的运动应该只来自相机透视，不来自轨道 */
  pinned: () => [],

  /** 轻轻上下浮动。最常用的"活着"感 */
  float: ({ range, intensity }) => {
    const map = mapper(range);
    return [oscillate('position.y', 0.022 * intensity, map)];
  },

  /** 左右轻摆 */
  sway: ({ range, intensity }) => {
    const map = mapper(range);
    return [oscillate('position.x', 0.016 * intensity, map)];
  },

  /** 缓慢斜向漂移（单向，不收尾回零）—— 用于"一直往某处走"的感觉 */
  drift: ({ range, intensity }) => {
    const map = mapper(range);
    return [
      track('position.x', [[0, 0], [1, 0.055 * intensity, 'easeInOut']], map),
      track('position.y', [[0, 0], [1, 0.03 * intensity, 'easeInOut']], map),
    ];
  },

  /** 呼吸：极轻微的整体缩放脉动 */
  breathe: ({ range, intensity }) => {
    const map = mapper(range);
    const a = 1 + 0.025 * intensity;
    return [
      track('scale.x', [[0, 1], [0.5, a, 'easeInOut'], [1, 1, 'easeInOut']], map),
      track('scale.y', [[0, 1], [0.5, a, 'easeInOut'], [1, 1, 'easeInOut']], map),
    ];
  },

  /** 淡入。**只动 opacity** —— 可以和任何 position 预设叠加而不冲突 */
  fadeIn: ({ range }) => {
    const map = mapper(range);
    return [track('opacity', [[0, 0, 'easeOut'], [1, 1, 'easeOut']], map)];
  },

  /** 淡出。转场收尾用 */
  fadeOut: ({ range }) => {
    const map = mapper(range);
    return [track('opacity', [[0, 1], [0.4, 1], [1, 0, 'easeIn']], map)];
  },

  /** 从下方升起 + 淡入。入场用 */
  rise: ({ range, intensity }) => {
    const map = mapper(range);
    return [
      track('position.y', [[0, -0.11 * intensity, 'easeOutCubic'], [1, 0, 'easeOutCubic']], map),
      track('opacity', [[0, 0, 'easeOut'], [0.7, 1, 'easeOut'], [1, 1]], map),
    ];
  },

  /** 从上方沉入 + 淡入 */
  sink: ({ range, intensity }) => {
    const map = mapper(range);
    return [
      track('position.y', [[0, 0.09 * intensity, 'easeOutCubic'], [1, 0, 'easeOutCubic']], map),
      track('opacity', [[0, 0, 'easeOut'], [0.7, 1, 'easeOut'], [1, 1]], map),
    ];
  },

  /**
   * 侧向滑入 + 轻微旋转。
   *
   * 注意方向：所有对象都往同一侧滑会显得像"整队平移"，
   * 所以调用方（compose.ts）会交替传入正负 intensity 来打散。
   */
  scatter: ({ range, intensity }) => {
    const map = mapper(range);
    const dir = intensity < 0 ? -1 : 1;
    const a = Math.abs(intensity) || 1;
    return [
      track('position.x', [[0, dir * 0.2 * a, 'easeOutCubic'], [1, 0, 'easeOutCubic']], map),
      track('rotation.z', [[0, dir * 0.06 * a, 'easeOutCubic'], [1, 0, 'easeOutCubic']], map),
      track('opacity', [[0, 0, 'easeOut'], [0.6, 1, 'easeOut'], [1, 1]], map),
    ];
  },

  /** 椭圆轨迹：x 和 y 的相位错开四分之一周期 */
  orbit: ({ range, intensity }) => {
    const map = mapper(range);
    return [
      oscillate('position.x', 0.02 * intensity, map, 0.25),
      oscillate('position.y', 0.014 * intensity, map, 0.25),
    ];
  },

  /** 沿 z 轻微推进 —— 配合相机前进，制造"层次在分离"的感觉 */
  pushIn: ({ range, intensity }) => {
    const map = mapper(range);
    return [track('position.z', [[0, -1.6 * intensity], [1, 1.6 * intensity, 'easeInOut']], map)];
  },

  /** 转场前先退场：淡出 + 下沉 */
  exitDown: ({ range, intensity }) => {
    const map = mapper(range);
    return [
      track('position.y', [[0, 0], [1, -0.09 * intensity, 'easeIn']], map),
      track('opacity', [[0, 1], [0.35, 1], [1, 0, 'easeIn']], map),
    ];
  },
};

export function presetNames(): string[] {
  return Object.keys(PRESETS);
}

/**
 * 展开一个 ObjectAnimation 成轨道数组。
 *
 *   { tracks: [...] }                    → 原样返回（手写优先）
 *   { preset: 'float' }                  → 展开预设
 *   { preset: 'float', intensity: 0.5 }  → 半幅
 *   { preset: 'float', range: [.2,.8] }  → 只在 20%~80% 进度之间浮动
 *   undefined                            → 空轨道（对象静止）
 *
 * 未知预设名**不抛异常**，而是返回空轨道 + 一条 console.warn ——
 * 因为预设名是内容侧字符串，拼错一个字母不该让整站白屏。
 */
export function expandPreset(anim: ObjectAnimation | undefined): Track[] {
  if (!anim) return [];
  if (anim.tracks && anim.tracks.length) return anim.tracks;

  const name = anim.preset;
  if (!name) return [];

  const build = PRESETS[name];
  if (!build) {
    console.warn(
      `[presets] 未知的动画预设 "${name}"，该对象将静止。可用: ${presetNames().join(', ')}`,
    );
    return [];
  }

  return build({
    range: anim.range ?? [0, 1],
    intensity: anim.intensity ?? 1,
  });
}
