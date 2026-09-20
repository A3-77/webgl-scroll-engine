/**
 * PHASE 9 —— Bloom（高光溢出）系统
 * ===========================================================================
 * 负责一件事：拿一张合成好的画面，提取高光 → 模糊 → 叠回原图输出。
 *
 * ---------------------------------------------------------------------------
 * 【改造前它在哪】
 *
 *   塞在 `Composer.render()` 的第 ⑤⑥⑦ 步：亮度提取、横竖两次高斯、
 *   最终合成，四段 blit 代码直接躺在渲染主流程里，和过渡 shader 首尾相接。
 *   想关掉 bloom 看过渡的原始输出，得读懂整段才知道该改哪。
 *
 * ---------------------------------------------------------------------------
 * 【三个 pass】
 *
 *   ① 亮度提取   源图 → 阈值+软膝 → rtBright（半分辨率）
 *   ② 可分离高斯 横 → 竖（rtBright → rtBlurA → rtBlurB）
 *   ③ 合成       原图 + bloom × strength → 输出
 *
 *   为什么模糊要走半分辨率：真实站点实测 Bloom 内部降到 640×406
 *   （约 1/2）后开始上采样。人眼看不出，但省掉 3/4 的像素。
 *
 *   为什么高斯要拆成横竖两次：9-tap 的二维高斯要 81 次采样，
 *   拆成两次一维只要 9+9 = 18 次，结果完全等价（可分离性）。
 *
 * ---------------------------------------------------------------------------
 * 【★ 阈值与软膝是这套观感的旋钮】
 *
 *   threshold 0.62 / softKnee 0.55 / strength 0.85 是实测调出来的：
 *     threshold 太低 → 整张图都发光，画面发灰
 *     threshold 太高 → 只有最亮的一小块有光晕，看不出效果
 *     softKnee 是阈值附近的过渡带宽度，避免高光边缘出现硬边
 *
 *   注意这套值依赖上游的 NeutralToneMapping（见 CanvasHost.tsx）。
 *   没有滚降的话，超过 1.0 的像素会被硬截断成死白，bloom 会糊成一片。
 * ===========================================================================
 */

import * as THREE from 'three';
import { createFullscreenQuad, type FullscreenQuad } from '../fullscreenQuad';
import { FULLSCREEN_VERTEX } from '../../shaders/fullscreen';
import {
  BLOOM_BRIGHT_FRAGMENT,
  BLOOM_BLUR_FRAGMENT,
  BLOOM_COMPOSITE_FRAGMENT,
} from '../../shaders/bloom';

export interface BloomOptions {
  /** 高光阈值 0..1 */
  threshold?: number;
  /** 阈值附近的软过渡带宽度 0..1 */
  softKnee?: number;
  /** bloom 叠加强度 */
  strength?: number;
}

/** 半分辨率：真实站点实测 Bloom 内部降到约 1/2 后开始上采样 */
const DOWNSCALE = 2;

export class BloomSystem {
  private rtBright!: THREE.WebGLRenderTarget;
  private rtBlurA!: THREE.WebGLRenderTarget;
  private rtBlurB!: THREE.WebGLRenderTarget;
  private readonly brightQuad: FullscreenQuad;
  private readonly blurQuad: FullscreenQuad;
  private readonly compositeQuad: FullscreenQuad;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private ready = false;

  constructor(options: BloomOptions = {}) {
    this.brightQuad = createFullscreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: BLOOM_BRIGHT_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tDiffuse: { value: null },
          uThreshold: { value: options.threshold ?? 0.62 },
          uSoftKnee: { value: options.softKnee ?? 0.55 },
        },
      }),
      this.quadCamera,
    );

    this.blurQuad = createFullscreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: BLOOM_BLUR_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tDiffuse: { value: null },
          uDirection: { value: new THREE.Vector2() },
        },
      }),
      this.quadCamera,
    );

    this.compositeQuad = createFullscreenQuad(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: BLOOM_COMPOSITE_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tDiffuse: { value: null },
          tBloom: { value: null },
          uStrength: { value: options.strength ?? 0.85 },
        },
      }),
      this.quadCamera,
    );
  }

  /** 运行时改旋钮（调试面板会用） */
  setParams(params: BloomOptions): void {
    if (params.threshold !== undefined) {
      this.brightQuad.mesh.material.uniforms.uThreshold.value = params.threshold;
    }
    if (params.softKnee !== undefined) {
      this.brightQuad.mesh.material.uniforms.uSoftKnee.value = params.softKnee;
    }
    if (params.strength !== undefined) {
      this.compositeQuad.mesh.material.uniforms.uStrength.value = params.strength;
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));

    this.rtBright?.dispose();
    this.rtBlurA?.dispose();
    this.rtBlurB?.dispose();

    const options: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };

    const bw = Math.max(1, Math.floor(w / DOWNSCALE));
    const bh = Math.max(1, Math.floor(h / DOWNSCALE));
    this.rtBright = new THREE.WebGLRenderTarget(bw, bh, options);
    this.rtBlurA = new THREE.WebGLRenderTarget(bw, bh, options);
    this.rtBlurB = new THREE.WebGLRenderTarget(bw, bh, options);

    this.ready = true;
  }

  /**
   * @param source 合成好的画面（过渡系统的输出）
   * @param out    输出目标。传 null 打到屏幕
   */
  render(
    gl: THREE.WebGLRenderer,
    source: THREE.Texture,
    out: THREE.WebGLRenderTarget | null,
  ): void {
    if (!this.ready) return;

    // ① 亮度提取
    this.brightQuad.mesh.material.uniforms.tDiffuse.value = source;
    gl.setRenderTarget(this.rtBright);
    gl.clear();
    gl.render(this.brightQuad.scene, this.quadCamera);

    // ② 可分离高斯：横 → 竖
    const blurU = this.blurQuad.mesh.material.uniforms;
    const bw = this.rtBright.width;
    const bh = this.rtBright.height;

    blurU.tDiffuse.value = this.rtBright.texture;
    (blurU.uDirection.value as THREE.Vector2).set(1 / bw, 0);
    gl.setRenderTarget(this.rtBlurA);
    gl.clear();
    gl.render(this.blurQuad.scene, this.quadCamera);

    blurU.tDiffuse.value = this.rtBlurA.texture;
    (blurU.uDirection.value as THREE.Vector2).set(0, 1 / bh);
    gl.setRenderTarget(this.rtBlurB);
    gl.clear();
    gl.render(this.blurQuad.scene, this.quadCamera);

    // ③ 合成
    const compU = this.compositeQuad.mesh.material.uniforms;
    compU.tDiffuse.value = source;
    compU.tBloom.value = this.rtBlurB.texture;
    gl.setRenderTarget(out);
    gl.clear();
    gl.render(this.compositeQuad.scene, this.quadCamera);
  }

  dispose(): void {
    this.rtBright?.dispose();
    this.rtBlurA?.dispose();
    this.rtBlurB?.dispose();
    this.brightQuad.dispose();
    this.blurQuad.dispose();
    this.compositeQuad.dispose();
    this.ready = false;
  }
}
