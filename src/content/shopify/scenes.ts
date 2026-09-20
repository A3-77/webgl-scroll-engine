/**
 * Shopify 内容包 —— 场景定义（Demo Content Pack）
 * ---------------------------------------------------------------------------
 * ⚠️ 这是**逆向工程的产物，不是引擎的一部分**。
 *   资产为原站公开 CDN 上的内容副本，版权归 Shopify 及原权利人，仅限个人研究。
 *
 * 它的存在有两个意义：
 *   1. 作为「真实世界复杂度」的验证 —— 4 章、KTX2 背景 + GLB 蒙皮模型、
 *      144k 顶点、170 骨骼，用来证明引擎扛得住真实素材。
 *   2. 作为「内容包可以多复杂」的参考。
 *
 * 【验收 1 的判定对象】删掉整个 src/content/shopify/ 目录，
 *   引擎与 placeholder 包必须照常运行 —— 因为 engine/ 里没有任何 import 指向它。
 *
 * 用它们跑：http://127.0.0.1:5173/?content=shopify
 */

import type { SceneConfig } from '../../schema';
import { DESIGN } from '../../config/design';

/** 按规则推导 earlyCrossfade（原站实现：index >= 2 ? 0.2 : 0） */
const crossfadeFor = (index: number): number =>
  index >= DESIGN.earlyCrossfadeFrom ? DESIGN.earlyCrossfadeAmount : 0;

const ORIGINAL_SCENES: SceneConfig[] = [
  /* ==================================================== B1 Hero（原站素材） */
  {
    id: 'o-scene-hero',
    handle: 'hero',
    index: 0,
    eyebrow: 'Original 01',
    title: 'Winter 2026',
    body:
      '原站真实素材：KTX2 背景 + GLB 前景模型（36,125 顶点 / 170 骨骼 / 6 段动画）。' +
      '动画由滚动进度驱动 —— 原站是挂在 Theatre.js 时间轴上被 sequence.position 拖着走的。',
    accent: '#e8c08a',
    background: '#1a1210',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(0),
    transition: { mode: 'radial', fadeCenter: [0, 0, 0] },
    camera: {
      z: 6.44,
      fov: 25,
      tracks: [
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 6.44, ease: 'easeInOut' },
          { t: 1.0, value: 4.60 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 25.0, ease: 'easeInOut' },
          { t: 1.0, value: 22.27 },
        ]},
      ],
    },
    objects: [
      {
        id: 'bg',
        role: 'background',
        type: 'plane',
        asset: 'oHeroBg',
        opaque: true,
        z: -30,
        overscan: 1.16,
        offset: [0, 0],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.05, ease: 'easeInOut' }, { t: 1, value: -0.05 },
          ]},
          { path: 'scale.x', keyframes: [
            { t: 0, value: 1.0, ease: 'easeOutCubic' }, { t: 1, value: 1.05 },
          ]},
        ],
      },
      {
        id: 'model',
        role: 'subject',
        type: 'model',
        asset: 'oHeroModel',
        modelHeight: 0.86,
        scrubAnimations: true,
        z: -8,
        overscan: 1,
        offset: [0.06, -0.05],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.16, ease: 'easeInOut' }, { t: 1, value: -0.14 },
          ]},
          { path: 'position.x', keyframes: [
            { t: 0, value: 0.03, ease: 'easeInOut' }, { t: 1, value: -0.02 },
          ]},
          { path: 'rotation.z', keyframes: [
            { t: 0, value: 0.0, ease: 'easeInOut' }, { t: 1, value: 0.03 },
          ]},
        ],
      },
    ],
  },

  /* ================================================ B2 Sidekick（原站素材） */
  {
    id: 'o-scene-sidekick',
    handle: 'sidekick',
    index: 1,
    eyebrow: 'Original 02',
    title: 'Sidekick',
    body:
      '星空背景本身也是一个 GLB —— 但它只有 4 个顶点、2 个三角面，' +
      '就是一块 quad，KTX2 贴图直接烘在 GLB 里。这是 04 报告第 2 节的现场验证。',
    accent: '#8fd6e8',
    background: '#0a1424',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(1),
    transition: { mode: 'sweep', fadeCenter: [0, 0, 0] },
    camera: {
      z: 5.2,
      fov: 24,
      tracks: [
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 5.20, ease: 'easeInOut' },
          { t: 1.0, value: 7.20 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 24.0, ease: 'easeInOut' },
          { t: 1.0, value: 28.0 },
        ]},
        { path: 'position.x', keyframes: [
          { t: 0.0, value: -0.26, ease: 'easeInOut' },
          { t: 1.0, value: 0.22 },
        ]},
      ],
    },
    objects: [
      {
        id: 'stars',
        // 远景星点层 —— 视觉上是背景（z=-32），但它带 ±0.03 的 x 漂移。
        // role 表达的是"这一层是什么"，不是"它必须静止"。
        role: 'background',
        type: 'model',
        asset: 'oSidekickStars',
        modelHeight: 1.35,
        z: -32,
        overscan: 1,
        offset: [0, 0],
        tracks: [
          { path: 'position.x', keyframes: [
            { t: 0, value: 0.03, ease: 'easeInOut' }, { t: 1, value: -0.03 },
          ]},
        ],
      },
      {
        id: 'model',
        role: 'subject',
        type: 'model',
        asset: 'oSidekickModel',
        modelHeight: 0.9,
        z: -9,
        overscan: 1,
        offset: [0.1, -0.02],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: -0.12, ease: 'easeInOut' }, { t: 1, value: 0.12 },
          ]},
          { path: 'rotation.z', keyframes: [
            { t: 0, value: -0.05, ease: 'easeInOut' }, { t: 1, value: 0.04 },
          ]},
        ],
      },
    ],
  },

  /* ============================================= B3 Operations（原站素材） */
  {
    id: 'o-scene-operations',
    handle: 'operations',
    index: 2,
    eyebrow: 'Original 03',
    title: 'Operations',
    body:
      '全站最大的模型：144,040 顶点 / 65,780 三角面 / 20 骨骼。' +
      'Draco 压缩后只有 726 KB —— 这个压缩比就是原站敢在首屏放几十个模型的底气。',
    accent: '#a8e0b0',
    background: '#0e1a14',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(2),
    transition: { mode: 'sweep', fadeCenter: [0, 0, 0] },
    camera: {
      z: 7.0,
      fov: 26,
      tracks: [
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 7.00, ease: 'easeInOut' },
          { t: 1.0, value: 5.40 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 26.0, ease: 'easeInOut' },
          { t: 1.0, value: 23.0 },
        ]},
        { path: 'position.y', keyframes: [
          { t: 0.0, value: 0.14, ease: 'easeInOut' },
          { t: 1.0, value: -0.12 },
        ]},
      ],
    },
    objects: [
      {
        id: 'bg',
        role: 'background',
        type: 'plane',
        asset: 'oOperationsBg',
        opaque: true,
        z: -34,
        overscan: 1.18,
        offset: [0, 0],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: -0.03, ease: 'easeInOut' }, { t: 1, value: 0.05 },
          ]},
        ],
      },
      {
        id: 'model',
        role: 'subject',
        type: 'model',
        asset: 'oOperationsModel',
        modelHeight: 0.82,
        scrubAnimations: true,
        z: -10,
        overscan: 1,
        offset: [0.02, -0.04],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.14, ease: 'easeInOut' }, { t: 1, value: -0.14 },
          ]},
        ],
      },
    ],
  },

  /* ================================================= B4 Finance（原站素材） */
  {
    id: 'o-scene-finance',
    handle: 'finance',
    index: 3,
    eyebrow: 'Original 04',
    title: 'Finance',
    body:
      '48,384 顶点 / 46,793 三角面 / 66 骨骼。这个模型声明了 KHR_materials_unlit —— ' +
      '也就是它**不参与光照计算**，直接输出贴图色。和 Hero 正好构成两种材质的对照。',
    accent: '#f0c46a',
    background: '#1a1508',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(3),
    transition: { mode: 'sweep', fadeCenter: [0, 0, 0] },
    camera: {
      z: 7.6,
      fov: 27,
      tracks: [
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 7.60, ease: 'easeInOut' },
          { t: 1.0, value: 5.80 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 27.0, ease: 'easeInOut' },
          { t: 1.0, value: 24.0 },
        ]},
        { path: 'position.x', keyframes: [
          { t: 0.0, value: 0.18, ease: 'easeInOut' },
          { t: 1.0, value: -0.16 },
        ]},
      ],
    },
    objects: [
      {
        id: 'bg',
        role: 'background',
        type: 'plane',
        asset: 'oFinanceBg',
        opaque: true,
        z: -33,
        overscan: 1.16,
        offset: [0, 0],
        tracks: [
          { path: 'position.x', keyframes: [
            { t: 0, value: -0.03, ease: 'easeInOut' }, { t: 1, value: 0.03 },
          ]},
        ],
      },
      {
        id: 'model',
        role: 'subject',
        type: 'model',
        asset: 'oFinanceModel',
        modelHeight: 0.84,
        scrubAnimations: true,
        z: -9,
        overscan: 1,
        offset: [-0.04, -0.03],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.13, ease: 'easeInOut' }, { t: 1, value: -0.13 },
          ]},
          { path: 'rotation.z', keyframes: [
            { t: 0, value: 0.02, ease: 'easeInOut' }, { t: 1, value: -0.02 },
          ]},
        ],
      },
    ],
  },
];

export const SCENES = ORIGINAL_SCENES;
