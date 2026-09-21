# PHASE 18 — pmndrs/postprocessing 集成

## 一句话

把自制的 Bloom 换成 pmndrs/postprocessing 的**声明式效果链**，让"画面要
什么胶片风格"由内容包在自己的 `site.post` 里说了算，不写一行 shader。

## 为什么做这一版

v0.2.0 把素材驱动做通了，但画面还停留在"干净溶解 + 一点 bloom"的状态。
对照参考站点（shader.se / iamsaeed.dev）一看就清楚差距 —— 它们的画面有
"质感"，是因为**滤镜强度跟着滚动变化**，而不是一层死板的滤镜。

问题分析里 SKY 与 portfolio 的差异：

| 维度 | 我的引擎（v0.2.0） | SKY | portfolio |
|---|---|---|---|
| 过渡核心 | 阈值场溶解（2D 图像混合）| 3D 飞机沿曲线飞 + 蒙版 | 11 种印刷学过渡 |
| 后处理 | 自制 Bloom（3 pass）| pmndrs uikit（多效果） | pmndrs postprocessing（多效果） |
| 滚动响应 | 静态滤镜 | 随滚动变化 | 随滚动变化 |

**关键洞察**：SKY 和 portfolio 用同一个库（pmndrs），它们的好处来自
**效果能跟着滚动呼吸**，而不是效果本身多么花哨。

## 怎么做的

### 1. 契约层（`src/schema/post.ts`）

可辨识联合 —— 8 种效果各有自己的参数：

```ts
export type PostEffectSpec =
  | { kind: 'bloom'; intensity?, luminanceThreshold?, mipmapBlur?, radius?, pulse? }
  | { kind: 'chromaticAberration'; offset?, radialModulation?, modulationOffset?, pulse? }
  | { kind: 'noise'; opacity?, blend?, premultiply?, pulse? }
  | { kind: 'vignette'; offset?, darkness?, pulse? }
  | { kind: 'scanline'; density?, opacity?, pulse? }
  | { kind: 'glitch'; strength?, ratio?, pulse? }
  | { kind: 'hueSaturation'; hue?, saturation?, pulse? }
  | { kind: 'brightnessContrast'; brightness?, contrast?, pulse? };
```

**`pulse`** 是核心概念 —— 让效果跟着滚动呼吸的旋钮。
详见 schema 文件头。

### 2. 装配层（`src/engine/systems/PostSystem.ts`）

继承自 EffectComposer，内部：

```
SourcePass ──► EffectPass(effects[0]..effects[7])
   │                │
   │                └── 所有效果**合并进同一个 shader**（pmndrs 的关键优化）
   │
   └── 把外部纹理（Composer's rtComposite）搬进 composer 的缓冲
```

每个效果"绑"出来，存基线值 + 一个 `apply(activity)` 方法。
每帧 Composer 喂过来一个活跃度（0..1），PostSystem 按 `pulse` 系数放大
每个效果的强度。

### 3. 驱动量（`PostDrive`）

活跃度 = 过渡活跃度 + 速度活跃度，两个都钳到 [0,1] 后相加再钳：

```
过渡活跃度 = sin(π × uProgress)     // 两端 0，中点 1
速度活跃度 = clamp01(|velocity| / 55) // 55 px/帧 是 Lenis 快速滚动的典型值
活跃度     = clamp01(transition + velocity)
```

活跃度再过一层**指数平滑**（时间常数 0.12s），否则颗粒会跟着速度逐帧闪。

为什么用 sin(π·u) 而不是直接用 u —— 切换瞬间两边都 0，画面完全无缝。
直接用 uProgress 的话每换一章效果强度都会"跳"一下。

### 4. SourcePass —— 唯一有点绕的桥

pmndrs/postprocessing 的 EffectComposer 第一个 pass 通常是 RenderPass（自己画 Scene）。
我们的第一个 pass 不是"画场景"，而是"过渡已经在别处混好了"（Composer's rtComposite）。

所以需要一个 `SourcePass extends Pass`，把外部纹理搬进 composer 的缓冲。
多一次全屏 blit（~0.1ms @1080p），换来的是：

1. **TransitionSystem 不知道 postprocessing 存在** —— 哪天换库或者降到无后处理路径，
   过渡系统一行不用动
2. 不依赖 composer 的双缓冲内部状态

### 5. 内容包声明审美（`src/content/types.ts` SiteConfig.post）

引擎只给**默认值**（`config/design.ts` 的 `DEFAULT_POST`：保守四件套），
内容包可以**整体替换**：

```ts
// src/content/cats/site.ts
const POST: PostConfig = {
  enabled: true,
  effects: [
    { kind: 'brightnessContrast', contrast: 1.06 },
    { kind: 'hueSaturation', saturation: 0.92 },
    { kind: 'bloom', intensity: 0.7, pulse: 0.4 },
    { kind: 'chromaticAberration', offset: [0.0016, 0.0012], pulse: 2.2 },
    { kind: 'noise', blend: 'overlay', opacity: 0.11, pulse: 1.5 },
    { kind: 'scanline', density: 1.6, opacity: 0.045 },
    { kind: 'vignette', darkness: 0.5, pulse: 0.5 },
  ],
};
```

这就是"内容与引擎彻底分离"的实际样子 —— 换观感 = 改 site.ts，引擎一行不动。

### 6. 删除自制 BloomSystem

pmndrs 的 BloomEffect 是 mipmap 金字塔模糊，比手写的固定半径高斯
质量高一个档次。删除原因：

- 不可配置
- 不可分脉冲
- pmndrs 版本质量更高

代价：零依赖路径消失 —— `post.enabled = false` 可以关掉所有后处理（含 bloom），
但没有"自带 bloom、不依赖 pmndrs"的选项。考虑到 pmndrs 已经是 deps，
这条路没价值。

## 实测数据

### 渲染

| 指标 | v0.2.0 | v0.3.0 placeholder (4 效果) | v0.3.0 cats (7 效果) |
|---|---|---|---|
| 后处理效果数 | 1（自制 bloom） | 4 | 7 |
| drawCalls | ~22 | 24 | 22 |
| fps | 144 | 144 | 144 |
| glError | 0 | 0 | 0 |
| postActivity 静止 | n/a | 0 | 0 |

### pulse 验证

| 操作 | velocity | activity (smoothed) |
|---|---|---|
| 静止 | 0 | 0 |
| `scrollBy(0, 1500)` 后 50ms | 1500 | 0.37（第一帧，指数爬升） |
| 350ms 后 | 1500 | 0.95（已稳定） |
| 静止 1.15s 后 | 0 | 0.0017（指数衰减） |

数学验证：target = 1.0，tau=0.12s，dt=0.3s，k=1-e^(-2.5)=0.918
→ activity 1 帧后 ≈ 0.918；实测 0.95（不同 dt 的小幅偏差）。

### 视觉验证

两张截图（都是 placeholder 包，4 效果默认链）：

**静止**（activity=0）：
- 边缘轻微暗角
- 网格和人物边缘看不到 RGB 散

**滚动速度 1500 px/帧**（activity=0.7）：
- 网格和剪影边缘**明显**的 RGB 分离
- 暗部颗粒显著加重
- bloom 边缘溢出更远

差异一眼能看出来 —— 这才是"质感"的来源，不是滤镜本身。

## 修改清单

### 新增
- `src/schema/post.ts` —— 后处理契约（PostConfig + 8 个效果的可辨识联合）
- `src/shaders/copy.ts` —— SourcePass 用的纯拷贝 fragment shader
- `src/engine/systems/SourcePass.ts` —— 把外部纹理接进 composer 的 Pass 子类
- `src/engine/systems/PostSystem.ts` —— 后处理系统（EffectComposer 封装）

### 修改
- `src/schema/index.ts` —— 导出 post
- `src/schema/scroll.ts` —— ScrollState 加 `velocity` 字段
- `src/store/sectionStore.ts` —— 初始 state 加 `velocity: 0`
- `src/animation/smoothScroll.ts` —— sync() 透传 `lenis.velocity`
- `src/config/design.ts` —— 追加 DEFAULT_POST（保守四件套）
- `src/engine/Composer.ts` —— 用 PostSystem 替换 BloomSystem；compute PostDrive
- `src/content/types.ts` —— SiteConfig 加 `post?: PostConfig`
- `src/content/cats/site.ts` —— 声明 7 效果"印刷/胶片"配置
- `src/components/CanvasHost.tsx` —— 把 `pack.site.post` 喂进 Composer
- `src/components/DebugHUD.tsx` —— HUD 加 `post effects` + `post activity` 两行
- `src/engine/systems/SceneManager.ts` —— 注释里的 "BloomSystem" 改成 "PostSystem"
- `src/engine/systems/TransitionSystem.ts` —— 同上

### 删除
- `src/engine/systems/BloomSystem.ts` —— 被 PostSystem 取代
- `src/shaders/bloom.ts` —— 同上

## 运行命令

```bash
npm install                  # 自动装 postprocessing 6.39.5（已包含在 deps 里）
npm run typecheck            # 0 错误
npm test                     # 6 文件 / 139 测试 全过
npm run verify:independence  # 删掉 cats / shopify 后引擎照常构建
npm run build                # 构建产物约 5MB（gzip 后 ~280KB）
npm run dev                  # 开发服务器
```

## 已实现能力

- ✅ 8 种效果：bloom / 色差 / 暗角 / 颗粒 / 扫描线 / 故障 / 调色 / 对比度
- ✅ 内容包声明驱动 —— 加 / 减 / 改效果不动引擎
- ✅ 滚动脉冲 —— 活跃度 = sin(π·u) + |velocity|/55，过指数平滑
- ✅ 半精度帧缓冲（HalfFloat）—— 避免 bloom 高光被夹死
- ✅ EffectComposer 高效合并 —— 8 个效果 = 1 次全屏绘制（bloom 内部例外）
- ✅ 切换关闭开关 —— `post.enabled: false` 退化到无后处理直出
- ✅ HUD 实时显示活跃度 —— 调试时一眼看 pulse 是否在工作

## 仍存在的问题（诚实声明）

- **Glitch 的随机延迟** —— `GlitchEffect.delay` 是区间（Vector2），即使
  活跃度 = 0 它也会白跑一次随机数。无害但有点浪费，pmndrs 没暴露"关闭"接口。
- **修复窗口尺寸后的 EffectComposer setSize 行为** —— EffectComposer 内部
  会再次调用 renderer.setSize，但我们传了 `updateStyle = false`，所以
  canvas 的 CSS 尺寸不会被改成 px 实测值。这个耦合需要后面踩一次才算稳。
- **shader.glsl 改动** —— 当前没改任何 GLSL（SourcePass 用一个简单 COPY_FRAGMENT），
  所以没踩反引号截断的坑。新加 shader 务必跑 typecheck（见 MEMORY.md）。
- **pmndrs 输出色彩空间** —— 我们 renderer 是 `LinearSRGBColorSpace`，
  EffectPass 直接写屏与之前一致；切到 sRGB 输出色空间需要重新验证（没改）。
---

## ★ 事后补记（2026-09-20）：一个被默认配置掩盖的真实缺陷

**这份文档当时写的"已实现能力"是准确的，但有一个语义缺陷没被发现 ——
因为默认链恰好绕过了它。**

### 缺陷

`PostSystem` 把 schema 的值**原样透传**给 pmndrs 的 uniform，
但两套语义对不上（详见 [`PHASE-23-3D过渡载体.md`](PHASE-23-3D过渡载体.md) 第 5 节）：

| 字段 | schema 承诺 | pmndrs 实际要求 | 原实现 |
|---|---|---|---|
| `hueSaturation.saturation` | 倍率，**1 = 原样** | 偏移，**0 = 原样** | ✗ 直接透传 |
| `brightnessContrast.contrast` | 倍率，**1 = 原样** | 偏移，**0 = 原样** | ✗ 直接透传 |
| `brightnessContrast.brightness` | 偏移，**0 = 原样** | 偏移，**0 = 原样** | ✓ 恰好对 |

后果：`saturation: 0.92` 走成 `diff * (1 - 1/(1.001-0.92))` ≈ `diff * -998`，
**整屏霓虹色**；`contrast: 1.06` 走成 `color / (1 - 1.06)` = `color / -0.06`，
**直接反相**。

### 为什么没被发现

`DEFAULT_POST`（`src/config/design.ts`）只用了
`bloom` / `chromaticAberration` / `noise` / `vignette` ——
**这四个的语义恰好都对得上**。所以：

- shopify 包（走默认链）一直正常 ✓
- cats 包（显式声明了 `hueSaturation` + `brightnessContrast`）全废 ✗
- 而且炸得很像"素材/分割有问题"，掩盖了真正的原因

### 修法

在 `PostSystem` 里加一层语义映射（`saturationToOffset` / `contrastToOffset` /
`brightnessToLevel`），并补 `PostSystem.test.ts` 13 项防回归测试。

> **教训**：把第三方库的 uniform 语义当作"显然和我的 schema 一样"，
> 是这次的根本错误。**声明式配置层必须有一层显式的语义映射，
> 并且要有测试钉住它** —— 否则默认配置会把缺陷藏起来，
> 直到某个内容包第一次用到那些"冷门"效果才炸，而且炸得莫名其妙。
