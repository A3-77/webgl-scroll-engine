/**
 * 引擎级资产 —— 不属于任何内容包
 * ---------------------------------------------------------------------------
 * 这两张图是**转场 shader 的工作物料**，不是"内容"：
 *   noise       —— 灰度噪声，让溶解边界永远在抖，不会像机械蒙版
 *   mudNormal   —— 法线图，R 通道用作位移偏移，让边界有"泥浆流动"的有机感
 *
 * 它们由引擎默认提供（app 装配时自动合入资产表），内容包不需要重复声明。
 * 内容包想换成自己美术做的噪声图，只需在自己的 assets 里用**同名 key** 覆盖即可
 * （合并顺序是 `{ ...ENGINE_ASSETS, ...pack.assets }`，后写的赢）。
 */

import type { AssetRegistry } from '../schema';

export const ENGINE_ASSETS: AssetRegistry = {
  noise: { path: 'engine/noise.png', kind: 'image' },
  mudNormal: { path: 'engine/mud-normal.png', kind: 'image' },
};

/** 引擎资产的默认 key —— 内容包的 site.transitionTextures 默认指向它们 */
export const DEFAULT_TRANSITION_TEXTURES = {
  noise: 'noise',
  displacement: 'mudNormal',
} as const;
