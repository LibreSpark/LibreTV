'use client';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

declare global {
  interface Window {
    __FRIDAY_PENDING_OPEN__?: boolean;
  }
}

const VIDEO_ELEMENT_ID = 'libretv-main-video'; 
const STORAGE_KEY = 'custom_api_url'; 
const MAX_FRONTEND_SSE_BUFFER = 1024 * 512;
const PLAYER_ACTION_TIMEOUT = 10000;

type MessageData = {
  title: string;
  poster: string;
  link: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  type: 'text' | 'movie_card' | 'system';
  content: string;
  data?: MessageData;
};

const INIT_MESSAGE: Message = {
  id: 'init',
  role: 'assistant',
  type: 'text',
  content: '你好！我是 Friday。想看什么电影，或者需要我帮你换几个新接口？',
};

type SpeechState = 'idle' | 'listening' | 'thinking' | 'speaking';

let simpleUidCounter = 0;
function simpleUid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  simpleUidCounter += 1;
  return `${Date.now().toString(36)}-${simpleUidCounter}-${Math.random().toString(36).slice(2, 12)}`;
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

function saveCustomSources(list: { name: string; url: string }[]) {
  try {
    const uniqueMap = new Map<string, { name: string; url: string }>();
    list.forEach((item) => uniqueMap.set(item.url, item));
    const finalList = Array.from(uniqueMap.values()).slice(-15);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(finalList));
    return finalList;
  } catch (err: unknown) {
    console.warn('保存自定义源失败，可能是隐私模式限制', err);
    return [];
  }
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
  const isSafari =
    typeof window !== 'undefined' &&
    /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

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

  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const isVoiceModeRef = useRef(false);
  const speechStateRef = useRef<SpeechState>('idle');
  const micDeniedRef = useRef(false);
  const isRecognizingRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const agentAbortControllerRef = useRef<AbortController | null>(null);

  const mountedRef = useRef(false);
  const messagesRef = useRef<Message[]>(messages);
  const isOpenRef = useRef(false);
  const hasInitMessageRef = useRef(false);
  const skipSpeakThisTurnRef = useRef(false);

  const focusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reloadTimerRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const redirectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleSendRef = useRef<((overrideText?: string) => Promise<void>) | null>(null);
  const speakTextRef = useRef<((text: string, forceResume?: boolean) => void) | null>(null);

  const setSpeechStateSafe = useCallback((state: SpeechState) => {
    speechStateRef.current = state;
    setSpeechState(state);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const togglePanel = useCallback(
    (reset = false) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        if (isOpenRef.current) {
          setIsOpen(false);
          setTimeout(() => setIsExpanded(false), 300);
          if (isVoiceModeRef.current) {
            isVoiceModeRef.current = false;
            setIsVoiceMode(false);
            setSpeechStateSafe('idle');
            synthRef.current?.cancel();
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            try {
              recognitionRef.current?.stop();
            } catch {}
          }
          synthRef.current?.cancel();
          if (abortControllerRef.current) abortControllerRef.current.abort();
          if (agentAbortControllerRef.current) agentAbortControllerRef.current.abort();
          if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
          skipSpeakThisTurnRef.current = false;
          setLoading(false);
          document.body.classList.remove('friday-popup-lock');
          closeTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setIsMounted(false);
          }, 300);
        } else {
          setIsMounted(true);
          setTimeout(() => {
            setIsOpen(true);
            document.body.classList.add('friday-popup-lock');
            if (reset) {
              setMessages([INIT_MESSAGE]);
              setInput('');
              hasInitMessageRef.current = true;
              skipSpeakThisTurnRef.current = false;
              if (abortControllerRef.current) abortControllerRef.current.abort();
              if (agentAbortControllerRef.current) agentAbortControllerRef.current.abort();
              synthRef.current?.cancel();
              try {
                recognitionRef.current?.stop();
              } catch {}
            }
          }, 10);
        }
      }, 150);
    },
    [setSpeechStateSafe]
  );

  useEffect(() => {
    setMounted(true);
    mountedRef.current = true;
    document.body.classList.remove('friday-popup-lock');
    if (!hasInitMessageRef.current) {
      setMessages([INIT_MESSAGE]);
      hasInitMessageRef.current = true;
    }
    micDeniedRef.current = false;
    if (typeof window === 'undefined') return;
    synthRef.current = window.speechSynthesis;
    if (window.__FRIDAY_PENDING_OPEN__) {
      window.__FRIDAY_PENDING_OPEN__ = false;
      closeTimerRef.current = setTimeout(() => {
        if (mountedRef.current && !isOpenRef.current) togglePanel(false);
      }, 50);
    }
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) setIsSpeechSupported(false);
    return () => {
      mountedRef.current = false;
      document.body.classList.remove('friday-popup-lock');
      synthRef.current?.cancel();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {}
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (agentAbortControllerRef.current) agentAbortControllerRef.current.abort();
      [closeTimerRef, reloadTimerRef, debounceTimerRef, focusTimerRef, redirectTimerRef].forEach(
        (ref) => {
          if (ref.current) clearTimeout(ref.current);
        }
      );
    };
  }, [togglePanel]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
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

  const startRecognition = useCallback(() => {
    if (isRecognizingRef.current || !recognitionRef.current) return;
    isRecognizingRef.current = true;
    try {
      recognitionRef.current.start();
    } catch {
      isRecognizingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !isSpeechSupported) return;
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        isRecognizingRef.current = true;
        if (isVoiceModeRef.current) setSpeechStateSafe('listening');
      };
      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            setInput(event.results[i][0].transcript);
          }
        }
        if (finalTranscript) {
          isRecognizingRef.current = false;
          try {
            recognition.stop();
          } catch {}
          if (handleSendRef.current) {
            handleSendRef.current(finalTranscript);
          }
        }
      };
      recognition.onerror = (e: any) => {
        isRecognizingRef.current = false;
        if (e.error === 'not-allowed') {
          setIsVoiceMode(false);
          isVoiceModeRef.current = false;
          micDeniedRef.current = true;
        }
        setSpeechStateSafe('idle');
      };
      recognition.onend = () => {
        isRecognizingRef.current = false;
        if (!mountedRef.current || micDeniedRef.current || document.visibilityState === 'hidden') {
          return;
        }
        if (isVoiceModeRef.current && speechStateRef.current === 'listening') {
          if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = setTimeout(() => {
            if (
              mountedRef.current &&
              isVoiceModeRef.current &&
              speechStateRef.current === 'listening'
            ) {
              startRecognition();
            }
          }, 300);
        }
      };
      recognitionRef.current = recognition;
    }
  }, [isSpeechSupported, setSpeechStateSafe, startRecognition]);

  const speakText = useCallback(
    (text: string, forceResume = false) => {
      if (!isVoiceModeRef.current && !forceResume) return;
      if (!synthRef.current) return;
      synthRef.current.cancel();
      const cleanText = text.replace(/[*#_`~\[\]\(\)>```]/g, '').replace(/\n+/g, '。');
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.lang = 'zh-CN';
      utterance.onstart = () => setSpeechStateSafe('speaking');
      utterance.onend = () => {
        if ((isVoiceModeRef.current || forceResume) && !isSafari) {
          setSpeechStateSafe('listening');
          startRecognition();
        } else {
          setSpeechStateSafe('idle');
          if (isSafari) {
            isVoiceModeRef.current = false;
            setIsVoiceMode(false);
          }
        }
      };
      synthRef.current.speak(utterance);
    },
    [isSafari, setSpeechStateSafe, startRecognition]
  );

  useEffect(() => {
    speakTextRef.current = speakText;
  }, [speakText]);

  const toggleVoiceMode = () => {
    if (!isSpeechSupported) return;
    if (isVoiceMode) {
      isVoiceModeRef.current = false;
      setIsVoiceMode(false);
      setSpeechStateSafe('idle');
      synthRef.current?.cancel();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {}
    } else {
      micDeniedRef.current = false;
      isVoiceModeRef.current = true;
      setIsVoiceMode(true);
      setSpeechStateSafe('listening');
      startRecognition();
    }
  };

  const expandPopup = () => {
    if (!isExpanded) {
      setIsExpanded(true);
      focusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) inputRef.current?.focus();
      }, 400);
    }
  };

  const forceScrollToBottom = useCallback(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, []);

  useEffect(() => {
    if (isExpanded) forceScrollToBottom();
  }, [messages, loading, isExpanded, forceScrollToBottom]);

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

  const safeNavigate = (href: string) => {
    try {
      const u = new URL(href, window.location.origin);
      if (!['http:', 'https:'].includes(u.protocol)) {
        setMessages((prev) => [
          ...prev,
          { id: simpleUid(), role: 'assistant', type: 'text', content: '⚠️ 不安全链接已被拦截' },
        ]);
        return;
      }
      window.location.href = u.href;
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: simpleUid(), role: 'assistant', type: 'text', content: '⚠️ 链接格式错误' },
      ]);
    }
  };

  const executePlayerAction = async (
    action: string,
    time?: number
  ): Promise<{ success: boolean; msg: string }> => {
    const video = document.getElementById(VIDEO_ELEMENT_ID) as HTMLVideoElement;
    if (!video) return { success: false, msg: '当前页面没有视频播放器' };

    const safeSeek = (targetTime: number) => {
      if (!Number.isFinite(targetTime) || targetTime < 0) return false;
      if (video.seekable && video.seekable.length > 0) {
        let isSeekable = false;
        for (let i = 0; i < video.seekable.length; i++) {
          if (targetTime >= video.seekable.start(i) && targetTime <= video.seekable.end(i)) {
            isSeekable = true;
            break;
          }
        }
        if (!isSeekable) return false;
      } else if (Number.isFinite(video.duration) && targetTime > video.duration) {
        return false;
      }
      video.currentTime = targetTime;
      return true;
    };

    try {
      switch (action) {
        case 'play':
          await Promise.race([
            video.play(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('播放超时')), PLAYER_ACTION_TIMEOUT))
          ]);
          break;
        case 'pause':
          video.pause();
          break;
        case 'seek_forward':
          if (!safeSeek(video.currentTime + 10)) return { success: false, msg: '无法快进：超出可播放范围' };
          break;
        case 'seek_backward':
          if (!safeSeek(video.currentTime - 10)) return { success: false, msg: '无法快退：超出可播放范围' };
          break;
        case 'seek_to':
          if (typeof time !== 'number' || !Number.isFinite(time)) return { success: false, msg: '参数错误：必须提供有效时间' };
          if (!safeSeek(time)) return { success: false, msg: '参数错误：指定时间不可达' };
          break;
        case 'volume_up':
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case 'volume_down':
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case 'fullscreen':
          if (video.requestFullscreen) {
            await Promise.race([
              video.requestFullscreen(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('全屏超时')), PLAYER_ACTION_TIMEOUT))
            ]);
          } else {
            return { success: false, msg: '浏览器不支持全屏' };
          }
          break;
        default:
          return { success: false, msg: '未知播放器操作' };
      }
      return { success: true, msg: `已执行操作: ${action}` };
    } catch (err: unknown) {
      return { success: false, msg: `浏览器拦截或异常: ${String((err as Error).message)}` };
    }
  };

  const isSafeUrl = (urlStr: string) => {
    try {
      const url = new URL(urlStr);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (url.username || url.password) return false;
      let host = url.hostname.toLowerCase();
      if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
      if (host.endsWith('.local') || host.endsWith('.localhost') || host === 'localhost' || host === '::' || host === '::1') return false;
      if (host.startsWith('127.') || host.startsWith('0.') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return false;
      const parts = host.split('.');
      if (parts.length === 4) {
        const p0 = parseInt(parts[0]);
        const p1 = parseInt(parts[1]);
        if (p0 === 172 && p1 >= 16 && p1 <= 31) return false;
        if (p0 === 100 && p1 >= 64 && p1 <= 127) return false;
        if (p0 >= 224 && p0 <= 239) return false;
      }
      if (host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) return false;
      if (host.startsWith('::ffff:') || host.includes('127.0.0.1')) return false;
      return true;
    } catch {
      return false;
    }
  };

  const validateFrontendTool = (name: string, args: Record<string, any>): boolean => {
    if (!args || typeof args !== 'object') return false;
    if (name === 'search_movie') return typeof args.keyword === 'string' && args.keyword.trim().length > 0 && args.keyword.length <= 100;
    if (name === 'add_video_source') return typeof args.name === 'string' && args.name.length > 0 && args.name.length <= 30 && typeof args.api_url === 'string' && isSafeUrl(args.api_url);
    if (name === 'update_api_config') return typeof args.api_url === 'string' && isSafeUrl(args.api_url);
    if (name === 'control_player') {
      const acts = ['play', 'pause', 'seek_forward', 'seek_backward', 'volume_up', 'volume_down', 'fullscreen', 'seek_to'];
      if (!acts.includes(args.action)) return false;
      if (args.action === 'seek_to' && (typeof args.time !== 'number' || !Number.isFinite(args.time))) return false;
      return true;
    }
    if (name === 'fetch_and_add_source') return true;
    return false;
  };

  const processStreamResponse = async (response: Response) => {
    if (!response.body) throw new Error('empty body');
    const reader = response.body.getReader();
    try {
      let fullContent = '';
      const toolCalls = new Map<number, { id?: string; name: string; arguments: string; isDiscarded?: boolean }>();
      let streamMsgId: string | null = null;
      let hasStreamedText = false;
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let receivedDone = false;
      let streamCorrupted = false;

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

        if (dataStr === '[DONE]') {
          receivedDone = true;
          return;
        }

        try {
          const parsedData = JSON.parse(dataStr);
          const delta = parsedData.choices?.[0]?.delta;
          const finishReason = parsedData.choices?.[0]?.finish_reason;

          if (finishReason === 'length') {
            setMessages((prev) => [
              ...prev,
              { id: simpleUid(), role: 'assistant', type: 'system', content: '\n⚠️ 输出长度已达上限，回答被截断。' },
            ]);
          }

          if (delta?.content) {
            fullContent += delta.content;
            if (!hasStreamedText) {
              hasStreamedText = true;
              streamMsgId = simpleUid();
              setMessages((prev) => [
                ...prev,
                { id: streamMsgId!, role: 'assistant', type: 'text', content: fullContent },
              ]);
            } else {
              setMessages((prev) => {
                const up = [...prev];
                if (streamMsgId) {
                  const idx = up.findIndex((m) => m.id === streamMsgId);
                  if (idx > -1) up[idx].content = fullContent;
                }
                return up;
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
                if (current.arguments.length + tc.function.arguments.length <= 50000) {
                  current.arguments += tc.function.arguments;
                } else {
                  current.isDiscarded = true;
                  current.name = '';
                  current.arguments = '';
                }
              }
              toolCalls.set(index, current);
            }
          }
        } catch {
          streamCorrupted = true;
          receivedDone = true;
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
          throw new Error('数据包过大，存在内存溢出风险');
        }

        let match;
        const delimiter = /\r\n\r\n|\n\n|\r\r/;
        while ((match = delimiter.exec(buffer)) !== null) {
          const eventBlock = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          processEvent(eventBlock);

          if (receivedDone || streamCorrupted) {
            try {
              reader.cancel();
            } catch {}
            break;
          }
        }
        if (receivedDone || streamCorrupted) break;
      }

      if (!mountedRef.current) return;

      if (streamCorrupted || !receivedDone) {
        if (toolCalls.size > 0 || hasStreamedText) {
          setMessages((prev) => [
            ...prev,
            { id: simpleUid(), role: 'assistant', type: 'text', content: streamCorrupted ? '⚠️ 数据异常，任务已中止' : '⚠️ 网络中断，任务未完成' },
          ]);
        }
        return;
      }

      if (toolCalls.size > 0) {
        if (hasStreamedText && streamMsgId) {
          setMessages((prev) => prev.filter((m) => m.id !== streamMsgId));
        }

        for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          if (!call.name || !call.arguments || call.isDiscarded) continue;
          try {
            const args = JSON.parse(call.arguments);

            if (!validateFrontendTool(call.name, args)) {
              throw new Error('前端安全校验拦截：参数不合法或包含危险地址');
            }

            if (call.name === 'control_player') {
              const result = await executePlayerAction(args.action, args.time);
              setMessages((prev) => [
                ...prev,
                { id: simpleUid(), role: 'system', type: 'system', content: result.success ? `🎬 ${result.msg}` : `⚠️ 失败：${result.msg}` },
              ]);
              if (result.success) speakTextRef.current?.('操作已执行');
              else speakTextRef.current?.(`操作失败：${result.msg}`);
              skipSpeakThisTurnRef.current = true;
            } else if (call.name === 'search_movie') {
              const targetLink = `/search?q=${encodeURIComponent(args.keyword)}`;
              setMessages((prev) => [
                ...prev,
                {
                  id: simpleUid(), role: 'assistant', type: 'movie_card', content: '',
                  data: { title: args.keyword, poster: 'https://picsum.photos/300/450', link: targetLink },
                },
              ]);
              speakTextRef.current?.(`已为您找到${args.keyword}`);
              window.dispatchEvent(new CustomEvent('friday-action-search', { detail: args.keyword }));
              if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
              redirectTimerRef.current = setTimeout(() => {
                if (mountedRef.current) {
                  window.location.href = targetLink;
                  togglePanel(false);
                }
              }, 800);
            } else if (call.name === 'fetch_and_add_source') {
              await executeAgentFetchSources();
            } else if (call.name === 'add_video_source') {
              const existing = getCustomSources();
              existing.push({ name: args.name.slice(0, 30), url: new URL(args.api_url).href });
              saveCustomSources(existing);
              setMessages((prev) => [
                ...prev,
                { id: simpleUid(), role: 'system', type: 'system', content: `✅ 已保存本地配置：${args.name}\n请刷新页面生效。` },
              ]);
              speakTextRef.current?.(`已为您添加${args.name}接口`);
            } else if (call.name === 'update_api_config') {
              saveCustomSources([{ name: '自定义', url: new URL(args.api_url).href }]);
              setMessages((prev) => [
                ...prev,
                { id: simpleUid(), role: 'system', type: 'system', content: `✅ 浏览器本地 API 配置已更新，请刷新页面。` },
              ]);
              speakTextRef.current?.('本地 API 配置已更新');
            }
          } catch (err: unknown) {
            const message = `⚠️ 工具 ${call.name} 执行失败：${(err as Error)?.message || '参数错误'}`;
            setMessages((prev) => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: message }]);
            speakTextRef.current?.(message);
          }
        }
      } else if (fullContent) {
        if (!skipSpeakThisTurnRef.current) {
          speakTextRef.current?.(fullContent);
        }
        skipSpeakThisTurnRef.current = false;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  };

  const executeAgentFetchSources = async () => {
    if (!mountedRef.current) return;
    if (isVoiceModeRef.current) setSpeechStateSafe('thinking');
    setIsExpanded(true);
    setMessages((prev) => [
      ...prev,
      { id: simpleUid(), role: 'assistant', type: 'text', content: `正在全网抓取接口并自动筛选...` },
    ]);
    forceScrollToBottom();
    agentAbortControllerRef.current = new AbortController();
    const ac = agentAbortControllerRef.current;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'fetch_sources',
          messages: messagesRef.current.filter((m) => m.type !== 'system').map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: ac.signal,
      });
      if (!response.ok) throw new Error('Agent 抓取失败');
      await processStreamResponse(response);
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError' && mountedRef.current) {
        const errText = `⚠️ 抓取源失败：${(err as Error).message}`;
        setMessages((prev) => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: errText }]);
        speakTextRef.current?.(errText);
      }
    } finally {
      if (mountedRef.current) {
        agentAbortControllerRef.current = null;
      }
    }
  };

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = overrideText || input.trim();
    if (!text || loading) return;
    
    synthRef.current?.cancel();
    setInput('');
    setIsExpanded(true);
    skipSpeakThisTurnRef.current = false;

    const userMessage: Message = { id: simpleUid(), role: 'user', type: 'text', content: text };
    const history = [
      ...messagesRef.current.filter((m) => m.type !== 'system').map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];
    setMessages((prev) => [...prev, userMessage]);

    setLoading(true);
    if (isVoiceModeRef.current) setSpeechStateSafe('thinking');
    forceScrollToBottom();
    abortControllerRef.current = new AbortController();

    try {
      let playerContext = '';
      const video = document.getElementById(VIDEO_ELEMENT_ID) as HTMLVideoElement;
      playerContext = video
        ? `[系统提示：当前视频进度为 ${Math.floor(video.currentTime)} 秒，${video.paused ? '处于暂停状态' : '正在播放'}，音量为 ${Math.floor(video.volume * 100)}%。]`
        : `[系统提示：当前页面没有视频播放器。]`;

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, playerContext }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `网络错误`);
      }
      await processStreamResponse(response);
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError' && mountedRef.current) {
        const errMsg = `⚠️ ${(err as Error).message}`;
        setMessages((prev) => [...prev, { id: simpleUid(), role: 'assistant', type: 'text', content: errMsg }]);
        speakTextRef.current?.(errMsg);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        abortControllerRef.current = null;
        skipSpeakThisTurnRef.current = false;
      }
    }
  }, [input, loading, setSpeechStateSafe, forceScrollToBottom]);

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  if (!mounted || !isMounted) return null;

  const visibleMessages = messages.filter((m) => m.type !== 'system');
  const lastMsg = visibleMessages[visibleMessages.length - 1] || INIT_MESSAGE;

  return createPortal(
    <div className={`fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh] pointer-events-none transition-all duration-300 ${isOpen ? 'opacity-100' : 'opacity-0'}`} style={{ transform: 'translateZ(1px)' }}>
      <div className="absolute inset-0 bg-black/20 pointer-events-auto backdrop-blur-sm transition-opacity" style={{ transform: 'translateZ(1px)' }} onClick={() => togglePanel(false)}></div>
      
      <div ref={popupRef} onClick={expandPopup}
        className={`relative bg-[#050505] overflow-hidden flex flex-col items-center pointer-events-auto shadow-[0_20px_50px_rgba(0,0,0,0.8),inset_0_0_20px_rgba(255,255,255,0.05)] border border-white/10 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] will-change-transform ${isOpen ? 'scale-100 translate-y-0 opacity-100' : 'scale-90 -translate-y-8 opacity-0'}`}
        style={{ transform: 'translateZ(1px)', width: isExpanded ? '90%' : '260px', maxWidth: isExpanded ? '360px' : '260px', height: isExpanded ? '450px' : '110px', borderRadius: isExpanded ? '36px' : '55px', cursor: isExpanded ? 'default' : 'pointer' }}>
        <div className={`absolute bottom-0 left-0 w-full pointer-events-none z-0 overflow-hidden transition-all duration-700 ${isExpanded ? 'h-[100px]' : 'h-[60px]'} ${isOpen ? 'opacity-100' : 'opacity-0'}`}>
          <div className="absolute bottom-[-15px] left-[10%] w-[80%] h-[50px] bg-[radial-gradient(ellipse_at_bottom,rgba(0,140,255,0.3)_0%,transparent_70%)] blur-[15px] animate-breathe-1 mix-blend-screen"></div>
          <div className="absolute bottom-[-5px] left-[30%] w-[40%] h-[30px] bg-[radial-gradient(ellipse_at_center,rgba(255,200,100,0.3)_0%,transparent_70%)] blur-[10px] animate-breathe-2 mix-blend-screen"></div>
          <div className="absolute bottom-[5px] left-[40%] w-[20%] h-[10px] bg-white/40 blur-[8px] animate-breathe-3 mix-blend-screen"></div>
        </div>
        {!isExpanded && (
          <div className="relative z-10 w-full h-full flex flex-col justify-center px-6">
            <p className="text-[13px] text-gray-200 leading-relaxed font-medium line-clamp-2 overflow-hidden pb-2">
              {lastMsg?.type === 'movie_card' ? `已为您找到《${lastMsg.data?.title}》，点击展开` : (lastMsg?.content || "点击这里和我对话...")}
            </p>
            <div className="absolute bottom-2 left-6 text-[10px] text-gray-500">点击展开</div>
          </div>
        )}
        {isExpanded && (
          <div className="relative z-10 flex flex-col min-h-0 w-full h-full animate-fadeIn">
            <div className="px-6 pt-5 pb-2 shrink-0 flex justify-between items-center">
              <span className="text-xs text-gray-400 font-medium">✨ Friday</span>
              <button onClick={(e) => { e.stopPropagation(); togglePanel(false); }} className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-xs hover:bg-white/20 transition-colors">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 pb-2 flex flex-col gap-4 scrollbar-hide" ref={chatContainerRef}>
              {messages.map((msg) => (
                <div key={msg.id} className={`w-full flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  {msg.type === 'text' && (
                    <div className={`text-[14px] leading-relaxed break-words max-w-[85%] ${msg.role === 'user' ? 'bg-[#2c2c2e] text-white p-3 rounded-2xl rounded-br-sm' : 'text-gray-100 p-1'}`}>
                      <div dangerouslySetInnerHTML={formatText(msg.content)} />
                    </div>
                  )}
                  {msg.type === 'movie_card' && (
                    <div onClick={(e) => { e.stopPropagation(); synthRef.current?.cancel(); safeNavigate(msg.data!.link); togglePanel(false); }} className="bg-[#1c1c1e] border border-white/10 rounded-2xl overflow-hidden w-full max-w-[220px] shadow-lg mt-1 inline-block text-left cursor-pointer hover:scale-[1.02] transition-transform">
                      <div className="h-[120px] w-full relative bg-[#2c2c2e] overflow-hidden">
                        <img src={msg.data!.poster} alt={msg.data!.title} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).src = 'https://picsum.photos/300/450'; }} />
                      </div>
                      <div className="p-3 flex flex-col gap-1">
                        <span className="text-white font-bold text-sm truncate">{msg.data!.title}</span>
                        <button className="mt-2 w-full bg-white text-black text-[12px] py-1.5 rounded-lg font-bold active:scale-95 transition-transform">立即播放</button>
                      </div>
                    </div>
                  )}
                  {msg.type === 'system' && (<div className="text-[12px] text-green-400 bg-green-500/10 border border-green-500/20 p-2.5 rounded-xl mt-1 text-left inline-block">{msg.content}</div>)}
                </div>
              ))}
              {loading && (<div className="self-start flex gap-1 items-center p-1"><span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"></span><span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce delay-100"></span><span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce delay-200"></span></div>)}
            </div>
            <div className="flex items-center px-4 pb-4 pt-2 gap-2 shrink-0 bg-transparent">
              {isSpeechSupported && (
                <button onClick={(e) => { e.stopPropagation(); toggleVoiceMode(); }} className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${isVoiceMode ? 'text-red-400 bg-red-500/20' : 'text-gray-400 hover:text-white bg-white/5'}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" /></svg>
                </button>
              )}
              <input ref={inputRef} type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }} onClick={(e) => e.stopPropagation()}
                placeholder={speechState === 'listening' ? '正在聆听...' : speechState === 'thinking' ? '思考中...' : speechState === 'speaking' ? '正在播报...' : '问点什么...'}
                disabled={loading} className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder-gray-500 px-2 py-1" style={{ color: '#ffffff', caretColor: '#ffffff' }} />
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
