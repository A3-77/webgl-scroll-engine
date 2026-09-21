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
// 同理：运镜的展开也是**纯函数**（CameraMoveSpec → Track[]）。
// 依赖方向：schema/scene.ts → animation/camera-moves.ts → schema/scene.ts（type-only，被擦除）
// 无环 —— camera-moves.ts 自己没有任何运行时依赖。
import { expandCameraMove } from '../animation/camera-moves';

/* ------------------------------------------------------------ 相机 */

export interface CameraConfig {
  /** 相机到世界原点的初始距离（也是 position.z 轨道的兜底值） */
  z: number;
  /** 初始垂直视野角（度）。原站 Hero 实测从 25 走到 22.27 */
  fov: number;
  /** 相机自身的轨道（position / rotation / fov / target） */
  tracks: Track[];
  /** 可选阻尼，见 CameraAnimation.damping */
  damping?: number;
  /**
   * ★★ 看向的世界坐标（PHASE 26）—— **让镜头会「看」，而不是只会「平移」**。
   *
   * ---------------------------------------------------------------------------
   * 【为什么这是"像图片转场"的根因】
   *
   *   改造前相机只有 `position` 和 `rotation.z`（滚转）。
   *   也就是说镜头**永远朝着 -Z 方向看**，能做的只有"把画面平移一段距离"。
   *   无论怎么加缓动、加阻尼、加视差，观感都是**一张图在滑动** ——
   *   因为真实摄影机的运动不是平移，是**围绕一个被摄体运动**：
   *   推近时主体在画面里保持不动、背景向外散开；绕行时主体始终留在构图里。
   *
   *   两个参考站点都有这一项，而且都是核心：
   *     ▸ iamsaeed.dev —— `Pose = { position, target, roll, fov }`，
   *       每帧 `camera.lookAt(smoothedTgt)`，**目标本身也做阻尼**（和位置分开平滑）
   *     ▸ shader.se —— 20 架飞机各自 `plane.lookAt(position + direction)`，
   *       沿路径飞行时朝向始终对齐前进方向
   *
   * ---------------------------------------------------------------------------
   * 【零行为变更】
   *
   *   不声明 `target`、且 `tracks` 里也没有 `target.*` 轨道时，
   *   `CameraSystem` 走**原来的分支**（只写 position + rotation.z），逐位相同。
   *
   * 【怎么用】
   *
   *   静态看向某点：`target: [0, -0.6, 3.5]`
   *   让目标也动：在 `tracks` 里加 `target.x` / `target.y` / `target.z`
   *   想要一套现成的运镜：用 `move`（见下）
   */
  target?: [number, number, number];
  /**
   * ★★ 镜头语言（PHASE 26）—— 一个**命名过的运镜**，会被展开成轨道。
   *
   * 为什么需要"命名"而不是让内容自己写轨道：
   *   改造前的自动构图每章都是同一套动作（推进 + 上下平移 + 微滚转），
   *   只把方向符号交替一下 —— `composeCamera` 自己的注释就承认了
   *   "每章都用同一套运镜会让人明显感到'又是这个动作'"。
   *
   *   参考站点用的是**一套词汇**：iamsaeed.dev 的
   *   `ShotKind = hold | dolly | orbit | crash | whip | spline`，
   *   每种有各自的求值方式。有了词汇，"这一章该怎么拍"才是一个可做的决定。
   *
   * 展开由 `animation/camera-moves.ts` 负责（和对象预设同一套模式：
   * 内容声明名字，引擎展开成轨道，引擎侧只认识轨道一种形态）。
   */
  move?: CameraMoveSpec;
}

/** 运镜类型 —— 照搬参考站点的词汇，去掉本引擎没有对应实现的几种 */
export type CameraMoveKind =
  /** 基本不动。只留极轻的呼吸感 —— 用于"让观众凝视"的一章 */
  | 'hold'
  /** 沿视线推近（或拉远）。主体在画面里保持不动，背景向外散开 */
  | 'dolly'
  /** ★ 绕主体画弧。最有"空间感"的一种：主体始终在构图里，背景侧向流动 */
  | 'orbit'
  /** 快速横扫 + 目标跟随 —— 读作"甩镜头"，是**转场感**的来源 */
  | 'whip'
  /** 冲向主体：快速推近 + 视野收窄。读作"撞进去" */
  | 'crash'
  /** 升起并俯视：相机抬高，视线下压 */
  | 'rise';

export interface CameraMoveSpec {
  kind: CameraMoveKind;
  /**
   * **绕谁转** —— `orbit` 的弧心。不传 = 场景原点。
   * 自动构图会把它设成**主体的世界坐标质心**，这样 `orbit` 才是真的绕着主体转。
   */
  subject?: [number, number, number];
  /**
   * ★ **看向哪**（PHASE 26）。所有运镜的 `target.*` 轨道都取这个值。
   *
   * 不传 = 和 `subject` 相同（"死盯主体"）。
   *
   * ---------------------------------------------------------------------------
   * 【为什么它和 `subject` 要分开】
   *
   *   让相机转过头去把主体摆到**画面正中央**是有代价的：
   *
   *     ▸ 构图 —— 原照片的取景被丢掉了，主体永远在正中，很呆。
   *     ▸ 几何 —— 相机一转，**平坦的背景板**就得跟着变大才不露边。
   *       实测（cats 内容、aspect 2.234、主体偏轴 8°）：
   *       静态构图就需要 overscan **1.52**，而且这个需求和运镜幅度无关 ——
   *       再怎么压低幅度都救不回来。
   *
   *   所以自动构图给的是一个**折中点**：
   *       `look = 轴线 + 0.45 × (主体 − 轴线)`
   *   相机只转 45%，主体留在三分线附近，背景需求从 1.52 掉到 1.19。
   *   见 `compose.ts` 的 `lookBlend`。
   */
  look?: [number, number, number];
  /** 幅度倍率。1 = 预设默认；0 = 退化成静止（但依然 lookAt） */
  intensity?: number;
  /**
   * 允许的**最大推近量**（世界单位，正值）。`dolly` / `crash` 用它决定推多近。
   *
   * ★ 为什么必须由外面给：自动构图是**反解主体深度**来保证"推进结束时
   *   主体不冲出画面"的 —— `screenH × d/(d + dolly) ≤ maxScreenH`。
   *   这条不等式的右边是内容声明的 `dolly`。运镜若自己拍脑袋推得更近，
   *   主体就会被顶出画面，而那条约束是有单测锁着的。
   *
   *   所以：**推多近**由构图预算决定，**怎么推**由运镜决定。
   *
   * 不传 = `0.18 × 相机到主体的距离`。
   */
  approach?: number;
  /**
   * 方向符号。相邻章节交替（+1 / −1），让"同一个运镜"在相邻章读起来不同 ——
   * 参考站点就是靠交替方向让 `dolly` 一会儿推近一会儿拉远的。
   * 不传 = +1。
   */
  dir?: 1 | -1;
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
 * 取相机**生效的轨道**（PHASE 26）。
 *
 * 和 `tracksOf` 是同一套模式，也是相机运镜**唯一的展开点**：
 *   内容声明 `camera.move = { kind: 'orbit' }`，引擎在这里展开成
 *   `position.x/y/z` + `target.x/y/z`（+ 可能还有 `fov` / `rotation.z`）的轨道。
 *   引擎侧（`CameraSystem`）只认识轨道一种形态，不需要知道"运镜"这个概念。
 *
 * 【顺序 = 覆盖关系】
 *   手写轨道在前、运镜展开在后。求值器是"后写覆盖先写"（`out[path] = …`），
 *   所以运镜会盖掉同名的手写轨道。这是有意的：
 *   声明了 `move` 就表示"这一章的镜头交给这套运镜"，手写轨道只用于补充
 *   运镜不管的路径。
 *
 * 【零行为变更】
 *   不声明 `move` 时**原样返回** `cam.tracks` —— 不复制、不展开，
 *   连一次数组分配都没有。
 */
export function cameraTracksOf(cam: CameraConfig): Track[] {
  const move = cam.move;
  if (!move) return cam.tracks;

  const subject: [number, number, number] = move.subject ?? cam.target ?? [0, 0, 0];
  const expanded = expandCameraMove(move, {
    // 基准距离 —— 相机初始位置在 (0, 0, cam.z)，主体在 subject
    distance: Math.abs(cam.z - subject[2]),
    fov: cam.fov,
    // approach 由 move 自己带（自动构图会设成 |dolly|）；不传则由
    // expandCameraMove 兜底成 0.18 × 距离
    approach: move.approach,
    // 看向哪：move.look 优先，其次 camera.target（手写 target 的旧写法）
    look: move.look ?? cam.target,
    dir: move.dir ?? 1,
  });

  if (expanded.length === 0) return cam.tracks;
  return cam.tracks.length > 0 ? [...cam.tracks, ...expanded] : expanded;
}

/**
 * 相机是否"会看"（PHASE 26）—— 决定 `CameraSystem` 走哪条分支。
 *
 * 三个来源任一成立就算：
 *   ① `camera.target` 静态声明
 *   ② `tracks` 里有 `target.*` 轨道（内容自己写的手动运镜）
 *   ③ 声明了 `move`（运镜**一定**会发 `target.*`，见 camera-moves.ts 的 lookAt）
 *
 * ★ 这是零行为变更的开关：三者都不成立时 `CameraSystem` 走原分支，
 *   只写 position + rotation.z，逐位相同。
 */
export function cameraHasTarget(cam: CameraConfig): boolean {
  if (cam.target) return true;
  if (cam.move) return true;
  for (const t of cam.tracks) {
    if (t.path.startsWith('target.')) return true;
  }
  return false;
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
