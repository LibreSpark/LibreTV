'use client';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

type Message = { id: string; role: 'user' | 'assistant'; type: 'text' | 'movie_card' | 'system'; content: string; data?: any; };
const INIT_MESSAGE: Message = { id: 'init', role: 'assistant', type: 'text', content: '你好！我是 Friday。想看什么电影，或者需要我帮你换几个新接口？' };
type SpeechState = 'idle' | 'listening' | 'thinking' | 'speaking';

function simpleUid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

if (typeof document !== 'undefined') {
  if (!document.getElementById('friday-global-style')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'friday-global-style';
    styleEl.textContent = `
      .scrollbar-hide::-webkit-scrollbar { display: none; }
      .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      @keyframes customFadeIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
      .animate-fadeIn { animation: customFadeIn 0.3s ease-out forwards; }
      @keyframes breathe1 { 0% { transform: scale(1) translateY(0); opacity: 0.5; } 50% { transform: scale(1.05) translateY(-2px); opacity: 0.8; } 100% { transform: scale(1) translateY(0); opacity: 0.5; } }
      @keyframes breathe2 { 0% { transform: scale(1) translateX(0); opacity: 0.4; } 50% { transform: scale(1.1) translateX(3px); opacity: 0.7; } 100% { transform: scale(1) translateX(0); opacity: 0.4; } }
      @keyframes breathe3 { 0% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.2); opacity: 1; } 100% { transform: scale(1); opacity: 0.6; } }
      .animate-breathe-1 { animation: breathe1 4s ease-in-out infinite alternate; }
      .animate-breathe-2 { animation: breathe2 5s ease-in-out infinite alternate; }
      .animate-breathe-3 { animation: breathe3 3s ease-in-out infinite alternate; }
    `;
    document.head.appendChild(styleEl);
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

  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [speechState, setSpeechState] = useState<SpeechState>('idle');
  const [isSpeechSupported, setIsSpeechSupported] = useState(true);

  const AGENT_SECRET = process.env.NEXT_PUBLIC_AGENT_SECRET || 'default_fallback_secret_change_me';

  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const isVoiceModeRef = useRef(false);
  const speechStateRef = useRef<SpeechState>('idle');
  const micDeniedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const agentAbortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const messagesRef = useRef(messages);
  const isOpenRef = useRef(false);

  const focusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reloadTimerRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const redirectTimerRef = useRef<NodeJS.Timeout | null>(null); 

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { speechStateRef.current = speechState; }, [speechState]);
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);

  const togglePanel = useCallback((reset = false) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      if (isOpenRef.current) {
        setIsOpen(false); setTimeout(() => setIsExpanded(false), 300);
        
        if (isVoiceModeRef.current) {
          isVoiceModeRef.current = false;
          setIsVoiceMode(false);
          setSpeechState('idle');
          synthRef.current?.cancel();
          try { recognitionRef.current?.stop(); } catch (e) {}
        }
        
        synthRef.current?.cancel();
        if (abortControllerRef.current) abortControllerRef.current.abort();
        if (agentAbortControllerRef.current) agentAbortControllerRef.current.abort();
        if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);

        setLoading(false); document.body.classList.remove('friday-popup-lock');
        
        closeTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setIsMounted(false);
        }, 300);
      } else {
        setIsMounted(true);
        setTimeout(() => {
          setIsOpen(true); document.body.classList.add('friday-popup-lock');
          if (reset) { setMessages([INIT_MESSAGE]); setInput(''); }
        }, 10);
      }
    }, 150);
  }, []);

  useEffect(() => {
    setMounted(true);
    mountedRef.current = true;
    if (typeof window === 'undefined') return;
    synthRef.current = window.speechSynthesis;

    if (window.__FRIDAY_PENDING_OPEN__) {
      window.__FRIDAY_PENDING_OPEN__ = false;
      const openTimer = setTimeout(() => {
        if (!mountedRef.current || isOpenRef.current) return;
        togglePanel(false);
      }, 50);
      closeTimerRef.current = openTimer;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) setIsSpeechSupported(false);

    return () => {
      mountedRef.current = false;
      document.body.classList.remove('friday-popup-lock');
      synthRef.current?.cancel();
      try { recognitionRef.current?.stop(); } catch (e) { }
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (agentAbortControllerRef.current) agentAbortControllerRef.current.abort();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current); 
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current); 
    };
  }, [togglePanel]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        togglePanel(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, togglePanel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOpen = (e: Event) => {
      if (!isOpenRef.current) togglePanel((e as CustomEvent).detail?.reset || false);
    };
    window.addEventListener('toggle-friday-panel', handleOpen);
    return () => window.removeEventListener('toggle-friday-panel', handleOpen);
  }, [togglePanel]);

  useEffect(() => {
    if (typeof window === 'undefined' || !isSpeechSupported) return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN'; recognition.continuous = false; recognition.interimResults = true;
      recognition.onstart = () => { if (isVoiceModeRef.current) setSpeechState('listening'); };
      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
          else setInput(event.results[i][0].transcript);
        }
        if (finalTranscript) { try { recognition.stop(); } catch (e) { } handleSend(finalTranscript); }
      };
      recognition.onerror = (e: any) => {
        if (e.error === 'not-allowed') { setIsVoiceMode(false); isVoiceModeRef.current = false; micDeniedRef.current = true; }
        setSpeechState('idle');
      };
      recognition.onend = () => {
        if (!mountedRef.current || micDeniedRef.current || document.visibilityState === 'hidden') return;
        if (isVoiceModeRef.current && speechStateRef.current === 'listening') {
          setTimeout(() => {
            if (!mountedRef.current) return;
            try { recognitionRef.current?.start(); } catch (e) { 
              setIsVoiceMode(false); isVoiceModeRef.current = false; micDeniedRef.current = true; setSpeechState('idle');
            }
          }, 300);
        }
      };
      recognitionRef.current = recognition;
    }
  }, [isSpeechSupported]);

  const speakText = useCallback((text: string, forceResume = false) => {
    if (!synthRef.current) return; synthRef.current.cancel();
    const cleanText = text.replace(/[*#_`~\[\]\(\)>```]/g, '').replace(/\n+/g, '。');
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'zh-CN';
    utterance.onstart = () => setSpeechState('speaking');
    utterance.onend = () => {
      if (isVoiceModeRef.current || forceResume) {
        setSpeechState('listening');
        try { recognitionRef.current?.start(); } catch (e) { }
      } else setSpeechState('idle');
    };
    synthRef.current.speak(utterance);
  }, []);

  const toggleVoiceMode = () => {
    if (!isSpeechSupported) return;
    if (isVoiceMode) {
      isVoiceModeRef.current = false; setIsVoiceMode(false); setSpeechState('idle');
      synthRef.current?.cancel(); try { recognitionRef.current?.stop(); } catch (e) { }
    } else {
      micDeniedRef.current = false;
      isVoiceModeRef.current = true; setIsVoiceMode(true); setSpeechState('listening');
      try { recognitionRef.current?.start(); } catch (e) { }
    }
  };

  const expandPopup = () => {
    if (!isExpanded) {
      setIsExpanded(true);
      const focusTimer = setTimeout(() => {
        if (mountedRef.current) inputRef.current?.focus();
      }, 400);
      focusTimerRef.current = focusTimer;
    }
  };

  const forceScrollToBottom = () => { if (chatContainerRef.current) chatContainerRef.current.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' }); };
  useEffect(() => { if (isExpanded) forceScrollToBottom(); }, [messages, loading, isExpanded]);

  const formatText = (text: string) => {
    if (!text) return { __html: '' };
    return { __html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br />') };
  };

  const safeNavigate = (href: string) => {
    const cleanHref = href.replace(/[\s\x00-\x1f]/g, '').toLowerCase();
    const blockProtocols = ['javascript:', 'data:', 'vbscript:', 'blob:', 'about:'];
    if (blockProtocols.some(p => cleanHref.startsWith(p))) {
      setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: '⚠️ 不安全链接已被拦截' }]);
      return;
    }
    window.location.href = href;
  };

  const processStreamResponse = async (response: Response) => {
    if (!response.body) throw new Error('empty body');
    const reader = response.body.getReader();
    try {
      let fullContent = ''; let toolName = ''; let toolArgsBuffer = '';
      const streamMsgId = simpleUid();
      let hasStreamedText = false;
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        const chunk = decoder.decode(value, { stream: !done });
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        if (done) { decoder.decode(); break; }
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
              if (delta?.content) {
                fullContent += delta.content;
                if (!hasStreamedText) {
                  hasStreamedText = true;
                  setMessages(prev => [...prev, { id: streamMsgId, role: 'assistant', type: 'text', content: fullContent }]);
                } else {
                  setMessages(prev => {
                    const up = [...prev];
                    const idx = up.findIndex(m => m.id === streamMsgId);
                    if (idx > -1) up[idx].content = fullContent;
                    return up;
                  });
                }
              }
              if (delta?.tool_calls && delta.tool_calls.length > 0) {
                const tc = delta.tool_calls[0];
                if (tc.function?.name) { toolName = tc.function.name; toolArgsBuffer = ''; }
                if (tc.function?.arguments && toolArgsBuffer.length < 10000) toolArgsBuffer += tc.function.arguments;
              }
            } catch (e) { }
          }
        }
      }
      if (!mountedRef.current) return;
      
      if (toolName && toolArgsBuffer) {
        if (hasStreamedText) {
          setMessages(prev => prev.filter(m => m.id !== streamMsgId));
        }

        try {
          const args = JSON.parse(toolArgsBuffer);
          if (toolName === 'search_movie' && args.keyword) {
            setMessages(prev => [...prev, {
              id: simpleUid(), role: 'assistant', type: 'movie_card', content: '',
              data: {
                title: args.keyword,
                poster: `https://picsum.photos/seed/${encodeURIComponent(args.keyword)}/300/450`,
                link: `/search?q=${encodeURIComponent(args.keyword)}`
              }
            }]);
            
            speakText(`已为您搜索到关于${args.keyword}的影片。`);
            
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('friday-action-search', { detail: args.keyword }));
              if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
              redirectTimerRef.current = setTimeout(() => {
                window.location.href = `/search?q=${encodeURIComponent(args.keyword)}`; 
              }, 1000); 
            }
          } else if (toolName === 'fetch_and_add_source') {
            executeAgentFetchSources();
          } else if (toolName === 'add_video_source' && args.name && args.api_url) {
            setMessages(prev => [...prev, {
              id: simpleUid(), role: 'assistant', type: 'system',
              content: `✅ 已写入新接口：\n名称：${args.name}\n地址：${args.api_url}\n⚠️ 请手动刷新页面生效`
            }]);
            try {
              let existing = []; const localData = localStorage.getItem('custom_api_url');
              if (localData) {
                try {
                  const parsed = JSON.parse(localData);
                  existing = Array.isArray(parsed) ? parsed : [{ name: '默认', url: localData }];
                } catch { existing = [{ name: '默认', url: localData }]; }
              }
              existing.push({ name: String(args.name).slice(0, 20), url: String(args.api_url) });
              existing = existing.slice(-15);
              localStorage.setItem('custom_api_url', JSON.stringify(existing));
            } catch (e) { console.error("写入失败", e); }
            speakText(`已为您添加${args.name}接口，请手动刷新页面生效。`);
          }
        } catch (err) {
          const errMsg = '⚠️ 工具调用解析出错，请重试';
          setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: errMsg }]);
          speakText(errMsg, true);
        }
      } else if (fullContent) { 
        speakText(fullContent); 
      }
    } finally {
      reader.releaseLock();
    }
  };

  const executeAgentFetchSources = async () => {
    if (!mountedRef.current) return;
    if (isVoiceModeRef.current) setSpeechState('thinking');
    setIsExpanded(true); setLoading(true);
    setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: `正在全网抓取接口并自动筛选...` }]);
    forceScrollToBottom();
    
    agentAbortControllerRef.current = new AbortController();
    const ac = agentAbortControllerRef.current;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'X-Agent-Secret': AGENT_SECRET 
        },
        body: JSON.stringify({
          action: 'fetch_sources',
          messages: messagesRef.current.map(m => ({ role: m.role, content: m.content }))
        }),
        signal: ac.signal
      });
      if (!response.ok) throw new Error('Agent 抓取失败');
      await processStreamResponse(response);
    } catch (error: any) {
      if (error.name !== 'AbortError' && mountedRef.current) {
        const errText = `⚠️ 抓取源失败：${error.message}`;
        setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: errText }]);
        speakText(errText, true);
      }
    } finally {
      if (mountedRef.current) { agentAbortControllerRef.current = null; setLoading(false); }
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = overrideText || input.trim(); if (!text || loading) return;
    synthRef.current?.cancel(); setInput(''); setIsExpanded(true);
    setMessages(prev => [...prev, { id: simpleUid(), role: 'user', type: 'text', content: text }]);
    setLoading(true); if (isVoiceModeRef.current) setSpeechState('thinking'); forceScrollToBottom();
    abortControllerRef.current = new AbortController();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Agent-Secret': AGENT_SECRET
        },
        body: JSON.stringify({ messages: messagesRef.current.map(m => ({ role: m.role, content: m.content })) }),
        signal: abortControllerRef.current.signal
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `网络错误`);
      }
      await processStreamResponse(response);
    } catch (error: any) {
      if (error.name !== 'AbortError' && mountedRef.current) {
        const errMsg = `⚠️ ${error.message}`;
        setMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: errMsg }]);
        speakText(errMsg, true);
      }
    } finally { if (mountedRef.current) { setLoading(false); abortControllerRef.current = null; } }
  };

  if (!mounted || !isMounted) return null;
  const lastMsg = messages[messages.length - 1];

  return createPortal(
    <div className={`fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh] pointer-events-none transition-all duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
      <div className="absolute inset-0 bg-black/20 pointer-events-auto backdrop-blur-sm transition-opacity" onClick={() => togglePanel(false)}></div>
      
      <div ref={popupRef} onClick={expandPopup} 
        className={`relative bg-[#050505] overflow-hidden flex flex-col items-center pointer-events-auto shadow-[0_20px_50px_rgba(0,0,0,0.8),inset_0_0_20px_rgba(255,255,255,0.05)] border border-white/10 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] will-change-transform ${isOpen ? 'scale-100 translate-y-0 opacity-100' : 'scale-90 -translate-y-8 opacity-0'}`}
        style={{ 
          width: isExpanded ? '90%' : '260px', 
          maxWidth: isExpanded ? '360px' : '260px', 
          height: isExpanded ? '450px' : '110px', 
          borderRadius: isExpanded ? '36px' : '55px', 
          cursor: isExpanded ? 'default' : 'pointer' 
        }}>
        
        <div className={`absolute bottom-0 left-0 w-full pointer-events-none z-0 overflow-hidden transition-all duration-700 ${isExpanded ? 'h-[100px]' : 'h-[60px]'} ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
           <div className="absolute bottom-[-15px] left-[10%] w-[80%] h-[50px] bg-[radial-gradient(ellipse_at_bottom,rgba(0,140,255,0.3)_0%,transparent_70%)] blur-[15px] animate-breathe-1 mix-blend-screen"></div>
           <div className="absolute bottom-[-5px] left-[30%] w-[40%] h-[30px] bg-[radial-gradient(ellipse_at_center,rgba(255,200,100,0.3)_0%,transparent_70%)] blur-[10px] animate-breathe-2 mix-blend-screen"></div>
           <div className="absolute bottom-[5px] left-[40%] w-[20%] h-[10px] bg-white/40 blur-[8px] animate-breathe-3 mix-blend-screen"></div>
        </div>

        {!isExpanded && (
          <div className="relative z-10 w-full h-full flex flex-col justify-center px-6">
            <p className="text-[13px] text-gray-200 leading-relaxed font-medium line-clamp-2 overflow-hidden pb-2">{lastMsg?.content || "点击这里和我对话..."}</p>
            <div className="absolute bottom-2 left-6 text-[10px] text-gray-500">点击展开</div>
          </div>
        )}
        {isExpanded && (
          <div className="relative z-10 flex flex-col min-h-0 w-full h-full animate-fadeIn">
            <div className="px-6 pt-5 pb-2 shrink-0 flex justify-between items-center">
              <span className="text-xs text-gray-400 font-medium">✨ Friday</span>
              <button onClick={(e) => { e.stopPropagation(); togglePanel(false); }} className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-xs hover:bg-white/20 transition-colors">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 pb-2 flex flex-col gap-4 scrollbar-hide" ref={chatContainerRef}>
              {messages.map((msg) => (
                <div key={msg.id} className={`w-full flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {msg.type === 'text' && (
                    <div className={`text-[14px] leading-relaxed break-words max-w-[85%] ${
                      msg.role === 'user' ? 'bg-[#2c2c2e] text-white p-3 rounded-2xl rounded-br-sm' : 'text-gray-100 p-1'
                    }`}>
                      <div dangerouslySetInnerHTML={formatText(msg.content)} />
                    </div>
                  )}
                  {msg.type === 'movie_card' && (
                    <div className="bg-[#1c1c1e] border border-white/10 rounded-2xl overflow-hidden w-full max-w-[220px] shadow-lg mt-1 inline-block text-left">
                      <div className="h-[120px] bg-cover bg-center" style={{ backgroundImage: `url(${msg.data.poster})` }} />
                      <div className="p-3 flex flex-col gap-1">
                        <span className="text-white font-bold text-sm truncate">{msg.data.title}</span>
                        <button onClick={(e) => { e.stopPropagation(); synthRef.current?.cancel(); safeNavigate(msg.data.link); togglePanel(false); }} className="mt-2 w-full bg-white text-black text-[12px] py-1.5 rounded-lg font-bold active:scale-95 transition-transform">立即播放</button>
                      </div>
                    </div>
                  )}
                  {msg.type === 'system' && (
                    <div className="text-[12px] text-green-400 bg-green-500/10 border border-green-500/20 p-2.5 rounded-xl mt-1 text-left inline-block">{msg.content}</div>
                  )}
                </div>
              ))}
              {loading && (<div className="self-start flex gap-1 items-center p-1"><span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"></span><span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce delay-100"></span><span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce delay-200"></span></div>)}
            </div>
            
            <div className="flex items-center px-4 pb-4 pt-2 gap-2 shrink-0 bg-transparent">
              {isSpeechSupported && (
                <button onClick={(e) => { e.stopPropagation(); toggleVoiceMode(); }} className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${isVoiceMode ? 'text-red-400 bg-red-500/20' : 'text-gray-400 hover:text-white bg-white/5'}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" x2="12" y1="19" y2="22" />
                  </svg>
                </button>
              )}
              <input 
                ref={inputRef} 
                type="text" 
                value={input} 
                onChange={(e) => setInput(e.target.value)} 
                onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }} 
                onClick={(e) => e.stopPropagation()} 
                placeholder={
                  speechState === 'listening' ? '正在聆听...' : 
                  speechState === 'thinking' ? '思考中...' : 
                  speechState === 'speaking' ? '正在播报...' : '问点什么...'
                } 
                disabled={loading} 
                className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-gray-500 px-2 py-1" 
                style={{ color: '#ffffff', caretColor: '#ffffff' }} 
              />
              <button onClick={(e) => { e.stopPropagation(); handleSend(); }} disabled={!input.trim() || loading} className="w-8 h-8 rounded-full flex items-center justify-center text-white disabled:opacity-30">
                {loading ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span> : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
