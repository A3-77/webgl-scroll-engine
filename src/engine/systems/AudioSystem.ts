/**
 * PHASE 22 —— 音频系统
 * ===========================================================================
 * 声音不是"渲染"的一部分，但它和渲染**共享同一套滚动驱动量**，
 * 所以放在 engine/systems/ 下，由 CanvasHost 的 rAF 循环每帧喂一次。
 *
 * ---------------------------------------------------------------------------
 * 【为什么必须默认关闭 —— 浏览器自动播放策略】
 *
 *   Chrome / Safari / Firefox 都要求 AudioContext 在**用户手势**里 start()。
 *   页面一加载就 new AudioContext() 会得到一个 suspended 的上下文，
 *   声音永远不出来，而且控制台还不报错 —— 这是最容易误判"Tone.js 坏了"的坑。
 *
 *   所以本系统的生命周期是：
 *     构造 → 什么都不做（连 Tone.js 都不 import）
 *     start() → **必须在 click / keydown 的同步调用栈里** → Tone.start() + 建图
 *     stop()  → 淡出并拆掉整条链
 *
 * ---------------------------------------------------------------------------
 * 【★ Tone.js 为什么是动态 import】
 *
 *   Tone.js 压缩后约 200KB。而音频在用户点开关之前**完全用不上**。
 *   放在首屏 bundle 里等于让每一个访客都为"可能永远不点的功能"付 200KB。
 *   所以 `start()` 里才 `await import('tone')` —— Vite 会自动把它切成
 *   独立 chunk，首屏零成本。参考站点（iamsaeed.dev）也是这么做的。
 *
 * ---------------------------------------------------------------------------
 * 【信号图】
 *
 *   ambient（常驻）:
 *     osc×N（去谐）→ lowpass filter ┐
 *                                   ├→ tremolo → reverb → gain(ambientDb) ┐
 *   sfx（触发）:                    │                                      │
 *     noise → bandpass → envGain ───┘                                      │
 *     synth（bell）────────────────────────────────────────────────────────┤
 *                                                                          ↓
 *                                                            master(Gain) → Destination
 *
 *   tremolo 放在 filter 之后、reverb 之前：
 *     先"颤"再"混响"，颤音会被混响拖出尾巴，比反过来更有空间感。
 *
 * ---------------------------------------------------------------------------
 * 【滚动驱动】
 *   和后处理共用同一个活跃度概念（详见 schema/audio.ts 的 MotionSpec）：
 *     activity = clamp01(|velocity| / velocityRef)
 *   然后
 *     filter.frequency = filterBase + activity × filterOpen × (filterCeil - filterBase)
 *     tremolo.depth    = activity × tremoloDepth
 *
 *   滚快 → 音色"打开"并且微微发颤，停下 → 缓缓合上。
 *   这和后处理的 pulse 是同一套哲学：静止的效果是死的。
 *
 * ---------------------------------------------------------------------------
 * 【失败策略】
 *   任何一步抛错都不允许让页面崩掉 —— 音频是"锦上添花"，不是"必须"。
 *   start() 内部整体 try/catch，失败就标记 failed 并 console.warn 一次，
 *   之后 update() 直接 return。宁可静音，不可白屏。
 * ===========================================================================
 */

import type { AudioConfig, ScrollState } from '../../schema';

/** 动态 import 的类型。不写 `any` —— 否则后续所有节点操作都失去类型检查 */
type ToneModule = typeof import('tone');

/** 活跃度平滑的时间常数（秒），与 PostSystem 一致 */
const SMOOTHING_TAU = 0.12;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface AudioStats {
  /** 是否已解锁并建好图 */
  running: boolean;
  /** 启动失败（Tone.js 加载失败 / AudioContext 被拒） */
  failed: boolean;
  /** 平滑后的活跃度 0..1 */
  activity: number;
  /** 已触发过多少次转场音效 */
  hits: number;
}

interface Graph {
  Tone: ToneModule;
  master: import('tone').Gain;
  oscs: import('tone').Oscillator[];
  filter: import('tone').Filter;
  tremolo: import('tone').Tremolo;
  reverb: import('tone').Reverb;
  ambientGain: import('tone').Gain;
  noise: import('tone').Noise;
  noiseGain: import('tone').Gain;
  synth: import('tone').Synth;
}

export class AudioSystem {
  private readonly config: AudioConfig;
  private graph: Graph | null = null;
  private activity = 0;
  private hits = 0;
  private failed = false;
  /** 上一帧的章节号，用于检测"换章"以触发转场音效 */
  private prevChapter = -1;

  /** 解析后的参数（构造时算一次，避免每帧读可选字段） */
  private readonly p: {
    ambient: Required<NonNullable<AudioConfig['ambient']>> & { enabled: boolean };
    transition: Required<NonNullable<AudioConfig['transition']>> & { enabled: boolean };
    motion: Required<NonNullable<AudioConfig['motion']>>;
    masterDb: number;
  };

  readonly stats: AudioStats = { running: false, failed: false, activity: 0, hits: 0 };

  constructor(config: AudioConfig = {}) {
    this.config = config;

    const a = config.ambient ?? {};
    const t = config.transition ?? {};
    const m = config.motion ?? {};

    this.p = {
      masterDb: config.masterDb ?? -6,
      ambient: {
        enabled: a.enabled ?? true,
        pitch: a.pitch ?? 80,
        voices: a.voices ?? 4,
        detuneRange: a.detuneRange ?? 14,
        filterBase: a.filterBase ?? 320,
        filterCeil: a.filterCeil ?? 2600,
        reverb: a.reverb ?? 0.35,
        gainDb: a.gainDb ?? -22,
      },
      transition: {
        enabled: t.enabled ?? true,
        type: t.type ?? 'both',
        duration: t.duration ?? 0.18,
        gainDb: t.gainDb ?? -12,
        filterFreq: t.filterFreq ?? 1800,
      },
      motion: {
        filterOpen: m.filterOpen ?? 1,
        tremolo: m.tremolo ?? 0.045,
        velocityRef: m.velocityRef ?? 55,
      },
    };
  }

  /* ------------------------------------------------------------ 生命周期 */

  /**
   * ★ 必须在用户手势的同步调用栈里调用（click / keydown 处理函数内）。
   *
   * 为什么不能提前 await：Tone.start() 内部要 resume AudioContext，
   * 而浏览器判定"这是否发生在用户手势里"看的是**调用栈是否还在手势事件里**。
   * 一旦 await 过一次微任务，栈就断了，Chrome 会拒绝 resume。
   * 所以这里第一行就是 `await Tone.start()`，前面不做任何 await。
   */
  async start(): Promise<boolean> {
    if (this.graph || this.failed) return !!this.graph;

    try {
      const Tone = await import('tone');
      // ★ 立刻解锁，中间不能有任何别的 await
      await Tone.start();

      const { ambient, transition, masterDb } = this.p;

      const master = new Tone.Gain(Tone.dbToGain(masterDb)).toDestination();

      // ---- ambient 链 ----
      const ambientGain = new Tone.Gain(Tone.dbToGain(ambient.gainDb));
      const reverb = new Tone.Reverb({ decay: 4, wet: ambient.reverb });
      const tremolo = new Tone.Tremolo(4.5, 0).start();
      const filter = new Tone.Filter(ambient.filterBase, 'lowpass');

      filter.chain(tremolo, reverb, ambientGain, master);

      const oscs: import('tone').Oscillator[] = [];
      if (ambient.enabled) {
        const n = Math.max(1, Math.round(ambient.voices));
        for (let i = 0; i < n; i++) {
          // 去谐均匀铺开：n=1 时 detune=0，n>1 时从 -range/2 到 +range/2
          const detune = n === 1 ? 0 : (i / (n - 1) - 0.5) * ambient.detuneRange;
          const osc = new Tone.Oscillator(ambient.pitch, 'sine');
          osc.detune.value = detune;
          osc.connect(filter);
          osc.start();
          oscs.push(osc);
        }
      }

      // ---- sfx 链 ----
      // 噪声常驻运行，靠 gain 包络"开门"，避免每次触发都 start/stop
      // （Noise 的 start/stop 有 ~10ms 的建立时间，短音效会被吃掉头）
      const noise = new Tone.Noise('white');
      const noiseGain = new Tone.Gain(0);
      const bandpass = new Tone.Filter(transition.filterFreq, 'bandpass');
      noise.chain(bandpass, noiseGain, master);
      if (transition.enabled && (transition.type === 'noise' || transition.type === 'both')) {
        noise.start();
      }

      const synth = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.005, decay: transition.duration, sustain: 0, release: 0.05 },
      });
      synth.connect(master);

      this.graph = {
        Tone,
        master,
        oscs,
        filter,
        tremolo,
        reverb,
        ambientGain,
        noise,
        noiseGain,
        synth,
      };

      this.stats.running = true;
      return true;
    } catch (err) {
      this.failed = true;
      this.stats.failed = true;
      console.warn('[AudioSystem] 启动失败，已降级为静音:', err);
      return false;
    }
  }

  /** 淡出并拆掉整条链。可以再次 start() */
  stop(): void {
    const g = this.graph;
    if (!g) return;

    try {
      g.ambientGain.gain.rampTo(0, 0.25);
      // 等淡出走完再 dispose，否则会听到"啪"的一声
      window.setTimeout(() => {
        try {
          g.oscs.forEach((o) => o.dispose());
          g.noise.dispose();
          g.synth.dispose();
          g.tremolo.dispose();
          g.reverb.dispose();
          g.filter.dispose();
          g.ambientGain.dispose();
          g.noiseGain.dispose();
          g.master.dispose();
        } catch {
          /* dispose 失败无所谓，audio context 可能已经关了 */
        }
      }, 300);
    } catch (err) {
      console.warn('[AudioSystem] 停止时出错:', err);
    }

    this.graph = null;
    this.prevChapter = -1;
    this.stats.running = false;
  }

  /* ------------------------------------------------------------ 每帧 */

  /**
   * @param state     滚动状态（用 velocity 与 current.index）
   * @param uProgress 过渡进度 0..1（与后处理共用同一个值）
   * @param dt        距上一帧秒数
   */
  update(state: ScrollState, uProgress: number, dt: number): void {
    const g = this.graph;
    if (!g) return;

    // ---- ① 活跃度（与 PostSystem 同一套公式）----
    const target = clamp01(Math.abs(state.velocity) / this.p.motion.velocityRef);
    const k = 1 - Math.exp(-Math.min(dt, 0.1) / SMOOTHING_TAU);
    this.activity += (target - this.activity) * k;
    this.stats.activity = this.activity;

    // ---- ② 滚动驱动：滤波器打开 + 颤音加深 ----
    const { ambient, motion } = this.p;
    const open = motion.filterOpen * this.activity;
    const cutoff = ambient.filterBase + open * (ambient.filterCeil - ambient.filterBase);
    g.filter.frequency.rampTo(cutoff, 0.06);
    g.tremolo.depth.rampTo(motion.tremolo * this.activity, 0.06);

    // ---- ③ 换章触发转场音效 ----
    const chapter = state.current.index;
    if (this.prevChapter !== -1 && chapter !== this.prevChapter) {
      this.triggerTransition();
    }
    this.prevChapter = chapter;

    // uProgress 目前只用于"过渡进行中"的判定（未来可以做扫频），
    // 显式引用一次避免 TS 把它当成未使用参数。
    void uProgress;
  }

  /* ------------------------------------------------------------ 音效 */

  /**
   * 触发一次转场音效。
   *
   * 为什么噪声用"常驻 + gain 包络"而不是 triggerAttackRelease：
   *   Noise 没有包络，靠 start/stop 控制。而 stop() 之后立刻 start()
   *   会被 Web Audio 的节点回收机制打断，短音效会丢失。
   *   常驻运行 + 只在需要时把 gain 拉起来，是最稳的做法。
   */
  private triggerTransition(): void {
    const g = this.graph;
    const t = this.p.transition;
    if (!g || !t.enabled) return;

    const { Tone } = g;
    const now = Tone.now();
    const peak = Tone.dbToGain(t.gainDb);

    if (t.type === 'noise' || t.type === 'both') {
      const gain = g.noiseGain.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(0.0001, now);
      gain.linearRampToValueAtTime(peak, now + 0.008);
      gain.exponentialRampToValueAtTime(0.0001, now + t.duration);
    }

    if (t.type === 'tone' || t.type === 'both') {
      // 章节号决定音高：换章时音高会走，听起来像"翻页"
      const semis = [0, 3, 7, 10];
      const semi = semis[this.prevChapter % semis.length] ?? 0;
      const freq = Tone.Frequency(this.p.ambient.pitch * 4, 'midi')
        .transpose(semi)
        .toFrequency();
      g.synth.triggerAttackRelease(freq, t.duration, now);
    }

    this.hits += 1;
    this.stats.hits = this.hits;
  }

  dispose(): void {
    this.stop();
  }
}
