/**
 * PHASE 26 —— 指针系统
 * ===========================================================================
 * 负责一件事：把**跳变的指针输入**变成**平滑的、可叠加到相机上的位移**。
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么它必须是一个实例，不能是纯函数】
 *
 *   平滑（一阶低通）需要上一帧的值 —— 跨帧缓存。
 *   这一点和 `CameraSystem` 的阻尼完全同构。
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么不做成"相机轨道的一部分"】
 *
 *   轨道（`CameraConfig.tracks`）是**内容**写的：它决定"镜头从哪儿走到哪儿"。
 *   指针视差是**输入**：它决定"这一刻你从哪儿看"。
 *
 *   两者混在一起会有两个坏结果：
 *     ▸ 内容作者没法单独调"镜头运动"，一动就动到视差
 *     ▸ 指针不动时轨道求值的结果会被污染（缓存了上一帧的偏移）
 *
 *   所以这里**只负责算出一个偏移量**，由 `SceneBuilder` 在
 *   `cameraSystem.apply()` **之后**把它加上去 ——
 *   顺序很关键：轨道先写定基准位置，偏移叠加在基准之上，不累积。
 *
 * ---------------------------------------------------------------------------
 * 【★ 坐标系约定】
 *
 *   进来的：归一化屏幕坐标 `[x, y]`，`0..1`，**左上角为原点**（浏览器原生）
 *   出去的：`[-1, 1]`，**中心为原点、+y 向上**（和 three 的世界系一致）
 *
 *   这个翻转必须在**这里**做一次，不能留给调用方 ——
 *   否则每个调用点都要记得翻转，迟早有一个忘掉，
 *   表现为"鼠标往下移画面往上走"，而且极难联想到是坐标系的问题。
 * ===========================================================================
 */

import type { ResolvedPointer } from '../../schema';

export class PointerSystem {
  /** 平滑后的指针值，`[-1, 1]`，中心为原点、+y 向上 */
  private x = 0;
  private y = 0;

  /** 复用同一个对象，避免每帧在渲染循环里分配 */
  private readonly offset = { x: 0, y: 0 };

  constructor(private config: ResolvedPointer) {}

  /**
   * 重新构图后 config 可能被整体替换（和 `CameraSystem.syncConfig` 同理）。
   */
  syncConfig(config: ResolvedPointer): void {
    this.config = config;
    if (!config.enabled) this.reset();
  }

  /**
   * 推进一帧。
   *
   * @param dt    距上一帧的秒数。仅当声明了 damping 时用到
   * @param input 归一化屏幕坐标 `[x, y]`（0..1，左上原点）。
   *              不传 = 指针尚未进入过画面 = 目标值取中心（0, 0）
   */
  apply(dt: number, input?: readonly [number, number]): void {
    if (!this.config.enabled) {
      this.x = 0;
      this.y = 0;
      return;
    }

    // 屏幕坐标 → 中心原点、+y 向上
    const targetX = input ? input[0] * 2 - 1 : 0;
    const targetY = input ? 1 - input[1] * 2 : 0;

    const damping = this.config.damping;
    if (damping > 0) {
      // ★ 必须把「没配阻尼」和「这一帧没有时间流逝」分开：
      //
      //   damping === 0  → 没配阻尼，瞬时跟上（这是调用方要的）
      //   dt <= 0        → 时间没走，**值不该变**
      //
      //   写成 `if (damping > 0 && dt > 0) {…} else { 瞬时 }` 的话，
      //   dt = 0 会掉进 else 分支变成跳变 —— 表现为首帧"啪"地跳到指针位置。
      //   （CameraSystem 是那个写法，但它构造时正是靠这个跳变把首帧
      //    初始化到 t=0 的状态，是有意的；指针不需要，它应该永远缓动。）
      if (dt > 0) {
        // 与 CameraSystem 同一套写法：`1 - exp(-dt/damping)` 是**帧率无关**的。
        // 用固定系数的话，144fps 下会比 30fps 跟得紧得多。
        const k = 1 - Math.exp(-dt / Math.max(damping, 1e-4));
        this.x += (targetX - this.x) * k;
        this.y += (targetY - this.y) * k;
      }
    } else {
      this.x = targetX;
      this.y = targetY;
    }
  }

  /**
   * 算出要叠加到相机位置上的世界位移。
   *
   * @param distance 相机到场景的距离。**必须传真实距离** ——
   *                 乘上它之后，观感才是恒定的角度偏移（"±2°"）；
   *                 不乘的话，镜头推近时指针会把画面晃出屏幕。
   *
   * 返回的是**内部复用对象**，调用方应立刻用掉，不要长期持有。
   */
  offsetFor(distance: number): { x: number; y: number } {
    const c = this.config;
    if (!c.enabled) {
      this.offset.x = 0;
      this.offset.y = 0;
      return this.offset;
    }
    const d = Math.max(distance, 0);
    this.offset.x = this.x * c.parallax * d * c.axis[0];
    this.offset.y = this.y * c.parallax * d * c.axis[1];
    return this.offset;
  }

  /** 当前是否生效。`false` 时 `SceneBuilder` 会整段跳过叠加 */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 当前平滑值，调试用 */
  get value(): readonly [number, number] {
    return [this.x, this.y];
  }

  /** 归零。开关被关掉、或重新构图时调用 */
  reset(): void {
    this.x = 0;
    this.y = 0;
    this.offset.x = 0;
    this.offset.y = 0;
  }
}
