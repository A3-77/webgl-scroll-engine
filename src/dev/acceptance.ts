/**
 * ★ 里程碑验收（PHASE 11）
 * ===========================================================================
 * 把「素材 → 场景 → 滚动 → 相机 → 对象运动 → Shader 转场」这条链路
 * 变成**可以一条命令跑完**的断言集，而不是每次手工点、肉眼判断。
 *
 * ---------------------------------------------------------------------------
 * 【怎么用】
 *
 *   A. 浏览器里：地址后加 `?accept=1`，结果自动打到 console。
 *
 *   B. 控制台里随时跑：
 *        await __ACCEPTANCE__.run()
 *      返回结构化报告（也可以在 MCP 的 evaluate_script 里调）。
 *
 * ---------------------------------------------------------------------------
 * 【哪些标准能在这里测，哪些不能】
 *
 *   可测（运行时）：
 *     ② 两张图生成基础 Scene       —— 检查 manifest 的结构
 *     ③ 滚动控制 Scene01→02        —— 真的滚一遍，看 index 变不变
 *     ④ 场景内多对象独立运动        —— 采样 t 序列，比较各对象的轨迹
 *     ⑤ Camera 有明显空间运动       —— 量 z / y 的行程
 *     ⑥ Transition 用 RT + Shader  —— 检查双 RenderTarget 与 uProgress
 *     ⑦⑧ 素材驱动（换图/加图不改代码）—— 检查包形态：有 build、无静态 scenes
 *
 *   不可测（需要构建期动作，见 README 的手工步骤）：
 *     ① 删除内容包后引擎仍可运行     —— 要真删目录再构建
 *     ⑨ 产物完整性                  —— 属于 `npm run build-assets:check`
 *
 *   把"测不了的"也写进报告并标成 SKIP，是为了让读者知道**边界在哪** ——
 *   一份只报 PASS 的验收清单会给人虚假的安全感。
 * ===========================================================================
 */

/* ------------------------------------------------------------ 类型 */

export interface CheckResult {
  /** 对应验收标准的编号（①②③…），便于对照路线图 */
  id: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  /** 一句话说明测到了什么（数值、范围），FAIL 时说明差在哪 */
  detail: string;
}

export interface AcceptanceReport {
  checks: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/* ------------------------------------------------------------ 工具 */

/**
 * 等 n 帧。验收里的每一步都要让渲染循环真的跑过，否则读到的是旧状态。
 *
 * ★ 带超时保护。页面被节流时（Chrome 窗口被遮挡时 rAF 会降到 ~1fps），
 *   一次 `nextFrames(3)` 要等 3 秒 —— 验收脚本滚 9 个位置就卡 27 秒。
 *   超时后直接放行：读到的状态可能略旧，但至少验收能跑完并报出结论
 *   （而且这种情况本来就会在"帧率"那一项被标成 SKIP）。
 */
function nextFrames(n = 3, timeoutMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    let i = 0;
    const tick = (): void => {
      if (++i >= n) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** 引擎挂在 window 上的调试入口（由 CanvasHost 装配） */
interface EngineHandle {
  composer: any;
  scrollEngine: any;
  renderer: any;
  sectionStore: any;
  pack: any;
  content: any;
}

function engine(): EngineHandle | null {
  return (window as unknown as Record<string, unknown>).__ENGINE__ as EngineHandle | null;
}

function ok(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: 'PASS', detail };
}
function bad(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: 'FAIL', detail };
}
function skip(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: 'SKIP', detail };
}

/* ------------------------------------------------------------ 各项检查 */

/** ② 基础 Scene：manifest 结构完整 */
function checkScenes(e: EngineHandle): CheckResult {
  const scenes = e.content?.scenes ?? [];
  const id = '②';
  const label = '两张图生成基础 Scene';

  if (scenes.length < 2) {
    return bad(id, label, `只生成了 ${scenes.length} 个场景，至少需要 2 个`);
  }

  const problems: string[] = [];
  scenes.forEach((s: any) => {
    if (!s.objects?.length) problems.push(`${s.id} 没有对象`);
    // 用 role 而不是 `id === 'bg'` —— 命名约定不是契约，见 schema/object.ts
    const bg = s.objects?.find((o: any) => o.role === 'background');
    if (!bg) problems.push(`${s.id} 缺背景（没有 role: 'background' 的对象）`);
    const subjects = s.objects?.filter((o: any) => o.role === 'subject') ?? [];
    if (!subjects.length) problems.push(`${s.id} 没有 role: 'subject' 的对象`);
    if (!s.camera?.tracks?.length) problems.push(`${s.id} 相机没有轨道`);
    if (typeof s.heightVh !== 'number' || s.heightVh <= 0) problems.push(`${s.id} heightVh 非法`);
  });

  if (problems.length) return bad(id, label, problems.join('；'));

  const subjects = scenes.reduce(
    (n: number, s: any) => n + s.objects.filter((o: any) => o.role === 'subject').length,
    0,
  );
  return ok(
    id,
    label,
    `${scenes.length} 个场景 / ${subjects} 个主体；每个场景都有背景（role 声明）+ 相机轨道`,
  );
}

/** ③ 滚动驱动：滚一遍，看 current.index 会不会推进、progress 会不会连续变化 */
async function checkScrollDriving(e: EngineHandle): Promise<CheckResult> {
  const id = '③';
  const label = '滚动控制 Scene01 → Scene02';

  const st0 = e.sectionStore.getState();
  const heights: number[] = st0.heights ?? [];
  if (heights.length < 2) return bad(id, label, `章节数 ${heights.length} < 2`);

  const savedY = window.scrollY;
  const samples: Array<{ y: number; index: number; progress: number }> = [];

  // 从 0 扫到第二章节的末尾
  const total = heights[0] + heights[1];
  for (const frac of [0, 0.3, 0.6, 0.9, 1]) {
    const y = Math.round(frac * total * 0.95);
    e.scrollEngine.lenis.scrollTo(y, { immediate: true });
    await nextFrames(3);
    const s = e.sectionStore.getState();
    samples.push({ y, index: s.current.index, progress: s.current.progress });
  }

  // 恢复原位置 —— 验收不该留下副作用
  e.scrollEngine.lenis.scrollTo(savedY, { immediate: true });
  await nextFrames(3);

  const indices = new Set(samples.map((s) => s.index));
  if (indices.size < 2) {
    return bad(
      id,
      label,
      `滚动全程 current.index 一直是 ${[...indices].join('/')}，没有推进到下一章`,
    );
  }

  // progress 必须在每个章节内随滚动单调不减（这是"滚动驱动"的定义）
  const nonMonotonic = samples.some((s, i) => i > 0 && s.index === samples[i - 1].index && s.progress < samples[i - 1].progress);
  if (nonMonotonic) {
    return bad(id, label, `同一章节内 progress 出现回退：${samples.map((s) => s.progress.toFixed(2)).join(' → ')}`);
  }

  return ok(
    id,
    label,
    `滚过 ${total}px，章节从 ${samples[0].index} 推进到 ${samples[samples.length - 1].index}；` +
      // 带章节号，否则跨章时 progress 归零会被误读成"回退"
      `轨迹 ${samples.map((s) => `${s.index}:${s.progress.toFixed(2)}`).join(' → ')}`,
  );
}

/** ④ 对象独立运动：采样时间轴，比较各对象的轨迹是否互不相同 */
function checkObjectMotion(e: EngineHandle): CheckResult {
  const id = '④';
  const label = 'Scene 内多个对象独立运动';

  const built = e.composer?.scenes?.[0];
  if (!built) return bad(id, label, '拿不到第 1 个场景');

  const ts = [0, 0.25, 0.5, 0.75, 1];
  const traj = new Map<string, number[][]>();

  for (const t of ts) {
    built.applyTime(t);
    for (const layer of built.layers) {
      const p = layer.object.position;
      if (!traj.has(layer.config.id)) traj.set(layer.config.id, []);
      traj.get(layer.config.id)!.push([p.x, p.y, p.z]);
    }
  }

  // 把轨迹量化成签名 —— 浮点噪声不该被当成"运动方式不同"
  //
  // ★ 签名用**屏幕归一化位移**，既不是绝对位置、也不是世界位移。
  //
  //   为什么不比绝对位置：里面含着 baseX/baseY，每个对象本来就落在不同的地方，
  //     于是"所有对象用同一条轨道"会被误判成"轨迹不同"。
  //
  //   为什么不比世界位移：世界位移 = 轨道值 × baseVisibleH，而 baseVisibleH
  //     随 z 深度变 —— 于是**同一条轨道**在不同深度上会产生不同的世界位移，
  //     同样会把"整块平移"判成"独立运动"。实测踩过这个。
  //
  //   验收标准说的是"**看起来**是独立运动"，那就该比屏幕上的位移：
  //     屏幕位移 = 世界位移 / baseVisibleH（除以 aspect 是为了让 x 与 y 同量纲）
  //   这正好就是轨道值本身 —— 所以本质上是"比轨道值"。
  const aspect = built.camera?.aspect || 1;
  const sigs = new Map<string, string>();
  const movers: string[] = [];
  const still: string[] = [];

  for (const [objId, points] of traj) {
    const layer = built.layers.find((l: any) => l.config.id === objId);
    const vh = layer?.baseVisibleH || 1;

    const dx = points.map((p) => +((p[0] - points[0][0]) / vh / aspect).toFixed(5));
    const dy = points.map((p) => +((p[1] - points[0][1]) / vh).toFixed(5));
    const moved = dx.some((v) => v !== 0) || dy.some((v) => v !== 0);

    if (moved) {
      movers.push(objId);
      sigs.set(objId, `${dx.join(',')}|${dy.join(',')}`);
    } else {
      still.push(objId);
    }
  }

  if (movers.length < 2) {
    return bad(id, label, `只有 ${movers.length} 个对象在动（至少需要 2 个）`);
  }

  const distinct = new Set(sigs.values()).size;
  if (distinct < 2) {
    return bad(
      id,
      label,
      `${movers.length} 个对象都在动，但**屏幕位移完全相同** —— 看起来像整块平移，不是独立运动`,
    );
  }

  // 关于背景：**不断言"背景必须静止"**。
  //
  //   曾经加过这条断言，后来发现是错的：远景层（星点、云、雾）有轻微漂移
  //   是完全合理的 —— shopify 包的第 2 章就拿一个 GLB 星点模型当背景层，
  //   它带 ±0.03 的 x 漂移。把它判成"失败"是断言写得太武断。
  //
  //   现在只做**报告**：背景有没有在动，交给读者判断。
  const bgIds = built.layers
    .filter((l: any) => l.config.role === 'background')
    .map((l: any) => l.config.id);
  const movingBg = bgIds.filter((bid: string) => movers.includes(bid));

  return ok(
    id,
    label,
    `${movers.length} 个对象在动，其中 ${distinct} 种互不相同的屏幕位移轨迹；` +
      `${still.length} 个静止` +
      (bgIds.length === 0
        ? '（本场景没有 role: background 的对象）'
        : movingBg.length
          ? `（背景层 ${movingBg.join('、')} 也有位移 —— 远景漂移）`
          : `（背景层 ${bgIds.join('、')} 静止）`),
  );
}

/** ⑤ 相机空间运动：量 z / y / roll 的行程 */
function checkCamera(e: EngineHandle): CheckResult {
  const id = '⑤';
  const label = 'Camera 有明显空间运动';

  const built = e.composer?.scenes?.[0];
  if (!built) return bad(id, label, '拿不到第 1 个场景');

  built.applyTime(0);
  const a = { z: built.camera.position.z, y: built.camera.position.y, roll: built.camera.rotation.z };
  built.applyTime(1);
  const b = { z: built.camera.position.z, y: built.camera.position.y, roll: built.camera.rotation.z };

  const dz = Math.abs(b.z - a.z);
  const dy = Math.abs(b.y - a.y);
  const droll = Math.abs(b.roll - a.roll);

  // 阈值是"肉眼能看出来"的量级：
  //   z 行程 < 1 个单位 → 几乎看不出推进
  //   y 行程 < 0.2      → 视差弱到像静态
  if (dz < 1) return bad(id, label, `相机 z 只走了 ${dz.toFixed(2)} 个单位，看不出推进`);
  if (dy < 0.2) return bad(id, label, `相机 y 只走了 ${dy.toFixed(2)} 个单位，视差太弱`);

  return ok(
    id,
    label,
    `z ${a.z.toFixed(2)}→${b.z.toFixed(2)}（行程 ${dz.toFixed(2)}）  ` +
      `y ${a.y.toFixed(2)}→${b.y.toFixed(2)}（行程 ${dy.toFixed(2)}）  ` +
      `roll ±${droll.toFixed(4)}`,
  );
}

/** ⑥ 过渡：双 RenderTarget 真的存在，且 uProgress 会随滚动变化 */
async function checkTransition(e: EngineHandle): Promise<CheckResult> {
  const id = '⑥';
  const label = 'Transition 用 RenderTarget + Shader + Noise';

  const c = e.composer;
  if (!c?.rtCurrent || !c?.rtNext) return bad(id, label, '找不到 rtCurrent / rtNext');

  if (c.rtCurrent.texture === c.rtNext.texture) {
    return bad(id, label, 'rtCurrent 与 rtNext 是同一张纹理 —— 没有真正的双缓冲');
  }

  const uniforms = c.transitionQuad?.mesh?.material?.uniforms;
  if (!uniforms) return bad(id, label, '找不到过渡 quad 的 uniforms');

  const hasNoise = !!uniforms.tNoise?.value;
  const hasMud = !!uniforms.tMudNormal?.value;
  if (!hasNoise || !hasMud) {
    return bad(id, label, `噪声图=${hasNoise} 位移图=${hasMud} —— 阈值场缺料`);
  }

  // 滚到过渡区，看 uProgress 是否真的在 (0,1) 之间
  const heights: number[] = e.sectionStore.getState().heights ?? [];
  const savedY = window.scrollY;
  const savedIndex = e.sectionStore.getState().current.index;

  const seen: number[] = [];
  let sawOverlap = false;

  for (let y = 0; y <= heights[0]; y += Math.max(80, Math.floor(heights[0] / 12))) {
    e.scrollEngine.lenis.scrollTo(y, { immediate: true });
    await nextFrames(2);
    const st = e.sectionStore.getState();
    const u = uniforms.uProgress.value as number;
    seen.push(u);
    if (st.next) sawOverlap = true;
  }

  e.scrollEngine.lenis.scrollTo(savedY, { immediate: true });
  await nextFrames(3);

  const mid = seen.filter((u) => u > 0.02 && u < 0.98).length;
  if (mid === 0) {
    return bad(id, label, `扫过整章 uProgress 都没落在 (0,1) 之间（样本 ${seen.length} 个）`);
  }
  if (!sawOverlap) {
    return bad(id, label, '全程没有出现 current/next 同时求值的交叉状态');
  }

  return ok(
    id,
    label,
    `双 RT 独立、噪声图 + 位移图就位；扫过 ${seen.length} 个位置，` +
      `${mid} 个落在过渡区间内（uProgress 最大 ${Math.max(...seen).toFixed(3)}）`,
  );
}

/** ⑦⑧ 素材驱动：包形态必须是"有 build、无静态 scenes" */
function checkAssetDriven(e: EngineHandle): CheckResult {
  const id = '⑦⑧';
  const label = '换图 / 加图不改核心代码';

  const pack = e.pack;
  if (!pack) return bad(id, label, '拿不到内容包');

  if (typeof pack.build !== 'function') {
    return skip(
      id,
      label,
      `当前内容包 "${pack.id}" 是静态包（没有 build 钩子），这条标准只对素材驱动的包有意义`,
    );
  }
  if (pack.scenes) {
    return bad(
      id,
      label,
      `内容包 "${pack.id}" 同时提供了静态 scenes —— 那"加一张图"就必须改这个文件，标准不成立`,
    );
  }

  const scenes = e.content?.scenes ?? [];
  const ids = scenes.map((s: any) => s.id).join(', ');
  return ok(
    id,
    label,
    `内容包 "${pack.id}" 没有任何静态场景配置，${scenes.length} 个场景全部由 manifest 生成（${ids}）`,
  );
}

/** 性能：连续 60 帧的实际帧率 */
async function checkPerf(): Promise<CheckResult> {
  const id = '·';
  const label = '帧率';

  await nextFrames(5);
  const t0 = performance.now();
  let frames = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (++frames >= 60) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const ms = performance.now() - t0;
  const fps = (frames * 1000) / ms;

  // ★ 三道判据，任何一条成立都说明"这个环境下测不出真实帧率"：
  //
  //   1. 页面不可见  —— 后台标签页的 rAF 被节流到 ~1fps
  //   2. 页面没焦点  —— 同上
  //   3. **60 帧耗时超过 10 秒** —— 这条是物理判据，也是最后一道保险。
  //      真实渲染再慢也不会慢到 6fps 以下；出现这种情况一定是节流。
  //      实测踩过：`document.hasFocus()` 返回 true，但窗口其实在后台，
  //      60 帧跑了 60 秒 —— 只看前两条会误报成"渲染性能崩溃"。
  //
  //   测不了就报 SKIP。报 FAIL 会让人跑去优化根本没问题的代码；
  //   报 PASS 又会掩盖真实的性能问题。
  const throttled =
    document.visibilityState !== 'visible' || !document.hasFocus() || ms > 10000;

  if (throttled) {
    return skip(
      id,
      label,
      `页面不在前台或被节流（visibility=${document.visibilityState}, ` +
        `focus=${document.hasFocus()}, 60 帧耗时 ${(ms / 1000).toFixed(1)}s → ${fps.toFixed(1)} fps）。` +
        `切到前台重跑才有意义`,
    );
  }

  if (fps < 30) return bad(id, label, `${fps.toFixed(1)} fps（60 帧 / ${ms.toFixed(0)}ms）`);
  return ok(id, label, `${fps.toFixed(1)} fps（60 帧 / ${ms.toFixed(0)}ms）`);
}

/** ①⑨ 需要构建期动作，运行时测不了 —— 但要明确说出来 */
function skippedChecks(): CheckResult[] {
  return [
    skip(
      '①',
      '删除内容包后引擎仍可运行',
      '构建期验证，运行时测不了 —— 跑 npm run verify:independence（会自动移出内容包、构建、检查产物、再恢复）',
    ),
    skip('⑨', '产物与 manifest 一致', '属于构建期校验：npm run build-assets:check'),
  ];
}

/* ------------------------------------------- 引擎能力覆盖（可重复验证） */

/**
 * ★ 这一组回答一个具体问题：**引擎声明支持的能力，真的能用吗？**
 *
 * ---------------------------------------------------------------------------
 * 【为什么需要它】
 *
 *   schema 里有 20 多项能力，但很多**从来没有内容用过**。
 *   实测审计发现的"代码在、但从没跑过"清单：
 *     blending: 'additive'   —— 0 处使用
 *     visible 轨道            —— 0 处使用
 *     camera.damping         —— 实现完整，但所有内容包的 damping 都是 undefined
 *     parallax 倍率           —— 只验证过背景的 0
 *
 *   这类能力**可能早就坏了而没人知道** —— 它们不报错，只在你第一次真用的时候
 *   才暴露。所以必须主动把它们跑一遍。
 *
 * ---------------------------------------------------------------------------
 * 【设计上刻意通用】
 *
 *   遍历当前内容包**实际声明的**能力逐项验证，而不是针对某个包写死。
 *   换一个内容包，验证的就是另一批能力。
 *   内容里没声明的能力报 SKIP，并说明"这项没被覆盖" —— 而不是假装通过。
 */
function capabilityCheck(
  id: string,
  label: string,
  declaredCount: number,
  problems: string[],
  detail: string,
): CheckResult {
  if (declaredCount === 0) {
    return skip(id, label, '当前内容包没有用到这项能力 —— 换一个用到它的包再验');
  }
  if (problems.length) return bad(id, label, problems.join('；'));
  return ok(id, label, detail);
}

/** 遍历所有场景的所有对象，找出声明了某能力的 */
function scanObjects(
  e: EngineHandle,
  pred: (cfg: any) => boolean,
): Array<{ si: number; li: number; id: string }> {
  const out: Array<{ si: number; li: number; id: string }> = [];
  (e.composer?.scenes ?? []).forEach((built: any, si: number) => {
    (built.config?.objects ?? []).forEach((cfg: any, li: number) => {
      if (pred(cfg)) out.push({ si, li, id: cfg.id });
    });
  });
  return out;
}

/** 某对象在 t0 → t1 之间的世界位移 */
function worldDelta(built: any, layer: any, t0: number, t1: number): number {
  built.applyTime(t0);
  const a = layer.object.position.clone();
  built.applyTime(t1);
  const b = layer.object.position.clone();
  return b.sub(a).length();
}

/**
 * ⑩ parallax 倍率：把 layer.parallax 临时改成 1 再测一遍，比值应等于声明值。
 * 这是**直接验证倍率生效**，不是"读了一下字段"。
 */
function checkParallax(e: EngineHandle): CheckResult {
  const id = '⑩';
  const label = 'parallax 视差倍率';
  const found = scanObjects(e, (o) => typeof o.parallax === 'number' && o.parallax !== 1);
  const problems: string[] = [];
  const samples: string[] = [];
  const noMotion: string[] = [];

  for (const { si, li, id: objId } of found) {
    const built = e.composer.scenes[si];
    const layer = built.layers[li];
    const declared = layer.parallax;

    const withK = worldDelta(built, layer, 0, 1);
    layer.parallax = 1;
    const withOne = worldDelta(built, layer, 0, 1);
    layer.parallax = declared; // 立刻恢复

    if (withOne < 1e-6) {
      // ★ 这个对象**本来就没有轨道位移** —— 倍率乘上去还是 0，比值测不出来。
      //   典型例子：自动构图给背景的是 `parallax: 0` + 空轨道（双保险钉死）。
      //   这不是失败，是"这项对它不适用"。曾经把它当失败报过，是误报。
      noMotion.push(objId);
      continue;
    }

    const ratio = withK / withOne;
    if (Math.abs(ratio - declared) > 0.02) {
      problems.push(`${objId} 声明 ${declared}，实测倍率 ${ratio.toFixed(3)}`);
    } else {
      samples.push(`${objId} ×${declared}（实测 ${ratio.toFixed(3)}）`);
    }
  }

  // 找到声明了倍率的对象，但一个都测不出比值 → 报 SKIP 而不是 PASS。
  // 报 PASS 会让人以为"倍率验证过了"，其实没有。
  if (samples.length === 0 && problems.length === 0) {
    return skip(
      id,
      label,
      `声明了 parallax 的 ${found.length} 个对象都没有轨道位移（${noMotion.join('、')}）—— ` +
        `倍率乘上去还是 0，比值无从测起`,
    );
  }

  return capabilityCheck(
    id,
    label,
    found.length,
    problems,
    `倍率生效：${samples.join('、')}` +
      (noMotion.length ? `；${noMotion.join('、')} 无轨道位移，跳过` : ''),
  );
}

/** ⑪ 相机阻尼：一帧内把 t 从 0 跳到 1，相机不应该立刻到位 */
function checkCameraDamping(e: EngineHandle): CheckResult {
  const id = '⑪';
  const label = 'camera damping 相机阻尼';

  const found = (e.composer?.scenes ?? [])
    .map((built: any, si: number) => ({ si, damping: built.config?.camera?.damping ?? 0 }))
    .filter((x: any) => x.damping > 0);

  const problems: string[] = [];
  const samples: string[] = [];

  for (const { si, damping } of found) {
    const built = e.composer.scenes[si];
    const cam = built.camera;

    // 先让阻尼收敛到 t=0 的状态
    for (let i = 0; i < 200; i++) built.applyTime(0, 1 / 60);
    const atZero = cam.position.clone();

    // 一帧内跳到 t=1 —— 有阻尼时相机应该**还没到位**
    built.applyTime(1, 1 / 60);
    const afterOneFrame = cam.position.clone();

    // 再跑很多帧让它收敛
    for (let i = 0; i < 400; i++) built.applyTime(1, 1 / 60);
    const settled = cam.position.clone();

    const total = settled.distanceTo(atZero);
    const lag = settled.distanceTo(afterOneFrame);

    if (total < 1e-6) {
      problems.push(`场景 ${si} 相机本身不动，测不出阻尼`);
      continue;
    }
    // 一帧后应该明显没到位（滞后量 > 总行程的 20%）
    const lagRatio = lag / total;
    if (lagRatio < 0.2) {
      problems.push(
        `场景 ${si} damping=${damping} 但一帧后就到位了（滞后 ${(lagRatio * 100).toFixed(1)}%）—— 阻尼没生效`,
      );
    } else {
      samples.push(`场景 ${si} τ=${damping}s（一帧后仍差 ${(lagRatio * 100).toFixed(0)}%）`);
    }
  }

  return capabilityCheck(id, label, found.length, problems, `阻尼生效：${samples.join('、')}`);
}

/** ⑫ blending: 'additive' 加色混合 */
function checkBlending(e: EngineHandle): CheckResult {
  const id = '⑫';
  const label = 'blending 加色混合';

  const found = scanObjects(e, (o) => o.blending === 'additive');
  const problems: string[] = [];
  const samples: string[] = [];

  for (const { si, li, id: objId } of found) {
    const layer = e.composer.scenes[si].layers[li];
    const mat = layer.mesh?.material;
    if (!mat) {
      problems.push(`${objId} 不是平面对象，测不了 blending`);
      continue;
    }
    // THREE.AdditiveBlending === 2（见 three/src/constants.js）
    if (mat.blending !== 2) {
      problems.push(`${objId} 声明 additive，但材质 blending=${mat.blending}（应为 2）`);
    } else {
      samples.push(objId);
    }
  }

  return capabilityCheck(id, label, found.length, problems, `材质已是 AdditiveBlending：${samples.join('、')}`);
}

/** ⑬ visible 轨道：在隐藏区间内对象应不可见 */
function checkVisibleTrack(e: EngineHandle): CheckResult {
  const id = '⑬';
  const label = 'visible 可见性轨道';

  const found = scanObjects(e, (o) =>
    (o.animation?.tracks ?? o.tracks ?? []).some((t: any) => t.path === 'visible'),
  );
  const problems: string[] = [];
  const samples: string[] = [];

  for (const { si, li, id: objId } of found) {
    const built = e.composer.scenes[si];
    const layer = built.layers[li];

    built.applyTime(0);
    const visibleAtZero = layer.object.visible;

    built.applyTime(1);
    const visibleAtEnd = layer.object.visible;

    // 这条轨道必须**真的改变了可见性**，否则等于没生效
    if (visibleAtZero === visibleAtEnd) {
      problems.push(`${objId} 在 t=0 和 t=1 的可见性相同（都是 ${visibleAtZero}）—— 轨道没生效`);
    } else {
      samples.push(`${objId}: t=0 → ${visibleAtZero ? '显示' : '隐藏'}，t=1 → ${visibleAtEnd ? '显示' : '隐藏'}`);
    }
  }

  return capabilityCheck(id, label, found.length, problems, samples.join('、'));
}

/** ⑭ 相机 fov 轨道 */
function checkFovTrack(e: EngineHandle): CheckResult {
  const id = '⑭';
  const label = 'camera fov 轨道';

  const found = (e.composer?.scenes ?? [])
    .map((built: any, si: number) => ({
      si,
      has: (built.config?.camera?.tracks ?? []).some((t: any) => t.path === 'fov'),
    }))
    .filter((x: any) => x.has);

  const problems: string[] = [];
  const samples: string[] = [];

  for (const { si } of found) {
    const built = e.composer.scenes[si];
    built.applyTime(0);
    const f0 = built.camera.fov;
    built.applyTime(1);
    const f1 = built.camera.fov;

    if (Math.abs(f1 - f0) < 1e-3) {
      problems.push(`场景 ${si} 有 fov 轨道但 fov 没变（${f0.toFixed(2)} → ${f1.toFixed(2)}）`);
    } else {
      samples.push(`场景 ${si}: ${f0.toFixed(2)}° → ${f1.toFixed(2)}°`);
    }
  }

  return capabilityCheck(id, label, found.length, problems, samples.join('、'));
}

/** ⑮ tint 着色 */
function checkTint(e: EngineHandle): CheckResult {
  const id = '⑮';
  const label = 'tint 着色';

  const found = scanObjects(e, (o) => typeof o.tint === 'string' && o.tint.toLowerCase() !== '#ffffff');
  const problems: string[] = [];
  const samples: string[] = [];

  for (const { si, li, id: objId } of found) {
    const layer = e.composer.scenes[si].layers[li];
    const cfg = layer.config;
    const mat = layer.mesh?.material;
    if (!mat) continue;

    const want = String(cfg.tint).replace('#', '').toLowerCase();
    const got = mat.color.getHexString().toLowerCase();
    if (want !== got) {
      problems.push(`${objId} 声明 ${cfg.tint}，材质实际 #${got}`);
    } else {
      samples.push(`${objId} ${cfg.tint}`);
    }
  }

  return capabilityCheck(id, label, found.length, problems, `着色正确：${samples.join('、')}`);
}

/** ⑯ 过渡模式：radial 与 sweep 都要在内容里出现过 */
async function checkTransitionModes(e: EngineHandle): Promise<CheckResult> {
  const id = '⑯';
  const label = 'radial / sweep 两种过渡模式';

  const modes = new Set<string>(
    (e.content?.scenes ?? []).map((s: any) => s.transition?.mode).filter(Boolean),
  );

  if (!modes.has('sweep')) {
    return skip(
      id,
      label,
      '当前内容包只用了 radial。sweep 需要**至少 3 个场景**才会触发 —— ' +
        '过渡用的是 currentScene 的模式，所以 scene02 自己的 sweep 要等 scene03 才跑得到',
    );
  }

  // 滚到会触发 sweep 的那一段，读 shader 的 uIsHero
  const uniforms = e.composer?.transitionQuad?.mesh?.material?.uniforms;
  if (!uniforms) return bad(id, label, '找不到过渡 quad');

  const heights: number[] = e.sectionStore.getState().heights ?? [];
  const savedY = window.scrollY;
  let sawSweep = false;
  let sawRadial = false;

  // ★ 必须用**累计偏移**。
  //   `heights[i]` 是每一章**自己**的高度，而 `scrollTo` 要的是从文档顶部
  //   算起的绝对位置。写成 `h * frac` 的话，每一轮都落在第一章里 ——
  //   实测踩过：结果误报"sweep 从未被渲染"，而实际上是根本没滚过去。
  //   （这类 bug 最坑的地方在于：它报的 FAIL 看起来像是引擎的问题。）
  let acc = 0;
  for (const h of heights) {
    for (const frac of [0.2, 0.5, 0.8]) {
      const y = Math.round(acc + h * frac);
      e.scrollEngine.lenis.scrollTo(y, { immediate: true });
      await nextFrames(2);
      const isHero = (uniforms.uIsHero.value as number) > 0.5;
      if (isHero) sawRadial = true;
      else sawSweep = true;
    }
    acc += h;
  }

  e.scrollEngine.lenis.scrollTo(savedY, { immediate: true });
  await nextFrames(3);

  if (!sawSweep) return bad(id, label, '滚遍全部章节，uIsHero 一直是 1 —— sweep 从未被渲染');
  if (!sawRadial) return bad(id, label, '滚遍全部章节，uIsHero 一直是 0 —— radial 从未被渲染');

  return ok(id, label, `两种模式都实际渲染过（radial → uIsHero=1，sweep → uIsHero=0）`);
}

/* ------------------------------------------------------------ 主入口 */

export async function runAcceptance(): Promise<AcceptanceReport> {
  const t0 = performance.now();
  const e = engine();

  if (!e) {
    return {
      checks: [
        bad('—', '引擎已启动', 'window.__ENGINE__ 不存在 —— 内容还没加载完，或初始化失败（看 console）'),
      ],
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: performance.now() - t0,
    };
  }

  const checks: CheckResult[] = [
    checkScenes(e),
    await checkScrollDriving(e),
    checkObjectMotion(e),
    checkCamera(e),
    await checkTransition(e),
    checkAssetDriven(e),

    // ---- 引擎能力覆盖：声明了的能力必须真的生效 ----
    // 放在最后是因为它们会反复调 applyTime 改运行时状态，
    // 前面的检查依赖"干净"的初始状态。
    checkParallax(e),
    checkCameraDamping(e),
    checkBlending(e),
    checkVisibleTrack(e),
    checkFovTrack(e),
    checkTint(e),
    await checkTransitionModes(e),

    await checkPerf(),
    ...skippedChecks(),
  ];

  // applyTime 被验收脚本反复调用过，把画面交还给渲染循环
  await nextFrames(3);

  return {
    checks,
    passed: checks.filter((c) => c.status === 'PASS').length,
    failed: checks.filter((c) => c.status === 'FAIL').length,
    skipped: checks.filter((c) => c.status === 'SKIP').length,
    durationMs: performance.now() - t0,
  };
}

/* ------------------------------------------------------------ 输出 */

const MARK: Record<CheckResult['status'], string> = { PASS: '✓', FAIL: '✗', SKIP: '·' };

export function printReport(report: AcceptanceReport): void {
  const lines = [
    '',
    '══════════════════════════════════════════════════════════════',
    '  里程碑验收（PHASE 11）',
    '══════════════════════════════════════════════════════════════',
  ];

  for (const c of report.checks) {
    lines.push(`  ${MARK[c.status]} ${c.id}  ${c.label}`);
    lines.push(`      ${c.detail}`);
  }

  lines.push('');
  lines.push(
    `  ${report.passed} 通过 / ${report.failed} 失败 / ${report.skipped} 跳过` +
      `   （${report.durationMs.toFixed(0)}ms）`,
  );
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');

  const text = lines.join('\n');
  if (report.failed > 0) console.error(text);
  else console.log(text);
}

/**
 * 挂到 window 上。
 *
 * 只在开发模式挂 —— 生产构建里不该有"能任意滚动页面并改渲染状态"的调试入口。
 */
export function installAcceptance(): void {
  if (!import.meta.env.DEV) return;

  (window as unknown as Record<string, unknown>).__ACCEPTANCE__ = {
    run: async (): Promise<AcceptanceReport> => {
      const report = await runAcceptance();
      printReport(report);
      return report;
    },
    print: printReport,
  };

  // ?accept=1 → 等引擎就绪后自动跑一遍
  if (new URLSearchParams(window.location.search).get('accept') === '1') {
    const wait = (): void => {
      if (engine()) {
        void (window as any).__ACCEPTANCE__.run();
      } else {
        setTimeout(wait, 200);
      }
    };
    setTimeout(wait, 400);
  }
}
