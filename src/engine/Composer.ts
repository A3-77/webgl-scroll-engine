import * as THREE from 'three';
import type { SceneConfig, ScrollState } from '../schema';
import { transitionProgress } from '../animation/scrollProgress';
import type { ModelAsset } from './loaders';
import { SceneManager } from './systems/SceneManager';
import { TransitionSystem, type TransitionTextures } from './systems/TransitionSystem';
import { PostSystem, type PostDrive } from './systems/PostSystem';
import { DEFAULT_POST } from '../config/design';
import type { PostConfig } from '../schema/post';

/**
 * ★ 渲染编排器 —— 整站视觉的骨架
 * ===========================================================================
 * 每帧做这几件事（顺序不能变）：
 *
 *   ① 解析场景        SceneManager 按滚动状态给出 current / next 两个场景
 *   ② 求值两个场景    current 按 currentT 求值，next 按 nextT 求值
 *                     （这是"两张图同时在动"的前提）
 *   ③ 过渡混合        TransitionSystem：各渲到离屏纹理 → 阈值场混合 → rtComposite
 *   ④ 后处理链        PostSystem：bloom / 色差 / 颗粒 / 暗角 …（PHASE 18）
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
 *   ▸ 出厂前最后一道工序                  → PostSystem          (PHASE 18)
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
  /** 后处理链是否启用（false = 过渡结果直接打屏） */
  bloom: boolean;
  /** 后处理链里实际生效的效果数 */
  postEffects: number;
  /** 后处理活跃度 0..1 —— 看它就能判断 pulse 有没有在工作 */
  postActivity: number;
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
  /**
   * ★ 后处理链配置。
   *
   * 【改造说明】这里原本是三个裸参数 `bloom` / `bloomThreshold` / `bloomStrength`
   * —— 也就是"引擎在编译期就知道你只会要一个 bloom"。
   * 现在整条链由 schema 声明，内容包想加颗粒、色差、暗角都在这一个对象里说。
   * 不传就用 `config/design.ts` 的 DEFAULT_POST（保守四件套）。
   *
   * 不传和传 `{ enabled: false }` 的区别：
   *   不传        → 走默认链
   *   enabled:false → 一个后处理 pass 都不跑，过渡结果直接打屏
   *                   （调阈值场时必须这样，否则分不清亮边是 shader 画的还是 bloom 加的）
   */
  post?: PostConfig;
  /**
   * @deprecated 后处理已经统一到 `post`。
   * 保留这个开关只是为了让旧的调用点不炸 —— 它等价于 `post.enabled`。
   * 显式传了 `post` 时本参数被忽略。
   */
  bloom?: boolean;
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
  /** 出厂前最后一道工序：bloom / 色差 / 颗粒 / 暗角 … */
  private post: PostSystem;
  private enablePost: boolean;

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
    postEffects: 0,
    postActivity: 0,
    drawSize: '0×0',
    textureCount: 0,
  };

  constructor(options: ComposerOptions) {
    const { gl, textures, models } = options;
    this.gl = gl;
    this.scrollState = options.scrollState;
    this.stats.textureCount = textures.size;

    // 建场景。注意每个 section 一个独立 THREE.Scene + 独立 PerspectiveCamera
    // （真实站点也是这样：每个章节有自己的 camera 关键帧轨道，互不干扰）
    this.sceneManager = SceneManager.build(options.scenes, textures, models, 1);
    this.transition = new TransitionSystem(options.transitionTextures);

    // 后处理链。显式给了 post 就以它为准（此时忽略弃用的 bloom 开关），
    // 否则沿用 DEFAULT_POST，但允许用 bloom:false 把它整体关掉。
    const postConfig: PostConfig =
      options.post ??
      (options.bloom === false ? { ...DEFAULT_POST, enabled: false } : DEFAULT_POST);

    this.enablePost = postConfig.enabled ?? true;
    this.stats.bloom = this.enablePost;
    this.post = new PostSystem(gl, postConfig);
    this.stats.postEffects = this.post.stats.effectCount;

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
    // ★ 传 CSS 尺寸，不是 drawing buffer 尺寸 —— 理由见 PostSystem.setSize
    this.post.setSize(this.width, this.height);
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

    /**
     * ★ 后处理活跃度 —— 让效果"跟着滚动呼吸"的驱动量。
     *
     * 【为什么用 sin(π × uProgress) 而不是直接用 uProgress】
     *   uProgress 在章节切换的瞬间从 1 跳回 0。直接拿它当驱动量的话，
     *   每换一章效果强度都会"啪"地掉一次，非常明显。
     *   sin(π·u) 在 u=0 和 u=1 两端都是 0，左右连续 ——
     *   切换瞬间两边都是 0，画面完全无缝；过渡进行到一半时最强。
     *
     * 【速度项为什么单独给】
     *   只在切章时才有反应，大部分滚动时间里画面是"死的"。
     *   加上速度项之后，快速滑动也会让色差/颗粒涌上来 ——
     *   这才接近参考站点那种"手一直在操控画面"的感觉。
     */
    const drive: PostDrive = {
      transition: Math.sin(Math.PI * uProgress),
      velocity: state.velocity,
    };

    if (this.enablePost) {
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
      // ④ 后处理链 → ⑤ 屏幕
      this.post.render(gl, this.rtComposite.texture, drive, dt);
    } else {
      // 一个后处理 pass 都不跑，直接把过渡结果打到屏幕。
      // 调阈值场时必须走这条 —— 否则分不清边界亮边是 shader 画的还是 bloom 加的。
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
    this.stats.postActivity = this.post.stats.activity;
  }

  /* ------------------------------------------------------------ 清理 */

  dispose(): void {
    this.rtComposite?.dispose();
    this.transition.dispose();
    this.post.dispose();
    this.sceneManager.dispose();
  }
}
