/**
 * ★ 引擎默认设计 token
 * ---------------------------------------------------------------------------
 * 这些是**引擎级默认值** —— 一个内容包不提供 site 配置时，就用这里的。
 *
 * 改造前，本文件的数值全部来自对 Shopify Winter '26 的运行时实测
 * （H2 = 149.386px / NeueMontreal 字体族 / …）。那是**某个具体内容的视觉决策**，
 * 不该作为引擎的默认值 —— 引擎的默认值应该中立、不依赖任何特定品牌资产。
 *
 * 所以现在分两层：
 *   ▸ 本文件  —— 中立的默认值（系统字体栈、克制的字号阶梯）
 *   ▸ content/shopify/site.ts —— 保留那批实测值，作为 Shopify 内容包自己的配置
 */

import type { PostConfig } from '../schema/post';

export const DESIGN = {
  /**
   * 默认字体族。
   *
   * 为什么默认用系统字体栈而不是某个品牌字体：
   *   品牌字体（NeueMontreal / HWCigars / ImperialScript）是有授权的资产，
   *   引擎默认值里带上它们会让模板"开箱就跑不起来"（字体 404）。
   *   系统栈零加载、零授权风险，且中文环境下能正确落到 PingFang / 微软雅黑。
   */
  font: {
    sans: 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif',
    display: 'Georgia,"Songti SC","Times New Roman",serif',
    script: '"Snell Roundhand",cursive',
  },

  type: {
    h2: {
      fontSize: 'clamp(40px, 9.3vw, 132px)',
      fontWeight: 700,
      letterSpacing: '-0.03em',
      lineHeight: 0.9,
    },
    h3: {
      fontSize: 'clamp(24px, 3.2vw, 52px)',
      fontWeight: 700,
      letterSpacing: '-0.02em',
      lineHeight: 0.95,
    },
    eyebrow: {
      fontSize: 'clamp(11px, 0.85vw, 13px)',
      fontWeight: 500,
      letterSpacing: '0.18em',
      textTransform: 'uppercase' as const,
    },
    body: {
      fontSize: 'clamp(14px, 1.05vw, 17px)',
      fontWeight: 400,
      lineHeight: 1.55,
      letterSpacing: '-0.01em',
    },
  },

  /**
   * 章节高度（vh 倍数）—— 决定"滚多远换一章"。
   *
   * 1.2 的来历：真实站点实测值。它同时决定了首屏的初始进度：
   *   p(0) = vh / (h + vh) = 1 / 2.2 ≈ 0.4545
   * 而 scrollProgress.ts 会把首屏这一段重映射掉，让"首屏 = 动画第 0 帧"。
   * 所以改这个值不会破坏首屏对齐，但会改变"滚一章需要滚多远"的手感。
   */
  sectionHeightVh: 1.2,

  /**
   * 交叉溶解提前量。
   * 原站实现：`earlyCrossfade: sectionIndex >= 2 ? 0.2 : 0`
   * 即从第 3 章开始，下一章提前 20% 视口高度开始参与溶解。
   *
   * 为什么前两章不给提前量：首屏需要"稳定构图"的时间，
   * 太早开始溶解会让开场显得慌乱。
   */
  earlyCrossfadeFrom: 2,
  earlyCrossfadeAmount: 0.2,

  /**
   * 过渡 shader 的常量。
   *
   * [CONFIRMED] 这批值是从原站 shader 源码里逐字提取的
   *   （evidence/SHADER_transition.glsl，118 行）。
   *   当前 transition.ts 把数值内联在 GLSL 里，所以这份 token 暂时只作文档用途 ——
   *   改它不会影响渲染。要做成可调，需要把它们提升为 uniform。
   */
  transition: {
    /** hero 的 progress 用 smoothstep(0, 1.5, p) 重新映射 */
    heroSmoothstepMax: 1.5,
    /** 阈值场整体缩放：threshold / 1.2 */
    thresholdDivisor: 1.2,
    /** 噪声对阈值的权重 */
    noiseWeight: 0.2,
    /** fwidth 线稿强度区间 */
    edgeStrength: [5.0, 10.0] as [number, number],
    /** 抗锯齿带宽倍数 */
    aaWidth: 10.0,
    /** 溶解中心的鼠标影响权重 */
    mouseInfluence: 0.1,
  },
} as const;

/**
 * ★ 引擎级后处理默认值
 * ---------------------------------------------------------------------------
 * 与 `DESIGN` 分开导出的原因：DESIGN 是 `as const` 的**排版/滚动** token，
 * 而后处理配置要能被内容包整体替换（一个包可能一个效果都不要），
 * 混进 as const 的 DESIGN 里会让"整体替换"这件事变得别扭。
 *
 * 【为什么这套默认值偏保守】
 *   引擎默认值必须**中立** —— 它不能带着某个内容的审美。
 *   所以这里只保留"几乎任何素材都适用"的四件套：
 *     bloom（沿用自制版实测的 0.85 强度）+ 极轻的色差 + 极轻的颗粒 + 暗角。
 *   想要更强烈的风格（比如印刷感：重颗粒 + 扫描线 + 强色差），
 *   由内容包在自己的 `site.post` 里声明 —— 那是内容的审美决策。
 *
 * 【pulse 的取值理由】
 *   色差给 1.6、颗粒给 1.2 —— 这两个是"过渡瞬间最抓眼球"的，
 *   给大了才能在切换的 0.3 秒里被看见。
 *   bloom / vignette 只给 0.35 —— 它们是"底子"，剧烈变化会显得画面在喘。
 */
export const DEFAULT_POST: PostConfig = {
  enabled: true,
  frameBufferType: 'halfFloat',
  multisampling: 0,
  effects: [
    {
      kind: 'bloom',
      // 强度/阈值/软膝沿用自制 BloomSystem 的实测值，保证观感不突变
      intensity: 0.85,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.55,
      mipmapBlur: true,
      radius: 0.72,
      pulse: 0.35,
    },
    {
      kind: 'chromaticAberration',
      offset: [0.0009, 0.0007],
      radialModulation: true,
      modulationOffset: 0.35,
      // 切章瞬间色差炸开 —— 这是"镜头感"最便宜的来源
      pulse: 1.6,
    },
    {
      kind: 'noise',
      blend: 'overlay',
      opacity: 0.05,
      pulse: 1.2,
    },
    {
      kind: 'vignette',
      offset: 0.32,
      darkness: 0.4,
      pulse: 0.35,
    },
  ],
};
