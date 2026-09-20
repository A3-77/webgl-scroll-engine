/**
 * 极简 store —— 接口刻意对齐 zustand 的 `subscribeWithSelector`。
 *
 * 为什么不直接装 zustand？
 *   1. 真实站点用的是 zustand 风格的 store（`create()(set=>({...}))` + `subscribe(selector, cb)`），
 *      但本 Demo 只需要「getState / setState / subscribe(selector)」三件事，40 行就够。
 *   2. 依赖越少，`npm install` 越不容易出问题。
 *
 * 想换成 zustand：把本文件删掉，sectionStore.ts 里换成
 *   import { create } from 'zustand';
 *   import { subscribeWithSelector } from 'zustand/middleware';
 * 语义完全一致，其余代码不用动。
 */

type Listener<T> = (state: T, prev: T) => void;

export interface Store<T extends object> {
  getState(): T;
  setState(partial: Partial<T> | ((state: T) => Partial<T>)): void;
  /**
   * 订阅某个切片。selector 返回值用 Object.is 比较，没变就不触发。
   * 3D 渲染循环里不要用这个 —— 直接 getState()，避免每帧分配闭包。
   */
  subscribe<S>(selector: (state: T) => S, listener: (value: S, prev: S) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();

  return {
    getState: () => state,

    setState(partial) {
      const patch = typeof partial === 'function' ? (partial as (s: T) => Partial<T>)(state) : partial;

      // 浅比较：全部相等就完全不通知，避免滚动时无意义的 re-render
      let changed = false;
      for (const k in patch) {
        if (!Object.is((state as Record<string, unknown>)[k], (patch as Record<string, unknown>)[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;

      const prev = state;
      state = { ...state, ...patch };
      listeners.forEach((l) => l(state, prev));
    },

    subscribe(selector, listener) {
      let current = selector(state);
      const wrapped: Listener<T> = (s) => {
        const value = selector(s);
        if (!Object.is(value, current)) {
          const prev = current;
          current = value;
          listener(value, prev);
        }
      };
      listeners.add(wrapped);
      return () => {
        listeners.delete(wrapped);
      };
    },
  };
}
