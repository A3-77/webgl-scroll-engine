import { useEffect, useState } from 'react';
import { CanvasHost } from '../components/CanvasHost';
import { ScrollSections, SectionNav } from '../components/ScrollSections';
import { AudioToggle } from '../components/AudioToggle';
import { DebugHUD } from '../components/DebugHUD';
import { AudioSystem } from '../engine/systems/AudioSystem';
import { loadContentPack, applySiteToCss, type LoadedContent } from '../config/content.config';

/**
 * ★ 装配层（composition root）—— 全项目唯一知道"引擎 + 哪个内容包"的地方
 * ---------------------------------------------------------------------------
 * 引擎不知道内容从哪来，内容包不知道引擎怎么用 —— 两边都只依赖 schema。
 * 把它们接起来是这个文件的唯一职责。
 *
 * 装配动作只有四步：
 *   1. 解析 URL 参数（?content=xxx）决定加载哪个内容包
 *   2. 把内容包的站点配置写成 CSS 变量（字体 / 字号阶梯）
 *   3. 把解析后的 { assets, scenes } 交给 CanvasHost
 *   4. 把 scenes 交给 DOM 层（章节文案 / 导航点 / 调试面板）
 *
 * ★ 为什么这里存的是 `LoadedContent` 而不是 `ContentPack`：
 *   素材驱动的包（cats）在拿到 pack 之后还要异步解析出 scenes ——
 *   解析动作发生在 `loadContentPack` 里，所以拿到手时已经解析完了。
 *   App 不需要知道"这个包是静态的还是动态的"，那是包自己的事。
 *
 * 页面结构（三层，顺序不能反）：
 *   1. CanvasHost     —— sticky 钉住的 WebGL 画布，负 margin 把自己抽离文档流
 *   2. ScrollSections —— 透明的 DOM 章节，提供滚动高度 + 文案，叠在画布之上
 *   3. SectionNav / DebugHUD —— 固定定位的 UI
 */
export default function App() {
  const [loaded, setLoaded] = useState<LoadedContent | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<AudioSystem | null>(null);

  /**
   * ★ 音频系统由装配层持有。
   *
   * 为什么放在 App 而不是 CanvasHost 里 new：
   *   开关按钮在 DOM 层、渲染循环在 CanvasHost，两边都要拿同一个实例。
   *   装配层的职责本来就是"把各部分接起来"，让实例诞生在这里最自然。
   *
   * 为什么要等 loaded：
   *   AudioSystem 的构造参数来自内容包的 `site.audio`。
   *   早于内容包解析完成创建，就只能用引擎默认值 ——
   *   那样内容包声明的音色就永远不生效了。
   */
  useEffect(() => {
    if (!loaded) return;
    const a = new AudioSystem(loaded.pack.site.audio);
    setAudio(a);
    return () => {
      a.dispose();
      setAudio(null);
    };
  }, [loaded]);

  useEffect(() => {
    let cancelled = false;

    void loadContentPack()
      .then((result) => {
        if (cancelled) return;
        // 站点配置 → CSS 变量。必须在渲染章节之前完成，
        // 否则首帧会先按默认字号排一遍，然后跳变。
        applySiteToCss(result.pack.site);
        setLoaded(result);
        setWarning(result.warning);
        if (result.warning) console.warn('[content]', result.warning);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[App] 内容包加载失败:', err);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="boot">
        <h1 className="boot__title">引擎启动失败</h1>
        <pre className="boot__detail">{error}</pre>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="boot">
        <h1 className="boot__title">加载内容包…</h1>
      </div>
    );
  }

  const { pack, content } = loaded;

  return (
    <div className="app">
      <CanvasHost pack={pack} content={content} audio={audio} />
      <ScrollSections scenes={content.scenes} />
      <SectionNav scenes={content.scenes} />
      {/* 声音开关：默认 OFF，用户点击才启动 AudioContext（浏览器自动播放策略） */}
      <AudioToggle audio={audio} enabled />
      <DebugHUD
        scenes={content.scenes}
        packLabel={pack.label}
        warning={warning}
        notes={content.notes ?? null}
      />
    </div>
  );
}
