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
| `npm test` | **175 / 175**（原 152 + 媒介层 21 + shader 守卫 2） |
| `npm run verify:independence` | ✅ |
| `npm run build` | ✅ |

新增的测试钉死四件事：零行为变更契约、pulse 只动该动的旋钮、
会当除数的旋钮必须钳下界（`halftoneScale ≥ 1`、`ditherLevels ≥ 2`）、
**以及一条几何不变量** —— 网点半径系数必须 ≥ 格子外接圆半径（§7.5）。

另有一个 `src/shaders/no-backtick.test.ts` 守卫（§9.4）。

### 6.2 运行时（浏览器实测）

**媒介层在跑，且 pulse 与后处理严格同步：**

```
补分级之前：scroll 1150 → progress 0.708  postActivity 0.828
                        mediumHalftone 0.733
                        0.55 × (1 + 0.4 × 0.828) = 0.732  ✓

补分级之后：scroll 900  → progress 0.555  postActivity 0.984
                        mediumHalftone 0.767
                        uHalftone 实测 0.76656
                        0.55 × (1 + 0.4 × 0.984) = 0.7665  ✓
```

两个层吃的是**同一个数** —— 这不是巧合，`Composer` 把
`this.post.stats.activity` 直接传给过渡系统，媒介层不再自己算一遍。

**分级 uniform 确实落到了 shader 上**（浏览器读回，dpr = 1.25）：

```
uBlackPoint 0.28   uWhitePoint 0.97   uContrast 0.15
uHalftoneScale 7.5  = 6 × 1.25        uHasDepth 1
glError 0
```

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

**隔离测试**（`halftone/paper/dither/grain` 全关、`inkEdge = 1`、红墨）：
红色精确勾出猫的身体、耳朵、眼睛、领带条纹、帽檐、纽扣，
**背景基本不响应**。→ 见 §9.2，第一次做这个测试时因为没隔离变量而得到了错误结论。

**过渡中的媒介层**：`docs/img/phase25-transition.jpg` ——
scene01 与 scene02 在阈值场里交叠，两个场景各自被重绘成网点印刷品，
载体同时飞过。此时 `progress 0.555 / nextIndex 1 / drawCalls 37 / glError 0`。

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

### 7.1 深度项与亮度项的分工，比设计时预想的更"各管一段"

设计时的想法是"深度抓物体边界、亮度抓内部纹理"，两者叠加。
隔离实测（§6.2）之后，实际分工更清楚也更窄：

- **深度项**负责**主体与背景的剪影**（cats 的主体在 z 20~34，背景在 z 40，
  这里是有真实深度跳变的）
- **亮度项**负责**物体内部的纹理轮廓**（胡须、领带条纹、纽扣）

但 cats 这套素材的五个主体**彼此处在相近深度**，主体之间没有深度跳变 ——
所以"主体与主体交界"这种边只能靠亮度项。换成有明显前后关系的内容
（例如 shopify 的 GLB 前景 + 远景背景），深度项会强得多。

→ 这也是 §7.7 那道闸门存在的原因：既然深度只覆盖剪影，
就不该让亮度项在背景纹理上随便点亮。

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

同为 1280 宽的截图：

| | 体积 | 尺寸 |
|---|---|---|
| PHASE 23（无媒介层） | 108.6 / 106.0 KiB | 1280 × 572 |
| PHASE 25（补分级之前） | 205.3 / 194.7 KiB | 1280 × 578 |
| **PHASE 25（补分级之后）** | **286.2 / 308.0 KiB** | 1280 × 577 |

高度差 5~6px 是视口取整，不足以解释 2.7 倍的体积差。
补上分级之后体积又涨了约 45% —— 墨量上去了，高频内容更多。

网点是高频内容，JPEG 天然压不动 —— 这反过来也说明媒介层确实在画面里
加了真实的高频结构。

---

## 7.5 ★★ 一个"印不出来"的真 bug：网点半径的上限

**这是补做分级时才发现的，而且它伪装成了"素材太灰"。**

```glsl
// 修复前
float radius = sqrt(clamp(1.0 - srcLuma, 0.0, 1.0)) * 0.62;
```

网点网格是 `fract(p) - 0.5`，所以**格子内离中心最远的距离是 `sqrt(0.5) ≈ 0.7071`**。
系数 0.62 **小于**它 —— 意味着 `srcLuma = 0`（最黑）时半径也只有 0.62，
铺不满格子。

> **画面在数学上就印不出实黑。** 无论素材多黑，最多只能印出一片灰。

修复：系数改成 **0.78**（留一点余量给抗锯齿的过渡带），并加了一条不变量测试
把 `K ≥ sqrt(0.5)` 钉死，防止以后有人"调小一点更柔和"。

```ts
// src/schema/medium.test.ts
const K = 0.78;
const CELL_CIRCUMRADIUS = Math.SQRT1_2;   // ≈ 0.7071
expect(K).toBeGreaterThanOrEqual(CELL_CIRCUMRADIUS);
```

### 为什么"看不出是 bug"

单看画面只会觉得"偏灰、不够精神"，很像素材本身的问题 ——
而这套素材确实是浅色调的油画猫，所以这个解释非常自洽。
只有把半径公式和网格几何放在一起算，才会发现上限是**结构性**错的。

---

## 7.6 ★★ 缺了一级：单色分级（grade）

修完半径之后画面依然偏灰。查下去发现**少的是一整级**。

实测素材的亮度分布（`background.webp` + 五张 `subject-*.png`，
主体只统计 `alpha > 0.5` 的像素）：

| | p1 | p50 | p95 | p99 |
|---|---|---|---|---|
| 背景 | 0.371 | 0.731 | 0.871 | 0.904 |
| 主体合并 | 0.071 | 0.808 | 0.897 | 0.917 |
| **画面整体** | **0.298** | **0.744** | **0.882** | **0.909** |

也就是说墨量 `1 - 亮度` 只有 **0.09 ~ 0.70**，中位数 0.26 ——
**每个格子里都是小点**，整幅画印出来是一片浅灰米色。

参考站点的管线里这一步叫 `mono grade`（"单色分级"），是网点的**前置**。
它们不需要拉伸，是因为它们的场景是美术指导过的（深色背景 + 高饱和色块，
本来就跨越全色阶）。**本引擎的输入是普通照片，所以必须自己补上这一级。**

实现两级，顺序不能换：

```glsl
float gradeTone(float l) {
  // 1. levels —— 黑白场拉伸
  l = clamp((l - uBlackPoint) / max(uWhitePoint - uBlackPoint, 1e-3), 0.0, 1.0);
  // 2. contrast —— 绕 0.5 的 S 曲线，增益 = 1 + 对比 × 2
  return clamp((l - 0.5) * (1.0 + uContrast * 2.0) + 0.5, 0.0, 1.0);
}
```

### 三个取值的来历（cats 包）

- **blackPoint 0.28** —— 略低于画面 p1（0.298），把最暗的 1% 压成实黑
- **whitePoint 0.97** —— **故意高于 p99（0.909），不是取 p99**。
  取 p99 的话猫毛（p50 = 0.808）会被推到白点以上、半径归零 ——
  实测效果是"猫变成一张没有网点的白纸，只有背景有网点"，
  主体反而比背景更不像印刷品。抬到 0.97 之后猫毛保住 0.31 的点径
  （背景 0.43），两边都有网点，而真正的高光（0.92+）依然干净留白。
- **contrast 0.15** —— 这组素材偏亮（p50 = 0.744），S 曲线会把中位往亮处推、
  反而减少墨量。所以主要靠 levels 拉伸，S 曲线只做一点点分离。

### 分级**不参与脉动**，也**不喂墨线**

- 不脉动：让黑场随滚动上下浮动，读起来是"整幅画的曝光在抽"，不是印刷在呼吸
- 不喂墨线：墨线看的是**梯度**，拉伸会把噪点放大成假边

---

## 7.7 墨线：深度当闸门，而不是和亮度取 max

`inkEdge` 原本是 `max(depthEdge, lumEdge)`。这个写法**做不到**字段注释里
承诺的那件事（"加上深度之后，只有真正'立着的东西'才会被勾边"）——
亮度项单独就能点亮任何纹理。

改成让深度当闸门：

```glsl
// 深度存在时，亮度项必须得到深度的支持才画满
float gate = (uHasDepth > 0.5) ? (0.25 + 0.75 * depthEdge) : 1.0;
return max(depthEdge, lumEdge * gate);
```

留 0.25 的底是为了保住物体**内部**的纹理轮廓（胡须、领带条纹）——
那些地方深度是连续的，完全掐掉会把它们一起丢掉。

**隔离实测**（`halftone/paper/dither/grain` 全关，`inkEdge = 1`，红墨；
这样画面里除了原图只可能有一条红色墨线）：

| 区域 | 无闸门 | 有闸门 | 降幅 |
|---|---|---|---|
| 顶部纯背景带 | 7.22 | 6.44 | −10.8% |
| 主体带 | 9.93 | 7.54 | **−24.0%** |
| 红色像素占比 | 6.36% | 5.19% | −18% |

主体带降得**比背景更多**，正是预期结果：闸门掐掉的正是深度连续的**内部纹理**，
留下的是有深度支撑的**轮廓**。

---

## 8. 怎么用

```ts
// src/content/<你的包>/site.ts
import type { MediumConfig } from '../../schema';

const MEDIUM: MediumConfig = {
  enabled: true,
  mono: 0.45,          // 去色程度
  // ↓ 分级：把素材那点窄色调范围拉到 0..1。**照片驱动时这是必需的一级**
  blackPoint: 0.28,    // 低于它算全黑（网点铺满）
  whitePoint: 0.97,    // 高于它算全白（完全不着墨）
  contrast: 0.15,      // 绕 0.5 的 S 曲线
  halftone: 0.55,      // 网点强度
  halftoneScale: 6,    // 网点网格边长（CSS 像素）—— 最重要的旋钮
  halftoneAngle: 45,   // 印刷业标准角度
  inkEdge: 0.45,       // 墨线（深度当闸门，见 §7.7）
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

## 9. 测试方法上的教训（同一个坑踩了三次）

### 9.1 事后改 uniform 是无效的

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

### 9.2 ★ 红墨测试：变量没有隔离出你想测的东西

为了看清墨线落在哪，我把 `inkColor` 设成红色、`inkEdge` 拉到 1。
结果是**整个画面变粉**，包括大片背景 —— 我据此得出了
"墨线在整个背景上都在触发"的结论。

**这个结论是错的。** `uInkColor` 在 shader 里有**两个**用处：

```glsl
vec3 ink = mix(src * 0.15, uInkColor, 0.85);   // ① 网点的墨色
...
c = mix(c, uInkColor, line * uInkEdge);        // ② 墨线的颜色
```

改它等于**同时**把网点和墨线都染红了 —— 那片粉色是**网点**，不是墨线。

**正确做法：先把其它项关掉。** `halftone/paper/dither/grain` 全设 0，
画面里就只剩原图 + 墨线，红色才唯一对应墨线。隔离之后看到的是一条
**又细又准**的轮廓线（猫的剪影、眼睛、帽檐、领带条纹、纽扣），
背景基本不响应。

### 9.3 ★ 截图用的注入 CSS 把被测对象改坏了

为了拍一张没有调试面板的干净截图，我往页面里注入了
`html{overflow:hidden!important}`。之后在过渡中间截图，**整屏全黑**。

我据此怀疑"过渡有 bug"，还做了一次"关掉媒介层看是不是它"的对照 ——
**两次都是黑的**，于是差点写下"媒介层无关，是过渡链的问题"这个结论。

真实原因：**是我自己注入的那条 CSS 把画面弄黑的。**
去掉它之后同一个滚动位置渲染完全正常（见 §6.2 的过渡截图）。

**三次是同一个病**：测试手段自己改变了被测对象，而结果看起来像被测对象的问题。

> **通用结论**：动手改之前先问一句 ——
> **"我这个操作，只改了我想改的那一个变量吗？"**
> 尤其是这三类：改配置项（可能被别处复用）、
> 改注入的样式/脚本（会改变布局与渲染）、
> 在"已经画完"之后改状态。
> （对照 SKILL.md §6.16 与 §6.7）

### 9.4 于是给"反引号"这个坑加了一道守卫

补做分级的时候，这个坑**第四次**发生了：新写的 GLSL 注释里带了反引号
（`` `max(depthEdge, lumEdge)` ``），esbuild 报
`Expected ";" but found "max"`。

所以加了 `src/shaders/no-backtick.test.ts`，扫 `src/shaders/*.ts`，
断言**模板字符串内部不出现反引号**。

三个设计点：

1. **必须把源码当文本读**（用 Vite 的 `?raw`，不用 `import`）——
   因为出问题时那个文件是语法错误的，`import` 它会让测试文件一起加载失败，
   守卫就永远不会跑。
2. **不能只数反引号的奇偶** —— 成对的反引号会让总数保持偶数，
   但配对关系已经平移了，文件照样坏。
3. **守卫自己也要被验收**（SKILL §6.2）：用一个临时的
   `src/shaders/__guard-probe.ts` 制造真 bug，确认守卫**会 FAIL**
   并报出 `文件:行号 + 那一行的原文`，然后删掉探针。

> 顺带一提：`?raw` 而不是 `node:fs`，是因为本项目没装 `@types/node`，
> `tsconfig` 的 `types` 只有 `vite/client` —— 用现成的基础设施，不引新依赖。
