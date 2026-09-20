# PHASE 21 —— 单元测试

> 这个引擎里只有三个模块**有正确答案可言**：构图、预设展开、滚动数学。
> 其余部分（渲染、过渡观感、性能）只能靠"看起来对不对"判断，
> 那是浏览器内验收（`?accept=1`）的活。
>
> 这三个都是纯函数 —— 给定输入，正确的输出是唯一确定的。所以它们该被单测锁死。

```bash
npm test           # 97 个用例 / 3 个文件，~0.6s
npm run test:watch
```

| 模块 | 用例 | 锁住什么 |
|---|---|---|
| `asset-pipeline/compose.ts` | 22 | 构图数学（映射、深度反解、钳制、契约字段） |
| `animation/presets.ts` | 48 | 13 个预设的展开规则、路径纪律、range/intensity |
| `animation/scrollProgress.ts` | 27 | 滚动进度、**切换点零跳变**、earlyCrossfade、章节定位 |

---

## 一、用例怎么组织的

| 分组 | 锁住什么 |
|---|---|
| 构图公式 | `overscan = box.h × fY`、`offset = (center − 0.5) × f`、**z 与构图解耦** |
| 深度反解与钳制 | 初始占屏 ≤ `maxSubjectH`、**推进结束 ≤ `maxScreenH`**、`camera.z > 所有 object.z` |
| 相机轨道 | `dolly` 为负 = 推进（不是后退）、每场景都有轨道 |
| 首屏可见性 | 首屏 `opacity ≠ 0`、非首屏可以有 fadeIn |
| 契约字段 | `role` 正确、背景 `opaque`、**asset key 都能在 assets 表里找到** |
| 边界与确定性 | 纯函数、极端宽高比不崩、空主体/空 manifest、场景顺序、`earlyCrossfade` 规则、过渡模式、**主体轨迹互不相同** |

每一条都对应一个**真实踩过的坑**，不是为覆盖率凑数。

几个值得说的：

- **`z 与构图解耦`** —— 改 `dist` 会让 z 变，但 `overscan` 必须**一模一样**。
  这是整个自动构图能成立的地基（见 [`PHASE-3-自动构图.md`](PHASE-3-自动构图.md) §3.2）。
- **`asset key 都能在 assets 表里找到`** —— 这类"两个地方各写一遍字符串"的 bug
  不会报错，只会渲染出空白。
- **`主体轨迹互不相同`** —— 用**归一化位移签名**比较（见
  [`PHASE-11-里程碑验收.md`](PHASE-11-里程碑验收.md) §3.1 的教训）。

---

## 二、★ 抓到的一个真 bug

第一次跑：**20 passed / 2 failed**。两个失败性质完全不同。

### 失败 A：测试的期望值算错了

```
expected -0.75 to be close to -1
```

我在期望值里手算 `center.x`，算成了 `0.1`，实际是 `0.1 + 0.2/2 = 0.2`。
**代码是对的，测试是错的。**

修法不只是改数字 —— 改成**用公式算期望值**：

```ts
const cx = leftBox.x + leftBox.w / 2;
expect(...).toBeCloseTo((cx - 0.5) * 2.5, 6);
```

手算数字容易错，而且错了之后看起来像代码的问题。

### 失败 B：真 bug —— `maxScreenH` 约束被静默破坏

```
expected 1.0925 to be less than or equal to 1.050001
```

`compose.ts` 里的顺序是：

```ts
if (screenH < maxScreenH) {
  const dSafe = (maxScreenH * dolly) / (screenH - maxScreenH);
  if (dSafe > d) d = dSafe;      // ← 先把 d 提上去，保证推进后不超
}
d = Math.min(d, bgDist - 2);      // ← 再把它压回来，约束就没了
```

**反例**：一个占屏 92% 的大主体，要保证推进后不超过 1.05 屏高需要 `d ≈ 48`，
而 `bgDist - 2` 只给到 38 —— 于是它照样出界：

```
0.92 × 38/(38−6) = 1.0925   ← 超出承诺的 1.05
```

而 `docs/PHASE-3-自动构图.md` 里写着 `maxScreenH` 是"推进结束时允许的高度上限"。
**承诺与实现不符。**

**修法**：深度定下来之后，用**实际的 d** 反算尺寸上限 ——
深度已经被背景位置钉死了，那就反过来收尺寸：

```ts
d = Math.min(d, bgDist - 2);

const zoom = d / (d + dolly);
screenH = Math.min(screenH, maxScreenH / zoom);   // 让约束成为不变量
```

实测修复后（浏览器里读真实构图）：

```
scene01/subject-01  overscan 0.721   endScreenH 1.03
scene01/subject-04  overscan 0.638   endScreenH 0.79
scene02/subject-01  overscan 0.8842  endScreenH 1.05   ← 正好等于 maxScreenH
```

`scene02` 的猫从 92% 收到 88.4% —— 视觉上几乎无差别，但**约束成立了**。

---

## 三、踩到的一个版本坑

```
npm error ERESOLVE unable to resolve dependency tree
npm error   peer vite@"^6.4.0 || ^7.0.0 || ^8.0.0" from vitest@5.0.1
npm error   Found: vite@5.4.21
```

vitest 5 要求 vite 6+，而项目在 vite 5。装 **`vitest@^3`**（兼容 vite 5）。

> 顺带一个坑：`npx vitest run` 在**没装依赖**的情况下也能跑（npx 会临时下载）。
> 于是"测试通过了"这件事本身**不能证明依赖装好了** ——
> `tsc` 立刻报 `Cannot find module 'vitest'` 才暴露出来。
> **跑测试成功 ≠ 项目配置正确**，要 typecheck 一起跑。

---

## 五、另外两个模块

### presets.ts —— 48 个用例

最有价值的一条是**遍历全部 13 个预设**：一次性检查非空、path 合法、
keyframes 有序且 `t ∈ [0,1]`、**同一预设内无重复 path**（求值器按 path 覆盖，
重复会互相顶掉）。新增预设时自动被覆盖。

★ 第一版跑出 **6 个 FAIL，全部是分类假设错了** —— 不是代码的 bug：

| 我的假设 | 实际 |
|---|---|
| 所有预设都该展开出非空轨道 | `pinned` 空轨道是**正确的**，它的语义就是"不动" |
| 持续运动预设不碰 opacity | `rise` / `sink` / `scatter` / `exitDown` 动 opacity 是**设计意图**（升起 + 淡入） |
| 循环预设都该收尾回起点 | `drift` 不收尾回起点也是**设计意图**（单向漂移） |

改成照实现核对过的三个列表，并加了一条守卫：
**"分类必须覆盖全部预设"** —— 以后新增预设时它会失败，提醒你去归类。

> 和 PHASE 20 是同一个教训：**新写的检查先要验证它在正常内容上会不会误报。**

### scrollProgress.ts —— 27 个用例

最该锁住的是**切换点零跳变**：

```
切换前一瞬（current=i，  progress→1）      → uProgress→1
切换后一瞬（current=i+1，progress≈0.4545） → uProgress→0
```

两边都指向"画面 100% 是章节 i+1"，所以看不出接缝。这是整个滚动系统最关键的性质。

还有一条容易忽略的：**首屏 `scrollY=0` 时 `sceneTime` 必须是 0** ——
首章多了一段"入屏前一屏高"的区间（所以 progress 一上来就是 0.4545），
`sceneTime` 要把它扣掉，否则打开页面时首屏已经播到 45%，看不到入场动画。

---

## 六、还差的

`engine/` 里的东西（SceneBuilder / Composer）依赖 WebGL 上下文，
单测成本高、收益低 —— 它们更适合用 `?accept=1` 那套**浏览器内验收**。

---

## 七、修改的文件

| 文件 | 改动 |
|---|---|
| `src/asset-pipeline/compose.test.ts` | **新建**。22 个用例 |
| `src/animation/presets.test.ts` | **新建**。48 个用例 |
| `src/animation/scrollProgress.test.ts` | **新建**。27 个用例 |
| `src/asset-pipeline/compose.ts` | **修 bug**：深度定下后反算尺寸上限，让 `maxScreenH` 成为不变量 |
| `package.json` | 加 `test` / `test:watch`，devDep `vitest@^3` |

**测试总数 97，耗时 ~0.6s。**
