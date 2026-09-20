/**
 * ★ 自动构图 —— manifest → SceneConfig
 * ===========================================================================
 * 这是"素材驱动"真正落地的地方：**没有人写场景配置**。
 *
 *   图片 → build-assets → content.json → 本文件 → SceneConfig[] → 引擎
 *
 * 加一张新图，只需要把它丢进 input/ 再跑一次 build-assets —— TS 一行不用改。
 * 这就是验收 7（替换图片不改核心代码）与验收 8（新增 Scene03 不用重写引擎）。
 *
 * ===========================================================================
 * 【构图数学 —— 先把两个关键性质说清楚，否则下面的代码看不懂】
 *
 * 性质一：`offset` **就是屏幕归一化坐标**，且与 z 无关。
 *
 *   SceneBuilder 里 baseX = offset[0] × visibleH(z) × aspect、baseY = offset[1] × visibleH(z)，
 *   而屏幕在该深度处的可见宽高正好是 visibleH×aspect 与 visibleH。
 *   两边一除：
 *      屏幕横坐标（−0.5..0.5）= offset[0]
 *      屏幕纵坐标（−0.5..0.5）= offset[1]   （正值朝上）
 *   visibleH(z) 被约掉了 —— 所以同一个 offset 在 z=−30 和 z=−14 上
 *   落在**同一个屏幕位置**。这意味着"按原图位置摆放"和"拉开 z 做视差"
 *   是两件互不干扰的事。
 *
 * 性质二：`overscan` 可以精确补偿透视缩放，所以拉开 z **不会改变视觉大小**。
 *
 *   contain 模式下平面先"完整放入视口"，再整体乘 overscan。
 *   而 visibleH(z) 随 z 增大（越近越大），所以同样 overscan 的平面
 *   在世界里更大、但投影后屏幕尺寸不变。
 *   → z 只影响**视差强度**，不影响构图。这正是我们想要的：
 *     想要纵深就拉开 z，画面不会跟着变。
 *
 * ===========================================================================
 * 【源图 → 屏幕 的映射】
 *
 * 背景用 cover 铺满视口，于是源图会被**居中裁切**。设：
 *     srcAspect = 源图宽高比，vpAspect = 视口宽高比
 *     fX = max(1, srcAspect / vpAspect)   —— 横向铺满倍数（源图更宽时被裁）
 *     fY = max(1, vpAspect / srcAspect)   —— 纵向铺满倍数（源图更高时被裁）
 *
 * 则源图归一化坐标 (cx, cy)（y 向下）落到屏幕上：
 *     sx = (cx − 0.5) × fX
 *     sy = (0.5 − cy) × fY
 *
 * 主体尺寸同理：屏幕高度占比 = box.h × fY，屏幕宽度占比 = box.w × fX。
 * ===========================================================================
 * 【相机的朝向 —— 这里踩过一次，值得写下来】
 *
 *   three 的相机默认看向 **−z**。所以：
 *     相机 z 变大  → 离物体更远  → 画面缩小（后退）
 *     相机 z 变小  → 离物体更近  → 画面放大（推进）
 *
 *   第一版把 `dolly` 写成 `+4`（从 0 走到 +4），而所有物体都在 −30..−15 ——
 *   结果是**相机在后退**，越滚越远。而且因为"距离变大"，主体反而是缩小的，
 *   完全没有"推进感"。这个 bug 不会报错，只会让人觉得"效果很平"。
 *
 *   现在 `dolly` 约定为**负值 = 前进**，并且相机初始 z 必须大于所有物体的 z
 *   （否则相机在物体背后，什么都看不见）。
 * ===========================================================================
 * 【深度是反解出来的，不是盲分的】
 *
 *   一个主体被放大多少倍，只取决于「它到相机的距离」和「相机走了多远」：
 *
 *       zoom(d) = d / (d + dolly)          （dolly < 0 ⇒ zoom > 1）
 *
 *   d 是初始距离。想让某个主体在推进过程中放大不超过 maxScreenH / screenH，
 *   就把 d 解出来：
 *
 *       screenH × zoom(d) ≤ maxScreenH
 *       ⇒ d ≥ maxScreenH × dolly / (screenH − maxScreenH)
 *
 *   ★ 这条约束正好实现了"**大主体自动放远**"：
 *     屏幕占比 85% 的猫解出 d≈32（放大 1.23 倍，收尾时刚好占满一屏），
 *     屏幕占比 62% 的猫可以放在 d≈20（放大 1.43 倍，有明显的冲出感）。
 *     换句话说 —— **越小的东西动得越狠**，纵深层次就是这么出来的。
 * ===========================================================================
 */

import type {
  AssetRegistry,
  CameraConfig,
  ContentManifest,
  SceneConfig,
  SceneManifest,
  SceneObjectConfig,
  SubjectManifest,
  Track,
} from '../schema';
import { expandPreset } from '../animation/presets';

/* ------------------------------------------------------------ 选项 */

export interface ComposeOptions {
  /** 运行时视口宽高比（宽 / 高）。offset 与 overscan 的换算依赖它 */
  aspect: number;

  /** 每个 DOM 章节的高度（vh 倍数）。越大滚得越久、动画越从容 */
  heightVh?: number;

  /**
   * 相机初始 z。**必须大于所有物体的 z**，否则相机在物体背后。
   * 它同时是"世界尺度"的锚点 —— 物体距离都由它减去 d 得到。
   */
  cameraZ?: number;
  /** 垂直视野角（度） */
  fov?: number;
  /**
   * 相机沿 z 的推进量。**负值 = 朝 −z 前进**（three 的相机默认看向 −z）。
   * 0 = 相机不前后动，那就只剩横向视差，"空间感"会弱很多。
   */
  dolly?: number;
  /** 相机沿 y 的行程半幅（世界单位）。相机从 −camY 走到 +camY */
  camY?: number;

  /**
   * 主体到相机的距离区间 [最近, 最远]。
   *
   * ★ 这是"纵深感"的总旋钮：
   *     太窄（[24,28]）→ 所有主体挤在一层，看起来是平的
   *     太宽（[14,60]）→ 近的冲出画面、远的完全不动
   *   注意这里填的是**距离**不是 z —— z 由 `cameraZ − d` 算出，
   *   所以改 cameraZ 不会连带改掉构图，两者是解耦的。
   */
  dist?: [number, number];

  /** 背景到相机的距离。比 dist[1] 更远 */
  bgDist?: number;

  /**
   * 推进结束时，一个主体允许占到的**屏幕高度上限**（1 = 满屏）。
   *
   * 为什么允许 > 1：主体轻微出界（耳朵、脚）在视觉上很自然，
   * 而且留一点余量能让大主体也保留视差。设成 1.0 会让 85% 高的猫
   * 被推到很远处，视差几乎归零。
   */
  maxScreenH?: number;

  /**
   * 主体在**初始构图**下允许占到的屏幕高度上限（1 = 满屏）。
   *
   * 存在的理由：背景用 cover 铺满视口，而 cover 在"视口比源图宽"时
   * 会把源图纵向放大 —— 主体跟着放大。源图 3:2 配 21:9 视口时，
   * 纵向放大 1.55 倍，一张占源图 72% 高的猫会变成占屏幕 112%，整个出界。
   *
   * ★ 只钳制尺寸、不钳制位置：中心点仍与背景对齐，所以主体"还在原处"，
   *   只是收进屏幕内。见 composeSubject 里的详细说明。
   *
   * 默认 0.92 —— 留 8% 余量，让主体的耳朵/尾巴不至于贴着屏幕边缘。
   */
  maxSubjectH?: number;

  /** 每个场景的 DOM 文案覆盖 */
  copy?: Record<string, { eyebrow?: string; title?: string; body?: string }>;
}

const DEFAULTS = {
  heightVh: 2.0,
  cameraZ: 6,
  fov: 32,
  // ★ 负值 = 前进。见文件头"相机的朝向"
  dolly: -6,
  camY: 1.2,
  dist: [20, 34] as [number, number],
  bgDist: 40,
  maxScreenH: 1.05,
  maxSubjectH: 0.92,
} as const;

/* ------------------------------------------------------------ 小工具 */

/**
 * 某个距离处「视口在世界空间的高度」。
 *
 * 这是引擎里所有位移数值的单位（轨道值 1.0 = 一个视口高）。
 * 引擎侧的同名函数在 `SceneBuilder.visibleHeightAt`，那边用的是
 * `|camera.z − z|`；这里用的是纯距离 d，两者等价（z = cameraZ − d）。
 */
function visibleHAt(dist: number, fovDeg: number): number {
  return 2 * Math.tan((fovDeg * Math.PI) / 180 / 2) * dist;
}

/**
 * 主体动效分配。
 *
 * 为什么不是"所有主体用同一个预设"：
 *   5 只猫同步上下浮动会像一整块板在动，非常假。
 *   轮换预设 + 交错强度，就能让它们看起来各自独立（验收 4）。
 *
 * 为什么用固定序列而不是随机：
 *   同样的素材每次构建应该得到同样的结果。随机会让"这次看起来比上次好"
 *   变成无法复现的玄学。
 */
const MOTION_CYCLE = ['float', 'sway', 'orbit', 'drift', 'float'] as const;

/**
 * 黄金比序列 —— 用确定性方式把 N 个主体散布在深度区间上。
 *
 * 为什么不用 `i / (n−1)` 这种线性分布：
 *   线性分布会让深度随位置单调变化，5 只猫看起来像斜着一堵墙。
 *   黄金比（0.618）能保证任意 N 下都散布得比较均匀且不成规律。
 */
function goldenSpread(i: number): number {
  const g = 0.6180339887498949;
  return (i * g) % 1;
}

/** 从背景色推一个可读的前景色（DOM 文字用） */
function readableInk(rgb: number[] | undefined): string {
  if (!rgb || rgb.length < 3) return '#1c1b19';
  const [r, g, b] = rgb;
  // 相对亮度（sRGB 近似）。0.55 是"浅底用深字"的经验分界
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#1c1b19' : '#f5f4f2';
}

function cssRgb(rgb: number[] | undefined, fallback: string): string {
  if (!rgb || rgb.length < 3) return fallback;
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/**
 * 算一个 contain 平面为了达到「屏幕高度占比 = screenH」所需的 overscan。
 *
 * 推导：contain 先得到「完整放入视口」的高度
 *         ta ≤ vpAspect → 高度 = 视口高（贴满高度，宽度有余）
 *         ta >  vpAspect → 高度 = 视口宽 / ta（贴满宽度，高度有余）
 *       overscan 是等比缩放，所以 overscan = 目标高度 / contain 高度。
 */
function overscanFor(screenH: number, texAspect: number, vpAspect: number): number {
  if (texAspect <= vpAspect) return screenH;
  return (screenH * texAspect) / vpAspect;
}

/** 轨道数组的路径去重检查 —— 同一路径两条轨道会互相覆盖，是静默 bug */
function assertNoPathCollision(id: string, tracks: Track[]): Track[] {
  const seen = new Set<string>();
  for (const t of tracks) {
    if (seen.has(t.path)) {
      console.warn(
        `[compose] 对象 "${id}" 的动画里出现重复属性路径 "${t.path}"，` +
          `后一条会覆盖前一条。检查预设组合。`,
      );
    }
    seen.add(t.path);
  }
  return tracks;
}

/* ------------------------------------------------------------ 主体 → 对象 */

function composeSubject(
  scene: SceneManifest,
  subject: SubjectManifest,
  index: number,
  sceneIndex: number,
  ctx: SubjectContext,
): SceneObjectConfig {
  const { aspect: vpAspect, cameraZ, dolly, dist, bgDist, maxScreenH, maxSubjectH } = ctx;
  const srcAspect = scene.source.aspect;

  // 源图 → 屏幕 的铺满倍数（见文件头推导）
  const fX = Math.max(1, srcAspect / vpAspect);
  const fY = Math.max(1, vpAspect / srcAspect);

  // ---- 屏幕位置 ----
  // ★ 这里算的是「按背景的 cover 裁切后」的屏幕坐标，
  //   所以主体的**中心**永远落在背景上原本属于它的位置。
  const sx = (subject.center.x - 0.5) * fX;
  const sy = (0.5 - subject.center.y) * fY;

  // ---- 屏幕尺寸 ----
  // cover 在"视口比源图宽"时会把源图纵向放大（fY > 1），主体跟着变大。
  // 极端情况（超宽屏 + 源图里主体本来就高）会让主体整个冲出画面。
  //
  // ★ 只钳制**尺寸**、不钳制**位置** —— 这一点是有意的：
  //   中心点与背景对齐，所以主体看起来还"长在原处"；
  //   而尺寸收回屏幕内，保证主体完整可见。
  //   代价是主体的屏幕尺寸比"原图里的比例"略小，但：
  //     ▸ 背景在 build-assets 阶段已经把主体区域**填充掉了**，
  //       背景上不存在"猫的轮廓"等着被对齐；
  //     ▸ 主体 PNG 自带接触阴影，阴影跟着一起缩放，不会脱节。
  //   所以这个代价实际上是零。
  const rawScreenH = subject.box.h * fY;
  let screenH = Math.min(rawScreenH, maxSubjectH);

  // ---- 深度：黄金比散布 + 大主体自动放远（见文件头推导）----
  let d = dist[0] + (dist[1] - dist[0]) * goldenSpread(index);

  // 推进结束时放大不超过 maxScreenH / screenH
  //   screenH × d/(d+dolly) ≤ maxScreenH  ⇒  d ≥ maxScreenH·dolly / (screenH − maxScreenH)
  if (screenH < maxScreenH) {
    const dSafe = (maxScreenH * dolly) / (screenH - maxScreenH);
    if (dSafe > d) d = dSafe;
  }
  // 不能跑到背景后面 —— 那样它会比背景还远，纵深关系就颠倒了
  d = Math.min(d, bgDist - 2);

  // ★ 深度定下来之后，再用**实际的 d** 反算一次尺寸上限。
  //
  //   上面那条 `dSafe` 只在 d 没被 `bgDist - 2` 钳制时才有效。
  //   反例：一个占屏 92% 的大主体，要保证推进后不超过 1.05 屏高需要 d ≈ 48，
  //   而 `bgDist - 2` 只给到 38 —— 于是它照样出界，实测 0.92 × 38/32 = 1.0925。
  //
  //   这里补一刀：深度已经被背景位置钉死了，那就**反过来收尺寸**，
  //   让 `screenH × zoom ≤ maxScreenH` 成为不变量。
  //   单测 `相机推进结束时主体不超过 maxScreenH` 就是锁这条的。
  const zoom = d / (d + dolly);
  screenH = Math.min(screenH, maxScreenH / zoom);

  const z = cameraZ - d;

  // ---- 动效：入场 + 持续运动 + 呼吸 ----
  // ★ 三者必须动**不同的属性路径**。求值器按 path 覆盖，
  //   如果入场也用 position.y，它就会把持续运动的 position.y 顶掉。
  //
  // ★ 首屏（sceneIndex 0）**不做淡入**。
  //   原因：首屏的 t=0 就是"页面刚打开、还没滚动"的状态，
  //   而 fadeIn 在 t=0 时 opacity 恰好是 0 —— 于是打开页面看到的是一片空背景，
  //   用户会以为坏了。实测踩过：首屏截图里只有背景，5 只猫全是透明的。
  //   非首屏才需要淡入，因为它们是"滚进来的"。
  const primary = MOTION_CYCLE[index % MOTION_CYCLE.length];
  const intensity = 0.75 + 0.25 * ((index * 7) % 3) / 2; // 0.75 / 0.875 / 1.0

  const tracks = assertNoPathCollision(subject.id, [
    ...(sceneIndex === 0 ? [] : expandPreset({ preset: 'fadeIn', range: [0, 0.18] })),
    ...expandPreset({ preset: primary, intensity, range: [0.05, 1] }),
    ...expandPreset({ preset: 'breathe', intensity: 0.6 * intensity, range: [0, 1] }),
  ]);

  return {
    id: subject.id,
    role: 'subject',
    asset: subjectAssetKey(scene.id, subject.id),
    type: 'plane',
    fit: 'contain',
    // ★ 用 overscan 把"原图里的相对大小"还原到屏幕上 —— 见 overscanFor 的推导。
    //   它与 z 无关，所以"拉开深度"和"保持构图"是两件互不干扰的事。
    overscan: overscanFor(screenH, subject.aspect, vpAspect),
    z,
    offset: [sx, sy],
    // 主体是抠出来的透明 PNG，必须透明；且不能标 opaque，
    // 否则会和背景一起落进不透明渲染列表，renderOrder 就管不住前后了
    opaque: false,
    // 1 = 完全由 z 深度自然产生视差。不额外放大，避免"运动过头"
    parallax: 1,
    animation: { tracks },
  };
}

/** composeSubject / composeBackground / composeCamera 共用的上下文（全部选项已填默认值） */
interface SubjectContext {
  aspect: number;
  cameraZ: number;
  fov: number;
  dolly: number;
  camY: number;
  dist: [number, number];
  bgDist: number;
  maxScreenH: number;
  maxSubjectH: number;
}

/* ------------------------------------------------------------ 背景 → 对象 */

function composeBackground(
  scene: SceneManifest,
  ctx: SubjectContext,
): SceneObjectConfig {
  const { cameraZ, fov, camY, bgDist } = ctx;
  const z = cameraZ - bgDist;

  // ★ overscan 必须覆盖相机的横向摆动，否则背景边缘会露出来。
  //   条件：背景半高 ≥ 视口半高 + |camY|
  //         visibleH·os/2 ≥ visibleH/2 + |camY|
  //     ⇒   os ≥ 1 + 2|camY| / visibleH
  //   再留 3% 余量给浮点误差和"相机 y 与 z 同时变化"的耦合项。
  //
  //   只按**初始距离**算就够了：相机推进后距离变小、背景相对视口更大，
  //   余量只会更宽（推进 6 个单位，余量从 os−1 涨到 os·1.18−1）。
  const overscan = 1 + (2 * Math.abs(camY)) / visibleHAt(bgDist, fov) + 0.03;

  return {
    id: 'bg',
    // ★ 显式声明角色，而不是让消费方去猜 "id 是不是 'bg'"。
    //   见 schema/object.ts 的 role 注释。
    role: 'background',
    asset: backgroundAssetKey(scene.id),
    type: 'plane',
    fit: 'cover',
    overscan,
    z,
    offset: [0, 0],
    // ★ 满幅背景必须标 opaque。
    //   否则它会落进透明渲染列表，而透明列表在**不透明列表之后**绘制 ——
    //   背景会盖住所有主体（详见 schema/object.ts 的 opaque 注释）。
    opaque: true,
    // 0 = 背景的运动只来自相机透视，不来自轨道。
    //   这正是我们想要的：背景越"稳"，前景的视差越明显。
    parallax: 0,
    animation: { tracks: [] },
  };
}

/* ------------------------------------------------------------ 相机 */

function composeCamera(
  index: number,
  opts: SubjectContext,
): CameraConfig {
  const { cameraZ, fov, dolly, camY } = opts;
  // 相邻章节方向交替（0/2/4 一组，1/3/5 一组）——
  // 每章都用同一套运镜会让人明显感到"又是这个动作"。
  const dir = index % 2 === 0 ? 1 : -1;

  const tracks: Track[] = [
    {
      // ★ 推进：z 变小 = 离物体更近。dolly 是负值，见文件头"相机的朝向"
      path: 'position.z',
      keyframes: [
        { t: 0, value: cameraZ, ease: 'easeInOut' },
        { t: 1, value: cameraZ + dolly, ease: 'easeInOut' },
      ],
    },
    {
      // 上下平移 —— 这是**横向视差**的来源：
      // 相机在 y 上移动 Y，屏幕位移 ∝ Y / 距离，
      // 所以近处的主体比背景移动得多，层次感是几何给的。
      path: 'position.y',
      keyframes: [
        { t: 0, value: -camY * dir, ease: 'easeInOut' },
        { t: 1, value: camY * dir, ease: 'easeInOut' },
      ],
    },
    {
      // 极轻微的滚转 —— 超过 0.02 弧度就会让人觉得"画面歪了"
      path: 'rotation.z',
      keyframes: [
        { t: 0, value: 0.012 * dir, ease: 'easeInOut' },
        { t: 1, value: -0.012 * dir, ease: 'easeInOut' },
      ],
    },
  ];

  return { z: cameraZ, fov, tracks };
}

/* ------------------------------------------------------------ 场景 */

export interface ComposedContent {
  assets: AssetRegistry;
  scenes: SceneConfig[];
}

export function backgroundAssetKey(sceneId: string): string {
  return `bg-${sceneId}`;
}

export function subjectAssetKey(sceneId: string, subjectId: string): string {
  return `${sceneId}-${subjectId}`;
}

/**
 * 把 manifest 组装成引擎能直接吃的 { assets, scenes }。
 *
 * 纯函数：给定同样的 manifest + aspect，永远得到同样的结果。
 * 没有任何 IO，也没有任何隐藏状态 —— 方便单测与排查。
 */
export function composeContent(
  manifest: ContentManifest,
  options: ComposeOptions,
): ComposedContent {
  const o = { ...DEFAULTS, ...options };
  const assets: AssetRegistry = {};
  const scenes: SceneConfig[] = [];

  const subjectCtx: SubjectContext = {
    aspect: o.aspect,
    cameraZ: o.cameraZ,
    fov: o.fov,
    dolly: o.dolly,
    camY: o.camY,
    dist: o.dist,
    bgDist: o.bgDist,
    maxScreenH: o.maxScreenH,
    maxSubjectH: o.maxSubjectH,
  };

  manifest.scenes.forEach((scene, index) => {
    // ---- 资产注册 ----
    assets[backgroundAssetKey(scene.id)] = { path: scene.background, kind: 'image' };
    for (const s of scene.subjects) {
      assets[subjectAssetKey(scene.id, s.id)] = { path: s.path, kind: 'image' };
    }

    const ink = readableInk(scene.backgroundColor);
    const canvasBg = cssRgb(scene.backgroundColor, '#111111');
    const copy = options.copy?.[scene.id] ?? {};

    // ---- 对象：背景在最底，主体按 manifest 顺序（已是面积降序）----
    // renderOrder 由数组下标决定，所以顺序就是覆盖顺序：
    // 背景 → 最大的主体 → … → 最小的主体
    const objects: SceneObjectConfig[] = [
      composeBackground(scene, subjectCtx),
      ...scene.subjects.map((s, i) => composeSubject(scene, s, i, index, subjectCtx)),
    ];

    scenes.push({
      id: scene.id,
      handle: scene.id,
      index,
      eyebrow: copy.eyebrow ?? `SCENE ${String(index + 1).padStart(2, '0')}`,
      title: copy.title ?? `场景 ${index + 1}`,
      body: copy.body ?? '',

      accent: ink,
      background: canvasBg,

      heightVh: o.heightVh,
      // 复刻原站的规则：第 3 章起下一章提前 20% 视口高度参与溶解
      earlyCrossfade: index >= 2 ? 0.2 : 0,

      transition: {
        // 首屏用圆形径向溶解（更有"开幕"感），其余用斜向擦除
        mode: index === 0 ? 'radial' : 'sweep',
        // 溶解圆心放在背景平面上 —— 它会经 uProjectionView 投影到屏幕空间
        fadeCenter: [0, 0, o.cameraZ - o.bgDist],
      },
      camera: composeCamera(index, subjectCtx),
      objects,
    });
  });

  return { assets, scenes };
}
