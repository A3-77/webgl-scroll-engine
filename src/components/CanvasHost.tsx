import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Composer } from '../engine/Composer';
import { disposeAssets, loadAssets, type LoadedAssets } from '../engine/loaders';
import { createScrollEngine, type ScrollEngine } from '../animation/smoothScroll';
import { sectionStore, getScrollState } from '../store/sectionStore';
import { ENGINE_ASSETS } from '../content/engine-assets';
import { createAssetSource, type ContentPack, type ResolvedContent } from '../content/types';

/**
 * WebGL 宿主 —— 装配层的一部分。
 *
 * 它做三件事：
 *   1. 把内容包（ContentPack）翻译成引擎需要的东西
 *      （AssetSource / scenes / transitionTextures / earlyCrossfades）
 *   2. 管理 WebGLRenderer 与 rAF 循环的生命周期
 *   3. 监听尺寸与鼠标
 *
 * ★ 布局机制（这是"画布钉住"的实现，不是 GSAP pin）：
 *   真实站点实测的 class 是
 *     `sticky top-0 left-0 w-full h-[100vh] -mb-[100vh]`
 *   即：sticky 钉住 + 一个负的 margin-bottom 把自己从文档流里"抽掉"。
 *   结果就是 —— canvas 永远停在视口，而后面的章节照常滚动并叠在它上面。
 *   全程零 JS 参与定位，滚动性能完全交给合成器。
 *   （全量 grep 过 bundle：GSAP / ScrollTrigger 命中 0 次，确认没有用 pin。）
 *
 * ★ 降级条件：真实站点的实测条件是 `canvas.getContext('webgl2') !== null`，
 *   不是视口宽度。把视口缩到 502px 重载，canvasCount 仍是 5、
 *   `.canvas-wrapper` 的 opacity 仍是 1 —— 所以不是"移动端降级"。
 */

interface CanvasHostProps {
  /** 内容包本体 —— 这里只用它的 `site`（过渡纹理 key）与调试标签 */
  pack: ContentPack;
  /**
   * ★ 解析后的 { assets, scenes }。
   *
   * 为什么不直接给 pack 让这里自己解析：
   *   素材驱动的包要 fetch manifest 才能知道有哪些场景，这是个异步过程。
   *   如果放在这个组件里 await，就得处理"还没解析完"的中间态 ——
   *   而这个组件做的事是建 WebGL 上下文，它没有"部分初始化"这种状态。
   *   由装配层（App）先解析好再传进来，这里就永远只有一个确定的输入。
   */
  content: ResolvedContent;
}

export function CanvasHost({ pack, content }: CanvasHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let composer: Composer | null = null;
    let assets: LoadedAssets | null = null;
    let scrollEngine: ScrollEngine | null = null;
    let ro: ResizeObserver | null = null;

    /** 事件监听器的卸载函数。必须声明在 IIFE 之前 —— 它是同步收集、异步使用的 */
    const cleanupFns: Array<() => void> = [];

    /* ---------------------------------------------- 内容 → 引擎输入 */

    // 资产表 = 引擎资产 + 内容资产（内容同名 key 覆盖引擎资产）
    const assetSource = createAssetSource(
      { ...ENGINE_ASSETS, ...content.assets },
      import.meta.env.BASE_URL || '/',
    );

    const { noise, displacement } = pack.site.transitionTextures;

    /** 场景引用到的全部资产 key + 过渡纹理 key */
    const usedAssets: string[] = Array.from(
      new Set<string>([
        ...content.scenes.flatMap((s) => s.objects.map((o) => o.asset)),
        noise,
        displacement,
      ]),
    );

    /**
     * 需要 mipmap 的 key。
     *
     * 规则：**不是满幅铺开、会被显著缩小渲染的对象**都需要。
     * 判据用 `fit === 'contain'` —— 这是"按纹理自身宽高比完整放入视口"，
     * 意味着它一定比视口小，也就是一定处于 minification 状态，不加 mipmap 会闪。
     * 而 `cover`（铺满视口）是 1:1 左右的，不需要 mipmap，生成了只是白占 33% 显存。
     */
    const mipmapKeys = new Set<string>(
      content.scenes.flatMap((s) =>
        s.objects.filter((o) => (o.fit ?? 'cover') === 'contain').map((o) => o.asset),
      ),
    );

    /** 每章的交叉溶解提前量 —— 由内容提供，引擎不猜 */
    const earlyCrossfades = content.scenes.map((s) => s.earlyCrossfade);

    /* -------------------------------------------------------- 布局量测 */

    const readLayout = (): { heights: number[]; viewportH: number } => ({
      heights: Array.from(document.querySelectorAll<HTMLElement>('[data-section-id]')).map(
        (el) => el.offsetHeight,
      ),
      viewportH: window.innerHeight,
    });

    /* ---------------------------------------------------------- 初始化 */

    void (async () => {
      try {
        // ---- WebGL2 能力检测（真实站点的降级条件）----
        if (!document.createElement('canvas').getContext('webgl2')) {
          throw new Error('当前浏览器/设备不支持 WebGL2');
        }

        renderer = new THREE.WebGLRenderer({
          // 全屏后处理下 MSAA 既昂贵又几乎看不出差别（真实站点实测也是关掉的）
          antialias: false,
          alpha: false,
          stencil: false,
          depth: true,
          powerPreference: 'high-performance',
        });

        // sRGB 直通：这是一层"图像合成"，不做线性化才不会让画面整体偏暗
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

        // ★ 色调映射：只对模型生效，平面不受影响。
        //   平面材质都显式设了 `toneMapped: false`，所以它们是纯直通；
        //   而 PBR 模型在 NoToneMapping 下一旦受光超过 1.0 就直接截断成死白
        //   （实测人物白衣服整片过曝）。
        //   换成 Neutral 而不是 ACES：Neutral 只压高光、不抽色，
        //   对插画质感的模型更合适（ACES 会把鲜艳的橙袍压成灰橙）。
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.toneMappingExposure = 1.0;

        renderer.setClearColor(0x000000, 1);

        const el = renderer.domElement;
        el.style.display = 'block';
        el.style.width = '100%';
        el.style.height = '100%';
        host.appendChild(el);

        // ---- 素材 ----
        // 注意顺序：KTX2 转码器需要 renderer 才能 detectSupport，
        // 所以必须在 renderer 建好之后才能加载素材。
        assets = await loadAssets(usedAssets, renderer, assetSource, mipmapKeys);
        if (disposed) {
          disposeAssets(assets);
          return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = host.clientWidth || window.innerWidth;
        const h = host.clientHeight || window.innerHeight;

        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);

        composer = new Composer({
          gl: renderer,
          scenes: content.scenes,
          textures: assets.textures,
          models: assets.models,
          // ★ 引擎不认资产 key —— 由装配层按内容包的声明解析好再传进去
          transitionTextures: {
            noise: assets.textures.get(noise) ?? null,
            displacement: assets.textures.get(displacement) ?? null,
          },
          // ★ 引擎不认 store —— 只给一个取值函数
          scrollState: getScrollState,
        });
        composer.setSize(w, h, dpr);

        // 先量章节高度，再启动滚动 —— 顺序反了的话第一帧进度会算错
        // （createScrollEngine 构造时会 sync 一次，把 heights 写进 store）
        scrollEngine = createScrollEngine({
          earlyCrossfades,
          readLayout,
          publish: (patch) => sectionStore.setState(patch),
        });

        sectionStore.setState({ loaded: true });

        // 调试入口：控制台里可以直接 __ENGINE__.composer.stats 看实时状态
        (window as unknown as Record<string, unknown>).__ENGINE__ = {
          composer,
          scrollEngine,
          renderer,
          sectionStore,
          pack,
          content,
        };

        const start = performance.now();
        let last = start;
        let readyFlagged = false;

        const loop = (): void => {
          if (disposed) return;
          raf = requestAnimationFrame(loop);

          const now = performance.now();
          // 钳制 dt：切标签页回来时 now - last 可能是好几秒，
          // 不钳制的话相机阻尼会瞬移。
          const dt = Math.min((now - last) / 1000, 0.1);
          last = now;

          // Lenis 必须在 rAF 里推进，它才会把滚动位置插值成逐帧连续值
          scrollEngine!.lenis.raf(now);
          composer!.render((now - start) / 1000, dt);

          if (!readyFlagged) {
            readyFlagged = true;
            sectionStore.setState({ ready: true });
          }
        };
        raf = requestAnimationFrame(loop);

        /* ---------------------------------------------------- 尺寸变化 */

        /**
         * 重新构图的防抖定时器。
         *
         * 拖动窗口时 resize 会以每秒几十次的频率触发。每次都重新构图的话，
         * 主线程一直在算，画面反而更卡。等用户停手 250ms 再做。
         */
        let recomposeTimer: number | undefined;
        /** 上次构图用的视口宽高比 —— 用来判断"这次 resize 值不值得重算" */
        let composedAspect = w / h;

        const onResize = (): void => {
          if (!renderer || !composer) return;
          const nw = host.clientWidth || window.innerWidth;
          const nh = host.clientHeight || window.innerHeight;
          const ndpr = Math.min(window.devicePixelRatio || 1, 2);

          renderer.setPixelRatio(ndpr);
          renderer.setSize(nw, nh, false);
          composer.setSize(nw, nh, ndpr);
          scrollEngine?.sync();

          // ---- 重新构图 ----
          // 静态内容包的 scenes 是硬编码的，没有"重算"这回事，
          // 只有素材驱动的包（有 build 钩子）才需要。
          const build = pack.build;
          if (!build) return;

          window.clearTimeout(recomposeTimer);
          recomposeTimer = window.setTimeout(() => {
            if (disposed) return;

            const nextAspect = nw / nh;
            // 变化不到 4% 就不折腾：主体尺寸的变化肉眼看不出来，
            // 而重建几何 + 重新 fetch manifest 是有成本的。
            if (Math.abs(nextAspect - composedAspect) / composedAspect < 0.04) return;

            void build({ aspect: nextAspect })
              .then((next) => {
                if (disposed || !composer) return;

                const ok = composer.refreshLayout(next.scenes, nextAspect);
                if (ok) {
                  composedAspect = nextAspect;
                  // 章节高度是 vh 单位，视口一变高度也变，进度映射得重算
                  scrollEngine?.sync();
                } else {
                  // 结构变了（场景数或对象数不同）—— 那必须整体重建。
                  // 这里刻意不自动重建：会丢掉当前滚动位置，
                  // 而且这种情况通常意味着内容变了，用户本来就要刷新。
                  console.warn(
                    '[CanvasHost] 重新构图后的场景结构与当前不一致，已跳过。刷新页面以应用。',
                  );
                }
              })
              .catch((err: unknown) => {
                // 重新构图失败不该让画面挂掉 —— 保持旧布局继续跑
                console.warn('[CanvasHost] 重新构图失败，保持原布局:', err);
              });
          }, 250);
        };
        window.addEventListener('resize', onResize);
        cleanupFns.push(() => window.removeEventListener('resize', onResize));
        cleanupFns.push(() => window.clearTimeout(recomposeTimer));

        ro = new ResizeObserver(() => scrollEngine?.sync());
        document
          .querySelectorAll<HTMLElement>('[data-section-id]')
          .forEach((node) => ro!.observe(node));

        // 字体加载完高度可能变，再量一次
        void document.fonts?.ready.then(() => {
          if (!disposed) scrollEngine?.sync();
        });

        /* ------------------------------------------------------ 鼠标 */

        // uMouse 只影响 radial 模式的溶解中心（10% 权重）。
        // 真实站点有这个行为；改造前 store 里留了 mouse 字段但没有任何地方写入，
        // 所以 uMouse 恒为 (0.5, 0.5)，这个特性实际上是失效的 —— 这里补上。
        const onPointerMove = (e: PointerEvent): void => {
          sectionStore.setState({
            mouse: [e.clientX / window.innerWidth, e.clientY / window.innerHeight],
          });
        };
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        cleanupFns.push(() => window.removeEventListener('pointermove', onPointerMove));
      } catch (err) {
        console.error('[CanvasHost] 初始化失败:', err);
        sectionStore.setState({ error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanupFns.forEach((fn) => fn());
      ro?.disconnect();
      scrollEngine?.dispose();
      composer?.dispose();
      if (assets) disposeAssets(assets);
      renderer?.dispose();
      renderer?.domElement.remove();
      delete (window as unknown as Record<string, unknown>).__ENGINE__;
    };
    // 内容变了要重建整个渲染栈（纹理、几何、材质全不一样）——
    // 与其写一套热切换逻辑，不如整体重建。所以 content 是依赖项。
    // 注意依赖的是 `content` 而不是 `pack`：pack 对象是稳定的（模块级常量），
    // 而 content 是每次解析的产物 —— 它变才真的意味着素材变了。
  }, [pack, content]);

  return <div ref={hostRef} className="canvas-host" aria-hidden="true" />;
}
