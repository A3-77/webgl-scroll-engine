/**
 * Cats 内容包 —— 站点配置
 * ---------------------------------------------------------------------------
 * 这是"素材驱动"包，场景与资产都由 build-assets 的 manifest 自动生成，
 * 所以这里**只**剩下与素材无关的东西：标题、字体、排版、过渡纹理。
 *
 * 用引擎默认的设计 token（中性系统字体栈），不做品牌化 ——
 * 这一版的目标是验证引擎，不是做一个好看的网站。
 */

import { DESIGN } from '../../config/design';
import { DEFAULT_TRANSITION_TEXTURES } from '../engine-assets';
import type { SiteConfig } from '../types';

export const SITE: SiteConfig = {
  title: 'WebGL Scroll Engine — Cats',
  font: DESIGN.font,
  type: DESIGN.type,
  transitionTextures: { ...DEFAULT_TRANSITION_TEXTURES },
};
