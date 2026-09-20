import { useState } from 'react';
import type { AudioSystem } from '../engine/systems/AudioSystem';

/**
 * ★ 声音开关 —— 用户手势的入口
 * ===========================================================================
 * 这个按钮存在的理由不是"有个开关很方便"，而是**浏览器强制要求的**：
 *
 *   AudioContext 必须在用户手势的同步调用栈里 resume。
 *   页面自己调用 AudioSystem.start() 会得到一个 suspended 的上下文，
 *   永远不出声，而且控制台一声不吭 —— 极难排查。
 *
 *   所以 `onClick` 里**第一行**就是 `audio.start()`，中间不能有任何 await。
 *
 * ---------------------------------------------------------------------------
 * 【为什么默认 OFF】
 *   突然出声的网页是最招人烦的东西之一。让声音变成"用户主动邀请"，
 *   既符合自动播放策略，也是基本的礼貌。
 *   参考站点（iamsaeed.dev）甚至专门为这件事做了一张邀请卡片 ——
 *   我们这里一个角上的小开关就够了，但原则是同一条。
 *
 * ---------------------------------------------------------------------------
 * 【为什么用 useState 而不是读 audio.stats】
 *   stats 是每帧被改写的可变对象，React 不会为它重渲染。
 *   而"开/关"是一个离散的、由**用户动作**驱动的状态 ——
 *   它天然属于 React。每帧去同步一个每帧都在变的值到 React 是反模式。
 */
interface AudioToggleProps {
  audio: AudioSystem | null;
  /** 内容包是否声明了音频配置。没声明就干脆不显示按钮 */
  enabled: boolean;
}

export function AudioToggle({ audio, enabled }: AudioToggleProps) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!enabled || !audio) return null;

  const toggle = (): void => {
    if (busy) return;

    if (on) {
      audio.stop();
      setOn(false);
      return;
    }

    setBusy(true);
    // ★ 同步调用 —— 必须在 click 的调用栈里触发 Tone.start()
    void audio
      .start()
      .then((ok) => {
        setBusy(false);
        if (ok) setOn(true);
        else setFailed(true);
      })
      .catch(() => {
        setBusy(false);
        setFailed(true);
      });
  };

  return (
    <button
      type="button"
      className={`audio-toggle${on ? ' is-on' : ''}`}
      onClick={toggle}
      disabled={busy || failed}
      aria-pressed={on}
      aria-label={on ? '关闭声音' : '开启声音'}
      title={
        failed
          ? '音频启动失败（浏览器拒绝或 Tone.js 加载失败）'
          : on
            ? '关闭声音'
            : '开启声音：环境音 + 滚动驱动的音色变化'
      }
    >
      <span className="audio-toggle__dot" />
      {failed ? 'AUDIO FAILED' : busy ? '…' : on ? 'SOUND ON' : 'SOUND OFF'}
    </button>
  );
}
