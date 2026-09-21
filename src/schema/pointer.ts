/**
 * ★ 指针契约（PHASE 26）—— 继「滚动」「时间」之后的**第三个连续驱动源**
 * ===========================================================================
 * 引擎里本来只有两个连续驱动源：
 *
 *   ▸ 滚动 → 章节进度（决定"故事讲到哪"）
 *   ▸ 时间 → 颗粒 / 活性（决定"画面停着的时候是不是死的"）
 *
 * 指针（鼠标 / 触控 / 笔）是第三个：**它不推进故事，但它改变"你从哪儿看"**。
 * 少了它，画面在你不动滚轮的时候虽然"活着"（有颗粒在跳），
 * 却**不响应你** —— 读起来像一段视频，不像一个可以看进去的东西。
 *
 * ---------------------------------------------------------------------------
 * 【★ 为什么这一条是从两个参考站点里"找"出来的，不是想出来的】
 *
 * 两个站点的指针用法形式不同，但**都是实质性的连续驱动**：
 *
 *   ▸ **shader.se**（`skyworks/src/components/mouse-weight-pass.tsx`）
 *     把鼠标做成一个**场**：位置 / 方向 / 速度三路各带一组弹簧
 *     （stiffness 140 / 80 / 120，damping 28 / 22 / 24），
 *     渲染进一张浮点纹理，再去驱动背景平面的顶点位移。
 *
 *   ▸ **iamsaeed.dev**（`portfolio/components/ShotDirector.tsx`）
 *     指针视差。原文：
 *
 *         // pointer parallax: only inside settled shots, never in gutters/beats
 *         const parallaxOk = !reducedMotion && sample.transition === null &&
 *           (sample.shotKind === "hold" || sample.shotKind === "dolly");
 *         if (parallaxOk) {
 *           const amp = 0.035;                       // ~ +/-2deg at target distance
 *           const d = pos.current.distanceTo(tgt.current);
 *           pos.current.x += pointerX * amp * d * 0.35;
 *           pos.current.y += -pointerY * amp * d * 0.25;
 *         }
 *
 *     三个设计点值得原样保留：
 *       ▸ `amp * d` —— 幅度按**相机到目标的距离**缩放，所以观感是**恒定的角度**
 *         偏移（"±2°"），而不是固定的世界位移。远近不同的镜头手感一致。
 *       ▸ **受 `reducedMotion` 约束** —— 前庭功能敏感的用户不该被镜头晃到。
 *       ▸ **x/y 不对称**（0.35 / 0.25）—— 人眼对横向运动更敏感，
 *         纵向给满会晕。
 *
 * 本引擎两个都没有：`grep -rn "mouse" src/engine` 只在 TransitionSystem
 * 里命中一次（`mix(sceneCenter, uMouse, 0.1)` 影响溶解中心），
 * **场景本身完全不响应指针**。
 *
 * ---------------------------------------------------------------------------
 * 【★ 零行为变更契约】
 *
 *   `resolvePointer()` 不传参数时 `enabled === false`，
 *   于是 `PointerSystem` 每帧写出的偏移恒为 `(0, 0)` ——
 *   不声明 `site.pointer` 的内容包，相机与改造前逐位相同。
 *   这与 `site.carrier` / `site.medium` 是同一套约定。
 * ===========================================================================
 */

export interface PointerConfig {
  /**
   * 总开关。
   *
   * 默认 `false` —— 不声明就一个像素都不动。
   * 想要"画面跟着鼠标微微偏"就打开它（见 `POINTER_PARALLAX` 预设）。
   */
  enabled?: boolean;

  /**
   * 视差幅度：**相机到场景距离的比例**。
   *
   * 为什么是比例而不是世界单位：这样镜头推近 / 拉远时，
   * 指针的"手感"是恒定的角度偏移，而不是近处晃得厉害、远处几乎不动。
   * 参考站点取 0.035（"~ ±2deg at target distance"）。
   */
  parallax?: number;

  /**
   * 横 / 纵不对称系数 `[x, y]`。
   *
   * 默认 `[1, 1]`（中性）。参考站点用 `[0.35, 0.25]` ——
   * 人眼对横向运动更敏感，纵向给满容易晕。
   */
  axis?: [number, number];

  /**
   * 平滑时间常数（秒）。指针是**跳变**的输入（一帧里能从左上跳到右下），
   * 直接喂给相机会"啪"地跳一下。一阶低通之后就变成"视线慢慢跟过去"。
   *
   * `0` = 不平滑。参考站点的弹簧折算下来约 0.1~0.15s。
   */
  damping?: number;

  /**
   * 是否尊重系统的 `prefers-reduced-motion`。默认 `true`。
   *
   * 打开时，用户在系统里勾了"减少动态效果"，指针视差会被**整条关掉**
   * （而不是只减小幅度）—— 参考站点就是这么做的（`!reducedMotion &&`）。
   */
  respectReducedMotion?: boolean;
}

/** 归一化后的指针配置（`enabled` 已经把 reducedMotion 折算进去） */
export interface ResolvedPointer {
  enabled: boolean;
  parallax: number;
  axis: readonly [number, number];
  damping: number;
  respectReducedMotion: boolean;
}

/**
 * 出厂预设：照搬参考站点的取值。
 *
 * 想快速试：`pointer: POINTER_PARALLAX`。
 */
export const POINTER_PARALLAX: PointerConfig = {
  enabled: true,
  parallax: 0.035,
  axis: [0.35, 0.25],
  damping: 0.12,
  respectReducedMotion: true,
};

/** 完全不动（不声明 `site.pointer` 时引擎的等价状态） */
export const POINTER_OFF: ResolvedPointer = {
  enabled: false,
  parallax: 0,
  axis: [1, 1],
  damping: 0,
  respectReducedMotion: true,
};

/**
 * 把内容包声明的（可能残缺的）配置补全成引擎能直接用的形式。
 *
 * @param config        内容包的 `site.pointer`，可以不传
 * @param reducedMotion 当前是否处于 `prefers-reduced-motion: reduce`
 *
 * ★ `reducedMotion` 是在**这里**折算的，不是运行时再判断 ——
 *   这样"关掉"这件事只有一个真相来源，测试也能直接断言。
 */
export function resolvePointer(
  config?: PointerConfig | null,
  reducedMotion = false,
): ResolvedPointer {
  const respectReducedMotion = config?.respectReducedMotion ?? true;
  const wantsOn = config?.enabled ?? false;

  // 系统要求减少动态效果 → 整条关掉，而不是只调小
  const enabled = wantsOn && !(respectReducedMotion && reducedMotion);

  const parallax = Math.max(config?.parallax ?? 0, 0);
  const damping = Math.max(config?.damping ?? 0, 0);

  // axis 允许只给一个数或给负数（负数 = 反向，是个正当的创作选择）
  const ax = config?.axis?.[0];
  const ay = config?.axis?.[1];

  return {
    enabled,
    parallax,
    axis: [ax ?? 1, ay ?? 1],
    damping,
    respectReducedMotion,
  };
}
