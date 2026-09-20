import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { AssetKind, AssetSource, LoadedAssets, ModelAsset } from '../schema';

export type { LoadedAssets, ModelAsset };
/**
 * 素材加载。
 *
 * ---------------------------------------------------------------------------
 * 三条加载链路
 * ---------------------------------------------------------------------------
 * 真实站点的纹理管线（实测结论，见 03-深度还原.md §8）：
 *   KTX2 容器 + Basis Universal 超压缩 + ZSTD 熵编码 + BC7(BPTC) 块压缩
 *   → GPU 直接上传，零解码开销；不生成 mipmap，anisotropy = 1，flipY = false
 *
 * 几何链路：Draco（WASM，原站用 4 并发 Worker 池）
 *
 * 这里两条都实现了，且**解码器全部本地化** —— three 的 npm 包自带
 * `examples/jsm/libs/{draco,basis}/*.wasm`，构建前拷到 public/decoders/ 即可。
 * 原站是 `setTranscoderPath()` 指向 jsdelivr CDN，仓库要能离线跑，不能那样。
 *
 * ---------------------------------------------------------------------------
 * ★ 色彩空间：整条链路直通，不做任何转换
 * ---------------------------------------------------------------------------
 * 这是个纯"图像合成"场景（平面用 MeshBasicMaterial，模型多为 unlit），
 * 渲染器的 outputColorSpace 设成 LinearSRGBColorSpace，等价于"原样输出"。
 *
 * 于是贴图也必须按原样采样 —— 但 GLTFLoader 会把 baseColor 贴图标成 sRGB，
 * 那样 three 会在着色器里做一次 sRGB→linear 解码，而输出端又不重新编码，
 * 结果就是**模型整体偏暗**。
 *
 * 所以加载完 GLB 后要遍历一遍，把颜色贴图改回 LinearSRGBColorSpace，
 * 并关掉 toneMapping。这样 PNG 占位素材和 GLB 真实素材走的是同一条色彩通路，
 * 两者混在一个页面里也不会一个亮一个暗。
 *
 * 【改造说明】`ModelAsset` / `LoadedAssets` 的定义已移到 `schema/asset.ts` ——
 *   它们是引擎与内容之间的契约，不该定义在引擎实现里。
 *   本文件重新导出，保持 `from './loaders'` 的既有 import 路径可用。
 */

/* ------------------------------------------------------- 解码器（单例） */

let dracoLoader: DRACOLoader | null = null;
let ktx2Loader: KTX2Loader | null = null;

function basePath(): string {
  const b = (import.meta.env.BASE_URL as string | undefined) || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

/** Draco 解码器。首次调用时创建，之后复用（wasm 初始化不便宜） */
export function getDracoLoader(): DRACOLoader {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader().setDecoderPath(`${basePath()}decoders/draco/`);
  }
  return dracoLoader;
}

/** KTX2 转码器。必须 `detectSupport(renderer)` 之后才能 load —— 它要探测 GPU 支持哪些压缩格式 */
export function getKTX2Loader(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!ktx2Loader) {
    ktx2Loader = new KTX2Loader()
      .setTranscoderPath(`${basePath()}decoders/basis/`)
      .detectSupport(renderer);
  }
  return ktx2Loader;
}

/* ------------------------------------------------------------ 贴图设置 */

/**
 * 对齐真实站点的采样器设置。
 *
 * 实测原站：不生成 mipmap、anisotropy = 1、ClampToEdge、LinearFilter。
 * 这不是"省事"，而是**刻意的**：这些图是 1:1 铺满视口的，永远不会被缩小到
 * 需要 mipmap 的程度，生成它只是白白多占 33% 显存。
 *
 * ★ 但这条结论**只对"铺满视口的大图"成立**。
 *   素材流水线切出来的主体 PNG（一只猫占画面 1/6）会被**显著缩小**渲染，
 *   没有 mipmap 就会闪烁（minification aliasing）。
 *   所以采样器设置改成按资产声明：
 *     mipmaps 缺省 false（保持原站行为，大图不浪费显存）
 *     主体 PNG 显式声明 mipmaps: true
 */
function applySamplerSettings(texture: THREE.Texture, mipmaps: boolean): void {
  // ★ sRGB 直通：见文件头说明。整条链路不做线性化。
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = mipmaps;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
}

/* -------------------------------------------------------------- 加载器 */

async function loadImage(
  key: string,
  source: AssetSource,
  mipmaps: boolean,
): Promise<THREE.Texture> {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const texture = await loader.loadAsync(source.resolve(key));
  applySamplerSettings(texture, mipmaps);
  return texture;
}

async function loadKtx2(
  key: string,
  source: AssetSource,
  renderer: THREE.WebGLRenderer,
  mipmaps: boolean,
): Promise<THREE.Texture> {
  const loader = getKTX2Loader(renderer);
  const texture = await new Promise<THREE.Texture>((resolve, reject) => {
    loader.load(source.resolve(key), resolve, undefined, reject);
  });
  applySamplerSettings(texture, mipmaps);
  return texture;
}

async function loadModel(
  key: string,
  source: AssetSource,
  renderer: THREE.WebGLRenderer,
): Promise<ModelAsset> {
  const loader = new GLTFLoader()
    .setDRACOLoader(getDracoLoader())
    .setKTX2Loader(getKTX2Loader(renderer));

  const gltf = await loader.loadAsync(source.resolve(key));

  // ★ 色彩空间直通（见文件头）。不这么做模型会比占位素材暗一档。
  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    // 蒙皮模型关掉视锥剔除：包围盒不随骨骼更新，动画时会被误裁掉
    if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      mesh.frustumCulled = false;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;

      // ★ 模型保留 toneMapped（默认 true），让渲染器的 NeutralToneMapping 生效。
      //   平面材质是显式关掉色调映射的（纯图像合成，不该被映射改变颜色），
      //   模型则必须开着 —— 否则受光超过 1.0 会直接截断成死白。
      //   两条通路并存正是我们要的：平面直通、模型有高光滚降。

      // 颜色贴图改回"原样采样"；法线/粗糙度等数据贴图本来就该保持线性，不动
      const m = mat as THREE.MeshStandardMaterial;
      if (m.map) m.map.colorSpace = THREE.LinearSRGBColorSpace;
      if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.LinearSRGBColorSpace;

      mat.needsUpdate = true;
    }
  });

  return { scene: gltf.scene, animations: gltf.animations ?? [] };
}

/* ---------------------------------------------------------------- 入口 */

/**
 * 按 key 列表并发加载。返回贴图与模型两张表。
 *
 * 同一个 key 只会加载一次（Map 天然去重）；多个场景引用同一个模型时，
 * 使用方负责 `clone()` —— 因为同一个 Object3D 不能同时挂在两个场景里。
 *
 * @param source 资产来源（端口）。引擎不知道它背后是注册表、CMS 还是 IndexedDB。
 * @param mipmapKeys 需要生成 mipmap 的 key（被显著缩小渲染的主体图）。
 *                   **默认全部关闭** —— 保持原站"大图不生成 mipmap"的行为。
 */
export async function loadAssets(
  keys: string[],
  renderer: THREE.WebGLRenderer,
  source: AssetSource,
  mipmapKeys: ReadonlySet<string> = new Set(),
): Promise<LoadedAssets> {
  const textures = new Map<string, THREE.Texture>();
  const models = new Map<string, ModelAsset>();

  const unique = Array.from(new Set(keys));

  await Promise.all(
    unique.map(async (key) => {
      const kind: AssetKind = source.kind(key);
      try {
        if (kind === 'glb') {
          models.set(key, await loadModel(key, source, renderer));
        } else if (kind === 'ktx2') {
          textures.set(key, await loadKtx2(key, source, renderer, false));
        } else {
          textures.set(key, await loadImage(key, source, mipmapKeys.has(key)));
        }
      } catch (err) {
        // 单个素材失败不该拖垮整站 —— 明确报出是哪个 key，其余继续
        const hint =
          kind === 'ktx2' || kind === 'glb'
            ? '（KTX2/Draco 走的是本地 wasm 解码器，确认 public/decoders/ 存在）'
            : '';
        throw new Error(
          `[loaders] 素材加载失败: ${key} (kind=${kind}, path=${source.resolve(key)})${hint}\n` +
            `原因: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  return { textures, models };
}

export function disposeAssets(assets: LoadedAssets): void {
  assets.textures.forEach((t) => t.dispose());
  assets.textures.clear();

  assets.models.forEach((m) => {
    m.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // 贴图由 textures 表统一释放，这里只放材质
        mat.dispose();
      }
    });
  });
  assets.models.clear();
}

/** 释放全局解码器（热重载 / 卸载时调用） */
export function disposeDecoders(): void {
  dracoLoader?.dispose();
  ktx2Loader?.dispose();
  dracoLoader = null;
  ktx2Loader = null;
}
