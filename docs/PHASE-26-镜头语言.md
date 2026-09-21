# PHASE 26 —— 镜头语言（让镜头会「看」，而不是平移一张图）

> **一句话**：`camera.move` 声明「这一章怎么拍」，引擎把它展开成轨道。
> 改造前相机永远朝 −Z 看，能做的只有"把画面平移一段距离"——
> 这才是"像图片转场"的根因，加多少缓动、阻尼、视差都救不回来。

---

## 1. 为什么需要它：一次方向纠正

用户在 PHASE 25 之后说了一句把方向掰回来的话：

> "我不是让你去换滤镜  你懂吗你看看他们的动画顺滑又有创意"

前几轮的应对都错了。原始批评是"shader.se / iamsaeed.dev 怎么做，你的只是单纯图片转场了"，
而我的反应是**加视觉**：PHASE 18 加后处理链、PHASE 23 加 3D 过渡载体、
PHASE 25 加媒介层（网点 / 墨线 / 纸纹）。

媒介层本身没问题，但它不是用户要的东西。**用户要的是"动画"——运动。**
两个参考站点看起来高级，一半靠材质，另一半靠**镜头怎么动**。
我做了前一半，一直没碰后一半。

---

## 2. 根因：相机没有 `target`

翻完两个参考仓库的源码之后，差距收窄到**一个字段**。

### 2.1 本引擎改造前的相机

`CameraConfig` 只有：

```
z / fov / tracks(position.x, position.y, position.z, rotation.z)
```

也就是说：镜头**永远朝着 −Z 方向看**，唯一的自由度是"往哪平移"和"滚转多少"。
真实摄影机的运动不是平移，是**围绕一个被摄体运动**：

- 推近（dolly in）时主体在画面里**保持不动**、背景向外散开
- 绕行（orbit）时主体**始终留在构图里**，是背景在流动
- 甩镜头（whip）是"有人把镜头甩过去了"，不是"画面往旁边滑"

没有 `target`，这三件事**一件都做不出来**。所以不管叠多少缓动，
观感都是"一张图在滑动"。

### 2.2 两个参考站点都有这一项，而且都是核心

**iamsaeed.dev**（`portfolio/lib/shots.ts`）—— 镜头姿态的第一性定义：

```ts
export interface Pose {
  position: Vec3;
  target: Vec3;
  /** radians around the view axis (dutch) */
  roll?: number;
  fov?: number;
}

export type ShotKind = "hold" | "dolly" | "orbit" | "crash" | "whip" | "spline";
```

`portfolio/lib/authoredCamera.ts` —— 怎么把 Pose 变成一个相机：

```ts
cam.fov = pose.fov ?? 45;
cam.aspect = aspect;
cam.updateProjectionMatrix();
cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
if (pose.roll) cam.rotateZ(pose.roll);
```

`portfolio/components/ShotDirector.tsx` —— **目标本身也做阻尼，和位置分开平滑**：

```ts
// small lerp smoothing within a segment, hard snap across segments (cuts)
const snap = lastSegment.current !== sample.segment;
lastSegment.current = sample.segment;
if (snap) {
  sp.copy(pos.current);
  smoothedTgt.current.copy(tgt.current);
} else {
  const k = 1 - Math.exp(-14 * delta);
  sp.lerp(pos.current, k);
  smoothedTgt.current.lerp(tgt.current, k);   // ★ 目标独立平滑
}

camera.position.copy(sp);
camera.lookAt(smoothedTgt.current);            // ★ 会看
if (sample.pose.roll) camera.rotateZ(sample.pose.roll);
const fov = sample.pose.fov ?? 45;             // ★ fov 是绝对值
if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
```

**shader.se**（`skyworks`）—— 20 架飞机各自：

```js
plane.lookAt(position + direction);   // 朝向对齐前进方向
```

### 2.3 归纳

| | 参考站点 | 本引擎改造前 |
|---|---|---|
| 相机有 `target` | ✅ 位置与目标**各自独立平滑** | ❌ 只有 position |
| `fov` 是绝对值 | ✅ `pose.fov ?? 45` | ⚠️ 轨道值直接赋值 |
| `roll` 绕视线轴 | ✅ `lookAt` 之后 `rotateZ` | ⚠️ 写欧拉角 `rotation.z` |
| 运镜有**名字** | ✅ `ShotKind` 六种 | ❌ 每章同一套动作 |
| 指针只作用在定型镜头 | ✅ `transition === null && hold\|dolly` | ❌ 无条件叠加 |

本引擎的 `CameraSystem.apply` 现在与上面那段 `ShotDirector` **逐行对应**。

---

## 3. 架构：契约 / 展开器 / 引擎 / 自动构图

依赖方向不变 —— `schema` 是唯一契约层，引擎不认识内容。

```
schema/scene.ts            CameraConfig 新增 target / move
      │                    + cameraTracksOf() / cameraHasTarget()（展开点）
      ▼
animation/camera-moves.ts  纯函数：CameraMoveSpec → Track[]
      │                    六个 builder，零运行时依赖
      ▼
engine/systems/CameraSystem.ts   消费：lookAt 分支 + 缓存清理
      │
      ▼
asset-pipeline/compose.ts  自动构图：给每章分配运镜 + 预算回路
```

### 3.1 为什么"命名"比"让内容自己写轨道"更好

改造前的自动构图每章都是**同一套动作**（推进 + 上下平移 + 微滚转），
只是参数不同。有了 `ShotKind` 之后，"这一章怎么拍"才是一个**可做的决定**：

```ts
const MOVE_CYCLE: readonly CameraMoveKind[] =
  ['dolly', 'orbit', 'rise', 'hold', 'crash', 'whip'];
```

顺序是刻意排的 —— 最少章节（2 章）也能拿到表现力最强的两个
（`dolly` + `orbit`），而不是两个都像"轻轻晃一下"。

### 3.2 零行为变更契约

`cameraTracksOf()` 在 `move` 不存在时**原样返回 `cam.tracks`**（零分配）：

```ts
export function cameraTracksOf(cam: CameraConfig): Track[] {
  const move = cam.move;
  if (!move) return cam.tracks;        // 零行为变更
  ...
}
```

`cameraHasTarget()` 同样：不声明 `target`、`move`，且轨道里没有 `target.*` 时，
`CameraSystem` 走**原来的分支**（只写 `position` + `rotation.z`），逐位相同。

---

## 4. 六个运镜

全部在 `src/animation/camera-moves.ts`。幅度单位见 §5 纪律①。

| kind | 做什么 | 横向幅度 | 推近 | 其他 |
|---|---|---|---|---|
| `hold` | 定住，只呼吸 | x 往返 `0.015·frame`（中点最远） | `approach·0.35` | y 呼吸；**出去再回来** |
| `dolly` | 直推近 | — | `approach·intensity` | ★ **不受 `dir` 影响**，永远推近 |
| `orbit` | 绕主体转 18° | 弧长 18°，8 段非均匀采样 | — | 目标不动 ⇒ 构图稳定，背景自己流动 |
| `whip` | 甩镜头 | x `±0.12·frame`，**目标再扫 `±0.22·frame`** | — | `roll ±0.030·dir` |
| `crash` | 冲进去 | — | `approach·intensity`，`easeOutCubic` | `fov` 绝对值 `[fov] → [fov − 4·intensity]` |
| `rise` | 抬升 + 俯角 | y `±0.09·frame` | `approach·0.3` | `target.y` 反向小量（俯角）；`roll ±0.010·dir` |

**`whip` 的关键在"目标也跟着扫"**：只扫相机不扫目标，读到的是"平移"；
目标一起扫，读到的才是"有人把镜头甩过去了"。这是转场感的来源。

---

## 5. 三条实现纪律（都踩过）

### ① 横向幅度必须写成「主体处视口高度的比例」

第一版 `hold` 用 `0.010 × distance`、`whip` 用 `0.30 × distance`（世界单位 / 距离比例）。
结果：**镜头推近之后主体被晃出画面**（实测宽高比 2.234 下 overscan 需求 2.65）。

正确单位是**主体所在深度处的视口高度**：

```ts
frame = 2 * Math.tan((fov * Math.PI) / 180 / 2) * distance;
```

这才是观感的自然单位 —— 同一个 `0.12·frame` 在推近前后**看起来一样大**。

### ② 曲线路径用「非均匀采样 + `linear` 段」，不要「均匀采样 + 逐段缓动」

`sampleTrack` 是**逐段**取缓动的。给 `orbit` 的 8 段每段标 `easeInOut`，
会在每段两端各减速一次 —— **一条弧被切成 8 次起停**，非常明显。

正确做法：让 `u → easeInOut(u)` 决定**采样位置**，段间用 `linear`：

```ts
for (let i = 0; i <= samples; i++) {
  const u = i / samples;
  const e = easeInOut(u);                     // ★ 缓动决定采样位置
  const theta = -arc / 2 + arc * e;
  xs.push([u, subject[0] + Math.sin(theta) * distance, 'linear']);  // ★ 段间 linear
}
```

### ③ 推近量受构图预算约束，运镜不能自由发挥

自动构图**反解主体深度**，保证 `screenH × d/(d + dolly) ≤ maxScreenH`。
运镜自己推得更近会把主体顶出画面。所以：

- **推多近**由构图决定（`approach`）
- **怎么推**由运镜决定

`dolly` 与 `crash` **共用同一个预算**（有测试锁定），`crash` 的"冲"感来自
`easeOutCubic` 与 fov 收窄，不是推得更远。

---

## 6. `look` ≠ `subject`，以及 `lookBlend = 0.45` 的来历

### 6.1 问题：让镜头把主体摆到画面正中央，代价是什么

`orbit` 绕的是 `subject`，看向的可以是另一个点。第一版让
`look = subject`（把偏心主体摆到画面正中），代价立刻出现：

**平坦背景板必须等比放大才不露边，而且这个需求和运镜幅度无关。**

实测（cats 包 / aspect 2.234 / 主体偏轴 8°）：**静态就需 overscan 1.52**，超预算 1.45。

更糟的是预算回路的反应 —— `whip` 的 need 曲线是 `need(0) = 1.33 → need(1) = 1.56`，
**intensity = 0 就超预算**，回路把 intensity 压到 0.017，画面仍报 overscan 1.89。
根因**不是幅度，是"看向主体"这个动作本身的旋转量**。

### 6.2 解法：给一个折中点

```ts
function composeLook(subjectWorld, blend): [number, number, number] {
  const k = Math.min(Math.max(blend, 0), 1);
  const axis: [number, number, number] = [0, 0, subjectWorld[2]];
  return [axis[0] + (subjectWorld[0] - axis[0]) * k,
          axis[1] + (subjectWorld[1] - axis[1]) * k,
          axis[2]];
}
```

`lookBlend` 默认 **0.45** —— 视线落在"轴线 → 主体"的 45% 处。

**实测收益**：overscan 需求 **1.52 → 1.19**，所有运镜强度回到 1。
而且构图**更好看** —— 主体留在三分线附近，比死钉在正中央更像摄影。

> 教训：`look` 和 `subject` 分开是必要的。前者是"取景"，后者是"运动中心"，
> 把它们绑在一起等于让构图给运动让路。

---

## 7. 背景 overscan：从闭式公式改成数值扫描

改造前是闭式公式（只考虑相机 `position.z` 的推进）。
现在相机有了 `lookAt` 基向量与 `roll`，闭式公式**不可能**跟上。

`overscanForCamera(camera, bgZ, aspect, samples = 32)` —— 按 t 采样相机位姿，
把屏幕四角**反投影**到背景平面，取最大超出量：

```ts
for (let i = 0; i <= samples; i++) {
  evaluateTracks(tracks, i / samples, out);
  // 相机 z 轴 = 相机 − 目标（three 的 lookAt 让 −z 指向目标）
  // x = normalize(up × z)，y = z × x
  // roll 在相机空间里反向转
  for (const [nx, ny] of CORNERS) {
    ... 反投影 → need = max(need, |x|/halfW, |y|/halfH)
  }
}
```

**任何新运镜自动正确** —— 加一个 `spline` 不需要改 overscan 代码。

---

## 8. 预算回路

`overscanForCamera` 给出"要多大"，`bgOverscanMax`（默认 1.45）是预算。
超了就压 intensity：

```ts
let camera = build(1);
let need = overscanForCamera(camera, bgZ, aspect);
for (let attempt = 0; attempt < 5 && need > bgOverscanMax; attempt++) {
  const scale = (bgOverscanMax - 1) / Math.max(need - 1, 1e-6);
  camera = build(Math.max((camera.move?.intensity ?? 1) * scale * 0.98, 0));
  need = overscanForCamera(camera, bgZ, aspect);
}
```

`× 0.98` 是**阻尼**：`need` 是 32 个采样点上的最大值，intensity 一变
极值点会挪位置 —— 不阻尼会在预算上下横跳。

---

## 9. ★ 指针视差的两道门控

参考站点的原文规则（`ShotDirector.tsx`）：

```js
// pointer parallax: only inside settled shots, never in gutters/beats
const parallaxOk = !reducedMotion && sample.transition === null &&
  (sample.shotKind === "hold" || sample.shotKind === "dolly");
```

本引擎把 `reducedMotion` 折进了 `pointerSystem.enabled`（见 `schema/pointer.ts`），
剩下两条落在 `SceneBuilder`：

| 门控 | 本引擎的实现 | 为什么 |
|---|---|---|
| `shotKind is hold\|dolly` | `config.camera.move?.kind` 现算 | 镜头自己在飞时（orbit/whip/crash/rise）**不再叠**指针位移 —— 两股运动同向叠加会让画面"发毛"：镜头转 18° 的同时指针再推 2°，读到的不是"有创意"而是"抖" |
| `transition === null` | `setSettled()`，Composer 每帧告知 | 过场中两个场景同时在渲染，指针会把它们朝**同一方向**推 ⇒ 溶解边界上出现错位 |

**零行为变更**：没有声明 `move` 的旧内容包返回 `true`，
与 PHASE 26 之前逐位一致（那时指针就是唯一的环境运动）。

⚠️ 门控用**函数**现算，不是构建时算一次的常量 —— `applyCameraConfig` 会换掉整个
camera 配置，算一次的常量会立刻变成陈旧值。**这正是 PHASE 26 反复踩到的同一类 bug。**

---

## 10. 实测验证

### 10.1 静态检查

```
npm run typecheck        → 0 error
npx vitest run           → 265 / 265（13 个文件）
npm run verify:independence → 通过
```

新增测试：
- `src/animation/camera-moves.test.ts`（22）—— 六种运镜的形状、`intensity: 0` 真退化、
  幅度随距离/fov 的**屏幕占比不变**、`look ≠ subject`、`dir` 镜像
- `src/engine/systems/CameraSystem.test.ts`（10 → 18）—— 会看 / 不会看两条分支、
  `roll` 在 `lookAt` 之后、**零行为变更**、`target` 与 `position` 各自独立平滑
- `src/engine/SceneBuilder.test.ts`（新，10）—— 指针门控
- `src/asset-pipeline/compose.test.ts`（29 → 30）—— 每章声明一种运镜、
  `lookBlend` 是"看多准"的旋钮、overscan 覆盖整段运镜且不超预算

### 10.2 浏览器实测：六个运镜的位姿

把六个运镜逐个换到**同一个真实场景**上量取位姿（真实引擎路径）：

| kind | x 行程 | y 行程 | z 行程 | 视线摆动 | fov |
|---|---|---|---|---|---|
| `hold` | 0.23 | 0.15 | 2.10 | 0.7° | 32° |
| `crash` | 0 | 0 | 6.00 | 0.2° | **28°~32°** |
| `rise` | 0 | 2.75 | 1.80 | 7.7° | 32° |
| `dolly` | 0 | 0 | 6.00 | 0.2° | 32° |
| `orbit` | **11.89** | 0 | 0.33 | **18.0°** | 32° |
| `whip` | 3.66 | 0 | 0 | 6.6° | 32° |

**视线摆动**是"相机真的会看"的直接证据 —— 只量位置行程测不出 pan/tilt。

### 10.3 指针门控（真实引擎路径）

指针推到右上角（`value = [1, -1]`，偏移 0.0735 世界单位 ≈ ±2°）：

| 场景 | 运镜 | `settled = true` | `settled = false` | 门控 |
|---|---|---|---|---|
| scene01 | `dolly` | x = 0.0735 / 0.0367 | 0 / 0 | ✅ 吃指针 |
| scene02 | `orbit` | x = 8.5188 / 2.5743 | **完全相同** | ✅ 不吃指针 |

### 10.4 端到端验收

`?accept=1` / `__ACCEPTANCE__.run()` → **9 PASS / 0 FAIL / 8 SKIP**，
帧率 **143.9 fps**（SKIP 全是"当前内容包没用到该能力"）。

新增 **⑰ 运行时替换运镜** —— 走的是和 `Composer.refreshLayout`（改窗口大小触发
重新构图）**完全同一条**真实路径：`SceneBuilder.applyCameraConfig` → `CameraSystem.syncConfig`。

这一项不是设计出来的，是**实测踩出来的**，见 §11.2。

### 10.5 多宽高比扫描

aspect 2.234 / 1.778 / 1.0 / 0.6 下，所有运镜 intensity 都是 1
（只有 `whip` 在窄视口被压到 0.54 / 0.017），overscan 落在 1.05~1.48。

---

## 11. 两个真 bug（都不是"设计"，是踩出来的）

### 11.1 `evaluateTracks` 只写不删 → `crash` 的 fov 泄漏到 `rise`

`evaluateTracks(tracks, t, out)` **复用 `out` 对象**以避免每帧分配 ——
所以它**只写不删**。换过 config 之后，旧路径会永远留在缓存里继续被读。

实测现象：逐个换运镜时 `crash`（收窄到 28°）之后换成 `rise`，
`rise` **没有 fov 轨道**却一直停在 28° —— 画面窄了一圈而没有任何东西解释它。

修复在 `CameraSystem.syncConfig`：丢掉**新轨道不再产生**的键，
但**保留仍然存在的**（那部分要继续吃阻尼，全清掉会让重新构图时相机跳一下）。

```ts
const live = new Set(this.tracks.map((t) => t.path));
for (const key of Object.keys(this.raw)) {
  if (!live.has(key)) { delete this.raw[key]; delete this.smooth[key]; }
}
```

### 11.2 验收 ④⑤⑥ 从 v0.1.0 起一直 FAIL

`acceptance.ts` 读 `composer.scenes` / `composer.rtCurrent` / `composer.transitionQuad`，
而 PHASE 4~9 的模块化拆分把它们搬进了 `sceneManager` / `transition`。
它们只表现为"某项 FAIL"，非常容易被当成"功能坏了"。

修复：新增 `internals(e)` **白盒适配层**，把所有私有访问收敛到一处 ——
下次再重构只需要改这一处。修复后 **3 PASS / 5 FAIL → 8 PASS / 0 FAIL**。

同时把 `checkCamera`（⑤）重写为量**整段行程**（`max − min` over 25 个采样点）
而不是首尾差值 —— `hold` 是"出去再回来"，首尾差值恒为 0，
老写法会报"相机 y 只走了 0.00 个单位"而实际上相机一直在动。

---

## 12. 已知限制（诚实声明）

### 12.1 ★ 阻尼没有"段边界"，切不干净

参考站点的阻尼是**分段**的：

```js
// small lerp smoothing within a segment, hard snap across segments (cuts)
const snap = lastSegment.current !== sample.segment;
if (snap) { sp.copy(pos.current); smoothedTgt.current.copy(tgt.current); }
else { ... lerp ... }
```

段内平滑、**段间硬切**。本引擎的 `damping` 是**全局一阶低通**，没有段的概念 ——
如果内容作者在某条轨道里写了一个硬跳（等价于一个 cut），阻尼会把它**糊成一段滑动**。

**跨场景**不受影响：每个场景有独立的 `CameraSystem` 实例，
`syncConfig`/首帧时 `smooth[key] === undefined → = raw[key]`，天然是硬切。

**要修的话**：给 keyframe 加一个 `snap?: boolean` 标志，
`evaluateTracks` 返回"本帧是否踩在 snap 点上"，`CameraSystem` 见到就重置 `smooth`。
位置在 `src/engine/systems/CameraSystem.ts` 的 `apply()`。

### 12.2 `fov` 轨道是绝对值，内容要自己算

`CameraSystem` 直接 `camera.fov = smooth.fov ?? config.fov`。
所以运镜想收窄视野必须自己算绝对值（`crash` 写的是 `[fov] → [fov − 4·intensity]`）。
这是刻意的 —— 参考站点也是 `pose.fov ?? 45`。

### 12.3 自动构图的 `lookBlend` 是全局常量

`lookBlend` 目前只有一个全局默认值 0.45，不能按章节调。
如果某章的构图特别依赖主体居中，会需要按章覆写 —— 现在只能靠手写 `camera.target`。

### 12.4 仍然挂着的旧缺陷（与 PHASE 26 无关）

- **`position.x` 的位移单位与文档不一致** —— `SceneBuilder.setAspect()` 里
  故意没调 `objectSystem.setAspect(next)`，所以横向幅度是设计值的 `1/aspect`。
  一行修复位置已标在代码注释里，代价是横向幅度变成 aspect 倍，需重新过观感。
- **背景 64px 补洞块状痕迹** —— 素材流水线的既有缺陷（PHASE 25 排查确认与媒介层无关）。
- **ASCII 媒介** —— 需要字形图集，不在两个站点的交集里。

---

## 13. 怎么用

### 内容包：声明一个运镜

```ts
camera: {
  z: 6,
  fov: 32,
  tracks: [],
  target: [0, -0.2, -20.6],          // 看向哪（不写也行，move 会自己发 target.*）
  move: {
    kind: 'orbit',                    // hold | dolly | orbit | whip | crash | rise
    subject: [0.6, -0.4, -20.6],      // 绕谁转（orbit 的弧心）
    look: [0.3, -0.2, -20.6],         // 看向哪（可以和 subject 不同）
    intensity: 1,                     // 0 = 退化成静止（但依然 lookAt）
    approach: 6,                      // 最大推近量（世界单位）
    dir: 1,                           // 相邻章交替镜像
  },
}
```

也可以手写 `target.*` 轨道（不用 `move`）—— 那时 `cameraHasTarget()` 靠轨道判定。

### 内容包：打开指针视差

```ts
import { POINTER_PARALLAX } from '../schema';

site: {
  pointer: POINTER_PARALLAX,   // enabled / 0.035 / [0.35, 0.25] / damping 0.12
}
```

### 引擎侧：调试

- `?accept=1` 或 `__ACCEPTANCE__.run()` —— 含 ⑰ 运行时换运镜的位姿表
- `overscanForCamera(camera, bgZ, aspect)` 是 export 的，可以直接算某个运镜的 overscan 需求

---

## 14. 这一轮的教训

**"效果"是一个会骗人的词。**

我把它读成"视觉质感"，于是做了三轮材质；用户说的是"运动"。
判据其实一直摆在眼前 —— 用户原话是"他们的**动画**顺滑又有创意"，
而我盯着"效果"两个字。

下次遇到"他们的效果更好"，先问一句：**好在哪里 —— 是画面长什么样，还是画面怎么动？**
这两个方向的实现没有任何重叠，做错方向等于白做三轮。
