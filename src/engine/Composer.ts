import * as THREE from 'three';
import type { SceneConfig, ScrollState } from '../schema';
import { transitionProgress } from '../animation/scrollProgress';
import type { ModelAsset } from './loaders';
import { SceneManager } from './systems/SceneManager';
import { TransitionSystem, type TransitionTextures } from './systems/TransitionSystem';
import { BloomSystem } from './systems/BloomSystem';

/**
 * ★ 渲染编排器 —— 整站视觉的骨架
 * ===========================================================================
 * 每帧做这几件事（顺序不能变）：
 *
 *   ① 解析场景        SceneManager 按滚动状态给出 current / next 两个场景
 *   ② 求值两个场景    current 按 currentT 求值，next 按 nextT 求值
 *                     （这是"两张图同时在动"的前提）
 *   ③ 过渡混合        TransitionSystem：各渲到离屏纹理 → 阈值场混合 → rtComposite
 *   ④ 高光溢出        BloomSystem：亮度阈值 → 半分辨率高斯（横竖各一次）→ 叠回
 *   ⑤ 输出屏幕
 *
 * ---------------------------------------------------------------------------
 * 【这个类现在"不管"什么 —— 拆分后的职责边界】
 *
 *   ▸ 场景的生命周期与 current/next 解析  → SceneManager        (PHASE 4)
 *   ▸ 相机怎么摆                          → CameraSystem        (PHASE 5)
 *   ▸ 位移单位与视差倍率                  → ParallaxSystem      (PHASE 6)
 *   ▸ 每个图层怎么动                      → ObjectAnimationSystem(PHASE 7)
 *   ▸ 两张画面怎么混                      → TransitionSystem    (PHASE 8)
 *   ▸ 高光怎么溢出                        → BloomSystem         (PHASE 9)
 *
 *   本类只剩两件事：**编排顺序** 和 **持有 rtComposite 这个交接点**。
 *
 * ---------------------------------------------------------------------------
 * 【为什么 rtComposite 归编排器，而不归某个系统】
 *
 *   它是"过渡的输出"同时也是"bloom 的输入"，是两个系统之间唯一的耦合点。
 *   让任何一方拥有它，另一方就得反向依赖对方。交给编排器是最小的耦合。
 *
 * ---------------------------------------------------------------------------
 * 【为什么要绕这么多离屏纹理，而不是"直接渲染两个场景到屏幕再混合"】
 *
 *   因为 WebGL 没有"读回当前 framebuffer 再混合"的廉价手段。
 *   过渡效果需要同时访问两张完整画面（还要对它们做 fwidth 导数运算），
 *   唯一可行且高性能的方式就是各自先渲到纹理。真实站点用的
 *   pmndrs/postprocessing 的 EffectComposer 走的是同一条路
 *   （实测它的 Buffer 是 1279×812，Bloom 内部降到 640×406）。
 * ===========================================================================
 */
export interface ComposerStats {
  currentIndex: number;
  nextIndex: number;
  progress: number;
  nextProgress: number;
  /** 上一帧的 draw call 数（renderer.info.render.calls） */
  drawCalls: number;
  triangles: number;
  bloom: boolean;
  drawSize: string;
  /** 加载进显存的贴图数量（含过渡扰动图） */
  textureCount: number;
}

export interface ComposerOptions {
  gl: THREE.WebGLRenderer;
  /**
   * ★ 要渲染的场景列表。
   *
   * 【改造说明】这里原本是 `import { SCENES } from '../config/scenes'` ——
   * 一个通用渲染管线硬编码依赖了全局内容数组，等于"换内容 = 改引擎"。
   * 现在由 app 装配层注入，Composer 不知道内容从哪来。
   */
  scenes: SceneConfig[];
  textures: Map<string, THREE.Texture>;
  /** GLB 模型表。用占位素材时为空 Map */
  models: Map<string, ModelAsset>;
  /**
   * ★ 每帧读取滚动状态。
   *
   * 【改造说明】这里原本是 `import { sectionStore }` 直接读全局 store ——
   * 引擎依赖了应用状态管理，导致引擎无法脱离 React 单独测试。
   * 现在只接受一个取值函数。
   */
  scrollState: () => ScrollState;
  /**
   * 过渡 shader 用的扰动纹理。
   *
   * 【改造说明】这里原本硬编码 `textures.get('noise')` / `textures.get('mudNormal')` ——
   * 引擎知道了"内容里有一张叫 noise 的图"。现在由 app 按内容包的
   * `site.transitionTextures` 解析好再传进来。
   */
  transitionTextures?: TransitionTextures;
  /** 是否启用 bloom（默认 true）。关掉可以看清过渡 shader 的原始输出 */
  bloom?: boolean;
  /** 高光阈值 0..1 */
  bloomThreshold?: number;
  /** bloom 叠加强度 */
  bloomStrength?: number;
}

export class Composer {
  private gl: THREE.WebGLRenderer;
  private scrollState: () => ScrollState;
  private width = 1;
  private height = 1;

  /** 场景集合的生命周期与 current/next 解析 */
  private sceneManager: SceneManager;
  /** 双场景交叉溶解 */
  private transition: TransitionSystem;
  /** 高光溢出 */
  private bloom: BloomSystem;
  private enableBloom: boolean;

  /**
   * 过渡 → bloom 的交接纹理。
   * 它不属于任何一方（理由见文件头注释），所以由编排器持有。
   */
  private rtComposite!: THREE.WebGLRenderTarget;

  readonly stats: ComposerStats = {
    currentIndex: 0,
    nextIndex: -1,
    progress: 0,
    nextProgress: 0,
    drawCalls: 0,
    triangles: 0,
    bloom: true,
    drawSize: '0×0',
    textureCount: 0,
  };

  constructor(options: ComposerOptions) {
    const { gl, textures, models } = options;
    this.gl = gl;
    this.scrollState = options.scrollState;
    this.enableBloom = options.bloom ?? true;
    this.stats.bloom = this.enableBloom;
    this.stats.textureCount = textures.size;

    // 建场景。注意每个 section 一个独立 THREE.Scene + 独立 PerspectiveCamera
    // （真实站点也是这样：每个章节有自己的 camera 关键帧轨道，互不干扰）
    this.sceneManager = SceneManager.build(options.scenes, textures, models, 1);
    this.transition = new TransitionSystem(options.transitionTextures);
    this.bloom = new BloomSystem({
      threshold: options.bloomThreshold,
      strength: options.bloomStrength,
    });

    // 关掉 three 的自动重置：默认每次 gl.render() 都会清空 info，
    // 那样 stats 只能读到最后一个 pass（也就是 1 个 draw call）。
    // 手动在每帧开头 reset，才能统计到整帧全部 pass 的累计值。
    gl.info.autoReset = false;
  }

  /* ------------------------------------------------------------ 尺寸 */

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    const w = Math.floor(this.width * pixelRatio);
    const h = Math.floor(this.height * pixelRatio);
    const aspect = this.width / this.height;

    this.rtComposite?.dispose();
    this.rtComposite = new THREE.WebGLRenderTarget(w, h, {
      // HalfFloat：给 bloom 留出 >1 的余量，高光叠加不会被 clamp 成死白
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.transition.setSize(this.width, this.height, pixelRatio);
    this.bloom.setSize(this.width, this.height, pixelRatio);
    this.sceneManager.setAspect(aspect);

    this.stats.drawSize = `${w}×${h}`;
  }

  /* ------------------------------------------------- 视口变化后的重新构图 */

  /** 用重新构图后的 config 刷新场景布局。详见 SceneManager.refreshLayout */
  refreshLayout(configs: SceneConfig[], aspect: number): boolean {
    return this.sceneManager.refreshLayout(configs, aspect);
  }

  /* ------------------------------------------------------------ 每帧 */

  render(timeSec: number, dt = 0): void {
    const gl = this.gl;
    gl.info.reset(); // 手动重置，配合构造函数里的 info.autoReset = false
    const state = this.scrollState();

    // ① 解析：这一帧要哪两个场景，各自播到哪
    const frame = this.sceneManager.resolve(state);

    // ② 求值两个场景（顺序无关：两个场景不共享任何 Object3D）
    frame.current.applyTime(frame.currentT, dt);
    if (frame.next) frame.next.applyTime(frame.nextT, dt);

    // ③ 过渡混合。
    //    uProgress 用「本章尾段」重新归一化后的值，而不是 raw progress ——
    //    否则章节切换的瞬间画面会跳变（原因见 scrollProgress.ts 里 transitionProgress 的注释）
    const uProgress = transitionProgress(
      state.current.progress,
      state.heights[state.current.index] ?? 0,
      state.viewportH,
    );

    if (this.enableBloom) {
      this.transition.render(
        gl,
        {
          currentScene: frame.current,
          nextScene: frame.next,
          uProgress,
          timeSec,
          mouse: state.mouse,
        },
        this.rtComposite,
      );
      // ④ 高光溢出 → ⑤ 屏幕
      this.bloom.render(gl, this.rtComposite.texture, null);
    } else {
      // 省掉两次全屏 blit，直接把过渡结果打到屏幕
      this.transition.render(
        gl,
        {
          currentScene: frame.current,
          nextScene: frame.next,
          uProgress,
          timeSec,
          mouse: state.mouse,
        },
        null,
      );
    }

    // ---- stats ----
    this.stats.currentIndex = state.current.index;
    this.stats.nextIndex = frame.nextIndex;
    this.stats.progress = uProgress;
    this.stats.nextProgress = frame.nextT;
    this.stats.drawCalls = gl.info.render.calls;
    this.stats.triangles = gl.info.render.triangles;
  }

  /* ------------------------------------------------------------ 清理 */

  dispose(): void {
    this.rtComposite?.dispose();
    this.transition.dispose();
    this.bloom.dispose();
    this.sceneManager.dispose();
  }
}
