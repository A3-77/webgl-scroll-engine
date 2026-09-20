/**
 * Placeholder 内容包 —— 资产注册表
 * ---------------------------------------------------------------------------
 * 6 张图，全部是 tools/gen_assets.py 程序化生成的抽象图。
 * 换成你自己的图：直接覆盖 public/content/placeholder/ 下的同名文件即可。
 */

import type { AssetRegistry } from '../../schema';

export const ASSETS: AssetRegistry = {
  /* ---- 场景 01 Hero ---- */
  heroBg: { path: 'content/placeholder/hero-bg.png', kind: 'image' },
  heroMid: { path: 'content/placeholder/hero-mid.png', kind: 'image' },
  heroFg: { path: 'content/placeholder/hero-fg.png', kind: 'image' },

  /* ---- 场景 02 Sidekick ---- */
  sidekickBg: { path: 'content/placeholder/sidekick-bg.png', kind: 'image' },
  sidekickMid: { path: 'content/placeholder/sidekick-mid.png', kind: 'image' },
  sidekickFg: { path: 'content/placeholder/sidekick-fg.png', kind: 'image' },
};
