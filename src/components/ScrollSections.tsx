import type { CSSProperties } from 'react';
import type { SceneConfig } from '../schema';
import { sectionStore } from '../store/sectionStore';
import { useStore } from '../hooks/useStore';

/** 把配置里的 accent 透传成 CSS 变量，避免在每个子元素上写 style */
const accentVar = (accent: string): CSSProperties => ({ '--accent': accent }) as CSSProperties;

interface SectionsProps {
  scenes: SceneConfig[];
}

/**
 * DOM 覆盖层 —— 提供滚动高度 + 章节文案。
 *
 * 为什么文案不放 WebGL 里？
 *   真实站点也是 DOM 文字（可选中、可被搜索引擎读、能直接用系统字体渲染）。
 *   3D 只负责画面，文字交给浏览器排版引擎 —— 这是这类站的标准分工。
 *
 * 每个 section 的 height 决定「滚多远换一章」：
 *   height = 1.2 × 100vh  →  progress 的完整区间是 1.2vh + 1vh = 2.2vh 的滚动距离
 *
 * 【改造说明】场景数据从 props 来（由 app 装配层注入），不再直接 import 配置。
 *   本组件因此是通用的 —— 换内容包它一行不用改。
 */
export function ScrollSections({ scenes }: SectionsProps) {
  const active = useStore(sectionStore, (s) => s.activeSection);
  const ready = useStore(sectionStore, (s) => s.ready);

  return (
    <div className="sections">
      {scenes.map((scene, i) => {
        const isActive = active === i;
        return (
          <section
            key={scene.id}
            data-section-id={scene.handle}
            className={`section${isActive ? ' is-active' : ''}${ready ? ' is-ready' : ''}`}
            style={{
              height: `${scene.heightVh * 100}vh`,
              ...accentVar(scene.accent),
            }}
          >
            <div className="section__inner">
              <p className="section__eyebrow">{scene.eyebrow}</p>

              <h2 className="section__title">{scene.title}</h2>

              <p className="section__body">{scene.body}</p>

              <dl className="section__meta">
                <div>
                  <dt>camera z</dt>
                  <dd>{scene.camera.z.toFixed(2)}</dd>
                </div>
                <div>
                  <dt>fov</dt>
                  <dd>{scene.camera.fov.toFixed(1)}</dd>
                </div>
                <div>
                  <dt>transition</dt>
                  <dd>{scene.transition.mode}</dd>
                </div>
                <div>
                  <dt>objects</dt>
                  <dd>{scene.objects.length}</dd>
                </div>
              </dl>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** 章节导航点 —— 顺便当成"当前在第几章"的可视指示 */
export function SectionNav({ scenes }: SectionsProps) {
  const active = useStore(sectionStore, (s) => s.activeSection);

  return (
    <nav className="nav" aria-label="章节导航">
      {scenes.map((scene, i) => (
        <button
          key={scene.id}
          type="button"
          className={`nav__dot${active === i ? ' is-active' : ''}`}
          style={accentVar(scene.accent)}
          onClick={() => {
            const api = (window as unknown as Record<string, any>).__ENGINE__;
            api?.scrollEngine?.scrollToSection(i);
          }}
          title={scene.title}
        >
          <span className="nav__label">{String(i + 1).padStart(2, '0')}</span>
        </button>
      ))}
    </nav>
  );
}
