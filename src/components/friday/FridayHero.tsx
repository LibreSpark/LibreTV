'use client';

import { useEffect, useState } from 'react';
import { FridayOrbVisual } from '@/components/friday/FridayOrbVisual';

type FridayHeroProps = {
  onSearchFocus: () => void;
};

/** 首页 Friday 主入口。语音会话仍由唯一挂载的 AIFloatingBall 协调。 */
export function FridayHero({ onSearchFocus }: FridayHeroProps) {
  const [orbState, setOrbState] = useState<'standby' | 'listening' | 'thinking' | 'speaking' | 'completed'>('standby');

  useEffect(() => {
    const onVoiceState = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: typeof orbState }>).detail;
      if (detail?.state) setOrbState(detail.state);
    };
    window.addEventListener('friday-voice-state', onVoiceState);
    return () => window.removeEventListener('friday-voice-state', onVoiceState);
  }, []);
  const startVoice = () => {
    window.dispatchEvent(
      new CustomEvent('toggle-friday-panel', {
        detail: { reset: false, listen: true, immersive: true },
      }),
    );
  };

  return (
    <section className="friday-hero-v2" aria-label="Friday 影视助手">
      <p className="friday-hero-eyebrow">FRIDAY · AI ASSISTANT</p>
      <h1 className="friday-hero-title">今天想看什么？</h1>
      <p className="friday-hero-description">
        说出你想看的内容，Friday 帮你寻找。
      </p>

      <button
        type="button"
        className="friday-hero-orb-button"
        onClick={startVoice}
        aria-label="打开 Friday 并开始语音聆听"
      >
        <span className="friday-hero-orb">
          <FridayOrbVisual state={orbState} />
        </span>
        <span className="friday-hero-orb-label">进入沉浸式语音</span>
      </button>

      <button
        type="button"
        className="friday-hero-text-entry"
        onClick={onSearchFocus}
      >
        或者直接输入片名搜索
      </button>
    </section>
  );
}
