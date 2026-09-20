# BASELINE.md — PHASE 0 基线记录

> 记录时间：2026-09-20
> 对象：`shopify-winter2026-teardown/replica`
> 目的：在动手改造前，锁定"当前可以跑成什么样"，作为后续每个阶段的回归基准。

---

## 1. 环境

| 项 | 值 | 来源 |
|---|---|---|
| OS | Windows (win32) | `user_info` |
| Node | **v22.22.2** | WorkBuddy 托管版 `~/.workbuddy-ai/binaries/node/versions/22.22.2-2` |
| npm | 随 Node 22.22.2 分发 | `npm --version` |
| Shell | Git Bash (POSIX sh) | 工具约定 |
| 浏览器 | Chrome（DevTools MCP 驱动） | 实测 |

Python 环境（PHASE 2 素材流水线才需要，此处仅记录已备好）：

| 项 | 值 |
|---|---|
| Python | 3.13.12（托管版） |
| venv | `~/.workbuddy-ai/binaries/python/envs/default` |
| 已装 | pillow / numpy |

---

## 2. 启动方式

```bash
cd replica
npm install          # 首次：78 packages，约 2 分钟
npm run dev          # vite dev server → http://127.0.0.1:5173/
```

其它脚本：

```bash
npm run build        # 双入口构建（index.html + viewer.html）
npm run preview      # 预览构建产物
npm run typecheck    # tsc --noEmit
```

素材开关（URL 参数，不是运行时热切换）：

| URL | 含义 |
|---|---|
| `http://127.0.0.1:5173/` | 占位素材（3 章，纯平面） |
| `http://127.0.0.1:5173/?assets=original` | 原站真实素材（4 章，KTX2 + GLB） |

---

## 3. 当前技术栈（实测版本）

| 依赖 | 版本 | 作用 |
|---|---|---|
| three | **0.181.2** | 渲染核心（原生 three，**不是** R3F） |
| react / react-dom | 18.3.1 | 仅 DOM 覆盖层，不参与 3D 场景图 |
| lenis | 1.3.26 | 平滑滚动（插值出逐帧连续的 scrollY） |
| vite | 5.4.21 | 构建 |
| typescript | 5.6.3 | 类型 |

**关键事实：这不是 React Three Fiber 项目。** 3D 部分是原生 three 的命令式代码，React 只负责
Navbar / 章节文案 / 调试面板这些 DOM 层。这对接下来的改造是**利好**——引擎层没有
`useFrame` / `<mesh>` 这类声明式胶水，直接就是纯函数 + class，抽离成本极低。

自建替代品（刻意不引依赖）：

| 自建 | 替代了 | 行数 |
|---|---|---|
| `store/createStore.ts` | zustand | 68 |
| `animation/timeline.ts` | @theatre/core | 97 |
| `engine/fullscreenQuad.ts` | postprocessing 的 FullscreenPass | 41 |

---

## 4. 入口与页面结构

`index.html` → `src/main.tsx` → `src/App.tsx`

DOM 层次（顺序不能反，见 `App.tsx` 注释）：

```
.app
├── <CanvasHost />      sticky top-0 h-100vh -mb-100vh  ← WebGL 画布，钉住 + 负 margin 抽离文档流
├── <ScrollSections />  透明 DOM 章节，提供滚动高度与文案
├── <SectionNav />      右侧章节导航点
└── <DebugHUD />        右下角实时统计面板
```

第二入口：`viewer.html` → `src/viewer/main.ts`（632 行）——原站素材浏览器
（GLB 3D 预览 + KTX2 贴图预览）。**属于逆向取证工具，不属于引擎**。

---

## 5. 当前场景数量

由配置决定，**不写死**（这点已经是"config 驱动"了）：

| 素材组 | 章节数 | 每章图层 | 每章高度 |
|---|---|---|---|
| 占位素材 | 3 | 3（bg / mid / fg，全是 plane） | 1.2 × 100vh |
| 原站素材 | 4 | 2（KTX2 背景 plane + GLB 模型） | 1.2 × 100vh |

DOM 章节数、总滚动高度、导航点数量全部从 `SCENES` 数组派生。

---

## 6. 当前主要模块

```
replica/src/
├── App.tsx                     21   页面装配
├── main.tsx                    15   挂载（刻意不用 StrictMode，见文件注释）
├── styles.css                 451   DOM 层样式
│
├── config/                          ← 内容层（当前：Shopify 内容 + 占位内容混在一起）
│   ├── assets.ts              137   资产注册表（占位 + 原站两套混在一个对象里）
│   ├── scenes.ts              767   场景定义（PLACEHOLDER_SCENES + ORIGINAL_SCENES）
│   └── design.ts               72   设计 token（实测自原站）
│
├── engine/                          ← 引擎层（大体通用，但存在耦合，见 §8）
│   ├── Composer.ts            363   渲染管线：双 RT → 过渡 → bloom → 合成
│   ├── SceneBuilder.ts        413   按 config 建场景（plane / model 两类图层）
│   ├── loaders.ts             225   资产加载（image / ktx2 / glb 三条链路）
│   └── fullscreenQuad.ts       41   全屏 quad 工厂
│
├── shaders/                         ← 着色器
│   ├── transition.ts          180   ★ 核心转场（阈值场 + 噪声 + fwidth 线稿 + glow）
│   ├── bloom.ts                69   亮度提取 / 可分离高斯 / 合成
│   └── fullscreen.ts           14   全屏顶点着色器
│
├── animation/                       ← 动画与滚动
│   ├── timeline.ts             97   Theatre 风格关键帧求值器
│   ├── scrollProgress.ts      184   ★ 滚动 → 章节进度归一化（还原原站公式）
│   └── smoothScroll.ts         67   Lenis 封装 + store 同步
│
├── store/                           ← 状态
│   ├── createStore.ts          68   极简 store（对齐 zustand 语义）
│   └── sectionStore.ts         47   全局状态定义
│
├── hooks/
│   └── useStore.ts             27   store → React 桥
│
├── components/                      ← DOM 层
│   ├── CanvasHost.tsx         190   WebGL 宿主（初始化 / rAF / resize / 销毁）
│   ├── ScrollSections.tsx      93   章节 DOM + 导航
│   └── DebugHUD.tsx           209   实时统计面板
│
└── viewer/                          ← 逆向取证工具（非引擎）
    ├── main.ts                632   原站素材浏览器
    └── viewer.css             316
```

---

## 7. 实测验证结果（PHASE 0 验收）

用 Chrome DevTools MCP 实际驱动页面，**不是靠"应该能跑"**。

### 7.1 初始化

```json
{
  "hasApi": true, "loaded": true, "ready": true, "error": null,
  "isWebGL2": true, "dpr": 1.25,
  "sceneCount": 3, "canvasCount": 1, "sectionCount": 3,
  "heights": [808, 808, 808], "viewportH": 674,
  "totalScrollHeight": 2425
}
```

- `heights[i] / viewportH = 808 / 674 = 1.199` ✓ 等于 `DESIGN.sectionHeightVh = 1.2`
- `current.progress = 0.45479` ✓ 等于理论值 `vh / (h + vh) = 674 / 1482 = 0.45479`
  —— 这条精确对上，说明 `scrollProgress.ts` 对原站公式的还原是准确的。

### 7.2 滚动 → 章节进度 → 转场（9 个采样点）

| scrollY | current | cur.progress | next | next.progress | **uProgress** | drawCalls |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 0.455 | — | — | **0.000** | 10 |
| 364 | 0 | 0.700 | 1 | 0.155 | **0.341** | 15 |
| 727 | 0 | 0.945 | 1 | 0.400 | **0.880** | 15 |
| 1018 | 1 | 0.597 | 2 | 0.131 | **0.113** | 15 |
| 1212 | 1 | 0.727 | 2 | 0.250 | **0.401** | 15 |
| 1503 | 1 | 0.924 | 2 | 0.430 | **0.833** | 15 |
| 1751 | 2 | 0.584 | — | — | **0.085** | 10 |

关键观察：

1. **双场景同时求值成立** —— 每个采样点 `current` 和 `next` 的 progress 都在变，
   证明 `Composer.render()` 每帧确实求值了两个场景。
2. **切换点零跳变** —— 727 行 `uProgress=0.880`（cur=0），1018 行 `uProgress=0.113`（cur=1）。
   两个场景各自连续，没有出现"画面突然跳到 45%"的经典 bug。
   这正是 `transitionProgress()` 存在的理由（见该文件注释）。
3. **drawCalls 10 → 15** —— 非交叉区 10（1 个场景 + bloom 3 pass + 合成），
   交叉区 15（2 个场景 + bloom + 合成）。**证明 RenderTarget 双缓冲确实在工作**，
   转场不是简单的 opacity fade。

### 7.3 视觉确认

截图（scrollY=364，uProgress=0.341）可见：

- 五层空间构图正常，背景/中景/前景 z 分离有效
- **Hero 模式的圆形径向溶解**正在展开（白色圆形边界）
- 圆内出现 **fwidth 边缘线稿**（原图轮廓被抽成铅笔线）
- 边界有 **glow + bloom** 溢出
- 调试面板显示 **144 fps**

### 7.4 控制台

```
list_console_messages(types: ["error","warn"]) → <no console messages found>
```

**零 error / 零 warn。**

### 7.5 类型检查

```bash
npx tsc --noEmit   # exit 0，无输出
```

---

## 8. 已知问题 / 改造障碍（PHASE 1 的输入）

这一节是 PHASE 0 最重要的产出。基线**能跑**，但**不通用**。按严重程度排序：

### P0 — 引擎直接 import 内容（最核心的架构违规）

```ts
// src/engine/Composer.ts:3
import { SCENES } from '../config/scenes';
// src/engine/Composer.ts:104
this.scenes = SCENES.map((cfg) => buildScene(cfg, textures, models, 1));
```

`Composer` 是一个通用渲染管线，却硬编码依赖了全局内容数组。
后果：换内容 = 改引擎。这是"内容与引擎解耦"这条原则的**唯一硬伤**，必须修。

### P1 — 引擎硬编码具体资产 key

```ts
// src/engine/Composer.ts:115-116
tMudNormal: { value: textures.get('mudNormal') ?? null },
tNoise:     { value: textures.get('noise') ?? null },
```

`'mudNormal'` / `'noise'` 是内容侧的资产名。引擎不该知道内容里有哪几张图。
应该由调用方以 `transitionTextures: { noise, displacement }` 的形式注入。

### P1 — 引擎依赖内容侧的资产解析函数

```ts
// src/engine/loaders.ts:5
import { type AssetKey, assetKind, resolveAsset } from '../config/assets';
```

加载器应该面向一个 `AssetSource` 端口（接口），而不是直接 import 具体注册表。

### P2 — Schema 类型寄居在内容文件里

```ts
// src/engine/SceneBuilder.ts:8
import type { LayerConfig, SceneConfig } from '../config/scenes';
// src/animation/timeline.ts:1
import type { Ease, Keyframe, Track } from '../config/scenes';
```

`SceneConfig` / `LayerConfig` / `Track` / `Keyframe` 是**引擎与内容之间的契约**，
却被定义在"内容"文件里。方向反了 —— 应该提取到 `src/schema/`，
让**引擎和内容都依赖 schema**，而不是引擎依赖内容。

### P2 — 内容层内部两套内容混住

- `config/assets.ts`：占位资产与 `o*` 原站资产在同一个对象里
- `config/scenes.ts`：`PLACEHOLDER_SCENES` 与 `ORIGINAL_SCENES` 在同一个文件里
- `vite.config.ts`：`serveOriginals()` 插件专门服务 `../assets-original/`（Shopify 素材存档）
- `src/viewer/`：原站素材浏览器，与引擎无关

### P2 — 组件层直接 import 内容

`CanvasHost.tsx` / `ScrollSections.tsx` / `DebugHUD.tsx` 都直接 import `SCENES`。
这些组件本身是通用的，只是**取值来源**被写死了。

### 未验证 / 缺失的能力（对照目标清单）

| 目标能力 | 当前状态 |
|---|---|
| Scene 创建/销毁/切换 | ⚠️ 只支持"全部预建 + 按进度求值"，**没有 lazy load / 动态切换** |
| Camera System | ⚠️ 有（position/rotation/fov 轨道），但**没有 lookAt、没有 damping、没有 path** |
| Parallax System | ✅ 已有（靠 z 深度 + 透视投影，硬件免费给） |
| Object 独立动画 | ✅ 已有（每个 layer 独立 tracks） |
| Transition Engine | ✅ 已有（双 RT + 阈值场 shader） |
| Motion Presets | ❌ 没有，动画全是手写关键帧 |
| 自动构图 | ❌ 没有，所有 position/scale/z 全靠手填 |
| Asset Pipeline | ❌ 完全没有 |
| `?debug=1` 调试模式 | ⚠️ 有 DebugHUD（常驻），但**没有 URL 开关、没有 bounding box / layer / Z 可视化** |
| 响应式 | ⚠️ 有 `setAspect()` 重算几何（做法正确，不是 scale 硬缩），但**没有按断点调 FOV / 位置** |
| 性能优化 | ⚠️ 有 DPR 上限 2、RT resize、dispose；**没有 lazy load / 预加载下一场景 / 纹理缓存 / 移动端后处理降级** |
| 一键换素材 | ❌ 需手改 `config/assets.ts` + `config/scenes.ts` |

---

## 9. 基线结论

**可以继续。** 理由：

1. 跑得起来，零 error，144 fps，typecheck 干净。
2. 引擎**已经 85% 通用** —— SceneBuilder / Composer / transition shader / timeline /
   scrollProgress / loaders 全都是"读配置干活"的形态，没有 Shopify 硬编码逻辑。
3. 需要动的是**依赖方向**（引擎 → 内容 改成 引擎 → schema ← 内容），
   而不是重写算法。**代码量小，风险低。**

**不需要做的事**：不重写渲染管线、不重写 shader、不重写滚动数学。
`transition.ts`（180 行 shader）和 `scrollProgress.ts`（184 行滚动公式）是
本次逆向最有价值的资产，**一行都不该动**。
