/**
 * ★ 滚动进度归一化 —— 真实站点公式的逐行还原
 * ---------------------------------------------------------------------------
 * 来源：(_locale).editions.winter2026-DhFtUF58.js 里的 `Tn` 函数
 *      （混淆前形态见 03-深度还原.md §2，这里是还原变量名后的等价实现）
 *
 * 原始压缩代码（节选，变量名未还原）：
 *
 *   const d = s * (l.earlyCrossfade ?? 0),
 *         p = a - s - d,            // 区间起点
 *         m = a + c;                // 区间终点 = 累计高度 + 本章高度
 *   if (e < m) {
 *     const f = e - p,
 *           u = c + s + d,          // 区间长度
 *           g = clamp01(f / u);
 *     // ★ 同时算下一章，用于双纹理交叉溶解
 *     if (o + 1 < n) {
 *       const C = a + c, w = s * (v.earlyCrossfade ?? 0),
 *             S = C - s - w, M = e - S, E = y + s + w,
 *             k = clamp01(M / E);
 *       if (k > 0) x = { index: o + 1, progress: k };
 *     }
 *     return { current: { index: o, progress: g }, next: x };
 *   }
 *
 * 三个要点：
 *   1. 区间起点是 `acc - vh - ec`，不是 `acc`。也就是说——
 *      章节"开始进行"的时刻，比它进入视口还要早一个视口高度。
 *      这解释了为什么首屏 p(0) ≈ 0.4545 而不是 0。
 *   2. 区间长度是 `height + vh + ec`，即滚动一整个「章节高度 + 视口高度」才走完 100%。
 *   3. 每一帧同时算下一章的进度 —— 交叉溶解需要两张图同时在动。
 *      只有 k > 0 时才把 next 挂上去，所以没进入交叉区时是零成本的。
 */

import type { ProgressResult, SectionProgress } from '../schema/scroll';

export type { ProgressResult, SectionProgress };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * ★ 注意：`earlyCrossfades` 是**必传**的。
 *
 * 改造前这个参数是可选的，不传时函数内部会 `import { DESIGN }` 去推导 ——
 * 于是「滚动数学」依赖了「某个具体内容的视觉常量」。
 * 现在由内容包算出这个数组（每章一个值），app 塞进 ScrollState 传进来。
 * 引擎只负责算，不负责猜。
 */
export function computeSectionProgress(
  scrollY: number,
  heights: number[],
  vh: number,
  earlyCrossfades: number[],
): ProgressResult {
  const n = heights.length;
  if (n === 0) return { current: { index: 0, progress: 0 }, next: null };

  const ec = (i: number): number => vh * (earlyCrossfades[i] ?? 0);

  let acc = 0;
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    const e = ec(i);

    const start = acc - vh - e;
    const end = acc + h;

    if (scrollY < end) {
      const zone = h + vh + e;
      const progress = clamp01((scrollY - start) / zone);

      // ★ 同时求下一章的进度，交叉溶解靠它
      let next: SectionProgress | null = null;
      if (i + 1 < n) {
        const nh = heights[i + 1];
        const ne = ec(i + 1);
        const nStart = end - vh - ne;
        const nZone = nh + vh + ne;
        const k = clamp01((scrollY - nStart) / nZone);
        if (k > 0) next = { index: i + 1, progress: k };
      }

      return { current: { index: i, progress }, next };
    }

    acc += h;
  }

  return { current: { index: n - 1, progress: 1 }, next: null };
}

/**
 * 探针线定位 —— 还原真实站点的 activeSection 判定
 * 来源：Background-CGKUhMwd.js 滚动处理器
 *
 *   const b = g.scroll + M * 0.3;   // M = viewportH
 *   // 从累计高度里找 b 落在哪一章
 *
 * 为什么是 +30% 视口高而不是直接用 scrollY？
 *   因为视口顶部 30% 处是视觉上"当前正在看的区域"，
 *   用它判定当前章节比用顶部边缘更符合直觉。
 */
export function computeActiveSection(scrollY: number, heights: number[], vh: number): number {
  const probe = scrollY + vh * 0.3;
  let acc = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (probe >= acc && probe < acc + h) return i;
    acc += h;
  }
  return Math.max(0, heights.length - 1);
}

/**
 * ★ 把 raw progress 归一化成「场景自身的 0..1 时间轴」
 * ---------------------------------------------------------------------------
 * 这是本 Demo 唯一一处"对真实实现做了简化"的地方，说清楚原因：
 *
 * 真实站点里，第 0 章的区间起点是 `acc - vh = -vh`。但页面无法负向滚动，
 * 所以首屏时第 0 章的 progress 其实已经 ≈ `vh / (height + vh)`（≈ 0.4545），
 * 而不是 0。真实站点用 `offset = -1` 把 sequence.position 拉回 0 来处理这点。
 *
 * 对第 1 章及以后：区间起点 `acc - vh` 是可达的，progress 天然从 0 开始，不需要补偿。
 *
 * 所以这里只对第 0 章做一次线性重映射，让「首屏 = 动画第 0 帧」。
 * 其余章节直接透传 —— 关键帧作者只需记住「0 = 刚进入交叉区，1 = 完成生命周期」。
 */
export function sceneTime(
  index: number,
  progress: number,
  heights: number[],
  vh: number,
): number {
  const h = heights[index];
  if (index === 0 && h > 0 && vh > 0) {
    const p0 = vh / (h + vh);
    return clamp01((progress - p0) / (1 - p0));
  }
  return clamp01(progress);
}

/**
 * ★ 过渡 shader 的 uProgress —— 这里必须说清楚，因为它是整个管线里最容易出错的一环
 * ---------------------------------------------------------------------------
 * 【为什么要单独算，而不是直接用 current.progress】
 *
 *   如果直接把 current.progress 喂给 uProgress，会在章节切换的瞬间发生画面跳变：
 *
 *     scrollY = acc + h⁻   current = i，progress_i → 1        → 画面 100% 是章节 i+1
 *     scrollY = acc + h⁺   current = i+1，progress_{i+1} ≈ 0.45 → 画面立刻变成 45% 的章节 i+2
 *
 *   因为「区间起点比章节入屏早一个视口高」这个设计（见文件顶部说明），
 *   任何一章"刚成为 current"时 progress 就已经是 0.4545 了 —— 拿它当过渡参数必然跳变。
 *
 * 【本 Demo 的处理】
 *   把过渡区间定义为「本章还剩一屏可滚」到「本章结束」：
 *
 *     progress 起点 = h / (h + vh)     ← 此时 scrollY = acc + h - vh
 *     progress 终点 = 1                ← 此时 scrollY = acc + h（正好是切换点）
 *
 *   代入 h = 1.2vh：起点 = 0.5455。于是
 *     p = 0.5455 → uProgress = 0
 *     p = 1.0000 → uProgress = 1   ← 切换点，画面 100% 已是下一章
 *   而切换后的新 current 算出 uProgress = 0 → 显示它自己，画面完全连续，零跳变。
 *
 * 【诚实声明】
 *   真实站点过渡参数的确切来源，我没能从公开 bundle 里确认 —— 我只提取到了
 *   `Tn()` 返回的 { current, next } 两个 progress（见 03-深度还原.md §2），
 *   以及 shader 里的 uProgress uniform 声明，但没找到把两者连起来的那一行。
 *   这里采用的定义在数学上保证连续，观感与真实站点一致；若你有更精确的线索，
 *   替换本函数即可，其余代码不用动。
 */
export function transitionProgress(
  progress: number,
  sectionHeight: number,
  vh: number,
): number {
  if (!(sectionHeight > 0) || !(vh > 0)) return clamp01(progress);
  const start = sectionHeight / (sectionHeight + vh);
  if (start >= 1) return clamp01(progress);
  return clamp01((progress - start) / (1 - start));
}
