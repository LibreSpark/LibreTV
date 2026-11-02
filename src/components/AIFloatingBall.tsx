'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppStore, resolveSource } from '@/lib/store';
import type { SearchResultItem } from '@/lib/types';

type UIMessage = { id: string; role: 'user' | 'assistant'; type: 'text' | 'movie_list'; content: string; items?: SearchResultItem[]; };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string; }; };
type HistoryMessage = { role: 'user' | 'assistant' | 'tool'; content?: string | null; tool_call_id?: string; tool_calls?: ToolCall[]; };

const MAX_HISTORY = 24;
const MAX_TOOL_ROUNDS = 5;
const ALLOWED_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSearchResultItem(value: unknown): value is SearchResultItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.sourceKey === 'string' &&
    typeof value.sourceName === 'string' &&
    typeof value.vodId === 'string' &&
    typeof value.name === 'string'
  );
}

function compactHistory(history: HistoryMessage[]): HistoryMessage[] {
  const groups: HistoryMessage[][] = [];
  let current: HistoryMessage[] = [];
  for (const message of history) {
    if (message.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  
  const result: HistoryMessage[][] = [];
  let count = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (result.length > 0 && count + group.length > MAX_HISTORY) break;
    result.unshift(group);
    count += group.length;
  }
  return result.flat();
}

export default function AIFloatingBall() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [voiceEnabled, setVoiceEnabled] = useState(false); 
  
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ballX: 0, ballY: 0 });
  const listRef = useRef<HTMLDivElement | null>(null);
  const sendLock = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const apiHistoryRef = useRef<HistoryMessage[]>([]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, active]);

  useEffect(() => {
    return () => { 
      abortRef.current?.abort(); 
      if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); 
    };
  }, []);

  const speak = useCallback((text: string) => {
    if (!voiceEnabled || !text || typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    window.speechSynthesis.speak(utterance);
  }, [voiceEnabled]);

  const addTextMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    setMessages(prev => [...prev, { id: uid(), role, type: 'text', content }]);
    if (role === 'assistant') speak(content);
  }, [speak]);

  const addMovieList = useCallback((items: SearchResultItem[]) => {
    if (!items || items.length === 0) return;
    setMessages(prev => [...prev, { id: uid(), role: 'assistant', type: 'movie_list', content: '为你找到以下资源：', items }]);
  }, []);

  const openNativeDetail = useCallback((item: SearchResultItem) => {
    window.dispatchEvent(new CustomEvent('friday-open-detail', {
      detail: { sourceKey: item.sourceKey, sourceName: item.sourceName, sourceUrl: item.sourceUrl, vodId: item.vodId, name: item.name, pic: item.pic }
    }));
  }, []);

  const stopRequest = useCallback(() => { 
    abortRef.current?.abort(); 
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); 
  }, []);

  const executeUiTool = useCallback(async (tc: ToolCall): Promise<string> => {
    try {
      const args = JSON.parse(tc.function.arguments || '{}');
      if (tc.function.name === 'control_player') {
        const video = document.getElementById('libretv-main-video') as HTMLVideoElement;
        if (!video) return '播放器不存在';
        
        if (args.action === 'play') { await video.play().catch(()=>{}); return '播放成功'; }
        if (args.action === 'pause') { video.pause(); return '暂停成功'; }
        if (args.action === 'seek_to') { video.currentTime = args.time; return `已跳转`; }
        if (args.action === 'set_rate') { video.playbackRate = args.rate; return `已设倍速`; }
        return '未知操作';
      }
      if (tc.function.name === 'page_control') {
        if (args.action === 'navigate' && args.path) { router.push(args.path); return '已跳转'; }
        if (args.action === 'site_search' && args.keyword) { router.push(`/search?wd=${encodeURIComponent(args.keyword)}`); return '已搜索'; }
        if (args.action === 'toggle_theme') { document.documentElement.classList.toggle('dark'); return '已切主题'; }
        return '未知操作';
      }
      return '不支持的工具';
    } catch (err: any) { return `执行异常: ${err.message}`; }
  }, [router]);

  const send = useCallback(async (overrideText?: string) => {
    if (sendLock.current) return;
    const text = (overrideText !== undefined ? overrideText : input).trim();
    if (!text) return;

    sendLock.current = true;
    setInput('');
    setBusy(true);
    addTextMessage('user', text);
    apiHistoryRef.current.push({ role: 'user', content: text });

    const state = useAppStore.getState();
    const selectedSources = state.selectedKeys
      .map((key: string) => resolveSource(state, key))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map(s => ({ key: s.key, name: s.name, url: s.url, isAdult: s.isAdult }));

    const controller = new AbortController();
    abortRef.current = controller;
    let completed = false;

    try {
      for (let step = 0; step < MAX_TOOL_ROUNDS; step++) {
        if (controller.signal.aborted) break;

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            messages: apiHistoryRef.current,
            sources: selectedSources,
            filterAdult: state.yellowFilter === true
          }),
          signal: controller.signal,
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '请求失败');
        if (controller.signal.aborted) break;

        if (Array.isArray(data.movieData) && data.movieData.length > 0) {
          addMovieList(data.movieData);
        }

        if (data.type === 'final') {
          if (data.text) {
            apiHistoryRef.current.push({ role: 'assistant', content: data.text });
            addTextMessage('assistant', data.text);
          }
          completed = true;
          break;
        }

        if (data.type === 'tool_calls') {
          apiHistoryRef.current.push(data.assistantMessage);
          if (data.serverToolMessages) apiHistoryRef.current.push(...data.serverToolMessages);

          if (data.uiToolCalls) {
            for (const call of data.uiToolCalls) {
              const result = await executeUiTool(call);
              apiHistoryRef.current.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
          }
          continue;
        }
      }
      if (!completed && !controller.signal.aborted) {
        addTextMessage('assistant', '工具调用次数已达上限。');
      }
    } catch (error: any) {
      // 🚨 核心修复：不再无脑回滚整个历史，只清理可能未完成的工具调用
      if (error.name !== 'AbortError') {
        addTextMessage('assistant', `请求异常：${error.message}`);
      } else {
        addTextMessage('assistant', '已取消本次请求。');
      }
      // 容错回退：如果最后一条是孤立的 user，我们保留它，清空后面的脏数据
      let lastUserIndex = apiHistoryRef.current.length - 1;
      while (lastUserIndex >= 0 && apiHistoryRef.current[lastUserIndex].role !== 'user') lastUserIndex--;
      if (lastUserIndex >= 0) apiHistoryRef.current = apiHistoryRef.current.slice(0, lastUserIndex + 1);
    } finally {
      apiHistoryRef.current = compactHistory(apiHistoryRef.current);
      setBusy(false);
      sendLock.current = false;
    }
  }, [input, addTextMessage, addMovieList, executeUiTool]);

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (active) return;
    isDragging.current = false;
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragStart.current = { x: cx, y: cy, ballX: pos.x, ballY: pos.y };

    const handleMove = (event: MouseEvent | TouchEvent) => {
      const mx = 'touches' in event ? event.touches[0]?.clientX : (event as MouseEvent).clientX;
      const my = 'touches' in event ? event.touches[0]?.clientY : (event as MouseEvent).clientY;
      if (typeof mx !== 'number' || typeof my !== 'number') return;
      const dx = mx - dragStart.current.x;
      const dy = my - dragStart.current.y;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging.current = true;
      const newX = Math.min(Math.max(0, dragStart.current.ballX - dx), window.innerWidth - 90);
      const newY = Math.min(Math.max(0, dragStart.current.ballY - dy), window.innerHeight - 60);
      setPos({ x: newX, y: newY });
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove); window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove); window.removeEventListener('touchend', handleUp);
    };
    window.addEventListener('mousemove', handleMove); window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove, { passive: true }); window.addEventListener('touchend', handleUp);
  };

  return (
    <>
      <div className={`fixed inset-0 z-40 bg-black/20 backdrop-blur-sm transition-opacity ${active ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`} onClick={() => setActive(false)} />
      <div className="fixed z-50" style={{ bottom: `${pos.y}px`, right: `${pos.x}px` }}>
        {!active && (
          <button onMouseDown={handlePointerDown} onTouchStart={handlePointerDown} onClick={() => { if (!isDragging.current) setActive(true); }}
            className="w-[84px] h-[50px] rounded-full shadow-2xl flex items-center justify-center overflow-hidden"
            style={{ background: 'linear-gradient(180deg, #050505 0%, #1a1a1a 35%, #d9d9d9 52%, #ffffff 100%)' }}>
            <span className="text-black/40 text-2xl relative z-10">✦</span>
          </button>
        )}
        {active && (
          <div className="w-[350px] h-[500px] rounded-[32px] flex flex-col shadow-2xl bg-[rgba(20,20,25,0.85)] backdrop-blur-xl border border-white/15">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <span className="text-white/90 text-sm font-semibold">✦ Friday AI V3</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setVoiceEnabled(!voiceEnabled)} className="p-1.5 text-white/70">
                  {voiceEnabled ? '🔊' : '🔇'}
                </button>
                {busy && <button onClick={stopRequest} className="text-xs text-red-400">取消</button>}
                <button onClick={() => setActive(false)} className="text-white/70">✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" ref={listRef}>
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${message.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white/5 text-white'}`}>
                    {message.type === 'text' && message.content}
                    {message.type === 'movie_list' && (
                      <div className="grid grid-cols-2 gap-3 mt-2">
                        {message.items?.map((item, idx) => (
                          <div key={idx} onClick={() => openNativeDetail(item)} className="bg-[#1c1c1e] rounded-xl overflow-hidden cursor-pointer">
                            <div className="aspect-[2/3] w-full bg-[#2a2a2c] relative flex flex-col items-center justify-center">
                              <span className="text-white/20 text-3xl mb-1">🎬</span>
                              <span className="text-[10px] text-white/20">暂无海报</span>
                              {item.pic && <img src={item.pic} referrerPolicy="no-referrer" className="absolute inset-0 w-full h-full object-cover z-10" onError={(e) => e.currentTarget.style.display = 'none'} />}
                            </div>
                            <div className="p-2 text-[13px] font-bold text-white truncate">{item.name}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex justify-start">
                  <div className="bg-white/5 border border-white/5 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce" />
                    <span className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce delay-100" />
                    <span className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce delay-200" />
                  </div>
                </div>
              )}
            </div>
            <div className="p-3 border-t border-white/10 flex gap-2">
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="找电影…" className="flex-1 bg-transparent text-white outline-none px-2" />
              <button onClick={() => send()} className="bg-blue-600 rounded-full w-8 h-8 text-white">↑</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
