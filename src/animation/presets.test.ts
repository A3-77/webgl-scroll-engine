/**
 * Motion Presets 单元测试
 * ===========================================================================
 * `presets.ts` 和 `compose.ts` 一样是纯函数：给定 (preset, range, intensity)，
 * 输出的关键帧是唯一确定的。
 *
 * 最有价值的一条是「所有预设都能展开」—— 它一次性覆盖 13 个预设，
 * 能抓到拼写错误、未定义的 ease、空轨道、越界的 t。
 * ===========================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import { PRESETS, expandPreset, presetNames } from './presets';

/* ------------------------------------------------------------ 展开规则 */

describe('expandPreset 的分派规则', () => {
  it('undefined → 空轨道（对象静止）', () => {
    expect(expandPreset(undefined)).toEqual([]);
  });

  it('手写 tracks 优先，原样返回（不被 preset 覆盖）', () => {
    const hand = [{ path: 'position.y', keyframes: [{ t: 0, value: 1 }] }];
    expect(expandPreset({ tracks: hand, preset: 'float' })).toBe(hand);
  });

  it('空 tracks 数组会退回到 preset', () => {
    const out = expandPreset({ tracks: [], preset: 'float' });
    expect(out.length).toBeGreaterThan(0);
  });

  it('既没有 tracks 也没有 preset → 空轨道', () => {
    expect(expandPreset({} as never)).toEqual([]);
  });

  it('未知预设名不抛异常，只 warn + 空轨道', () => {
    // 预设名是内容侧的字符串，拼错一个字母不该让整站白屏
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let out: unknown;
    expect(() => {
      out = expandPreset({ preset: 'floattt' });
    }).not.toThrow();
    expect(out).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

/* ------------------------------------------------------------ 全部预设 */

describe('所有预设都能展开（13 个一次性覆盖）', () => {
  const names = presetNames();
  /** pinned 的语义就是"不动"，空轨道是**正确**的 —— 它不是缺陷，是特例 */
  const movers = names.filter((n) => n !== 'pinned');

  it('至少定义了 10 个预设', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('pinned 展开成空轨道（这是它的语义，不是缺陷）', () => {
    expect(expandPreset({ preset: 'pinned' })).toEqual([]);
  });

  it.each(movers)('预设 "%s" 展开出合法轨道', (name) => {
    const tracks = expandPreset({ preset: name });

    expect(tracks.length, `${name} 展开成空轨道`).toBeGreaterThan(0);

    for (const tr of tracks) {
      expect(typeof tr.path, `${name} 的轨道缺 path`).toBe('string');
      expect(tr.keyframes.length, `${name}/${tr.path} 没有关键帧`).toBeGreaterThan(0);

      for (const k of tr.keyframes) {
        // t 越界会导致求值器在区间外乱插值
        expect(k.t, `${name}/${tr.path} 的 t=${k.t} 越界`).toBeGreaterThanOrEqual(0);
        expect(k.t, `${name}/${tr.path} 的 t=${k.t} 越界`).toBeLessThanOrEqual(1);
        expect(Number.isFinite(k.value), `${name}/${tr.path} 的值不是有限数`).toBe(true);
      }

      // 关键帧按 t 升序 —— 求值器假定有序
      const ts = tr.keyframes.map((k) => k.t);
      expect(ts, `${name}/${tr.path} 的关键帧没有按 t 升序`).toEqual([...ts].sort((a, b) => a - b));
    }
  });

  it('同一个预设内不出现重复的 path（求值器按 path 覆盖，重复会互相顶掉）', () => {
    for (const name of movers) {
      const paths = expandPreset({ preset: name }).map((t) => t.path);
      expect(new Set(paths).size, `${name} 里有重复 path: ${paths.join(', ')}`).toBe(paths.length);
    }
  });

  it('每个预设只动少量属性（不越权）', () => {
    // 一个预设动 5 条以上轨道通常意味着它写错了
    for (const name of names) {
      const tracks = expandPreset({ preset: name });
      expect(tracks.length, `${name} 动了 ${tracks.length} 条轨道`).toBeLessThanOrEqual(4);
    }
  });

  it('PRESETS 表里的每个 builder 都是函数', () => {
    for (const [name, fn] of Object.entries(PRESETS)) {
      expect(typeof fn, `${name} 不是函数`).toBe('function');
    }
  });
});

/* ------------------------------------------------------------ 路径纪律 */

describe('三类动效动不同的属性路径（设计约束）', () => {
  /**
   * 求值器按 path 覆盖。如果入场也用 position.y，
   * 它就会把持续运动的 position.y 顶掉 —— 这个 bug 是静默的。
   *
   * ★ 这三个列表是**照着实现核对过的**，不是猜的。
   *   第一版把 rise / sink / scatter / exitDown 归进了"纯运动"，
   *   于是 6 个用例报 FAIL —— 而它们动 opacity 是**设计意图**
   *   （从下方升起 + 淡入）。分类错了会让测试指向不存在的 bug。
   */
  const OPACITY_ONLY = ['fadeIn', 'fadeOut'];
  const PURE_MOTION = ['pinned', 'float', 'sway', 'drift', 'breathe', 'orbit', 'pushIn'];
  const ENTRY_EXIT = ['rise', 'sink', 'scatter', 'exitDown'];

  const pathsOf = (name: string) => expandPreset({ preset: name }).map((t) => t.path);
  const present = (list: string[]) => list.filter((n) => presetNames().includes(n));

  it('三个分类覆盖了全部预设（新增预设时这里会失败，提醒你去归类）', () => {
    const classified = new Set([...OPACITY_ONLY, ...PURE_MOTION, ...ENTRY_EXIT]);
    const unclassified = presetNames().filter((n) => !classified.has(n));
    expect(unclassified, `这些预设没有归类: ${unclassified.join(', ')}`).toEqual([]);
  });

  it.each(present(OPACITY_ONLY))('纯淡入淡出 "%s" 只动 opacity', (name) => {
    expect(pathsOf(name)).toEqual(['opacity']);
  });

  it.each(present(PURE_MOTION))('纯运动预设 "%s" 绝不碰 opacity', (name) => {
    expect(pathsOf(name)).not.toContain('opacity');
  });

  it.each(present(ENTRY_EXIT))('入场/退场预设 "%s" 必须动 opacity', (name) => {
    // 入场没有透明度变化就没有视觉信号 —— 只位移会看起来像"原本就在那"
    expect(pathsOf(name)).toContain('opacity');
  });

  it('breathe 只动 scale', () => {
    const paths = pathsOf('breathe');
    expect(paths.every((p) => p.startsWith('scale'))).toBe(true);
  });

  it('float 只动 position.y', () => {
    expect(pathsOf('float')).toEqual(['position.y']);
  });

  it('pinned 什么都不动', () => {
    expect(expandPreset({ preset: 'pinned' })).toEqual([]);
  });
});

/* ------------------------------------------------------------ 参数 */

describe('range 与 intensity', () => {
  it('range 把关键帧映射到窗口内', () => {
    const full = expandPreset({ preset: 'float' });
    const half = expandPreset({ preset: 'float', range: [0.5, 1] });

    const ts = (tracks: typeof full) => tracks[0].keyframes.map((k) => k.t);
    expect(Math.min(...ts(full))).toBeCloseTo(0, 6);
    expect(Math.min(...ts(half))).toBeCloseTo(0.5, 6);
    expect(Math.max(...ts(half))).toBeLessThanOrEqual(1);
  });

  it('range 之外的窗口不改变轨道条数', () => {
    const a = expandPreset({ preset: 'sway', range: [0, 1] });
    const b = expandPreset({ preset: 'sway', range: [0.3, 0.7] });
    expect(b.length).toBe(a.length);
  });

  it('intensity 缩放幅度', () => {
    const amp = (i: number) => {
      const tr = expandPreset({ preset: 'float', intensity: i })[0];
      const vals = tr.keyframes.map((k) => k.value);
      return Math.max(...vals) - Math.min(...vals);
    };
    expect(amp(0.5)).toBeCloseTo(amp(1) * 0.5, 6);
    expect(amp(2)).toBeCloseTo(amp(1) * 2, 6);
  });

  it('intensity = 0 → 幅度为 0（等价于静止，但轨道仍在）', () => {
    const tr = expandPreset({ preset: 'float', intensity: 0 })[0];
    const vals = tr.keyframes.map((k) => k.value);
    expect(Math.max(...vals) - Math.min(...vals)).toBeCloseTo(0, 9);
  });

  it('循环预设收尾回到起点（否则窗口结束时会跳一下）', () => {
    // 区间外求值器是**钳制**的：若收尾不回 0，窗口一结束对象会"咔"地跳回基准位置。
    // 只有 oscillate 生成的预设才满足这条 —— drift / pushIn 是单向的，见下一条。
    for (const name of ['float', 'sway', 'breathe', 'orbit']) {
      if (!presetNames().includes(name)) continue;
      for (const tr of expandPreset({ preset: name })) {
        const first = tr.keyframes[0].value;
        const last = tr.keyframes[tr.keyframes.length - 1].value;
        expect(last, `${name}/${tr.path} 收尾值 ${last} 没回到起点 ${first}`).toBeCloseTo(first, 6);
      }
    }
  });

  it('单向预设**故意**不收尾回起点（这是它的语义，不是缺陷）', () => {
    // drift 的注释写着"单向，不收尾回零 —— 用于一直往某处走的感觉"。
    // 第一版把它放进了循环列表，于是误报 FAIL。
    for (const name of ['drift', 'pushIn']) {
      if (!presetNames().includes(name)) continue;
      const tracks = expandPreset({ preset: name });
      const movedAway = tracks.some((tr) => {
        const first = tr.keyframes[0].value;
        const last = tr.keyframes[tr.keyframes.length - 1].value;
        return Math.abs(last - first) > 1e-6;
      });
      expect(movedAway, `${name} 应当有单向位移`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------ 确定性 */

describe('确定性', () => {
  it('同样输入永远同样输出', () => {
    for (const name of presetNames()) {
      const a = expandPreset({ preset: name, range: [0.2, 0.8], intensity: 1.3 });
      const b = expandPreset({ preset: name, range: [0.2, 0.8], intensity: 1.3 });
      expect(JSON.stringify(a), `${name} 展开结果不稳定`).toBe(JSON.stringify(b));
    }
  });

  it('展开是幂等的（二次展开不改变结果）', () => {
    const once = expandPreset({ preset: 'scatter' });
    const twice = expandPreset({ tracks: once });
    expect(twice).toBe(once);
  });

  it('预设名列表稳定且无重复', () => {
    const names = presetNames();
    expect(new Set(names).size).toBe(names.length);
  });
});
