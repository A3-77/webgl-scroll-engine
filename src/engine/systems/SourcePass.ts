/**
 * PHASE 18 —— SourcePass：把「外部纹理」接进 postprocessing 的链
 * ===========================================================================
 * 这一层桥接是整次改造里唯一有点绕的地方，说清楚它为什么必须存在。
 *
 * ---------------------------------------------------------------------------
 * 【问题】
 *
 *   pmndrs/postprocessing 的 EffectComposer 是这样工作的：
 *
 *       pass[0].render(gl, inputBuffer, outputBuffer)
 *       pass[1].render(gl, inputBuffer, outputBuffer)   ← 读的是 pass[0] 写进去的
 *       ...
 *
 *   第一个 pass 通常是一个 RenderPass(scene, camera) —— 它**自己会画一个 Scene**。
 *   但我们这套管线的第一件事不是"画场景"，而是"两张场景已经在别处混好了"：
 *   TransitionSystem 已经把 current/next 混进了 Composer 的 rtComposite。
 *
 *   所以链的起点不是 Scene，而是一张已经存在的纹理。
 *
 * ---------------------------------------------------------------------------
 * 【为什么不让 TransitionSystem 直接画进 composer 的 inputBuffer】
 *
 *   两条理由：
 *   1. 那样 TransitionSystem 就必须 import EffectComposer，
 *      于是"过渡"这个纯渲染概念绑死在某个后处理库上。哪天换库或者降级到
 *      无后处理路径（post.enabled = false），过渡就跟着废了。
 *      现在过渡完全不知道后处理存在 —— 它只管往一个 RenderTarget 里画。
 *   2. composer.inputBuffer 是 postprocessing 的内部双缓冲之一，
 *      直接写它要依赖"当前哪个是 input"这个内部状态，版本一变就崩。
 *
 *   代价：多一次全屏 blit。1080p 下约 0.1ms，换来的是两个系统彻底解耦。
 *
 * ---------------------------------------------------------------------------
 * 【为什么继承 Pass 而不是自己 new 一个 Scene 手动 render】
 *
 *   因为 EffectComposer 需要统一调度：setSize 的广播、renderToScreen 的设置、
 *   needsSwap 的双缓冲交换、enabled 的跳过逻辑。
 *   自己手动 render 就得把这些协议重新实现一遍，而且很容易在
 *   「最后一个 pass 打屏」这个细节上出错。继承 Pass 只需实现 render()。
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { createFullscreenQuad, type FullscreenQuad } from '../fullscreenQuad';
import { FULLSCREEN_VERTEX } from '../../shaders/fullscreen';
import { COPY_FRAGMENT } from '../../shaders/copy';

export class SourcePass extends Pass {
  /** 每帧被覆写的输入纹理。由外部（Composer）持有，本 pass 不拥有它 */
  private texture: THREE.Texture | null;
  private readonly quad: FullscreenQuad;

  constructor(texture: THREE.Texture | null = null) {
    // ★ 先建好 quad 再 super()：Pass 的构造签名是 (name, scene, camera)，
    //   把已有的 fullscreenQuad 直接交进去，就不必再搭一遍全屏三角。
    //   JS 允许在 super() 之前做「不触碰 this」的计算，这里是安全的。
    const quad = createFullscreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: COPY_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        uniforms: { tDiffuse: { value: null } },
      }),
    );

    super('SourcePass', quad.scene, quad.camera);

    this.quad = quad;
    this.texture = texture;

    // 必须 true：本 pass 确实往 outputBuffer 里写了东西，
    // composer 需要在它之后交换双缓冲，否则下一个 pass 会读到空缓冲。
    this.needsSwap = true;
  }

  setTexture(texture: THREE.Texture | null): void {
    this.texture = texture;
  }

  /**
   * @param inputBuffer   忽略 —— 本 pass 不用上一个 pass 的结果
   * @param outputBuffer  写入目标；renderToScreen 为 true 时改打屏幕
   */
  override render(
    renderer: THREE.WebGLRenderer,
    _inputBuffer: THREE.WebGLRenderTarget | null,
    outputBuffer: THREE.WebGLRenderTarget | null,
  ): void {
    if (!this.texture) return;

    this.quad.mesh.material.uniforms.tDiffuse.value = this.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.clear();
    renderer.render(this.quad.scene, this.quad.camera);
  }

  override dispose(): void {
    this.quad.dispose();
    super.dispose();
  }
}
