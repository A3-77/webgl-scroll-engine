# 导演层改造 —— 仓库审计与迁移方案

> **状态：只审计，未改任何代码。** 等你确认 §3 的四个决策之后再动 Phase 1。
>
> 审计对象：`webgl-scroll-engine` @ `58f0429`（v0.7.0），
> 引擎 `src/` 共 **17 个目录 / 12,169 行**（不含测试）。

---

## 0. 一句话结论

**你的诊断是对的，但你的方案里有三处会和现有架构打架，必须先定。**

对的部分：现在确实是 `Scroll → Scene → 特效 → Scene`，缺一层"导演"。
但更准确的说法不是"抽象层级不够高"，而是 ——
**现在的时间轴是「每场景局部 0..1」，没有全局时间轴。**
所有上层抽象（Chapter / Sequence / Shot / 连续性）都建立在这一个地基上。
这一条不先解决，加多少层都只是给每个场景单独排节目。

---

## 1. 现状盘点：你点名的东西都在哪

| 你提到的 | 实际实现位置 | 行数 | 形态 |
|---|---|---|---|
| **Scroll** | `src/animation/scrollProgress.ts`<br>`src/animation/smoothScroll.ts`（Lenis）<br>`src/store/sectionStore.ts` | 182 / 94 / ~60 | 纯函数 + store。`ScrollState` 是引擎唯一入口 |
| **Timeline** | `src/schema/animation.ts`（`Track` / `Keyframe` / `Ease`）<br>`src/animation/timeline.ts`（`evaluateTracks`） | 115 / 97 | **多轨、多关键帧、逐帧缓动**已有 |
| **Scene** | `src/engine/systems/SceneManager.ts`<br>`src/engine/SceneBuilder.ts` | 174 / 529 | 集合生命周期 + 组装 |
| **Camera** | `src/engine/systems/CameraSystem.ts`<br>`src/animation/camera-moves.ts` | 177 / 378 | **PHASE 26 刚做完**：`target` / `lookAt` / `roll` / 六个命名运镜 |
| **Object** | `src/engine/systems/ObjectAnimationSystem.ts`<br>`src/animation/presets.ts` | 123 / 255 | 轨道驱动 position/scale/rotation/opacity/visible + **13 个预设** |
| **Transition** | `src/engine/systems/TransitionSystem.ts` | 309 | 双 RenderTarget 交叉溶解（阈值场，非透明度渐变） |
| **Asset** | `scripts/build-assets/`（Python）<br>`src/asset-pipeline/compose.ts` | ~2,000 / 979 | 分割 → 抠图 → 自动构图 |
| **Animation** | `src/animation/` | 1,006 | 时间轴求值 + 相机运镜 + 预设 + 滚动数学 |

**引擎已经有的、可以直接复用的 8 件事**（不是从零开始）：

1. `Track` / `Keyframe` / `Ease` + `evaluateTracks` —— **多轨多关键帧求值器，已存在**
2. `camera.move` 六个命名运镜 + `lookAt`/`target`/`roll`/`fov` —— **镜头编排能力，PHASE 26 刚建好**
3. 13 个对象预设（`float` / `drift` / `scatter` / `orbit` / `fadeIn` / `fadeOut` / `exitDown` …）
4. `ObjectAnimation` 的 `range: [start, end]` —— **stagger 已经能做到，只是没有"相对延迟"语义**
5. `evaluateTracks` 复用 `out` 对象零分配；`cameraTracksOf` 在构造/`syncConfig` 算一次 —— **性能纪律已建立**
6. `src/schema/` 契约层 + `verify:independence`（删掉任何内容包构建都必须通过）
7. 自动构图（主体检测 / 深度反解 / overscan 预算）
8. `?accept=1` 验收框架 + 265 个单测

**真正全新的只有 4 件事**：Shot/Sequence/Chapter 三级结构、Action DSL、跨镜头连续性、JSON 故事格式。

---

## 2. 逐项对照：你要的 vs 现状

| 你要的 | 现状 | 差距 |
|---|---|---|
| Experience / Chapter | `ScrollState.current.index` + `heights[]` | 有雏形，缺显式 Chapter 对象与"章节意图" |
| **Sequence / Shot** | ❌ 无 | **全新**（最核心的新抽象） |
| 多轨 / 多关键帧 / 不同 easing | ✅ `Track` + `Ease`（5 种） | 缺 `expo/circ/back/elastic/bounce/bezier/spline` |
| overlap / stagger / relative timing | ⚠️ `range: [start,end]` | 能错开，但没有"比上一个晚 0.15"的语义 |
| nested timeline / loop / scrub | ❌ | 全新（scrub 是 debug 面板的事） |
| Camera `position/rotation/lookAt/target/FOV/roll` | ✅ 全部有 | — |
| `dolly / orbit / zoom / follow` | ✅ 有（`dolly` `orbit` `crash`） | — |
| `truck / pedestal / pan / tilt` | ❌ | 缺，但都是"位移 + 朝向"的组合，加 builder 即可（每个 ~15 行） |
| **Camera Path / spline** | ❌ | **全新**（`sampleTrack` 是逐段线性/缓动，不是样条） |
| `shake` | ❌ | 全新（小，噪声驱动） |
| `focus / DOF` | ❌ | 全新，**且依赖后处理链支持** —— 现在没有 DOF pass |
| Object 独立 Timeline | ✅ `ObjectAnimation.tracks` | — |
| `enter / idle / exit` | ⚠️ 13 个预设覆盖了这些动作 | 缺**显式阶段**概念（现在是"写三条 range 不同的轨道"） |
| staggered animation | ⚠️ 靠 `range` 错开 | 同上，缺相对延迟 |
| **Action 系统** | ❌ | **全新**，但与预设高度重叠 —— 见 §4 建议 |
| **Event System** | ❌ | **全新，且与"可逆"冲突** —— 见 §3 冲突② |
| **Shot 连续性** | ❌ 场景间状态完全独立 | **全新，且有结构性障碍** —— 见 §3 冲突③ |
| Transition 降级为 Action | ⚠️ 已是"辅助"，但仍是独立系统 | 可以包装成 Action，但**不建议**真的塞进 Action 链 |
| 自动构图 | ✅ | 保留，与 Director 分工清楚 |
| Motion Presets | ✅ 13 个 | 扩充即可（加电影化动作） |
| **JSON Schema（Experience）** | ❌（现有 `manifest.json` 是素材清单，不是故事） | 全新 |
| Director Debug Panel | ⚠️ 有 `DebugHUD` + `acceptance.ts` | 缺"当前是谁在控制动画"的展示 + scrubber |
| **Camera Recorder / waypoint 导出** | ❌ | 全新（中） |
| 时间函数扩充 | ⚠️ 5 种 | 易扩展 |
| 性能（evaluate 不分配） | ✅ 纪律已建立 | 需保持 |
| 测试矩阵（15 项场景） | ⚠️ 265 单测 + 验收 | 缺"素材形态矩阵"与**向后滚动可逆**的自动化测试 |

---

## 3. ★ 四个必须先定的设计冲突

这一节是本次审计最重要的部分。**你的指令里有三处自相矛盾，照单全收会做出一个不能回滚的系统。**

### 冲突① `duration: 30`（秒）还是滚动单位？

你的 DSL 写：

```js
experience({ duration: 30, chapters: [...] })
```

但你在第二十二条写：

> Scroll 只是 Input。正确结构：Scroll → normalized progress → Experience Timeline → Director

**这两条不能同时成立。** 如果 `duration` 是秒，那时间自己在流走 ——
停下滚动画面会继续走完，滚动退化成 seek 条。这会直接破坏你在第二十六条的要求
（"向后滚动必须完全可逆"）：时间在流走时，"滚回去"和"时间倒流"是两件事，状态必然打架。

**我的建议**：`duration` 用**滚动单位**（vh 倍数），保持"画面是 scroll 的纯函数"这个不变量。
时间轴只驱动**活性层**（颗粒、呼吸、音频），不驱动叙事位置 —— 这正是现有引擎的做法
（`uTime` 只喂后处理与媒介层的颗粒）。

> 需要你拍板：**叙事位置 = f(滚动)** 还是 **f(时间)**？我强烈建议前者。

### 冲突② `at(progress, () => {...})` 回调 vs "完全可逆"

你要求：

```js
at(0.25, () => { camera.dolly(2) })
at(0.50, () => { object("cat02").scatter(...) })
```

同时要求（第二十六条）：

> 向后滚动必须完全可逆。不能动画状态错乱。不能重复触发 event。不能 scene 状态残留。

**回调式事件和"完全可逆"在数学上不相容**：

- 往回滚时这个回调要不要"反向执行"？回调是不可逆的副作用，没人知道怎么反。
- 快速滚动时一帧跨过 3 个 trigger，要触发几个？
- 拖动滚动条来回蹭，会不会重复触发？

参考站点自己就是这么处理的 —— `portfolio/lib/beats.ts` 的 `BeatRunner` 有
"越过 trigger 触发一次 + hysteresis 回退重臂 + reducedMotion 跳过"这套机制，
**但它的 beats 全部是音频**。**视觉状态全部是 `f(t)` 纯函数。**

**我的建议**：把 `at()` 拆成两个语义不同的 API：

| API | 形态 | 可逆 | 用途 |
|---|---|---|---|
| `keyframe(progress, state)` | 声明式、绝对 | ✅ | **一切视觉** |
| `onEnter(progress, cb)` | 回调、边沿触发 | ❌（明确声明） | **只用于非视觉**：音频、埋点 |

即：**视觉不许用回调。** 想"在 0.5 处猫散开"，就写 0.5 处猫的位置关键帧，而不是回调。
这一条守住了，第二十六条才可能满足。

### 冲突③ 跨场景连续性有**结构性障碍**

你要求：

> Scene02 的单猫从之前的运动状态自然出现。Shot 是时间分段，不是状态重置。

**现状做不到，而且不是加代码就能做到的**：

- 每个场景是**独立的 `THREE.Scene`**（`SceneBuilder.buildScene` 里 `new THREE.Scene()`）
- scene01 的 5 只猫 与 scene02 的 1 只猫是**不同的 `Object3D`、不同的贴图**
- 它们分属两个场景图，各自有独立的 `CameraSystem` 实例与独立的平滑缓存

所以"同一只猫延续过去"在结构上不存在 —— 那两个对象根本不是同一个东西。

三条路：

| 方案 | 做法 | 代价 | 效果 |
|---|---|---|---|
| **A. 单场景** | 一个 `THREE.Scene`，章节只是相机/可见性分段 | **大**（拆掉双场景过渡，TransitionSystem 要重做） | 最接近你要的"连续电影" |
| **B. handoff** | 保留双场景，过渡期把 A 的某对象位姿交给 B 的同 id 对象 | 中 | 观感连续，实现可控 |
| **C. 只做视觉连续** | A 的猫在过渡期继续按轨迹动，B 的猫按**同一条轨迹**出现 | 小 | 能骗过眼睛，但不是真的同一个对象 |

**我的建议：B + C 混合。** 先在 schema 里引入**跨场景稳定 id**（`object.key`），
过渡期做 handoff；不做 handoff 的对象退回 C。
A 方案的收益/代价比在现阶段不划算 —— 它会把已经验证过的过渡系统整个推翻。

> 需要你拍板：**要不要真的"同一只猫"**，还是"看起来连续"就够？

### 冲突④ 目录重构会打破契约层

你给的目录结构（`src/core/` `src/camera/` `src/director/` `src/objects/` `src/scene/` `src/scroll/` …）
会**拆散现在唯一的契约层 `src/schema/`**，而 `verify:independence`
（删掉任何内容包后构建必须通过）依赖这个边界。

**我的建议：新代码进现有布局，不搬迁已有文件。**

```
src/schema/director.ts          ← 新契约（Experience/Chapter/Sequence/Shot/Action）
src/animation/easing.ts         ← 扩充缓动表
src/animation/actions.ts        ← ActionSpec → Track[]（纯函数）
src/animation/shots.ts          ← Shot → 局部时间映射
src/engine/systems/DirectorSystem.ts  ← evaluate(progress) → DirectorState
src/dev/DirectorPanel.tsx       ← 调试面板 + scrubber
```

理由：`src/engine/systems/` 这个布局是 PHASE 4~9 拆分的产物，
每个 System 的职责边界都写过文档、有测试。为了对齐一份目录树去搬 5,229 行引擎代码，
收益是"看起来更像架构图"，代价是全部回归测试重新过一遍。

---

## 4. 我建议改掉的两处设计

### 4.1 Action 系统和现有预设高度重叠 —— 不要做两套

你要的：

```js
action.move("cat01", { from: [-3,0,0], to: [0,0,0], duration: 0.3 })
```

现有预设已经在做同一件事，而且已经解决了一个你会踩到的坑：
**预设会被展开成 `Track[]`，所以引擎只认识轨道一种形态**（`schema/animation.ts` 的原话：
"预设是内容侧的糖"）。

**建议：Action 就是"更通用的预设"。** 同一个展开机制，签名从
`preset: 'scatter'` 扩成 `{ action: 'move', target, from, to, at, duration, easing }`。
产出仍然是 `Track[]`。**引擎侧一行都不用改** —— 这是现有架构送的一份礼物，别浪费。

### 4.2 Transition 不必"降级成 Action"

你要求 `Transition ≠ Animation`、Transition 只能是 Action 的一种。
**方向对，但别真的塞进 Action 链。**

过渡是两个场景之间的**双缓冲合成**，它需要两张 RenderTarget、一个阈值场 shader、
以及"两张图同时在动"的前提。把它降级成一条普通 Action 轨道，
会让 `TransitionSystem` 的所有权和生命周期变得含糊，而它现在是最不该动的部分
（PHASE 23 花了 465 行文档才把它做对）。

**建议：保持独立系统，只把它在 Director 里降级为"一个 Shot 的收尾动作"** ——
即 Director 决定"什么时候开始过渡"，但过渡内部仍然由 TransitionSystem 全权负责。

---

## 5. 迁移方案（9 个阶段，把 demo 提前）

**和你给的 15 阶段最大的不同：把"5猫→1猫 demo"从 Phase 13 提到 Phase 5。**

理由：demo 是**唯一的判据**。如果在做完 12 层抽象之后才发现抽象错了，
返工成本是全量的；如果 Phase 5 就做出来，后面 4 个阶段都是在**已知能跑通**的地基上加东西。

| 阶段 | 内容 | 产出（可验证） | 预估改动 |
|---|---|---|---|
| **P0** | 你回答 §3 的四个问题 | 决策记录 | — |
| **P1** | **全局时间轴**：新增 `experienceProgress()`，把"每场景局部 0..1"提升为"跨全部章节的全局 0..1" | 一个数字，加单测 | `scrollProgress.ts` +~30 行 |
| **P2** | **Director 骨架**：Chapter/Sequence/Shot 三级 + `evaluate(progress) → DirectorState`。**先只驱动相机** | 一个场景内能声明 5 个镜头并真的按顺序演 | 新 3 文件 + `Composer.ts` 改 ~40 行 |
| **P3** | **Shot 连续性 + 对象生命周期**：enter/idle/exit 全部表达成**绝对 `f(t)`**；跨 shot 不重置 | 向后滚动可逆的自动化测试 | `shots.ts` 扩充 |
| **P4** | **Action DSL**：`action.move/rotate/scale/fade/orbit/scatter` → 展开成 `Track[]`（复用预设机制） | DSL 真能驱动引擎（不是 demo API） | `actions.ts` + 测试 |
| **P5** | ★ **5猫→1猫 20 秒 demo**（按你 §18 的 8 段编排） | **验收点：不出现"一个 transition 连接两个场景"的感觉** | 内容侧为主 |
| **P6** | **JSON Schema**：Experience 可存成 JSON、可加载 | 同一份 JSON 驱动 demo | `schema/director.ts` 导出 |
| **P7** | **Director Debug Panel + scrubber** | 面板显示"当前是谁在控制动画" | 新 1 文件 |
| **P8** | **Camera Path/spline + Recorder**（waypoint 录制 → 导出 JSON） | 录一条路径能重放 | 新 2 文件 |
| **P9** | **场景矩阵测试**（5→1 / 1→5 / 竖图 / 横图 / 透明 PNG / GLB / 混合 / 3 章 / 10 章 / 移动端 / 慢滚 / 快滚 / **向后滚** / 跳滚） | 测试报告 | `acceptance.ts` 扩充 |

每个阶段结束都跑：`npm test` + `npm run typecheck` + `npm run build`（+ `verify:independence`）。

---

## 6. 具体文件改动清单

### 新增（P1~P5 必需）

```
src/schema/director.ts              契约：ExperienceConfig / ChapterConfig /
                                    SequenceConfig / ShotConfig / ActionSpec / DirectorState
src/animation/easing.ts             扩充缓动：expo / circ / back / elastic / bounce /
                                    bezier / catmullRom（现有 5 种 → 12 种）
src/animation/actions.ts            ActionSpec → Track[]（纯函数，零运行时依赖）
src/animation/shots.ts              Shot 的局部时间映射 + 绝对状态求值
src/engine/systems/DirectorSystem.ts  evaluate(progress) → DirectorState（轻量、不分配）
```

### 修改（最小侵入）

| 文件 | 改什么 | 为什么 |
|---|---|---|
| `src/animation/scrollProgress.ts` | 新增 `experienceProgress()` | P1 的地基 |
| `src/schema/scene.ts` | `SceneConfig` 可选加 `shots?: ShotConfig[]` | **可选字段 ⇒ 老内容包零影响** |
| `src/engine/Composer.ts` | 用 `DirectorSystem` 的结果替代直接 resolve | 唯一装配点 |
| `src/engine/SceneBuilder.ts` | `applyTime` 接受 DirectorState | 不再自己求值 |
| `src/content/types.ts` | 内容包可声明 `experience` | 内容侧入口 |
| `src/dev/acceptance.ts` | 加"连续运动"与"向后滚动可逆"验收项 | P9 |

### 明确**不动**

`TransitionSystem` / `MediumSystem` / `PostSystem` / `CarrierSystem` / `AudioSystem` /
`loaders.ts` / `asset-pipeline/` / `shaders/` / `components/` / `store/` / 全部现有测试。

---

## 7. 关于你最后提的 AI Story Generator

> 给 AI 10 张产品图，生成 `Chapter → Sequence → Shot → Action` 的故事脚本

**这件事的前提正是 P6（JSON Schema）。** 一旦故事是 JSON，
"AI 生成故事"就退化成"AI 生成一份符合 schema 的 JSON" —— 那时才真正可做。

顺序反过来的话（先做生成器），AI 只能输出它自己都无法验证的结构，
而引擎也吃不下 —— 会变成一堆 demo API。

**所以 P6 是这件事的门槛，不是可选项。**

---

## 8. 需要你回答的四个问题

1. **叙事位置 = f(滚动) 还是 f(时间)？** 我建议 `f(滚动)`，`duration` 用 vh 倍数。
2. **视觉允许用回调式事件吗？** 我建议**不允许**（回调只给音频/埋点），否则"完全可逆"做不到。
3. **要不要真的"同一只猫"？** 还是"看起来连续"就够？我建议 handoff + 视觉连续混合。
4. **接受"新代码进现有布局、不搬迁已有文件"吗？** 我建议接受。

回答完这四条，我按 P1 开始，每阶段跑完门禁再进下一阶段。
