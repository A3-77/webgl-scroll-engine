# PHASE 4~9 —— 引擎模块化拆分

> 状态：✅ 完成 · 119 个测试 · typecheck · build · 浏览器烟测全过

## 一、为什么拆

之前的 `Composer.ts`（467 行）和 `SceneBuilder.ts`（456 行）各承担了多个系统的职责：

| PHASE | 系统 | 拆分前在哪 | 拆分后 |
|---|---|---|---|
| 4 | 场景管理 | `Composer.scenes[]` + `scenes[i]` 直接索引 | `engine/systems/SceneManager.ts` |
| 5 | 相机 | `SceneBuilder.applyTime` 前半段 | `engine/systems/CameraSystem.ts` |
| 6 | 视差 | `SceneBuilder.applyTime` 中间 3 行 | `engine/systems/ParallaxSystem.ts` |
| 7 | 对象动效 | `SceneBuilder.applyTime` 后半段 | `engine/systems/ObjectAnimationSystem.ts` |
| 8 | 过渡 | `Composer.render` ③ 步 | `engine/systems/TransitionSystem.ts` |
| 9 | Bloom | `Composer.render` ⑤⑥⑦ 步 | `engine/systems/BloomSystem.ts` |

拆分后：`Composer` 缩到 **234 行**，只剩"按顺序调度 + 持有 rtComposite 交接点"。

## 二、拆分原则

1. **不引入回归**。纯重构 —— 数学、shader、uniform 全部按行搬运。
2. **不夹带行为变化**。发现缺陷就停下来报告（见「已知缺陷」），不要顺手改。
3. **结构化接口而不是 import**。`ObjectAnimationSystem` 接受的
   `AnimatableLayer` 是结构化的（不是 import BuiltLayer），
   避免 SceneBuilder ↔ ObjectAnimationSystem 的循环 import。
4. **RenderTarget 按所有权分配**。rtCurrent/rtNext 归 TransitionSystem，
   rtBright/rtBlurA/rtBlurB 归 BloomSystem，**rtComposite 归 Composer**
   —— 它是过渡 → bloom 的唯一耦合点，让任何一方拥有都会让另一方反向依赖。
5. **跨帧缓存属于实例**。CameraSystem 的 `smooth` 是阻尼状态，
   所以它**必须**是类，不是纯函数。ParallaxSystem 是纯函数（无跨帧状态）。

## 三、改动清单

### 新增

| 文件 | 行 | 说明 |
|---|---|---|
| `src/engine/systems/SceneManager.ts` | 146 | PHASE 4。生命周期 + 解析 current/next |
| `src/engine/systems/CameraSystem.ts` | 95 | PHASE 5。轨道求值 + 阻尼 |
| `src/engine/systems/ParallaxSystem.ts` | 110 | PHASE 6。位移单位制 |
| `src/engine/systems/ObjectAnimationSystem.ts` | 102 | PHASE 7。遍历图层写 transform |
| `src/engine/systems/TransitionSystem.ts` | 175 | PHASE 8。双场景交叉溶解 |
| `src/engine/systems/BloomSystem.ts` | 162 | PHASE 9。亮度提取 + 高斯 + 合成 |
| `src/engine/systems/ParallaxSystem.test.ts` | 84 | 12 用例 |
| `src/engine/systems/CameraSystem.test.ts` | 110 | 10 用例 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/engine/SceneBuilder.ts` | 456 → 421 行。移除 camValues/camSmooth 与对象循环内的内联逻辑，委托给两个系统。新增 `applyCameraConfig` 用于 refreshLayout |
| `src/engine/Composer.ts` | 467 → 234 行。`scenes[]` / RTs / 过渡 / bloom 全部下放，自己只剩"调度 + 持有 rtComposite" |

## 四、设计抉择

### 4.1 求值顺序：先求两个，再一起渲染（不再交错）

**改造前**：`current.applyTime → render current → next.applyTime → render next`
**改造后**：`current.applyTime + next.applyTime → render current + render next`

两个场景不共享任何 Object3D，所以这个变化**不影响渲染结果**，但把
"applyTime 几次、render 几次"的细节从调用方剥离了。

### 4.2 CameraSystem 的 syncConfig

`Composer.refreshLayout` 会整体替换 `built.config.camera`。
CameraSystem 持有的是**引用**，所以替换 config 后必须显式
`syncConfig`，否则会一直用旧的轨道。

新建 `BuiltScene.applyCameraConfig` 把这件事封装好，调用方一行搞定。

### 4.3 ParallaxSystem 故意做小

原本想给它一个"视差模型"职责（管理不同深度层的相对速度），写完发现
—— 分层视差是**透视投影的几何后果**，由深度差自然产生，不写代码也成立。

所以它只剩两件小事：
- 定义"1.0 = 一个视口高"的单位制
- 提供一个艺术性的强度倍率

刻意做小，避免重算反而抵消自然视差。

### 4.4 AnimatableLayer 用结构化接口

```ts
export interface AnimatableLayer { config, object, mesh?, baseVisibleH, ... }
```

而不是 `import type { BuiltLayer } from '../SceneBuilder'` —— 这样 SceneBuilder
可以 import ObjectAnimationSystem，对象系统也可以接受任何 BuiltLayer
结构上满足的对象，**零运行时依赖**。

## 五、验证

```
✓ typecheck
✓ npm test          119 个用例 / 5 个文件 / 0.6s
✓ vite build        1.94s
✓ npm run verify:independence
✓ 浏览器烟测        http://localhost:5299/?accept=1  144fps, stats 正常,
                    场景切换、过渡、HUD 全部就绪（截图：scene02 猫）
```

烟测发现了**一个真实的预存缺陷**（见下）。

## 六、已知缺陷（拆分过程中发现，不在本次修复）

### 6.1 position.x 的位移单位与文档/构图不一致

**症状**：横向轨道位移只有设计值的 1/aspect（2.1 视口下约 47%）。

**根因**：
- `presets.ts:23` 与 `compose.ts:16` 两处文档都写着
  `position.x 的世界位移 = 值 × visibleH × aspect`（即"1.0 = 一个屏幕宽"）
- 但旧 `SceneBuilder.applyTime` 里的 `* aspect` 用的是 `buildScene` 的入参
  （Composer 固定传 1，**之后 setAspect 永不更新**），所以实际生效的是
  "1.0 = 一个视口高"——横向只有设计值的 1/aspect。

**修复一行**：
```ts
// src/engine/SceneBuilder.ts setAspect 内
function setAspect(next: number): void {
  camera.aspect = next;
  camera.updateProjectionMatrix();
  // ↑ 这里加一行 ↓
  objectSystem.setAspect(next);
  // ...
}
```

**为什么不改**：纯重构不应夹带观感变化；改完之后所有横向轨道幅度
会变成当前的 aspect 倍，需要重新过一遍眼睛。已加 ⚠️ 注释 + ParallaxSystem
测试钉住当前的"aspect=1"行为，修复时改测试再改代码。

### 6.2 已发现但**未在拆分中修复**的其它"既知限制"

继续沿用 PHASE 21 / MEMORY.md 的清单（接触阴影、resize 不重新构图、浅色背景掩码失灵、腰部检测仅横向等），本阶段**未触及**。

## 七、给后续阶段的提示

- **加新轨道**：改 schema + presets + 某个 System 的求值循环。
  CameraSystem 只关心 `position.x/y/z / rotation.z / fov`，其他要加到
  ObjectAnimationSystem。
- **改运镜**：现在只动 `CameraSystem.apply()` 就行，Composer 不知道。
- **改过渡视觉**：改 `TransitionSystem.render()` + `shaders/transition.ts`。
- **改 bloom 调参**：运行时改用 `bloomSystem.setParams({...})`。
- **加新场景类型**：现在没有 —— SceneBuilder 的 if-else 是 "plane / model" 二分。
  真要加（比如视频贴图）就在 SceneBuilder 里加分支，SceneManager / Composer 不用动。