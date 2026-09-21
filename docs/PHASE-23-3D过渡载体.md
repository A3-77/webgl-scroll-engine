# PHASE 23 —— 3D 过渡载体 + 后处理语义缺陷修复

> 本次改动分两部分，价值不对等，所以文档也分开写：
> **① 3D 过渡载体**（原计划的工作）
> **② 顺带挖出并修掉的 PHASE 18 真实缺陷**（意外收获，但对可用性的影响更大）
>
> 如果你的时间只够看一节，看第 5 节。

---

## 1. 起因

对照参考站点后得到的判断：

> 「你现在的只是单纯的图片转场了」

对照 `shader.se`（SKY）的做法：

- 一架 3D 飞机沿 Catmull-Rom 曲线飞过画面
- 飞机身上"挂"着一个小平面，那个小平面上跑过渡 shader
- shader 的溶解边缘用**多频正弦叠加**做成有机的、油墨扩散式的形状
- 于是画面不是在"叠化"，而是在**被飞过的东西擦写**

我们原实现是纯 2D 的：铺一张阈值图，比较 `progress - threshold`。
边界再活，它也是**没有主体的** —— 没有一个"东西"在做这件事。
这就是"看起来只是图片转场"的根因。

---

## 2. 做了什么

### 2.1 契约层（`src/schema/carrier.ts`，新增）

`CarrierConfig` 是一份纯声明，内容包只需要说"我想要一个什么样的载体"：

| 字段 | 作用 | 默认 |
|---|---|---|
| `enabled` | 总开关。false = 行为与改造前逐位相同 | `false` |
| `preset` | 自动路径：`fly-across` / `fly-through` / `orbit` / `rise` | `fly-across` |
| `path` | 手写控制点，覆盖 preset（进阶选项） | — |
| `kind` | `shape`（程序化几何）/ `glb`（内容包自己的模型） | 按是否给了 `model` 推断 |
| `shape` | `plane` / `box` / `sphere` / `cone` / `torus` | `plane` |
| `scale` | 整体缩放 | `1` |
| `orient` | `billboard` / `tangent` / `fixed` / `spin` | `billboard` |
| `color` | 载体颜色 | `#e8e2d6` |
| `opacity` | 不透明度（< 1 自动切 transparent） | `1` |
| `emissive` | 自发光强度，让 bloom 抓到它 | `0.35` |
| `follow` | **溶解中心跟随载体的强度 0..1** | `0.75` |
| `organic` | **有机边缘强度 0..1** | `1` |
| `onlyDuringTransition` | 只在过渡进行中显示 | `true` |

**为什么默认给 preset 而不是让内容包手写路径**：素材驱动的原则是"丢图进去就出网站"。
要求用户手写一串 Catmull-Rom 控制点（还得理解相机 z / fov / 视锥）等于把门槛抬回
"你得懂 three.js"。所以默认走 preset —— 引擎按当前相机参数算出屏幕边界，
自动生成一条合理的飞行路径。

### 2.2 载体系统（`src/engine/systems/CarrierSystem.ts`，新增）

持有一个**独立的 `THREE.Scene`**、一条 `CatmullRomCurve3`、一个程序化几何的 Mesh。

### 2.3 过渡 shader（`src/shaders/transition.ts`，改）

新增三个 uniform + 两个函数：

```glsl
uniform vec3  uCarrierPoint;    // 载体此刻的世界坐标
uniform float uCarrierFollow;   // 溶解中心被拉向载体的强度
uniform float uCarrierOrganic;  // 有机边缘强度

float organicDistance(vec2 uv, vec2 center, float t, float amount) {
  vec2 d = (uv - center) * vec2(uAspect, 1.0);
  float r = length(d);
  if (amount <= 0.0001) return r;
  float angle = atan(d.y, d.x);
  float wobble = sin(angle*3.0 + t*1.5)*1.5
               + sin(angle*7.0 + t*2.5)
               + sin(angle*13.0 + t*0.8)*0.5;
  return r + wobble * 0.02 * amount;
}

vec2 projectToScreen(vec3 worldPos) {
  vec4 clip = uProjectionView * vec4(worldPos, 1.0);
  return (clip.xy / clip.w) * 0.5 + 0.5;
}
```

主函数里两处改动：

```glsl
sceneCenter = mix(sceneCenter, projectToScreen(uCarrierPoint), uCarrierFollow);
float dist = organicDistance(uv, maskCenter, uTime, uCarrierOrganic) * 0.8;
```

**频率为什么是 3 / 7 / 13**：整数倍（3/6/12）会让三个波在同一相位反复对齐，
边界看起来像有棱角的星形；3/7/13 互质，一个周期里几乎不重复，读起来才像"有机的"。

### 2.4 装配层（`src/engine/Composer.ts`，改）

```
① 场景解析 → ② 求值 → ③ 过渡混合到 rtComposite
                          ↓
                  ③' renderCarrier（把载体叠在合成画面之上）
                          ↓
                  ④ 后处理链 → ⑤ 屏幕
```

**★ 为什么载体必须有自己的 Scene，不能挂进 currentScene / nextScene**：
挂进去的话它会被自己引发的溶解给溶掉（飞到一半消失一半）。

**★ 为什么必须在过渡 blit 之后、后处理之前叠上去**：
这样它永远完整地压在合成好的画面之上，同时还能吃到 bloom / 颗粒。

**★ 为什么 `renderCarrier` 必须关掉 `autoClear`**：
这一步是"在已有画面上再画一个东西"，不是"重新画一张"。
默认的 `autoClear = true` 会在 `render()` 开头把颜色缓冲清掉 ——
过渡结果就没了，只剩下载体孤零零地飘在黑底上。

### 2.5 零行为变更契约

`uCarrierFollow` / `uCarrierOrganic` 全为 0 时：

- `mix(sceneCenter, carrierCenter, 0)` 是恒等变换
- `organicDistance(..., 0)` 直接 `return length(d)`，与原来的 `length()` 逐位相同

**这是硬要求**：不声明载体的内容包（shopify / placeholder）必须完全不受影响。
实测 shopify 包回归通过（见第 6 节）。

---

## 3. 踩坑记录

### 3.1 循环依赖：载体永远不出现，而且不报错

第一次接线时，`Composer` 里用 `this.carrier.active` 当闸门：

```ts
if (this.carrier.active) {          // ✗ 错
  this.carrier.setCamera(...);      // ← 路径正是在这里面才建的
  this.carrier.update(...);
}
```

而 `active` 的定义是"物体建好 **且** 路径算好"。
路径又是这个块里调 `setCamera()` 才建的 —— 于是条件永远为假，
载体永远不出现，**而且不报错**。

**诊断方式**：在浏览器里读 `carrier.stats`，看到
`{ ready: true, hasCurve: false, active: false }`。

**修法**：拆成两个 getter，闸门用要求更弱的那个。

```ts
/** 物体建好了（路径可能还没算） */
get ready(): boolean { return this.stats.ready && this.object !== null; }
/** 完全就绪：物体 + 路径 */
get active(): boolean { return this.ready && this.curve !== null; }
```

**教训**：状态闸门要选**依赖最少**的那个谓词。
用"完全就绪"去当"开始初始化"的条件，就是经典的鸡生蛋。

### 3.2 载体几乎看不见

两个原因叠在一起：

1. `orient: 'tangent'` —— 平面法线朝着前进方向，而它是**横向**飞过画面的，
   结果平面**侧对**镜头，屏幕上只剩一条几乎看不见的细线。
   → 平面类载体必须用 `billboard`。
2. `buildShape()` 把颜色**硬编码成纸白** `#e8e2d6`，完全无视 `config.color`。
   素材是浅灰底的油画 —— 纸白载体在上面彻底隐形。
   → 颜色必须走 config。这也是"引擎不能假设素材明暗"的一部分。

### 3.3 浅色素材上，不透明的深色载体是一个"洞"

改成深色 `#2b2622` 之后载体能看见了，但在浅色油画上它就是一块**不透明的黑洞**，
比不加载体还难看。

**修法**：新增 `opacity` 旋钮。`0.42` 读起来是"一片玻璃飞过"：
看得见、有存在感，又不挡内容。

**为什么做成 schema 字段而不是在代码里写死**：这是审美决策，
按本项目的分工应该归内容包（见 `内容包契约.md`）。

### 3.4 浅色素材在过渡正中间整屏过曝

**症状**：油画猫图（浅灰底，luma ≈ 0.8）在 `uProgress ≈ 0.5` 时全屏白，
什么都看不见；深色素材（参考站点那种暗青底）完全正常。

**根因**：过渡 shader 里的发光是纯粹的**乘法**：

```glsl
outputColor = mix(outputColor, outputColor * glowMult, (1.0 - glowFactor) * glowGate);
```

hero 模式下 `glowMult` 最高到 40。参考站点是深色画面，深色乘 8 刚好是
"看得见的辉光" —— 所以这个写法在原站点上是对的，**它没打算通用**。
但浅色像素乘 8 就是 6.4，远超 1.0；再喂给 pmndrs 的 mipmap bloom，
会被摊成一整屏白（比自制的 3 pass 高斯宽得多）。

**修法**：给每个像素算一个"乘到这个系数刚好到 1.0"的上限，取小值：

```glsl
float baseLuma = dot(outputColor.rgb, vec3(0.299, 0.587, 0.114));
float glowCeiling = 1.0 / max(baseLuma, 0.08);
float glowScale = min(glowMult, glowCeiling);
outputColor = mix(outputColor, outputColor * glowScale, (1.0 - glowFactor) * glowGate);
```

自调节效果：

| 像素亮度 | 上限 | 结果 |
|---|---|---|
| luma 0.10（深色素材） | 10 | hero 的 8 原样通过 —— **观感零变化** |
| luma 0.80（浅色素材） | 1.25 | 峰值停在 1.0，不再过曝 |
| luma 0.05（极暗） | 20 | 8 原样通过 |

也就是"只在乘完不会过曝的范围内乘" —— 亮的地方自然少给，暗的地方给足。

---

## 4. 载体接线验证

浏览器实测（cats 包，`follow: 0.8`，`organic: 1`）：

| 时刻 | `uProgress` | `carrierT` | `carrierVisible` | `postActivity` |
|---|---|---|---|---|
| 静止 | 0.000 | 0.000 | false | 0.00 |
| 过渡中 | 0.841 | 0.841 | true | 0.478 |

`carrierT` 精确跟随 `uProgress`，`glError = 0`，
过渡区间外自动隐藏（`onlyDuringTransition`）。

截图见 `docs/img/phase23-transition.jpg` —— 可以清楚看到
**有机波浪状的溶解边界**和飞过的载体。

---

## 5. ★★ 顺带挖出的 PHASE 18 真实缺陷（本次最大产出）

### 5.1 症状

用火山引擎 EntitySegment 重新分割出 5 只猫之后，浏览器里**每只猫都被渲染成彩虹噪点**，
背景变成一片平坦的浅灰，完全看不出内容。

同时：`generated/preview-scene01.png`（build-assets 自己的验证图）**完全正常**，
产出 PNG 的 alpha 分布也完全正常（均值 171.8、覆盖 68%、无"只剩轮廓"特征）。

**所以分割没问题，素材没问题 —— 问题在渲染链。**

### 5.2 定位过程

用了 6 次二分，每次都在浏览器里改活对象 + 截图：

| # | 操作 | 结果 | 结论 |
|---|---|---|---|
| 1 | `enablePost = false` | **完美画面** | 问题 100% 在后处理链 |
| 2 | 全部效果参数归零 | 平坦浅色 | 不是参数问题，是链路问题 |
| 3 | `effectPass.enabled = false` | 仍平坦 | **无效测试**（见下） |
| 4 | 把 `rtComposite` 像素读回来 | `[0.71, 0.78, 0.87, 1]` | rtComposite 内容**正确** |
| 5 | 把 EffectPass 的 `inputBuffer` 直接 blit 到屏幕 | **完美画面** | EffectPass 收到的输入**正确** |
| 6 | 逐个效果单独挂载 | `hueSaturation` 单独 → 整屏霓虹 | **元凶锁定** |

**测试 3 的坑（值得记下来）**：`pass.enabled = false` 之后，
composer 不再把 `renderToScreen` 赋给剩下的 pass，
于是**什么都没画到屏幕上** —— 看到的是清屏色，不是 pass 的输出。
必须用 `composer.removePass(pass)`（库的 `autoRenderToScreen` 逻辑会接管），
或者干脆改 pass 的 `render` 方法。

**测试 4 的坑**：`renderer.readRenderTargetPixels` 对 HalfFloat 目标
**必须传 `Uint16Array`**（不是 `Float32Array`），否则 WebGL 静默失败、返回全 0，
看起来像"缓冲是空的"。

### 5.3 根因

`PostSystem` 把 schema 的值**原样透传**给了 pmndrs/postprocessing 的 uniform，
但两套语义完全对不上。

读库源码（`node_modules/postprocessing/build/index.js`）拿到的 ground truth：

```glsl
// HueSaturationEffect —— 7387 行
uniform float saturation;
...
if (saturation > 0.0) { color += diff * (1.0 - 1.0 / (1.001 - saturation)); }
else                  { color += diff * -saturation; }
```

```glsl
// BrightnessContrastEffect —— 4435 行
uniform float brightness; uniform float contrast;
vec3 color = inputColor.rgb + vec3(brightness - 0.5);
if (contrast > 0.0) { color /= vec3(1.0 - contrast); }
else                { color *= vec3(1.0 + contrast); }
outputColor = vec4(color + vec3(0.5), inputColor.a);
```

库自己的 JSDoc 也写得很清楚：

```
@param {Number} [options.saturation=0.0] - The saturation factor,
       ranging from -1 to 1, where 0 means no change.
@param {Number} [options.brightness=0.0] - ... where 0 means no change.
@param {Number} [options.contrast=0.0]   - ... where 0 means no change.
```

而本项目的 schema 承诺的是（`src/schema/post.ts`）：

| 字段 | schema 语义 | pmndrs 语义 | 要映射？ |
|---|---|---|---|
| `saturation` | 倍率，**1 = 原样** | 偏移，**0 = 原样** | ✅ 要 |
| `contrast` | 倍率，**1 = 原样** | 偏移，**0 = 原样** | ✅ 要 |
| `brightness` | 偏移，**0 = 原样** | 偏移，**0 = 原样** | ❌ **不要** |

**cats 包实际发生的事**：

- `saturation: 0.92`（本意"略降饱和"）→ `diff * (1 - 1/(1.001-0.92))` ≈ `diff * -998`
  → **整屏霓虹色**，再被 bloom 一糊就成了白屏上的彩色噪点
- `contrast: 1.06` → `color / (1 - 1.06)` = `color / -0.06` → **直接反相**

两个叠起来，画面全废。

### 5.4 修法

在 `PostSystem` 里加一层**语义映射**（纯函数，可单测）：

```ts
/** 饱和度倍率 → pmndrs 偏移。上限钳到 0.999：shader 里 `1.001 - s` 做分母。 */
export const saturationToOffset = (mult: number): number => Math.min(mult - 1, 0.999);

/**
 * 对比度倍率 → pmndrs 偏移。
 * shader 分两段，实际增益分别是 1/(1-c) 和 1+c。
 * 反解出让增益恰好等于 schema 承诺的倍率 k：
 *   k ≥ 1 → c = 1 - 1/k
 *   k < 1 → c = k - 1
 * 这样任何 k 都取不到 c = 1 的除零点。
 */
export const contrastToOffset = (mult: number): number =>
  mult >= 1 ? 1 - 1 / mult : mult - 1;

/** 亮度偏移 → pmndrs 电平。**恒等** —— 首尾两个 0.5 互相抵消，见下。 */
export const brightnessToLevel = (offset: number): number => offset;
```

**★ 反向踩坑（第一版修法又踩了一次）**：
第一版"顺手"把 `brightness` 也平移了 `0.5`（以为 0.5 是中性），
结果整屏**过曝成白**。

原因在 shader 的最后一行 —— 完整算式是：

```
color       = inputColor + (brightness - 0.5)
color       = color / (1 - contrast)     （或 × (1 + contrast)）
outputColor = color + 0.5
```

**首尾两个 0.5 互相抵消**，所以 `brightness = 0` 才是恒等。

> **教训**：要按 shader 的**完整算式**反解中性值，不能只看中间那行。

### 5.5 为什么不在内容包侧改值迁就库

那样等于把库的怪语义泄漏进内容包的作者手里 —— 下一个包作者还得再踩一遍。
**映射必须在引擎这一层做完**，内容包只面对"倍率 1 = 原样、偏移 0 = 原样"这一套。

### 5.6 为什么之前没发现

- `DEFAULT_POST`（`src/config/design.ts`）只用了
  `bloom` / `chromaticAberration` / `noise` / `vignette` —— **这四个的语义恰好都对得上**。
- 所以 shopify 包（用默认链）一直正常。
- 只有 cats 包显式声明了 `hueSaturation` + `brightnessContrast`，
  于是只有它炸 —— 而且炸得很像"素材/分割有问题"，掩盖了真正的原因。

### 5.7 防回归

新增 `src/engine/systems/PostSystem.test.ts`（13 项），
把「schema 的值 → uniform → 实际像素」整条链算成纯函数断言，
其中包含把 shader 算式逐字抄成 JS 的 `applyBrightnessContrast`：

```ts
it('★ schema 的中性值（brightness 0 / contrast 1）必须逐像素恒等', () => {
  for (const input of [0, 0.15, 0.5, 0.72, 1]) {
    expect(applyBrightnessContrast(input, 0, 1)).toBeCloseTo(input, 9);
  }
});
```

还专门留了一条测试**复现第一版错误映射的白屏**，
这样下一个改这层的人能看到"为什么不能加 0.5"。

---

## 6. 验证结果

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm test` | **152 / 152 通过**（原 139 + 新增 13） |
| `npm run verify:independence` | ✅ 删除内容包后引擎照常构建、产物干净 |
| `npm run build` | ✅ |
| cats 包（7 效果 + 载体） | ✅ 五只猫清晰可辨，见 `docs/img/phase23-scene01.jpg` |
| shopify 包（默认链） | ✅ 无回归（KTX2 背景 + GLB 36,125 顶点） |
| 载体跟随 | `carrierT` 精确等于 `uProgress`，区间外自动隐藏 |
| 每只猫的独立运动 | 见下表 |

**每只猫独立运动实测**（40px 滚动量，cats 包 scene01）：

| 图层 | dx | dy | dScale | 说明 |
|---|---|---|---|---|
| `bg` | 0 | 0 | 0 | 静止 |
| `subject-01` | 0 | +0.0496 | 0.00087 | 纯纵向 |
| `subject-02` | +0.0535 | 0 | 0.00102 | 纯横向 |
| `subject-03` | +0.0621 | +0.0435 | 0.00116 | 双轴，幅度最大 |
| `subject-04` | +0.0113 | +0.0062 | 0.00087 | 双轴，幅度最小 |
| `subject-05` | 0 | +0.0683 | 0.00102 | 纯纵向，幅度最大 |

五只猫走不同的轴、不同的幅度 —— 这正是"每只猫都有自己的动画"的量化证据。

---

## 7. 已知限制（诚实声明）

1. **载体是纯程序化几何，不是"有意义的物体"**。
   `plane` 读起来是"一片玻璃/一张纸"，不是 SKY 那种飞机剪影。
   要真正的语义物体，内容包得自己提供 GLB（`kind: 'glb'` + `model`）。

2. **载体是实心的，不是"传送门"**。
   SKY 的做法是让载体平面自己渲染过渡 shader（载体上显示下一章的画面）。
   我们目前是"一个半透明物体飞过 + 溶解中心跟随"，
   效果接近但不是同一个机制。做成传送门需要在 `CarrierSystem` 里
   接一张 rtNext 纹理，属于后续工作。

3. **`organic` 只作用于 `radial`（hero）模式的阈值场**。
   `sweep` 模式走的是斜向擦除，边界本来就不是圆，没有加有机扰动的必要。

4. **载体路径是预设的，不响应鼠标**。
   参考站点的飞机是会跟着鼠标微调的。目前只有滚动驱动。

5. **`opacity < 1` 时 `depthWrite` 被关掉**。
   对单片载体没问题；如果将来做"多个载体互相遮挡"，
   需要改成先按深度排序再画。

---

## 8. 复现命令

```bash
cd webgl-scroll-engine

# 1. 重新生成素材（需要火山引擎凭证，见 PHASE-24 文档）
npm run build-assets -- --provider=volcengine --max-entity=8

# 2. 起服务
npm run build && npm run preview     # 或 npm run dev

# 3. 打开 cats 包（默认）
#    http://127.0.0.1:4173/
#    回归 shopify 包：
#    http://127.0.0.1:4173/?content=shopify

# 4. 调试：控制台里 __ENGINE__ 可访问 composer / renderer / pack
#    __ENGINE__.composer.stats        → 含 carrierVisible / carrierT / postActivity
#    __ENGINE__.composer.enablePost = false   → 看过渡 shader 的原始输出
#      （调阈值场时必须关，否则分不清亮边是 shader 画的还是 bloom 加的）
```
