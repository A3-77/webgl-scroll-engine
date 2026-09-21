# webgl-scroll-engine

[![CI](https://github.com/A3-77/webgl-scroll-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/A3-77/webgl-scroll-engine/actions/workflows/ci.yml)

**素材驱动的滚动叙事 WebGL 引擎。** 往 `input/` 丢几张图，跑两条命令，得到一个滚动驱动的 2.5D 叙事网站。

不需要写 Three.js、Shader、Timeline 或 React 代码 —— 场景从素材里自动生成。

| 首屏（五只猫，各自独立运动） | 滚动到下一章（Shader 阈值场过渡） |
|---|---|
| ![首屏](docs/shots/01-scene01-five-cats.jpg) | ![过渡](docs/shots/02-transition-radial.jpg) |

*（真实渲染画面，canvas 像素导出。生成方式见 [`docs/PHASE-3-自动构图.md`](docs/PHASE-3-自动构图.md)）*

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
    selftest.py            ← 18 项算子自检（npm run build-assets:selftest）
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
| `npm test` | 单元测试（97 个用例 / 3 个纯函数模块，~0.6s） |
| `npm run typecheck` | 类型检查。**改完 shader 必跑** |

切换内容包：URL 加 `?content=<包名>`。可用 `cats`（素材驱动）和 `placeholder`（引擎自检，不依赖素材）。

---

## 验收

把整条链路跑一遍断言，而不是靠肉眼：

```
http://localhost:5199/?accept=1        ← 打开就跑，结果打到 console
```

或在控制台里随时：

```js
await __ACCEPTANCE__.run()
```

覆盖路线图的 ②③④⑤⑥⑦⑧ 六条标准（①⑨ 需要构建期动作，会标成 `SKIP` 并说明该怎么做）。
**要全覆盖就跑两个包**：`?content=placeholder`（覆盖全部引擎能力）和 `?content=cats`（覆盖素材驱动）各跑一次 ——
两个包的 SKIP 是互补的。

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

内容包可以在自己的 `build()` 里覆盖任意一项：

```ts
build: async ({ aspect }) => {
  const manifest = await loadManifest();
  return composeContent(manifest, { aspect, dolly: -9, dist: [16, 40] });
};
```

---

## 已知限制

- **主体自带接触阴影。** 分割会把主体脚下的阴影一起抠进 PNG。浅色背景下看不出来（拼回校验与原图一致），换成深色背景就会显形。抬阈值实测去不掉（阴影与主体在颜色空间上连成一片）。用合成素材复现过：一个 600×560 的方块被检测成 667×632 —— 多出来的正是柔和投影。
- **背景有高频内容时色键控失效。** 换 `--provider rembg` 或手工掩码。
- **主体与背景在亮度和色度上都接近时无解。** 报告里会是 `low` 置信度。
- **腰部检测只处理横向排布**的主体（并排的猫）。纵向堆叠或斜向排布拆不开。
- **竖屏下横排主体会出界。** 源图是横排的 5 只猫（1.5），竖屏（0.67）时横向放大 2.26 倍，只能看到中间 3 只。这是 `cover` 语义的几何必然（背景必须铺满，主体才能"长在原处"）—— 换一张更接近方形的源图最省事。详见 [`docs/PHASE-17-响应式.md`](docs/PHASE-17-响应式.md)。

---

## 文档

- [`docs/内容包契约.md`](docs/内容包契约.md) —— **怎么写自己的内容包**（两种形态、场景契约、容易踩的点）
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
