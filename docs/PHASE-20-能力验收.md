# PHASE 20 —— 引擎能力验收

> 这一阶段回答一个具体问题：**引擎声明支持的能力，真的能用吗？**
>
> 起因：审计发现 schema 里有 20 多项能力，但**很多从来没有内容用过**。
> 它们可能早就坏了而没人知道 —— 不报错，只在你第一次真用的时候才暴露。

---

## 一、审计：25 项能力里只有 13 项被验证过

方法：grep `src/schema/` 里声明的每个能力，看它在**内容里**有没有被真实使用、
以及有没有端到端验证过。

| 状态 | 数量 | 典型 |
|---|---|---|
| ✅ 端到端验证过 | 13 | `fit: cover/contain`、`offset`、`overscan`、`z` 视差、相机轨道、radial 过渡、`opacity`/`position`/`scale` 轨道、`role`、`opaque` |
| ⚠️ 只验证了一部分 | 5 | `parallax`（只测过背景的 0）、`tint`（用过但没看效果）、`modelHeight`、`type: 'model'`、`scrubAnimations` |
| ❌ 代码在、内容从未用过 | 7 | `camera.damping`、`blending: 'additive'`、`visible` 轨道、`camera.fov` 轨道、`earlyCrossfade`、`sweep` 过渡、对象 `rotation.z` 轨道 |

**7 项"从未触发"里最危险的是**：

- `earlyCrossfade` —— 规则是 `index >= 2 ? 0.2 : 0`，而默认的 cats 包只有 2 个场景 → **恒为 0**
- `sweep` 过渡 —— 过渡取 **currentScene** 的 mode，scene02 自己的 sweep 要等 scene03 才跑得到
- `camera.damping` —— `SceneBuilder` 里实现完整（含帧率无关的 `1-exp(-dt/τ)`），但所有内容包的 damping 都是 undefined

---

## 二、做法：让 placeholder 成为完整的能力验收台

`placeholder` 的定位就是"改动引擎之后先跑它"，所以把缺的 4 项补进去：

| 补的能力 | 加在哪 | 为什么这样用 |
|---|---|---|
| `parallax: 1.4` | scene-hero 的 `fg` | 前景"跑得比几何允许的更狠" —— 语义自然 |
| `damping: 0.12` | scene-sidekick 的相机 | 滚动停下后相机再滑一小段 |
| `blending: 'additive'` | scene-retail 的 `mid` | 深色背景下 = 发光层 |
| `visible` 轨道 | scene-retail 的 `fg` | 收尾时前景退场（`visible` 是硬切，要淡出该用 `opacity`） |

它原本已覆盖 `rotation.z` / `fov` / `tint` / `earlyCrossfade` / `sweep`（3 个场景），
补完之后**七项全齐**。

---

## 三、验收脚本：新增 7 项能力检查（⑩~⑯）

设计上刻意**通用** —— 遍历当前内容包**实际声明的**能力逐项验证，
而不是针对 placeholder 写死。换一个包，验证的就是另一批能力。
内容里没声明的报 SKIP，并说明"这项没被覆盖"。

几个检查的验证方式值得说：

### ⑩ parallax —— 直接测倍率，不是读字段

```ts
const withK   = worldDelta(built, layer, 0, 1);        // 声明值下的位移
layer.parallax = 1;
const withOne = worldDelta(built, layer, 0, 1);        // 改成 1 之后的位移
layer.parallax = declared;                             // 立刻恢复
// 比值应该 ≈ 声明值
```

实测：`fg ×1.4（实测 1.400）`。

### ⑪ damping —— 一帧内把 t 从 0 跳到 1，相机不该到位

```ts
for (let i = 0; i < 200; i++) built.applyTime(0, 1/60);   // 先收敛到 t=0
built.applyTime(1, 1/60);                                  // 一帧跳到 t=1
const afterOneFrame = cam.position.clone();
for (let i = 0; i < 400; i++) built.applyTime(1, 1/60);    // 再收敛
const settled = cam.position.clone();
// 一帧后的滞后量应 > 总行程的 20%
```

实测：`τ=0.12s（一帧后仍差 87%）`。

### ⑯ radial / sweep —— 滚遍全部章节，读 shader 的 `uIsHero`

实测：`两种模式都实际渲染过`。

---

## 四、★ 这一轮抓到的 4 个问题

**其中 3 个是我自己的检查写错了** —— 这恰恰说明"验收脚本也需要被验收"。

### 4.1 检查脚本的滚动位置算错了（误报 sweep 从未渲染）

```ts
// ✗ 每一轮都落在第一章里 —— heights[i] 是每一章自己的高度，
//   而 scrollTo 要的是从文档顶部算起的**绝对位置**
for (const h of heights) { const y = h * frac; }

// ✓ 累计偏移
let acc = 0;
for (const h of heights) { const y = acc + h * frac; acc += h; }
```

这个 bug 最坑的地方：**它报的 FAIL 看起来像是引擎的问题**。

### 4.2 `role` 是可选字段 → 手写包一定忘

检查 ② 一开始在 placeholder 上 FAIL：手写内容包的对象没有声明 `role`。

修法不是放松检查，而是**给手写包补上**（placeholder 9 处 + shopify 8 处），
并在 `schema/object.ts` 里写清楚：**role 是契约的一部分，不是可选装饰** ——
缺了验收就只能报 SKIP，而 SKIP 意味着"没验证"，不是"没问题"。

### 4.3 「背景必须静止」这条断言写得太武断

原本加了一条反向断言：`role: 'background'` 的对象必须静止。
后来发现是错的 —— shopify 包第 2 章拿一个 GLB 星点模型当背景层，
它带 ±0.03 的 x 漂移；**远景层漂移是完全合理的**（星点、云、雾）。

改成**只报告不判定**：背景有没有在动，交给读者判断。

> 顺带修正了 `role` 的语义：它表达"**是什么**"，不是"**必须怎样**"。

### 4.4 帧率检查漏判了"窗口被遮挡"

```ts
// ✗ 只看这两个：实测 hasFocus() 返回 true，但 60 帧跑了 59 秒
document.visibilityState !== 'visible' || !document.hasFocus()

// ✓ 加第三道**物理判据**：真实渲染再慢也不会慢到 6fps 以下
ms > 10000
```

顺带给 `nextFrames` 加了超时保护 —— 否则节流环境下验收会卡几十秒。

---

## 五、实测结果

### placeholder（静态包，覆盖全部能力）

```
✓ ② 3 个场景 / 6 个主体；每个场景都有背景（role 声明）+ 相机轨道
✓ ③ 滚过 1756px，章节从 0 推进到 1
✓ ④ 3 个对象在动，3 种互不相同的屏幕位移轨迹
✓ ⑤ z 6.44→4.20  y -0.25→0.10  roll ±0.0300
✓ ⑥ 双 RT 独立；扫过 11 个位置，8 个落在过渡区间内
· ⑦⑧ 静态包没有 build 钩子 —— 这条只对素材驱动的包有意义
✓ ⑩ parallax 倍率生效：fg ×1.4（实测 1.400）
✓ ⑪ damping 生效：场景 1 τ=0.12s（一帧后仍差 87%）
✓ ⑫ 材质已是 AdditiveBlending：mid
✓ ⑬ fg: t=0 → 显示，t=1 → 隐藏
✓ ⑭ fov 轨道：25.00°→22.27° / 24.00°→29.00° / 30.00°→24.00°
✓ ⑮ tint 着色正确：bg #8f9fd4、mid #c9a8ff、fg #6e5f9a
✓ ⑯ radial 与 sweep 两种模式都实际渲染过
✓ · 144.0 fps

13 通过 / 0 失败 / 3 跳过
```

### cats（素材驱动包）

```
7 通过 / 0 失败 / 9 跳过
```

两个包的 SKIP **互补**：placeholder 缺"素材驱动"（⑦⑧），cats 缺那些手写包才用的能力。
**合起来是全覆盖。**

### 验收 ①（构建期，独立脚本）

```
npm run verify:independence

移出 2 个包: cats, shopify
[1/3] typecheck      ✓ 没有任何静态 import 指向被移出的包
[2/3] 生产构建        ✓ 构建通过
[3/3] 产物残留检查    ✓ 产物里没有被移出包的任何内容
已恢复 2 个包: cats, shopify

✓ 验收 ① 通过
```

---

## 六、怎么用

```bash
# 构建期两项
npm run verify:independence      # ① 删除内容包后引擎仍可运行
npm run build-assets:check       # ⑨ 产物与 manifest 一致

# 运行时（浏览器）
?accept=1                        # 打开就跑
await __ACCEPTANCE__.run()       # 或控制台随时跑
```

**要全覆盖就跑两个包**：`?content=placeholder` 和 `?content=cats` 各跑一次。

---

## 七、修改的文件

| 文件 | 改动 |
|---|---|
| `src/content/placeholder/scenes.ts` | 补 4 项能力（parallax / damping / additive / visible）+ 9 处 `role` |
| `src/content/shopify/scenes.ts` | 补 8 处 `role` |
| `src/schema/object.ts` | `role` 的语义写清楚（是什么 ≠ 必须怎样；手写包也要声明） |
| `src/dev/acceptance.ts` | 新增 ⑩~⑯ 七项能力检查；修 4 个检查自身的 bug |
| `scripts/verify-independence.mjs` | **新建**。验收 ① 的自动化 |
| `package.json` | 加 `verify:independence` |
