# webgl-scroll-engine

[![CI](https://github.com/A3-77/webgl-scroll-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/A3-77/webgl-scroll-engine/actions/workflows/ci.yml)

**素材驱动的滚动叙事 WebGL 引擎。** 往 `input/` 丢几张图，跑两条命令，得到一个滚动驱动的 2.5D 叙事网站。

不需要写 Three.js、Shader、Timeline 或 React 代码 —— 场景从素材里自动生成。

| 首屏（五只猫，各自独立运动） | 滚动到下一章（Shader 阈值场过渡） |
|---|---|
| ![首屏](docs/shots/01-scene01-five-cats.jpg) | ![过渡](docs/shots/02-transition-radial.jpg) |

*（真实渲染画面，canvas 像素导出。生成方式见 [`docs/PHASE-3-自动构图.md`](docs/PHASE-3-自动构图.md)）*

| 开媒介层：同一张画面被**重绘成印刷品** | 过渡中：墨线由深度缓冲驱动 |
|---|---|
| ![媒介层](docs/img/phase25-scene01.jpg) | ![媒介层过渡](docs/img/phase25-transition.jpg) |

*（同一场景，只改 `site.medium` 一个配置块 —— 网点 / 墨线 / 纸纹 / 抖动 / 持续颗粒。
详见 [`docs/PHASE-25-媒介层.md`](docs/PHASE-25-媒介层.md)）*

### 镜头会「看」，不是平移一张图

自动构图给每一章分配一个**命名过的运镜**（`hold` / `dolly` / `orbit` / `whip` / `crash` / `rise`），
并且相机真的有 `target` —— 位置与目标**各自独立阻尼**，`roll` 绕视线轴叠加。

| 运镜 | 位置行程 (x/y/z) | 视线摆动 | 做什么 |
|---|---|---|---|
| `dolly` | 0 / 0 / 6.0 | 0.2° | 直推近，主体不动、背景向外散开 |
| `orbit` | 11.9 / 0 / 0.3 | **18.0°** | 绕主体转 18° 弧，构图稳定、背景流动 |
| `whip` | 3.7 / 0 / 0 | 6.6° | 甩镜头，**目标跟着扫** ⇒ 转场感 |
| `crash` | 0 / 0 / 6.0 | 0.2° | `easeOutCubic` 冲进去 + fov 收窄 28°→32° |
| `rise` | 0 / 2.7 / 1.8 | 7.7° | 抬升 + 视线下压（俯角） |
| `hold` | 0.2 / 0.2 / 2.1 | 0.7° | 定住呼吸，**出去再回来** |

*（浏览器实测，真实引擎路径。`npm run dev` → `?accept=1` 里的 ⑰ 项会现场打出这张表）*

**为什么这一项是分水岭**：改造前相机只有 `position` + `rotation.z`，永远朝 −Z 看 ——
能做的只有"把画面平移一段距离"，加多少缓动/阻尼/视差都救不回来。
真实摄影机的运动是**围绕被摄体运动**。
详见 [`docs/PHASE-26-镜头语言.md`](docs/PHASE-26-镜头语言.md)。

---

## 30 秒上手

```bash
npm install

# 1. 素材 → 场景（分割主体、生成透明 PNG、自动构图）
npm run build-assets

# 2. 起开发服务器
npm run dev
```

打开终端里打印的地址即可。默认加载 `cats` 内容包（`input/` 里的两张猫图）。

**换图片**：把 `input/*.jpg` 换成你的图 → 重跑 `npm run build-assets` → 刷新页面。完。

**加一章**：往 `input/` 多丢一张图（命名 `scene04.jpg`）→ 重跑 `build-assets`。不需要改任何代码。

---

## 用你自己的素材

上面跑起来的是自带的示例包（`cats`）。要做你自己的：

```bash
npm run new-pack dogs          # 创建内容包，生成后立刻可用
```

生成的 `src/content/dogs/` 里只有两个文件：

```
index.ts    ← 包声明 + 一行 build
site.ts     ← 标题 / 字体 / 排版 token
```

改 `site.ts` 的 `title`，然后：

```bash
# 把图放进 input/（文件名决定章节顺序）
npm run build-assets
npm run dev
```

访问 `?content=dogs`。想让它成为默认，改 `src/config/content.config.ts` 里的
`DEFAULT_CONTENT_PACK = 'dogs'`。

**你不需要写场景配置** —— 主体位置、大小、深度、相机运镜、转场方式全部从素材算出来。
需要精细控制时才看 [`docs/内容包契约.md`](docs/内容包契约.md)。

### 三个内容包

| 包 | 形态 | 用途 |
|---|---|---|
| `cats` | 素材驱动（读 manifest 自动构图） | **默认**。演示主要用法 |
| `placeholder` | 手写场景，程序化抽象图 | 引擎自检 —— 不依赖任何外部素材，永远能跑 |
| `shopify` | 手写场景 + KTX2 + GLB 蒙皮模型 | 参考实现。证明引擎扛得住真实素材（4.9 万三角形）。**素材在仓库外**，单独使用本引擎时可以整个删掉 |

这三个包并存本身就是"内容与引擎解耦"的证据：引擎对它们一视同仁，因为它只认 schema。

---

## 目录

```
input/                     ← 你的原始图片。按文件名排序 = 章节顺序
scripts/build-assets/      ← 素材流水线（Python）
  pipeline/
    providers/             ← 分割算法，可插拔
    selftest.py            ← 20 项算子自检（npm run build-assets:selftest）
src/
  asset-pipeline/          ← manifest → SceneConfig 的自动构图
  schema/                  ← 引擎与内容之间的契约层
  engine/                  ← 渲染管线（不认识任何具体内容）
  animation/               ← 关键帧求值 + 运动预设
  content/                 ← 内容包。每个目录一个包
  components/ app/ config/ ← DOM 层与装配
public/content/            ← build-assets 的产物（会被浏览器直接取）
generated/                 ← manifest、预览图、掩码核对报告
docs/                      ← 技术文档
```

---

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run new-pack <id>` | 创建一个新的内容包（生成后立刻可用） |
| `npm run build-assets` | 跑素材流水线 |
| `npm run build-assets:check` | 只校验产物完整性，不重新生成 |
| `npm run build-assets:selftest` | 算子自检（20 项，改过 `imaging.py` 之后跑一遍） |
| `npm run build-assets:providers` | 列出可用的分割算法 |
| `npm run verify:independence` | 验证「删除内容包后引擎仍可运行」（自动移出→构建→检查→恢复） |
| `npm test` | 单元测试（**265** 个用例 / 13 个文件，~1.3s） |
| `npm run typecheck` | 类型检查。**改完 shader 必跑** |

切换内容包：URL 加 `?content=<包名>`。可用 `cats`（素材驱动）和 `placeholder`（引擎自检，不依赖素材）。

---

## 验收

把整条链路跑一遍断言，而不是靠肉眼：

```
http://localhost:5173/?accept=1        ← 打开就跑，结果打到 console
```

或在控制台里随时：

```js
await __ACCEPTANCE__.run()
```

覆盖路线图的 ②③④⑤⑥⑦⑧ 六条标准，外加 ⑩~⑰ **引擎能力覆盖**
（遍历当前内容包**实际声明的**能力逐项跑一遍，没声明的报 `SKIP` 并说明"这项没被覆盖"）。
①⑨ 需要构建期动作，会标成 `SKIP` 并说明该怎么做。

其中 **⑰ 运行时替换运镜** 值得单独提一句 —— 它走的是和 `Composer.refreshLayout`
（改窗口大小触发重新构图）完全同一条真实路径，并且会现场打出上面那张六个运镜的位姿表。

**要全覆盖就跑两个包**：`?content=placeholder`（覆盖全部引擎能力）和 `?content=cats`（覆盖素材驱动）各跑一次 ——
两个包的 SKIP 是互补的。

当前状态（cats 包 / Chrome）：**9 PASS / 0 FAIL / 8 SKIP，143.9 fps**。

构建期的两项：

```bash
npm run verify:independence      # ① 删除内容包后引擎仍可运行
npm run build-assets:check       # ⑨ 产物与 manifest 一致
```

详见 [`docs/PHASE-11-里程碑验收.md`](docs/PHASE-11-里程碑验收.md) 与
[`docs/PHASE-20-能力验收.md`](docs/PHASE-20-能力验收.md)。

---

## 出问题了先看这里

**素材跑出来不对** → 打开 `generated/report.html`。
里面有每个场景的「掩码叠原图」，能一眼看出主体是漏了还是多抓了。终端也会列出置信度不是 `high` 的场景。

**背景不是纯色** → 换分割算法：
```bash
npm run build-assets -- --provider rembg
```
（需要 `pip install rembg`，首次运行会下 176MB 模型）

或者手工提供掩码：把黑白 PNG 放到 `input/masks/<图片名>.png`，用 `--provider manual`。

**页面空白** → 看浏览器控制台。多半是 `public/content/manifest.json` 不存在，跑一次 `npm run build-assets`。

**改完 shader 记得跑 `npm run typecheck`** —— GLSL 内联在 TS 模板字符串里，注释里写一个反引号就会截断字符串，报错信息（`Expected ";" but found "fwidth"`）完全指不到点子上。这个坑踩过两次。

---

## 可调参数

自动构图的全部旋钮在 `src/asset-pipeline/compose.ts` 的 `DEFAULTS`：

| 参数 | 默认 | 作用 |
|---|---|---|
| `heightVh` | 2.0 | 每章滚多远（vh 倍数） |
| `cameraZ` | 6 | 相机初始 z。必须大于所有物体的 z |
| `dolly` | −6 | 相机推进量。**负值 = 前进**（three 相机看向 −z） |
| `camY` | 1.2 | 相机上下行程半幅，决定横向视差强度 |
| `dist` | [20, 34] | 主体到相机的距离区间。**纵深感的总旋钮** |
| `bgDist` | 40 | 背景到相机的距离 |
| `maxSubjectH` | 0.92 | 主体初始占屏高度上限（超宽视口下防止主体出界） |
| `maxScreenH` | 1.05 | 相机推进结束时主体允许占的高度 |
| `lookBlend` | 0.45 | **镜头"看多准"**：`look = 轴线 + lookBlend × (主体 − 轴线)`。0 = 不看主体，1 = 死盯主体（背景板会被推出去，实测 overscan 需求 1.52 超预算） |
| `bgOverscanMax` | 1.45 | 背景放大的**预算上限**。运镜需求超了就自动压 `intensity`（见 [`docs/PHASE-26-镜头语言.md`](docs/PHASE-26-镜头语言.md) §8） |

内容包可以在自己的 `build()` 里覆盖任意一项：

```ts
build: async ({ aspect }) => {
  const manifest = await loadManifest();
  return composeContent(manifest, { aspect, dolly: -9, dist: [16, 40] });
};
```

### 镜头语言：`camera.move` + `site.pointer`

**这是"运动"的一半**，和媒介层（材质）完全独立。详见 [`docs/PHASE-26-镜头语言.md`](docs/PHASE-26-镜头语言.md)。

自动构图会按 `MOVE_CYCLE = ['dolly', 'orbit', 'rise', 'hold', 'crash', 'whip']`
给每章分配一个运镜（顺序刻意排过 —— 只有 2 章也能拿到表现力最强的两个）。
内容包想自己指定就写 `camera.move`：

| 字段 | 作用 |
|---|---|
| `kind` | `hold` / `dolly` / `orbit` / `whip` / `crash` / `rise` |
| `subject` | **绕谁转**（orbit 的弧心，也是 fov 收窄的参考深度） |
| `look` | **看向哪**。★ 和 `subject` 分开 —— 前者是取景，后者是运动中心 |
| `intensity` | `0` = 退化成静止（但**依然 `lookAt`**，构图不塌） |
| `approach` | 最大推近量（世界单位）。**由构图给，运镜不自由发挥** |
| `dir` | `1 / -1`，相邻章交替镜像 |

不想用 `move` 也可以手写 `target.x/y/z` 轨道（`cameraHasTarget()` 靠轨道判定）。

**指针视差**（第三个连续驱动源，见 `site.pointer`）默认关：

```ts
import { POINTER_PARALLAX } from '../schema';

site: { pointer: POINTER_PARALLAX }   // 0.035 幅度 / axis [0.35, 0.25] / damping 0.12
```

幅度按**相机到目标的距离**缩放 ⇒ 观感是恒定的 ±2° 角度偏移，推近拉远手感一致。
★ 有**两道门控**（照搬参考站点）：只在 `hold` / `dolly` 这类**已定型**的镜头里生效，
且过场中一律关掉 —— 镜头自己在飞的时候再叠指针位移会让画面"发毛"。

### 媒介层：`site.medium`

`site.post` 是**滤镜**（在照片上加东西），`site.medium` 是**重绘**（换一种材料）。
两者独立，可以只用其一。完整说明见 [`docs/PHASE-25-媒介层.md`](docs/PHASE-25-媒介层.md)。

| 参数 | 默认 | 作用 |
|---|---|---|
| `enabled` | `false` | 总开关。**关掉 = 一个 pass 都不跑**，画面与不开时逐位相同 |
| `mono` | `0.55` | 去色程度。不建议给到 1 —— 会丢掉素材本身的色彩 |
| `blackPoint` | `0.12` | **分级**：低于它算全黑（网点铺满） |
| `whitePoint` | `0.92` | **分级**：高于它算全白（完全不着墨） |
| `contrast` | `0.30` | **分级**：绕 0.5 的 S 曲线，增益 = 1 + 对比 × 2 |
| `halftone` | `0.6` | 网点强度。把连续调拆成"墨点的大小" |
| `halftoneScale` | `5` | 网屏尺寸，单位 **CSS 像素**（内部按 dpr 换算） |
| `halftoneAngle` | `45` | 网屏角度。印刷上 45° 最不容易出摩尔纹 |
| `inkEdge` | `0.5` | 墨线强度。轮廓由**深度不连续 + 亮度梯度**共同决定 |
| `inkThreshold` | `0.06` | 墨线灵敏度。调大 = 只留最硬的边 |
| `paper` | `0.35` | 纸纹叠加强度 |
| `paperColor` | `#efe7d6` | 纸色（sRGB） |
| `inkColor` | `#1a1714` | 墨色（sRGB）—— 同时决定**网点**的墨色和**墨线**的颜色 |
| `dither` | `0` | 有序抖动强度（Bayer 4×4）。默认关 |
| `ditherLevels` | `6` | 抖动量化级数，最小 2 |
| `grain` | `0.05` | 持续颗粒强度。**不跟滚动走，按墙钟时间跑** |
| `grainSpeed` | `1` | 颗粒速度 |
| `pulse` | `0.35` | 滚动脉冲倍率 —— 和 `site.post` 共用同一个活跃度 |

> **分级（`blackPoint` / `whitePoint` / `contrast`）是照片驱动的关键一级。**
> 普通照片的亮度只占一小段（实测 cats 素材是 0.30 ~ 0.91），不拉开的话
> 网点全是小点、整幅画印出来是一片浅灰 —— 像褪色旧照片，不像印刷品。
> 参考站点不需要这一级，是因为它们的场景本来就跨越全色阶。
> **怎么量这三个值**见 [`docs/PHASE-25-媒介层.md`](docs/PHASE-25-媒介层.md) §7.6。

> `pulse` 只作用于 `halftone / dither / inkEdge / paper / grain` 这五个**强度**旋钮。
> `mono / 分级 / paperColor / inkColor / inkThreshold` 不脉冲 —— 材料本身不该跟着滚动闪。

> **想要参考站点那种"海报感"，拧的是 `dither`，不是 `contrast`。**
> 分级再怎么调都只能把高调素材拉到标准差约 0.21（实测扫了 20 组参数），
> 而有序抖动**量化到 N 级必然产生双峰**：
> `dither 1.0` + `ditherLevels 3` + `contrast 0.5` → 近纸白 30.8% / 标准差 0.241，
> 与参考站点 newsprint 版画（29.1% / 0.300）同区间。
> 代价是画面被量化成 N 级色阶 —— 像海报，不像照片。实测数据见 §7.8。

---

## 已知限制

- **主体自带接触阴影。** 分割会把主体脚下的阴影一起抠进 PNG。浅色背景下看不出来（拼回校验与原图一致），换成深色背景就会显形。抬阈值实测去不掉（阴影与主体在颜色空间上连成一片）。用合成素材复现过：一个 600×560 的方块被检测成 667×632 —— 多出来的正是柔和投影。
- **背景有高频内容时色键控失效。** 换 `--provider rembg` 或手工掩码。
- **主体与背景在亮度和色度上都接近时无解。** 报告里会是 `low` 置信度。
- **腰部检测只处理横向排布**的主体（并排的猫）。纵向堆叠或斜向排布拆不开。
- **竖屏下横排主体会出界。** 源图是横排的 5 只猫（1.5），竖屏（0.67）时横向放大 2.26 倍，只能看到中间 3 只。这是 `cover` 语义的几何必然（背景必须铺满，主体才能"长在原处"）—— 换一张更接近方形的源图最省事。详见 [`docs/PHASE-17-响应式.md`](docs/PHASE-17-响应式.md)。
- **背景补洞会留下块状痕迹。** 抠掉主体后背景要补洞，补洞算法工作在 64px 的块上，于是背景里能看到 64px 尺度的方块。这是**素材流水线的既有缺陷**（PHASE 25 排查时确认与媒介层无关：把媒介层全部旋钮归零，方块依然在）。有趣的是媒介层的网点/纸纹会把它盖住。详见 [`docs/PHASE-25-媒介层.md`](docs/PHASE-25-媒介层.md) §7.2。
- **`position.x` 的位移单位与文档不一致。** 文档与构图都写着"世界位移 = 值 × 视口高 × aspect"，实际生效的是"1.0 = 一个视口高"，横向幅度只有设计值的 `1/aspect`（2.1 视口下约 47%）。这是拆分前 `SceneBuilder.applyTime` 的遗留问题，**PHASE 4~9 拆分时有意未改**（修它会改变所有现有内容的观感）。一行修复位置：`src/engine/SceneBuilder.ts` 的 `setAspect()` 里补 `objectSystem.setAspect(next)`；修完横向幅度变成 aspect 倍，需要重新过眼睛。
- **相机阻尼没有"段边界"。** 参考站点的阻尼是**分段**的（段内 lerp、**段间硬切**）；本引擎的 `damping` 是全局一阶低通。如果内容作者在某条轨道里写了一个硬跳（等价于一个 cut），阻尼会把它糊成一段滑动。**跨场景不受影响**（每个场景有独立的 `CameraSystem` 实例，首帧天然硬切）。要修的话给 keyframe 加 `snap?: boolean`，位置在 `src/engine/systems/CameraSystem.ts` 的 `apply()`。详见 [`docs/PHASE-26-镜头语言.md`](docs/PHASE-26-镜头语言.md) §12.1。
- **`lookBlend` 是全局常量**，不能按章节调。某章如果特别依赖主体居中，现在只能手写 `camera.target` 覆写。
- **媒介层的"印品感"上限由素材决定，不由引擎决定。** 分级只能把素材的色调范围拉开，拉不出素材里没有的东西。实测 cats 素材（高调浅色油画）的亮度标准差只有 0.132，扫了 20 组分级参数，输出标准差上限约 0.215；而参考站点的版画是 0.263~0.344 —— 因为它们的场景里有**大块平涂的实黑色块**。所以：**高调照片印出来就是高调**。想要那种海报感要换素材，或拧 `dither`（见上文）。详见 [`docs/PHASE-25-媒介层.md`](docs/PHASE-25-媒介层.md) §7.8。

---

## 文档

- [`docs/内容包契约.md`](docs/内容包契约.md) —— **怎么写自己的内容包**（两种形态、场景契约、容易踩的点）
- [`docs/PHASE-26-镜头语言.md`](docs/PHASE-26-镜头语言.md) —— **镜头语言**（六个命名运镜、相机 `target`、三条实现纪律、`look` vs `subject` 的推导、指针门控）：让镜头**会看**，而不是平移一张图
- [`docs/PHASE-25-媒介层.md`](docs/PHASE-25-媒介层.md) —— **媒介层**（网点/墨线/纸纹/抖动/持续颗粒）：把画面**重绘成另一种材料**，而不是加滤镜；含两个参考站的差距分析与实测数据
- [`docs/PHASE-24-火山引擎分割.md`](docs/PHASE-24-火山引擎分割.md) —— 用 EntitySegment 做实例分割（挨着的主体也能拆开），含鉴权排查全过程
- [`docs/PHASE-23-3D过渡载体.md`](docs/PHASE-23-3D过渡载体.md) —— 载体飞过 + 溶解跟随 + 有机边缘；**以及顺带挖出的 PHASE 18 后处理语义缺陷**
- [`docs/PHASE-22-音频.md`](docs/PHASE-22-音频.md) —— Tone.js 环境音与转场音效，与后处理共用活跃度
- [`docs/PHASE-18-postprocessing.md`](docs/PHASE-18-postprocessing.md) —— pmndrs 后处理链、滚动脉冲；**尾部有语义缺陷的事后补记**
- [`docs/PHASE-21-单元测试.md`](docs/PHASE-21-单元测试.md) —— 构图数学的单测，以及它抓到的一个真 bug
- [`docs/PHASE-20-能力验收.md`](docs/PHASE-20-能力验收.md) —— 引擎声明的能力逐项验证（25 项里哪些真跑过）
- [`docs/PHASE-19-模板化.md`](docs/PHASE-19-模板化.md) —— 通用性验证（换一套完全不同的素材真跑一遍）与脚手架
- [`docs/PHASE-11-里程碑验收.md`](docs/PHASE-11-里程碑验收.md) —— 验收脚本覆盖什么、边界在哪、怎么验证它真的会 FAIL
- [`docs/PHASE-17-响应式.md`](docs/PHASE-17-响应式.md) —— 视口变化后重新构图的实现与实测数据
- [`docs/PHASE-4-9-模块化拆分.md`](docs/PHASE-4-9-模块化拆分.md) —— 引擎 6 个系统的职责边界、设计抉择、烟测、发现的预存缺陷
- [`docs/PHASE-3-自动构图.md`](docs/PHASE-3-自动构图.md) —— manifest → 场景的映射数学、运动预设、验证结果
- [`docs/PHASE-2-素材流水线.md`](docs/PHASE-2-素材流水线.md) —— 分割算法、参数来历、实测数据、踩过的坑
- [`docs/BASELINE.md`](docs/BASELINE.md) —— 被复刻的原始站点的技术基线
