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
// 依赖方向：content/ → schema/ ✓（契约层是唯一被两边共享的东西）
import type { PostConfig } from '../../schema';
import type { SiteConfig } from '../types';

/**
 * ★ Cats 包的胶片风格
 * ---------------------------------------------------------------------------
 * 为什么这里要显式声明一套，而不是直接用引擎默认值：
 *   DEFAULT_POST 是**中立**的（轻颗粒 + 轻色差），套在任何素材上都不会出错，
 *   但也因此没有性格。Cats 的素材是油画质感的猫，走"印刷/胶片"方向更合适 ——
 *   油墨网点、重颗粒、边缘色散，正好呼应参考站点 shader.se 的观感。
 *
 *   这就是「内容包声明审美，引擎只负责执行」这条分工的实际样子：
 *   换一套观感 = 改这个文件，引擎一行不动。
 *
 * 【几个值的来历】
 *   noise.opacity 0.11 —— 再高就开始盖掉画面细节（实测 0.15 时猫的胡须糊了）
 *   chromaticAberration.offset [0.0016, 0.0012] —— 约 2~3 像素 @1080p，
 *     静止时几乎看不见，切章时 ×2.2 才炸得出来
 *   scanline.density 1.6 —— 低于 1 会出摩尔纹
 *   bloom.intensity 0.7 —— 比默认低：油画本身亮部就多，泛光给大了会糊
 */
const POST: PostConfig = {
  enabled: true,
  frameBufferType: 'halfFloat',
  multisampling: 0,
  effects: [
    // 顺序有意义：先调色 → 再上质感 → 最后泛光。
    // 反过来的话，颗粒和色差会被 bloom 一起模糊掉，等于白加。
    {
      kind: 'brightnessContrast',
      brightness: 0.02,
      contrast: 1.06,
      pulse: 0,
    },
    {
      kind: 'hueSaturation',
      hue: 0,
      // 略降饱和：油画素材本身偏艳，压一点才有"印刷油墨"的味道
      saturation: 0.92,
      pulse: 0,
    },
    {
      kind: 'bloom',
      intensity: 0.7,
      luminanceThreshold: 0.66,
      luminanceSmoothing: 0.5,
      mipmapBlur: true,
      radius: 0.7,
      pulse: 0.4,
    },
    {
      kind: 'chromaticAberration',
      offset: [0.0016, 0.0012],
      radialModulation: true,
      modulationOffset: 0.3,
      // 切章瞬间色散炸开 —— 最抓眼球的一下
      pulse: 2.2,
    },
    {
      kind: 'noise',
      blend: 'overlay',
      opacity: 0.11,
      premultiply: false,
      pulse: 1.5,
    },
    {
      kind: 'scanline',
      density: 1.6,
      opacity: 0.045,
      pulse: 0.6,
    },
    {
      kind: 'vignette',
      offset: 0.28,
      darkness: 0.5,
      pulse: 0.5,
    },
  ],
};

export const SITE: SiteConfig = {
  title: 'WebGL Scroll Engine — Cats',
  font: DESIGN.font,
  type: DESIGN.type,
  transitionTextures: { ...DEFAULT_TRANSITION_TEXTURES },
  post: POST,
};
