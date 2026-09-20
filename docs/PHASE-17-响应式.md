# PHASE 17 —— 响应式（视口变化后重新构图）

> 之前的行为：`aspect` 只在页面加载时取一次，之后**再也不变**。
> 拖窄窗口 → 主体偏大、位置偏移、溢出屏幕。
>
> 现在：视口比例变化超过 4% 时，**重新构图并原地刷新布局**，纹理和材质全部复用。

---

## 一、为什么光调 `setSize` 不够

`Composer.setSize` 只做两件事：重建 RenderTarget、对每个场景调 `setAspect`。

而 `setAspect` 重算的是 `baseX/baseY` 和平面几何尺寸 —— 它用的 `overscan` 和 `offset`
是**构图阶段按当时的 aspect 算好的常量**。

视口从 21:9 变到 4:3 时：

```
fY = max(1, vpAspect/srcAspect)     从 1.55 掉到 1.0
→ 主体本该缩小 35%，但 overscan 还是旧值 → 主体偏大、位置也偏
```

实测：把 2.14 的视口缩到 1.21，`subject-01` 的 `overscan` 应该从 0.752 掉到 0.526，
不重新构图的话它会保持 0.752 —— 在窄视口下主体偏大 43%。

---

## 二、实现

### 2.1 `Composer.refreshLayout(configs, aspect): boolean`

把**重新构图后的 config** 原地写回 `BuiltScene`，再调 `setAspect`：

```ts
for (let i = 0; i < this.scenes.length; i++) {
  const built = this.scenes[i];
  const cfg = configs[i];
  // 结构不一致 → 返回 false，让调用方走整体重建
  if (cfg.id !== built.config.id || cfg.objects.length !== built.config.objects.length) return false;

  for (let j = 0; j < built.config.objects.length; j++) {
    objCfg.z = next.z;
    objCfg.overscan = next.overscan;
    objCfg.offset = next.offset;
    objCfg.fit = next.fit;
  }
  built.config.camera = cfg.camera;
  built.config.transition = cfg.transition;
  built.setAspect(aspect);          // ← 现在它读到的 overscan 已经是新的
}
```

**为什么是「刷新」而不是「重建」**：重建要重新 `loadAssets`（图片解码 200~500ms），
拖动窗口时会持续卡顿。这里只改几何参数。

**为什么返回 boolean**：结构不一致（场景数或对象数变了）说明内容本身变了，
那必须走整体重建。返回 `false` 让调用方决定，而不是在这里静默吞掉。

### 2.2 防抖 250ms + 4% 阈值

拖动窗口时 resize 以每秒几十次触发。每次都重新构图的话主线程一直在算，画面反而更卡。

```ts
if (Math.abs(nextAspect - composedAspect) / composedAspect < 0.04) return;
```

4% 的依据：主体屏幕尺寸的变化在 4% 以内肉眼看不出来，而重建几何是有成本的。

### 2.3 manifest 内存缓存

`build()` 不只页面加载时调一次，视口变化时也会调。每次都走 `loadManifest` 的话，
拖动窗口会连发几十个请求。

```ts
export async function loadManifestCached(url = MANIFEST_URL): Promise<ContentManifest>
```

缓存生命周期刻意定在**页面会话**：刷新即清空，所以
「重跑 build-assets → 刷新 → 换内容」这条工作流完全不受影响。

> 这也是它**不能**做成 HTTP 缓存的原因 —— `loadManifest` 用的是 `cache: 'no-cache'`，
> 本来就是要每次都拿最新的。

### 2.4 静态内容包自动跳过

```ts
const build = pack.build;
if (!build) return;      // 静态包的 scenes 是硬编码的，没有"重算"这回事
```

实测 `?content=placeholder` 从 1444×674 缩到 702×732，引擎存活、`drawSize` 正确更新、
控制台零 error / warn。

---

## 三、实测数据

四个视口，同一份 manifest。每个值都能用手算的公式复现 —— 这本身就是构图数学正确的证据。

| 渲染容器 | aspect | `subject-01` overscan | `subject-01` offset.x | scene02 overscan | scene02 z |
|---|---|---|---|---|---|
| 1444×674（初始宽屏） | 2.142 | 0.7518 | −0.1901 | 0.92 | −32 |
| 885×732（变窄） | 1.209 | **0.5264** | **−0.2359** | **0.7168** | **−14** |
| 1525×732（变回宽） | 2.083 | **0.7311** | −0.1901 | 0.92 | −32 |
| 487×732（竖屏） | 0.665 | 0.5264 | **−0.4290** | 0.7168 | −14 |

对账（`fY = max(1, aspect/1.5)`、`fX = max(1, 1.5/aspect)`）：

```
overscan = box.h × fY      0.5264 × 1.428 = 0.7518  ✓  (aspect 2.142)
                           0.5264 × 1.000 = 0.5264  ✓  (aspect 1.209)
offset.x = (cx − 0.5) × fX  (−0.1901) × 1.000 = −0.1901  ✓
                           (−0.1901) × 1.241 = −0.2359  ✓  (aspect 1.209)
                           (−0.1901) × 2.256 = −0.4290  ✓  (aspect 0.665)
```

`scene02` 的 `z` 在 −32 ↔ −14 之间摆动，是「大主体自动放远」在起作用：
窄视口下 `screenH` 降到 0.7168，解出的安全距离变成 18.9，
于是它从"被 `bgDist−2` 钳制的 38"变成"黄金比给的 20"。

**背景的 overscan 始终是 1.1346** —— 它只依赖 `camY` / `fov` / `bgDist`，都与 aspect 无关。这是对的。

---

## 四、已知限制

### 竖屏下横排主体会出界

源图 1.5（5 只猫横排），竖屏 0.665 时 `fX = 2.256` —— 横向放大 2.26 倍，
而 5 只猫在原图里横跨 91% 宽度，于是屏幕上的跨度变成 2.05 倍宽。**只能看到中间 3 只。**

这是 `cover` 语义的**几何必然**，不是 bug：

- 背景必须 cover 铺满（否则露黑边）
- 主体跟着背景的裁切比例走，才能"长在原处"
- 竖屏 + 横排源图 → 两侧被裁

**三条出路**（都不改引擎）：

1. **换一张更接近方形的源图** —— 最省事，也是这类项目最常见的选择
2. 给 `composeContent` 传自定义参数（`dist` / `maxSubjectH`）微调
3. 以后可以加一个可选的「横向收拢」策略：主体超出屏幕时按比例向中心压缩。
   默认关闭 —— 它会让主体与背景**错位**，只对无缝背景成立。

### 其他

- 4% 阈值意味着**小幅 resize 不会重新构图**。这是刻意的取舍（避免高频重算），
  但如果用户把窗口从 16:9 慢慢拖到 15:9，累计变化超过 4% 时会一次性补上。
- 只处理了视口**比例**变化。DPR 变化（拖到不同缩放比的显示器）走的是
  `setSize` 里已有的 `setPixelRatio`，不需要重新构图。

---

## 五、修改的文件

| 文件 | 改动 |
|---|---|
| `src/engine/Composer.ts` | 新增 `refreshLayout(configs, aspect): boolean` |
| `src/components/CanvasHost.tsx` | resize 加防抖 + 重新构图 + `clearTimeout` 清理 |
| `src/asset-pipeline/manifest.ts` | 新增 `loadManifestCached` / `invalidateManifestCache` |
| `src/content/cats/index.ts` | 改用带缓存的读取 |

引擎的构图数学（`compose.ts`）**一行没改** —— 它本来就是纯函数，重新构图只是再调一次。

---

## 六、下一步

PHASE 17 的 WebGL 侧完成。剩下的响应式工作在 DOM 层（章节文案的字号阶梯、导航点在小屏下的排布），
那是 CSS 的活，不影响 3D 构图。

按路线图，接下来应该做 **PHASE 11（里程碑验收）** —— 把
「五猫 → 滚动 → 相机推进 → 5 只猫独立位移 → Shader 转场 → 单猫定格」
这条链路固化成可重复执行的验收脚本，而不是每次手工点。
