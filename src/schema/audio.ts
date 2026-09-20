/**
 * ★ Schema —— 音频契约
 * ===========================================================================
 * 把"这个内容包要不要声音、要什么样的声音"声明成数据，
 * 引擎不直接 new 任何 Tone.js 节点 —— 全部由 schema 驱动。
 *
 * ---------------------------------------------------------------------------
 * 【三块拼图：ambient / transition / motion】
 *
 *   ▸ ambient —— 一条持续的低频 drone（drone bed），永远是画面"的声音底色"
 *   ▸ transition —— 章节切换瞬间触发一次短音 / 噪声 burst，作为"画面换"的听觉提示
 *   ▸ motion —— 把滚动速度映射到滤波器打开 / 颤音深度，效果跟着手"动起来"
 *
 *   这三条覆盖了参考站点（iamsaeed.dev）音频系统里最显眼的三个效果。
 *   它没有鼓点、没有 UI 音效、没有 hit-stop —— 那些是更深的细节，
 *   不属于"素材驱动"该解决的范畴，先不做。
 *
 * ---------------------------------------------------------------------------
 * 【★ 默认 OFF —— 浏览器自动播放策略的硬约束】
 *
 *   Chrome / Safari / Firefox 都要求 AudioContext 必须在用户手势里
 *   start()，否则会被静默或直接挂起。本契约通过 `enabled: false` 默认值
 *   让音频默认完全不开，符合"先取得用户许可再放声"的礼貌原则。
 *
 *   UI 层（AudioToggle 按钮）会在用户第一次点击时调用 audioSystem.start()，
 *   把 enabled 翻成 true。
 *
 * ---------------------------------------------------------------------------
 * 【dB 而不是 0..1】
 *   Tone.js 的 Gain 接口用 dB（-Infinity..+12 是合理区间）。
 *   把"音量"按 dB 声明有两个好处：
 *     1. 与 Tone.js 对齐，避免每帧做 10^(db/20) 的转换
 *     2. 人的听感是对数刻度，dB 步进比 0..1 步进更直觉
 *   没写单位转换是因为这是 Tone.js 的硬约定，不是我们引入的。
 * ---------------------------------------------------------------------------
 */

/* ------------------------------------------------------------ 环境音床 */

export interface AmbientSpec {
  /** 是否启用。默认 false —— 必须用户主动开 */
  enabled?: boolean;

  /** 主振荡器频率 Hz。80 是个偏低的"垫底"音，安静的展馆感觉 */
  pitch?: number;

  /**
   * 几个去谐的副本。1 = 只有主振；3~5 是常见的"胖 drone"；
   * 再多就开始糊。detune 范围越大，音色越"宽"。
   */
  voices?: number;

  /** 每个副本的 detune 范围 cents（1 半音 = 100 cents） */
  detuneRange?: number;

  /** 低通滤波器基准截止 Hz（静止时）。8000 几乎不动 */
  filterBase?: number;

  /** 滤波器最大打开量 Hz（被 motion 推到上限） */
  filterCeil?: number;

  /** 混响干湿比 0..1。0 = 干声，1 = 全湿。0.3 是微妙的"远墙"感 */
  reverb?: number;

  /** 整体音量 dB。默认 -22 —— 背景，不抢戏 */
  gainDb?: number;
}

/* ------------------------------------------------------------ 转场音效 */

export interface TransitionSfxSpec {
  /** 是否启用 */
  enabled?: boolean;

  /**
   * 触发音类型。
   *   'noise' —— 白噪声快速淡出，像撕纸（默认）
   *   'tone'  —— 一根短促的 sine bell
   *   'both'  —— 噪声 + tone 叠在一起，更"大"
   */
  type?: 'noise' | 'tone' | 'both';

  /** 持续时间 s。0.15 是个"快闪"的量级 */
  duration?: number;

  /** 音量 dB。默认 -10，比 ambient 强 */
  gainDb?: number;

  /** 带通中心频率 Hz。2000 是"擦边高频"，不刺耳 */
  filterFreq?: number;
}

/* ------------------------------------------------------------ 滚动驱动 */

export interface MotionSpec {
  /**
   * 滚动速度 → 滤波器打开量。
   *   0 = 静止时滤波器永远在 filterBase
   *   1 = 速度归一化到 velocityRef 时滤波器推到 filterCeil
   * 中间值线性插值。
   */
  filterOpen?: number;

  /**
   * 滚动速度 → 振幅调制（颤音）深度 0..1。
   *   0 = 完全不颤
   *   0.05 = 滚得快时微微"飘"，最有生命力
   */
  tremolo?: number;

  /** 速度归一化参考（px/帧）。参考站点实测 Lenis 快速滚动典型量级 */
  velocityRef?: number;
}

/* ------------------------------------------------------------ 顶层 */

export interface AudioConfig {
  /**
   * 是否启用音频。默认 false —— 必须在用户手势（点击 AudioToggle）后置 true。
   *
   * 为什么不默认开：浏览器自动播放策略 + 很多人并不想要声音。
   * 默认 OFF 让"进入页面就安静"成为底线，要声音的人才主动点一下。
   */
  enabled?: boolean;

  /** 总音量 dB，默认 -6 */
  masterDb?: number;

  /** 环境音床 */
  ambient?: AmbientSpec;

  /** 转场音效 */
  transition?: TransitionSfxSpec;

  /** 滚动驱动 */
  motion?: MotionSpec;
}