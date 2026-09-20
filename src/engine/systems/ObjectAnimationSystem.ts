/**
 * PHASE 7 —— 对象动效系统
 * ===========================================================================
 * 负责一件事：给定场景时间 t，把每个图层的 transform / 可见性 / 透明度
 * 更新到位。
 *
 * ---------------------------------------------------------------------------
 * 【改造前它在哪】
 *
 *   塞在 `SceneBuilder` 的 `BuiltScene.applyTime()` 后半段，
 *   和相机求值挤在同一个函数里。那个函数一改，相机、对象、几何三件事
 *   全都在改动半径内。
 *
 * ---------------------------------------------------------------------------
 * 【它管什么】
 *
 *   ▸ 轨道求值（position / scale / rotation / opacity / visible）
 *   ▸ 位移单位换算与视差倍率 → 交给 ParallaxSystem
 *   ▸ 写进 THREE.Object3D
 *   ▸ 动画 scrub（GLB 的 AnimationMixer）
 *
 * 【它不管什么】
 *
 *   ▸ 相机怎么动        → CameraSystem
 *   ▸ 平面几何怎么建    → SceneBuilder
 *   ▸ 视口比例怎么适应  → SceneBuilder.setAspect（但会把 aspect 同步过来）
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么 AnimatableLayer 是结构化的接口，而不是 import BuiltLayer】
 *
 *   SceneBuilder 会 import 本模块，本模块若再 import BuiltLayer 就成环。
 *   改成结构化接口后，BuiltLayer 天然满足它 —— 编译期照样检查，
 *   运行期零依赖。这条是 `engine/` 内部模块之间该有的样子。
 * ===========================================================================
 */

import type * as THREE from 'three';
import type { SceneObjectConfig, Track } from '../../schema';
import { evaluateTracks } from '../../animation/timeline';
import { applyParallax, type WorldOffset } from './ParallaxSystem';

/** 可被本系统驱动的最小图层信息（BuiltLayer 结构上满足它） */
export interface AnimatableLayer {
  config: SceneObjectConfig;
  /** 位置由轨道驱动的那个节点（plane 是 mesh 本身，model 是外层 group） */
  object: THREE.Object3D;
  /** 仅 plane */
  mesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 仅 model：动画混合器 + 总时长 */
  mixer?: THREE.AnimationMixer;
  clipDuration?: number;
  /** 基准状态下该深度处「刚好铺满视口」的世界高度 */
  baseVisibleH: number;
  /** 基准位置（config 里的 offset），轨道位移叠加在它之上 */
  baseX: number;
  baseY: number;
  /** 该对象的生效轨道（已展开预设） */
  tracks: Track[];
  /** 视差强度倍率 */
  parallax: number;
  /** 每帧复用的求值缓存 */
  values: Record<string, number>;
}

/** visible 轨道的判定阈值：> 0.5 算可见 */
const VISIBLE_THRESHOLD = 0.5;

export class ObjectAnimationSystem {
  /** 位移单位的 X 方向需要 aspect，setAspect 时同步过来 */
  private aspect = 1;
  /** 视差换算的复用输出 */
  private readonly offset: WorldOffset = { x: 0, y: 0 };

  constructor(private readonly layers: AnimatableLayer[]) {}

  /** 视口比例变化时同步（位移单位的 X 方向依赖它） */
  setAspect(aspect: number): void {
    this.aspect = aspect;
  }

  /** 按归一化时间轴 0..1 更新全部图层 */
  apply(t: number): void {
    for (const layer of this.layers) {
      const v = layer.values;
      evaluateTracks(layer.tracks, t, v);

      applyParallax(
        layer,
        v['position.x'] ?? 0,
        v['position.y'] ?? 0,
        this.aspect,
        this.offset,
      );

      layer.object.position.set(
        layer.baseX + this.offset.x,
        layer.baseY + this.offset.y,
        layer.config.z + (v['position.z'] ?? 0),
      );

      layer.object.scale.set(v['scale.x'] ?? 1, v['scale.y'] ?? 1, 1);
      layer.object.rotation.z = v['rotation.z'] ?? 0;

      // visible 轨道：0.5 为界。用来做"主体在转场前先消失"这类效果
      if ('visible' in v) layer.object.visible = v['visible'] > VISIBLE_THRESHOLD;

      if (layer.mesh && 'opacity' in v) layer.mesh.material.opacity = v['opacity'];

      // ★ 动画 scrub：把混合器时间直接设成 t × 时长。
      //   不是 mixer.update(dt) —— 那样动画会自己走，和滚动脱钩。
      //   原站的动画就是被 Theatre 的 sequence.position 拖着走的。
      if (layer.mixer && layer.clipDuration) {
        layer.mixer.setTime(t * layer.clipDuration);
      }
    }
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.mixer?.stopAllAction();
    }
  }
}
