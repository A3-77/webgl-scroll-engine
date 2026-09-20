/**
 * ★ Schema —— 滚动状态契约
 * ---------------------------------------------------------------------------
 * 引擎每帧需要知道的**全部滚动信息**，就这一个对象。
 *
 * 改造前，`Composer.render()` 里直接 `import { sectionStore }` 读全局 store ——
 * 也就是「渲染管线」依赖了「应用状态管理」。这带来两个实际问题：
 *   1. 引擎没法脱离 React/store 单独测试
 *   2. 想换一套状态方案（zustand / jotai / 原生）就得改引擎
 *
 * 现在 Composer 只接受一个 `() => ScrollState` 的取值函数。
 * 谁来提供这个函数是 app 装配层的事。
 * ---------------------------------------------------------------------------
 *
 * 【进度计算的完整链路】
 *
 *   lenis.scroll（平滑后的 scrollY）
 *        ↓  computeSectionProgress()
 *   { current: {index, progress}, next: {index, progress} | null }
 *        ↓  sceneTime()          ← 把 raw progress 归一化到场景自身时间轴
 *   sceneTime 0..1
 *        ↓  evaluateTracks()
 *   相机 / 对象 / shader 的每一帧属性值
 *
 *   next 的存在是「双场景交叉溶解」的前提 —— 必须两张图同时在动，
 *   阈值场才能做出"两个场景互相咬合"的溶解，而不是简单的透明度渐变。
 */

export interface SectionProgress {
  index: number;
  /** 0..1 */
  progress: number;
}

export interface ProgressResult {
  current: SectionProgress;
  /** 正在参与交叉溶解的下一章；null = 当前没有交叉 */
  next: SectionProgress | null;
}

export interface ScrollState {
  /** Lenis 平滑后的滚动位置（不是原生 scrollY —— 原生值会抖） */
  scrollY: number;
  /** 视口高度（px） */
  viewportH: number;
  /** 各章节 DOM 实测高度（px），启动后由 ScrollSections 回填 */
  heights: number[];
  /**
   * 每章的交叉溶解提前量（vh 倍数），与 heights 等长。
   *
   * 为什么是数组而不是从 DESIGN 里现算：
   *   改造前 scrollProgress.ts 直接 import DESIGN 来推导，
   *   于是「滚动数学」依赖了「某个具体内容的视觉常量」。
   *   现在是内容包算出这个数组、由 app 塞进 state —— 引擎只管用。
   */
  earlyCrossfades: number[];
  /**
   * 探针线命中的章节。
   * 真实实现：探针线 = scrollY + viewportH * 0.3
   * 用它判定"当前正在看哪一章"比用视口顶部边缘更符合直觉。
   */
  activeSection: number;
  current: SectionProgress;
  next: SectionProgress | null;
  /** 归一化鼠标位置，0..1，供过渡 shader 的 uMouse 使用 */
  mouse: [number, number];
}
