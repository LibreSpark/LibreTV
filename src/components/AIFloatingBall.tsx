'use client';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

const VIDEO_ELEMENT_ID = 'libretv-main-video';
const STORAGE_KEY = 'custom_api_url';

type MessageData = {
  title: string;
  poster: string;
  link: string;
  year?: number;
  rating?: number;
  overview?: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  type: 'text' | 'movie_list' | 'system';
  content: string;
  dataList?: MessageData[];
};

const INIT_MESSAGE: Message = {
  id: 'init',
  role: 'assistant',
  type: 'text',
  content: '你好！我是 Friday。想看什么电影？',
};

let simpleUidCounter = 0;
function simpleUid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${++simpleUidCounter}`;
}

function getCustomSources(): { name: string; url: string }[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [{ name: '默认', url: stored }];
  } catch {
    return [];
  }
}

export default function AIFloatingBall() {
  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([INIT_MESSAGE]);
  const [loading, setLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const messagesRef = useRef<Message[]>(messages);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    setMounted(true);
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const forceScrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => { if (isExpanded) forceScrollToBottom(); }, [messages, loading, isExpanded, forceScrollToBottom]);

  const processStreamResponse = async (response: Response) => {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullContent = '';
    const toolCalls = new Map<number, { id?: string; name: string; arguments: string }>();
    let streamMsgId: string | null = null;
    let hasStreamedText = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const delimiter = /\r\n\r\n|\n\n|\r\r/;
      let match;
      while ((match = delimiter.exec(buffer)) !== null) {
        const eventBlock = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        
        for (const line of eventBlock.split(/\r\n|\n|\r/)) {
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
              const parsedData = JSON.parse(dataStr);
              const delta = parsedData.choices?.[0]?.delta;
              if (delta?.content) {
                fullContent += delta.content;
                if (!hasStreamedText) {
                  hasStreamedText = true;
                  streamMsgId = simpleUid();
                  setMessages(prev => [...prev, { id: streamMsgId!, role: 'assistant', type: 'text', content: fullContent }]);
                } else {
                  setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...m, content: fullContent } : m));
                }
              }
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = Number(tc.index ?? 0);
                  const cur = toolCalls.get(idx) || { name: '', arguments: '' };
                  if (tc.function?.name) cur.name += tc.function.name;
                  if (tc.function?.arguments) cur.arguments += tc.function.arguments;
                  toolCalls.set(idx, cur);
                }
              }
            } catch {}
          }
        }
      }
    }

    if (toolCalls.size > 0) {
      if (hasStreamedText && streamMsgId) setMessages(prev => prev.filter(m => m.id !== streamMsgId));
      
      for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
        if (call.name === 'search_movie') {
          try {
            const args = JSON.parse(call.arguments);
            setMessages(prev => [...prev, { id: simpleUid(), role: 'system', type: 'system', content: `🔍 正在为您搜索真实资源：${args.keyword}...` }]);
            
            const sources = getCustomSources();

            // 请求你原生的真实搜索接口
            const searchRes = await fetch('/api/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wd: args.keyword, sources })
            });
            
            if (searchRes.ok) {
              const text = await searchRes.text();
              let realList: any[] = [];
              
              // 兼容你原生接口可能返回的流式或 JSON 数据
              try {
                const searchData = JSON.parse(text);
                if (searchData.items) realList = searchData.items;
                else if (Array.isArray(searchData)) realList = searchData;
                else if (searchData.list) realList = searchData.list;
              } catch {
                const matches = [...text.matchAll(/data:\s*(\{.*?\})/g)];
                for (const m of matches) {
                  try {
                    const d = JSON.parse(m[1]);
                    if (d.videos) realList.push(...d.videos);
                    if (d.item) realList.push(d.item);
                    if (d.list) realList.push(...d.list);
                  } catch {}
                }
              }

              if (realList.length > 0) {
                const formattedList = realList.slice(0, 5).map((m: any) => ({
                  title: m.vod_name || m.title || '未知',
                  poster: m.vod_pic || m.poster || 'https://picsum.photos/300/450',
                  link: m.vod_id ? `/play/${m.vod_id}` : m.link || '#',
                  year: m.vod_year || m.year,
                  overview: m.vod_remarks || m.overview || '暂无简介'
                }));

                setMessages(prev => [
                  ...prev, 
                  { 
                    id: simpleUid(), 
                    role: 'assistant', 
                    type: 'movie_list', 
                    content: `为您找到关于“${args.keyword}”的真实资源：`, 
                    dataList: formattedList 
                  }
                ]);
              } else {
                setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: '抱歉，没有找到真实的资源。' }]);
              }
            }
          } catch (e) {
            setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: '搜索真实资源异常。' }]);
          }
        }
      }
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = overrideText || input.trim();
    if (!text || loading) return;

    setInput('');
    setIsExpanded(true);
    const userMsg: Message = { id: simpleUid(), role: 'user', type: 'text', content: text };
    const history = [...messagesRef.current.filter(m => m.type !== 'system').map(m => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
    
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    forceScrollToBottom();
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) throw new Error('网络异常');
      await processStreamResponse(response);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: `⚠️ 错误: ${err.message}` }]);
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  if (!mounted || !isMounted) return null;

  return createPortal(
    <div className={`fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh] pointer-events-none transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
      <div className="absolute inset-0 bg-black/20 pointer-events-auto backdrop-blur-sm" onClick={() => { setIsOpen(false); setTimeout(() => setIsMounted(false), 300); }}></div>

      <div 
        className={`relative bg-[#050505] overflow-hidden flex flex-col pointer-events-auto shadow-2xl border border-white/10 transition-all duration-700 ease-out ${isOpen ? 'scale-100 translate-y-0 opacity-100' : 'scale-90 -translate-y-8 opacity-0'}`}
        style={{ width: isExpanded ? '90%' : '260px', maxWidth: '360px', height: isExpanded ? '500px' : '110px', borderRadius: isExpanded ? '24px' : '55px' }}
      >
        {isExpanded && (
          <div className="px-5 pt-5 pb-2 flex justify-between items-center border-b border-white/10 shrink-0">
            <span className="text-sm text-gray-300 font-medium">✨ Friday</span>
            <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white">✕</button>
          </div>
        )}

        <div className={`flex-1 overflow-y-auto p-4 flex flex-col gap-4 ${isExpanded ? 'block' : 'hidden'}`} ref={chatContainerRef}>
          {messages.map((msg) => (
            <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              {msg.type === 'text' && (
                <div className={`text-[14px] p-3 rounded-2xl max-w-[85%] ${msg.role === 'user' ? 'bg-[#2c2c2e] text-white rounded-br-sm' : 'text-gray-200'}`}>
                  {msg.content}
                </div>
              )}
              {msg.type === 'system' && (
                <div className="text-[12px] text-green-400 bg-green-500/10 px-3 py-1.5 rounded-lg">{msg.content}</div>
              )}

              {msg.type === 'movie_list' && msg.dataList && (
                <div className="flex flex-col gap-3 w-full mt-2">
                  <div className="text-sm text-gray-400">{msg.content}</div>
                  {msg.dataList.map((item, i) => (
                    <a
                      key={i}
                      href={item.link}
                      onClick={() => setIsOpen(false)}
                      className="bg-[#1c1c1e] border border-white/10 rounded-xl p-2.5 flex gap-3 hover:bg-[#2c2c2e] transition-colors no-underline text-inherit"
                    >
                      <img src={item.poster} alt={item.title} className="w-[65px] h-[95px] object-cover rounded-md bg-[#333] shrink-0" onError={(e) => { (e.target as HTMLImageElement).src = 'https://picsum.photos/300/450'; }} />
                      <div className="flex flex-col justify-between flex-1 min-w-0 py-1">
                        <div>
                          <div className="text-white font-bold text-[15px] truncate">{item.title}</div>
                          <div className="text-gray-400 text-xs mt-1">
                            {item.year ? `${item.year}年` : ''} 
                          </div>
                          <div className="text-gray-500 text-[11px] line-clamp-2 mt-1 leading-snug">{item.overview}</div>
                        </div>
                        <div className="text-[#0A84FF] text-xs font-medium self-end mt-2">查看详情 →</div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          {loading && <div className="text-gray-500 text-xs">正在思考...</div>}
        </div>

        {!isExpanded && (
          <div className="w-full h-full flex flex-col justify-center px-6 cursor-pointer" onClick={() => { setIsExpanded(true); inputRef.current?.focus(); }}>
             <p className="text-[13px] text-gray-200 line-clamp-2">点击这里和我对话...</p>
          </div>
        )}

        <div className="p-3 border-t border-white/10 bg-[#1a1a1a] shrink-0">
          <div className="flex items-center bg-[#2c2c2e] rounded-full px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="问点什么..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-gray-500"
            />
            <button onClick={() => handleSend()} disabled={!input.trim() || loading} className="text-[#0A84FF] disabled:opacity-30 ml-2">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
