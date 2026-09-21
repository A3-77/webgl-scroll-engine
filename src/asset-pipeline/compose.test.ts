/**
 * composeContent 单元测试
 * ===========================================================================
 *     npm test
 *
 * ---------------------------------------------------------------------------
 * 【为什么这些用例值得写】
 *
 *   `composeContent` 是这个引擎里**唯一有正确性可言**的模块 ——
 *   其它部分（渲染、过渡、滚动）只能靠"看起来对不对"来判断，
 *   而构图是**可计算的**：给定 manifest + aspect，正确答案是唯一的。
 *
 *   所以它也是最该被单测锁死的地方。下面每条用例都对应一个真实踩过的坑。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';
import type { ContentManifest, SceneManifest, SubjectManifest } from '../schema';
import { cameraHasTarget, cameraTracksOf } from '../schema';
import { backgroundAssetKey, composeContent, subjectAssetKey } from './compose';

/* ------------------------------------------------------------ fixture */

function subject(
  id: string,
  box: { x: number; y: number; w: number; h: number },
  aspect = 1,
  areaRatio = 0.1,
): SubjectManifest {
  return {
    id,
    path: `content/test/${id}.webp`,
    box,
    center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    aspect,
    areaRatio,
    pixelCount: Math.round(areaRatio * 1_000_000),
    size: [Math.round(400 * aspect), 400],
    confidence: 'high',
    metrics: {},
  } as SubjectManifest;
}

function scene(
  id: string,
  srcAspect: number,
  subjects: SubjectManifest[],
): SceneManifest {
  return {
    id,
    source: { width: Math.round(1000 * srcAspect), height: 1000, aspect: srcAspect },
    background: `content/test/${id}-bg.webp`,
    subjects,
    provider: 'test',
    generatedAt: '2026-09-20T00:00:00Z',
    confidence: 'high',
    metrics: {},
  } as SceneManifest;
}

function manifest(scenes: SceneManifest[]): ContentManifest {
  return { version: 1, generator: 'test', scenes };
}

/** 一个典型的横排场景：3:2 源图，一个居中的主体 */
const oneSubject = (srcAspect = 1.5) =>
  manifest([
    scene('scene01', srcAspect, [subject('subject-01', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 }, 0.67, 0.06)]),
  ]);

/* ------------------------------------------------------------ 构图公式 */

describe('构图公式（把推导锁死）', () => {
  /**
   * 这是整个自动构图的地基：
   *   fY = max(1, vpAspect / srcAspect)
   *   fX = max(1, srcAspect / vpAspect)
   *   overscan = box.h × fY          ← 主体占屏幕高度的比例
   *   offset   = (center − 0.5) × f  ← 屏幕归一化坐标
   *
   * 曾经踩过的坑：把 `box.w / box.h` 当成主体宽高比用（它是**源图归一化**坐标，
   * 非等比），算出来的尺寸会差 50%。所以这里连 fX 一起对账。
   */
  it('overscan = box.h × fY，offset = (center − 0.5) × f', () => {
    const aspect = 2.0;
    const srcAspect = 1.5;
    const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.3 };

    const { scenes } = composeContent(manifest([scene('s', srcAspect, [subject('sub', box, 0.67, 0.06)])]), {
      aspect,
      // 关掉深度反解的影响，单测映射本身
      dist: [20, 20],
      maxScreenH: 99,
      maxSubjectH: 99,
    });

    const fY = Math.max(1, aspect / srcAspect); // 2.0 / 1.5
    const fX = Math.max(1, srcAspect / aspect); // 1（源图更窄）
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    const sub = scenes[0].objects.find((o) => o.id === 'sub')!;
    expect(sub.overscan).toBeCloseTo(box.h * fY, 6);
    expect(sub.offset![0]).toBeCloseTo((cx - 0.5) * fX, 6);
    expect(sub.offset![1]).toBeCloseTo((0.5 - cy) * fY, 6);
  });

  it('源图比视口宽时，横向才会被裁（fX > 1）', () => {
    const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.3 };
    // 竖版视口 + 横版源图 → 横向放大
    const { scenes } = composeContent(manifest([scene('s', 1.5, [subject('sub', box, 0.67, 0.06)])]), {
      aspect: 0.6,
      dist: [20, 20],
      maxScreenH: 99,
      maxSubjectH: 99,
    });
    const sub = scenes[0].objects.find((o) => o.id === 'sub')!;
    // fX = 1.5 / 0.6 = 2.5；这个主体居中（center.x = 0.5），所以 offset 仍是 0
    expect(sub.offset![0]).toBeCloseTo((0.5 - 0.5) * 2.5, 6);

    // 换成偏左的主体，验证放大确实生效。
    // 注意用**公式**算期望值而不是手写数字 —— 第一版手算成 -1，
    // 实际 center.x 是 0.1 + 0.2/2 = 0.2 → (0.2-0.5)×2.5 = -0.75。
    const leftBox = { x: 0.1, y: 0.3, w: 0.2, h: 0.3 };
    const { scenes: s2 } = composeContent(
      manifest([scene('s', 1.5, [subject('sub', leftBox, 0.67, 0.06)])]),
      { aspect: 0.6, dist: [20, 20], maxScreenH: 99, maxSubjectH: 99 },
    );
    const cx = leftBox.x + leftBox.w / 2;
    expect(s2[0].objects.find((o) => o.id === 'sub')!.offset![0]).toBeCloseTo((cx - 0.5) * 2.5, 6);
  });

  it('z 只影响视差强度，不影响构图（overscan 与 z 无关）', () => {
    const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.3 };
    const m = manifest([scene('s', 1.5, [subject('sub', box, 0.67, 0.06)])]);

    const narrow = composeContent(m, { aspect: 2.0, dist: [18, 22], maxScreenH: 99, maxSubjectH: 99 });
    const wide = composeContent(m, { aspect: 2.0, dist: [30, 40], maxScreenH: 99, maxSubjectH: 99 });

    const zOf = (c: typeof narrow) => c.scenes[0].objects.find((o) => o.id === 'sub')!.z;
    const osOf = (c: typeof narrow) => c.scenes[0].objects.find((o) => o.id === 'sub')!.overscan;

    // z 变了
    expect(zOf(narrow)).not.toBeCloseTo(zOf(wide), 3);
    // 但占屏比例没变
    expect(osOf(narrow)).toBeCloseTo(osOf(wide), 9);
  });
});

/* ------------------------------------------------------------ 深度反解 */

describe('深度反解与尺寸钳制', () => {
  it('主体初始占屏高度不超过 maxSubjectH', () => {
    // 一张 3:2 源图配超宽视口 → cover 会纵向放大 1.55 倍，
    // 一个占源图 72% 高的主体会变成占屏幕 112% —— 整个出界。
    const m = manifest([
      scene('s', 1.5, [subject('big', { x: 0.2, y: 0.1, w: 0.6, h: 0.72 }, 0.8, 0.4)]),
    ]);
    const { scenes } = composeContent(m, { aspect: 3.2 });
    const big = scenes[0].objects.find((o) => o.id === 'big')!;
    expect(big.overscan).toBeLessThanOrEqual(0.92 + 1e-9);
  });

  it('相机推进结束时主体不超过 maxScreenH', () => {
    const m = manifest([
      scene('s', 1.5, [
        subject('a', { x: 0.05, y: 0.1, w: 0.3, h: 0.7 }, 0.5, 0.2),
        subject('b', { x: 0.6, y: 0.3, w: 0.15, h: 0.2 }, 0.6, 0.03),
      ]),
    ]);
    const opts = { aspect: 2.0 };
    const { scenes } = composeContent(m, opts);
    const o = { ...{ dolly: -6, cameraZ: 6, fov: 32 }, ...opts };

    for (const obj of scenes[0].objects) {
      if (obj.role === 'background') continue;
      const d = o.cameraZ - obj.z;
      const zoom = d / (d + o.dolly);
      expect(obj.overscan! * zoom).toBeLessThanOrEqual(1.05 + 1e-6);
    }
  });

  it('相机 z 必须大于所有物体的 z（写反了不报错，只是画面不对）', () => {
    const m = manifest([
      scene('s', 1.5, [
        subject('a', { x: 0.2, y: 0.2, w: 0.3, h: 0.4 }, 0.7, 0.1),
        subject('b', { x: 0.6, y: 0.3, w: 0.2, h: 0.3 }, 0.7, 0.05),
      ]),
    ]);
    const { scenes } = composeContent(m, { aspect: 2.0 });
    const camZ = scenes[0].camera.z;

    for (const obj of scenes[0].objects) {
      expect(obj.z).toBeLessThan(camZ);
    }
  });
});

/* ------------------------------------------------------------ 相机 */

describe('相机轨道', () => {
  /**
   * ★ PHASE 26 之后 `camera.tracks` 是**空的** —— 轨道由 `camera.move`
   *   在 `cameraTracksOf` 里展开。所以断言必须读"生效轨道"，而不是裸的
   *   `camera.tracks`。这条本身就是契约的一部分：引擎侧只认轨道。
   *
   * ★ 而且要取第 1 章：运镜按 MOVE_CYCLE 分配，`dolly` 排在第 1 位。
   *   旧版本"每章都推进"，所以拿任意一章都能验 —— 现在这正是被改掉的东西。
   */
  it('dolly 为负 → t=1 时相机 z 更小（推进，不是后退）', () => {
    const { scenes } = composeContent(
      manifest([
        scene('scene01', 1.5, [subject('s1', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('scene02', 1.5, [subject('s2', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
      ]),
      { aspect: 2.0, dolly: -6, cameraZ: 6 },
    );

    expect(scenes[0].camera.move?.kind).toBe('dolly');

    const track = cameraTracksOf(scenes[0].camera).find((t) => t.path === 'position.z')!;
    const first = track.keyframes[0].value;
    const last = track.keyframes[track.keyframes.length - 1].value;

    expect(first).toBeGreaterThan(last);
    expect(first).toBeCloseTo(6, 6);
  });

  it('每个场景展开后都有相机轨道', () => {
    const { scenes } = composeContent(
      manifest([scene('a', 1.5, [subject('s1', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
                scene('b', 1.5, [subject('s2', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })])]),
      { aspect: 2.0 },
    );
    for (const s of scenes) {
      expect(cameraTracksOf(s.camera).length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------ 镜头语言 */

describe('镜头语言（PHASE 26）', () => {
  const manyScenes = (n: number) =>
    manifest(
      Array.from({ length: n }, (_, i) =>
        scene(`scene0${i + 1}`, 1.5, [
          subject(`subject-01`, { x: 0.4, y: 0.3, w: 0.2, h: 0.3 }, 0.67, 0.06),
        ]),
      ),
    );

  it('每章声明一个运镜，且相邻章节不重复同一个动作', () => {
    const { scenes } = composeContent(manyScenes(6), { aspect: 2.0 });
    const kinds = scenes.map((s) => s.camera.move?.kind);

    expect(kinds.every((k) => typeof k === 'string')).toBe(true);
    // 全部 6 种都上过场 —— 否则"每章同一套动作"的问题只是换了个样子
    expect(new Set(kinds).size).toBe(6);
    for (let i = 1; i < kinds.length; i++) {
      expect(kinds[i]).not.toBe(kinds[i - 1]);
    }
  });

  it('★ 相机真的"会看"：每章都发 target.* 轨道', () => {
    const { scenes } = composeContent(manyScenes(3), { aspect: 2.0 });

    for (const s of scenes) {
      expect(cameraHasTarget(s.camera)).toBe(true);
      const paths = cameraTracksOf(s.camera).map((t) => t.path);
      expect(paths).toContain('target.x');
      expect(paths).toContain('target.y');
      expect(paths).toContain('target.z');
    }
  });

  it('★ target 是"轴线 ↔ 主体"的折中点，不是主体本身', () => {
    // 主体摆在画面左上角 —— 明显偏离轴线，才能验出折中
    const m = manifest([
      scene('s', 1.5, [subject('a', { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, 0.67, 0.06)]),
    ]);
    const { scenes } = composeContent(m, { aspect: 2.0 });
    const cam = scenes[0].camera;

    // 屏幕左上 → 世界 x 负、y 正（offset 的正 y 朝上）
    expect(cam.target![0]).toBeLessThan(0);
    expect(cam.target![1]).toBeGreaterThan(0);
    // 主体在远处，所以 target.z 应该贴着主体所在的平面
    expect(cam.target![2]).toBeCloseTo(cam.move!.subject![2], 6);
    // 折中点在轴线和主体之间 → 偏移量比主体小
    expect(Math.abs(cam.target![0])).toBeLessThan(Math.abs(cam.move!.subject![0]));
  });

  it('lookBlend 是那个"看多准"的旋钮', () => {
    const m = manifest([
      scene('s', 1.5, [subject('a', { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, 0.67, 0.06)]),
    ]);

    const at = (lookBlend: number) =>
      composeContent(m, { aspect: 2.0, lookBlend }).scenes[0].camera;

    const full = at(1); // 死盯主体
    const none = at(0); // 完全不转（看向轴线）
    const half = at(0.5);

    // 完全不转时，看向的就是相机轴线上的点
    expect(none.target![0]).toBeCloseTo(0, 9);
    expect(none.target![1]).toBeCloseTo(0, 9);
    expect(none.target![2]).toBeCloseTo(full.move!.subject![2], 6);

    // 看向主体时，target = 主体质心
    expect(full.target![0]).toBeCloseTo(full.move!.subject![0], 9);
    expect(full.target![1]).toBeCloseTo(full.move!.subject![1], 9);

    // 一半就是一半（轴线在 0）
    expect(half.target![0]).toBeCloseTo(full.target![0] * 0.5, 9);
    expect(half.target![1]).toBeCloseTo(full.target![1] * 0.5, 9);

    // 而"绕谁转"始终是主体，不受 lookBlend 影响
    expect(none.move!.subject).toEqual(full.move!.subject);
  });

  it('★ 推近量受 |dolly| 约束 —— 否则主体会被顶出画面', () => {
    const dolly = -6;
    const cameraZ = 6;
    const { scenes } = composeContent(manyScenes(6), { aspect: 2.0, dolly, cameraZ });

    for (const s of scenes) {
      const cam = s.camera;
      expect(cam.move?.approach).toBeCloseTo(Math.abs(dolly), 9);

      const zTrack = cameraTracksOf(cam).find((t) => t.path === 'position.z')!;
      const zs = zTrack.keyframes.map((k) => k.value);
      // 最近处 = z 最小值；相机初始在 cameraZ，最多只能推近 |dolly|
      expect(cameraZ - Math.min(...zs)).toBeLessThanOrEqual(Math.abs(dolly) + 1e-6);
    }
  });

  it('★ 背景 overscan 覆盖整段运镜 —— 否则会露边', () => {
    const { scenes } = composeContent(manyScenes(6), { aspect: 2.0 });
    const bgOverscanMax = 1.45;

    for (const s of scenes) {
      const bg = s.objects.find((o) => o.role === 'background')!;
      expect(bg.overscan).toBeGreaterThanOrEqual(1);
      // 预算生效：超预算时压的是运镜幅度，不是无限放大背景
      expect(bg.overscan).toBeLessThanOrEqual(bgOverscanMax * 1.03 + 1e-6);
    }
  });

  it('极窄视口下仍然不超预算（横向运镜最吃 overscan）', () => {
    const { scenes } = composeContent(manyScenes(6), { aspect: 0.6 });
    for (const s of scenes) {
      const bg = s.objects.find((o) => o.role === 'background')!;
      expect(bg.overscan).toBeLessThanOrEqual(1.45 * 1.03 + 1e-6);
      expect(bg.overscan).toBeGreaterThanOrEqual(1);
    }
  });

  it('确定性：同样的输入两次构图结果一致', () => {
    const a = composeContent(manyScenes(4), { aspect: 2.0 });
    const b = composeContent(manyScenes(4), { aspect: 2.0 });
    expect(a.scenes.map((s) => s.camera.move)).toEqual(b.scenes.map((s) => s.camera.move));
    expect(a.scenes.map((s) => s.objects[0].overscan)).toEqual(
      b.scenes.map((s) => s.objects[0].overscan),
    );
  });
});

/* ------------------------------------------------------------ 首屏可见性 */

describe('首屏可见性（踩过：打开页面一片空白）', () => {
  /**
   * 首屏 t=0 就是"页面刚打开、还没滚动"。如果首屏主体也走 fadeIn
   * （t=0 时 opacity=0），用户看到的是空背景，会以为坏了。
   */
  it('首个场景的对象在 t=0 时 opacity 不为 0', () => {
    const { scenes } = composeContent(oneSubject(), { aspect: 2.0 });

    for (const obj of scenes[0].objects) {
      const tracks = obj.animation?.tracks ?? obj.tracks ?? [];
      for (const tr of tracks) {
        if (tr.path !== 'opacity') continue;
        // 找 t=0 处的值（首帧或区间外钳制到首帧）
        const kf = tr.keyframes;
        const atZero = kf[0].t <= 0 ? kf[0].value : kf.find((k) => k.t <= 0)?.value ?? kf[0].value;
        expect(atZero, `${obj.id} 在 t=0 时 opacity=${atZero}`).toBeGreaterThan(0);
      }
    }
  });

  it('非首个场景可以有 fadeIn', () => {
    const { scenes } = composeContent(
      manifest([
        scene('a', 1.5, [subject('s1', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('b', 1.5, [subject('s2', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
      ]),
      { aspect: 2.0 },
    );
    const allTracks = (s: (typeof scenes)[number]) =>
      s.objects.flatMap((o) => o.animation?.tracks ?? o.tracks ?? []);
    expect(allTracks(scenes[1]).some((t) => t.path === 'opacity')).toBe(true);
  });
});

/* ------------------------------------------------------------ 契约字段 */

describe('契约字段', () => {
  it('背景与主体的 role 正确', () => {
    const { scenes } = composeContent(
      manifest([scene('s', 1.5, [
        subject('a', { x: 0.2, y: 0.3, w: 0.2, h: 0.3 }),
        subject('b', { x: 0.6, y: 0.3, w: 0.2, h: 0.3 }),
      ])]),
      { aspect: 2.0 },
    );
    const roles = scenes[0].objects.map((o) => o.role);
    expect(roles.filter((r) => r === 'background')).toHaveLength(1);
    expect(roles.filter((r) => r === 'subject')).toHaveLength(2);
  });

  it('背景标了 opaque，主体没有', () => {
    const { scenes } = composeContent(oneSubject(), { aspect: 2.0 });
    for (const obj of scenes[0].objects) {
      if (obj.role === 'background') expect(obj.opaque).toBe(true);
      else expect(obj.opaque).toBeFalsy();
    }
  });

  it('资产 key 格式稳定', () => {
    expect(backgroundAssetKey('scene01')).toBe('bg-scene01');
    expect(subjectAssetKey('scene01', 'subject-02')).toBe('scene01-subject-02');
  });

  it('每个对象的 asset key 都能在 assets 表里找到（否则渲染时是空的）', () => {
    const { scenes, assets } = composeContent(
      manifest([scene('s', 1.5, [
        subject('a', { x: 0.2, y: 0.3, w: 0.2, h: 0.3 }),
        subject('b', { x: 0.6, y: 0.3, w: 0.2, h: 0.3 }),
      ])]),
      { aspect: 2.0 },
    );
    for (const obj of scenes[0].objects) {
      expect(assets[obj.asset], `缺少资产 ${obj.asset}`).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------ 边界与确定性 */

describe('边界与确定性', () => {
  it('同样输入永远同样输出（纯函数）', () => {
    const m = oneSubject();
    const a = composeContent(m, { aspect: 2.0 });
    const b = composeContent(m, { aspect: 2.0 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('极端宽高比不崩', () => {
    for (const aspect of [0.35, 0.6, 1.0, 1.78, 3.5, 5.0]) {
      expect(() => composeContent(oneSubject(), { aspect })).not.toThrow();
    }
  });

  it('没有主体的场景不崩，只生成背景', () => {
    const { scenes } = composeContent(manifest([scene('empty', 1.5, [])]), { aspect: 2.0 });
    expect(scenes).toHaveLength(1);
    expect(scenes[0].objects).toHaveLength(1);
    expect(scenes[0].objects[0].role).toBe('background');
  });

  it('空 manifest 返回空场景列表', () => {
    const { scenes, assets } = composeContent(manifest([]), { aspect: 2.0 });
    expect(scenes).toHaveLength(0);
    expect(Object.keys(assets)).toHaveLength(0);
  });

  it('场景顺序与 manifest 一致', () => {
    const { scenes } = composeContent(
      manifest([
        scene('a', 1.5, [subject('x', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('b', 1.5, [subject('y', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('c', 1.5, [subject('z', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
      ]),
      { aspect: 2.0 },
    );
    expect(scenes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(scenes.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('earlyCrossfade 按 index >= 2 的规则推导', () => {
    const { scenes } = composeContent(
      manifest([
        scene('a', 1.5, [subject('x', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('b', 1.5, [subject('y', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('c', 1.5, [subject('z', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
      ]),
      { aspect: 2.0 },
    );
    expect(scenes[0].earlyCrossfade).toBe(0);
    expect(scenes[1].earlyCrossfade).toBe(0);
    expect(scenes[2].earlyCrossfade).toBeCloseTo(0.2, 6);
  });

  it('过渡模式：首章 radial，其余 sweep', () => {
    const { scenes } = composeContent(
      manifest([
        scene('a', 1.5, [subject('x', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
        scene('b', 1.5, [subject('y', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
      ]),
      { aspect: 2.0 },
    );
    expect(scenes[0].transition.mode).toBe('radial');
    expect(scenes[1].transition.mode).toBe('sweep');
  });

  it('主体之间的运动轨迹互不相同（否则看起来像整块平移）', () => {
    const { scenes } = composeContent(
      manifest([scene('s', 1.5, [
        subject('a', { x: 0.2, y: 0.3, w: 0.2, h: 0.3 }, 1, 0.1),
        subject('b', { x: 0.5, y: 0.3, w: 0.2, h: 0.3 }, 1, 0.1),
        subject('c', { x: 0.8, y: 0.3, w: 0.2, h: 0.3 }, 1, 0.1),
      ])]),
      { aspect: 2.0 },
    );
    const sigs = scenes[0].objects
      .filter((o) => o.role === 'subject')
      .map((o) => JSON.stringify((o.animation?.tracks ?? []).map((t) => [t.path, t.keyframes.map((k) => k.value)])));
    expect(new Set(sigs).size).toBeGreaterThan(1);
  });
});
