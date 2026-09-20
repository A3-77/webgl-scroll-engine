/**
 * Cats 内容包 —— 素材驱动（PHASE 3 / 12 的落点）
 * ===========================================================================
 * ★ 这个文件里**没有一行场景配置**。
 *
 *   它只声明了三件事：包 id、显示名、站点配置。
 *   "读 manifest → 自动构图 → 收集置信度提醒"这套流程在 `content/build.ts` 里，
 *   每个素材驱动的包都复用它。
 *
 *   所以"换图片"的完整流程是：
 *       input/scene01.jpg 换掉 → npm run build-assets → 刷新页面
 *   Three.js / Shader / SceneBuilder / Camera / Scroll 代码一行不用动。
 *
 * ---------------------------------------------------------------------------
 * 【想创建自己的包？】
 *
 *   npm run new-pack <id>
 *
 *   会生成 src/content/<id>/{index.ts,site.ts} 两个文件，
 *   改一下 site.ts 里的标题和字体就能用。
 *
 * 【想调构图参数？】
 *
 *   传进 buildContent 即可（全部参数见 asset-pipeline/compose.ts 的 DEFAULTS）：
 *
 *     build: ({ aspect }) => buildContent({ aspect, dolly: -9, dist: [16, 40] }),
 * ===========================================================================
 */

import { buildContent } from '../build';
import type { BuildContext, ContentPack, ResolvedContent } from '../types';
import { SITE } from './site';

export const pack: ContentPack = {
  id: 'cats',
  label: 'Cats',
  description:
    '素材驱动 · 场景由 build-assets 的 manifest 自动构图。' +
    '换 input/ 里的图片即可换内容，不需要改任何代码。',

  site: SITE,

  build: ({ aspect }: BuildContext): Promise<ResolvedContent> => buildContent({ aspect }),
};

export { SITE };
