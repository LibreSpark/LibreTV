'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icon';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { V4HomepageHeader } from '@/components/home/V4HomepageHeader';

const categories = [
  { label: '动作', query: '动作电影', detail: '热血、冒险与强节奏', image: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=900&q=85', tone: 'action' },
  { label: '剧情', query: '剧情电影', detail: '值得细细品味的故事', image: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=900&q=85', tone: 'drama' },
  { label: '喜剧', query: '喜剧电影', detail: '轻松时刻与快乐灵感', image: 'https://images.unsplash.com/photo-1527224857830-43a7acc85260?auto=format&fit=crop&w=900&q=85', tone: 'comedy' },
  { label: '科幻', query: '科幻电影', detail: '探索未知与未来世界', image: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=900&q=85', tone: 'scifi' },
  { label: '悬疑', query: '悬疑电影', detail: '线索、反转与谜题', image: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=900&q=85', tone: 'mystery' },
  { label: '爱情', query: '爱情电影', detail: '关于相遇与心动', image: 'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?auto=format&fit=crop&w=900&q=85', tone: 'romance' },
  { label: '动画', query: '动画电影', detail: '想象力不设限', image: 'https://images.unsplash.com/photo-1535223289827-42f1e9919769?auto=format&fit=crop&w=900&q=85', tone: 'animation' },
  { label: '纪录片', query: '纪录片', detail: '看见真实世界', image: 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=900&q=85', tone: 'documentary' },
] as const;

export default function SearchPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [voiceState, setVoiceState] = useState<'IDLE'|'LISTENING'|'THINKING'|'SPEAKING'>('IDLE');
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useSearchHistory(query);

  useEffect(() => {
    inputRef.current?.focus();
    const onTranscript = (event: Event) => {
      const transcript = (event as CustomEvent<{text?:string}>).detail?.text?.trim();
      if (transcript) setQuery(transcript.slice(0,100));
    };
    const onState = (event: Event) => {
      const state = (event as CustomEvent<{state?:string}>).detail?.state;
      if (state && ['IDLE','LISTENING','THINKING','SPEAKING'].includes(state)) setVoiceState(state as typeof voiceState);
    };
    window.addEventListener('friday-home-transcript', onTranscript);
    window.addEventListener('friday-home-voice-state', onState);
    return () => {
      window.removeEventListener('friday-home-transcript', onTranscript);
      window.removeEventListener('friday-home-voice-state', onState);
    };
  }, []);

  const submit = (value = query) => {
    const text = value.trim().slice(0,100);
    if (!text) { inputRef.current?.focus(); return; }
    history.record(text);
    history.close();
    router.push('/search/results?q=' + encodeURIComponent(text));
  };
  const pick = (value: string) => { setQuery(value); submit(value); };
  const toggleVoice = () => window.dispatchEvent(new CustomEvent('friday-home-orb-toggle'));

  return (
    <div className="v4-search-page">
      <V4HomepageHeader />
      <main className="v4-search-main">
        <header className="v4-search-heading">
          <h1>搜索</h1>
        </header>

        <div className="v4-search-box" ref={history.containerRef}>
          <form role="search" onSubmit={event => { event.preventDefault(); submit(); }}>
            <Icon name="search" />
            <input
              ref={inputRef}
              value={query}
              maxLength={100}
              placeholder={voiceState === 'LISTENING' ? '正在聆听…' : '搜索电影、电视剧、动漫'}
              aria-label="搜索影视内容"
              onChange={event => { setQuery(event.target.value); history.resetActive(); }}
              onFocus={history.onFocus}
              onKeyDown={event => history.onKeyDown(event,pick)}
            />
            {query && <button className="v4-search-clear" type="button" aria-label="清空搜索" onClick={() => {setQuery('');inputRef.current?.focus();}}><Icon name="close"/></button>}
            <button className={'v4-search-mic' + (voiceState === 'LISTENING' ? ' is-listening' : '')} type="button" aria-label={voiceState === 'LISTENING' ? '停止语音搜索' : '语音搜索'} aria-pressed={voiceState === 'LISTENING'} onClick={toggleVoice}><Icon name="microphone"/></button>
          </form>
          {history.visible && <SearchHistoryDropdown id="search-page-history" matches={history.matches} activeIndex={history.activeIndex} onPick={pick} onRemove={history.remove} onClearAll={history.clearAll}/>}
        </div>

        {history.matches.length > 0 && (
          <section className="v4-search-recent" aria-label="最近搜索">
            <h2>最近搜索</h2>
            <div>{history.matches.slice(0,6).map(item => <button key={item.text} type="button" onClick={() => pick(item.text)}><Icon name="clock"/><span>{item.text}</span></button>)}</div>
          </section>
        )}

        <section className="v4-search-explore" aria-labelledby="v4-search-explore-title">
          <div className="v4-search-section-heading">
            <h2 id="v4-search-explore-title">探索分类</h2>
          </div>
          <div className="v4-search-category-grid">
            {categories.map(category => (
              <button key={category.label} type="button" className={'v4-search-category-card tone-' + category.tone} onClick={() => submit(category.query)} style={{ backgroundImage: 'linear-gradient(180deg, transparent 35%, rgba(0,0,0,.48) 100%)' }}>
                <img className="v4-search-category-image" src={category.image} alt="" loading="lazy" onError={event => { const image = event.currentTarget; if (!image.dataset.fallback) { image.dataset.fallback = 'true'; image.src = 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=900&q=80'; } else { image.style.display = 'none'; } }} />
                <span className="v4-search-category-copy"><strong>{category.label}</strong></span>
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
