/**
 * Shopify 内容包 —— 资产注册表
 * ---------------------------------------------------------------------------
 * ⚠️ 版权声明：以下资产是从原站公开 CDN 拉取的内容副本（tools/fetch_assets.py），
 *   版权归 Shopify 及原权利人所有，仅限个人研究使用。
 *
 * 路径前缀 `original/` 由 vite.config.ts 的 serveOriginals() 插件映射到
 * 仓库根的 `assets-original/` 目录（dev 与 build 都可用）。
 *
 * 前缀 `o`（original）= 这些是原站真实素材，与 placeholder 包的资产区分开。
 */

import type { AssetRegistry } from '../../schema';

export const ASSETS: AssetRegistry = {
  /* ---- Hero 首屏 ---- */
  oHeroBg: { path: 'original/textures/Hero-bg-hires-optimized.ktx2', kind: 'ktx2' },
  oHeroModel: {
    path: 'original/models/EW26_Hero_251207v3_compressed-optimized.glb',
    kind: 'glb',
  },

  /* ---- Sidekick ---- */
  // 注意：Sidekick 的背景不是贴图平面，而是一个**模型**
  // （EW26_Sidekick_bg_stars，4 顶点 quad + 内嵌 KTX2）。
  // 所以这里没有 oSidekickBg —— 背景走 oSidekickStars 那条路。
  oSidekickModel: {
    path: 'original/models/EW26_Sidekick_251208_compressed-optimized.glb',
    kind: 'glb',
  },
  /** Sidekick 的星空背景是独立模型（4 顶点 quad + 内嵌 KTX2） */
  oSidekickStars: {
    path: 'original/models/EW26_Sidekick_bg_stars-optimized.glb',
    kind: 'glb',
  },

  /* ---- Operations（用最大的那个模型，144k 顶点）---- */
  oOperationsBg: {
    path: 'original/textures/Operations_bg_diffuse-optimized.ktx2',
    kind: 'ktx2',
  },
  oOperationsModel: {
    path: 'original/models/Operations_fg_smaller_251127_compressed-optimized.glb',
    kind: 'glb',
  },

  /* ---- Finance ---- */
  oFinanceBg: { path: 'original/textures/Finance_bg-optimized.ktx2', kind: 'ktx2' },
  oFinanceModel: {
    path: 'original/models/EW26_Finance_251208v2_compressed-optimized.glb',
    kind: 'glb',
  },
};
