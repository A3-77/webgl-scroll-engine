/**
 * Placeholder 内容包 —— 站点配置
 * ---------------------------------------------------------------------------
 * 用引擎默认的设计 token（中性系统字体栈），不做任何品牌化。
 */

import { DESIGN } from '../../config/design';
import { DEFAULT_TRANSITION_TEXTURES } from '../engine-assets';
import type { SiteConfig } from '../types';

export const SITE: SiteConfig = {
  title: 'WebGL Scroll Engine — Placeholder',
  font: DESIGN.font,
  type: DESIGN.type,
  transitionTextures: { ...DEFAULT_TRANSITION_TEXTURES },
};
