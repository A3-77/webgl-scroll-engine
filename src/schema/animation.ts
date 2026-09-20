/**
 * ★ Schema —— 动画契约
 * ---------------------------------------------------------------------------
 * 这是引擎与内容之间的**共享契约**之一。
 *
 * 为什么单独抽一层 schema/：
 *   改造前，`Track` / `Keyframe` / `Ease` 这三个类型定义在 `config/scenes.ts` 里，
 *   而 `engine/SceneBuilder.ts` 和 `animation/timeline.ts` 都要 import 它 ——
 *   于是「引擎」依赖了「内容」，方向反了。
 *
 *   现在：engine → schema ← content。两边都只依赖契约，互不知道对方存在。
 *
 * ---------------------------------------------------------------------------
 * 数据结构刻意对齐真实站点的 Theatre.js 资产格式：
 *   Theatre:  sheet.sequence.tracksByObject[obj].trackData[trackId].keyframes
 *              + trackIdByPropPath: '["position","x"]' -> trackId
 *   这里:     track.path = 'position.x' + track.keyframes
 * 语义完全一致（都是"按 sequence.position 求值的属性轨道"）。
 * ---------------------------------------------------------------------------
 *
 * [CONFIRMED] 原站用 @theatre/core，13 份 theatre-project-state JSON 作为 CMS 资产下发
 * [CONFIRMED] 轨道按 `sequence.position` 求值，而不是按墙上时钟
 */

/* ------------------------------------------------------------------ 缓动 */

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'easeOutCubic';

/* -------------------------------------------------------------- 关键帧 */

export interface Keyframe {
  /** 时间轴位置 0..1 —— 对应场景的滚动进度 */
  t: number;
  value: number;
  /** 从"上一个关键帧"到"本关键帧"之间使用的缓动 */
  ease?: Ease;
}

/* ---------------------------------------------------------------- 轨道 */

/**
 * 属性路径。刻意与真实站点的 trackIdByPropPath 保持同名：
 *
 *   位置   'position.x' | 'position.y' | 'position.z'
 *   缩放   'scale.x'    | 'scale.y'
 *   旋转   'rotation.z'
 *   不透明 'opacity'
 *   可见性 'visible'    （0 = 隐藏，1 = 显示）
 *   相机   'fov'
 *
 * 新增属性只需要在这里加一个字符串 —— 求值器（animation/timeline.ts）
 * 是按字符串查表，不认识具体属性，所以加属性不用改引擎。
 */
export type TrackPath =
  | 'position.x'
  | 'position.y'
  | 'position.z'
  | 'scale.x'
  | 'scale.y'
  | 'rotation.z'
  | 'opacity'
  | 'visible'
  | 'fov'
  | (string & {});

export interface Track {
  path: TrackPath;
  keyframes: Keyframe[];
}

/* ------------------------------------------------------------ 属性轨道表 */

/** 一帧求值结果：属性路径 → 数值。求值器复用同一个对象，避免 60fps 下疯狂分配 */
export type TrackValues = Record<string, number>;

/* -------------------------------------------------------------- 组合动画 */

/**
 * 一个对象的完整动画描述：可以是手写轨道，也可以引用一个预设。
 *
 * 这是 PHASE 13（Motion Presets）的接口形态：
 *   { preset: 'scatter' }                          —— 全用预设默认值
 *   { preset: 'slideLeft', intensity: 0.8 }        —— 预设 + 强度
 *   { preset: 'float', range: [0.2, 0.8] }         —— 预设 + 生效区间
 *   { tracks: [...] }                              —— 手写轨道（完全自由）
 *
 * 预设最终会被「展开」成 tracks（见 animation/presets/index.ts），
 * 所以引擎侧只需要认识 tracks 一种形态 —— 预设是内容侧的糖。
 */
export interface ObjectAnimation {
  /** 预设名。与 tracks 二选一 */
  preset?: string;
  /** 预设强度倍率（1 = 预设默认幅度） */
  intensity?: number;
  /** 预设生效的滚动区间 [start, end]，默认 [0, 1] */
  range?: [number, number];
  /** 手写轨道。给了这个就忽略 preset */
  tracks?: Track[];
}

/* ---------------------------------------------------------- 相机动画 */

export interface CameraAnimation {
  /** 相机位置轨道 */
  tracks: Track[];
  /**
   * 阻尼系数（0..1，越小越"拖沓"）。
   *
   * [INFERENCE] 原站的相机是否带阻尼未能从 bundle 确认。
   *   这里实现为可选：不填 = 直接跟随（原站当前行为），
   *   填了 = 对求值结果做一阶低通，滚动停下后相机还会滑一小段。
   *   做成可选是为了**不改变已验证的观感**。
   */
  damping?: number;
}
