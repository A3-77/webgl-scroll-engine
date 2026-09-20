/**
 * ★ Schema —— 资产契约
 * ---------------------------------------------------------------------------
 * 定义"资产"这件事本身，以及引擎读取资产的**端口**（AssetSource）。
 *
 * 改造前的问题：`engine/loaders.ts` 直接 import 了
 *     import { type AssetKey, assetKind, resolveAsset } from '../config/assets';
 * 也就是说「通用加载器」依赖了「具体的内容注册表」。换内容就得改加载器。
 *
 * 现在：加载器只认识 `AssetSource` 这个接口，不认识任何具体注册表。
 * 谁来提供 AssetSource 是 app 装配层的事（见 src/app/）。
 * ---------------------------------------------------------------------------
 *
 * 关于 `kind` 为什么要显式声明，而不是让加载器嗅探扩展名：
 *   加载器**没法从扩展名可靠地猜出加载方式** —— `.ktx2` 要走 KTX2Loader + wasm 转码器，
 *   `.glb` 要挂 Draco + KTX2 解码器，普通图走 TextureLoader。
 *   把 kind 写在注册表里，换素材时如果忘了改，加载器会**明确报错**，
 *   而不是静默走错分支产出一个坏纹理。
 */

import type * as THREE from 'three';

export type AssetKind = 'image' | 'ktx2' | 'glb';

export interface AssetDef {
  /** 相对 public/ 的路径 */
  path: string;
  kind: AssetKind;
}

/** 资产注册表：key → 定义。key 是内容侧自己起的名字 */
export type AssetRegistry = Record<string, AssetDef>;

/* ------------------------------------------------------------------ 端口 */

/**
 * 引擎读取资产所需的全部能力。**这是一个端口（port），不是实现。**
 *
 * 引擎只依赖这个接口；具体实现由内容包提供。
 * 好处：以后想换成"从 CMS 拉清单"、"从 IndexedDB 读"、"运行时生成"，
 * 都只需要换一个 AssetSource 实现，引擎一行不用动。
 */
export interface AssetSource {
  /** 把资产 key 解析成可直接喂给加载器的 URL */
  resolve(key: string): string;
  /** 该资产该用哪个加载器 */
  kind(key: string): AssetKind;
  /** 注册表里全部 key（用于预加载、校验、调试面板） */
  keys(): string[];
}

/* ------------------------------------------------------- 运行时资产表 */

/**
 * 一个加载完成的 GLB。
 *
 * 放在 schema 而不是 engine/loaders 里，是为了让 `LoadedAssets` 这个契约
 * 不产生「schema → engine」的反向依赖。引擎与内容都只依赖 schema。
 */
export interface ModelAsset {
  /**
   * 模型场景图。
   * **每次使用都要 clone** —— 同一个 Object3D 不能同时挂在两个 THREE.Scene 里，
   * 而且蒙皮模型必须用 SkeletonUtils.clone（普通 clone 不重建骨骼绑定）。
   */
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/** 加载完成后的资产集合。引擎内部流转用 */
export interface LoadedAssets {
  textures: Map<string, THREE.Texture>;
  models: Map<string, ModelAsset>;
}

/* ------------------------------------------------------------ 生成产物 */

/**
 * 素材流水线（scripts/build-assets/）产出的 manifest 结构。
 *
 * 这是 `input/scene01.jpg` 变成可渲染场景的**中间契约**：
 *   input/*.jpg → 分割 → 透明 PNG → manifest.json → Scene Generator → scenes.json
 *
 * 引擎不直接消费 manifest（那是构建期的东西），
 * 但 Scene Generator 需要它，所以类型放在 schema 里共享。
 */
export interface SubjectManifest {
  /** 主体 id，如 'subject-01' */
  id: string;
  /** 透明 PNG 相对 public/ 的路径 */
  path: string;
  /** 在原图中的包围盒，**归一化到 0..1** */
  box: { x: number; y: number; w: number; h: number };
  /** 主体中心，归一化到 0..1（0.5, 0.5 = 画面正中） */
  center: { x: number; y: number };
  /** 主体宽高比（像素） */
  aspect: number;
  /** 像素面积占比 —— 用来判断谁是"主角" */
  areaRatio: number;
  /** 连通域标记出的像素数 */
  pixelCount: number;
  /**
   * 透明 PNG 的像素尺寸 [宽, 高]。
   *
   * 与 aspect 冗余（aspect = size[0]/size[1]），但**保留两者是有意的**：
   *   ▸ aspect 是给构图用的（算比例）
   *   ▸ size 是给"分辨率够不够"用的（自动构图要按它决定贴图的 mipmap 与放大上限）
   */
  size: [number, number];
}

export interface SceneManifest {
  /** 场景 id，如 'scene01' */
  id: string;
  /** 源图尺寸 */
  source: { width: number; height: number; aspect: number };
  /** 背景图（原图去主体后的 inpaint / 或原图本身）相对 public/ 的路径 */
  background: string;
  /** 分割出的主体列表，按 areaRatio 降序 */
  subjects: SubjectManifest[];
  /** 生成时使用的 provider 名，便于复现与排查 */
  provider: string;
  /** 生成时间（ISO） */
  generatedAt: string;
  /**
   * 背景估计色 [R, G, B]（0..255）。
   *
   * 用途：当作 canvas 底色。素材加载完成前 canvas 是空的，
   * 如果底色是白的而图是浅灰的，会闪一帧白 —— 这类影棚图的背景通常就是浅灰。
   */
  backgroundColor?: number[];
  /**
   * 分割置信度。由 provider 给出，pipeline 透传。
   *
   * ★ 为什么让引擎也看到它：
   *   色键控有明确的适用边界（背景非均匀、主体低对比时会缺块）。
   *   与其让用户到渲染结果里发现"猫少了一块胸"，不如在素材层面就标出来 ——
   *   调试面板会据此显示警告。
   */
  confidence?: 'high' | 'medium' | 'low';
  /** 机器可读的分割诊断量（阈值 / 是否触发自适应 / 对比裕度 …） */
  metrics?: Record<string, number | boolean | string>;
}

export interface ContentManifest {
  version: 1;
  generator?: string;
  generatedAt?: string;
  scenes: SceneManifest[];
  /** 每个场景的人类可读诊断（终端里已经打印过，这里留档） */
  diagnostics?: Record<string, string[]>;
}
