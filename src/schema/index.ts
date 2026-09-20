/**
 * ★ Schema 统一出口
 * ---------------------------------------------------------------------------
 * 引擎与内容都只从这里 import。任何一方都不该直接 import 对方的文件。
 *
 *   engine/  →  import from '../schema'      ✓
 *   content/ →  import from '../schema'      ✓
 *   engine/  →  import from '../content/...' ✗  禁止
 *   content/ →  import from '../engine/...'  ✗  禁止（loaders 的类型除外，见下）
 *
 * 唯一的例外是 `LoadedAssets` 需要引用 `ModelAsset` —— 那是加载器产物的类型，
 * 属于引擎内部实现细节，schema 里的 import 是 type-only，编译后不产生依赖。
 */

export * from './animation';
export * from './object';
export * from './scene';
export * from './asset';
export * from './scroll';
