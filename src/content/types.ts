/**
 * ★ ContentPack —— 内容包契约
 * ---------------------------------------------------------------------------
 * 这是"内容与引擎彻底分离"的落点。
 *
 * 一个内容包 = 引擎跑起来所需的**全部内容**：
 *   ▸ 资产注册表（有哪些图/模型，各自怎么加载）
 *   ▸ 场景定义（怎么排布、怎么动）
 *   ▸ 站点配置（标题、字体、排版 token、过渡纹理用哪张图）
 *
 * 引擎不认识任何具体内容包。它只接受一个 ContentPack 对象。
 * 谁来提供这个对象，是 app 装配层的事（src/app/）。
 *
 * ---------------------------------------------------------------------------
 * 【验收 1 的判定标准】
 *   删掉 src/content/shopify/ 整个目录，引擎必须照常运行。
 *   因为 engine/ 里没有一行 import 指向它。
 */

import type {
  AssetRegistry,
  AudioConfig,
  CarrierConfig,
  PostConfig,
  SceneConfig,
} from '../schema';

/* ------------------------------------------------------------ 站点配置 */

export interface SiteConfig {
  /** 浏览器标题 / <title> */
  title: string;

  /** 字体族（CSS font-family 值） */
  font: {
    sans: string;
    display: string;
    script: string;
  };

  /** 排版 token —— 会被 ScrollSections 透传成 CSS 变量 */
  type: {
    h2: { fontSize: string; fontWeight: number; letterSpacing: string; lineHeight: number };
    h3: { fontSize: string; fontWeight: number; letterSpacing: string; lineHeight: number };
    eyebrow: { fontSize: string; fontWeight: number; letterSpacing: string };
    body: { fontSize: string; fontWeight: number; lineHeight: number; letterSpacing: string };
  };

  /**
   * 引擎级过渡纹理的**资产 key**。
   *
   * 为什么这两张图不归引擎所有：
   *   引擎需要"一张噪声图 + 一张位移图"来做阈值场扰动，
   *   但具体用哪张是内容/美术的决定（换一张噪声 = 完全不同的边界质感）。
   *   引擎只知道要按 key 去资产表里取，不知道 key 叫什么。
   *
   * 改造前这两个 key 是**硬编码在 Composer.ts 里的字符串** `'noise'` / `'mudNormal'`，
   * 也就是引擎知道了内容里有哪些图 —— 这正是要消除的耦合。
   */
  transitionTextures: {
    /** 灰度噪声图，R 通道即噪声值 */
    noise: string;
    /** 法线图，R 通道被用作位移偏移 */
    displacement: string;
  };

  /**
   * ★ 后处理链 —— 内容包自己的"胶片风格"。
   *
   * 为什么它属于内容而不是引擎：
   *   "画面要不要颗粒、色差多重、暗角多深"是**审美决策**，
   *   和"标题用什么字体"是同一类东西。引擎默认值（config/design.ts 的
   *   DEFAULT_POST）必须保持中立，否则一个偏印刷风的引擎默认值
   *   套到干净的商业摄影上就是灾难。
   *
   *   不声明 → 用引擎的保守四件套（bloom + 极轻色差 + 极轻颗粒 + 暗角）。
   *   声明了   → 整体替换，引擎默认值一条都不生效。
   *
   * 例：想要 shader.se 那种印刷/胶片感，就声明
   *   { effects: [{ kind:'noise', opacity:0.12, pulse:1.5 },
   *               { kind:'chromaticAberration', offset:[0.0016,0.0012], pulse:2 },
   *               { kind:'scanline', density:1.6, opacity:0.06 },
   *               { kind:'bloom', intensity:0.7 }] }
   */
  post?: PostConfig;

  /**
   * ★ 3D 过渡载体（PHASE 23）。
   *
   * 不声明 → 纯 2D 阈值场溶解（改造前的行为，逐位一致）。
   * 声明 `{ enabled: true, preset: 'fly-across' }` →
   *   一个 3D 物体沿自动生成的曲线飞过画面，且**溶解边界跟着它走**。
   *
   * 为什么它是"内容决策"而不是"引擎能力"：
   *   有没有一个"主角"在做这件事，决定的是这段叙事的语气。
   *   有的内容想要"画面被擦开"，有的只想要安静的叠化 ——
   *   这个判断属于内容，不属于引擎。
   */
  carrier?: CarrierConfig;

  /**
   * ★ 声音 —— 同样属于内容包的审美决策。
   *
   * 【默认静音，不是"默认播放"】
   *   浏览器的自动播放策略要求 AudioContext 必须在用户手势里启动，
   *   所以引擎**物理上做不到**"进页面就响"。UI 上放一个开关，
   *   用户点了才 `AudioSystem.start()`。
   *
   *   这条约束反而是好事：突然出声的网页是最招人烦的东西之一。
   *   让它变成"用户主动邀请"，既合规又礼貌。
   *
   * 【为什么音量/音色归内容包】
   *   一个摄影集要的是安静的低频垫底，一个赛博朋克 demo 要的是
   *   高频噪声 —— 引擎默认值不可能同时讨好两者。
   *   和 post 一样：不声明 = 用引擎默认值，声明 = 整体替换。
   */
  audio?: AudioConfig;
}

/* ------------------------------------------------------------ 内容包 */

/** 一个包解析完成后的形态 —— 引擎只认这个 */
export interface ResolvedContent {
  assets: AssetRegistry;
  scenes: SceneConfig[];

  /**
   * 内容包想告诉使用者的**非致命**提醒。
   *
   * 例：某张图的分割置信度偏低（背景不是纯色，掩码可能有缺失），
   *     建议换 provider 或手工掩码。
   *
   * ★ 为什么不只 console.warn：
   *   构建脚本早就把这条信息打出来了，但**没人会去翻终端**。
   *   把它一路带到调试面板上，用户才真的会看到。
   *   这与 build-assets 的"不要静默产出垃圾掩码"是同一条原则。
   */
  notes?: string[];
}

/**
 * 动态构建时能拿到的运行时信息。
 *
 * 为什么 `aspect` 必须在这里传进去、而不能由包自己去读 `window`：
 *   构图数学（`offset` 与 `overscan` 的换算）**依赖视口宽高比**，
 *   见 `asset-pipeline/compose.ts` 的推导。
 *   如果包自己去读 window，那这个包就绑死在浏览器上，
 *   也没法在 Node 里跑测试或做离线预览。
 *   由装配层提供，包保持纯函数 —— 给定 (manifest, aspect) 永远同样的结果。
 */
export interface BuildContext {
  /** 视口宽高比（宽 / 高） */
  aspect: number;
}

export interface ContentPack {
  /** 唯一标识，如 'shopify' / 'placeholder' / 'cats' */
  id: string;
  /** 人类可读名，调试面板与文档里用 */
  label: string;
  /** 一句话说明这个包是什么（会显示在调试面板） */
  description?: string;

  site: SiteConfig;

  /**
   * 静态资产注册表：key → { path, kind }。
   * 手写内容包用这个。与 `build` 二选一。
   */
  assets?: AssetRegistry;

  /** 静态场景定义。数组顺序 = 章节顺序。与 `build` 二选一 */
  scenes?: SceneConfig[];

  /**
   * ★ 动态内容：在运行时生成 assets 与 scenes。
   *
   * 存在的理由：素材驱动的包（从 build-assets 的 manifest 自动构图）
   * 在**构建期并不知道**有哪些场景 —— 用户随时可能往 input/ 里丢一张新图。
   * 如果只能静态声明，那"加图不改代码"就做不到（验收 7）。
   *
   * 与 assets/scenes 二选一。两个都给的话 build 优先。
   *
   * 为什么是函数而不是直接给 Promise：
   *   `loadContentPack` 需要能选择"根本不加载这个包"
   *   （比如 URL 参数指向了别的包）—— 函数是懒执行的，Promise 不是。
   */
  build?: (ctx: BuildContext) => Promise<ResolvedContent>;

  /**
   * 这个包是否引用了仓库外的原始素材（版权提示用）。
   *
   * 改造前这个信息由 `isOriginalAsset(key)` 从 key 名前缀 `o` 猜出来 ——
   * 靠命名约定传递语义是脆的（改个 key 名就失效了）。
   * 现在由内容包自己声明。
   */
  attribution?: string;
}

/* ------------------------------------------------------------ 工具 */

/**
 * 把 AssetRegistry 包成一个 AssetSource（引擎读资产所需的端口）。
 *
 * 放在 content/ 而不是 engine/，因为它是"内容侧适配引擎端口"的适配器 ——
 * 引擎不该知道 AssetRegistry 这种结构的存在。
 */
export function createAssetSource(assets: AssetRegistry, baseUrl = '/'): {
  resolve(key: string): string;
  kind(key: string): 'image' | 'ktx2' | 'glb';
  keys(): string[];
} {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  const get = (key: string) => {
    const def = assets[key];
    if (!def) {
      throw new Error(
        `[AssetSource] 未注册的资产 key: "${key}"。\n` +
          `已注册: ${Object.keys(assets).join(', ') || '(空)'}\n` +
          `→ 检查内容包的 assets 注册表，或场景配置里是否拼错了 key。`,
      );
    }
    return def;
  };

  return {
    resolve: (key) => `${base}${get(key).path}`,
    kind: (key) => get(key).kind,
    keys: () => Object.keys(assets),
  };
}
