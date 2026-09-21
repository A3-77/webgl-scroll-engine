/**
 * ★ Schema —— 媒介层契约（PHASE 25）
 * ===========================================================================
 * 一个媒介层 = 一份「这张画面是用什么材料做的」的声明。
 *
 * ---------------------------------------------------------------------------
 * 【为什么需要它 —— 它和 post 不是同一件事】
 *
 *   `site.post` 管的是**滤镜**：bloom、色差、颗粒、暗角。
 *   它们全部只读颜色缓冲，做的是「在已有像素上加一点东西」。
 *   八个效果叠满，画面依然是一张照片。
 *
 *   媒介层管的是**重绘**：把画面重新表达成另一种材料。
 *   网点（halftone）不是给照片加纹理，而是把连续调拆成"墨点的大小"；
 *   墨线（inkEdge）不是描边滤镜，而是用**深度和亮度的不连续**重新画一遍轮廓。
 *   做完之后画面不再是照片 —— 它是一张印刷品。
 *
 *   这不是我们发明的分类。两个参考站点走的是同一条路：
 *     ▸ iamsaeed.dev 的 `PrintEffect`：单色分级 → 注册网点 → 交叉排线
 *       → 墨线（对法线和深度做 Sobel）→ 纸纹 → 暗角
 *     ▸ shader.se 的 ASCII 背景：把视频按亮度量化成 0..99，
 *       再用这个数去索引一张 10×10 的字形图集，重绘成字符画
 *   两者的共同点是：**画面被换了一种材料，而不是被调了色**。
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么这里是一个平铺接口，而 post.ts 用可辨识联合】
 *
 *   因为两者是不同形状的东西。
 *
 *   post 是一串**互不认识的独立效果**：bloom 不知道有没有颗粒，
 *   颗粒也不关心 bloom 多强。所以用 `kind` 收窄的联合类型最合适 ——
 *   写错参数直接编译失败。
 *
 *   媒介层是一条**有固定顺序的管线**：
 *
 *       单色化 → 网点 → 有序抖动 → 墨线 → 纸纹 → 持续颗粒
 *
 *   顺序不能换（先描边再网点，墨线会被网点吃掉；先纸纹再描边，
 *   纸纹会被当成轮廓）。既然顺序是固定的，就不该让使用者去排列它们 ——
 *   平铺的强度旋钮反而更诚实：你调的是"这张纸有多少墨"，
 *   而不是"先做哪一步"。
 *
 *   这也是 iamsaeed.dev 的做法（他们的注释原话：`One effect,
 *   recipe-driven uniforms`）。所以这里跟着它走。
 *
 * ---------------------------------------------------------------------------
 * 【★ pulse —— 和 post 共用同一个活跃度】
 *
 *   每个旋钮都可以在末尾乘一个 `(1 + pulse × 活跃度)`，
 *   活跃度由引擎每帧算好（见 PostSystem 的 drive 参数），
 *   和 `site.post` 用的是**同一个公式、同一个速度源**。
 *   于是"切章时网点变粗"和"切章时色差炸开"是同一件事的两面，
 *   而不是两条各自跑着的轨道。
 *
 * ---------------------------------------------------------------------------
 * 【★ 零行为变更契约】
 *
 *   `enabled: false`（或不声明）时，引擎**一个 pass 都不跑**，
 *   画面与 PHASE 25 之前逐位相同。三个内置内容包里只有 cats 声明它，
 *   shopify / placeholder 完全不受影响。
 * ===========================================================================
 */

/* ------------------------------------------------------ 出厂预设 */

/**
 * 印刷（print）—— 最"通用"的媒介预设。
 *
 * 为什么拿它当默认值：网点 + 墨线 + 纸纹这套组合对**任何素材**都成立，
 * 不依赖素材本身有线条或色块。它是"把照片印出来"，不是"把照片变成漫画"。
 */
export const MEDIUM_PRINT: MediumConfig = {
  mono: 0.55,
  halftone: 0.6,
  halftoneScale: 5,
  halftoneAngle: 45,
  inkEdge: 0.5,
  inkThreshold: 0.06,
  paper: 0.35,
  paperColor: '#efe7d6',
  inkColor: '#1a1714',
  dither: 0,
  ditherLevels: 6,
  grain: 0.05,
  grainSpeed: 1,
  pulse: 0.35,
};

/* ------------------------------------------------------ 配置 */

export interface MediumConfig {
  /**
   * 总开关。false = 一个 pass 都不跑，画面与未声明时逐位相同。
   *
   * 关掉它的用途：看清场景的**原始渲染**。
   * 调构图 / 调颜色的时候必须关 —— 否则你分不清"猫是暗的"是素材暗
   * 还是网点把它印暗了。
   */
  enabled?: boolean;

  /* ---- ① 单色化 ---- */

  /**
   * 去色程度 0..1。0 = 原色，1 = 完全灰度。
   *
   * 印刷媒介的底子。但**不建议给到 1** —— 完全灰度会丢掉素材的色彩信息，
   * 而素材驱动的引擎不该替用户决定"这张图该是黑白还是彩色"。
   * 0.5 左右能保住色调，同时让网点读起来像"印刷"而不是"噪点"。
   */
  mono?: number;

  /* ---- ② 网点 ---- */

  /** 网点强度 0..1。0 = 不画网点 */
  halftone?: number;
  /**
   * 网点网格边长（CSS 像素）。**这是媒介层最重要的一个旋钮。**
   *
   *   2 ~ 4    细密，接近胶印，远看像颗粒
   *   5 ~ 8    看得见网点结构，典型的"报纸/丝网印"
   *   12 ~ 20  网点本身成为图形语言，接近波普艺术
   *
   * ★ 用**屏幕空间**的固定网格，不是 UV 网格 —— 后者会让网点随画面
   *   缩放而伸缩，看起来像"网点粘在图上"。真实印刷的网点是相对纸面固定的。
   */
  halftoneScale?: number;
  /**
   * 网点旋转角度（度）。
   *
   * 45° 是印刷业的标准角度：人眼对 0° / 90° 的规则网格最敏感，
   * 45° 最难看出网纹，也最不容易和素材自身的横竖结构打架。
   * 想制造明显的"印刷感"反而可以用 0 或 15。
   */
  halftoneAngle?: number;

  /* ---- ③ 有序抖动 ---- */

  /**
   * 有序抖动（Bayer 4×4）强度 0..1。
   *
   * 和网点的区别：网点是**空间**上的调制（点的面积随明暗变），
   * 抖动是**数值**上的调制（把连续灰阶砍成几级，用棋盘图案骗眼睛）。
   * 抖动更"数字"、更硬，网点更"印刷"、更柔。两者可以叠加。
   */
  dither?: number;
  /** 抖动后的色阶数。6 左右开始明显，3 以下就是纯海报风 */
  ditherLevels?: number;

  /* ---- ④ 墨线 ---- */

  /**
   * 墨线强度 0..1。
   *
   * ★ 这是媒介层里**唯一需要几何缓冲**的一项。
   *   它同时看两个东西：
   *     ▸ 深度不连续 —— 物体和背景的交界（这是滤镜永远拿不到的）
   *     ▸ 亮度梯度   —— 物体内部的纹理轮廓
   *   只用亮度梯度的话，背景的云、水波都会被描成线；
   *   加上深度之后，只有真正"立着的东西"才会被勾边。
   */
  inkEdge?: number;
  /**
   * 墨线灵敏度。深度差超过它才算一条边。
   *
   * 太小 → 整个画面爬满细线（连地面法线的抖动都被描出来）
   * 太大 → 只有最近处的物体有边
   * 0.05 ~ 0.15 是安全区（单位是线性化之后的深度差，不是原始深度值）
   */
  inkThreshold?: number;

  /* ---- ⑤ 纸 ---- */

  /** 纸纹强度 0..1。程序化生成，不需要素材 */
  paper?: number;
  /** 纸色。它同时被用作网点的"空白处"颜色和墨线的反衬 */
  paperColor?: string;
  /** 墨色。网点实心处和墨线的颜色 */
  inkColor?: string;

  /* ---- ⑥ 持续颗粒 ---- */

  /**
   * 持续颗粒强度 0..1。
   *
   * ★ 和 `site.post` 里的 `noise` 是两回事，别混用：
   *   ▸ post 的 noise 强度跟着**滚动**走（pulse），停下滚动就没了
   *   ▸ 这里的 grain 由**墙上时钟**驱动，停下滚动它依然在跳
   *
   *   这就是为什么两个站点的画面"看起来是活的"——
   *   滚动和时间是两个独立的驱动源，缺一个画面就会在静止时"冻住"。
   */
  grain?: number;
  /** 颗粒的跳动速度。1 = 每秒重掷一次，0.3 = 缓慢流动 */
  grainSpeed?: number;

  /* ---- 脉动 ---- */

  /**
   * 滚动脉冲强度 0..1。实际强度 = 基准 × (1 + pulse × 活跃度)。
   * 与 `site.post` 的 pulse 吃同一个活跃度，所以两边严格同步。
   */
  pulse?: number;
}

/* ------------------------------------------------------ 归一化 */

/** 一个媒介层旋钮的生效值（pulse 已展开） */
export interface ResolvedMedium {
  mono: number;
  halftone: number;
  halftoneScale: number;
  halftoneAngle: number;
  dither: number;
  ditherLevels: number;
  inkEdge: number;
  inkThreshold: number;
  paper: number;
  paperColor: string;
  inkColor: string;
  grain: number;
  grainSpeed: number;
}

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

/**
 * 把声明 + 活跃度展开成实际的 uniform 值。
 *
 * ★ 这是媒介层**唯一**的求值点，和 `tracksOf` / `expandPreset` 是同一个思路：
 *   旋钮的默认值和钳制只在这里发生一次。散落到 MediumSystem 里
 *   逐项写 `?? 0`，就会出现"某个旋钮忘了钳制，pulse 一开直接爆掉"。
 *
 * @param config 内容包声明
 * @param activity 活跃度 0..1（0 = 静止）
 */
export function resolveMedium(config: MediumConfig, activity = 0): ResolvedMedium {
  const p = 1 + clamp01(config.pulse ?? 0) * clamp01(activity);
  const scale = (v: number | undefined, d: number): number => (v ?? d) * p;

  return {
    // 单色化和纸色不参与脉动 —— 它们是"材料本身"，
    // 让纸的底色随滚动变来变去会读成"曝光在抖"，而不是"印刷在呼吸"
    mono: clamp01(config.mono ?? 0),
    paperColor: config.paperColor ?? '#efe7d6',
    inkColor: config.inkColor ?? '#1a1714',
    inkThreshold: config.inkThreshold ?? 0.06,
    halftoneScale: Math.max(1, config.halftoneScale ?? 5),
    ditherLevels: Math.max(2, config.ditherLevels ?? 6),
    grainSpeed: config.grainSpeed ?? 1,

    halftone: clamp01(scale(config.halftone, 0)),
    dither: clamp01(scale(config.dither, 0)),
    inkEdge: clamp01(scale(config.inkEdge, 0)),
    paper: clamp01(scale(config.paper, 0)),
    grain: clamp01(scale(config.grain, 0)),
    halftoneAngle: config.halftoneAngle ?? 45,
  };
}
