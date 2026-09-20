/**
 * ★ 内容包选择 —— 整个项目**唯一**需要改动的配置文件
 * ---------------------------------------------------------------------------
 * 想换内容，只改这里（或直接用 URL 参数），不需要碰任何 Three.js / Shader / 引擎代码。
 *
 * 三种指定方式，优先级从高到低：
 *   1. URL 参数   ?content=cats
 *   2. 本文件的 DEFAULT_CONTENT_PACK
 *   3. 兜底 'placeholder'（引擎自检包，永远存在）
 *
 * ---------------------------------------------------------------------------
 * 【为什么用 import.meta.glob 而不是静态 import】
 *
 * 静态写法：
 *     import { shopifyPack } from '../content/shopify';
 *     const PACKS = { shopify: shopifyPack, placeholder: placeholderPack };
 *
 * 这个写法有个致命问题：**删掉 src/content/shopify/ 目录，构建直接失败** ——
 * 因为 Vite/Rollup 在构建期就要解析这个 import。
 * 但"删掉 Shopify 内容后引擎仍能运行"是本项目的硬验收标准之一（验收 1）。
 *
 * 换成 glob 之后，内容包变成**构建期自动发现**：
 *   ▸ 加一个包 = 新建一个目录 + 导出 `pack`，无需改本文件
 *   ▸ 删一个包 = 直接删目录，构建照常通过，没有任何残留引用
 *
 * 这条约束反过来也定义了目录约定：`src/content/<id>/index.ts` 必须导出 `pack`。
 */

import type { BuildContext, ContentPack, ResolvedContent, SiteConfig } from '../content/types';

/**
 * 默认内容包。
 *
 * ★ 这是**你唯一需要改的配置**。
 *   用 `npm run new-pack <id>` 创建自己的包之后，把这里改成那个 id 即可。
 *
 * 目前指向 `cats` —— 它是自带的素材驱动示例包。
 * 它读的是 `/content/manifest.json`，也就是**当前 `input/` 的产物**，
 * 所以你即使不新建包，只要换掉 `input/` 里的图并重跑 build-assets，
 * 看到的就是你自己的内容（只是标题还叫 "Cats"，改 `cats/site.ts` 即可）。
 *
 * 其他可选值：
 *   'placeholder' —— 引擎自检包，不依赖任何外部素材，永远能跑
 *   'shopify'     —— 参考实现，需要仓库外的原始素材
 */
export const DEFAULT_CONTENT_PACK = 'cats';

/**
 * 自动发现全部内容包。
 *
 * 注意 `eager: false` —— 包是**懒加载**的。
 * 这样 `?content=shopify` 时不会把 cats 包的场景配置也打进首屏 bundle。
 */
const packModules = import.meta.glob<{ pack: ContentPack }>('../content/*/index.ts');

/** 从 glob 的路径里抠出包 id：'../content/shopify/index.ts' → 'shopify' */
function idFromPath(path: string): string {
  const m = /\/([^/]+)\/index\.ts$/.exec(path);
  return m ? m[1] : path;
}

/** 当前请求的内容包 id（URL 参数优先） */
export function requestedPackId(): string {
  if (typeof window === 'undefined') return DEFAULT_CONTENT_PACK;
  const q = new URLSearchParams(window.location.search).get('content');
  return q && q.trim() ? q.trim() : DEFAULT_CONTENT_PACK;
}

/** 全部可用内容包的 id 列表（调试面板 / 错误提示用） */
export function availablePackIds(): string[] {
  return Object.keys(packModules).map(idFromPath).sort();
}

/**
 * 把内容包解析成引擎能直接吃的形态。
 *
 * 两种包形态：
 *   ▸ 静态包（placeholder / shopify）—— 直接给 assets + scenes
 *   ▸ 动态包（cats 这类素材驱动的）—— 给一个 `build()`，运行时去 fetch manifest 再构图
 *
 * 为什么统一成异步：动态包要等 manifest 下载完才知道有哪些场景，
 * 而调用方（App）不应该分两套路径处理。一次 await 换掉一个分支。
 */
async function resolvePack(pack: ContentPack, ctx: BuildContext): Promise<ResolvedContent> {
  if (pack.build) {
    const resolved = await pack.build(ctx);
    if (!resolved?.scenes?.length) {
      throw new Error(
        `[content] 内容包 "${pack.id}" 的 build() 返回了 0 个场景。\n` +
          `  → 如果是素材驱动的包，多半是 manifest 里没有场景，或 build-assets 还没跑过。`,
      );
    }
    return resolved;
  }

  if (pack.assets && pack.scenes) {
    return { assets: pack.assets, scenes: pack.scenes };
  }

  throw new Error(
    `[content] 内容包 "${pack.id}" 既没有 build()，也没有同时提供 assets 与 scenes。\n` +
      `  约定：二者必居其一。`,
  );
}

/** 当前视口宽高比。构图数学需要它，见 content/types.ts 的 BuildContext */
function currentAspect(): number {
  if (typeof window === 'undefined') return 16 / 9;
  const h = window.innerHeight || 1;
  return (window.innerWidth || 1) / h;
}

export interface LoadedContent {
  pack: ContentPack;
  /** 实际加载的包 id（可能因回落而与请求的不同） */
  resolvedId: string;
  /** 回落原因，没有则为 null */
  warning: string | null;
  /** 解析后的 assets + scenes。引擎只认这个 */
  content: ResolvedContent;
}

/**
 * 加载内容包。
 *
 * 找不到请求的包时**不抛异常**，而是回落到默认包并给出明确提示 ——
 * 一个拼错的 URL 参数不该让整站白屏。
 */
export async function loadContentPack(id = requestedPackId()): Promise<LoadedContent> {
  const wanted = id.trim() || DEFAULT_CONTENT_PACK;
  const key = Object.keys(packModules).find((p) => idFromPath(p) === wanted);

  if (key) {
    const mod = await packModules[key]();
    return {
      pack: mod.pack,
      resolvedId: wanted,
      warning: null,
      content: await resolvePack(mod.pack, { aspect: currentAspect() }),
    };
  }

  // 回落：请求的包不存在（目录被删了、或 URL 拼错了）
  const fallbackKey = Object.keys(packModules).find((p) => idFromPath(p) === DEFAULT_CONTENT_PACK)
    ?? Object.keys(packModules)[0];

  if (!fallbackKey) {
    throw new Error(
      `[content] 一个内容包都找不到。\n` +
        `约定：src/content/<id>/index.ts 必须导出 \`pack: ContentPack\`。\n` +
        `请确认至少存在 src/content/placeholder/。`,
    );
  }

  const mod = await packModules[fallbackKey]();
  const resolvedId = idFromPath(fallbackKey);
  return {
    pack: mod.pack,
    resolvedId,
    warning:
      `请求的内容包 "${wanted}" 不存在（可用：${availablePackIds().join(', ') || '无'}），` +
      `已回落到 "${resolvedId}"。`,
    content: await resolvePack(mod.pack, { aspect: currentAspect() }),
  };
}

/* ---------------------------------------------------- 站点配置 → CSS */

/**
 * 把 SiteConfig 里的字体与排版 token 写成 CSS 自定义属性。
 *
 * 为什么走 CSS 变量而不是给每个元素写 inline style：
 *   ScrollSections / SectionNav 里有多处需要同一套字号，逐个写 style 会重复且难改。
 *   挂到 :root 上，样式表里用 var(--site-font-sans) 引用即可，
 *   换内容包时整站的字体与字号阶梯一次性跟着变。
 */
export function applySiteToCss(site: SiteConfig, root: HTMLElement = document.documentElement): void {
  const set = (k: string, v: string | number): void => {
    root.style.setProperty(k, typeof v === 'number' ? String(v) : v);
  };

  set('--site-font-sans', site.font.sans);
  set('--site-font-display', site.font.display);
  set('--site-font-script', site.font.script);

  set('--site-h2-size', site.type.h2.fontSize);
  set('--site-h2-weight', site.type.h2.fontWeight);
  set('--site-h2-tracking', site.type.h2.letterSpacing);
  set('--site-h2-leading', site.type.h2.lineHeight);

  set('--site-h3-size', site.type.h3.fontSize);
  set('--site-h3-weight', site.type.h3.fontWeight);
  set('--site-h3-tracking', site.type.h3.letterSpacing);
  set('--site-h3-leading', site.type.h3.lineHeight);

  set('--site-eyebrow-size', site.type.eyebrow.fontSize);
  set('--site-eyebrow-weight', site.type.eyebrow.fontWeight);
  set('--site-eyebrow-tracking', site.type.eyebrow.letterSpacing);

  set('--site-body-size', site.type.body.fontSize);
  set('--site-body-weight', site.type.body.fontWeight);
  set('--site-body-leading', site.type.body.lineHeight);
  set('--site-body-tracking', site.type.body.letterSpacing);

  document.title = site.title;
}
