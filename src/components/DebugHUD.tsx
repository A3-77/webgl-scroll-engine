import { useEffect, useState } from 'react';
import type { SceneConfig } from '../schema';
import { sectionStore } from '../store/sectionStore';

interface Snapshot {
  activeSection: number;
  currentIndex: number;
  nextIndex: number;
  progress: number;
  nextProgress: number;
  scrollY: number;
  viewportH: number;
  heights: number[];
  drawCalls: number;
  triangles: number;
  drawSize: string;
  bloom: boolean;
  fps: number;
  dpr: number;
  objectCount: number;
  textureCount: number;
}

const EMPTY: Snapshot = {
  activeSection: 0,
  currentIndex: 0,
  nextIndex: -1,
  progress: 0,
  nextProgress: 0,
  scrollY: 0,
  viewportH: 0,
  heights: [],
  drawCalls: 0,
  triangles: 0,
  drawSize: '—',
  bloom: true,
  fps: 0,
  dpr: 0,
  objectCount: 0,
  textureCount: 0,
};

interface DebugHUDProps {
  scenes: SceneConfig[];
  /** 内容包标签，显示在面板头部 */
  packLabel?: string;
  /** 内容包回落提示 */
  warning?: string | null;
  /**
   * 内容包给出的非致命提醒（例：某张图分割置信度偏低）。
   *
   * 为什么值得单独开一块 UI：这类信息在终端里早就打出来了，
   * 但**没人会去翻终端**。放到面板上，用户才会真的看到并去处理。
   */
  notes?: string[] | null;
}

/**
 * 调试面板 —— 直接读渲染管线暴露的实时统计。
 *
 * ★ 刻意以 10fps 更新（不是每帧）：
 *   这个面板是 DOM，每帧 setState 会让 React 每秒重渲染 60 次，
 *   把主线程抢走，反而把帧率压下去 —— 测量行为本身干扰被测对象。
 *   3D 循环里读 store 是零成本的（直接 getState），DOM 层才需要节流。
 *
 * 【改造说明】场景数据从 props 来，不再 import 配置。
 *   统计信息从 `window.__ENGINE__` 读 —— 那是装配层挂出去的调试入口。
 */
export function DebugHUD({ scenes, packLabel, warning, notes }: DebugHUDProps) {
  const [open, setOpen] = useState(true);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);

  useEffect(() => {
    let raf = 0;
    let lastSample = 0;
    let frames = 0;
    let fps = 0;

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      frames++;

      if (now - lastSample < 100) return;

      const dt = (now - lastSample) / 1000;
      fps = Math.round(frames / dt);
      frames = 0;
      lastSample = now;

      const api = (window as unknown as Record<string, any>).__ENGINE__;
      const s = sectionStore.getState();
      const stats = api?.composer?.stats;

      setSnap({
        activeSection: s.activeSection,
        currentIndex: s.current.index,
        nextIndex: s.next ? s.next.index : -1,
        progress: s.current.progress,
        nextProgress: s.next ? s.next.progress : 0,
        scrollY: s.scrollY,
        viewportH: s.viewportH,
        heights: s.heights,
        drawCalls: stats?.drawCalls ?? 0,
        triangles: stats?.triangles ?? 0,
        drawSize: stats?.drawSize ?? '—',
        bloom: stats?.bloom ?? true,
        fps,
        dpr: api?.renderer?.getPixelRatio?.() ?? 0,
        objectCount: api?.content?.scenes?.reduce(
          (n: number, sc: SceneConfig) => n + sc.objects.length,
          0,
        ) ?? 0,
        // ★ 注意是 `stats.textureCount`，不是 `composer.textureCount` ——
        //   后者不存在，读出来恒为 undefined → 面板上永远显示 0，
        //   会让人误以为纹理没加载。实测踩过。
        textureCount: stats?.textureCount ?? 0,
      });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const error = useError();

  if (!open) {
    return (
      <button type="button" className="hud__toggle" onClick={() => setOpen(true)}>
        stats
      </button>
    );
  }

  const cur = scenes[snap.currentIndex];
  const nxt = snap.nextIndex >= 0 ? scenes[snap.nextIndex] : null;

  return (
    <aside className="hud">
      <header className="hud__head">
        <span className="hud__title">{packLabel ?? '渲染管线'}</span>
        <button type="button" className="hud__close" onClick={() => setOpen(false)} aria-label="收起">
          ×
        </button>
      </header>

      {warning ? <p className="hud__warn">{warning}</p> : null}
      {error ? <p className="hud__error">初始化失败：{error}</p> : null}
      {notes?.length ? (
        <ul className="hud__notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}

      <div className="hud__grid">
        <Row label="fps" value={String(snap.fps)} />
        <Row label="dpr" value={snap.dpr.toFixed(2)} />
        <Row label="draw size" value={snap.drawSize} />
        <Row label="draw calls" value={String(snap.drawCalls)} />
        <Row label="triangles" value={String(snap.triangles)} />
        <Row label="textures" value={String(snap.textureCount)} />
        <Row label="bloom" value={snap.bloom ? 'on' : 'off'} />
        <Row label="objects" value={String(snap.objectCount)} />

        <Row label="scrollY" value={snap.scrollY.toFixed(1)} />
        <Row label="viewportH" value={String(snap.viewportH)} />
        <Row label="activeSection" value={String(snap.activeSection)} />
      </div>

      <div className="hud__bars">
        <Bar
          label={`current · ${cur ? cur.handle : '—'}`}
          value={snap.progress}
          accent={cur?.accent ?? '#fff'}
        />
        <Bar
          label={`next · ${nxt ? nxt.handle : '（无交叉）'}`}
          value={nxt ? snap.nextProgress : 0}
          accent={nxt?.accent ?? '#555'}
          dim={!nxt}
        />
      </div>

      <div className="hud__heights">
        <span className="hud__muted">section heights (px)</span>
        <div className="hud__chips">
          {snap.heights.map((h, i) => (
            <span key={i} className={`hud__chip${i === snap.activeSection ? ' is-active' : ''}`}>
              {Math.round(h)}
            </span>
          ))}
        </div>
      </div>

      <p className="hud__hint">
        控制台可用 <code>__ENGINE__</code> 访问 composer / renderer / store / pack
      </p>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud__row">
      <span className="hud__label">{label}</span>
      <span className="hud__value">{value}</span>
    </div>
  );
}

function Bar({
  label,
  value,
  accent,
  dim,
}: {
  label: string;
  value: number;
  accent: string;
  dim?: boolean;
}) {
  return (
    <div className={`hud__bar${dim ? ' is-dim' : ''}`}>
      <div className="hud__bar-head">
        <span className="hud__label">{label}</span>
        <span className="hud__value">{(value * 100).toFixed(1)}%</span>
      </div>
      <div className="hud__bar-track">
        <div
          className="hud__bar-fill"
          style={{ width: `${Math.min(100, value * 100)}%`, background: accent }}
        />
      </div>
    </div>
  );
}

function useError(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const unsub = sectionStore.subscribe(
      (s) => s.error,
      (v) => setError(v),
    );
    setError(sectionStore.getState().error);
    return unsub;
  }, []);
  return error;
}
