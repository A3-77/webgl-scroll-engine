import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Store } from '../store/createStore';

/**
 * 把自建 store 接到 React。
 *
 * ★ selector 必须返回「原始值」（number / string / boolean / null）。
 *   返回对象的话，每次 getSnapshot 都是新引用，Object.is 永远不相等，
 *   会直接变成无限重渲染。
 *
 * ★ 3D 渲染循环里不要用这个 hook —— 那里直接 `sectionStore.getState()` 读，
 *   否则 60fps 下每秒会触发 60 次 React 更新，白白吃掉主线程。
 *   这个 hook 只给 DOM 覆盖层（章节文案、调试面板）用。
 */
export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe((s) => selectorRef.current(s), onChange),
    [store],
  );

  const getSnapshot = useCallback(() => selectorRef.current(store.getState()), [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
