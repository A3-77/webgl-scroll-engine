/**
 * Shopify 内容包 —— 站点配置
 * ---------------------------------------------------------------------------
 * 这里保留的是**对 Shopify Winter '26 的运行时实测值**（见 03-深度还原.md §5）。
 * 它们不是引擎默认值（引擎默认见 src/config/design.ts），而是这个内容包自己的视觉决策。
 *
 * 实测依据：
 *   H2 computed style = font-size 149.386px / font-weight 700
 *                       letter-spacing -0.03em / line-height 0.9
 *   字体族：NeueMontreal（正文/标题）、HWCigars（展示）、ImperialScript（手写）
 *   tailwind v4.2.2，@layer theme/base/components/utilities/properties/transitions
 *
 * ⚠️ 那三个字体是 Shopify 的授权字体，本包只声明 font-family 名，
 *   不打包字体文件 —— 本地没装就自然回落到系统字体，不会 404。
 */

import { DESIGN } from '../../config/design';
import { DEFAULT_TRANSITION_TEXTURES } from '../engine-assets';
import type { SiteConfig } from '../types';

export const SITE: SiteConfig = {
  title: 'Winter 2026 — Shopify 内容包',

  font: {
    sans: '"NeueMontreal","Helvetica Neue",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif',
    display: '"HWCigars","NeueMontreal",Georgia,"Songti SC",serif',
    script: '"ImperialScript","Snell Roundhand",cursive',
  },

  type: {
    /** 真实站点 H2 的实测值，上限对齐 149.386px */
    h2: {
      fontSize: 'clamp(40px, 9.3vw, 149.386px)',
      fontWeight: 700,
      letterSpacing: '-0.03em',
      lineHeight: 0.9,
    },
    h3: DESIGN.type.h3,
    eyebrow: DESIGN.type.eyebrow,
    body: DESIGN.type.body,
  },

  transitionTextures: { ...DEFAULT_TRANSITION_TEXTURES },
};
