# PHASE 22 — 音频系统（Tone.js）

## 一句话

给滚动叙事加一层**跟着滚动呼吸的声音**：低频 drone 垫底 + 换章时一次短音效 +
滚得快时滤波器打开、音色微微发颤。和后处理共用同一套活跃度公式。

## 为什么做

参考站点 iamsaeed.dev 用了 Tone.js（`tone@15.1.22`），它的音频系统是
10 个文件的规模（buses / recipes / rooms / score / transitions / moments…）。
我们不做那么深 —— 只取**最能被感知的三块**：

| 参考站点的模块 | 我们做不做 | 理由 |
|---|---|---|
| 6 条命名总线 + master chain | 简化成一条 master | 素材驱动不需要那么细的混音 |
| 常驻 ambient bed | **做**（`ambient`） | 最基础的"画面有声音" |
| 转场 hit / hit-stop | **做**（`transition`） | 换章的听觉提示，最抓人 |
| 滚动 → 音色变化 | **做**（`motion`） | 让声音"活"起来 |
| 鼓点 / UI 音效 / 卷积房间 | 不做 | 属于内容编排，不属于素材驱动 |

## ★ 三个必须知道的硬约束

### 1. AudioContext 必须在用户手势里启动

Chrome / Safari / Firefox 都要求。页面自己调 `Tone.start()` 会得到一个
**suspended** 的上下文 —— 永远不出声，控制台一声不吭。

所以 `AudioSystem.start()` 的第一行就是 `await Tone.start()`，
**前面不能有任何别的 await**（await 过一次微任务，调用栈就断了，
Chrome 会判定"不在手势里"）。

UI 上放一个左下角的开关（`AudioToggle`），默认 `SOUND OFF`，
用户点了才启动。这既合规也是礼貌 —— 突然出声的网页最招人烦。

### 2. Tone.js 必须动态 import

Tone 压缩后 ~340KB。而音频在用户点开关之前**完全用不上**。
放在首屏 bundle 里等于让每个访客都为"可能永远不点的功能"付 340KB。

实测：Vite 把它切成了独立 chunk（`index-DWHXqSMG.js`，340KB），
`index.html` 只引用主 chunk —— **首屏零成本**。

### 3. audio 实例必须过一道 ref

主 `useEffect` 的依赖是 `[pack, content]`，**不会**在 audio 变化时重跑。
而 audio 是 App 在内容包解析完成后才创建的（CanvasHost 首帧必然拿到 null）。
循环里直接读 props 的 audio，闭包捕获的就是那个 null ——
声音永远不响，而且没有任何报错。

```tsx
const audioRef = useRef<AudioSystem | null>(audio ?? null);
audioRef.current = audio ?? null;   // 每帧读 ref.current
```

## 信号图

```
ambient（常驻）:
  osc×4（去谐 ±7 cents）→ lowpass ┐
                                  ├→ tremolo → reverb → gain(-22dB) ┐
sfx（触发）:                      │                                 │
  white noise → bandpass(1800) ───┘                                 │
  synth bell ───────────────────────────────────────────────────────┤
                                                                     ↓
                                                       master(-6dB) → Destination
```

**tremolo 放在 filter 之后、reverb 之前**：先"颤"再"混响"，
颤音会被混响拖出尾巴，比反过来更有空间感。

## 滚动驱动（与后处理共用公式）

```
activity = clamp01(|velocity| / velocityRef)       // velocityRef 默认 55
activity 再过 0.12s 指数平滑（与 PostSystem 的 SMOOTHING_TAU 一致）

filter.frequency → filterBase + activity × filterOpen × (filterCeil - filterBase)
tremolo.depth    → activity × tremoloDepth
```

实测：静止 → cutoff 320（= filterBase）；velocity 640 → activity 0.565 →
cutoff 正在 60ms 斜坡上爬向 1608（抓到中途值 529）。

**音频的 activity 与后处理的 postActivity 数值完全相同**（实测都是 0.565）——
因为它们吃的是同一个 `ScrollState.velocity` 和同一个平滑公式。
这就是"画面炸开"和"声音响起"严格同步的原因。

## 换章触发

```ts
if (this.prevChapter !== -1 && chapter !== this.prevChapter) this.triggerTransition();
```

噪声用**常驻运行 + gain 包络**，不是 `start()/stop()`：
Noise 的 stop→start 有 ~10ms 建立时间，短音效会被吃掉头。

bell 的音高按章节号走（0/3/7/10 半音），听起来像"翻页"。

## 契约层（`src/schema/audio.ts`）

```ts
interface AudioConfig {
  enabled?: boolean;      // 默认 false —— 必须用户手势
  masterDb?: number;
  ambient?:   { pitch, voices, detuneRange, filterBase, filterCeil, reverb, gainDb }
  transition?:{ type: 'noise'|'tone'|'both', duration, gainDb, filterFreq }
  motion?:    { filterOpen, tremolo, velocityRef }
}
```

内容包在 `site.audio` 声明 —— 和 `site.post` 一样，
**不声明 = 引擎默认值，声明 = 整体替换**。

cats 包声明的是"偏暗、安静、有空间感"的一套：
`pitch 80 / voices 4 / detuneRange 14 / filter 320→2600 / tremolo 0.045`。

## 实测

| 检查 | 结果 |
|---|---|
| 按钮渲染 | ✓ `SOUND OFF`，可点击 |
| 真实点击 → 启动 | ✓ `running: true`，按钮变 `SOUND ON`，`.is-on` 生效 |
| 图结构 | ✓ 4 个振荡器，master gain 0.50（-6dB），reverb wet 0.35 |
| 滚动 → 活跃度 | ✓ velocity 640 → activity 0.565（与 postActivity 完全一致） |
| 滚动 → 滤波器 | ✓ cutoff 320（静止）→ 斜坡爬向 1608 |
| 换章 → 音效 | ✓ 回到第 0 章时 hits 1 → 2 |
| 关闭 | ✓ `running: false`，graph 已 dispose，按钮回 `SOUND OFF` |
| Tone 是否进首屏 | ✓ 否，独立 340KB chunk |
| typecheck / test / verify:independence | ✓ 全过 |

## 修改清单

### 新增
- `src/schema/audio.ts` —— 音频契约
- `src/engine/systems/AudioSystem.ts` —— Tone.js 封装
- `src/components/AudioToggle.tsx` —— 左下角开关（用户手势入口）
- `src/styles.css` —— `.audio-toggle` 样式（含呼吸状态灯）

### 修改
- `src/schema/index.ts` —— 导出 audio
- `src/content/types.ts` —— `SiteConfig` 加 `audio?: AudioConfig`
- `src/content/cats/site.ts` —— 声明 AUDIO 配置
- `src/app/App.tsx` —— 持有 AudioSystem 实例，渲染开关
- `src/components/CanvasHost.tsx` —— 接 `audio` prop，rAF 里驱动，过 ref

## 仍存在的问题（诚实声明）

- **无头 / 后台标签页无法验证真实听感** —— 实测只验证了信号图参数与触发计数，
  没有真正"听过"。参数（pitch 80 / tremolo 0.045 等）是按经验值给的，
  需要在真实浏览器里试听后微调。
- **Tremolo 的 depth 是 rampTo(0.06)** —— 每帧都在排新的斜坡，
  理论上会累积调度事件。实测没出问题，但高频滚动下值得再看一眼。
- **没有 prefers-reduced-motion 的音频降级** —— CSS 里给状态灯加了，
  但声音本身没做（自动播放策略已经让它默认 OFF，影响有限）。
- **转场音效没有去重** —— 快速来回滚动会连触发。参考站点有 MIN_GAP 去重，
  我们没做。

## 运行命令

```bash
npm install         # tone@15.1.22
npm run typecheck
npm test
npm run verify:independence
npm run build
npm run dev         # 打开后点左下角 SOUND OFF 开声音
```
