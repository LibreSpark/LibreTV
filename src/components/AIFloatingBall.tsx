'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppStore, resolveSource } from '@/lib/store';
import type { SearchResultItem } from '@/lib/types';

type UIMessage = {
  id: string;
  role: 'user' | 'assistant';
  type: 'text' | 'movie_list';
  content: string;
  items?: SearchResultItem[];
};

type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type HistoryMessage = {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type ApiResponse = {
  type: 'final' | 'tool_calls';
  text?: string;
  searchText?: string;
  movieData?: unknown;
  assistantMessage?: HistoryMessage;
  serverToolMessages?: HistoryMessage[];
  uiToolCalls?: ToolCall[];
  error?: string;
};

const MAX_HISTORY = 45;
const MAX_TOOL_ROUNDS = 5;
const MAX_UI_TOOL_CALLS = 8;
const MAX_TOOL_ARGUMENTS = 4000;
const ALLOWED_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const uid = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

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

function isToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value) || !isRecord(value.function)) return false;

  if (
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    value.type !== 'function' ||
    typeof value.function.name !== 'string' ||
    typeof value.function.arguments !== 'string' ||
    value.function.arguments.length > MAX_TOOL_ARGUMENTS
  ) {
    return false;
  }

  if (
    value.function.name !== 'control_player' &&
    value.function.name !== 'page_control'
  ) {
    return false;
  }

  try {
    const args: unknown = JSON.parse(value.function.arguments || '{}');
    return isRecord(args);
  } catch {
    return false;
  }
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (!isRecord(value)) return false;

  if (value.role === 'user') {
    return typeof value.content === 'string';
  }

  if (value.role === 'assistant') {
    if (
      value.content !== undefined &&
      value.content !== null &&
      typeof value.content !== 'string'
    ) {
      return false;
    }

    if (value.tool_calls !== undefined) {
      if (
        !Array.isArray(value.tool_calls) ||
        value.tool_calls.length === 0 ||
        value.tool_calls.length > MAX_UI_TOOL_CALLS ||
        !value.tool_calls.every(isToolCall)
      ) {
        return false;
      }
    }

    return true;
  }

  if (value.role === 'tool') {
    return (
      typeof value.tool_call_id === 'string' &&
      typeof value.content === 'string'
    );
  }

  return false;
}

/**
 * 按完整用户对话轮次压缩。
 * 不会从中间截断一组 assistant tool_calls / tool 结果。
 */
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

  const selected: HistoryMessage[][] = [];
  let count = 0;

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];

    if (selected.length > 0 && count + group.length > MAX_HISTORY) {
      break;
    }

    selected.unshift(group);
    count += group.length;
  }

  return selected.flat();
}

function validateToolPairing(
  assistantMessage: unknown,
  uiToolCalls: unknown,
): assistantMessage is HistoryMessage {
  if (!isHistoryMessage(assistantMessage)) return false;
  if (assistantMessage.role !== 'assistant') return false;
  if (!Array.isArray(assistantMessage.tool_calls)) return false;
  if (!Array.isArray(uiToolCalls)) return false;
  if (uiToolCalls.length === 0 || uiToolCalls.length > MAX_UI_TOOL_CALLS) {
    return false;
  }

  const assistantCalls = assistantMessage.tool_calls;

  if (assistantCalls.length !== uiToolCalls.length) return false;

  const assistantIds = new Set<string>();

  for (const call of assistantCalls) {
    if (!isToolCall(call) || assistantIds.has(call.id)) return false;
    assistantIds.add(call.id);
  }

  const uiIds = new Set<string>();

  for (const rawCall of uiToolCalls) {
    if (!isToolCall(rawCall) || uiIds.has(rawCall.id)) return false;
    uiIds.add(rawCall.id);
  }

  if (assistantIds.size !== uiIds.size) return false;

  for (const id of assistantIds) {
    if (!uiIds.has(id)) return false;
  }

  return true;
}

function getSafeInternalPath(path: string): string | null {
  const value = path.trim();

  if (!value || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\')) return null;

  try {
    const url = new URL(value, window.location.origin);

    if (url.origin !== window.location.origin) return null;
    if (url.protocol !== window.location.protocol) return null;

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

async function readApiResponse(response: Response): Promise<ApiResponse> {
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `服务器返回的不是 JSON 数据（HTTP ${response.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`,
    );
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch {
    throw new Error(`服务器响应无法解析（HTTP ${response.status}）`);
  }

  if (!isRecord(data)) {
    throw new Error('服务器返回的数据格式无效');
  }

  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `请求失败：HTTP ${response.status}`,
    );
  }

  if (data.type !== 'final' && data.type !== 'tool_calls') {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : '服务器返回了未知响应类型',
    );
  }

  return data as unknown as ApiResponse;
}

export default function AIFloatingBall() {
  const router = useRouter();

  const [active, setActive] = useState(false);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [listening, setListening] = useState(false);

  const isDragging = useRef(false);
  const dragStart = useRef({
    x: 0,
    y: 0,
    ballX: 0,
    ballY: 0,
  });

  const listRef = useRef<HTMLDivElement | null>(null);
  const sendLock = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const apiHistoryRef = useRef<HistoryMessage[]>([]);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const el = listRef.current;

    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages, busy, active]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();

      try {
        recognitionRef.current?.abort();
      } catch {
        // 组件卸载时忽略语音识别清理异常。
      }

      if (
        typeof window !== 'undefined' &&
        window.speechSynthesis
      ) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (
        !voiceEnabled ||
        !text ||
        typeof window === 'undefined' ||
        !window.speechSynthesis
      ) {
        return;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';

      window.speechSynthesis.speak(utterance);
    },
    [voiceEnabled],
  );

  const addTextMessage = useCallback(
    (role: 'user' | 'assistant', content: string) => {
      setMessages(prev => [
        ...prev,
        {
          id: uid(),
          role,
          type: 'text',
          content,
        },
      ]);

      if (role === 'assistant') {
        speak(content);
      }
    },
    [speak],
  );

  const addMovieList = useCallback((items: SearchResultItem[]) => {
    if (!items.length) return;

    setMessages(prev => [
      ...prev,
      {
        id: uid(),
        role: 'assistant',
        type: 'movie_list',
        content: '为你找到以下资源：',
        items,
      },
    ]);
  }, []);

  const openNativeDetail = useCallback((item: SearchResultItem) => {
    window.dispatchEvent(
      new CustomEvent('friday-open-detail', {
        detail: {
          sourceKey: item.sourceKey,
          sourceName: item.sourceName,
          sourceUrl: item.sourceUrl,
          vodId: item.vodId,
          name: item.name,
          pic: item.pic,
        },
      }),
    );
  }, []);

  const stopRequest = useCallback(() => {
    abortRef.current?.abort();

    try {
      recognitionRef.current?.stop();
    } catch {
      // 忽略识别停止异常。
    }

    if (
      typeof window !== 'undefined' &&
      window.speechSynthesis
    ) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const startVoice = useCallback(() => {
    if (typeof window === 'undefined') return;

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      addTextMessage('assistant', '当前浏览器不支持语音识别。');
      return;
    }

    try {
      const rec = new SpeechRecognition();

      rec.lang = 'zh-CN';
      rec.continuous = false;
      rec.interimResults = true;

      rec.onstart = () => {
        setListening(true);
      };

      rec.onresult = (event: any) => {
        let text = '';

        for (
          let i = event.resultIndex;
          i < event.results.length;
          i++
        ) {
          text += event.results[i][0].transcript;
        }

        if (text) setInput(text);
      };

      rec.onerror = () => {
        setListening(false);
      };

      rec.onend = () => {
        setListening(false);
      };

      recognitionRef.current = rec;
      rec.start();
    } catch {
      setListening(false);
      addTextMessage('assistant', '语音识别启动失败，请检查浏览器麦克风权限。');
    }
  }, [addTextMessage]);

  const executeUiTool = useCallback(
    async (call: ToolCall): Promise<string> => {
      try {
        if (!isToolCall(call)) {
          return '工具调用格式无效';
        }

        const args: unknown = JSON.parse(call.function.arguments || '{}');

        if (!isRecord(args)) {
          return '工具参数格式无效';
        }

        if (call.function.name === 'control_player') {
          const video = document.getElementById(
            'libretv-main-video',
          ) as HTMLVideoElement | null;

          if (!video) return '找不到播放器';

          switch (args.action) {
            case 'play': {
              try {
                await video.play();
                return '已成功开始播放';
              } catch {
                return '播放失败：浏览器可能阻止了自动播放，或视频尚未准备好';
              }
            }

            case 'pause': {
              video.pause();
              return '已暂停播放';
            }

            case 'seek_to': {
              if (
                typeof args.time !== 'number' ||
                !Number.isFinite(args.time) ||
                args.time < 0
              ) {
                return '跳转失败：时间参数无效';
              }

              if (
                Number.isFinite(video.duration) &&
                args.time > video.duration
              ) {
                return '跳转失败：目标时间超过视频时长';
              }

              try {
                video.currentTime = args.time;
                return `已尝试跳转到 ${args.time} 秒`;
              } catch {
                return '跳转失败：播放器当前无法定位到该时间';
              }
            }

            case 'set_rate': {
              if (
                typeof args.rate !== 'number' ||
                !ALLOWED_RATES.includes(args.rate)
              ) {
                return '倍速设置失败：不支持该倍速';
              }

              try {
                video.playbackRate = args.rate;
                return `已设置为 ${args.rate} 倍速`;
              } catch {
                return '倍速设置失败';
              }
            }

            default:
              return '不支持的播放器操作';
          }
        }

        if (call.function.name === 'page_control') {
          if (args.action === 'navigate') {
            if (typeof args.path !== 'string') {
              return '页面跳转失败：路径无效';
            }

            const safePath = getSafeInternalPath(args.path);

            if (!safePath) {
              return '页面跳转失败：只允许站内地址';
            }

            router.push(safePath);
            return '已提交站内页面跳转';
          }

          if (args.action === 'site_search') {
            if (
              typeof args.keyword !== 'string' ||
              !args.keyword.trim() ||
              args.keyword.length > 100
            ) {
              return '站内搜索失败：关键词无效';
            }

            router.push(
              `/search?wd=${encodeURIComponent(args.keyword.trim())}`,
            );

            return '已提交站内搜索';
          }

          if (args.action === 'toggle_theme') {
            document.documentElement.classList.toggle('dark');
            return '已切换主题';
          }

          return '不支持的页面操作';
        }

        return '未知工具';
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : '未知异常';

        return `工具执行异常：${message}`;
      }
    },
    [router],
  );

  const send = useCallback(
    async (overrideText?: string) => {
      if (sendLock.current) return;

      const text = (
        overrideText !== undefined ? overrideText : input
      ).trim();

      if (!text) return;

      sendLock.current = true;
      setInput('');
      setBusy(true);

      addTextMessage('user', text);

      apiHistoryRef.current.push({
        role: 'user',
        content: text,
      });

      const state = useAppStore.getState();

      const selectedSources = state.selectedKeys
        .map((key: string) => resolveSource(state, key))
        .filter(
          (source): source is NonNullable<typeof source> =>
            source !== undefined,
        )
        .map(source => ({
          key: source.key,
          name: source.name,
          url: source.url,
          isAdult: source.isAdult,
        }));

      const controller = new AbortController();
      abortRef.current = controller;

      let completed = false;

      try {
        for (let step = 0; step < MAX_TOOL_ROUNDS; step++) {
          if (controller.signal.aborted) break;

          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messages: apiHistoryRef.current,
              sources: selectedSources,
              filterAdult: state.yellowFilter === true,
            }),
            signal: controller.signal,
          });

          const data = await readApiResponse(response);

          if (controller.signal.aborted) break;

          if (Array.isArray(data.movieData)) {
            const validItems = data.movieData.filter(isSearchResultItem);

            if (validItems.length > 0) {
              addMovieList(validItems);
            }
          }

          if (data.type === 'final') {
            if (typeof data.text === 'string' && data.text.trim()) {
              apiHistoryRef.current.push({
                role: 'assistant',
                content: data.text,
              });

              addTextMessage('assistant', data.text);
            }

            completed = true;
            break;
          }

          if (data.type === 'tool_calls') {
            const uiCalls = data.uiToolCalls;

            if (
              !Array.isArray(uiCalls) ||
              uiCalls.length === 0 ||
              uiCalls.length > MAX_UI_TOOL_CALLS
            ) {
              throw new Error('服务器返回的前端工具列表无效');
            }

            if (!validateToolPairing(data.assistantMessage, uiCalls)) {
              throw new Error('工具调用记录与执行列表不匹配');
            }

            // 搜索提示单独写入历史，服务器搜索工具不进入前端执行链。
            if (
              typeof data.searchText === 'string' &&
              data.searchText.trim()
            ) {
              apiHistoryRef.current.push({
                role: 'assistant',
                content: data.searchText,
              });

              addTextMessage('assistant', data.searchText);
            }

            apiHistoryRef.current.push(data.assistantMessage);

            // 兼容后端返回的服务器工具结果。
            if (data.serverToolMessages !== undefined) {
              if (!Array.isArray(data.serverToolMessages)) {
                throw new Error('服务器工具结果格式无效');
              }

              for (const message of data.serverToolMessages) {
                if (
                  !isHistoryMessage(message) ||
                  message.role !== 'tool'
                ) {
                  throw new Error('服务器工具结果内容无效');
                }

                apiHistoryRef.current.push(message);
              }
            }

            for (const call of uiCalls) {
              if (controller.signal.aborted) break;

              const result = await executeUiTool(call);

              apiHistoryRef.current.push({
                role: 'tool',
                tool_call_id: call.id,
                content: result,
              });
            }

            if (controller.signal.aborted) break;

            continue;
          }

          throw new Error('服务器返回了未知响应类型');
        }

        if (!completed && !controller.signal.aborted) {
          addTextMessage(
            'assistant',
            '本次任务的工具调用次数已达到上限，请简化需求后重试。',
          );
        }
      } catch (error: unknown) {
        const aborted =
          controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError');

        if (aborted) {
          addTextMessage('assistant', '已取消本次请求。');
        } else {
          const message =
            error instanceof Error ? error.message : '未知错误';

          addTextMessage('assistant', `请求异常：${message}`);
        }

        // 只回退当前用户轮次之后的未完成数据，保留此前完整对话。
        let lastUserIndex = apiHistoryRef.current.length - 1;

        while (
          lastUserIndex >= 0 &&
          apiHistoryRef.current[lastUserIndex].role !== 'user'
        ) {
          lastUserIndex--;
        }

        if (lastUserIndex >= 0) {
          apiHistoryRef.current = apiHistoryRef.current.slice(
            0,
            lastUserIndex + 1,
          );
        }
      } finally {
        apiHistoryRef.current = compactHistory(apiHistoryRef.current);

        setBusy(false);
        sendLock.current = false;

        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [
      input,
      addTextMessage,
      addMovieList,
      executeUiTool,
    ],
  );

  const handlePointerDown = (
    event: React.MouseEvent | React.TouchEvent,
  ) => {
    if (active) return;

    isDragging.current = false;

    const clientX =
      'touches' in event
        ? event.touches[0].clientX
        : event.clientX;

    const clientY =
      'touches' in event
        ? event.touches[0].clientY
        : event.clientY;

    dragStart.current = {
      x: clientX,
      y: clientY,
      ballX: pos.x,
      ballY: pos.y,
    };

    const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
      const mx =
        'touches' in moveEvent
          ? moveEvent.touches[0]?.clientX
          : moveEvent.clientX;

      const my =
        'touches' in moveEvent
          ? moveEvent.touches[0]?.clientY
          : moveEvent.clientY;

      if (typeof mx !== 'number' || typeof my !== 'number') return;

      const dx = mx - dragStart.current.x;
      const dy = my - dragStart.current.y;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        isDragging.current = true;
      }

      const newX = Math.min(
        Math.max(0, dragStart.current.ballX - dx),
        Math.max(0, window.innerWidth - 90),
      );

      const newY = Math.min(
        Math.max(0, dragStart.current.ballY - dy),
        Math.max(0, window.innerHeight - 60),
      );

      setPos({
        x: newX,
        y: newY,
      });
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove, {
      passive: true,
    });
    window.addEventListener('touchend', handleUp);
  };

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/20 backdrop-blur-sm transition-opacity ${
          active
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setActive(false)}
      />

      <div
        className="fixed z-50"
        style={{
          bottom: `${pos.y}px`,
          right: `${pos.x}px`,
        }}
      >
        {!active && (
          <button
            onMouseDown={handlePointerDown}
            onTouchStart={handlePointerDown}
            onClick={() => {
              if (!isDragging.current) setActive(true);
            }}
            className="w-[84px] h-[50px] rounded-full shadow-2xl flex items-center justify-center overflow-hidden"
            style={{
              background:
                'linear-gradient(180deg, #050505 0%, #1a1a1a 35%, #d9d9d9 52%, #ffffff 100%)',
            }}
          >
            <span className="text-black/40 text-2xl relative z-10">
              ✦
            </span>
          </button>
        )}

        {active && (
          <div className="w-[350px] h-[500px] rounded-[32px] flex flex-col shadow-2xl bg-[rgba(20,20,25,0.85)] backdrop-blur-xl border border-white/15">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <span className="text-white/90 text-sm font-semibold">
                ✦ Friday AI
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setVoiceEnabled(value => !value)}
                  className="p-1.5 text-white/70"
                  aria-label="切换语音播报"
                >
                  {voiceEnabled ? '🔊' : '🔇'}
                </button>

                {busy && (
                  <button
                    onClick={stopRequest}
                    className="text-xs text-red-400"
                  >
                    取消
                  </button>
                )}

                <button
                  onClick={() => setActive(false)}
                  className="text-white/70"
                  aria-label="关闭 Friday"
                >
                  ✕
                </button>
              </div>
            </div>

            <div
              className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
              ref={listRef}
            >
              {messages.map(message => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === 'user'
                      ? 'justify-end'
                      : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                      message.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white/5 text-white'
                    }`}
                  >
                    {message.type === 'text' && message.content}

                    {message.type === 'movie_list' && (
                      <div className="grid grid-cols-2 gap-3 mt-2">
                        {message.items?.map((item, index) => (
                          <button
                            type="button"
                            key={`${item.sourceKey}-${item.vodId}-${index}`}
                            onClick={() => openNativeDetail(item)}
                            className="bg-[#1c1c1e] rounded-xl overflow-hidden cursor-pointer text-left"
                          >
                            <div className="aspect-[2/3] w-full bg-[#2a2a2c] relative flex flex-col items-center justify-center">
                              <span className="text-white/20 text-3xl mb-1">
                                🎬
                              </span>

                              <span className="text-[10px] text-white/20">
                                暂无海报
                              </span>

                              {item.pic && (
                                <img
                                  src={item.pic}
                                  alt={item.name}
                                  referrerPolicy="no-referrer"
                                  className="absolute inset-0 w-full h-full object-cover z-10"
                                  onError={event => {
                                    event.currentTarget.style.display = 'none';
                                  }}
                                />
                              )}
                            </div>

                            <div className="p-2 text-[13px] font-bold text-white truncate">
                              {item.name}
                            </div>
                          </button>
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
              <button
                onClick={listening ? stopRequest : startVoice}
                disabled={busy}
                className={`w-8 h-8 rounded-full text-white ${
                  listening ? 'bg-red-600' : 'bg-white/10'
                } disabled:opacity-40`}
                aria-label="语音输入"
              >
                🎙
              </button>

              <input
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    send();
                  }
                }}
                placeholder="找电影…"
                disabled={busy}
                className="flex-1 min-w-0 bg-transparent text-white outline-none px-2 disabled:opacity-50"
              />

              <button
                onClick={() => send()}
                disabled={busy || !input.trim()}
                className="bg-blue-600 rounded-full w-8 h-8 text-white disabled:opacity-40"
                aria-label="发送"
              >
                ↑
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
