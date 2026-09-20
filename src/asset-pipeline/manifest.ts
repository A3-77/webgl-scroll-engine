/**
 * manifest 读取
 * ===========================================================================
 * `generated/content.json` 是 Python 侧与 TS 侧的契约。
 * 运行时读的是 `public/content/manifest.json` —— build-assets 会同时写两份，
 * 内容一样，只是 public/ 那份浏览器才取得到。
 *
 * 为什么要 fetch 而不是 `import manifest from '../../generated/content.json'`：
 *   静态 import 会把 manifest **烘进 bundle**，于是"重跑 build-assets 就能换内容"
 *   这件事在开发服务器上就失效了（要重启 + 重建）。
 *   fetch 让素材成为真正的运行时数据。
 * ===========================================================================
 */

import type { ContentManifest } from '../schema';

/** build-assets 写出的运行时副本。路径相对站点根 */
export const MANIFEST_URL = '/content/manifest.json';

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** 结构校验。宁可在这里明确报错，也不要让缺字段一路飘到渲染循环里 */
function validate(data: unknown, url: string): ContentManifest {
  if (!data || typeof data !== 'object') {
    throw new ManifestError(`${url} 不是一个 JSON 对象。`);
  }
  const m = data as Partial<ContentManifest>;

  if (!Array.isArray(m.scenes) || m.scenes.length === 0) {
    throw new ManifestError(
      `${url} 里没有任何场景。\n` +
        `  → 多半是 input/ 目录为空，或 build-assets 一个主体都没检测到。\n` +
        `  → 看看 generated/report.html 里每个场景的掩码图。`,
    );
  }

  for (const s of m.scenes) {
    if (!s.id || !s.background || !Array.isArray(s.subjects)) {
      throw new ManifestError(`${url} 里场景 ${String(s?.id)} 的字段不完整（缺 id/background/subjects）。`);
    }
    for (const sub of s.subjects) {
      if (!sub.id || !sub.path || !sub.box || !sub.center || !sub.size) {
        throw new ManifestError(
          `${url} 里 ${s.id}/${String(sub?.id)} 的字段不完整。` +
            ` 若 manifest 是旧版本生成的，重跑一次 npm run build-assets。`,
        );
      }
    }
  }

  return m as ContentManifest;
}

export async function loadManifest(url: string = MANIFEST_URL): Promise<ContentManifest> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new ManifestError(
      `取不到 ${url}：${(err as Error).message}\n` +
        `  → 确认开发服务器正在运行，且 public/content/manifest.json 存在。`,
    );
  }

  if (!res.ok) {
    throw new ManifestError(
      `${url} 返回 ${res.status} ${res.statusText}。\n` +
        `  → 还没有生成过素材？跑一次：\n` +
        `      npm run build-assets`,
    );
  }

  return validate(await res.json(), url);
}

/* ------------------------------------------------------------ 缓存 */

let cachedUrl: string | null = null;
let cachedValue: ContentManifest | null = null;

/**
 * 带**页面会话级**内存缓存的读取。
 *
 * ★ 存在的理由：视口变化时要重新构图（PHASE 17），而重新构图需要 manifest。
 *   如果每次都走 `loadManifest`，拖动窗口会连续发几十个请求 ——
 *   manifest 本身不大，但每个请求都要过一次网络栈 + JSON.parse，
 *   在 resize 这种高频场景下是纯浪费。
 *
 * ★ 缓存的生命周期刻意定在"页面会话"：
 *   刷新页面就清空，所以「重跑 build-assets → 刷新 → 换内容」这条工作流
 *   完全不受影响。这也是它**不能**做成 HTTP 缓存的原因 ——
 *   `loadManifest` 用的是 `cache: 'no-cache'`，本来就是要每次都拿最新的。
 */
export async function loadManifestCached(url: string = MANIFEST_URL): Promise<ContentManifest> {
  if (cachedValue && cachedUrl === url) return cachedValue;
  cachedValue = await loadManifest(url);
  cachedUrl = url;
  return cachedValue;
}

/** 手动失效缓存（目前没有调用方，留给以后的热重载用） */
export function invalidateManifestCache(): void {
  cachedValue = null;
  cachedUrl = null;
}
