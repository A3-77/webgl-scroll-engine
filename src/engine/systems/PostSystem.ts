/**
 * PHASE 18 —— 后处理系统
 * ===========================================================================
 * 接住过渡系统的输出，跑一条**声明式**的效果链，最后打屏。
 *
 * ---------------------------------------------------------------------------
 * 【改造前 vs 改造后】
 *
 *   改造前：整条链只有自制 BloomSystem 一个东西
 *     （亮度提取 → 半分辨率横竖高斯 → 叠回，3 个 pass / 4 次全屏 blit）。
 *   它够用，但**不可配置** —— 想加胶片颗粒就得手写 shader 再改 Composer，
 *   等于「换观感 = 改引擎」，与本项目「换素材不改代码」的目标背道而驰。
 *
 *   改造后：换成 pmndrs/postprocessing。
 *     ▸ Bloom 升级成 mipmap 金字塔模糊（比固定半径高斯质量高一个档次）
 *     ▸ 额外拿到色差 / 颗粒 / 暗角 / 扫描线 / 故障 / 调色等 30+ 现成效果
 *     ▸ 全部效果由 schema 声明驱动（src/schema/post.ts），内容包不写 shader
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么效果能合并成一个 pass】
 *
 *   postprocessing 的 EffectPass 会把传进去的**所有 Effect 编译进同一个
 *   fragment shader**（它把每个效果的 mainImage() 串成一段代码）。
 *   所以叠 8 个效果仍然是 1 次全屏绘制 —— 这是它比"每个效果一个 pass"
 *   快一个数量级的原因，也是本项目敢默认开 5 个效果的底气。
 *
 *   唯一额外开销是 Bloom：它内部有自己的亮度/模糊金字塔，不受合并影响。
 *
 * ---------------------------------------------------------------------------
 * 【★ pulse：让后处理跟着滚动呼吸】
 *
 *   静止的滤镜一眼假。参考站点（shader.se / iamsaeed.dev）的画面有生命感，
 *   是因为滤镜强度在跟着滚动变化。本系统每帧收到一个「活跃度」：
 *
 *       activity = 过渡活跃度 + 速度活跃度        （各自 0..1，取和后钳制）
 *
 *   然后每个效果按自己的 pulse 系数放大：
 *
 *       intensity = base × (1 + pulse × activity)
 *
 *   活跃度还过了一层指数平滑（时间常数 SMOOTHING_TAU），
 *   所以效果是"涌上来又缓缓退下去"，而不是跟着速度逐帧抖。
 *   没有这层平滑，快速滚动时颗粒会像噪点一样闪，非常廉价。
 *
 * ---------------------------------------------------------------------------
 * 【为什么不用 @react-three/postprocessing】
 *
 *   那是 R3F 的声明式封装，本项目是原生 three.js 命令式管线（Composer 持有
 *   自己的 RenderTarget 与 rAF 循环）。用它等于为了一个库把整个渲染层改成
 *   React 组件树 —— 收益（JSX 好看）远小于代价。
 *   postprocessing 本身的 imperative API 已经足够。
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  GlitchEffect,
  HueSaturationEffect,
  NoiseEffect,
  ScanlineEffect,
  VignetteEffect,
  type Effect,
} from 'postprocessing';
import type { PostConfig, PostEffectSpec } from '../../schema/post';
import { SourcePass } from './SourcePass';

/* ------------------------------------------------------------ 常量 */

/**
 * 活跃度平滑的时间常数（秒）。
 *
 * 0.12 的含义：活跃度跳变后约 0.12s 追上 63%，约 0.4s 基本稳定。
 * 再短就跟没平滑一样（颗粒逐帧闪）；再长就变成"滚完了效果还在"。
 */
const SMOOTHING_TAU = 0.12;

/** 速度归一化参考值（px/帧）。Lenis 快速滚动时的典型量级 */
const VELOCITY_REF = 55;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------------------------------------ 每帧驱动量 */

export interface PostDrive {
  /**
   * 过渡活跃度 0..1。
   * 由 Composer 用 sin(π × uProgress) 算出 —— 两端为 0、过渡中点最强。
   * 用 sin 而不是直接用 uProgress，是为了保证章节切换的瞬间左右连续（都是 0），
   * 否则每换一章效果强度都会"跳"一下。
   */
  transition: number;
  /** 滚动速度（px/帧，带符号）。内部取绝对值后按 VELOCITY_REF 归一化 */
  velocity: number;
}

/* ------------------------------------------------------------ 绑定后的效果 */

interface BoundEffect {
  kind: PostEffectSpec['kind'];
  effect: Effect;
  /** 参与脉冲的基准值，个数与语义由 apply 决定 */
  base: number[];
  pulse: number;
  apply(activity: number): void;
}

/* ------------------------------------------------------------ 系统 */

export interface PostSystemStats {
  /** 实际生效的效果数（禁用的不算） */
  effectCount: number;
  /** 平滑后的活跃度 0..1。调试时看它就能判断 pulse 有没有在工作 */
  activity: number;
  /** 链里的 pass 数（SourcePass + EffectPass） */
  passCount: number;
}

export class PostSystem {
  private readonly composer: EffectComposer;
  private readonly sourcePass: SourcePass;
  private effectPass: EffectPass | null = null;

  private readonly bound: BoundEffect[] = [];
  private readonly enabled: boolean;

  /** 平滑后的活跃度。跨帧持有 —— 这是本系统唯一的"状态" */
  private activity = 0;

  readonly stats: PostSystemStats = { effectCount: 0, activity: 0, passCount: 0 };

  constructor(gl: THREE.WebGLRenderer, config: PostConfig = { effects: [] }) {
    this.enabled = config.enabled ?? true;

    this.composer = new EffectComposer(gl, {
      // HalfFloat 是默认且必须的：我们的过渡输出本来就是 HalfFloat，
      // 若这里降到 byte，超过 1.0 的高光会被夹掉，bloom 会失去意义。
      frameBufferType:
        config.frameBufferType === 'byte' ? THREE.UnsignedByteType : THREE.HalfFloatType,
      multisampling: config.multisampling ?? 0,
      // 我们的两个场景各自渲到自己的 RenderTarget（带深度），
      // composer 这一级只做 2D 图像处理，不需要深度。
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.sourcePass = new SourcePass(null);
    this.composer.addPass(this.sourcePass);

    if (this.enabled) {
      this.buildEffects(config.effects);
    }

    this.stats.effectCount = this.bound.length;
    this.stats.passCount = this.composer.passes.length;
  }

  /* ------------------------------------------------------ 效果装配 */

  private buildEffects(specs: PostEffectSpec[]): void {
    const effects: Effect[] = [];

    for (const spec of specs) {
      if (spec.enabled === false) continue;
      const bound = this.createEffect(spec);
      if (!bound) continue;
      this.bound.push(bound);
      effects.push(bound.effect);
    }

    if (effects.length === 0) {
      // ★ 声明了后处理但一个效果都没开 —— 不要建空的 EffectPass。
      //   空 EffectPass 会白白多一次全屏 blit，而且某些驱动下编译不出着色器。
      //   此时 SourcePass 是链上最后一个 pass，composer 会自动把它的
      //   renderToScreen 置 true，画面照样正确输出（等于"后处理直通"）。
      return;
    }

    this.effectPass = new EffectPass(new THREE.OrthographicCamera(), ...effects);
    this.composer.addPass(this.effectPass);
  }

  /** 工厂：schema 声明 → pmndrs 效果实例 + 脉冲应用器 */
  private createEffect(spec: PostEffectSpec): BoundEffect | null {
    const pulse = spec.pulse ?? 0;

    switch (spec.kind) {
      case 'bloom': {
        const intensity = spec.intensity ?? 0.85;
        const e = new BloomEffect({
          intensity,
          luminanceThreshold: spec.luminanceThreshold ?? 0.62,
          luminanceSmoothing: spec.luminanceSmoothing ?? 0.55,
          mipmapBlur: spec.mipmapBlur ?? true,
          radius: spec.radius ?? 0.72,
          levels: spec.levels ?? 8,
        });
        return {
          kind: spec.kind,
          effect: e,
          base: [intensity],
          pulse,
          apply: (a) => {
            e.intensity = intensity * (1 + pulse * a);
          },
        };
      }

      case 'chromaticAberration': {
        const [ox, oy] = spec.offset ?? [0.0008, 0.0006];
        const e = new ChromaticAberrationEffect({
          offset: new THREE.Vector2(ox, oy),
          // 这两个字段在 postprocessing 的类型里是**必填**，必须显式给
          radialModulation: spec.radialModulation ?? true,
          modulationOffset: spec.modulationOffset ?? 0.35,
        });
        return {
          kind: spec.kind,
          effect: e,
          base: [ox, oy],
          pulse,
          apply: (a) => {
            const k = 1 + pulse * a;
            e.offset.set(ox * k, oy * k);
          },
        };
      }

      case 'noise': {
        const opacity = spec.opacity ?? 0.055;
        const blend =
          spec.blend === 'screen'
            ? BlendFunction.SCREEN
            : spec.blend === 'add'
              ? BlendFunction.ADD
              : BlendFunction.OVERLAY;
        const e = new NoiseEffect({
          blendFunction: blend,
          premultiply: spec.premultiply ?? false,
        });
        e.blendMode.opacity.value = opacity;
        return {
          kind: spec.kind,
          effect: e,
          base: [opacity],
          pulse,
          apply: (a) => {
            e.blendMode.opacity.value = clamp01(opacity * (1 + pulse * a));
          },
        };
      }

      case 'vignette': {
        const darkness = spec.darkness ?? 0.42;
        const e = new VignetteEffect({
          offset: spec.offset ?? 0.32,
          darkness,
        });
        return {
          kind: spec.kind,
          effect: e,
          base: [darkness],
          pulse,
          apply: (a) => {
            e.darkness = clamp01(darkness * (1 + pulse * a));
          },
        };
      }

      case 'scanline': {
        const opacity = spec.opacity ?? 0.05;
        const e = new ScanlineEffect({
          blendFunction: BlendFunction.OVERLAY,
          density: spec.density ?? 1.15,
        });
        e.blendMode.opacity.value = opacity;
        return {
          kind: spec.kind,
          effect: e,
          base: [opacity],
          pulse,
          apply: (a) => {
            e.blendMode.opacity.value = clamp01(opacity * (1 + pulse * a));
          },
        };
      }

      case 'glitch': {
        const strength = spec.strength ?? 0.28;
        // GlitchEffect 是随机触发的：delay/duration/strength 都是区间，
        // 内部自己摇随机数。所以"强度"必须靠 maxStrength 来压 ——
        // 活跃度为 0 时把上限压到 0，它就完全不可见（但仍会白跑一次随机）。
        const e = new GlitchEffect({
          delay: new THREE.Vector2(1.5, 3.5),
          duration: new THREE.Vector2(0.05, 0.18),
          strength: new THREE.Vector2(0, strength),
          ratio: spec.ratio ?? 0.55,
        });
        return {
          kind: spec.kind,
          effect: e,
          base: [strength],
          pulse,
          apply: (a) => {
            e.maxStrength = clamp01(strength * (1 + pulse * a));
          },
        };
      }

      case 'hueSaturation': {
        const saturation = spec.saturation ?? 1.0;
        const e = new HueSaturationEffect({
          hue: spec.hue ?? 0,
          saturation,
        });
        return {
          kind: spec.kind,
          effect: e,
          base: [saturation],
          pulse,
          apply: (a) => {
            e.saturation = saturation * (1 + pulse * a);
          },
        };
      }

      case 'brightnessContrast': {
        const contrast = spec.contrast ?? 1.0;
        const e = new BrightnessContrastEffect({
          brightness: spec.brightness ?? 0,
          contrast,
        });
        return {
          kind: spec.kind,
          effect: e,
          base: [contrast],
          pulse,
          apply: (a) => {
            e.contrast = contrast * (1 + pulse * a);
          },
        };
      }

      default:
        // 联合类型已经穷尽了所有 kind，这里只是防御"运行时塞进未识别的 kind"
        // （比如从 JSON 读配置）。静默忽略比崩掉好，但要在控制台留痕。
        console.warn('[PostSystem] 未识别的后处理效果:', spec);
        return null;
    }
  }

  /* ------------------------------------------------------------ 尺寸 */

  /**
   * @param width  CSS 像素宽（**不是** drawing buffer 尺寸）
   * @param height CSS 像素高
   *
   * 为什么传 CSS 尺寸：EffectComposer.setSize 内部会自己调
   * `renderer.getDrawingBufferSize()` 去开缓冲（即它自己乘 pixelRatio）。
   * 传已经乘过 pixelRatio 的值会导致缓冲开成 4 倍（dpr=2 时）。
   * 第三个参数 false = 不要动 canvas 的 style（我们的 canvas 是 100%/100%）。
   */
  setSize(width: number, height: number): void {
    this.composer.setSize(Math.max(1, width), Math.max(1, height), false);
  }

  /* ------------------------------------------------------------ 每帧 */

  /**
   * @param source 过渡系统的输出纹理（Composer 的 rtComposite）
   * @param drive  这一帧的活跃度来源
   * @param dt     距上一帧的秒数，用于指数平滑
   */
  render(
    gl: THREE.WebGLRenderer,
    source: THREE.Texture,
    drive: PostDrive,
    dt: number,
  ): void {
    // ---- ① 活跃度：过渡 + 速度，取和后钳制 ----
    const velocityActivity = clamp01(Math.abs(drive.velocity) / VELOCITY_REF);
    const target = clamp01(drive.transition + velocityActivity);

    // ---- ② 指数平滑 ----
    //  用 1 - e^(-dt/tau) 而不是固定的 lerp 系数：这样平滑速度与帧率无关，
    //  144fps 和 60fps 下"涌上来"的观感一致。钳制 dt 是为了防止
    //  切标签页回来时 dt 是好几秒，导致系数变成 1（等于没平滑）。
    const k = 1 - Math.exp(-Math.min(dt, 0.1) / SMOOTHING_TAU);
    this.activity += (target - this.activity) * k;
    this.stats.activity = this.activity;

    // ---- ③ 把活跃度写进每个效果 ----
    if (this.activity > 0.0005) {
      for (const b of this.bound) b.apply(this.activity);
    }

    // ---- ④ 跑链 ----
    this.sourcePass.setTexture(source);
    this.composer.render(dt);

    // postprocessing 内部会改 renderTarget，跑完交还给调用方时置回 null，
    // 否则下一帧任何直接的 gl.render() 都会画进 composer 的缓冲里。
    gl.setRenderTarget(null);
  }

  /* ------------------------------------------------------------ 清理 */

  dispose(): void {
    this.effectPass?.dispose();
    this.sourcePass.dispose();
    this.composer.dispose();
  }
}
