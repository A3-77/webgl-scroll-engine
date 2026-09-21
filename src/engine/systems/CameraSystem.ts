/**
 * PHASE 5 —— 相机系统
 * ===========================================================================
 * 负责一件事：给定场景时间 t，把相机摆到该在的位置。
 *
 * ---------------------------------------------------------------------------
 * 【改造前它在哪】
 *
 *   塞在 `SceneBuilder` 的 `BuiltScene.applyTime()` 前半段，
 *   和"对象动效求值"挤在同一个函数里。
 *   于是想改相机的求值方式，就得动那个 456 行的大函数 ——
 *   而它同时还管着平面几何、模型归一化、视口自适应。
 *
 * ---------------------------------------------------------------------------
 * 【它管什么】
 *
 *   ▸ 轨道求值（position.x/y/z、rotation.z、fov、**target.x/y/z**）
 *   ▸ 阻尼（一阶低通，帧率无关；position 与 target 各持一份状态）
 *   ▸ 把结果写进 THREE.PerspectiveCamera
 *   ▸ **让相机"看"**（PHASE 26）—— 有 target 时 `lookAt()`，无则只写欧拉角
 *
 * 【它不管什么】
 *
 *   ▸ 对象怎么动        → ObjectAnimator
 *   ▸ 视口比例怎么适应  → SceneBuilder.setAspect（相机 aspect 由它设）
 *   ▸ 场景怎么切换      → SceneManager
 *   ▸ "这一章怎么拍"    → schema/scene.ts 的 cameraTracksOf（把运镜展开成轨道）
 *
 * ---------------------------------------------------------------------------
 * 【★ 会看 vs 不会看 —— 零行为变更的开关】
 *
 *   改造前相机只有 position + rotation.z，镜头**永远朝 -Z 看**，
 *   所以任何运动都退化成"平移一张图"。PHASE 26 加了 target 之后，
 *   `hasTarget` 决定走哪条分支：
 *
 *     false → 原分支：`position.set()` + `rotation.z = roll`（逐位相同）
 *     true  → 新分支：`position.set()` + `lookAt(target)` + `rotateZ(roll)`
 *
 *   开关的判定在 `cameraHasTarget()`（camera.target / move / target.* 轨道）。
 *
 * ---------------------------------------------------------------------------
 * 【★ 有状态：阻尼需要上一帧的值】
 *
 *   `smooth` 是跨帧缓存，所以它必须是一个**实例**，不能是纯函数。
 *   这也是为什么 `refreshLayout` 之后要调 `syncConfig()` ——
 *   config 可能被整个替换掉（见 Composer.refreshLayout）。
 * ===========================================================================
 */

import type * as THREE from 'three';
import type { CameraConfig } from '../../schema';
import { cameraHasTarget, cameraTracksOf } from '../../schema';
import type { Track } from '../../schema/animation';
import { evaluateTracks } from '../../animation/timeline';

export class CameraSystem {
  /** 本帧求值结果（未阻尼） */
  private readonly raw: Record<string, number> = {};
  /** 阻尼后的值 —— 跨帧缓存，这就是它需要成为实例的原因 */
  private readonly smooth: Record<string, number> = {};

  /**
   * 展开后的轨道（PHASE 26）。
   * ★ 在构造 / `syncConfig` 时算一次并缓存 —— 运镜的展开会分配数组，
   *   放在 `apply` 里就是每帧一次分配，而 `apply` 每帧会被调两次
   *   （current + next 两个场景各一次）。
   */
  private tracks: Track[];
  /**
   * 相机这一章是否"会看"（有 target）。
   * false 时走**原分支**（只写 position + rotation.z），保证零行为变更。
   */
  private hasTarget: boolean;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private config: CameraConfig,
  ) {
    this.tracks = cameraTracksOf(config);
    this.hasTarget = cameraHasTarget(config);
  }

  /**
   * 重新构图后 config 可能被整个替换（Composer.refreshLayout 干的事），
   * 这里把引用同步过来。
   */
  syncConfig(config: CameraConfig): void {
    this.config = config;
    // 自动构图会在这里换上带运镜的新 config —— 必须重算
    this.tracks = cameraTracksOf(config);
    this.hasTarget = cameraHasTarget(config);

    // ★ 丢掉**新轨道不再产生**的旧键。
    //
    //   `evaluateTracks` 是只写不删的（它复用 `out` 来避免每帧分配），
    //   所以换过 config 之后，旧路径会永远留在缓存里继续被读 ——
    //   最典型的是 `fov`：上一份 config 有 fov 轨道、这一份没有，
    //   于是相机继续用上一份算出来的 fov。
    //   实测踩到：`crash`（收窄到 28°）之后换成 `rise`，rise 没有 fov 轨道，
    //   却一直停在 28° —— 画面窄了一圈而没有任何东西解释它。
    //
    //   只删失效的键，**保留仍然存在的**：那部分要继续吃阻尼，
    //   全清掉会让重新构图（改窗口大小）时相机跳一下。
    const live = new Set(this.tracks.map((t) => t.path));
    for (const key of Object.keys(this.raw)) {
      if (!live.has(key)) {
        delete this.raw[key];
        delete this.smooth[key];
      }
    }
  }

  /**
   * @param t  场景时间轴 0..1
   * @param dt 距上一帧的秒数。仅当相机声明了 damping 时才用到
   */
  apply(t: number, dt = 0): void {
    evaluateTracks(this.tracks, t, this.raw);

    const damping = this.config.damping ?? 0;
    if (damping > 0 && dt > 0) {
      // 一阶低通：k 越大跟得越紧。
      // ★ 1 - exp(-dt/damping) 是**帧率无关**的写法 ——
      //   用 `k = damping` 这种固定系数会在 30fps 和 144fps 下表现完全不同。
      //
      // ★★ 平滑缓存是**按轨道路径**分键的，所以 `target.*` 天然拥有
      //    独立于 `position.*` 的一份状态 —— 这正是参考站点的做法
      //    （`ShotDirector` 对 smoothedTgt 和 position 分别做
      //    `1 - exp(-14 * delta)`）。二者共用一个 k，但历史值互不干扰：
      //    位置快速推进时，视线不会跟着"甩"一下。
      const k = 1 - Math.exp(-dt / Math.max(damping, 1e-4));
      for (const key in this.raw) {
        this.smooth[key] =
          this.smooth[key] === undefined
            ? this.raw[key]
            : this.smooth[key] + (this.raw[key] - this.smooth[key]) * k;
      }
    } else {
      for (const key in this.raw) this.smooth[key] = this.raw[key];
    }

    this.camera.position.set(
      this.smooth['position.x'] ?? 0,
      this.smooth['position.y'] ?? 0,
      this.smooth['position.z'] ?? this.config.z,
    );

    const roll = this.smooth['rotation.z'] ?? 0;

    if (this.hasTarget) {
      // ★★ 会看的分支（PHASE 26）
      //
      //   `lookAt` 会**重写整个 quaternion**，所以：
      //     ① 必须在它**之后**再叠滚转，否则滚转会被抹掉
      //     ② 滚转要用 `rotateZ`（绕**相机自身的 Z 轴** = 视线轴）而不是
      //        写 `rotation.z`。写欧拉角的话，three.js 的 'XYZ' 顺序是
      //        R = RX·RY·RZ，RZ 在最内层，得到的不是"绕视线轴滚转"。
      //        参考站点用的也是 `camera.rotateZ(roll)`。
      //     ③ 因为 lookAt 每帧重置 quaternion，rotateZ 不会逐帧累积。
      this.camera.lookAt(
        this.smooth['target.x'] ?? this.config.target?.[0] ?? 0,
        this.smooth['target.y'] ?? this.config.target?.[1] ?? 0,
        this.smooth['target.z'] ?? this.config.target?.[2] ?? 0,
      );
      if (roll !== 0) this.camera.rotateZ(roll);
    } else {
      // 原分支 —— 逐位保持改造前的行为
      this.camera.rotation.z = roll;
    }

    const fov = this.smooth['fov'] ?? this.config.fov;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
