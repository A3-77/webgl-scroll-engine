import type { Ease, Keyframe, Track } from '../schema/animation';

/**
 * 关键帧求值器 —— 替代 Theatre.js 运行时。
 *
 * 真实站点用的是 @theatre/core：
 *   13 份 `*.theatre-project-state*.json` 作为 CMS 资产下发（我全量下载了，共 82 对象 / 375 轨道 / 780 关键帧）
 *   运行时 `project.sheet('Scene').sequence.position = <进度>`，Theatre 内部按轨道求值。
 *
 * 这里用 ~40 行复刻同样的语义：
 *   ▸ 每个轨道是一组 (t, value) 关键帧
 *   ▸ t 用 0..1 归一化进度（比 Theatre 的绝对时间轴更好改）
 *   ▸ 段内插值 + 缓动，段外钳制
 *
 * 想换回真正的 Theatre.js：
 *   npm i @theatre/core
 *   把 scenes.ts 的 tracks 转成 theatre 的 trackIdByPropPath 结构，
 *   然后 `sheet.sequence.position = t` 即可 —— 其余代码不用动。
 */

const EASE: Record<Ease, (x: number) => number> = {
  linear: (x) => x,
  easeIn: (x) => x * x,
  easeOut: (x) => 1 - (1 - x) * (1 - x),
  easeInOut: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
};

/** 单条轨道求值。t 超出范围时钳制到首/尾关键帧 */
export function sampleTrack(keyframes: Keyframe[], t: number): number {
  const n = keyframes.length;
  if (n === 0) return 0;
  if (n === 1) return keyframes[0].value;

  if (t <= keyframes[0].t) return keyframes[0].value;
  const last = keyframes[n - 1];
  if (t >= last.t) return last.value;

  for (let i = 0; i < n - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const u = span <= 1e-9 ? 1 : (t - a.t) / span;
      // 缓动取"目标关键帧"上标注的那个
      const eased = (EASE[b.ease ?? 'easeInOut'] ?? EASE.easeInOut)(u);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * 求值一组轨道。
 * out 参数可选，用于避免每帧分配新对象（渲染循环里会调很多次）。
 */
export function evaluateTracks(
  tracks: Track[],
  t: number,
  out: Record<string, number> = {},
): Record<string, number> {
  for (let i = 0; i < tracks.length; i++) {
    out[tracks[i].path] = sampleTrack(tracks[i].keyframes, t);
  }
  return out;
}

/**
 * ★ 还原真实站点的进度 → sequence.position 映射
 * ---------------------------------------------------------------------------
 * 提取自 Effects-WhEp4HUr.js 的 useTheatreSheet：
 *
 *   const scale  = (sectionHeight + viewportH) / viewportH;   // = (h + vh) / vh
 *   const offset = sectionIndex === 0 ? -1 : 0;               // 首屏序曲用
 *   const h = (p) => Math.max(0, p * scale + offset);
 *
 * 为什么首屏要 -1？
 *   因为 progress 的区间起点是 `acc - vh`（见 scrollProgress.ts），
 *   所以页面还没滚动时 p 就已经不是 0 了：
 *     p(0) = vh / (height + vh)
 *   当 height = 1.2vh 时 p(0) = 1/2.2 ≈ 0.4545，
 *   代入 h(p) = 0.4545 * 2.2 - 1 = 0 —— 正好把"首屏未滚动"归零。
 *   这是真实实现里一个很妙的细节，Hero 的入场动画就靠它对齐。
 *
 * 注意：本 Demo 的关键帧 t 用的是 0..1 归一化进度（更好改），
 * 而不是真实站点的 sequence.position（区间是 [0, scale]）。
 * DebugHUD 里会同时显示两者，方便对照。
 */
export function makePositionMapper(
  sectionHeightPx: number,
  viewportH: number,
  sectionIndex: number,
): (progress: number) => number {
  const scale = viewportH > 0 ? (sectionHeightPx + viewportH) / viewportH : 1;
  const offset = sectionIndex === 0 ? -1 : 0;
  return (p: number) => Math.max(0, p * scale + offset);
}
