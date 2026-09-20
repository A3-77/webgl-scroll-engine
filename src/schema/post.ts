/**
 * ★ Schema —— 后处理契约
 * ===========================================================================
 * 一个后处理链 = 一份「画面出厂前的最后一道工序」的声明。
 *
 * ---------------------------------------------------------------------------
 * 【为什么要有这一层，而不是在 Composer 里手工 new 一堆 Effect】
 *
 *   改造前整条链只有一件事：自制的 BloomSystem（亮度提取 → 横竖高斯 → 叠回）。
 *   它的问题是**不可配置** —— 想要胶片颗粒，得手写 shader、改 Composer、
 *   再改调试面板，等于「换观感 = 改引擎」。这和「换素材 = 改代码」是同一类病。
 *
 *   现在：内容包在自己那份 `site.post` 里声明想要哪些效果、各自多强，
 *   引擎按声明去装配 pmndrs/postprocessing 的效果链。内容包不写一行 shader。
 *
 * ---------------------------------------------------------------------------
 * 【★ pulse —— 让后处理"活着"，而不是一层静态滤镜】
 *
 *   参考站点（shader.se / iamsaeed.dev）的画面之所以"有质感"，
 *   不是因为叠了滤镜，而是因为**滤镜的强度在跟着滚动变化**：
 *   切章的瞬间色差炸开、颗粒变重；滚快的时候画面撕裂感增强。
 *   静止不变的滤镜一眼就能看出是"贴图"。
 *
 *   所以每个效果都带一个可选的 `pulse`（0..1）：
 *
 *       实际强度 = base × (1 + pulse × 活跃度)
 *
 *   「活跃度」由引擎每帧算好喂进来，见 PostSystem.render() 的 drive 参数。
 *   它是两个来源的加权和：
 *     ▸ 过渡活跃度  过渡进行到一半时最强（sin(π × uProgress)）
 *     ▸ 滚动速度    滚得越快越强（Lenis velocity 归一化）
 *
 *   pulse = 0 就是"恒定强度"，退化成普通滤镜 —— 这是最保守的写法。
 *
 * ---------------------------------------------------------------------------
 * 【为什么用可辨识联合（discriminated union）而不是一个大平铺的接口】
 *
 *   八个效果的参数各不相同，平铺成一个接口会得到
 *   `radius?: number; density?: number; columns?: number; ...` 这种
 *   「字段之间互不认识」的面条结构，而且 `kind: 'noise'` 配 `radius: 8`
 *   这种错误写法类型检查器根本拦不住。
 *   联合类型让 TS 在 `switch (e.kind)` 里自动收窄，写错参数即编译失败。
 * ---------------------------------------------------------------------------
 */

/* ------------------------------------------------------------ 效果种类 */

export type PostEffectKind =
  /** 高光溢出。pmndrs 版是 mipmap 金字塔模糊，比手写高斯质量高得多 */
  | 'bloom'
  /** RGB 通道错位 —— 镜头色差。是"胶片/印刷"质感最便宜的来源 */
  | 'chromaticAberration'
  /** 胶片颗粒 */
  | 'noise'
  /** 暗角 */
  | 'vignette'
  /** 扫描线（CRT）。单独用很廉价，配合 noise 才有味道 */
  | 'scanline'
  /** 数字故障。随机触发，pulse 决定强度 */
  | 'glitch'
  /** 色相 / 饱和度 */
  | 'hueSaturation'
  /** 亮度 / 对比度 */
  | 'brightnessContrast';

/* ------------------------------------------------------------ 各效果的声明 */

interface PostEffectBase {
  /** 默认 true。设为 false 等于"声明了但暂时关掉"，方便 A/B 对比 */
  enabled?: boolean;
  /**
   * 滚动脉冲强度，0..1。0 = 恒定强度。详见文件头说明。
   *
   * 经验值：
   *   0.3 ~ 0.6  能察觉但不过分（推荐给 bloom / vignette）
   *   1.0 ~ 2.0  切换瞬间明显炸开（推荐给 chromaticAberration / noise）
   */
  pulse?: number;
}

export interface BloomEffectSpec extends PostEffectBase {
  kind: 'bloom';
  /** 叠加强度。0.85 是自制版实测调出来的值，先沿用 */
  intensity?: number;
  /** 亮度阈值 0..1。低于它不参与泛光 */
  luminanceThreshold?: number;
  /** 阈值附近的软过渡带，避免高光边缘出现硬边 */
  luminanceSmoothing?: number;
  /** 用 mipmap 金字塔模糊（推荐）。关掉就退化成固定半径的核模糊 */
  mipmapBlur?: boolean;
  /** mipmapBlur 下的模糊半径 0..1 */
  radius?: number;
  /** mipmap 层数，越多越远的光晕越大。默认 8 */
  levels?: number;
}

export interface ChromaticAberrationSpec extends PostEffectBase {
  kind: 'chromaticAberration';
  /** UV 偏移量 [x, y]。0.0008 左右是"看得见但不廉价"的量级 */
  offset?: [number, number];
  /** 是否让偏移从画面中心向外递增（镜头感更强） */
  radialModulation?: boolean;
  /** radialModulation 生效的起始半径 0..1 */
  modulationOffset?: number;
}

export interface NoiseSpec extends PostEffectBase {
  kind: 'noise';
  /** 颗粒强度 0..1（走 blendMode.opacity） */
  opacity?: number;
  /**
   * 混合模式。
   *   'overlay' —— 只在中灰附近抖动，不抬黑场，最像真实胶片（默认）
   *   'screen'  —— 只提亮，暗部会变灰
   *   'add'     —— 线性相加，最生硬
   */
  blend?: 'overlay' | 'screen' | 'add';
  /** 先把噪声和原色相乘再混合（暗部颗粒更细） */
  premultiply?: boolean;
}

export interface VignetteSpec extends PostEffectBase {
  kind: 'vignette';
  /** 暗角起始位置 0..1，越小暗角越大 */
  offset?: number;
  /** 暗角深度 0..1 */
  darkness?: number;
}

export interface ScanlineSpec extends PostEffectBase {
  kind: 'scanline';
  /** 线条密度（屏幕高度的倍数） */
  density?: number;
  /** 强度 0..1 */
  opacity?: number;
}

export interface GlitchSpec extends PostEffectBase {
  kind: 'glitch';
  /** 最大扰动强度 0..1 */
  strength?: number;
  /** 触发概率 0..1。越小越偶发 */
  ratio?: number;
}

export interface HueSaturationSpec extends PostEffectBase {
  kind: 'hueSaturation';
  /** 色相偏移，弧度 -PI..PI */
  hue?: number;
  /** 饱和度倍率。1 = 原样，0 = 灰度 */
  saturation?: number;
}

export interface BrightnessContrastSpec extends PostEffectBase {
  kind: 'brightnessContrast';
  /** 亮度偏移 -1..1 */
  brightness?: number;
  /** 对比度倍率。1 = 原样 */
  contrast?: number;
}

/** 一个后处理效果的完整声明 */
export type PostEffectSpec =
  | BloomEffectSpec
  | ChromaticAberrationSpec
  | NoiseSpec
  | VignetteSpec
  | ScanlineSpec
  | GlitchSpec
  | HueSaturationSpec
  | BrightnessContrastSpec;

/* ------------------------------------------------------------ 链的配置 */

export interface PostConfig {
  /**
   * 总开关。false = 过渡结果直接打屏，一个后处理 pass 都不跑。
   *
   * 关掉它的用途：看清过渡 shader 的**原始输出**。
   * 调阈值场的时候必须关 —— 否则你分不清边界的亮边是 shader 画的还是 bloom 加的。
   */
  enabled?: boolean;

  /**
   * 内部帧缓冲的精度。
   *   'halfFloat'（默认）—— 保留 >1 的高光，bloom 才不会被夹成死白
   *   'byte'            —— 省带宽，但 bloom 会在 1.0 处硬截断
   */
  frameBufferType?: 'halfFloat' | 'byte';

  /** 多重采样抗锯齿。全屏后处理下收益极小，默认 0（关） */
  multisampling?: number;

  /** 按顺序排列的效果。顺序会影响观感（先调色再泛光 ≠ 先泛光再调色） */
  effects: PostEffectSpec[];
}
