import * as THREE from 'three';
// ★ 必须用 SkeletonUtils.clone，不能用 Object3D.clone()。
//   普通 clone 不会重建 SkinnedMesh 与 Skeleton/Bone 的绑定关系，
//   蒙皮模型克隆出来会塌成一团、或者完全不动。
//   注意 three r181 这里是**具名导出**（不是 SkeletonUtils 命名空间）。
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CameraConfig, SceneConfig, SceneObjectConfig, Track } from '../schema';
import { tracksOf } from '../schema';
import type { ModelAsset } from './loaders';
import { CameraSystem } from './systems/CameraSystem';
import { ObjectAnimationSystem } from './systems/ObjectAnimationSystem';
import { resolveParallax } from './systems/ParallaxSystem';

/**
 * 按 config 构建一个可渲染的场景。
 *
 * ★ 关于"视差是怎么来的" —— 这是整个 2.5D 效果的原理，值得说清楚：
 *
 *   真实站点实测（three devtools 钩子抓的运行时场景图）：
 *     asset-1  Group  position(-0.233, 0.141, -7.09)  scale(2,2,3)
 *     asset-2  Group  position(0, 0, -25.46)          scale 18.901
 *
 *   注意这两个平面的 z 差了 18 个单位。配一台 PerspectiveCamera 时，
 *   相机往前推 1 个单位，z=-7 的层在屏幕上放大的倍率远大于 z=-25 的层 ——
 *   视差不需要写任何代码，它是透视投影的几何后果，是硬件免费给的。
 *
 *   所以这里刻意"不在每帧重算尺寸"。平面的世界尺寸只在初始化时按
 *   「起始相机状态」定一次，之后相机怎么动都不改 —— 一旦每帧按当前距离重算，
 *   平面就会跟着相机一起缩放，视差会被完全抵消掉（这是最容易踩的坑）。
 *
 * ---------------------------------------------------------------------------
 * 两种图层
 * ---------------------------------------------------------------------------
 *   plane —— 贴图平面，MeshBasicMaterial，无光照。用于背景/中景/前景的 2D 分层
 *   model —— GLB 模型，按包围盒归一化缩放居中。用于原站真实素材
 *
 * 两者可以混在一个场景里。原站的实际构成就是「KTX2 背景平面 + GLB 前景模型」。
 */

export interface BuiltLayer {
  config: SceneObjectConfig;
  /** 位置由轨道驱动的那个节点（plane 是 mesh 本身，model 是外层 group） */
  object: THREE.Object3D;
  /** 仅 plane */
  mesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** 仅 model：归一化后的内层节点（居中 + 缩放） */
  inner?: THREE.Object3D;
  /** 仅 model：模型原始包围盒的高度（世界单位），setAspect 时用来重算缩放 */
  modelSizeY?: number;
  /** 仅 model：把归一化缩放重设到指定目标高度（setAspect 时调用） */
  applyModelScale?: (targetHeight: number) => void;
  /** 仅 model：动画混合器 + 总时长。动画由滚动进度 scrub */
  mixer?: THREE.AnimationMixer;
  clipDuration?: number;
  /** 基准状态下该深度处「刚好铺满视口」的世界高度。轨道数值的 1.0 = 一个视口高 */
  baseVisibleH: number;
  /** 基准位置（config 里的 offset），轨道位移叠加在它之上 */
  baseX: number;
  baseY: number;
  /** 该对象的生效轨道（已展开预设） */
  tracks: Track[];
  /** 视差强度倍率（1 = 完全由 z 深度自然产生） */
  parallax: number;
  /** 每帧复用的求值缓存，避免 60fps 下疯狂分配对象 */
  values: Record<string, number>;
}

export interface BuiltScene {
  config: SceneConfig;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  layers: BuiltLayer[];
  /** 按归一化时间轴 0..1 更新相机与所有对象 */
  applyTime(t: number, dt?: number): void;
  /** 视口比例变化时重算几何与缩放 */
  setAspect(aspect: number): void;
  /** 重新构图后整体替换相机配置（会同步给 CameraSystem） */
  applyCameraConfig(config: CameraConfig): void;
  dispose(): void;
}

function textureAspect(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  if (image?.width && image?.height) return image.width / image.height;
  return 1;
}

/** 该深度处「视口在世界空间的高度」—— 所有位移数值的单位 */
function visibleHeightAt(config: SceneConfig, z: number, aspect: number): number {
  void aspect;
  const baseDist = Math.abs(config.camera.z - z);
  return 2 * Math.tan(THREE.MathUtils.degToRad(config.camera.fov) / 2) * baseDist;
}

/**
 * 算一个平面图层的世界尺寸。
 *
 * ★ fit 的语义严格对齐 CSS 的 object-fit：
 *     cover   → 铺满视口，**保持贴图宽高比**，超出部分裁掉（可能裁切）
 *     contain → 完整放进视口，**保持贴图宽高比**，不裁切（可能留边）
 *
 *   ⚠️ cover 这里踩过一次：最初写成了 `width = viewW; height = visibleH`，
 *   也就是**直接拉伸铺满、不管宽高比**。结果 1.563 的贴图被拉到 2.117 的视口上，
 *   横向拉伸 1.35 倍，画面肉眼可见地变形，背景左边还露出一条黑边。
 *   "cover" 和 "stretch" 是两回事，别混。
 *
 * visibleH 始终返回「视口在该深度处的高度」——
 * 它是轨道位移的单位（1.0 = 移动一个视口高），与平面自身尺寸无关。
 */
function computePlaneSize(
  config: SceneConfig,
  layer: SceneObjectConfig,
  texture: THREE.Texture,
  aspect: number,
): { width: number; height: number; visibleH: number } {
  const visibleH = visibleHeightAt(config, layer.z, aspect);
  const viewW = visibleH * aspect;
  const texAspect = textureAspect(texture);

  let width: number;
  let height: number;

  if ((layer.fit ?? 'cover') === 'contain') {
    // 按高度放入，宽度超了改按宽度放入 —— 取"更小"的那个方向
    height = visibleH;
    width = height * texAspect;
    if (width > viewW) {
      width = viewW;
      height = width / texAspect;
    }
  } else {
    // cover：按宽度铺满，高度不足就改按高度铺满 —— 取"更大"的那个方向
    width = viewW;
    height = width / texAspect;
    if (height < visibleH) {
      height = visibleH;
      width = height * texAspect;
    }
  }

  return {
    width: width * layer.overscan,
    height: height * layer.overscan,
    visibleH,
  };
}

/**
 * 把模型归一化：几何中心移到原点，高度缩放到 targetH。
 *
 * 为什么必须归一化：37 个模型出自不同美术之手，单位尺度完全不统一
 * （有的包围盒高度 0.5，有的 40）。不归一化的话，换个模型就得手工试 scale，
 * 而且相机取景也会完全不同。归一化之后，"modelHeight" 这一个数就够构图了。
 */
function normalizeModel(
  inner: THREE.Object3D,
  targetH: number,
): { sizeY: number; applyScale: (h: number) => void } {
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const sizeY = size.y || 1;

  // 先归零：把几何中心搬到原点
  inner.position.set(-center.x, -center.y, -center.z);

  // 再把缩放放到一个外层节点上，避免和 position 互相干扰
  const applyScale = (h: number): void => {
    const s = h / sizeY;
    inner.scale.setScalar(s);
    // position 也要跟着缩放（因为 position 是在父节点空间里生效的）
    inner.position.set(-center.x * s, -center.y * s, -center.z * s);
  };
  applyScale(targetH);

  return { sizeY, applyScale };
}

/**
 * ★ 光照强度 —— 这里踩过一个坑，值得说清楚。
 *
 * 原站 19/37 个模型用 `KHR_materials_unlit`（无光照），但**首屏那几个大模型不是**：
 * 实测 Hero / Sidekick / Operations 三个都只带 Draco + KTX2 扩展，
 * 也就是说它们用的是 PBR 材质，必须打光才看得见。
 *
 * 原站自己的光照参数是抓不到的（不在 GLB 里，也没有 KHR_lights_punctual），
 * 所以只能自己定。第一版给的是 ambient 2.4 + key 2.2 + rim 1.0 ——
 * 人物的白色衣服直接过曝成一块死白。
 *
 * 光靠调低强度治标不治本：three r155 之后光照走物理单位，
 * 而且这个管线是 sRGB 直通，**没有高光滚降**，任何超过 1.0 的像素都被截断。
 * 真正的解法是在渲染器上开 NeutralToneMapping（见 CanvasHost.tsx）——
 * 平面材质显式关掉了色调映射所以仍是直通，只有模型吃到滚降。
 *
 * 有了滚降之后，光可以给得足一点，形体才出得来。下面这组值是实测定下来的。
 */
const LIGHTS = {
  /** 环境光：决定暗部亮度。太高会让模型失去体积感 */
  ambient: 1.05,
  /** 主光：唯一产生明暗交界的光，负责形体 */
  key: 1.6,
  /** 补光：从反方向压一点，避免暗部死黑 */
  rim: 0.45,
} as const;

export function buildScene(
  config: SceneConfig,
  textures: Map<string, THREE.Texture>,
  models: Map<string, ModelAsset>,
  aspect: number,
): BuiltScene {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(config.camera.fov, aspect, 0.1, 1000);
  camera.position.set(0, 0, config.camera.z);
  scene.add(camera);

  // 光照：PBR 模型需要，MeshBasicMaterial 的平面完全不受影响 —— 所以无条件加上是安全的
  scene.add(new THREE.AmbientLight(0xffffff, LIGHTS.ambient));
  const keyLight = new THREE.DirectionalLight(0xffffff, LIGHTS.key);
  keyLight.position.set(2.5, 4, 6);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, LIGHTS.rim);
  rimLight.position.set(-3.5, -2.5, 2);
  scene.add(rimLight);

  const layers: BuiltLayer[] = config.objects.map((layerConfig, i) => {
    const visibleH0 = visibleHeightAt(config, layerConfig.z, aspect);
    const baseX = layerConfig.offset[0] * visibleH0 * aspect;
    const baseY = layerConfig.offset[1] * visibleH0;
    // 该对象的生效轨道 + 视差倍率（缺省值由 ParallaxSystem 统一给，别在各处写 ?? 1）
    const tracks = tracksOf(layerConfig);
    const parallax = resolveParallax(layerConfig);

    /* ------------------------------------------------ 模型图层 */
    if (layerConfig.type === 'model') {
      const asset = models.get(layerConfig.asset);
      if (!asset) {
        throw new Error(
          `[SceneBuilder] 模型缺失: ${layerConfig.asset}（场景 ${config.id} / 图层 ${layerConfig.id}）。` +
            `确认 assets-original/models/ 下有该文件，且 assets.ts 里声明了 kind: 'glb'。`,
        );
      }

      // ★ 必须用 SkeletonUtils.clone，普通 .clone() 不会重建骨骼绑定，
      //   蒙皮模型会塌成一团或者完全不动。
      const cloned = cloneSkinned(asset.scene) as THREE.Group;

      const group = new THREE.Group();
      const targetH = (layerConfig.modelHeight ?? 0.9) * visibleH0;
      const { sizeY, applyScale } = normalizeModel(cloned, targetH);
      group.add(cloned);
      group.position.set(baseX, baseY, layerConfig.z);
      // ★ renderOrder 必须逐个子网格设置。
      //   只设在 group 上没用 —— three 排序的是"渲染项"（每个 Mesh 一个），
      //   而 group 本身不参与渲染。漏了这一步背景会盖住模型。
      group.renderOrder = i;
      cloned.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.renderOrder = i;
      });
      scene.add(group);

      // 动画：由滚动进度 scrub，不是按墙上时钟播
      let mixer: THREE.AnimationMixer | undefined;
      let clipDuration: number | undefined;
      if (layerConfig.scrubAnimations && asset.animations.length) {
        mixer = new THREE.AnimationMixer(cloned);
        // 只播第一段。原站每个模型有多个片段（Hero 有 6 段），
        // 由 Theatre 时间轴决定什么时候切哪一段 —— 这里简化为一段。
        const clip = asset.animations[0];
        mixer.clipAction(clip).play();
        clipDuration = clip.duration;
      }

      return {
        config: layerConfig,
        object: group,
        inner: cloned,
        modelSizeY: sizeY,
        applyModelScale: applyScale,
        mixer,
        clipDuration,
        baseVisibleH: visibleH0,
        baseX,
        baseY,
        tracks,
        parallax,
        values: {},
      };
    }

    /* ------------------------------------------------ 平面图层 */
    const map = textures.get(layerConfig.asset);
    if (!map) {
      throw new Error(
        `[SceneBuilder] 素材缺失: ${layerConfig.asset}（场景 ${config.id} / 对象 ${layerConfig.id}）。` +
          `请确认内容包的 assets 注册表里声明了这个 key，且 public/ 下有对应文件。`,
      );
    }

    // ★ 基准尺寸：用「起始相机状态」算一次，之后相机怎么动都不再重算 ——
    //    一旦每帧按当前距离重算，平面就会跟着相机一起缩放，视差会被完全抵消
    const size = computePlaneSize(config, layerConfig, map, aspect);
    const baseVisibleH = size.visibleH;

    // 尺寸烘进 geometry，把 mesh.scale 完整留给轨道使用
    const geometry = new THREE.PlaneGeometry(size.width, size.height);

    const material = new THREE.MeshBasicMaterial({
      map,
      // ★ 满幅背景标成 opaque 才能和前景模型落进同一个渲染列表（见 LayerConfig.opaque 的注释）
      transparent: !layerConfig.opaque,
      // 纯 2D 分层合成：关掉深度测试，靠 renderOrder 决定前后覆盖
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      // 关掉色调映射 —— 这是一层"图像合成"，不是 PBR 光照，映射会改变原图颜色
      toneMapped: false,
    });

    if (layerConfig.tint) material.color.set(layerConfig.tint);
    if (layerConfig.blending === 'additive') material.blending = THREE.AdditiveBlending;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = i;
    // 顶点着色器/矩阵都在掌控内，关掉剔除避免误判
    mesh.frustumCulled = false;
    mesh.position.set(baseX, baseY, layerConfig.z);

    scene.add(mesh);

    return {
      config: layerConfig,
      object: mesh,
      mesh,
      baseVisibleH,
      baseX,
      baseY,
      tracks,
      parallax,
      values: {},
    };
  });

  /**
   * 按归一化时间轴更新相机与全部对象。
   *
   * 求值本身已经在 CameraSystem / ObjectAnimationSystem 里，
   * 这里只负责"按正确顺序调它们"—— 相机先于对象，
   * 这样对象写进的是本帧最终的相机状态下的场景图。
   *
   * @param t  场景自身的时间轴 0..1
   * @param dt 距上一帧的秒数。仅当相机声明了 damping 时才会用到
   *           （damping 是对求值结果做一阶低通，需要真实的帧间隔）
   */
  function applyTime(t: number, dt = 0): void {
    cameraSystem.apply(t, dt);
    objectSystem.apply(t);
  }

  /**
   * 重新构图后替换相机配置（见 Composer.refreshLayout）。
   *
   * config.camera 是**整体替换**一个新对象，而 CameraSystem 持有的是旧引用，
   * 所以必须显式同步一次，否则相机会一直用旧的轨道跑。
   */
  function applyCameraConfig(next: CameraConfig): void {
    config.camera = next;
    cameraSystem.syncConfig(next);
  }

  function setAspect(next: number): void {
    camera.aspect = next;
    camera.updateProjectionMatrix();

    // ⚠️ 这里**故意不**调 `objectSystem.setAspect(next)`。
    //    拆分前 applyTime 里的 `* aspect` 用的是 buildScene 的入参（Composer 传 1，
    //    之后永不更新），所以轨道位移的 X 一直按「1.0 = 一个视口高」算。
    //    而 presets.ts / compose.ts 两处文档写的是「1.0 = 一个视口宽」——
    //    也就是应该 × aspect。两者不一致，是一个**已存在的行为缺陷**。
    //
    //    这次是纯重构，不夹带观感变化，所以保持原样（继续传构建时的 aspect）。
    //    要修就在这里加一行 `objectSystem.setAspect(next);` ——
    //    代价是横向位移幅度会变成现在的 aspect 倍（2.1 视口下约 2 倍），
    //    需要重新过一遍观感。见 docs/PHASE-4-9-模块化拆分.md 的「已知缺陷」。

    for (const layer of layers) {
      const visibleH = visibleHeightAt(config, layer.config.z, next);
      layer.baseVisibleH = visibleH;
      layer.baseX = layer.config.offset[0] * visibleH * next;
      layer.baseY = layer.config.offset[1] * visibleH;

      if (layer.config.type === 'model') {
        // 模型：重算归一化缩放（目标高度是「视口高的倍数」，视口变了就得重算）
        layer.applyModelScale?.((layer.config.modelHeight ?? 0.9) * visibleH);
        continue;
      }

      // 平面：重建几何（PlaneGeometry 的宽高是烘在顶点里的，改 aspect 必须重建）
      const map = layer.mesh?.material.map;
      if (!map || !layer.mesh) continue;

      const size = computePlaneSize(config, layer.config, map, next);
      layer.mesh.geometry.dispose();
      layer.mesh.geometry = new THREE.PlaneGeometry(size.width, size.height);
    }
  }

  function dispose(): void {
    objectSystem.dispose();
    for (const layer of layers) {
      if (layer.mesh) {
        layer.mesh.geometry.dispose();
        layer.mesh.material.dispose();
      }
    }
    scene.clear();
  }

  // 系统实例：相机与对象求值各归其位（PHASE 5 / PHASE 7）
  const cameraSystem = new CameraSystem(camera, config.camera);
  const objectSystem = new ObjectAnimationSystem(layers);
  objectSystem.setAspect(aspect);

  // 先跑一次，保证首帧就是正确状态（否则会闪一帧未初始化的画面）
  applyTime(0);

  return { config, scene, camera, layers, applyTime, setAspect, applyCameraConfig, dispose };
}
