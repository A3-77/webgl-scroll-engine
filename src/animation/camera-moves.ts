/**
 * PHASE 26 —— 镜头语言（camera moves）
 * ===========================================================================
 * 把「一个命名过的运镜」展开成相机轨道。
 *
 * 和 `animation/presets.ts` 是同一套模式：内容声明名字，引擎展开成轨道，
 * 引擎侧（`CameraSystem`）只认识轨道一种形态。
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么相机需要"词汇"而不是只有"轨道"】
 *
 *   改造前每章的相机都是同一套动作：`position.z` 推进 + `position.y` 上下平移
 *   + 一点 `rotation.z` 滚转，只把方向符号交替。`composeCamera` 自己的注释
 *   就写着"每章都用同一套运镜会让人明显感到'又是这个动作'"。
 *
 *   参考站点用的是一套**词汇**（iamsaeed.dev 的
 *   `ShotKind = hold | dolly | orbit | crash | whip | spline`）。
 *   有了词汇，"这一章该怎么拍"才是一个可以做的决定 ——
 *   否则你能调的只有"推多少、平移多少"，调出来的永远是同一个动作。
 *
 * ---------------------------------------------------------------------------
 * 【★ 三条实现纪律，都来自"看起来不对"的实测】
 *
 *   ① **横向幅度一律写成"主体处视口高度"的比例**，不写世界单位。
 *
 *      `frame = 2·tan(fov/2)·distance` 就是"相机到主体那个深度上，
 *      视口在世界空间有多高"。它是**观感的自然单位**：
 *      横向移动 0.10·frame，观感就是"画面横移了 10% 视口高" ——
 *      与 fov 无关、与镜头远近无关。
 *
 *      参考站点的指针视差也用的是比例（`amp * distanceToTarget`，
 *      注释写着 "~ ±2deg at target distance"）。区别只在于：
 *      它用的是距离的比例，我们用的是**视口高度的比例** ——
 *      后者更准，因为距离的比例还要乘上 fov 才等于观感。
 *
 *      写成世界单位的后果：镜头推近之后同一个数值会把主体晃出画面。
 *
 *   ② **曲线路径用"非均匀采样 + linear 段"，不要"均匀采样 + 逐段缓动"。**
 *      求值器（`sampleTrack`）是**逐段**取缓动的：给每个关键帧标 `easeInOut`，
 *      它会在**每一段**的两端都减速 —— 一条弧被切成 8 段，就有 8 次"起停"，
 *      看起来是一顿一顿的。
 *      正确做法：让 `u → easeInOut(u)` 决定**采样位置**，
 *      段与段之间用 `linear`。这样整条弧只有一个平滑的加速—减速包络。
 *
 *   ③ **推近量受 `approach` 约束，不能自由发挥。**
 *
 *      自动构图会**反解主体深度**来保证"推进结束时主体不冲出画面"：
 *          screenH × d/(d + dolly) ≤ maxScreenH
 *      这个不等式的右边用的是内容声明的 `dolly`。如果运镜自己拍脑袋
 *      推近 42% 距离（= 距离 27 时的 11.3），而 `dolly` 只有 6，
 *      主体就会被顶出画面 —— 而这条约束是有单测锁着的。
 *
 *      所以推近量由**外面**给（`approach`），运镜只决定**怎么推**
 *      （`dolly` 匀速缓入缓出、`crash` 快进慢停 + 收窄视野）。
 * ===========================================================================
 */

import type { CameraMoveKind, CameraMoveSpec } from '../schema/scene';
import type { Ease, Keyframe, Track } from '../schema/animation';

/* ------------------------------------------------------------ 上下文 */

export interface CameraMoveContext {
  /** 相机到主体的基准距离（= |camera.z − subject.z|） */
  distance: number;
  /**
   * 主体所在深度上「视口在世界空间的高度」= `2·tan(fov/2)·distance`。
   * ★ 所有**横向/纵向**幅度的单位，见文件头纪律①。
   */
  frame: number;
  /**
   * **绕谁转** —— `orbit` 的弧心。其他运镜不用它。
   */
  subject: [number, number, number];
  /**
   * ★ **看向哪** —— 所有运镜的 `target.*` 轨道都取这个值。
   *
   * ---------------------------------------------------------------------------
   * 【为什么它和 `subject` 是两个东西】
   *
   *   直觉上"绕谁转"和"看向哪"是同一个点，但**看向主体**是有代价的：
   *   相机要转过头去，让主体落在画面中心。
   *
   *   代价有多大？实测（cats 内容，aspect 2.234）：主体偏轴 8° 时，
   *   平坦背景板（在主体后 13 个单位）需要被放大 **1.52 倍** 才不露边 ——
   *   而这不是运镜造成的，是**静态构图**就要这么多。也就是说
   *   再怎么压低运镜幅度都救不回来（预算回路会把 intensity 压到 0，
   *   画面变成一动不动，背景照样不够大）。
   *
   *   而且"把主体摆到正中央"本身也不是好构图 —— 原照片的取景被丢掉了。
   *
   *   所以由**外面**（自动构图）给一个折中点：`look = 轴线 + k × (主体 − 轴线)`。
   *   k = 0.45 时相机只转 45% 的角度，主体留在三分线附近，
   *   背景需求从 1.52 掉到 1.19 —— 构图更好看，代价更小。
   *   见 compose.ts 的 `lookBlend`。
   *
   *   不传 = 和 `subject` 相同（内容自己写运镜时的默认：看向主体）。
   */
  look: [number, number, number];
  /**
   * 相机的基准视野角（度）。
   * ★ 必须传进来：`fov` 轨道在引擎里是**绝对值**（`CameraSystem` 直接写
   *   `camera.fov = smooth.fov ?? config.fov`），所以运镜想"收窄视野"
   *   必须自己算出绝对值，写 0 或负数会把相机搞坏。
   */
  fov: number;
  /**
   * 允许的**最大推近量**（世界单位，正值）。见文件头纪律③。
   * 自动构图把它设成 `|dolly|`，于是"主体不出界"这条不变量继续成立。
   */
  approach: number;
  /** 幅度倍率，1 = 预设默认 */
  intensity: number;
  /** 方向符号 —— 相邻章节交替，避免"每章都是同一个动作" */
  dir: 1 | -1;
}

export type CameraMoveBuilder = (ctx: CameraMoveContext) => Track[];

/* ------------------------------------------------------------ 工具 */

function track(path: string, points: Array<[number, number, Ease?]>): Track {
  return {
    path,
    keyframes: points.map(
      ([t, value, ease]): Keyframe => ({ t, value, ease: ease ?? 'easeInOut' }),
    ),
  };
}

/** 只给一个值 = 常量轨道（求值器对单关键帧返回该常量） */
function constant(path: string, value: number): Track {
  return track(path, [[0, value]]);
}

/**
 * 让相机看向 `look` 的三条常量轨道。
 *
 * 每个运镜都要发这一组 —— 不发的话相机就退回"永远朝 -Z 看"，
 * 那么所有运镜都退化成"平移一张图"，正是这一版要解决的问题。
 */
function lookAt(look: [number, number, number]): Track[] {
  return [
    constant('target.x', look[0]),
    constant('target.y', look[1]),
    constant('target.z', look[2]),
  ];
}

/** 局部 0..1 → 带缓动的局部位置（用于非均匀采样，见文件头纪律②） */
const easeInOut = (u: number): number => u * u * (3 - 2 * u);

/* ------------------------------------------------------------ 运镜表 */

export const CAMERA_MOVES: Record<CameraMoveKind, CameraMoveBuilder> = {
  /**
   * 基本不动 —— 只留极轻的呼吸 + **极缓的推近**，让"静止"不显得是"卡住了"。
   *
   * 为什么要那 0.35 的推近：自动构图是**反解主体深度**来让主体在推进结束时
   * 长到该有的屏幕尺寸的（`screenH × d/(d+dolly) ≤ maxScreenH`）。
   * 首屏完全不动的话，主体就永远停在"还没长开"的状态。
   * 0.35 的推近既保住了"凝视"的观感，又不让构图白算。
   *
   * 往返用两条 `easeInOut` 段：中点两侧的导数都是 0，所以转折处
   * **速度连续**（只是平滑地掉头），不会出现"急停再倒车"的顿挫。
   */
  hold: ({ frame, subject, look, distance, approach, intensity, dir }) => [
    track('position.x', [
      [0, 0],
      [0.5, 0.015 * frame * intensity * dir],
      [1, 0],
    ]),
    track('position.y', [
      [0, 0],
      [0.5, -0.010 * frame * intensity],
      [1, 0],
    ]),
    track('position.z', [
      [0, subject[2] + distance],
      [1, subject[2] + distance - approach * 0.35 * intensity],
    ]),
    ...lookAt(look),
  ],

  /**
   * 沿视线推近。★ 必须配合 lookAt 才成立 ——
   *   只改 position.z 而不看向主体的话，观感是"把图放大"，
   *   而不是"镜头推近"。
   *
   * ★ 不受 `dir` 影响（永远推近）：构图的尺寸上限是按"推近"反解的，
   *   拉远会让主体比设计的更小 —— 那是构图该决定的事，不该由运镜顺手改掉。
   *   "推近还是拉远"如果需要，是**另一个运镜**该干的事。
   */
  dolly: ({ distance, subject, look, approach, intensity }) => [
    constant('position.x', 0),
    constant('position.y', 0),
    track('position.z', [
      [0, subject[2] + distance],
      [1, subject[2] + distance - approach * intensity],
    ]),
    ...lookAt(look),
  ],

  /**
   * ★ 绕主体画弧 —— 本版最有"空间感"的一种。
   *
   * 相机沿水平圆弧从 −arc/2 转到 +arc/2，**始终看向 `look`**。
   * 于是主体在画面里基本不动，背景和分层按各自的深度侧向流动 ——
   * 这是 2.5D 分层最能出效果的运动，也是"平移一张图"永远做不出来的。
   *
   * ★ 弧心是 `subject`（真的绕主体转），看向的是 `look`（可能略偏）——
   *   两个点是分开的，见 CameraMoveContext.look 的说明。
   */
  orbit: ({ distance, subject, look, intensity, dir }) => {
    // 18° 总弧长。再大就要靠"背景 overscan"兜底，背景会被放大到发虚 ——
    // 自动构图那边有 `bgOverscanMax` 预算，超了会把 intensity 压回来。
    const arc = ((18 * Math.PI) / 180) * intensity * dir;
    const samples = 8;
    const xs: Array<[number, number, Ease?]> = [];
    const zs: Array<[number, number, Ease?]> = [];

    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      // ★ 用缓动决定**采样位置**，而不是给每段标缓动（文件头纪律②）
      const e = easeInOut(u);
      const theta = -arc / 2 + arc * e;
      xs.push([u, subject[0] + Math.sin(theta) * distance, 'linear']);
      zs.push([u, subject[2] + Math.cos(theta) * distance, 'linear']);
    }

    return [
      track('position.x', xs),
      constant('position.y', 0),
      track('position.z', zs),
      // 绕行时目标保持不动 = 构图稳定，背景自己流动
      ...lookAt(look),
    ];
  },

  /**
   * 甩镜头 —— 相机大幅横扫，**目标跟着扫**。
   *
   * 关键在"目标也动"：只扫相机不扫目标的话，读到的是"平移"；
   * 目标一起扫，读到的才是"有人把镜头甩过去了"，是转场感的来源。
   */
  whip: ({ frame, subject, look, distance, intensity, dir }) => {
    const pan = 0.12 * frame * intensity * dir;
    const look_ = 0.22 * frame * intensity * dir;
    return [
      track('position.x', [
        [0, -pan, 'easeOutCubic'],
        [1, pan, 'easeOutCubic'],
      ]),
      constant('position.y', 0),
      constant('position.z', subject[2] + distance),
      track('target.x', [
        [0, look[0] - look_, 'easeOutCubic'],
        [1, look[0] + look_, 'easeOutCubic'],
      ]),
      constant('target.y', look[1]),
      constant('target.z', look[2]),
      // 一点滚转 —— 甩镜头时人会本能地歪一下。
      // ★ 跟着 intensity 缩放：`intensity: 0` 必须真的退化成静止
      track('rotation.z', [
        [0, 0.030 * dir * intensity],
        [1, -0.030 * dir * intensity],
      ]),
    ];
  },

  /**
   * 冲向主体：快速推近 + 视野收窄。
   *
   * 缓动用 `easeOutCubic`（快进慢停）—— "冲"是先快后停，
   * 用 `easeInOut` 会变成"慢慢加速再慢慢停"，读起来是"靠近"而不是"冲"。
   * fov 同时收窄会放大这个感觉（推轨 + 变焦叠加）。
   *
   * ★ 推近量用 `approach`（和 `dolly` 同一个预算），"冲"的感觉来自
   *   **速度曲线 + 视野收窄**，而不是"推得比别人多"。
   */
  crash: ({ subject, look, distance, approach, fov, intensity }) => [
    constant('position.x', 0),
    constant('position.y', 0),
    track('position.z', [
      [0, subject[2] + distance, 'easeOutCubic'],
      [1, subject[2] + distance - approach * intensity, 'easeOutCubic'],
    ]),
    // 视野收窄 —— 幅度很小，收多了会像"变焦糊"。
    // ★ 写绝对值（基准 fov 减一点），不是增量
    track('fov', [
      [0, fov, 'easeOutCubic'],
      [1, fov - 4 * intensity, 'easeOutCubic'],
    ]),
    ...lookAt(look),
  ],

  /**
   * 升起并俯视：相机抬高，视线同时下压。
   *
   * 视线必须跟着下压，否则读起来是"抬头看天花板"——
   * 相机升了、但还盯着原来那个高度，画面里主体会往下滑。
   * 让 target 比相机抬得少，就形成了俯角。
   */
  rise: ({ frame, distance, subject, look, approach, intensity, dir }) => {
    const lift = 0.09 * frame * intensity;
    return [
      constant('position.x', 0),
      track('position.y', [
        [0, -lift],
        [1, lift],
      ]),
      // 升起的同时略微推近 —— 只升不近读起来是"往上飘"，
      // 抬高的同时靠近一点才像"摇臂升起来看"。
      // ★ 推近量同样走 approach 预算（0.3 倍），不自己拍脑袋
      track('position.z', [
        [0, subject[2] + distance],
        [1, subject[2] + distance - approach * 0.3 * intensity],
      ]),
      // 目标比相机抬得少 → 形成俯角
      track('target.y', [
        [0, look[1] + lift * 0.25],
        [1, look[1] - lift * 0.25],
      ]),
      constant('target.x', look[0]),
      constant('target.z', look[2]),
      track('rotation.z', [
        [0, 0.010 * dir * intensity],
        [1, -0.010 * dir * intensity],
      ]),
    ];
  },
};

/** 所有运镜名字（调试面板 / 文档用） */
export function cameraMoveNames(): string[] {
  return Object.keys(CAMERA_MOVES);
}

/**
 * 展开一个运镜。`spec` 为空时返回空数组 ——
 * 那是"不声明 move"的状态，相机走原来的分支（零行为变更）。
 */
export function expandCameraMove(
  spec: CameraMoveSpec | undefined,
  base: {
    distance: number;
    fov: number;
    /** 不传 = `0.18 × distance`（内容自己写运镜时的兜底） */
    approach?: number;
    dir: 1 | -1;
    subject?: [number, number, number];
    /** 看向哪。不传 = 和 subject 相同 */
    look?: [number, number, number];
  },
): Track[] {
  if (!spec) return [];
  const builder = CAMERA_MOVES[spec.kind];
  if (!builder) {
    console.warn(`[camera-moves] 未知的运镜 "${spec.kind}"，已忽略`);
    return [];
  }

  // 距离不能是 0 —— 那会让 frame 变成 0，所有幅度一起消失
  const distance = Math.max(base.distance, 1e-6);
  const subject = spec.subject ?? base.subject ?? [0, 0, 0];
  return builder({
    distance,
    // ★ 观感单位：该深度处视口在世界空间的高度
    frame: 2 * Math.tan((base.fov * Math.PI) / 180 / 2) * distance,
    subject,
    // 看向哪 —— 不单独给就看向主体（"死盯主体"的默认行为）
    look: spec.look ?? base.look ?? subject,
    fov: base.fov,
    approach: Math.max(spec.approach ?? base.approach ?? 0.18 * distance, 0),
    intensity: spec.intensity ?? 1,
    dir: base.dir,
  });
}
