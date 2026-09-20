/**
 * ★ 从 manifest 构建一个内容包 —— 素材驱动包的公共骨架
 * ===========================================================================
 * 每个素材驱动的包都要做同样三件事：
 *   1. 读 manifest（带缓存）
 *   2. 交给 composeContent 自动构图
 *   3. 收集"置信度偏低"这类非致命提醒
 *
 * 抽出来之前，这三件事在每个包里各写一遍 —— 而第 3 步尤其容易漏，
 * 漏了就等于"分割出问题但没人知道"。
 *
 * 于是写一个素材驱动的包只需要：
 *
 *     // src/content/<id>/index.ts
 *     export const pack: ContentPack = {
 *       id: 'dogs', label: 'Dogs', site: SITE,
 *       build: ({ aspect }) => buildContent({ aspect }),
 *     };
 *
 * 想调构图参数就传进去：
 *
 *     build: ({ aspect }) => buildContent({ aspect, dolly: -9, dist: [16, 40] }),
 *
 * 想用另一份 manifest（比如同一个项目里放两套素材）：
 *
 *     build: ({ aspect }) => buildContent({ aspect, manifestUrl: '/content-dogs/manifest.json' }),
 * ===========================================================================
 */

import { composeContent, type ComposeOptions } from '../asset-pipeline/compose';
import { loadManifestCached } from '../asset-pipeline/manifest';
import type { ContentManifest } from '../schema';
import type { ResolvedContent } from './types';

/** 置信度 → 人类可读的处置建议 */
const CONFIDENCE_HINT: Record<string, string> = {
  medium:
    '掩码大概率可用，但背景不是纯色。打开 generated/report.html 核对掩码叠原图，' +
    '若主体有缺失，改用 --provider rembg 或 input/masks/ 手工掩码。',
  low: '掩码**不可信**。这张图不适合色键控 —— 请改用 rembg，或手工提供掩码。',
};

/**
 * 从 manifest 里挑出「使用者需要知道」的事。
 *
 * ★ 为什么这些信息要一路带到调试面板上，而不是只 console.warn：
 *   构建脚本早就把它们打出来了，但**没人会去翻终端**。
 *   这和 build-assets 的"不要静默产出垃圾掩码"是同一条原则。
 */
export function collectNotes(manifest: ContentManifest): string[] {
  const notes: string[] = [];

  for (const s of manifest.scenes) {
    if (s.confidence && s.confidence !== 'high') {
      const m = s.metrics ?? {};
      const margin = typeof m.contrastMargin === 'number' ? m.contrastMargin.toFixed(2) : '?';
      // 注意用 `||` 而不是 `??`，而且必须先取出来再拼字符串 ——
      // `'...' + HINT[k] ?? HINT.low` 里 `+` 的优先级更高，
      // 结果是 `(字符串) ?? ...`，左边永远不是 nullish，fallback 变成死代码。
      const hint = CONFIDENCE_HINT[s.confidence] || CONFIDENCE_HINT.low;
      notes.push(
        `场景 "${s.id}" 的分割置信度是 ${s.confidence}（对比裕度 ${margin}）。${hint}`,
      );
    }
  }

  // manifest 与素材对不上，多半是"图删了但 manifest 没重跑"
  for (const s of manifest.scenes) {
    if (s.subjects.length === 0) {
      notes.push(
        `场景 "${s.id}" 一个主体都没有 —— 只会渲染背景。` +
          `多半是分割失败，或那张图的背景太复杂。`,
      );
    }
  }

  return notes;
}

export interface BuildContentOptions extends ComposeOptions {
  /**
   * manifest 的 URL。默认 `/content/manifest.json`（build-assets 的默认输出）。
   *
   * 一个项目里要放两套互不相干的素材时，用 build-assets 的 `--out` 写到不同目录，
   * 然后在这里指过去即可。
   */
  manifestUrl?: string;
}

/**
 * 素材驱动包的标准 build 实现。
 *
 * 给定同样的 (manifest, aspect, 构图参数)，永远得到同样的结果 —— 纯函数，
 * 没有隐藏状态（manifest 缓存是显式的，见 loadManifestCached）。
 */
export async function buildContent(options: BuildContentOptions): Promise<ResolvedContent> {
  const { manifestUrl, ...composeOptions } = options;

  const manifest = await loadManifestCached(manifestUrl);
  const composed = composeContent(manifest, composeOptions);
  const notes = collectNotes(manifest);

  if (notes.length) {
    console.warn(`[content] ${notes.length} 条提醒：\n` + notes.map((n) => `  · ${n}`).join('\n'));
  }

  return { ...composed, notes };
}
