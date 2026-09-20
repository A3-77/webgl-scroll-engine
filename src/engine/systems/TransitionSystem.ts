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
 *   ▸ 混合完之后的高光    → BloomSystem
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
}

export class TransitionSystem {
  private rtCurrent!: THREE.WebGLRenderTarget;
  private rtNext!: THREE.WebGLRenderTarget;
  private readonly quad: FullscreenQuad;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** 复用，避免每帧 new Matrix4 */
  private readonly projView = new THREE.Matrix4();
  /** setSize 之前 render 会被调到 —— 没有尺寸就什么都不画，别崩 */
  private ready = false;

  constructor(transitionTextures?: TransitionTextures) {
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

    const u = this.quad.mesh.material.uniforms;
    (u.uResolution.value as THREE.Vector2).set(w, h);
    u.uAspect.value = aspect;

    this.ready = true;
  }

  /**
   * @param out 合成目标。传 null 表示直接打到屏幕（bloom 关闭时走这条，省两次全屏 blit）
   */
  render(gl: THREE.WebGLRenderer, input: TransitionInput, out: THREE.WebGLRenderTarget | null): void {
    if (!this.ready) return;

    const { currentScene, nextScene } = input;

    // ① current → rtCurrent
    gl.setRenderTarget(this.rtCurrent);
    gl.clear();
    gl.render(currentScene.scene, currentScene.camera);

    // ② next → rtNext
    //    没有 next 时复用 rtCurrent 的纹理：这样即使过渡 shader 因噪声扰动
    //    渗出一点 blendFactor，混合的也是同一张图，不会出现残影
    let nextTexture: THREE.Texture = this.rtCurrent.texture;
    if (nextScene) {
      gl.setRenderTarget(this.rtNext);
      gl.clear();
      gl.render(nextScene.scene, nextScene.camera);
      nextTexture = this.rtNext.texture;
    }

    // ③ 双纹理 → 过渡
    const u = this.quad.mesh.material.uniforms;
    u.tCurrent.value = this.rtCurrent.texture;
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

    gl.setRenderTarget(out);
    gl.clear();
    gl.render(this.quad.scene, this.quadCamera);
  }

  dispose(): void {
    this.rtCurrent?.dispose();
    this.rtNext?.dispose();
    this.quad.dispose();
    this.ready = false;
  }
}
