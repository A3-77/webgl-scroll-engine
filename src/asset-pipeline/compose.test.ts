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
  it('dolly 为负 → t=1 时相机 z 更小（推进，不是后退）', () => {
    const { scenes } = composeContent(oneSubject(), { aspect: 2.0, dolly: -6, cameraZ: 6 });
    const track = scenes[0].camera.tracks.find((t) => t.path === 'position.z')!;
    const first = track.keyframes[0].value;
    const last = track.keyframes[track.keyframes.length - 1].value;

    expect(first).toBeGreaterThan(last);
    expect(first).toBeCloseTo(6, 6);
  });

  it('每个场景都有相机轨道', () => {
    const { scenes } = composeContent(
      manifest([scene('a', 1.5, [subject('s1', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })]),
                scene('b', 1.5, [subject('s2', { x: 0.4, y: 0.3, w: 0.2, h: 0.3 })])]),
      { aspect: 2.0 },
    );
    for (const s of scenes) {
      expect(s.camera.tracks.length).toBeGreaterThan(0);
    }
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
