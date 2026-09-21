/**
 * PHASE 23 —— 3D 过渡载体系统
 * ===========================================================================
 * 一个真的 3D 物体飞过画面，而**过渡的溶解边界跟着它走**。
 *
 * ---------------------------------------------------------------------------
 * 【改造前 vs 改造后】
 *
 *   改造前：过渡是纯 2D 的 —— 屏幕上铺一张阈值场，比较
 *   `progress - threshold` 决定每个像素显示 current 还是 next。
 *   边界再活（噪声 + 法线扰动），它也是**没有主体的**：
 *   没有一个"东西"在做这件事。这就是"看起来只是图片转场"的根源。
 *
 *   改造后：一个 3D 载体沿 Catmull-Rom 曲线飞过画面，
 *   阈值场的中心从"固定圆心"换成**载体的屏幕空间位置**。
 *   画面不再是"叠化"，而是"被飞过的东西擦开"。
 *
 *   ▸ 这是 SKY（shader.se）about 场景过渡的核心手法
 *     （一架 3D 飞机沿曲线飞，身上挂着跑过渡 shader 的小平面）
 *
 * ---------------------------------------------------------------------------
 * 【★ 载体为什么不进 currentScene / nextScene】
 *
 *   如果把它挂进某个场景，它会被**自己引发的溶解给溶掉** ——
 *   飞到一半就消失一半，完全读不懂。
 *
 *   所以载体是独立的 `THREE.Scene`，在过渡 blit **之后**、
 *   后处理**之前**叠上去。它永远完整地压在合成好的画面之上。
 *
 *   ▸ 代价：要多一次 render call（只画一个物体，开销可忽略）
 *   ▸ 收益：载体与溶解彻底解耦，谁都不会破坏谁
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么渲染时用 currentScene 的相机】
 *
 *   过渡 shader 里算载体屏幕位置用的是 `uProjectionView`
 *   （= currentScene 相机的 projection × viewInverse）。
 *   载体要画在"shader 以为它在的那个位置"，就必须用**同一个相机**渲染。
 *   用独立相机的话，飞过的物体和它引发的溶解会对不上 ——
 *   看起来像"溶解在跟着一个看不见的东西走"。
 *
 * ---------------------------------------------------------------------------
 * 【★ 路径为什么按相机参数自动生成】
 *
 *   素材驱动的原则是"丢图进去就出网站"。
 *   让用户手写 Catmull-Rom 控制点（还得理解相机 z / fov / 视锥）
 *   等于把门槛抬回"你得懂 three.js"。
 *
 *   所以默认走 preset：按当前相机的 z / fov / aspect 算出
 *   **各个深度上的屏幕边界**，自动生成一条保证"两端在画面外、
 *   中间穿过画面"的路径。要精确编排时再手写 path 覆盖。
 *
 *   ⚠️ 关键细节：起点必须在**它自己那个深度**的画面外。
 *      远处的视锥更宽 —— 用中段的半宽去算起点，起点会落在画面内，
 *      物体会"凭空出现"而不是"飞进来"。实测踩过。
 * ===========================================================================
 */

import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CarrierConfig } from '../../schema/carrier';
import type { ModelAsset } from '../../schema';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface CarrierSystemStats {
  /** 载体是否已建好（GLB 没加载出来时是 false） */
  ready: boolean;
  /** 当前沿路径的进度 0..1 */
  t: number;
  /** 载体是否这一帧可见 */
  visible: boolean;
  /** 溶解跟随强度（透传给 shader） */
  follow: number;
}

/** 沿路径采样用的临时量，避免每帧 new */
const tmpPos = new THREE.Vector3();
const tmpTan = new THREE.Vector3();
const tmpLook = new THREE.Vector3();

export class CarrierSystem {
  readonly scene = new THREE.Scene();

  private readonly config: Required<
    Pick<
      CarrierConfig,
      | 'preset'
      | 'kind'
      | 'shape'
      | 'scale'
      | 'orient'
      | 'follow'
      | 'organic'
      | 'emissive'
      | 'color'
      | 'opacity'
    >
  > & { enabled: boolean; onlyDuringTransition: boolean; spin: [number, number, number] };

  private object: THREE.Object3D | null = null;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private closedCurve = false;

  /** 手写路径（覆盖 preset）。构造时从 config 取出，setCamera 里才用得上 */
  private readonly pathOverride: [number, number, number][] | undefined;

  /** 相机参数 —— setCamera 后才知道，路径要按它算 */
  private camZ = 6;
  private fov = 32;
  private aspect = 1;

  private disposed = false;

  readonly stats: CarrierSystemStats = { ready: false, t: 0, visible: false, follow: 0 };

  constructor(config: CarrierConfig, models: Map<string, ModelAsset>) {
    this.config = {
      enabled: config.enabled ?? false,
      preset: config.preset ?? 'fly-across',
      kind: config.kind ?? (config.model ? 'glb' : 'shape'),
      shape: config.shape ?? 'plane',
      scale: config.scale ?? 1,
      orient: config.orient ?? 'billboard',
      color: config.color ?? '#e8e2d6',
      spin: config.spin ?? [0, 0, 0.6],
      follow: config.follow ?? 0.75,
      organic: config.organic ?? 1,
      emissive: config.emissive ?? 0.35,
      opacity: config.opacity ?? 1,
      onlyDuringTransition: config.onlyDuringTransition ?? true,
    };

    this.pathOverride = config.path;

    if (!this.config.enabled) return;

    this.object = this.buildObject(config, models);
    if (!this.object) return;

    this.scene.add(this.object);

    // 载体有自己的灯 —— 它不属于任何场景，没有灯的话
    // MeshStandardMaterial 会渲染成纯黑。
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 3, 5);
    this.scene.add(key);

    this.stats.ready = true;
    this.stats.follow = this.config.follow;
  }

  /* ------------------------------------------------------------ 建物体 */

  private buildObject(config: CarrierConfig, models: Map<string, ModelAsset>): THREE.Object3D | null {
    if (this.config.kind === 'glb') {
      const key = config.model;
      const asset = key ? models.get(key) : undefined;
      if (!asset) {
        console.warn(
          `[CarrierSystem] 找不到模型资产 "${key ?? '(未指定)'}"，` +
            `已回退到程序化 plane。已注册: ${[...models.keys()].join(', ') || '(空)'}`,
        );
        return this.buildShape();
      }
      // ★ 必须 clone：同一个 Object3D 不能同时挂进两个 Scene，
      //   而且蒙皮模型要 SkeletonUtils.clone（普通 clone 不重建骨骼绑定）
      return skeletonClone(asset.scene);
    }
    return this.buildShape();
  }

  private buildShape(): THREE.Object3D {
    const geo = ((): THREE.BufferGeometry => {
      switch (this.config.shape) {
        case 'box':
          return new THREE.BoxGeometry(1, 0.35, 0.06);
        case 'sphere':
          return new THREE.SphereGeometry(0.5, 24, 16);
        case 'cone':
          return new THREE.ConeGeometry(0.45, 1, 20);
        case 'torus':
          return new THREE.TorusGeometry(0.5, 0.16, 16, 32);
        case 'plane':
        default:
          // 一片"纸" —— 最像 SKY 的飞机轮廓，也最便宜
          return new THREE.PlaneGeometry(1.6, 0.5);
      }
    })();

    // ★ 颜色必须走 config —— 契约里声明了 color 却硬编码成纸白，
    //   结果是"浅色素材 + 浅色载体"完全看不见。深色素材上纸白是对的，
    //   浅色素材上就得换成深色剪影。这也是"引擎不能假设素材明暗"的一部分。
    const color = new THREE.Color(this.config.color);
    // ★ 不透明度 < 1 时自动切 transparent。
    //   浅色素材上，一块不透明的深色载体会变成一个"洞"——
    //   实测油画猫图上比不加载体还难看。见 schema/carrier.ts 的 opacity 说明。
    const opacity = this.config.opacity;
    const mat = new THREE.MeshStandardMaterial({
      color,
      // ★ 给一点自发光：飞过时会被 bloom 抓到，拖出光晕。
      //   这是"画面里有主角"的关键 —— 纯漫反射的物体在暗背景上几乎看不见。
      emissive: color,
      emissiveIntensity: this.config.emissive,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
      transparent: opacity < 1,
      opacity,
      // 半透明物体不该写深度，否则会挡住自己后面本该透出来的东西
      depthWrite: opacity >= 1,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(this.config.scale);
    return mesh;
  }

  /* ------------------------------------------------------------ 路径 */

  /**
   * 由装配层（Composer）在知道相机参数后调用。
   * 路径依赖相机，所以不能只在构造时算一次。
   */
  setCamera(camZ: number, fov: number, aspect: number): void {
    if (!this.config.enabled) return;
    this.camZ = camZ;
    this.fov = fov;
    this.aspect = aspect;
    this.curve = this.buildCurve();
  }

  /**
   * 世界 z 处的**可见半宽 / 半高**。
   *
   * 相机在 (0, 0, camZ) 朝 -z 看，所以到 z 处的距离是 camZ - z。
   * 半高 = 距离 × tan(fov/2)，半宽 = 半高 × aspect。
   */
  private screenHalfAt(z: number): { halfW: number; halfH: number } {
    const d = Math.max(0.5, this.camZ - z);
    const halfH = d * Math.tan((this.fov * Math.PI) / 360);
    return { halfW: halfH * this.aspect, halfH };
  }

  private buildCurve(): THREE.CatmullRomCurve3 {
    const p = this.config.preset;

    // 手写路径优先
    const override = this.pathOverride;
    if (override && override.length >= 2) {
      return new THREE.CatmullRomCurve3(
        override.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
        false,
        'catmullrom',
        0.5,
      );
    }

    const camZ = this.camZ;

    switch (p) {
      case 'fly-through': {
        // 从正前方远处冲向镜头，最后穿过画面 —— 最有冲击力
        const z0 = camZ - 90;
        const z1 = camZ - 30;
        const { halfW: w0, halfH: h0 } = this.screenHalfAt(z0);
        return new THREE.CatmullRomCurve3([
          new THREE.Vector3(w0 * 0.3, h0 * 0.18, z0),
          new THREE.Vector3(0, 0, z1),
          // 终点在相机**之后**（z > camZ），所以物体是"穿过"画面飞走的
          new THREE.Vector3(-0.4, -0.25, camZ + 1.5),
        ]);
      }

      case 'orbit': {
        // 绕画面中心转一整圈
        this.closedCurve = true;
        const z = camZ - 18;
        const { halfW: w } = this.screenHalfAt(z);
        const r = w * 0.62;
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.7, z));
        }
        return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
      }

      case 'rise': {
        // 从下方升到上方 —— "揭幕"
        const z0 = camZ - 40;
        const z1 = camZ - 20;
        const z2 = camZ - 6;
        const { halfH: h0 } = this.screenHalfAt(z0);
        const { halfH: h2 } = this.screenHalfAt(z2);
        return new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, -h0 * 1.25, z0),
          new THREE.Vector3(0, 0, z1),
          new THREE.Vector3(0, h2 * 1.25, z2),
        ]);
      }

      case 'fly-across':
      default: {
        // SKY 的走向：左下远处 → 中间 → 右上近处
        const z0 = camZ - 70;
        const z1 = camZ - 24;
        const z2 = camZ - 4;
        //
        // ★ 起点/终点必须用**各自深度**的屏幕半宽，不能用中段的。
        //   远处视锥更宽 —— 用中段的半宽算起点，起点会落在画面内，
        //   物体就变成"凭空出现"而不是"飞进来"。
        const { halfW: w0, halfH: h0 } = this.screenHalfAt(z0);
        const { halfW: w2, halfH: h2 } = this.screenHalfAt(z2);
        return new THREE.CatmullRomCurve3([
          new THREE.Vector3(-w0 * 1.25, -h0 * 0.75, z0),
          new THREE.Vector3(0, 0.05, z1),
          new THREE.Vector3(w2 * 1.25, h2 * 0.75, z2),
        ]);
      }
    }
  }

  /* ------------------------------------------------------------ 每帧 */

  /**
   * @param uProgress 过渡进度 0..1（与 shader 的 uProgress 是同一个值）
   * @param timeSec   墙上时钟，驱动自转
   * @param dt        距上一帧秒数
   */
  update(uProgress: number, timeSec: number, dt: number): void {
    const obj = this.object;
    if (!obj || !this.curve) return;

    const t = clamp01(uProgress);
    this.stats.t = t;

    // ---- 位置 ----
    // getPointAt 是**弧长参数化**的：匀速沿曲线走，
    // 而不是 getPoint 那样在控制点之间忽快忽慢。
    this.curve.getPointAt(t, tmpPos);
    obj.position.copy(tmpPos);

    // ---- 朝向 ----
    if (this.config.orient === 'billboard') {
      // 永远正对镜头。相机在 (0, 0, camZ) 朝 -z 看（引擎里所有相机都这样），
      // 所以"看着相机"就是 lookAt(0, 0, camZ)。
      obj.lookAt(0, 0, this.camZ);
    } else if (this.config.orient === 'tangent') {
      this.curve.getTangentAt(t, tmpTan);
      tmpLook.copy(tmpPos).add(tmpTan);
      obj.lookAt(tmpLook);
    } else if (this.config.orient === 'spin') {
      obj.rotation.x += this.config.spin[0] * dt;
      obj.rotation.y += this.config.spin[1] * dt;
      obj.rotation.z += this.config.spin[2] * dt;
    }

    // ---- 可见性 ----
    // 只在过渡真正进行时露面。否则 uProgress=0 的大部分时间里
    // 它会一直杵在路径起点（哪怕在画面外，也白白占一次 render call）。
    const during = t > 0.002 && t < 0.998;
    obj.visible = this.config.onlyDuringTransition ? during : true;
    this.stats.visible = obj.visible;

    void timeSec;
  }

  /** 载体当前的世界坐标 —— 喂给过渡 shader 当溶解中心 */
  get worldPosition(): THREE.Vector3 {
    return this.object ? this.object.position : tmpPos.set(0, 0, 0);
  }

  get follow(): number {
    return this.stats.ready ? this.config.follow : 0;
  }

  get organic(): number {
    return this.stats.ready ? this.config.organic : 0;
  }

  /**
   * 载体已建好，**但路径还没算**（还没调 setCamera）。
   *
   * ★ 存在的理由：装配层需要用它当"该不该喂相机参数"的闸门。
   *   如果拿 `active` 当闸门会变成循环依赖 ——
   *   active 要求 curve 存在，而 curve 恰恰要靠这个闸门放行后调 setCamera 才建得出来。
   *   实测踩过：carrierT 恒为 0，载体永远不出现，且没有任何报错。
   */
  get ready(): boolean {
    return this.stats.ready && this.object !== null;
  }

  /** 路径也算好了，这一帧可以渲染 */
  get active(): boolean {
    return this.ready && this.curve !== null;
  }

  get closed(): boolean {
    return this.closedCurve;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.object?.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.scene.clear();
    this.object = null;
    this.stats.ready = false;
  }
}
