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
  CameraMoveKind,
  ContentManifest,
  SceneConfig,
  SceneManifest,
  SceneObjectConfig,
  SubjectManifest,
  Track,
} from '../schema';
import { cameraHasTarget, cameraTracksOf } from '../schema';
import { evaluateTracks } from '../animation/timeline';
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

  /**
   * 背景平面允许的**最大 overscan**（PHASE 26）。
   *
   * 为什么需要这个预算：相机一旦真的开始"绕主体转 / 甩镜头"，可见区域
   * 会横向大幅平移，背景平面必须比视口更大才不露边 —— 而 overscan 是
   * **等比放大**，放得越大背景越糊。
   *
   * 所以构图的做法是：先按满幅度算一次，量出需要多大的 overscan；
   * 超预算就把**运镜幅度**压回来，而不是无限放大背景。
   * 见 `overscanForCamera` 与 `composeCamera`。
   *
   * 1.45 的含义：背景最多被放大 45%。对一张 2048 宽的源图来说，
   * 在 1920 视口上仍然够清晰。
   */
  bgOverscanMax?: number;

  /**
   * ★ 相机"看向主体"的程度（PHASE 26）：`look = 轴线 + lookBlend × (主体 − 轴线)`。
   *
   *   `1.0` = 死盯主体，主体永远在画面正中央。
   *   `0.0` = 完全不转，构图和原照片一模一样 —— 但相机也就不会"看"了，
   *           `orbit` / `whip` 会退化成"平移一张图"。
   *   `0.45` = 默认。主体留在三分线附近。
   *
   * ---------------------------------------------------------------------------
   * 【为什么默认不是 1.0】
   *
   *   两个理由，一个美学、一个几何：
   *
   *   ① 美学：把主体摆到正中央会丢掉原照片的取景。主体偏一点反而更好看。
   *
   *   ② 几何（更硬的理由）：相机一转头，**平坦的背景板**就得跟着变大
   *      才不露边，而且这个需求和运镜幅度**无关** ——
   *      实测 cats 内容在 aspect 2.234 下，主体偏轴 8° 时
   *      静态构图就需要 overscan **1.52**，超出 1.45 的预算。
   *      预算回路只能把 intensity 压到 0（画面一动不动），背景照样不够大。
   *
   *      lookBlend = 0.45 → 需求 1.52 降到 1.19，运镜才真的有幅度可用。
   */
  lookBlend?: number;

  /** 每个场景的 DOM 文案覆盖 */
  copy?: Record<string, { eyebrow?: string; title?: string; body?: string }>;
}

const DEFAULTS = {
  heightVh: 2.0,
  cameraZ: 6,
  fov: 32,
  // ★ 负值 = 前进。见文件头"相机的朝向"。
  //   它同时是**推近预算** —— 运镜能推多近由它决定（见 CameraMoveSpec.approach）
  dolly: -6,
  camY: 1.2,
  dist: [20, 34] as [number, number],
  bgDist: 40,
  maxScreenH: 1.05,
  maxSubjectH: 0.92,
  bgOverscanMax: 1.45,
  lookBlend: 0.45,
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
 * ★ 相机运镜分配（PHASE 26）。
 *
 * 改造前每章都是同一套动作（`position.z` 推进 + `position.y` 上下平移
 * + 微滚转），只把方向符号交替 —— `composeCamera` 自己的注释就承认了
 * "每章都用同一套运镜会让人明显感到'又是这个动作'"。
 *
 * 现在按顺序给每章一种**不同的镜头语言**，让翻页读起来像"剪辑"：
 *
 *   0 dolly  推近 —— 从"看全景"进入"看这个"。经典的开场镜头。
 *   1 orbit  绕行 —— 分层纵深最出效果的一种。**放在第 2 位是刻意的**：
 *            只有两章的内容（最小可用素材集）也能拿到"推进 + 绕行"这对
 *            表现力最强的组合，而不是"推进 + 又一个推进"。
 *   2 rise   升起俯视 —— 视角一换，观众会重新读一遍画面。
 *   3 hold   不动 —— 情绪落下来的一拍，让观众自己看。**必须排在后面**：
 *            它是"减法"，前面得有东西可减。
 *   4 crash  冲向主体 —— 情绪最重的一章给它。
 *   5 whip   甩镜头 —— 收尾时把镜头甩出去，接下一轮。
 *
 * 固定序列、不随机：同样的素材每次构建结果一致（同 MOTION_CYCLE 的理由）。
 */
const MOVE_CYCLE: readonly CameraMoveKind[] = [
  'dolly',
  'orbit',
  'rise',
  'hold',
  'crash',
  'whip',
];

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
  /**
   * ★ 主体的**世界坐标质心**（PHASE 26）—— 运镜的"看向哪"。
   *
   * 为什么必须是真的世界坐标而不是原点：`orbit` 是**绕主体转**，
   * 如果看向原点而主体在别处，绕行就变成了"绕着空气转" ——
   * 主体会在画面里画圈，正是要避免的那种"平移感"。
   *
   * 由 `subjectCentroid` 从已经摆好的主体对象反推（offset + z → 世界坐标），
   * 所以不存在"两套摆放数学"对不上的风险。
   */
  subjectWorld: [number, number, number];
  /**
   * ★ 相机**看向哪**（PHASE 26）—— 轴线与主体之间的折中点。
   * 见 ComposeOptions.lookBlend 的推导。
   */
  cameraLook: [number, number, number];
  /** 背景 overscan 的预算上限，见 ComposeOptions.bgOverscanMax */
  bgOverscanMax: number;
}

/* ------------------------------------------------------------ 背景 → 对象 */

/**
 * 屏幕四角（NDC）。
 * 背景要"不露边"，等价于这四角射线打在背景平面上的落点都落在平面内。
 */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * ★ 数值扫描整段运镜，算出背景平面**至少**需要多大的 overscan 才不露边。
 *
 * ---------------------------------------------------------------------------
 * 【为什么不再用闭式公式】
 *
 *   改造前的公式是 `1 + 2|camY| / visibleH + 0.03`，推导干净，但它只覆盖
 *   **相机沿 y 平移**这一种情况（因为那时相机只会平移）。
 *
 *   PHASE 26 之后相机有了 `target`，会**转动**：`orbit` 绕着主体转、
 *   `whip` 把视线甩出去。转动对"背景露不露边"的影响比平移大得多 ——
 *   相机绕着主体转 9°，背景平面（在主体后面 13 个单位）会被推出
 *   `k·tan9° ≈ 2.1` 个世界单位，而纯平移只会推出 `d·sin9°`。
 *   手推这个闭式公式要分运镜种类、分轴、还要处理 lookAt 的基向量，
 *   改一个运镜就得重推一遍 —— 很容易推错，而且错了只表现为"边缘露出一条"。
 *
 *   所以改成**直接量**：按 t 采样相机位姿（位置 + 朝向），把屏幕四角
 *   反投影到背景平面上，取最大超出量。任何新运镜都自动正确。
 *
 * ---------------------------------------------------------------------------
 * 【它同时管"lookAt 的基向量"和"roll"】
 *
 *   朝向按 three 的 `lookAt` 规则构造：相机 −z 指向目标，
 *   `x = normalize(up × z)`、`y = z × x`（up = 世界 +y）。
 *   相机空间里的角点方向是 `(nx·tanHalf·aspect, ny·tanHalf, −1)`；
 *   `CameraSystem` 在 lookAt 之后还会 `rotateZ(roll)`，所以在相机空间里
 *   把 (dx, dy) 反向转 −roll 即可（roll ≤ 0.03 rad，但它对角落的影响
 *   约等于 `roll × halfW/halfH` ≈ 6%，不能忽略）。
 */
export function overscanForCamera(
  camera: CameraConfig,
  bgZ: number,
  aspect: number,
  samples = 32,
): number {
  const tracks = cameraTracksOf(camera);
  const hasTarget = cameraHasTarget(camera);
  const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2);
  // overscan = 1 时，cover 平面正好铺满视口 → 半宽半高就是视口的半宽半高
  const halfH = visibleHAt(Math.abs(camera.z - bgZ), camera.fov) / 2;
  const halfW = halfH * aspect;

  const out: Record<string, number> = {};
  let need = 1;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    evaluateTracks(tracks, t, out);

    const cx = out['position.x'] ?? 0;
    const cy = out['position.y'] ?? 0;
    const cz = out['position.z'] ?? camera.z;

    // 相机基向量（three 的 lookAt 让 −z 指向目标 ⇒ z 轴 = 相机 − 目标）
    let zx: number;
    let zy: number;
    let zz: number;
    if (hasTarget) {
      zx = cx - (out['target.x'] ?? camera.target?.[0] ?? 0);
      zy = cy - (out['target.y'] ?? camera.target?.[1] ?? 0);
      zz = cz - (out['target.z'] ?? camera.target?.[2] ?? 0);
    } else {
      // 不声明 target = 永远朝 −z 看（原分支）
      zx = 0;
      zy = 0;
      zz = 1;
    }
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl;
    zy /= zl;
    zz /= zl;

    // x = normalize(up × z)，up = (0,1,0) ⇒ (zz, 0, −zx)
    let xx = zz;
    let xz = -zx;
    const xl = Math.hypot(xx, xz);
    if (xl < 1e-6) {
      // 相机几乎垂直朝上/下看 —— 退化取一个任意正交基
      xx = 1;
      xz = 0;
    } else {
      xx /= xl;
      xz /= xl;
    }
    // y = z × x
    const yx = zy * xz - zz * 0;
    const yy = zz * xx - zx * xz;
    const yz = zx * 0 - zy * xx;

    const roll = out['rotation.z'] ?? 0;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);

    for (const [nx, ny] of CORNERS) {
      let dx = nx * tanHalf * aspect;
      let dy = ny * tanHalf;
      // rotateZ(roll) 之后，相机空间里角的坐标反向转了 −roll
      const rx = dx * cr - dy * sr;
      const ry = dx * sr + dy * cr;
      dx = rx;
      dy = ry;
      const dz = -1;

      const wx = xx * dx + yx * dy + zx * dz;
      const wy = 0 * dx + yy * dy + zy * dz;
      const wz = xz * dx + yz * dy + zz * dz;

      if (Math.abs(wz) < 1e-9) continue;
      const s = (bgZ - cz) / wz;
      // s ≤ 0 = 这条射线朝背离背景平面的方向走，不可能露边
      if (s <= 0) continue;

      const px = cx + s * wx;
      const py = cy + s * wy;
      need = Math.max(need, Math.abs(px) / halfW, Math.abs(py) / halfH);
    }
  }

  return need;
}

function composeBackground(
  scene: SceneManifest,
  ctx: SubjectContext,
  camera: CameraConfig,
): SceneObjectConfig {
  const { cameraZ, fov, bgDist, aspect } = ctx;
  const z = cameraZ - bgDist;

  // ★ 背景必须覆盖**整段运镜**里相机能看到的所有方向，否则边缘会露出来。
  //
  //   改造前这里是一个手推的闭式公式（`1 + 2|camY|/visibleH + 0.03`），
  //   只覆盖"相机沿 y 平移"。相机现在会转（orbit / whip），闭式公式不再成立
  //   —— 改成数值扫描实际位姿，见 overscanForCamera 的说明。
  //
  //   扫描采样 32 个 t，可能擦过极值点，所以再放 3% 余量。
  const need = overscanForCamera(camera, z, aspect);
  const overscan = need * 1.03;

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

/**
 * ★ 相机 —— 现在只负责**声明一个运镜**（PHASE 26）。
 *
 * 轨道由 `animation/camera-moves.ts` 展开（`cameraTracksOf` 是展开点），
 * 所以这里不再手写 `position.z` / `position.y` / `rotation.z` 三条轨道。
 *
 * ---------------------------------------------------------------------------
 * 【预算回路：超预算时压幅度，而不是放大背景】
 *
 *   运镜幅度越大，背景平面就得越大才不露边；而 overscan 是等比放大，
 *   放得越大背景越糊。所以这里先按满幅度建一次相机、量出需要的 overscan，
 *   超预算就把 `intensity` 压回来。
 *
 *   横向幅度与 intensity 近似线性，所以一步就能修正到位；`orbit` 用的是
 *   角度（sin），略非线性，所以再量一次兜住。
 */
function composeCamera(index: number, ctx: SubjectContext): CameraConfig {
  const { cameraZ, fov, dolly, bgDist, subjectWorld, cameraLook, bgOverscanMax, aspect } = ctx;

  // 相邻章节方向交替 —— 同一个运镜在相邻章读起来不同
  // （参考站点就是靠这个让 dolly 一会儿推近一会儿拉远的）
  const dir: 1 | -1 = index % 2 === 0 ? 1 : -1;
  const kind = MOVE_CYCLE[index % MOVE_CYCLE.length];
  const bgZ = cameraZ - bgDist;

  const build = (intensity: number): CameraConfig => ({
    z: cameraZ,
    fov,
    // 轨道全部由 move 展开 —— 不再手写
    tracks: [],
    // target 是"没有 target.* 轨道时的兜底"，取值和运镜的 look 一致
    target: cameraLook,
    move: {
      kind,
      // 绕谁转 = 主体（orbit 要真的绕着它）
      subject: subjectWorld,
      // 看向哪 = 折中点，不是主体本身。见 ComposeOptions.lookBlend
      look: cameraLook,
      intensity,
      dir,
      // ★ 推近预算 = 内容声明的 |dolly|。
      //   构图反解主体深度时用的就是这个数（`screenH × d/(d+dolly) ≤ maxScreenH`），
      //   所以运镜推近量必须和它一致，否则主体会被顶出画面。
      approach: Math.abs(dolly),
    },
  });

  let camera = build(1);
  let need = overscanForCamera(camera, bgZ, aspect);

  // 迭代到收敛。★ 每步乘 0.98 是**阻尼**：
  //   `need` 是 32 个采样点上的最大值，intensity 一变，极值点会挪到
  //   另一个采样点上，于是"量出来的最大值"不是强度的光滑函数 ——
  //   不阻尼的话会在预算上下反复横跳，收敛不到。
  //
  //   ★ 注意：如果**静态构图**（intensity = 0）本身就超预算，这个回路
  //     救不回来 —— 它会把 intensity 压到 0 然后放弃，画面一动不动。
  //     那是 `lookBlend` 该解决的问题，不是幅度的问题。
  for (let attempt = 0; attempt < 5 && need > bgOverscanMax; attempt++) {
    const scale = (bgOverscanMax - 1) / Math.max(need - 1, 1e-6);
    const current = camera.move?.intensity ?? 1;
    camera = build(Math.max(current * scale * 0.98, 0));
    need = overscanForCamera(camera, bgZ, aspect);
  }

  return camera;
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
 * ★ 主体的世界坐标质心（PHASE 26）—— 运镜"看向哪"。
 *
 * 从**已经摆好的主体对象**反推，而不是重算一遍构图数学：
 *   offset 就是屏幕归一化坐标（见文件头性质一），乘上该深度处的视口尺寸
 *   就是世界坐标 —— 和 `SceneBuilder` 的 baseX/baseY 是同一套换算。
 *
 * 这样做的价值：只有**一处**摆放数学。若在这里重写一遍，
 * 以后改构图公式就很容易只改一处，运镜于是"看向空气"。
 */
function subjectCentroid(
  objects: SceneObjectConfig[],
  ctx: SubjectContext,
): [number, number, number] {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;

  for (const o of objects) {
    if (o.role !== 'subject') continue;
    const vh = visibleHAt(Math.abs(ctx.cameraZ - o.z), ctx.fov);
    sx += o.offset[0] * vh * ctx.aspect;
    sy += o.offset[1] * vh;
    sz += o.z;
    n++;
  }

  // 没有主体（只有背景的场景）→ 看向深度区间的中点，绕行仍然成立
  if (n === 0) {
    const mid = (ctx.dist[0] + ctx.dist[1]) / 2;
    return [0, 0, ctx.cameraZ - mid];
  }
  return [sx / n, sy / n, sz / n];
}

/**
 * ★ 相机看向哪 —— 轴线与主体之间的折中点（PHASE 26）。
 *
 * 「轴线」= 相机初始朝向（−z）在主体那个深度上的落点，也就是世界坐标
 * `[0, 0, subject.z]`。看向它 = 相机完全不转，构图和原照片一模一样。
 *
 * 折中：`look = 轴线 + k × (主体 − 轴线)`
 *   k = 0（轴线）→ 不转，但运镜退化成"平移一张图"
 *   k = 1（主体）→ 死盯主体，主体居中但背景板被推出去（见 lookBlend 的推导）
 */
function composeLook(
  subjectWorld: [number, number, number],
  blend: number,
): [number, number, number] {
  const k = Math.min(Math.max(blend, 0), 1);
  const axis: [number, number, number] = [0, 0, subjectWorld[2]];
  return [
    axis[0] + (subjectWorld[0] - axis[0]) * k,
    axis[1] + (subjectWorld[1] - axis[1]) * k,
    axis[2],
  ];
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

  const baseCtx: Omit<SubjectContext, 'subjectWorld' | 'cameraLook'> = {
    aspect: o.aspect,
    cameraZ: o.cameraZ,
    fov: o.fov,
    dolly: o.dolly,
    camY: o.camY,
    dist: o.dist,
    bgDist: o.bgDist,
    maxScreenH: o.maxScreenH,
    maxSubjectH: o.maxSubjectH,
    bgOverscanMax: o.bgOverscanMax,
  };
  // 主体对象先于相机建，之后才知道质心；这两个占位值只用于建主体
  // （composeSubject 不读 subjectWorld / cameraLook）
  const subjectCtx: SubjectContext = {
    ...baseCtx,
    subjectWorld: [0, 0, 0],
    cameraLook: [0, 0, 0],
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
    //
    // ★ 顺序（PHASE 26）：主体 → 质心 → 相机 → 背景。
    //   背景的 overscan 依赖相机的整段运镜，所以它必须**最后**建；
    //   而相机看向哪依赖主体的实际位置，所以它必须在主体之后。
    const subjectObjects = scene.subjects.map((s, i) =>
      composeSubject(scene, s, i, index, subjectCtx),
    );

    const subjectWorld = subjectCentroid(subjectObjects, baseCtx as SubjectContext);
    const sceneCtx: SubjectContext = {
      ...baseCtx,
      subjectWorld,
      cameraLook: composeLook(subjectWorld, o.lookBlend),
    };

    const camera = composeCamera(index, sceneCtx);
    const background = composeBackground(scene, sceneCtx, camera);

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
      camera,
      objects: [background, ...subjectObjects],
    });
  });

  return { assets, scenes };
}
