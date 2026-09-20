/**
 * Placeholder 内容包
 * ---------------------------------------------------------------------------
 * 引擎的"体检包"：不依赖任何外部素材，开箱即跑，用来验证引擎本身是否正常。
 * 任何改动引擎之后，先用它跑一遍 —— 它跑得起来，才说明引擎没坏。
 *
 * 【约定】每个内容包的 index.ts 必须导出一个名为 `pack` 的 ContentPack。
 *   content.config.ts 用 import.meta.glob 自动发现所有包，靠的就是这个约定。
 */

import type { ContentPack } from '../types';
import { ASSETS } from './assets';
import { SCENES } from './scenes';
import { SITE } from './site';

export const pack: ContentPack = {
  id: 'placeholder',
  label: 'Placeholder',
  description: '程序化抽象图 · 3 章 · 纯平面 2D 合成。引擎自检用，不依赖外部素材。',
  site: SITE,
  assets: ASSETS,
  scenes: SCENES,
};

export { ASSETS, SCENES, SITE };
