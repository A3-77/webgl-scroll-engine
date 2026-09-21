/**
 * PHASE 25 —— 媒介层系统
 * ===========================================================================
 * 负责一件事：把一张渲染结果**重绘成另一种材料**，然后交还给过渡系统。
 *
 * ---------------------------------------------------------------------------
 * 【它在渲染链里的位置 —— 这一点很关键】
 *
 *   本引擎每帧的链路是：
 *
 *     场景 → 纹理 → 过渡混合 → 载体 → 后处理 → 屏幕
 *
 *   媒介层插在**「场景 → 纹理」之后、「过渡混合」之前**：
 *
 *     场景 → 纹理 → 媒介重绘 → 过渡混合 → 载体 → 后处理 → 屏幕
 *                    ^^^^^^^^ 这里
 *
 *   为什么不在过渡之后统一重绘一次？因为那样就拿不到深度了。
 *
 *   ★ 深度缓冲是**每个场景各自渲染时产生的**。一旦两张画面混成一张，
 *     "这个像素属于哪个物体、离相机多远"就永久丢失了 ——
 *     墨线、雾、景深这类要读深度的效果全部做不了。
 *     iamsaeed.dev 就是踩在这个问题上：他们的印刷层在过渡**之后**，
 *     所以必须额外搞一条 `pjtCovered` 覆盖通道，把"这个像素已经被
 *     过渡替换过了"标出来，再让墨线在那块闭嘴 ——
 *     否则入画章节的墨线会被当成线框，画在出画章节的快照上面。
 *
 *   我们把媒介层放在过渡之前，就**完全绕开了这个问题**：
 *   每个场景重绘自己那一张，深度天然是对的，不需要覆盖通道。
 *   代价是过渡溶解的是"两张已经印好的画面"——
 *   而这恰好是对的观感：翻页翻的是两张印刷品，不是一块玻璃。
 *
 * ---------------------------------------------------------------------------
 * 【它管什么】
 *
 *   ▸ 媒介 shader 的全部 uniform
 *   ▸ 两张重绘目标的离屏纹理（current / next 各一张）
 *   ▸ 「声明 + 活跃度 → 实际 uniform」的展开（委托给 resolveMedium）
 *
 * 【它不管什么】
 *
 *   ▸ 场景怎么渲染、深度怎么产生  → TransitionSystem（它持有 RenderTarget）
 *   ▸ 两张画面怎么混              → TransitionSystem
 *   ▸ 混合完之后的滤镜            → PostSystem
 *
 * ---------------------------------------------------------------------------
 * 【★ 零行为变更契约】
 *
 *   `enabled: false`（或不声明）时：
 *     ▸ 构造函数里就标记 inactive
 *     ▸ TransitionSystem 会**完全跳过** apply() —— 一个 pass 都不跑，
 *       两张重绘目标也不会被分配
 *     ▸ 画面与 PHASE 25 之前逐位相同
 * ===========================================================================
 */

import * as THREE from 'three';
import { createFullscreenQuad, type FullscreenQuad } from '../fullscreenQuad';
import { FULLSCREEN_VERTEX } from '../../shaders/fullscreen';
import { MEDIUM_FRAGMENT } from '../../shaders/medium';
import { resolveMedium, type MediumConfig } from '../../schema/medium';

export interface MediumStats {
  /** 媒介层是否在跑 */
  active: boolean;
  /** 累计重绘次数（每帧最多 2 次：current + next） */
  passes: number;
  /** 本帧展开后的网点强度（调试用 —— 看它就能判断 pulse 有没有在工作） */
  halftone: number;
  /** 本帧展开后的墨线强度 */
  inkEdge: number;
}

/** 重绘目标槽位。0 = current，1 = next */
export type MediumSlot = 0 | 1;

export class MediumSystem {
  private readonly config: MediumConfig;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullscreenQuad;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /**
   * 两张重绘目标。为什么要两张而不是一张：
   * 同一帧里 current 和 next 都要重绘，而一个 RenderTarget 不能
   * 同时当输入和输出 —— 用一张会读到上一帧的内容（画面糊掉）。
   */
  private rtA: THREE.WebGLRenderTarget | null = null;
  private rtB: THREE.WebGLRenderTarget | null = null;

  /**
   * ★ 必须记住 pixelRatio，用来换算网点尺寸。
   *
   * `halftoneScale` 的语义是 **CSS 像素** —— 它描述的是"纸上网点多大"，
   * 应该在任何屏幕上都一样大。而 shader 里的 `gl_FragCoord` 是**设备像素**。
   *
   * 直接拿两者相除的话：dpr=1 的屏上网点周期是 6px，dpr=2 的屏上就变成 3px ——
   * 同一个配置在两台机器上观感差一倍，而且 retina 上细到看不见。
   * 这是"素材驱动"最不能忍的那类 bug：配置没变，效果却变了。
   */
  private pixelRatio = 1;

  private ready = false;

  readonly stats: MediumStats = { active: false, passes: 0, halftone: 0, inkEdge: 0 };

  constructor(config: MediumConfig) {
    this.config = config;
    // ★ enabled 默认 false。媒介层是"强风格"的开关，
    //   默认开会让所有既有内容包画面突变 —— 必须是显式声明才生效。
    this.stats.active = config.enabled === true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: MEDIUM_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 100 },
        uTime: { value: 0 },
        uHasDepth: { value: 0 },

        uMono: { value: 0 },
        uBlackPoint: { value: 0 },
        uWhitePoint: { value: 1 },
        uContrast: { value: 0 },
        uHalftone: { value: 0 },
        uHalftoneScale: { value: 5 },
        uHalftoneAngle: { value: 45 },
        uDither: { value: 0 },
        uDitherLevels: { value: 6 },
        uInkEdge: { value: 0 },
        uInkThreshold: { value: 0.06 },
        uPaper: { value: 0 },
        uPaperColor: { value: new THREE.Color('#efe7d6') },
        uInkColor: { value: new THREE.Color('#1a1714') },
        uGrain: { value: 0 },
        uGrainSpeed: { value: 1 },
      },
    });

    this.quad = createFullscreenQuad(this.material, this.quadCamera);
  }

  /** 媒介层是否在跑。false 时调用方应完全跳过 apply() */
  get active(): boolean {
    return this.stats.active;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    if (!this.stats.active) return;

    this.pixelRatio = Math.max(pixelRatio, 1e-3);
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));

    this.rtA?.dispose();
    this.rtB?.dispose();

    // 与场景纹理同样的精度 —— 重绘是**在画面本身上做减法**，
    // 用 byte 会把 >1 的高光先夹死，bloom 就再也补不回来了
    const options: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // 重绘是纯全屏 pass，不需要自己的深度
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(w, h, options);
    this.rtB = new THREE.WebGLRenderTarget(w, h, options);

    (this.material.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.ready = true;
  }

  /**
   * 把一张场景纹理重绘到指定的槽位。
   *
   * @param slot      0 = current，1 = next。两张目标必须错开
   * @param src       场景渲染结果
   * @param depth     该场景的深度纹理。传 null 时墨线降级为纯亮度梯度
   * @param camera    提供 near / far —— 深度线性化必须知道这两个值
   * @param timeSec   墙上时钟秒数，驱动持续颗粒
   * @param activity  滚动活跃度 0..1，展开 pulse 用
   * @returns         重绘后的纹理（可直接喂给过渡 shader）
   */
  apply(
    gl: THREE.WebGLRenderer,
    slot: MediumSlot,
    src: THREE.Texture,
    depth: THREE.Texture | null,
    camera: THREE.PerspectiveCamera,
    timeSec: number,
    activity: number,
  ): THREE.Texture {
    const target = slot === 0 ? this.rtA : this.rtB;
    // 没准备好就原样返回 —— 宁可少一层风格，也不要黑屏
    if (!this.ready || !target) return src;

    const r = resolveMedium(this.config, activity);
    const u = this.material.uniforms;

    u.tDiffuse.value = src;
    u.tDepth.value = depth;
    u.uHasDepth.value = depth ? 1 : 0;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uTime.value = timeSec;

    u.uMono.value = r.mono;
    u.uBlackPoint.value = r.blackPoint;
    u.uWhitePoint.value = r.whitePoint;
    u.uContrast.value = r.contrast;
    u.uHalftone.value = r.halftone;
    // ★ × pixelRatio：halftoneScale 是 CSS 像素，gl_FragCoord 是设备像素。
    //   不换算的话同一个配置在 retina 上网点会细一倍（理由见字段注释）
    u.uHalftoneScale.value = r.halftoneScale * this.pixelRatio;
    u.uHalftoneAngle.value = r.halftoneAngle;
    u.uDither.value = r.dither;
    u.uDitherLevels.value = r.ditherLevels;
    u.uInkEdge.value = r.inkEdge;
    u.uInkThreshold.value = r.inkThreshold;
    u.uPaper.value = r.paper;
    // ★ 用 THREE.Color 而不是手写归一化 —— 它会在 ColorManagement 开启时
    //   把 sRGB 的十六进制**转成线性空间**。渲染目标里存的是线性值，
    //   直接把 sRGB 数值塞进 uniform 会让纸色偏亮（实测肉眼可辨）
    (u.uPaperColor.value as THREE.Color).set(r.paperColor);
    (u.uInkColor.value as THREE.Color).set(r.inkColor);
    u.uGrain.value = r.grain;
    u.uGrainSpeed.value = r.grainSpeed;

    gl.setRenderTarget(target);
    gl.clear();
    gl.render(this.quad.scene, this.quadCamera);
    gl.setRenderTarget(null);

    this.stats.passes++;
    this.stats.halftone = r.halftone;
    this.stats.inkEdge = r.inkEdge;

    return target.texture;
  }

  dispose(): void {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = null;
    this.rtB = null;
    this.quad.dispose();
    this.ready = false;
  }
}
