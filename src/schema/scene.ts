/**
 * ★ Schema —— 场景契约
 * ---------------------------------------------------------------------------
 * 一个场景 = 一份完整可渲染的声明。整个引擎只认这一种输入形态。
 *
 * 改造前的状态：`SceneConfig` 定义在 `config/scenes.ts`（一个内容文件）里，
 * 被 `engine/SceneBuilder.ts` 反向 import。现在它属于契约层。
 * ---------------------------------------------------------------------------
 *
 * 【本文件做的一处正式化改动】
 *   改造前用 `isHero: boolean` 表达"首屏走圆形径向溶解"。
 *   `isHero` 是个含糊的名字 —— 它同时暗示了"这是第一章"和"这是圆形溶解"，
 *   两件事被一个布尔值绑死了。想给第 3 章也用圆形溶解，没法表达。
 *   现在改成 `transition.mode: 'radial' | 'sweep'` —— 意图明确，且可自由组合。
 *   （行为不变：radial 仍然映射到 shader 的 uIsHero = 1，见 Composer.ts）
 */

import type { CameraAnimation, ObjectAnimation, Track } from './animation';
import type { SceneObjectConfig } from './object';
// ★ 这里 import 的是"展开器"，不是"预设表"。
//   `animation/presets.ts` 里既定义了 13 个预设，也定义了 expandPreset()。
//   展开是**纯函数**（ObjectAnimation → Track[]），没有副作用、没有状态，
//   所以放在这一层是合适的 —— 它是"内容声明 → 引擎输入"的归一化步骤。
//
//   依赖方向：schema/scene.ts → animation/presets.ts → schema/animation.ts（type-only）
//   无环。而且 presets.ts 自己**没有**任何运行时依赖（它只 import type），
//   所以引入它不会顺带拖进别的模块。
import { expandPreset } from '../animation/presets';

/* ------------------------------------------------------------ 相机 */

export interface CameraConfig {
  /** 相机到世界原点的初始距离（也是 position.z 轨道的兜底值） */
  z: number;
  /** 初始垂直视野角（度）。原站 Hero 实测从 25 走到 22.27 */
  fov: number;
  /** 相机自身的轨道（position / rotation / fov） */
  tracks: Track[];
  /** 可选阻尼，见 CameraAnimation.damping */
  damping?: number;
}

/* ------------------------------------------------------------ 过渡 */

/**
 * 场景进入时的过渡方式。
 *
 * 【原理】过渡不是 alpha 渐变，而是「空间变化的阈值场」：
 *   屏幕上铺一张 threshold 图，比较 `progress - threshold` 的正负，
 *   逐像素决定显示 Scene A 还是 Scene B。阈值图由
 *   圆形距离/斜向梯度 + 噪声 + 法线扰动 三部分叠加而成 ——
 *   这就是为什么边界是"活"的，而普通 mask 是死的。
 */
export interface TransitionConfig {
  /**
   *   'radial' —— 圆形径向溶解 + current/next 各自 ±10% 缩放推进，边界强发光
   *               （原站 Hero 首屏用的）
   *   'sweep'  —— 斜向擦除，进度先过一遍 smoothstep 缓动
   *               （原站其余章节用的）
   */
  mode: 'radial' | 'sweep';

  /**
   * 溶解中心（世界坐标）。只对 radial 有意义 ——
   * 会被 uProjectionView 投影到屏幕空间，所以改这个值 = 改圆心的位置。
   * 再叠 10% 的鼠标影响（uMouse），圆心会跟着鼠标微微偏移。
   */
  fadeCenter: [number, number, number];
}

/* ------------------------------------------------------------ 场景 */

export interface SceneConfig {
  id: string;
  /** 对应 DOM 章节的 data-section-id，也用于调试面板 */
  handle: string;
  /** 在 SCENES 数组里的序号。冗余但显式，方便调试时对照 */
  index: number;

  /* ---- DOM 覆盖层文案 ---- */
  eyebrow: string;
  title: string;
  body: string;

  /* ---- 视觉 token ---- */
  /** 章节主色（DOM 文字 / 进度条 / 调试面板） */
  accent: string;
  /** canvas 底色，同时是 DOM 的背景（避免加载瞬间白闪） */
  background: string;

  /* ---- 滚动行为 ---- */
  /** DOM 章节高度（vh 倍数）—— 决定"滚多远换一章" */
  heightVh: number;
  /**
   * 交叉溶解提前量（vh 倍数）。
   * 原站实现：`sectionIndex >= 2 ? 0.2 : 0`
   * 即从第 3 章开始，下一章提前 20% 视口高度开始参与溶解。
   */
  earlyCrossfade: number;

  /* ---- 引擎 ---- */
  transition: TransitionConfig;
  camera: CameraConfig;
  /** 场景内的对象。渲染顺序 = 数组顺序（renderOrder 按序号设置） */
  objects: SceneObjectConfig[];
}

/* ------------------------------------------------------ 归一化辅助 */

/**
 * 取一个对象生效的轨道。
 *
 * 支持三种写法：
 *   objects: [{ animation: { tracks: [...] } }]    ← 手写
 *   objects: [{ animation: { preset: 'scatter' } }] ← 预设（在这里展开）
 *   objects: [{ tracks: [...] }]                    ← 改造前的旧写法，兼容
 *
 * ★ 这是预设机制**唯一的展开点**（引擎侧）。
 *   所以 `expandPreset` 必须在这里调用，而不是在 SceneBuilder 里 ——
 *   否则每条读取轨道的代码路径都要各自记得展开一次，
 *   漏掉一处就是"某个对象的动画莫名不动"这种极难定位的 bug。
 *
 *   注意 compose.ts（自动构图）走的是另一条路：它直接把展开好的 tracks
 *   写进 `animation.tracks`。两条路最终都汇到同一个结果，
 *   这里再调一次 expandPreset 是幂等的（`tracks` 优先，原样返回）。
 */
export function tracksOf(obj: SceneObjectConfig): Track[] {
  if (obj.animation?.tracks?.length) return obj.animation.tracks;
  if (obj.animation?.preset) return expandPreset(obj.animation);
  return obj.tracks ?? [];
}

/**
 * @deprecated 预设的展开已经统一在 `tracksOf` 里完成。
 * 保留这个函数只是为了让旧的调用点不炸 —— 新代码请直接用 `tracksOf`。
 */
export function presetOf(obj: SceneObjectConfig): ObjectAnimation | null {
  const a = obj.animation;
  if (!a || a.tracks || !a.preset) return null;
  return a;
}

/** 取相机的阻尼系数（默认 0 = 直接跟随，即原站行为） */
export function cameraDamping(cam: CameraConfig | CameraAnimation): number {
  return cam.damping ?? 0;
}
