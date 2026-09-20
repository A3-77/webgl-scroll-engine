import type { ScrollState } from '../schema/scroll';
import { createStore } from './createStore';

/**
 * 应用级状态。
 *
 * 这是**唯一的全局状态容器**，DOM 层与 3D 循环都从这里读。
 *
 * 【为什么 3D 循环不该直接 import 它】
 *   `Composer` 现在通过构造参数接受一个 `() => ScrollState` 取值函数，
 *   由 app 层注入 `() => sectionStore.getState()`。
 *   所以 store 是"装配层的东西"，不是"引擎的东西" —— 引擎可以脱离它单独测试。
 *   这是 PHASE 1 消除的一处耦合，别再加回去。
 *
 * 【改造说明】改造前本文件自带 `SectionProgress` / `ProgressResult` 定义，
 *   与 `animation/scrollProgress.ts` 里那份重复。现在统一到 schema/scroll.ts。
 */
export interface SectionState extends ScrollState {
  /** 首帧是否已渲染完成 */
  ready: boolean;
  /** 素材是否全部就绪 */
  loaded: boolean;
  /** 初始化失败时的错误信息（WebGL2 缺失、素材 404 等） */
  error: string | null;
  /** 内容包回落提示（请求的包不存在时） */
  contentWarning: string | null;
}

export const sectionStore = createStore<SectionState>({
  scrollY: 0,
  viewportH: typeof window !== 'undefined' ? window.innerHeight : 800,
  heights: [],
  earlyCrossfades: [],
  activeSection: 0,
  current: { index: 0, progress: 0 },
  next: null,
  mouse: [0.5, 0.5],
  velocity: 0,
  ready: false,
  loaded: false,
  error: null,
  contentWarning: null,
});

/**
 * 只读快照 —— 引擎每帧调用它。
 * 刻意做成"取整个 state 对象"而不是"取某个字段"：每帧多次 getState 的分配开销
 * 远小于为每个字段建一个订阅。别在这里做任何计算。
 */
export const getScrollState = (): ScrollState => sectionStore.getState();
