'use client';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';

declare global {
  interface Window {
    __FRIDAY_PENDING_OPEN__?: boolean;
    loadVideoById?: (vodId: string | number) => Promise<boolean>;
  }
}

const VIDEO_ELEMENT_ID = 'libretv-main-video';
const STORAGE_KEY = 'custom_api_url';
const CHAT_STORAGE_KEY = 'friday_chat_history';
const POS_KEY = 'friday_ball_pos';
const MAX_FRONTEND_SSE_BUFFER = 1024 * 512;
const MAX_AGENT_STEPS = 5;
const MAX_CHAT_HISTORY = 50;
const MAX_RECOGNITION_RETRY = 3;
const MAX_TOOL_ARG_LENGTH = 50000;

type MovieCardItem = {
  title: string;
  poster: string;
  vodId: string | number;
  year?: number;
  overview?: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  type: 'text' | 'composite_movie' | 'system';
  content: string;
  compositeMovie?: {
    summary: string;
    items: MovieCardItem[];
  };
  tool_call_id?: string;
  tool_calls?: any[];
};

const INIT_MESSAGE: Message = {
  id: 'init',
  role: 'assistant',
  type: 'text',
  content: '你好！我是 Friday。想看什么电影？',
};

type SpeechState = 'idle' | 'listening' | 'thinking' | 'speaking';

let simpleUidCounter = 0;
function simpleUid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  simpleUidCounter += 1;
  return `${Date.now().toString(36)}-${simpleUidCounter}-${Math.random().toString(36).slice(2)}`;
}

function normalizeName(name: string) {
  return String(name || '').replace(/[\s\(\)（）]/g, '').toLowerCase();
}

const isSafeUrl = (urlStr: string) => {
  try {
    const url = new URL(urlStr);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    if (process.env.NODE_ENV === 'development') return true;
    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host.endsWith('.local') || host.endsWith('.localhost') || host === 'localhost' || host === '::' || host === '::1') return false;
    if (host.startsWith('127.') || host === '0.0.0.0' || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false;
    const parts = host.split('.');
    if (parts.length === 4) {
      const p0 = parseInt(parts[0]); const p1 = parseInt(parts[1]);
      if (p0 === 172 && p1 >= 16 && p1 <= 31) return false;
      if (p0 === 100 && p1 >= 64 && p1 <= 127) return false;
      if (p0 >= 224 && p0 <= 239) return false;
    }
    if (host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) return false;
    if (host.startsWith('::ffff:') || host.includes('127.0.0.1')) return false;
    return true;
  } catch { return false; }
};

function extractMoviesRecursively(obj: any, maxDepth = 8, maxNodes = 2000) {
  let bestList: any[] = [];
  let nodeCount = 0;
  function traverse(node: any, depth: number) {
    nodeCount++;
    if (nodeCount > maxNodes || !node || typeof node !== 'object' || depth > maxDepth) return;
    if (Array.isArray(node)) {
      let validCount = 0;
      for (const item of node) {
        if (item && typeof item === 'object') {
          const hasId = item.vod_id !== undefined || item.id !== undefined || item.vid !== undefined || item.vodId !== undefined;
          const hasName = item.vod_name || item.title || item.name;
          if (hasId && hasName) validCount++;
        }
      }
      if (validCount > 0 && node.length > bestList.length) bestList = node;
      for (const item of node) traverse(item, depth + 1);
      return;
    }
    for (const key in node) traverse(node[key], depth + 1);
  }
  traverse(obj, 0);
  return bestList;
}

function getCustomSources(): any[] {
  const fallback = [
    { key: 'bfzy', name: '风暴', url: 'https://bfzyapi.com/api.php/provide/vod' },
    { key: '360', name: '360', url: 'https://360zy.com/api.php/provide/vod' }
  ];
  if (typeof window === 'undefined') return fallback;
  try {
    const candidates: any[] = [];
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        candidates.push(
          ...parsed
            .map((item: any) => ({
              ...item,
              url: item.url || item.api || item.path,
              key: item.key || item.name || '默认源',
              name: item.name || '自定义源'
            }))
            .filter(x => isSafeUrl(x.url))
        );
      }
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      try {
        const val = localStorage.getItem(key);
        if (!val) continue;
        if (val.includes('customAPIs') || val.includes('sources') || val.includes('bfzy')) {
          const parsed = JSON.parse(val);
          const apis = parsed?.state?.customAPIs || parsed?.customAPIs || parsed?.state?.sources;
          if (Array.isArray(apis) && apis.length > 0) {
            candidates.push(
              ...apis
                .map((item: any) => ({
                  ...item,
                  url: item.url || item.api || item.path,
                  key: item.key || item.name || '默认',
                  name: item.name || '自定义源'
                }))
                .filter(x => isSafeUrl(x.url))
            );
          }
        }
      } catch {}
    }
    if (candidates.length > 0) {
      const map = new Map<string, any>();
      candidates.forEach(it => map.set(it.url, it));
      return Array.from(map.values());
    }
  } catch { }
  return fallback;
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

// ---------- 组件外工具 ----------

const ALLOW_TOOLS = new Set(['search_movie', 'control_player', 'page_control']);

const validateFrontendTool = (name: string, args: Record<string, any>): boolean => {
  if (!ALLOW_TOOLS.has(name)) return false;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'search_movie') return typeof args.keyword === 'string' && args.keyword.trim().length > 0;
  if (name === 'control_player') return typeof args.action === 'string';
  if (name === 'page_control') return typeof args.action === 'string';
  return true;
};

const formatText = (text: string) => {
  if (!text) return { __html: '' };
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br />');
  return { __html: escaped };
};

/**
 * 发送前对历史做清理：
 * - 丢弃前端 system 提示（不应发给模型）
 * - 丢弃空 assistant（无 content 且无 tool_calls）
 * - 丢弃孤立 tool 消息（前一条不是对应 tool_calls 的 assistant）
 */
function sanitizeHistoryForAPI(history: Message[]): any[] {
  const out: any[] = [];
  for (const m of history) {
    if (m.type === 'system') continue;
    if (m.role === 'user') {
      if (!m.content || !m.content.trim()) continue;
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      const hasContent = !!(m.content && m.content.trim());
      if (!hasToolCalls && !hasContent) continue;
      const item: any = { role: 'assistant', content: m.content || '' };
      if (hasToolCalls) item.tool_calls = m.tool_calls;
      out.push(item);
      continue;
    }
    if (m.role === 'tool') {
      const prev: any = out[out.length - 1];
      const ok = prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls)
        && prev.tool_calls.some((tc: any) => tc.id === m.tool_call_id);
      if (!ok) continue;
      out.push({ role: 'tool', content: m.content, tool_call_id: m.tool_call_id });
    }
  }
  return out;
}

export default function AIFloatingBall() {
  const isSafari = typeof window !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
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

  const [pos, setPos] = useState({ x: 24, y: 24 });
  const posRef = useRef({ x: 24, y: 24 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ballX: 0, ballY: 0 });

  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const isVoiceModeRef = useRef(false);
  const speechStateRef = useRef<SpeechState>('idle');
  const micDeniedRef = useRef(false);
  const isRecognizingRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const speechTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recRetryCountRef = useRef(0);
  const speechSessionRef = useRef(0);
  const pendingSpeakRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const messagesRef = useRef<Message[]>([INIT_MESSAGE]);
  const isOpenRef = useRef(false);

  const focusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const openDelayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const expandDelayTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleSendRef = useRef<((overrideText?: string) => Promise<void>) | null>(null);
  const speakTextRef = useRef<((text: string, forceResume?: boolean) => void) | null>(null);

  const setSpeechStateSafe = useCallback((state: SpeechState) => {
    speechStateRef.current = state;
    setSpeechState(state);
  }, []);

  const cancelSpeech = useCallback(() => {
    speechSessionRef.current += 1;
    if (speechTimerRef.current) {
      clearTimeout(speechTimerRef.current);
      speechTimerRef.current = null;
    }
    try { synthRef.current?.cancel(); } catch {}
  }, []);

  const commitMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    const next = updater(messagesRef.current);
    messagesRef.current = next.slice(-MAX_CHAT_HISTORY);
    setMessages(messagesRef.current);
  }, []);

  const updateBallPosition = useCallback((x: number, y: number) => {
    if (typeof window === 'undefined') return;
    const maxX = Math.max(0, window.innerWidth - 56);
    const maxY = Math.max(0, window.innerHeight - 56);
    const next = {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(0, Math.min(maxY, y))
    };
    posRef.current = next;
    setPos(next);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const msgs = parsed.slice(-MAX_CHAT_HISTORY);
          messagesRef.current = msgs;
          setMessages(msgs);
        }
      }
      const savedPos = localStorage.getItem(POS_KEY);
      if (savedPos) {
        const p = JSON.parse(savedPos);
        updateBallPosition(p.x ?? 24, p.y ?? 24);
      }
    } catch { }
  }, [updateBallPosition]);

  const togglePanel = useCallback((reset = false) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    if (openDelayTimerRef.current) clearTimeout(openDelayTimerRef.current);
    if (expandDelayTimerRef.current) clearTimeout(expandDelayTimerRef.current);

    debounceTimerRef.current = setTimeout(() => {
      if (isOpenRef.current) {
        setIsOpen(false);
        expandDelayTimerRef.current = setTimeout(() => setIsExpanded(false), 300);
        if (isVoiceModeRef.current) {
          isVoiceModeRef.current = false;
          setIsVoiceMode(false);
          setSpeechStateSafe('idle');
          if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
          try { recognitionRef.current?.stop(); } catch {}
        }
        cancelSpeech();
        if (abortControllerRef.current) abortControllerRef.current.abort();
        setLoading(false);
        document.body.classList.remove('friday-popup-lock');
        closeTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setIsMounted(false);
        }, 300);
      } else {
        setIsMounted(true);
        openDelayTimerRef.current = setTimeout(() => {
          setIsOpen(true);
          document.body.classList.add('friday-popup-lock');
          if (reset) {
            commitMessages(() => [INIT_MESSAGE]);
            setInput('');
            localStorage.removeItem(CHAT_STORAGE_KEY);
            if (abortControllerRef.current) abortControllerRef.current.abort();
            cancelSpeech();
            isVoiceModeRef.current = false;
            setIsVoiceMode(false);
            setSpeechStateSafe('idle');
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            try { recognitionRef.current?.stop(); } catch {}
          }
        }, 10);
      }
    }, 150);
  }, [setSpeechStateSafe, commitMessages, cancelSpeech]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isOpenRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    isDragging.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const ballX = posRef.current.x;
    const ballY = posRef.current.y;
    dragStart.current = { x: startX, y: startY, ballX, ballY };
    const ac = new AbortController();

    const handleMove = (m: PointerEvent) => {
      const dx = m.clientX - startX;
      const dy = m.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging.current = true;
      updateBallPosition(ballX + dx, ballY + dy);
    };

    const handleUp = () => {
      ac.abort();
      if (isDragging.current) {
        try { localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)); } catch {}
        // 延迟重置，确保紧随其后的 click 被识别为拖拽后的 click 而非误触
        setTimeout(() => { isDragging.current = false; }, 0);
      }
    };

    window.addEventListener('pointermove', handleMove, { signal: ac.signal });
    window.addEventListener('pointerup', handleUp, { signal: ac.signal });
    window.addEventListener('pointercancel', handleUp, { signal: ac.signal });
  };

  const startRecognition = useCallback(() => {
    if (isRecognizingRef.current || !recognitionRef.current) return;
    if (recRetryCountRef.current >= MAX_RECOGNITION_RETRY) return;
    isRecognizingRef.current = true;
    try { recognitionRef.current.start(); } catch {
      isRecognizingRef.current = false;
      recRetryCountRef.current += 1;
    }
  }, []);

  const toggleVoiceMode = () => {
    if (!isSpeechSupported) return;
    if (isVoiceMode) {
      isVoiceModeRef.current = false;
      setIsVoiceMode(false);
      setSpeechStateSafe('idle');
      cancelSpeech();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      try { recognitionRef.current?.stop(); } catch {}
    } else {
      micDeniedRef.current = false;
      recRetryCountRef.current = 0;
      isVoiceModeRef.current = true;
      setIsVoiceMode(true);
      setSpeechStateSafe('listening');
      startRecognition();
    }
  };

  useEffect(() => {
    setMounted(true);
    mountedRef.current = true;
    document.body.classList.remove('friday-popup-lock');
    if (typeof window === 'undefined') return;
    synthRef.current = window.speechSynthesis;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) setIsSpeechSupported(false);

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
        isVoiceModeRef.current = false;
        setIsVoiceMode(false);
        setSpeechStateSafe('idle');
        try { recognitionRef.current?.stop(); } catch {}
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onResize = () => {
      updateBallPosition(posRef.current.x, posRef.current.y);
    };
    window.addEventListener('resize', onResize);

    return () => {
      mountedRef.current = false;
      document.body.classList.remove('friday-popup-lock');
      cancelSpeech();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      try { recognitionRef.current?.stop(); } catch {}
      if (abortControllerRef.current) abortControllerRef.current.abort();
      [closeTimerRef, debounceTimerRef, focusTimerRef, openDelayTimerRef, expandDelayTimerRef].forEach(ref => {
        if (ref.current) clearTimeout(ref.current);
      });
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onResize);
    };
  }, [updateBallPosition, setSpeechStateSafe, cancelSpeech]);

  useEffect(() => {
    if (typeof window === 'undefined' || !isSpeechSupported) return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      isRecognizingRef.current = true;
      recRetryCountRef.current = 0;
      if (isVoiceModeRef.current) setSpeechStateSafe('listening');
    };
    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
        else setInput(event.results[i][0].transcript);
      }
      if (finalTranscript) {
        isRecognizingRef.current = false;
        try { recognition.stop(); } catch {}
        if (handleSendRef.current) handleSendRef.current(finalTranscript);
      }
    };
    recognition.onerror = (e: any) => {
      isRecognizingRef.current = false;
      if (e.error === 'not-allowed') {
        micDeniedRef.current = true;
        setIsVoiceMode(false);
        isVoiceModeRef.current = false;
        setSpeechStateSafe('idle');
        return;
      }
      if (e.error === 'no-speech' || e.error === 'aborted') {
        // 由 onend 处理重启；aborted 通常是我们主动 stop
        return;
      }
      setSpeechStateSafe('idle');
    };
    recognition.onend = () => {
      isRecognizingRef.current = false;
      if (!mountedRef.current || micDeniedRef.current || document.visibilityState === 'hidden') return;
      if (isVoiceModeRef.current && speechStateRef.current === 'listening') {
        recRetryCountRef.current += 1;
        if (recRetryCountRef.current >= MAX_RECOGNITION_RETRY) {
          isVoiceModeRef.current = false;
          setIsVoiceMode(false);
          setSpeechStateSafe('idle');
          return;
        }
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current && isVoiceModeRef.current && speechStateRef.current === 'listening') startRecognition();
        }, 300);
      }
    };
    recognitionRef.current = recognition;
  }, [isSpeechSupported, setSpeechStateSafe, startRecognition]);

  const speakText = useCallback((text: string, forceResume = false) => {
    if (!isVoiceModeRef.current && !forceResume) return;
    if (!synthRef.current) return;
    if (typeof SpeechSynthesisUtterance === 'undefined') return;

    const session = ++speechSessionRef.current;
    if (speechTimerRef.current) {
      clearTimeout(speechTimerRef.current);
      speechTimerRef.current = null;
    }
    try { synthRef.current.cancel(); } catch {}

    const cleanText = text.replace(/[*#_`~\[\]\(\)>```]/g, '').replace(/\n+/g, '。');
    if (!cleanText.trim()) {
      if (isVoiceModeRef.current) {
        setSpeechStateSafe('listening');
        startRecognition();
      } else {
        setSpeechStateSafe('idle');
      }
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'zh-CN';

    const maxSpeechMs = Math.max(4000, cleanText.length * 180);
    speechTimerRef.current = setTimeout(() => {
      if (session !== speechSessionRef.current) return;
      try { synthRef.current?.cancel(); } catch {}
      if (isVoiceModeRef.current) {
        setSpeechStateSafe('listening');
        startRecognition();
      } else {
        setSpeechStateSafe('idle');
      }
    }, maxSpeechMs);

    utterance.onstart = () => {
      if (session !== speechSessionRef.current) return;
      setSpeechStateSafe('speaking');
    };
    utterance.onend = () => {
      if (session !== speechSessionRef.current) return;
      if (speechTimerRef.current) {
        clearTimeout(speechTimerRef.current);
        speechTimerRef.current = null;
      }
      if (isVoiceModeRef.current && !isSafari) {
        setSpeechStateSafe('listening');
        startRecognition();
      } else {
        setSpeechStateSafe('idle');
        if (isSafari && isVoiceModeRef.current) {
          isVoiceModeRef.current = false;
          setIsVoiceMode(false);
        }
      }
    };
    utterance.onerror = () => {
      if (session !== speechSessionRef.current) return;
      if (speechTimerRef.current) {
        clearTimeout(speechTimerRef.current);
        speechTimerRef.current = null;
      }
      if (isVoiceModeRef.current) {
        setSpeechStateSafe('listening');
        startRecognition();
      } else {
        setSpeechStateSafe('idle');
      }
    };
    try { synthRef.current.speak(utterance); } catch { }
  }, [isSafari, setSpeechStateSafe, startRecognition]);

  useEffect(() => { speakTextRef.current = speakText; }, [speakText]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        togglePanel(false);
      }
      if (e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!isOpenRef.current) togglePanel(false);
        setTimeout(() => { if (!isVoiceModeRef.current) toggleVoiceMode(); }, 350);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [togglePanel]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) togglePanel(false);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [togglePanel]);

  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);

  useEffect(() => {
    if (typeof window !== 'undefined' && messagesRef.current.length > 0) {
      try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messagesRef.current.slice(-MAX_CHAT_HISTORY))); } catch { }
    }
  }, [messages]);

  const loadVideoInsidePage = useCallback((vodId: string | number, title: string) => {
    if (vodId === undefined || vodId === null || vodId === '') return;
    window.dispatchEvent(new CustomEvent('friday-play-video', { detail: { vodId, title }, bubbles: true }));
    togglePanel(false);
  }, [togglePanel]);

  const expandPopup = () => {
    if (!isExpanded) {
      setIsExpanded(true);
      focusTimerRef.current = setTimeout(() => { if (mountedRef.current) inputRef.current?.focus(); }, 400);
    }
  };

  const forceScrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      setTimeout(() => {
        if (chatContainerRef.current) chatContainerRef.current.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: 'smooth' });
      }, 0);
    }
  }, []);

  useEffect(() => { if (isExpanded) forceScrollToBottom(); }, [messages, loading, isExpanded, forceScrollToBottom]);

  type StreamResult = {
    content: string;
    toolCalls: Array<{ id?: string; name: string; arguments: string; isDiscarded?: boolean }>;
  } | null;

  const processStreamResponse = async (response: Response): Promise<StreamResult> => {
    if (!response.body) throw new Error('empty body');
    const reader = response.body.getReader();
    let localStreamMsgId: string | null = null;
    try {
      let fullContent = '';
      const toolCalls = new Map<number, { id?: string; name: string; arguments: string; isDiscarded?: boolean }>();
      let receivedDone = false;
      let streamCorrupted = false;
      let hadParseError = false;
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      const processEvent = (eventBlock: string) => {
        if (receivedDone || streamCorrupted) return;
        const lines = eventBlock.split(/\r\n|\n|\r/);
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            let d = line.slice(5);
            if (d.startsWith(' ')) d = d.slice(1);
            dataStr += d + '\n';
          }
        }
        dataStr = dataStr.replace(/\n$/, '');
        if (!dataStr) return;
        if (dataStr === '[DONE]') { receivedDone = true; return; }
        try {
          const parsedData = JSON.parse(dataStr);
          const delta = parsedData.choices?.[0]?.delta;
          const finishReason = parsedData.choices?.[0]?.finish_reason;
          if (finishReason === 'length') {
            commitMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'system', content: '⚠️ 输出长度已达上限，回答被截断。' }]);
          }
          if (delta?.content) {
            fullContent += delta.content;
            if (!localStreamMsgId) {
              localStreamMsgId = simpleUid();
              commitMessages(prev => [...prev, { id: localStreamMsgId!, role: 'assistant', type: 'text', content: fullContent }]);
            } else {
              commitMessages(prev => {
                const arr = [...prev];
                const idx = arr.findIndex(m => m.id === localStreamMsgId);
                if (idx > -1) arr[idx].content = fullContent;
                return arr;
              });
            }
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const index = Number(tc.index ?? 0);
              const current = toolCalls.get(index) ?? { name: '', arguments: '' };
              if (current.isDiscarded) continue;
              if (tc.id) current.id = tc.id;
              if (tc.function?.name) current.name += tc.function.name;
              if (tc.function?.arguments) {
                if (current.arguments.length + tc.function.arguments.length <= MAX_TOOL_ARG_LENGTH) {
                  current.arguments += tc.function.arguments;
                } else {
                  current.isDiscarded = true;
                  current.name = '';
                  current.arguments = '';
                  commitMessages(p => [...p, { id: simpleUid(), role: 'assistant', type: 'system', content: '⚠️ 工具调用参数过大，已丢弃本次工具请求' }]);
                }
              }
              toolCalls.set(index, current);
            }
          }
        } catch {
          hadParseError = true;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) {
            const remainingEvents = buffer.split(/\r\n\r\n|\n\n|\r\r/);
            for (const ev of remainingEvents) processEvent(ev);
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_FRONTEND_SSE_BUFFER) {
          buffer = buffer.slice(-MAX_FRONTEND_SSE_BUFFER);
          streamCorrupted = true;
          break;
        }
        let match;
        const delimiter = /\r\n\r\n|\n\n|\r\r/;
        while ((match = delimiter.exec(buffer)) !== null) {
          const eventBlock = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          processEvent(eventBlock);
          if (receivedDone || streamCorrupted) { try { reader.cancel(); } catch {} break; }
        }
        if (receivedDone || streamCorrupted) break;
      }

      if (!mountedRef.current) return null;

      if (streamCorrupted) {
        if (localStreamMsgId) commitMessages(prev => prev.filter(m => m.id !== localStreamMsgId));
        commitMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'system', content: '⚠️ 数据异常，请重试' }]);
        return null;
      }
      if (hadParseError) {
        if (localStreamMsgId) commitMessages(prev => prev.filter(m => m.id !== localStreamMsgId));
        commitMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'system', content: '⚠️ 数据解析异常，请重试' }]);
        return null;
      }
      // 兼容未发送 [DONE] 的服务端：只要收到内容或工具调用即视为完成
      if (!receivedDone && !fullContent && toolCalls.size === 0) {
        if (localStreamMsgId) commitMessages(prev => prev.filter(m => m.id !== localStreamMsgId));
        commitMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'system', content: '⚠️ 连接中断，请重试' }]);
        return null;
      }
      return { content: fullContent, toolCalls: Array.from(toolCalls.values()) };
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  };

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = overrideText || input.trim();
    if (!text) return;

    const thisRequestId = ++requestIdRef.current;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    pendingSpeakRef.current = false;
    if (isVoiceModeRef.current) {
      setSpeechStateSafe('thinking');
      try { recognitionRef.current?.stop(); } catch {}
    }
    cancelSpeech();
    setInput('');
    setIsExpanded(true);
    setLoading(true);
    forceScrollToBottom();

    const userMsg: Message = { id: simpleUid(), role: 'user', type: 'text', content: text };
    commitMessages(prev => [...prev, userMsg]);
    let currentHistory = [...messagesRef.current];

    let currentStep = 0;
    try {
      while (currentStep < MAX_AGENT_STEPS) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        currentStep++;

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: sanitizeHistoryForAPI(currentHistory) }),
          signal,
        });
        if (!response.ok) throw new Error(`请求失败: ${response.status}`);
        const data = await processStreamResponse(response);
        if (!data) break;
        const { content, toolCalls } = data;

        if (toolCalls.length === 0) {
          if (content) {
            pendingSpeakRef.current = true;
            speakTextRef.current?.(content);
          }
          break;
        }

        const assistantMsg: Message = {
          id: simpleUid(),
          role: 'assistant',
          type: 'text',
          content: content || '',
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
          }))
        };
        commitMessages(prev => [...prev, assistantMsg]);
        currentHistory = [...messagesRef.current];

        for (const tc of toolCalls) {
          let resultContent = '';
          try {
            if (!tc.id || !tc.name) throw new Error('工具调用缺少id或name');
            let args: any;
            try {
              args = JSON.parse(tc.arguments || '{}');
            } catch { throw new Error('工具参数JSON解析失败'); }
            if (!validateFrontendTool(tc.name, args)) throw new Error(`非法工具或参数:${tc.name}`);

            if (tc.name === 'search_movie') {
              const searchRes = await fetch('/api/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wd: args.keyword, sources: getCustomSources() }),
                signal
              });
              if (!searchRes.ok) throw new Error(`搜索异常: ${searchRes.status}`);
              const raw = await searchRes.text();
              let realList: any[] = [];
              try { realList = extractMoviesRecursively(JSON.parse(raw)); } catch { }

              realList = realList.filter((m) => {
                if (!m) return false;
                const name = String(m.vod_name ?? m.title ?? m.name ?? '');
                const id = m.vod_id ?? m.id ?? m.vid ?? m.vodId;
                if (!id || !name) return false;
                const badWords = ['预告', '花絮', '解说', 'MV', '特辑', '片段', '彩蛋'];
                const lower = name.toLowerCase();
                const matched = badWords.find((w) => lower.includes(w.toLowerCase()));
                if (!matched) return true;
                const kw = String(args?.keyword ?? '').toLowerCase();
                return kw.includes(matched.toLowerCase());
              }).map((m: any) => {
                let safePic = m.vod_pic || m.poster || m.pic || '';
                if (safePic.startsWith('//')) safePic = `https:${safePic}`;
                return {
                  ...m,
                  vod_id: m.vod_id || m.id || m.vid || m.vodId,
                  vod_name: m.vod_name || m.title || m.name,
                  vod_pic: safePic,
                  vod_year: m.vod_year || m.year,
                  vod_remarks: m.vod_remarks || m.overview || m.remarks
                };
              });

              const uniqueMap = new Map();
              realList.forEach(m => {
                const key = `${normalizeName(m.vod_name)}-${m.vod_year || '未知'}`;
                if (!uniqueMap.has(key)) uniqueMap.set(key, m);
              });
              realList = Array.from(uniqueMap.values());

              if (realList.length > 0) {
                const formattedList = realList.slice(0, 6).map((m: any) => ({
                  title: m.vod_name,
                  poster: m.vod_pic || 'https://picsum.photos/300/450',
                  vodId: m.vod_id,
                  year: m.vod_year,
                  overview: m.vod_remarks || '暂无简介'
                }));
                commitMessages(prev => [...prev, {
                  id: simpleUid(), role: 'assistant', type: 'composite_movie', content: '',
                  compositeMovie: { summary: `已为您找到关于“${args.keyword}”的资源，点击播放：`, items: formattedList }
                }]);
                resultContent = `搜索成功，找到 ${formattedList.length} 部电影。清单：` + formattedList.map((m: any) => m.title).join(', ');
              } else {
                resultContent = `未找到关于“${args.keyword}”的资源。`;
              }
            } else if (tc.name === 'control_player') {
              resultContent = await new Promise<string>((resolve) => {
                let resolved = false;
                const onAbort = () => finish('播放器返回：已取消');
                const cleanup = () => {
                  window.removeEventListener('friday-tool-result', handler);
                  signal.removeEventListener('abort', onAbort);
                  if (timeoutId) clearTimeout(timeoutId);
                };
                const finish = (val: string) => {
                  if (resolved) return;
                  resolved = true;
                  cleanup();
                  resolve(val);
                };
                const handler = (e: Event) => {
                  const detail = (e as CustomEvent).detail;
                  if (detail.tool === 'control_player') {
                    finish(`播放器返回：${detail.success ? '成功' : '失败'} - ${detail.msg}`);
                  }
                };
                const timeoutId = setTimeout(() => finish('播放器返回：失败 - 页面未响应'), 3000);
                window.addEventListener('friday-tool-result', handler);
                signal.addEventListener('abort', onAbort);
                if (signal.aborted) { finish('播放器返回：已取消'); return; }
                window.dispatchEvent(new CustomEvent('friday-player-control', { detail: args }));
              });
            } else if (tc.name === 'page_control') {
              window.dispatchEvent(new CustomEvent('friday-page-control', { detail: args }));
              resultContent = `网页操作已下发: ${args.action}`;
            }
          } catch (err: any) {
            resultContent = `工具执行异常：${err.message}`;
          }
          const toolMsg: Message = {
            id: simpleUid(),
            role: 'tool',
            type: 'text',
            content: resultContent,
            tool_call_id: tc.id
          };
          commitMessages(prev => [...prev, toolMsg]);
          currentHistory = [...messagesRef.current];
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        commitMessages(prev => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: `⚠️ 异常: ${err.message}` }]);
        if (isVoiceModeRef.current) {
          setSpeechStateSafe('listening');
          startRecognition();
        }
      } else {
        setSpeechStateSafe('idle');
      }
    } finally {
      if (thisRequestId === requestIdRef.current && mountedRef.current) {
        setLoading(false);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        // 语音模式兜底：本轮没有安排朗读且仍处于思考中，回到监听
        if (isVoiceModeRef.current && !pendingSpeakRef.current && speechStateRef.current === 'thinking') {
          setSpeechStateSafe('listening');
          startRecognition();
        }
      }
    }
  }, [input, forceScrollToBottom, commitMessages, startRecognition, setSpeechStateSafe, cancelSpeech]);

  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);

  const visibleMessages = useMemo(() => {
    return messages.filter((m) => {
      if (m.type === 'system') return true;
      if (m.role === 'user') return true;
      if (m.role === 'assistant' && m.type === 'text') return !!(m.content && m.content.trim());
      if (m.type === 'composite_movie') return true;
      return false;
    });
  }, [messages]);

  if (!mounted) return null;

  const lastMsg = visibleMessages[visibleMessages.length - 1] || INIT_MESSAGE;

  const ballStyle: React.CSSProperties = {
    left: pos.x,
    top: pos.y,
    zIndex: 9999,
    position: 'fixed',
    width: 56,
    height: 56,
    borderRadius: '999px',
    pointerEvents: isOpen ? 'none' : 'auto',
    transform: 'translate(0,0)',
    touchAction: 'none',
  };

  return <>
    <div
      style={ballStyle}
      onPointerDown={handlePointerDown}
      onClick={() => {
        if (isDragging.current) return;
        togglePanel(false);
      }}
      className="bg-blue-600 shadow-lg flex items-center justify-center select-none"
    >
      <span className="text-white font-bold text-sm">AI</span>
    </div>

    {isMounted && createPortal(
      <div className={`fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh] pointer-events-none transition-all duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
        <div className="absolute inset-0 bg-black/20 pointer-events-auto backdrop-blur-sm transition-opacity" onClick={() => togglePanel(false)}></div>

        <div
          onClick={expandPopup}
          className={`relative bg-[#050505] overflow-hidden flex flex-col items-center pointer-events-auto shadow-[0_20px_50px_rgba(0,0,0,0.8),inset_0_0_20px_rgba(255,255,255,0.05)] border border-white/10 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] will-change-transform ${isOpen ? 'scale-100 translate-y-0 opacity-100' : 'scale-90 -translate-y-8 opacity-0'}`}
          style={{ width: isExpanded ? '90%' : '260px', maxWidth: isExpanded ? '360px' : '260px', height: isExpanded ? 'min(80vh, 520px)' : '110px', borderRadius: isExpanded ? '36px' : '55px', cursor: isExpanded ? 'default' : 'pointer' }}
        >
          <div className={`absolute bottom-0 left-0 w-full pointer-events-none z-0 overflow-hidden transition-all duration-700 ${isExpanded ? 'h-[100px]' : 'h-[60px]'} ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
            <div className="absolute bottom-[-15px] left-[10%] w-[80%] h-[50px] bg-[radial-gradient(ellipse_at_bottom,rgba(0,140,255,0.3)_0%,transparent_70%)] blur-[15px] animate-breathe-1 mix-blend-screen"></div>
            <div className="absolute bottom-[-5px] left-[30%] w-[40%] h-[30px] bg-[radial-gradient(ellipse_at_center,rgba(255,200,100,0.3)_0%,transparent_70%)] blur-[10px] animate-breathe-2 mix-blend-screen"></div>
            <div className="absolute bottom-[5px] left-[40%] w-[20%] h-[10px] bg-white/40 blur-[8px] animate-breathe-3 mix-blend-screen"></div>
          </div>

          {!isExpanded && (
            <div className="relative z-10 w-full h-full flex flex-col justify-center px-6">
              <p className="text-[13px] text-gray-200 leading-relaxed font-medium line-clamp-2 overflow-hidden pb-2" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {lastMsg?.type === 'composite_movie'
                  ? (lastMsg.compositeMovie?.items && lastMsg.compositeMovie.items.length > 0 ? `已为您找到资源，点击展开` : `未找到资源，点击展开查看详情`)
                  : lastMsg?.content || '点击这里和我对话...'}
              </p>
              <div className="absolute bottom-2 left-6 text-[10px] text-gray-500">点击展开 (Alt+A)</div>
            </div>
          )}

          {isExpanded && (
            <div className="relative z-10 flex flex-col min-h-0 w-full h-full animate-fadeIn">
              <div className="px-6 pt-5 pb-2 shrink-0 flex justify-between items-center">
                <span className="text-xs text-gray-400 font-medium">✨ Friday</span>
                <button
                  onClick={(e) => { e.stopPropagation(); togglePanel(false); }}
                  className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-xs hover:bg-white/20 transition-colors"
                  aria-label="关闭"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 pb-2 flex flex-col gap-4 scrollbar-hide" ref={chatContainerRef}>
                {visibleMessages.map((msg) => (
                  <div key={msg.id} className={`w-full flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {msg.type === 'text' && (
                      <div className={`text-[14px] leading-relaxed break-words max-w-[85%] ${msg.role === 'user' ? 'bg-[#2c2c2e] text-white p-3 rounded-2xl rounded-br-sm' : 'text-gray-100 p-1'}`}>
                        <div dangerouslySetInnerHTML={formatText(msg.content)} />
                      </div>
                    )}
                    {msg.type === 'composite_movie' && msg.compositeMovie && (
                      <div className="w-full mt-2 animate-fadeIn">
                        <div className="text-[13px] text-gray-200 leading-relaxed mb-3">
                          {msg.compositeMovie.summary}
                        </div>
                        <div className="relative w-full h-[110px] rounded-2xl overflow-hidden mb-3 bg-gradient-to-br from-indigo-900/40 to-emerald-900/40">
                          <div className="flex gap-2 px-3 pt-3 overflow-x-auto scrollbar-hide absolute inset-0">
                            {msg.compositeMovie.items.slice(0, 6).map((item, idx) => (
                              <img
                                key={idx}
                                src={item.poster}
                                alt={item.title}
                                loading="lazy"
                                className="h-[90px] w-[66px] rounded-lg object-cover shrink-0 bg-[#333]"
                                onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = `https://picsum.photos/seed/movie${idx}/300/450`; }}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-col gap-2.5">
                          {msg.compositeMovie.items.map((item, i) => (
                            <div
                              key={i}
                              onClick={(e) => { e.stopPropagation(); loadVideoInsidePage(item.vodId, item.title); }}
                              className="bg-[#1c1c1e] border border-white/10 rounded-xl p-2.5 flex gap-3 hover:bg-[#2c2c2e] transition-colors cursor-pointer"
                            >
                              <img
                                src={item.poster}
                                alt={item.title}
                                loading="lazy"
                                className="w-[65px] h-[95px] rounded-md object-cover bg-[#333] shrink-0"
                                onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = `https://picsum.photos/seed/card${i}/300/450`; }}
                              />
                              <div className="flex-1 min-w-0 py-1 flex flex-col justify-between">
                                <div>
                                  <div className="text-white font-bold text-[15px] truncate">{item.title}</div>
                                  <div className="text-gray-400 text-xs mt-0.5">{item.year ? `${item.year}年` : ''}</div>
                                  <div className="text-gray-500 text-[11px] mt-1 leading-snug" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.overview || '暂无简介'}</div>
                                </div>
                                <div className="text-[#0A84FF] text-xs font-medium self-end mt-1">▶ 点击播放</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {msg.type === 'system' && (
                      <div className="text-[12px] text-green-400 bg-green-500/10 border border-green-500/20 p-2.5 rounded-xl mt-1 text-left inline-block">
                        {msg.content}
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="self-start flex gap-1 items-center p-1">
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"></span>
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce delay-100"></span>
                    <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce delay-200"></span>
                  </div>
                )}
              </div>
              <div className="flex items-center px-4 pb-4 pt-2 gap-2 shrink-0 bg-transparent">
                {isSpeechSupported && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleVoiceMode(); }}
                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${isVoiceMode ? 'text-red-400 bg-red-500/20' : 'text-gray-400 hover:text-white bg-white/5'}`}
                    aria-label="语音模式"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" /></svg>
                  </button>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleSend();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={speechState === 'listening' ? '正在聆听...' : speechState === 'thinking' ? '思考中...' : speechState === 'speaking' ? '正在播报...' : '问点什么...'}
                  disabled={loading}
                  className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-gray-500 px-2 py-1"
                  style={{ color: '#ffffff', caretColor: '#ffffff' }}
                />

                {loading ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); if (abortControllerRef.current) abortControllerRef.current.abort(); }}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white bg-red-500 hover:bg-red-600 transition-colors"
                    title="停止生成"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  </button>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSend(); }}
                    disabled={!input.trim()}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white disabled:opacity-30"
                    aria-label="发送"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>,
      document.body
    )}
  </>;
}
