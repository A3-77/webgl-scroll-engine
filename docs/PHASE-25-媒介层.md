# PHASE 25 —— 媒介层（把画面印出来，而不是给它加滤镜）

> **一句话**：`site.post` 决定「在照片上加什么」，`site.medium` 决定「这张画面是什么材料做的」。
> 开了媒介层，画面不再是一张照片 —— 它是一张印刷品。

---

## 1. 为什么需要它：一个被误诊了几轮的问题

用户的原始批评是：

> "shader.se / iamsaeed.dev 怎么做，你的只是单纯图片转场了"

前几轮的应对是「加效果」：PHASE 18 加了 pmndrs 后处理链，PHASE 23 加了 3D 过渡载体。
但把两个参考仓库的源码逐行读完之后，结论变了 —— **差距不在效果的多少，在效果的种类**。

本引擎当时有 8 个后处理效果：

```
bloom / chromaticAberration / noise / vignette / scanline / glitch / hueSaturation / brightnessContrast
```

**这 8 个全是颜色空间滤镜。** 它们只读颜色缓冲，做的是"在已有像素上加一点东西"。
八个叠满，画面依然是一张照片。

---

## 2. 证据：两个参考站点共有、而本引擎没有的三件事

### 2.1 画面被**重新表达成另一种媒介**

**shader.se**（`skyworks/src/components/asci-background.tsx`）：

```js
const cellIndex      = floor(uv * asciResolution);          // 切成 20px 格子
const cellVideoColor = texture(skyVideoTexture, cellUv);    // 每格取中心像素
const cellIntensity  = dot(cellVideoColor.rgb, lumaWeights); // 算亮度
const remapped       = remap(cellIntensity, 0.25, 0.8, 0, 1);
const videoIntensity = floor(remapped * 100);               // 量化成 0..99
const asciColor      = texture(asciTexture, glyphUv);       // 用亮度索引字形图集
```

视频被按亮度量化，再用这个数去索引一张 10×10 的字形图集 —— **重绘成字符画**。

**iamsaeed.dev**（`portfolio/shaders/PrintEffect.ts` 文件头原文）：

> color-window mask → mono grade → registered single-screen halftone → crosshatch
> shadow steps → ink edge (Sobel on normals+depth) → paper+grain multiply → vignette

画面被拆成网点、排线、墨线、纸纹 —— **重绘成印刷品**。

**共同点**：两者都不是"在照片上叠颜色"，而是换了一种材料。

### 2.2 重绘读**几何缓冲**

- **portfolio**：墨线是对 `tNormal` 和 `readDepth` 做 Sobel；彩色窗口用
  `uInvViewProjection` 从深度重建世界坐标
- **skyworks**：背景是一块 120×120 细分的平面，在 `positionNode` 里做顶点位移
  （鼠标轨迹会推动它）

本引擎当时的实测结果：`grep -rn "DepthTexture|normalPass|readDepth" src/` → **零命中**。
没有任何深度或法线缓冲，所以即使想做墨线也拿不到结构信息。

### 2.3 停下滚动，画面依然是活的

- **skyworks**：`sky.mp4` 一直在播（`useVideoTexture` autoplay），20 架飞机持续绕柱飞行
- **portfolio**：`time` uniform 驱动颗粒与节拍

本引擎当时：`uTime` 只出现在 `transition.ts` 里，**后处理链零时间驱动** ——
停下滚动，画面完全冻住。

> **共同点归纳成一句**：滚动和时间是两个独立的驱动源，缺一个画面在静止时就会死。

---

## 3. 架构：为什么媒介层必须插在**过渡之前**

这是本 PHASE 最关键的一个决定。

### 3.1 渲染链的现状

```
场景 → 纹理 → 过渡混合 → 载体 → 后处理 → 屏幕
```

### 3.2 两个可选位置

**位置 A：过渡之后**（iamsaeed.dev 的选择）

他们必须额外搞一条 `pjtCovered` 覆盖通道。文件头注释原文：

> `pjtCovered` — written by TransitionEffect. EffectPass sorts merged effects by
> attributes, CONVOLUTION before DEPTH, so the transition composites FIRST and this
> pass prints the result — **without the gate the incoming issue's ink line drew as a
> wireframe over every snapshot**

也就是说：一旦两张画面混成一张，**"这个像素属于哪个物体、离相机多远"就永久丢失了**，
墨线会画错地方，只能靠一条覆盖通道把它标出来再让它闭嘴。

**位置 B：过渡之前**（本引擎的选择）

```
场景 → 纹理 → 媒介重绘 → 过渡混合 → 载体 → 后处理 → 屏幕
              ^^^^^^^^ 这里
```

每个场景重绘自己那一张，**深度天然是对的**，不需要覆盖通道。
代价是过渡溶解的是"两张已经印好的画面"—— 而这恰好是对的观感：
翻页翻的是两张印刷品，不是一块玻璃。

**所以这个决定同时简化了实现和改进了观感。**

---

## 4. 六个阶段

顺序固定，不可调换（先描边再网点，墨线会被网点吃掉；先纸纹再描边，纸纹会被当成轮廓）：

| # | 阶段 | 做什么 | 关键点 |
|---|---|---|---|
| ① | 单色化 | `mix(src, vec3(luma), mono)` | 不建议给到 1，会丢掉素材色相 |
| ② | 网点 | 屏幕空间旋转网格 + 点径 ∝ √墨量 | **网格锚在屏幕而非 UV** |
| ③ | 有序抖动 | Bayer 4×4 解析式 | 与网点是两种语言，默认关 |
| ④ | 墨线 | 深度不连续 + 亮度梯度 | **读原始颜色，不读网点化后的** |
| ⑤ | 纸纹 | 双尺度 hash 叠加 | 单尺度像电视雪花 |
| ⑥ | 持续颗粒 | 墙上时钟驱动 | **不依赖滚动** |

### 4.1 网点为什么锚在屏幕空间

用 UV 网格的话，网点会随画面缩放一起伸缩 —— 看起来像"网点印在图上"。
真实印刷的网点是相对纸面固定的，所以**纸（屏幕）动、网点不动**。

### 4.2 墨线为什么读原始颜色

网点本身是高频的墨点阵列。拿它算亮度梯度，**整张画面会被网点网格自己勾满边**，
看起来像加了一层噪点描边。

所以 shader 里先 `vec3 src` 存住原始值，墨线只吃 `src`：

```glsl
vec3 src = texture2D(tDiffuse, uv).rgb;
...
// ④ 墨线 —— 用的是 src，不是 c
float line = inkLine(uv, srcLuma);
```

---

## 5. 三条容易写错的纪律（都踩过）

### ① 深度差要用**相对差**，不能用绝对差

透视投影下远处的深度值天然大得多。绝对差会让近处的东西没边、远处的东西全是边。

```glsl
float inv = 1.0 / max(d0, 1e-3);
float gx = abs(dR - dL) * inv;   // 除以自身深度，远近才可比
```

### ② 亮度梯度要**阈值化**

强边缘处相邻像素可以从黑跳到白（梯度 ≈ 1.0），而毛发的微观起伏只有 0.1~0.2。
不设阈值的话，毛发、布料、云这类高频纹理会被整片描成线 ——
**实测踩过：阈值给太低，猫的毛被描成一团乱麻。**

```glsl
float lumEdge = smoothstep(0.10, 0.45, lumGrad);
```

### ③ `halftoneScale` 是 **CSS 像素**，`gl_FragCoord` 是**设备像素**

直接相除的话：dpr=1 的屏上网点周期是 6px，dpr=2 的屏上就变成 3px ——
**同一个配置在两台机器上观感差一倍，retina 上细到看不见。**

这是"素材驱动"最不能忍的那类 bug：配置没变，效果却变了。

```ts
u.uHalftoneScale.value = r.halftoneScale * this.pixelRatio;
```

实测：dpr=1.25 时 uniform 读到 `7.5 = 6 × 1.25` ✓

---

## 6. 实测验证

### 6.1 静态检查

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm test` | **164 / 164**（原 152 + 新增 12） |
| `npm run verify:independence` | ✅ |
| `npm run build` | ✅ |

新增的 12 个测试钉死三件事：零行为变更契约、pulse 只动该动的旋钮、
会当除数的旋钮必须钳下界（`halftoneScale ≥ 1`、`ditherLevels ≥ 2`）。

### 6.2 运行时（浏览器实测）

**媒介层在跑，且 pulse 与后处理严格同步：**

```
scroll 1150 → progress 0.708  postActivity 0.828
              mediumHalftone 0.733
              0.55 × (1 + 0.4 × 0.828) = 0.732  ✓ 精确吻合
```

两个层吃的是**同一个数** —— 这不是巧合，`Composer` 把
`this.post.stats.activity` 直接传给过渡系统，媒介层不再自己算一遍。

**深度缓冲确实挂上了：**

```
hasDepth: 1
tDepth: DepthTexture, isDepthTexture: true
near 0.1 / far 1000        （来自场景相机）
```

**墨线的深度贡献（同条件 A/B，只切换深度分支）：**

| 指标 | 值 |
|---|---|
| 平均绝对差 | 4.70 / 255 |
| 最大差 | **253**（有像素从纸色直接变成全墨） |
| 差值 >8 的像素 | 16.38% |
| 差值 >32 的像素 | 0.02%（约 314 像素） |

**"细线 + 平滑尾"正是边缘检测的特征。** 另外测了 `inkThreshold` 0.08 vs 0.60
—— 结果几乎相同（4.663 vs 4.66），说明深度边是**二值的**（要么 0 要么远超阈值），
符合轮廓特征。

**隔离测试**：把其他项全关、只留墨线并染成红色，红色精确勾出猫的身体、
耳朵、眼睛、领带条纹、帽檐、纽扣。

### 6.3 回归

| 内容包 | `mediumActive` | `mediumPasses` | 结果 |
|---|---|---|---|
| cats | `true` | 持续增长 | 印刷观感 ✓ |
| shopify | `false` | **0** | 无回归，KTX2 + GLB 正常 ✓ |
| placeholder | `false` | **0** | 无回归，`glError 0` ✓ |

**不声明媒介层的包，一个 pass 都不跑，深度纹理也不分配** —— 这是硬约定。

### 6.4 零行为变更契约（实测）

把所有媒介旋钮归零后截图：画面回到**干净的摄影渲染**，没有网点、没有纸色、没有墨线。
shader 里每一步都是 `mix(x, f(x), 0)`，而 `mix(a, b, 0)` 严格等于 `a`。

### 6.5 性能

```
fps 144    drawCalls 31（cats，媒介层开）  glError 0
```

对比媒介层关闭时的 22 —— 多出的 9 个里，媒介层本身占 2 个（current + next）。

---

## 7. 已知限制（诚实声明）

### 7.1 深度项在这套素材上偏弱

cats 包的五个主体与背景**处在相近深度**，所以深度不连续没有"前景物体 vs 远景"
那么剧烈。墨线的贡献主要来自亮度梯度，深度项是补充。

换个有明显前后的内容（例如 shopify 的 GLB 前景 + 远景背景），深度项会强得多。

### 7.2 ★ 暴露了一个**既有的素材缺陷**

调试过程中发现画面背景有矩形色块。追查结果是 `public/content/scene01/background.webp`
**本身**就有这个问题 —— 猫被抹掉之后的填充是 **64px 级的粗块**：

| 文件 | alpha 均值 | 透明占比 | 角点 alpha |
|---|---|---|---|
| background.webp | 255.0 | 0% | 全部 255（无问题） |
| subject-01..05.png | 171.8 ~ 181.9 | 27.6% ~ 31.6% | **全部 0**（干净） |

主体 PNG 的 alpha 是干净的，所以问题在**背景修复（inpainting）的分辨率太低**。

**这与 PHASE 25 无关**（把媒介层全部归零，色块依然存在），但媒介层
**恰好把它盖住了** —— 网点 + 纸纹的纹理把粗块的边界打散了。

> 下一轮可以修：提高 inpainting 分辨率，或换更好的修复算法。

### 7.3 还没有 ASCII 媒介

shader.se 的 ASCII 重绘需要一张字形图集（他们的 `/asci.png`）。
本 PHASE 做的是**印刷媒介**（网点 / 墨线 / 纸纹 / 抖动 / 颗粒）——
这已经覆盖了"两个站点共有的那件事"（媒介重绘），ASCII 是同一个类别下的
另一个实例，可以后续用运行时 canvas 生成图集的方式补上。

### 7.4 网点会让 JPEG 压不动

`docs/img/phase25-*.jpg` 是 205KB / 194KB，而 PHASE 23 的同尺寸截图只有 108KB。
网点是高频内容，JPEG 天然压不动 —— 这反过来也说明媒介层确实在画面里
加了真实的高频结构。

---

## 8. 怎么用

```ts
// src/content/<你的包>/site.ts
import type { MediumConfig } from '../../schema';

const MEDIUM: MediumConfig = {
  enabled: true,
  mono: 0.45,          // 去色程度
  halftone: 0.55,      // 网点强度
  halftoneScale: 6,    // 网点网格边长（CSS 像素）—— 最重要的旋钮
  halftoneAngle: 45,   // 印刷业标准角度
  inkEdge: 0.45,       // 墨线
  inkThreshold: 0.08,  // 墨线灵敏度
  paper: 0.3,          // 纸纹
  paperColor: '#efe7d6',
  inkColor: '#1a1714',
  grain: 0.06,         // 持续颗粒（时间驱动，不依赖滚动）
  pulse: 0.4,          // 与 post 共用同一个活跃度
};

export const SITE: SiteConfig = {
  // ...
  medium: MEDIUM,
};
```

或者直接用出厂预设：

```ts
import { MEDIUM_PRINT } from '../../schema';
```

**调参速查：**

| 想要的效果 | 怎么调 |
|---|---|
| 更像胶印 | `halftoneScale` 2~4，`mono` 0.3 |
| 更像报纸 | `halftoneScale` 5~8，`mono` 0.7，`paper` 0.5 |
| 更像波普艺术 | `halftoneScale` 12~20，`mono` 1.0 |
| 更像漫画 | `inkEdge` 0.8，`inkThreshold` 0.04，`mono` 0.8 |
| 更像数字低保真 | `dither` 0.8，`ditherLevels` 3，`halftone` 0 |

**关掉它**：`medium: { enabled: false }` 或不声明 —— 一个 pass 都不跑。

---

## 9. 一个测试方法上的教训

调试时我试图用「事后改 uniform」来做 A/B 对比，结果**毫无效果**，差点误判成
"深度项没起作用"。

原因是 `MediumSystem.apply()` **在内部就完成了绘制**：

```ts
u.uMono.value = r.mono;      // ← 设 uniform
...
gl.render(this.quad.scene, this.quadCamera);   // ← 绘制在这里发生
return target.texture;
```

在 `apply()` **返回之后**改 uniform，改的是"下一帧会被覆盖掉的值"，
永远影响不到已经画完的那一帧。

**正确做法：改输入，不改输出。** 要么改 `config`（`resolveMedium` 会读它），
要么包装 `apply` 改它的**参数**（例如把 depth 传成 `null`）。

> 同一条教训的另一种形态：**静默无效的测试比没有测试更糟** ——
> 它会给你一个错误的"已排除"结论。（对照 SKILL.md §6.16）
