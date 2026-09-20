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
 *   ▸ 轨道求值（position.x/y/z、rotation.z、fov）
 *   ▸ 阻尼（一阶低通，帧率无关）
 *   ▸ 把结果写进 THREE.PerspectiveCamera
 *
 * 【它不管什么】
 *
 *   ▸ 对象怎么动        → ObjectAnimator
 *   ▸ 视口比例怎么适应  → SceneBuilder.setAspect（相机 aspect 由它设）
 *   ▸ 场景怎么切换      → SceneManager
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
import { evaluateTracks } from '../../animation/timeline';

export class CameraSystem {
  /** 本帧求值结果（未阻尼） */
  private readonly raw: Record<string, number> = {};
  /** 阻尼后的值 —— 跨帧缓存，这就是它需要成为实例的原因 */
  private readonly smooth: Record<string, number> = {};

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private config: CameraConfig,
  ) {}

  /**
   * 重新构图后 config 可能被整个替换（Composer.refreshLayout 干的事），
   * 这里把引用同步过来。
   */
  syncConfig(config: CameraConfig): void {
    this.config = config;
  }

  /**
   * @param t  场景时间轴 0..1
   * @param dt 距上一帧的秒数。仅当相机声明了 damping 时才用到
   */
  apply(t: number, dt = 0): void {
    evaluateTracks(this.config.tracks, t, this.raw);

    const damping = this.config.damping ?? 0;
    if (damping > 0 && dt > 0) {
      // 一阶低通：k 越大跟得越紧。
      // ★ 1 - exp(-dt/damping) 是**帧率无关**的写法 ——
      //   用 `k = damping` 这种固定系数会在 30fps 和 144fps 下表现完全不同。
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
    this.camera.rotation.z = this.smooth['rotation.z'] ?? 0;

    const fov = this.smooth['fov'] ?? this.config.fov;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
