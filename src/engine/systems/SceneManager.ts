/**
 * PHASE 4 —— 场景管理器
 * ===========================================================================
 * 负责一件事：**场景集合的生命周期，以及"这一帧该渲染哪两个场景"**。
 *
 * ---------------------------------------------------------------------------
 * 【改造前它在哪】
 *
 *   根本不存在这个类。场景数组是 `Composer` 的一个私有字段 `scenes: BuiltScene[]`，
 *   而"取 current / 取 next / 算它们各自的时间"这段逻辑直接写在
 *   `Composer.render()` 的开头。于是场景的生命周期（建、改比例、重新构图、销毁）
 *   和渲染管线（离屏纹理、过渡、bloom）在同一个类里纠缠。
 *
 * ---------------------------------------------------------------------------
 * 【它管什么】
 *
 *   ▸ 按 config 建出全部场景（委托 SceneBuilder）
 *   ▸ 当前章 / 下一章的解析，以及各自的时间轴求值
 *   ▸ 视口比例变化 → 通知每个场景重算几何
 *   ▸ 重新构图后的原地刷新（refreshLayout）
 *   ▸ 销毁
 *
 * 【它不管什么】
 *
 *   ▸ 场景内部怎么求值      → CameraSystem / ObjectAnimationSystem
 *   ▸ 渲染到哪张纹理        → TransitionSystem
 *   ▸ 混合完之后的高光      → PostSystem（后处理链）
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么每章要有独立的 Scene + 独立的 PerspectiveCamera】
 *
 *   真实站点就是这么做的：每个章节有自己的 camera 关键帧轨道，互不干扰。
 *   共用一个相机的话，"第 2 章相机推近"的轨道会在切到第 3 章时留下残值。
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么要同时解析出 next】
 *
 *   next 的存在是「双场景交叉溶解」的前提 —— 必须两张图同时在动，
 *   过渡 shader 的阈值场才能做出"两个场景互相咬合"的溶解，
 *   而不是简单的透明度渐变。
 * ===========================================================================
 */

import type * as THREE from 'three';
import type { SceneConfig, ScrollState } from '../../schema';
import { sceneTime } from '../../animation/scrollProgress';
import { buildScene, type BuiltScene } from '../SceneBuilder';
import type { ModelAsset } from '../loaders';
import type { PointerSystem } from './PointerSystem';

/** 解析结果：这一帧要渲染的两个场景 + 各自的时间轴位置 */
export interface ResolvedFrame {
  current: BuiltScene;
  /** 没有下一章时为 null（末章） */
  next: BuiltScene | null;
  /** -1 表示没有下一章 */
  nextIndex: number;
  /** current 的场景时间 0..1 */
  currentT: number;
  /** next 的场景时间 0..1。没有 next 时为 0 */
  nextT: number;
}

export class SceneManager {
  private constructor(readonly scenes: BuiltScene[]) {}

  static build(
    configs: SceneConfig[],
    textures: Map<string, THREE.Texture>,
    models: Map<string, ModelAsset>,
    aspect: number,
    pointerSystem: PointerSystem,
  ): SceneManager {
    return new SceneManager(
      configs.map((cfg) => buildScene(cfg, textures, models, aspect, pointerSystem)),
    );
  }

  /**
   * 按滚动状态解析出「当前章 + 下一章」以及各自的时间轴位置。
   *
   * 只解析、不求值 —— 求值由调用方在合适的时机调 `applyTime`，
   * 这样渲染顺序（先渲 current 还是先渲 next）仍然由编排层决定。
   */
  resolve(state: ScrollState): ResolvedFrame {
    const { current, next, heights, viewportH } = state;
    const currentScene = this.scenes[current.index] ?? this.scenes[0];
    const nextScene = next ? this.scenes[next.index] : undefined;

    return {
      current: currentScene,
      next: nextScene ?? null,
      nextIndex: nextScene && next ? next.index : -1,
      currentT: sceneTime(current.index, current.progress, heights, viewportH),
      nextT: nextScene && next ? sceneTime(next.index, next.progress, heights, viewportH) : 0,
    };
  }

  setAspect(aspect: number): void {
    for (const s of this.scenes) s.setAspect(aspect);
  }

  /**
   * ★ 用**重新构图后的 config** 刷新已有场景的布局。返回是否成功。
   *
   * ---------------------------------------------------------------------------
   * 【为什么光调 setAspect 不够】
   *
   *   `setAspect` 重算的是 baseX/baseY 和平面几何尺寸 ——
   *   它用的 `overscan` 和 `offset` 是**构图阶段按当时的 aspect 算好的常量**。
   *
   *   视口从 21:9 变到 4:3 时：
   *     fY = max(1, vpAspect/srcAspect)  从 1.55 掉到 1.0
   *     → 主体本该缩小 35%，但 overscan 还是旧值 → **主体偏大、位置也偏**
   *   实测：把 2.12 的视口缩到 1.0，主体会溢出屏幕一大截。
   *
   * ---------------------------------------------------------------------------
   * 【为什么是"刷新"而不是"重建"】
   *
   *   重建要重新 `loadAssets`（图片解码 200~500ms），拖动窗口时会持续卡顿。
   *   这里只改几何参数 —— 纹理、材质、RenderTarget 全部复用。
   *
   * ---------------------------------------------------------------------------
   * 【前置条件】configs 与当前 scenes **结构一致**（同样的场景数、同样的 id、
   * 同样的对象顺序）。不一致说明内容本身变了，那必须走整体重建，
   * 所以这里直接返回 false 让调用方去重建。
   */
  refreshLayout(configs: SceneConfig[], aspect: number): boolean {
    if (configs.length !== this.scenes.length) return false;

    for (let i = 0; i < this.scenes.length; i++) {
      const built = this.scenes[i];
      const cfg = configs[i];

      if (
        !cfg ||
        cfg.id !== built.config.id ||
        cfg.objects.length !== built.config.objects.length
      ) {
        return false;
      }

      // 几何参数**原地**写回 —— SceneBuilder 持有的是同一个对象引用，
      // 所以改这里就等于改了它的 config。
      for (let j = 0; j < built.config.objects.length; j++) {
        const objCfg = built.config.objects[j];
        const next = cfg.objects[j];
        if (next.id !== objCfg.id) return false;

        objCfg.z = next.z;
        objCfg.overscan = next.overscan;
        objCfg.offset = next.offset;
        objCfg.fit = next.fit;
      }

      // 相机与过渡配置整体替换。
      // 相机的 tracks 其实不随 aspect 变（cameraZ/dolly/camY 都是定值），
      // 但替换是幂等的，留着更安全 —— 以后若要按 aspect 调运镜就在这里生效。
      // ★ 必须走 applyCameraConfig：CameraSystem 持有的是旧引用，
      //   直接赋值 `built.config.camera = cfg.camera` 相机不会跟着换。
      built.applyCameraConfig(cfg.camera);
      built.config.transition = cfg.transition;

      // setAspect 会用**更新后的** config.z / config.overscan 重算几何
      built.setAspect(aspect);
    }

    return true;
  }

  dispose(): void {
    for (const s of this.scenes) s.dispose();
  }
}
