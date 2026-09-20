/**
 * PHASE 6 —— 视差系统
 * ===========================================================================
 * 负责一件事：**位移的单位制**。
 *
 * ---------------------------------------------------------------------------
 * 【先说清楚：这里的"视差"到底指什么】
 *
 *   分层视差**不是这几十行代码算出来的**，它是透视投影的几何后果：
 *
 *     同一个相机往前推 Δz，z=-7 的层在屏幕上放大的倍率，
 *     远大于 z=-25 的层 —— 这是硬件免费给的，不写任何代码也成立。
 *
 *   真实站点实测（three devtools 钩子抓的运行时场景图）印证了这一点：
 *     asset-1  Group  position(-0.233, 0.141, -7.09)  scale(2,2,3)
 *     asset-2  Group  position(0, 0, -25.46)          scale 18.901
 *   两层 z 差 18 个单位，屏幕上位移速度自然就差出一个量级。
 *
 *   所以本模块**只做两件很小但容易写错的事**：
 *
 *     ▸ 定义"轨道数值 1.0"等于多少世界单位
 *     ▸ 提供一个艺术性的强度倍率（让某一层"动得更狠"）
 *
 *   刻意做小 —— 把"自然视差"也塞进代码里重算一遍，反而会把它抵消掉
 *   （见下面 ⚠️ 那条踩过的坑）。
 *
 * ---------------------------------------------------------------------------
 * 【单位制：1.0 = 一个视口高】
 *
 *   baseVisibleH = 该图层深度处「视口在世界空间的高度」
 *                = 2 · tan(fov/2) · |camera.z - layer.z|
 *
 *   于是：
 *     Y 方向   1.0 → baseVisibleH              世界单位
 *     X 方向   1.0 → baseVisibleH · aspect     世界单位
 *
 *   X 为什么要乘 aspect：视口高对应的世界高度是 baseVisibleH，
 *   而视口宽是它的 aspect 倍。不乘的话，"横向移动 1.0"和"纵向移动 1.0"
 *   在屏幕上的距离不相等 —— 构图时算好的 offset 会被扭掉。
 *
 * ---------------------------------------------------------------------------
 * 【⚠️ 已知缺陷：调用方传进来的 aspect 目前恒为 1】
 *
 *   presets.ts 与 compose.ts 都写着「position.x 的轨道值 = 屏幕宽度的比例」，
 *   也就是这里该收**运行时的视口 aspect**。但拆分前 `applyTime` 用的是
 *   `buildScene` 的入参（Composer 固定传 1），之后 setAspect 也不更新它 ——
 *   于是实际生效的是「1.0 = 一个视口高」，横向幅度只有设计值的 1/aspect
 *   （2.1 的视口下约 47%）。
 *
 *   这次是纯重构，**保持原样不动**。修复点在 SceneBuilder.setAspect 里，
 *   加一行 `objectSystem.setAspect(next)` 即可，但那会让横向动效幅度翻倍，
 *   属于观感变更，需要单独过一遍眼睛。
 *
 * ---------------------------------------------------------------------------
 * 【⚠️ 踩过的坑：不要在每帧重算 baseVisibleH】
 *
 *   baseVisibleH 依赖 `camera.z - layer.z`。如果每帧按**当前**相机位置重算，
 *   相机一往前推，所有层的位移单位就同步变小 —— 画面整体跟着相机缩放，
 *   分层视差被完全抵消，2.5D 变成一张扁平的图。
 *
 *   所以它只在初始化和 setAspect 时算一次（用「起始相机状态」），
 *   之后相机怎么动都不改。
 * ===========================================================================
 */

import type { SceneObjectConfig } from '../../schema';

/** 视差计算所需的最小图层信息（BuiltLayer 结构上满足它） */
export interface ParallaxLayer {
  /** 该层深度处「一个视口高」对应的世界单位数 */
  baseVisibleH: number;
  /** 艺术性强度倍率（1 = 完全由 z 深度自然产生） */
  parallax: number;
}

/** 复用的输出容器 —— 每帧每图层都新建对象会在 60fps 下喂饱 GC */
export interface WorldOffset {
  x: number;
  y: number;
}

/** 缺省强度：1 = 不加不减，视差纯由深度自然产生 */
export const DEFAULT_PARALLAX = 1;

/**
 * 从 config 解析视差强度。
 *
 * 单独抽出来是因为"缺省值"这件事散在各处就会各写一遍 ——
 * `?? 1` 出现三次，其中一次写成了 `?? 0`，那层的动效就整个消失了。
 */
export function resolveParallax(config: SceneObjectConfig): number {
  return config.parallax ?? DEFAULT_PARALLAX;
}

/**
 * 轨道位移（视口高为单位）→ 世界坐标偏移，并施加该层的强度倍率。
 *
 * @param vx 轨道求出的 position.x（0 = 不动）
 * @param vy 轨道求出的 position.y
 * @param aspect 视口宽高比
 * @param out 结果写入这里（复用，不分配）
 *
 * ★ 只放大**轨道位移**，不动 baseX/baseY，也不碰投影本身 ——
 *   所以调 parallax 不会破坏构图，只会让这个对象"动得更狠"。
 */
export function applyParallax(
  layer: ParallaxLayer,
  vx: number,
  vy: number,
  aspect: number,
  out: WorldOffset,
): void {
  const strength = layer.parallax;
  out.x = vx * strength * layer.baseVisibleH * aspect;
  out.y = vy * strength * layer.baseVisibleH;
}
