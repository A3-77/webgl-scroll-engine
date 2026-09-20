/**
 * Shopify 内容包
 * ---------------------------------------------------------------------------
 * ⚠️ 这是**逆向工程的产物，不是引擎的一部分**。版权归 Shopify 及原权利人，
 *   仅限个人研究。详见仓库根 README 与 LICENSE。
 *
 * 【它存在的意义】
 *   作为「真实世界复杂度」的验证台：4 章、KTX2 压缩背景 + GLB 蒙皮模型、
 *   单模型 144,040 顶点 / 20 骨骼、Draco 压缩到 726KB。
 *   placeholder 包跑得起来只能说明引擎没坏；这个包跑得起来才说明引擎**扛得住真实素材**。
 *
 * 【验收 1 的判定对象】
 *   把 src/content/shopify/ 整个目录删掉，引擎 + placeholder 包必须照常运行。
 *   原因：content.config.ts 用 `import.meta.glob` 自动发现内容包，
 *   不存在的目录不会出现在 glob 结果里，也不会有任何静态 import 指向它。
 *   删掉它，构建照常通过，只是 `?content=shopify` 会提示"内容包不存在"。
 *
 * 【★ 它同时是「引擎通用性」的证据】
 *   同一个引擎上跑着两种**形态完全不同**的内容包：
 *
 *     cats     —— 素材驱动：运行时读 manifest 自动构图，纯平面，透明 PNG
 *     shopify  —— 手写场景：静态 scenes + KTX2 压缩纹理 + GLB 蒙皮模型（4.9 万三角形）
 *
 *   引擎对这两者一视同仁（都只是 `ContentPack`），因为它只认 schema。
 *   这是"内容与引擎彻底解耦"最直接的证明 —— 比任何架构图都有说服力。
 *
 * 【依赖：素材在仓库外】
 *   它读 ../repo/assets-original/（由 vite 插件 serveOriginals 提供）。
 *   所以**单独拿走 webgl-scroll-engine/ 时这个包会报缺素材** ——
 *   那不是引擎的问题，是它本来就依赖逆向研究时抓下来的原始素材。
 *   处理方式二选一：整个删掉，或者把素材拷进项目根的 assets-original/。
 */

import type { ContentPack } from '../types';
import { ASSETS } from './assets';
import { SCENES } from './scenes';
import { SITE } from './site';

export const pack: ContentPack = {
  id: 'shopify',
  label: 'Shopify Winter 2026',
  description: '逆向工程的真实素材 · 4 章 · KTX2 背景 + GLB 蒙皮模型。仅限个人研究。',
  site: SITE,
  assets: ASSETS,
  scenes: SCENES,
  attribution: '素材版权归 Shopify 及原权利人所有，仅限个人研究使用。',
};

export { ASSETS, SCENES, SITE };
