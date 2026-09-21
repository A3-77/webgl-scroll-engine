/**
 * PHASE 8 —— 过渡系统
 * ===========================================================================
 * 负责一件事：把「当前章节画面」和「下一章节画面」混成一张，输出到指定目标。
 *
 * ---------------------------------------------------------------------------
 * 【改造前它在哪】
 *
 *   塞在 `Composer.render()` 里（第 ③④ 步）：建 RenderTarget、建 quad、
 *   设 11 个 uniform、算投影矩阵、blit —— 全挤在一个 100 行的函数体里，
 *   和 bloom 的 3 个 pass 首尾相接。想单独调过渡，得在 bloom 的代码里翻。
 *
 * ---------------------------------------------------------------------------
 * 【它管什么】
 *
 *   ▸ rtCurrent / rtNext 两张离屏纹理的生命周期
 *   ▸ 场景 → 纹理（每个章节一个独立 Scene + Camera，各渲各的）
 *   ▸ 过渡 shader 的全部 uniform
 *   ▸ 过渡 blit 到「合成目标」或「屏幕」
 *
 * 【它不管什么】
 *
 *   ▸ 场景怎么求值        → SceneManager / CameraSystem / ObjectAnimationSystem
 *   ▸ 过渡进度怎么算      → animation/scrollProgress.transitionProgress
 *   ▸ 混合完之后的高光    → PostSystem（后处理链）
 *
 * ---------------------------------------------------------------------------
 * 【为什么要先各渲到纹理，而不是"直接渲两个场景到屏幕再混合"】
 *
 *   因为 WebGL 没有"读回当前 framebuffer 再混合"的廉价手段。
 *   过渡效果需要同时访问两张完整画面（还要对它们做 fwidth 导数运算），
 *   唯一可行且高性能的方式就是各自先渲到纹理。真实站点用的
 *   pmndrs/postprocessing 的 EffectComposer 走的是同一条路
 *   （实测它的 Buffer 是 1279×812）。
 *
 * ---------------------------------------------------------------------------
 * 【★ 求值顺序：两个场景先各自 applyTime，再一起渲染】
 *
 *   改造前是「求值 current → 渲 current → 求值 next → 渲 next」交替进行。
 *   改成「先求值两个，再渲染两个」是安全的：
 *   applyTime 只改各自场景图里的 Object3D / Camera，两个场景互不共享节点。
 *   这样 render() 的参数可以一次给全，调用方不必关心内部要几次 setRenderTarget。
 * ===========================================================================
 */

import * as THREE from 'three';
import type { BuiltScene } from '../SceneBuilder';
import { createFullscreenQuad, type FullscreenQuad } from '../fullscreenQuad';
import { FULLSCREEN_VERTEX } from '../../shaders/fullscreen';
import { TRANSITION_FRAGMENT } from '../../shaders/transition';
import type { MediumSystem } from './MediumSystem';

export interface TransitionTextures {
  noise?: THREE.Texture | null;
  displacement?: THREE.Texture | null;
}

/** 每帧喂给过渡的输入 */
export interface TransitionInput {
  currentScene: BuiltScene;
  /** 没有下一章时传 null —— 内部会把 tNext 指向 rtCurrent 的纹理（见 render 注释） */
  nextScene: BuiltScene | null;
  /** 0..1，已按「本章尾段」重新归一化（用 raw progress 会在切换瞬间跳变） */
  uProgress: number;
  /** 墙上时钟秒数，驱动 shader 里的噪声扰动 */
  timeSec: number;
  /** 归一化鼠标坐标 [0..1, 0..1] */
  mouse: readonly [number, number];
  /**
   * 3D 过渡载体（PHASE 23）。不传 = 无载体，行为与改造前一致。
   *
   * 只吃三个**纯数据**而不是整个 CarrierSystem —— 过渡系统不必知道
   * 载体是怎么飞、沿什么曲线飞的，它只需要"此刻它在哪、影响多大"。
   */
  carrier?: {
    /** 世界坐标 */
    position: THREE.Vector3;
    /** 溶解跟随强度 0..1 */
    follow: number;
    /** 有机边缘强度 */
    organic: number;
  } | null;
  /**
   * 滚动活跃度 0..1（PHASE 25）。
   *
   * 媒介层的 pulse 用它展开。★ 和 PostSystem 吃的是**同一个值** ——
   * 所以"切章时网点变粗"和"切章时色差炸开"严格同步，
   * 是同一件事的两面，不是两条各自跑着的轨道。
   */
  activity?: number;
}

export class TransitionSystem {
  private rtCurrent!: THREE.WebGLRenderTarget;
  private rtNext!: THREE.WebGLRenderTarget;
  /**
   * ★ 深度纹理（PHASE 25）。
   *
   * 它是媒介层能做墨线的前提。挂在场景的 RenderTarget 上 ——
   * 这样渲染场景时深度**顺带**就写进去了，零额外 draw call。
   *
   * 为什么要在这里持有：深度只在"场景渲染"那一刻存在。
   * 一旦两张画面混成一张，"这个像素离相机多远"就永久丢失了。
   * 所以必须在混合**之前**把它交给媒介层用掉。
   */
  private depthCurrent: THREE.DepthTexture | null = null;
  private depthNext: THREE.DepthTexture | null = null;
  /**
   * 媒介层（PHASE 25）。不传 = 一个 pass 都不跑，行为与改造前逐位相同。
   *
   * ★ 用依赖注入而不是 import 具体实现，和 transitionTextures 同一个理由：
   *   过渡系统只负责"把场景变成纹理"，至于这张纹理要不要被重绘，
   *   是编排器（Composer）决定的事。
   */
  private readonly medium: MediumSystem | null;
  private readonly quad: FullscreenQuad;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** 复用，避免每帧 new Matrix4 */
  private readonly projView = new THREE.Matrix4();
  /** setSize 之前 render 会被调到 —— 没有尺寸就什么都不画，别崩 */
  private ready = false;

  constructor(transitionTextures?: TransitionTextures, medium?: MediumSystem) {
    this.medium = medium ?? null;
    const material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: TRANSITION_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tCurrent: { value: null },
        tNext: { value: null },
        tMudNormal: { value: transitionTextures?.displacement ?? null },
        tNoise: { value: transitionTextures?.noise ?? null },
        uProgress: { value: 0 },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uMouse: { value: new THREE.Vector2(0.5, 0.5) },
        uIsHero: { value: 1 },
        uIsFallback: { value: 0 },
        uProjectionView: { value: new THREE.Matrix4() },
        uFadeCenterPoint: { value: new THREE.Vector3() },
        uDarken: { value: 0 },
        // ---- PHASE 23：3D 载体 ----
        // 全部为 0 时 shader 行为与改造前逐位相同，未声明载体的内容包不受影响
        uCarrierPoint: { value: new THREE.Vector3() },
        uCarrierFollow: { value: 0 },
        uCarrierOrganic: { value: 0 },
      },
    });
    this.quad = createFullscreenQuad(material, this.quadCamera);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    const aspect = width / height;

    this.rtCurrent?.dispose();
    this.rtNext?.dispose();
    this.depthCurrent?.dispose();
    this.depthNext?.dispose();

    // HalfFloat：给后续 bloom 留出 >1 的余量，高光叠加不会被 clamp 成死白
    const options: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };

    this.rtCurrent = new THREE.WebGLRenderTarget(w, h, options);
    this.rtNext = new THREE.WebGLRenderTarget(w, h, options);

    // ★ 只有媒介层在跑时才挂深度纹理。
    //   多挂一张 24 位深度纹理 = 每帧多写 w×h×4 字节的带宽，
    //   而不用媒介层的内容包（shopify / placeholder）完全不需要它。
    //   「不声明就没有开销」是引擎的硬约定。
    if (this.medium?.active) {
      this.depthCurrent = new THREE.DepthTexture(w, h);
      this.depthNext = new THREE.DepthTexture(w, h);
      this.rtCurrent.depthTexture = this.depthCurrent;
      this.rtNext.depthTexture = this.depthNext;
    } else {
      this.depthCurrent = null;
      this.depthNext = null;
    }

    const u = this.quad.mesh.material.uniforms;
    (u.uResolution.value as THREE.Vector2).set(w, h);
    u.uAspect.value = aspect;

    // 媒介层自己那两张重绘目标的尺寸
    this.medium?.setSize(width, height, pixelRatio);

    this.ready = true;
  }

  /**
   * @param out 合成目标。传 null 表示直接打到屏幕（bloom 关闭时走这条，省两次全屏 blit）
   */
  render(gl: THREE.WebGLRenderer, input: TransitionInput, out: THREE.WebGLRenderTarget | null): void {
    if (!this.ready) return;

    const { currentScene, nextScene } = input;
    const medium = this.medium;
    const activity = input.activity ?? 0;

    // ① current → rtCurrent
    gl.setRenderTarget(this.rtCurrent);
    gl.clear();
    gl.render(currentScene.scene, currentScene.camera);

    // ①' 媒介重绘（PHASE 25）
    //     ★ 必须在这里做，不能等到过渡之后 —— 深度只在这一刻有效。
    //       两张画面一旦混合，"这个像素离相机多远"就永久丢失了。
    let currentTexture: THREE.Texture = this.rtCurrent.texture;
    if (medium?.active) {
      currentTexture = medium.apply(
        gl,
        0,
        currentTexture,
        this.depthCurrent,
        currentScene.camera as THREE.PerspectiveCamera,
        input.timeSec,
        activity,
      );
    }

    // ② next → rtNext
    //    没有 next 时复用 current 的纹理：这样即使过渡 shader 因噪声扰动
    //    渗出一点 blendFactor，混合的也是同一张图，不会出现残影
    //    ★ 复用的一定是**重绘之后**的那张，否则没有下一章时画面会突然
    //      从"印刷品"跳回"照片"（章节末尾的瞬间闪烁，实测可见）
    let nextTexture: THREE.Texture = currentTexture;
    if (nextScene) {
      gl.setRenderTarget(this.rtNext);
      gl.clear();
      gl.render(nextScene.scene, nextScene.camera);
      nextTexture = this.rtNext.texture;
      if (medium?.active) {
        nextTexture = medium.apply(
          gl,
          1,
          nextTexture,
          this.depthNext,
          nextScene.camera as THREE.PerspectiveCamera,
          input.timeSec,
          activity,
        );
      }
    }

    // ③ 双纹理 → 过渡
    const u = this.quad.mesh.material.uniforms;
    u.tCurrent.value = currentTexture;
    u.tNext.value = nextTexture;
    u.uProgress.value = input.uProgress;
    u.uTime.value = input.timeSec;
    (u.uMouse.value as THREE.Vector2).set(input.mouse[0], 1 - input.mouse[1]);

    // 过渡模式 → shader 的 uIsHero。
    // 'radial' 走圆形径向溶解（原站 Hero 首屏），'sweep' 走斜向擦除。
    // 改造前这里读的是 `config.isHero` —— 那个布尔值同时暗示了"这是第一章"
    // 和"这是圆形溶解"，两件事被绑死，想给第 3 章也用圆形溶解就没法表达。
    u.uIsHero.value = currentScene.config.transition.mode === 'radial' ? 1 : 0;
    u.uIsFallback.value = 0; // Demo 不走 DOM fallback 分支
    u.uDarken.value = 0;
    (u.uFadeCenterPoint.value as THREE.Vector3).fromArray(
      currentScene.config.transition.fadeCenter,
    );

    // uProjectionView：把世界坐标的"溶解中心"投影到屏幕空间
    currentScene.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(
      currentScene.camera.projectionMatrix,
      currentScene.camera.matrixWorldInverse,
    );
    (u.uProjectionView.value as THREE.Matrix4).copy(this.projView);

    // ---- 载体：溶解中心跟着它走（PHASE 23） ----
    // 必须在 uProjectionView 更新**之后**写，两个 uniform 是配套的。
    const carrier = input.carrier;
    if (carrier) {
      (u.uCarrierPoint.value as THREE.Vector3).copy(carrier.position);
      u.uCarrierFollow.value = carrier.follow;
      u.uCarrierOrganic.value = carrier.organic;
    } else {
      u.uCarrierFollow.value = 0;
      u.uCarrierOrganic.value = 0;
    }

    gl.setRenderTarget(out);
    gl.clear();
    gl.render(this.quad.scene, this.quadCamera);
  }

  dispose(): void {
    this.rtCurrent?.dispose();
    this.rtNext?.dispose();
    this.depthCurrent?.dispose();
    this.depthNext?.dispose();
    this.quad.dispose();
    this.ready = false;
  }
}
