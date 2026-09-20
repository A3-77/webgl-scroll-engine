/**
 * Placeholder 内容包 —— 场景定义
 * ---------------------------------------------------------------------------
 * 程序化生成的抽象图（tools/gen_assets.py 的产物），开箱即跑，
 * 不携带任何第三方美术资产。用途是「验证引擎本身」而不是「展示内容」。
 *
 * 结构：3 章 x 3 层平面（bg / mid / fg），全部 MeshBasicMaterial，纯 2D 合成。
 *
 * 这是「内容包」的示范写法：一个包 = 一份场景数组 + 一张资产表 + 一份站点配置。
 * 想加自己的内容，照着这个目录复制一份即可，引擎一行都不用改。
 */

import type { SceneConfig } from '../../schema';
import { DESIGN } from '../../config/design';

/** 按规则推导 earlyCrossfade（原站实现：index >= 2 ? 0.2 : 0） */
const crossfadeFor = (index: number): number =>
  index >= DESIGN.earlyCrossfadeFrom ? DESIGN.earlyCrossfadeAmount : 0;

const PLACEHOLDER_SCENES: SceneConfig[] = [
  /* ============================================================ 01 Hero */
  {
    id: 'scene-hero',
    handle: 'hero',
    index: 0,
    eyebrow: 'Edition 01',
    title: 'Winter 2026',
    body: '滚动驱动的双场景交叉溶解。背景、中景、前景分别位于不同 z 深度，相机推进时自然产生视差。',
    accent: '#e8c08a',
    background: '#1a1210',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(0),
    transition: { mode: 'radial', fadeCenter: [0, 0, 0] },
    camera: {
      z: 6.44,
      fov: 25,
      tracks: [
        // 真实站点 Hero 的相机 z 从 6.439 出发；fov 实测从 25 收到 22.27
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 6.44, ease: 'easeInOut' },
          { t: 1.0, value: 4.20 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 25.0, ease: 'easeInOut' },
          { t: 1.0, value: 22.27 },
        ]},
        { path: 'position.y', keyframes: [
          { t: 0.0, value: -0.25, ease: 'easeInOut' },
          { t: 1.0, value: 0.10 },
        ]},
        { path: 'rotation.z', keyframes: [
          { t: 0.0, value: 0.0, ease: 'easeInOut' },
          { t: 1.0, value: -0.03 },
        ]},
      ],
    },
    objects: [
      {
        id: 'bg',
        role: 'background',
        asset: 'heroBg',
        // 满幅背景标成不透明：见 LayerConfig.opaque 的注释（否则会盖住前景模型）
        opaque: true,
        z: -30,
        overscan: 1.16,
        offset: [0, 0],
        tint: '#ffffff',
        tracks: [
          // 远景几乎不动 —— 视差的最外层
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.05, ease: 'easeInOut' }, { t: 1, value: -0.05 },
          ]},
          { path: 'scale.x', keyframes: [
            { t: 0, value: 1.0, ease: 'easeOutCubic' }, { t: 1, value: 1.05 },
          ]},
        ],
      },
      {
        id: 'mid',
        role: 'subject',
        fit: 'contain',
        asset: 'heroMid',
        z: -11,
        overscan: 0.88,
        // 右移 + 略微下沉，给左侧标题让位，也让剪影落在视口下半部
        offset: [0.28, -0.06],
        tracks: [
          // 中景：主体，位移最明显
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.18, ease: 'easeInOut' }, { t: 1, value: -0.16 },
          ]},
          { path: 'position.x', keyframes: [
            { t: 0, value: 0.04, ease: 'easeInOut' }, { t: 1, value: -0.03 },
          ]},
          { path: 'rotation.z', keyframes: [
            { t: 0, value: 0.0, ease: 'easeInOut' }, { t: 1, value: 0.035 },
          ]},
        ],
      },
      {
        id: 'fg',
        role: 'subject',
        fit: 'contain',
        asset: 'heroFg',
        z: -2.4,
        overscan: 1.4,
        offset: [0, -0.34],
        // ★ 能力验收点 ①：parallax 倍率
        //   z 深度产生的视差是"物理正确"的，但物理正确 ≠ 好看。
        //   1.4 = 让这一层比几何允许的动得更狠一点（前景冲刺感）。
        //   倍率只作用于**轨道位移**，不作用于投影本身，所以不破坏构图。
        parallax: 1.4,
        tracks: [
          // 前景：跑得最快 —— 视差最强
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.12, ease: 'easeInOut' }, { t: 1, value: -0.26 },
          ]},
          { path: 'scale.y', keyframes: [
            { t: 0, value: 1.0, ease: 'easeOutCubic' }, { t: 1, value: 1.12 },
          ]},
        ],
      },
    ],
  },

  /* ======================================================== 02 Sidekick */
  {
    id: 'scene-sidekick',
    handle: 'sidekick',
    index: 1,
    eyebrow: 'Edition 02',
    title: 'Sidekick',
    body: '冷色章节。相机反向拉远，配合斜向擦除的阈值场，形成与上一章完全不同的进入方式。',
    accent: '#8fd6e8',
    background: '#0a1424',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(1),
    transition: { mode: 'sweep', fadeCenter: [0, 0, 0] },
    camera: {
      z: 5.2,
      fov: 24,
      // ★ 能力验收点 ②：相机阻尼
      //   一阶低通，帧率无关的写法（1 - exp(-dt/τ)）。
      //   效果：滚动停下后相机会再滑一小段，不是硬跟。
      //   0.12 秒左右的时间常数 —— 能感觉到但不拖沓。
      damping: 0.12,
      tracks: [
        // 与 Hero 相反：拉远 + 视角变宽
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 5.20, ease: 'easeInOut' },
          { t: 1.0, value: 7.60 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 24.0, ease: 'easeInOut' },
          { t: 1.0, value: 29.0 },
        ]},
        { path: 'position.x', keyframes: [
          { t: 0.0, value: -0.30, ease: 'easeInOut' },
          { t: 1.0, value: 0.26 },
        ]},
      ],
    },
    objects: [
      {
        id: 'bg',
        role: 'background',
        asset: 'sidekickBg',
        opaque: true,
        z: -32,
        overscan: 1.12,
        offset: [0, 0],
        tracks: [
          { path: 'position.x', keyframes: [
            { t: 0, value: 0.03, ease: 'easeInOut' }, { t: 1, value: -0.03 },
          ]},
        ],
      },
      {
        id: 'mid',
        role: 'subject',
        fit: 'contain',
        asset: 'sidekickMid',
        z: -9,
        overscan: 0.92,
        offset: [0.14, -0.02],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: -0.14, ease: 'easeInOut' }, { t: 1, value: 0.12 },
          ]},
          { path: 'rotation.z', keyframes: [
            { t: 0, value: -0.06, ease: 'easeInOut' }, { t: 1, value: 0.05 },
          ]},
          { path: 'scale.x', keyframes: [
            { t: 0, value: 0.94, ease: 'easeOutCubic' }, { t: 1, value: 1.08 },
          ]},
        ],
      },
      {
        id: 'fg',
        role: 'subject',
        fit: 'contain',
        asset: 'sidekickFg',
        z: -2.4,
        overscan: 1.4,
        offset: [0, -0.30],
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: -0.10, ease: 'easeInOut' }, { t: 1, value: 0.16 },
          ]},
        ],
      },
    ],
  },

  /* ========================================================== 03 Retail */
  {
    id: 'scene-retail',
    handle: 'retail',
    index: 2,
    eyebrow: 'Edition 03',
    title: 'Retail',
    body:
      '这一章刻意复用了 01/02 的素材，只靠 config 里的色调、z 深度、相机轨道和 earlyCrossfade 做出全新章节 —— ' +
      '这就是"config 驱动 scene"的意义：加章节不用写组件。',
    accent: '#d9a0ff',
    background: '#150f22',
    heightVh: DESIGN.sectionHeightVh,
    earlyCrossfade: crossfadeFor(2), // ← index>=2，所以这里是 0.2
    transition: { mode: 'sweep', fadeCenter: [0, 0, 0] },
    camera: {
      z: 8.4,
      fov: 30,
      tracks: [
        { path: 'position.z', keyframes: [
          { t: 0.0, value: 8.40, ease: 'easeInOut' },
          { t: 1.0, value: 5.60 },
        ]},
        { path: 'fov', keyframes: [
          { t: 0.0, value: 30.0, ease: 'easeInOut' },
          { t: 1.0, value: 24.0 },
        ]},
        { path: 'position.y', keyframes: [
          { t: 0.0, value: 0.20, ease: 'easeInOut' },
          { t: 1.0, value: -0.18 },
        ]},
      ],
    },
    objects: [
      {
        id: 'bg',
        role: 'background',
        asset: 'heroBg',
        opaque: true,
        z: -34,
        overscan: 1.2,
        offset: [0, 0],
        tint: '#8f9fd4', // ← 同一张暖色图，靠 tint 变成冷紫
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: -0.04, ease: 'easeInOut' }, { t: 1, value: 0.06 },
          ]},
        ],
      },
      {
        id: 'mid',
        role: 'subject',
        fit: 'contain',
        asset: 'sidekickMid',
        z: -10,
        overscan: 1.0,
        offset: [0.24, 0.02],
        tint: '#c9a8ff',
        // ★ 能力验收点 ③：additive 混合
        //   加色混合：颜色相加而不是覆盖。深色背景下 = 发光层。
        //   这也是唯一用到 additive 的地方 —— 之前它在代码里但从没被跑过。
        blending: 'additive',
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.20, ease: 'easeInOut' }, { t: 1, value: -0.18 },
          ]},
          { path: 'rotation.z', keyframes: [
            { t: 0, value: 0.05, ease: 'easeInOut' }, { t: 1, value: -0.07 },
          ]},
        ],
      },
      {
        id: 'fg',
        role: 'subject',
        fit: 'contain',
        asset: 'heroFg',
        z: -2.2,
        overscan: 1.45,
        offset: [0, -0.36],
        tint: '#6e5f9a',
        tracks: [
          { path: 'position.y', keyframes: [
            { t: 0, value: 0.16, ease: 'easeInOut' }, { t: 1, value: -0.30 },
          ]},
          // ★ 能力验收点 ④：visible 轨道
          //   0.5 为界，> 0.5 = 显示。用于"某个对象只在特定阶段出现"。
          //   这里是最合理的用法 —— **收尾时前景退场**，只留背景和中景。
          //   注意它是硬切（布尔判定），不是淡出；要淡出应该用 opacity。
          { path: 'visible', keyframes: [
            { t: 0, value: 1 }, { t: 0.8, value: 1 }, { t: 0.82, value: 0 }, { t: 1, value: 0 },
          ]},
        ],
      },
    ],
  },
];

export const SCENES = PLACEHOLDER_SCENES;
