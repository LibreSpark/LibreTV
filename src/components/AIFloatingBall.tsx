
'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useRouter } from 'next/navigation';
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

const MAX_HISTORY = 24;
const MAX_TOOL_ROUNDS = 5;

const ALLOWED_RATES = [
  0.5,
  0.75,
  1,
  1.25,
  1.5,
  1.75,
  2,
  3,
  4,
];

const uid = () =>
  Math.random().toString(36).slice(2) +
  Date.now().toString(36);

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isSearchResultItem(
  value: unknown
): value is SearchResultItem {
  if (!isRecord(value)) return false;

  return (
    typeof value.sourceKey === 'string' &&
    value.sourceKey.length > 0 &&
    typeof value.sourceName === 'string' &&
    value.sourceName.length > 0 &&
    typeof value.vodId === 'string' &&
    /^[a-zA-Z0-9_-]{1,30}$/.test(value.vodId) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (
      value.pic === undefined ||
      typeof value.pic === 'string'
    ) &&
    (
      value.sourceUrl === undefined ||
      typeof value.sourceUrl === 'string'
    )
  );
}

function isSafeInternalPath(path: unknown): path is string {
  if (
    typeof path !== 'string' ||
    path.length > 200 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    /[\u0000-\u001f]/.test(path)
  ) {
    return false;
  }

  if (path === '/' || path === '/search') {
    return true;
  }

  if (path.startsWith('/search?')) {
    return true;
  }

  return /^\/detail\/[a-zA-Z0-9_-]{1,30}$/.test(path);
}

function compactHistory(
  history: HistoryMessage[]
): HistoryMessage[] {
  if (history.length <= MAX_HISTORY) {
    return history;
  }

  let lastUserIndex = -1;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  if (lastUserIndex >= 0) {
    return history.slice(lastUserIndex);
  }

  return history.slice(-MAX_HISTORY);
}

export default function AIFloatingBall() {
  const router = useRouter();

  const [active, setActive] = useState(false);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const [pos, setPos] = useState({
    x: 24,
    y: 24,
  });

  const isDragging = useRef(false);

  const dragStart = useRef({
    x: 0,
    y: 0,
    ballX: 0,
    ballY: 0,
  });

  const listRef = useRef<HTMLDivElement | null>(null);
  const sendLock = useRef(false);

  const abortRef = useRef<AbortController | null>(
    null
  );

  const apiHistoryRef = useRef<HistoryMessage[]>([]);

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
    };
  }, []);

  const addTextMessage = useCallback(
    (
      role: 'user' | 'assistant',
      content: string
    ) => {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role,
          type: 'text',
          content,
        },
      ]);
    },
    []
  );

  const addMovieList = useCallback(
    (items: SearchResultItem[]) => {
      if (!Array.isArray(items) || items.length === 0) {
        return;
      }

      const safeItems = items.filter(isSearchResultItem);

      if (safeItems.length === 0) {
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'assistant',
          type: 'movie_list',
          content: '为你找到以下资源：',
          items: safeItems,
        },
      ]);
    },
    []
  );

  // 修复：sourceUrl 改为可选，由 page.tsx 负责数据源兜底。
  const openNativeDetail = useCallback(
    (item: SearchResultItem) => {
      if (!isSearchResultItem(item)) {
        addTextMessage(
          'assistant',
          '影片资源信息不完整，无法打开详情。'
        );
        return;
      }

      window.dispatchEvent(
        new CustomEvent('friday-open-detail', {
          detail: {
            sourceKey: item.sourceKey,
            sourceName: item.sourceName,
            ...(item.sourceUrl
              ? { sourceUrl: item.sourceUrl }
              : {}),
            vodId: item.vodId,
            name: item.name,
            pic: item.pic,
            typeName: item.typeName,
            year: item.year,
            area: item.area,
            remarks: item.remarks,
            isAdult: item.isAdult,
          },
        })
      );
    },
    [addTextMessage]
  );

  const executeUiTool = useCallback(
    async (tc: ToolCall): Promise<string> => {
      try {
        if (
          !tc ||
          !tc.function ||
          typeof tc.function.name !== 'string' ||
          typeof tc.function.arguments !== 'string'
        ) {
          return '工具调用格式错误';
        }

        let args: unknown;

        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          return '工具参数 JSON 格式错误';
        }

        if (!isRecord(args)) {
          return '工具参数必须是对象';
        }

        if (tc.function.name === 'control_player') {
          const video = document.getElementById(
            'libretv-main-video'
          ) as HTMLVideoElement | null;

          if (!video) {
            return '播放器不存在';
          }

          const action = args.action;

          if (action === 'play') {
            try {
              await video.play();
              return '播放成功';
            } catch {
              return '播放失败：浏览器可能阻止了自动播放';
            }
          }

          if (action === 'pause') {
            try {
              video.pause();

              return video.paused
                ? '暂停成功'
                : '暂停操作未生效';
            } catch {
              return '暂停失败';
            }
          }

          if (action === 'seek_to') {
            const time = args.time;

            if (
              typeof time !== 'number' ||
              !Number.isFinite(time) ||
              time < 0
            ) {
              return '跳转时间参数无效';
            }

            if (
              Number.isFinite(video.duration) &&
              video.duration > 0 &&
              time > video.duration
            ) {
              return `跳转失败：视频总时长只有 ${video.duration} 秒`;
            }

            try {
              video.currentTime = time;

              return `已设置跳转位置为 ${time} 秒`;
            } catch {
              return '播放器不允许执行该跳转';
            }
          }

          if (action === 'set_rate') {
            const rate = args.rate;

            if (
              typeof rate !== 'number' ||
              !Number.isFinite(rate) ||
              !ALLOWED_RATES.includes(rate)
            ) {
              return '倍速参数无效';
            }

            try {
              video.playbackRate = rate;

              if (video.playbackRate !== rate) {
                return '播放器未能应用指定倍速';
              }

              return `已设置倍速为 ${rate} 倍`;
            } catch {
              return '倍速设置失败';
            }
          }

          return '未知播放器操作';
        }

        if (tc.function.name === 'page_control') {
          const action = args.action;

          if (action === 'navigate') {
            const path = args.path;

            if (!isSafeInternalPath(path)) {
              return '页面路径不在允许列表中';
            }

            try {
              router.push(path);

              return '已发起站内页面跳转，页面加载状态尚未确认';
            } catch {
              return '页面跳转请求失败';
            }
          }

          if (action === 'site_search') {
            const keyword = args.keyword;

            if (
              typeof keyword !== 'string' ||
              !keyword.trim() ||
              keyword.length > 50
            ) {
              return '站内搜索关键词无效';
            }

            try {
              router.push(
                `/search?wd=${encodeURIComponent(
                  keyword.trim()
                )}`
              );

              return '已发起站内搜索跳转';
            } catch {
              return '站内搜索跳转失败';
            }
          }

          if (action === 'toggle_theme') {
            try {
              document.documentElement.classList.toggle(
                'dark'
              );

              return '已切换页面主题样式';
            } catch {
              return '主题切换失败';
            }
          }

          return '未知页面操作';
        }

        return '不允许执行该工具';
      } catch (error) {
        return error instanceof Error
          ? `工具执行异常：${error.message}`
          : '工具执行异常';
      }
    },
    [router]
  );

  const stopRequest = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (overrideText?: string) => {
      if (sendLock.current) {
        return;
      }

      const text = (
        overrideText !== undefined
          ? overrideText
          : input
      ).trim();

      if (!text || text.length > 2000) {
        return;
      }

      sendLock.current = true;

      setInput('');
      setBusy(true);

      addTextMessage('user', text);

      apiHistoryRef.current.push({
        role: 'user',
        content: text,
      });

      const controller = new AbortController();

      abortRef.current = controller;

      let finished = false;

      try {
        for (
          let step = 0;
          step < MAX_TOOL_ROUNDS;
          step++
        ) {
          if (controller.signal.aborted) {
            break;
          }

          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messages: apiHistoryRef.current,
            }),
            signal: controller.signal,
          });

          let data: Record<string, unknown>;

          try {
            data = await response.json();
          } catch {
            throw new Error('服务器返回的数据不是有效 JSON');
          }

          if (!response.ok) {
            throw new Error(
              typeof data.error === 'string'
                ? data.error
                : `请求失败：HTTP ${response.status}`
            );
          }

          if (controller.signal.aborted) {
            break;
          }

          if (
            Array.isArray(data.movieData) &&
            data.movieData.length > 0
          ) {
            addMovieList(
              data.movieData.filter(isSearchResultItem)
            );
          }

          if (data.type === 'final') {
            const finalText =
              typeof data.text === 'string'
                ? data.text
                : '';

            if (finalText) {
              apiHistoryRef.current.push({
                role: 'assistant',
                content: finalText,
              });

              addTextMessage(
                'assistant',
                finalText
              );
            }

            finished = true;
            break;
          }

          if (data.type === 'tool_calls') {
            const assistantMessage =
              data.assistantMessage;

            const serverToolMessages =
              data.toolMessages;

            const uiToolCalls =
              data.uiToolCalls;

            if (
              !isRecord(assistantMessage) ||
              assistantMessage.role !== 'assistant' ||
              !Array.isArray(assistantMessage.tool_calls)
            ) {
              throw new Error('工具调用消息格式错误');
            }

            if (!Array.isArray(serverToolMessages)) {
              throw new Error('服务器工具结果格式错误');
            }

            if (!Array.isArray(uiToolCalls)) {
              throw new Error('前端工具调用格式错误');
            }

            apiHistoryRef.current.push(
              assistantMessage as HistoryMessage
            );

            const expectedIds = new Set(
              (
                assistantMessage.tool_calls as ToolCall[]
              ).map((tc) => tc.id)
            );

            const receivedIds = new Set<string>();

            for (const rawMessage of serverToolMessages) {
              if (
                !isRecord(rawMessage) ||
                rawMessage.role !== 'tool' ||
                typeof rawMessage.tool_call_id !== 'string' ||
                typeof rawMessage.content !== 'string' ||
                !expectedIds.has(rawMessage.tool_call_id) ||
                receivedIds.has(rawMessage.tool_call_id)
              ) {
                throw new Error('服务器工具结果与调用 ID 不匹配');
              }

              receivedIds.add(rawMessage.tool_call_id);

              apiHistoryRef.current.push(
                rawMessage as HistoryMessage
              );
            }

            for (const rawCall of uiToolCalls) {
              if (controller.signal.aborted) {
                break;
              }

              if (
                !isRecord(rawCall) ||
                typeof rawCall.id !== 'string' ||
                !expectedIds.has(rawCall.id) ||
                receivedIds.has(rawCall.id) ||
                !isRecord(rawCall.function) ||
                typeof rawCall.function.name !== 'string' ||
                typeof rawCall.function.arguments !== 'string'
              ) {
                throw new Error('前端工具调用结构错误');
              }

              const result = await executeUiTool(
                rawCall as unknown as ToolCall
              );

              receivedIds.add(rawCall.id);

              apiHistoryRef.current.push({
                role: 'tool',
                tool_call_id: rawCall.id,
                content: result,
              });
            }

            if (controller.signal.aborted) {
              break;
            }

            if (receivedIds.size !== expectedIds.size) {
              throw new Error('存在未完成的工具调用');
            }

            continue;
          }

          throw new Error('服务器返回了未知响应类型');
        }

        if (!finished && !controller.signal.aborted) {
          addTextMessage(
            'assistant',
            '本次工具调用已达到最大执行轮数，请简化操作后重试。'
          );
        }

        apiHistoryRef.current = compactHistory(
          apiHistoryRef.current
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === 'AbortError'
        ) {
          addTextMessage(
            'assistant',
            '已取消本次请求。'
          );
        } else {
          addTextMessage(
            'assistant',
            `请求异常：${
              error instanceof Error
                ? error.message
                : '未知错误'
            }`
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }

        setBusy(false);
        sendLock.current = false;
      }
    },
    [
      input,
      addTextMessage,
      addMovieList,
      executeUiTool,
    ]
  );

  const handlePointerDown = (
    e: React.MouseEvent<HTMLButtonElement> |
      React.TouchEvent<HTMLButtonElement>
  ) => {
    if (active) return;

    isDragging.current = false;

    const cx =
      'touches' in e
        ? e.touches[0].clientX
        : e.clientX;

    const cy =
      'touches' in e
        ? e.touches[0].clientY
        : e.clientY;

    dragStart.current = {
      x: cx,
      y: cy,
      ballX: pos.x,
      ballY: pos.y,
    };

    const handleMove = (
      event: MouseEvent | TouchEvent
    ) => {
      const mx =
        'touches' in event
          ? event.touches[0]?.clientX
          : event.clientX;

      const my =
        'touches' in event
          ? event.touches[0]?.clientY
          : event.clientY;

      if (
        typeof mx !== 'number' ||
        typeof my !== 'number'
      ) {
        return;
      }

      const dx = dragStart.current.x - mx;
      const dy = dragStart.current.y - my;

      if (
        Math.abs(dx) > 5 ||
        Math.abs(dy) > 5
      ) {
        isDragging.current = true;
      }

      const newX = Math.min(
        Math.max(
          0,
          dragStart.current.ballX + dx
        ),
        window.innerWidth - 90
      );

      const newY = Math.min(
        Math.max(
          0,
          dragStart.current.ballY + dy
        ),
        window.innerHeight - 60
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
        className={`fixed inset-0 z-40 bg-black/20 backdrop-blur-sm transition-opacity duration-500 ${
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
              if (!isDragging.current) {
                setActive(true);
              }
            }}
            className="w-[84px] h-[50px] rounded-full shadow-2xl flex items-center justify-center overflow-hidden relative group hover:scale-105 transition-transform duration-300"
            style={{
              background:
                'linear-gradient(180deg, #050505 0%, #1a1a1a 35%, #d9d9d9 52%, #ffffff 100%)',
              boxShadow:
                '0 10px 25px rgba(0,0,0,0.15), inset 0 -2px 5px rgba(255,255,255,0.8)',
            }}
          >
            <div
              className="absolute top-1/2 left-[5%] w-[90%] h-[12px] -translate-y-1/2 blur-[2px] rounded-full pointer-events-none"
              style={{
                background:
                  'radial-gradient(ellipse at center, rgba(255,255,255,1) 0%, rgba(200,220,255,0.8) 30%, rgba(255,255,255,0) 70%)',
              }}
            />

            <span className="text-black/40 text-2xl relative z-10 drop-shadow-md">
              ✦
            </span>
          </button>
        )}

        {active && (
          <div
            className="w-[350px] h-[500px] max-h-[80vh] rounded-[32px] overflow-hidden flex flex-col shadow-2xl animate-fadeIn"
            style={{
              background: 'rgba(20, 20, 25, 0.7)',
              backdropFilter: 'blur(30px)',
              WebkitBackdropFilter: 'blur(30px)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
            }}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <span className="text-white/90 text-sm font-semibold tracking-wide">
                ✦ Friday AI 2.1
              </span>

              <div className="flex items-center gap-2">
                {busy && (
                  <button
                    onClick={stopRequest}
                    className="px-3 py-1 rounded-full bg-red-500/20 text-red-300 text-xs hover:bg-red-500/30"
                  >
                    取消
                  </button>
                )}

                <button
                  onClick={() => setActive(false)}
                  className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/70 hover:bg-white/20 transition"
                >
                  ✕
                </button>
              </div>
            </div>

            <div
              className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-hide"
              ref={listRef}
            >
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center text-white/50 space-y-4">
                  <p className="text-sm">
                    需要我帮你找点什么？
                  </p>

                  <div className="flex flex-wrap gap-2 justify-center">
                    {[
                      '我想看蜘蛛侠',
                      '暂停播放',
                      '最近有什么好看的',
                    ].map((item) => (
                      <button
                        key={item}
                        onClick={() => send(item)}
                        className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition text-xs text-white/80"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${
                    message.role === 'user'
                      ? 'justify-end'
                      : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      message.role === 'user'
                        ? 'bg-blue-600/80 text-white rounded-br-sm shadow-md'
                        : 'bg-white/5 text-white/90 border border-white/5 rounded-bl-sm'
                    }`}
                  >
                    {message.type === 'text' && (
                      <span className="whitespace-pre-wrap break-words">
                        {message.content}
                      </span>
                    )}

                    {message.type === 'movie_list' && (
                      <div className="flex flex-col gap-3">
                        <div>{message.content}</div>

                        <div className="grid grid-cols-2 gap-3">
                          {message.items?.map((item, index) => (
                            <button
                              type="button"
                              key={`${item.sourceKey}-${item.vodId}-${index}`}
                              onClick={() => openNativeDetail(item)}
                              className="group relative flex flex-col bg-[#1c1c1e] rounded-xl overflow-hidden border border-white/5 hover:border-white/20 cursor-pointer transition text-left"
                            >
                              <div className="aspect-[2/3] w-full relative overflow-hidden flex flex-col items-center justify-center bg-gradient-to-br from-[#34343a] via-[#24242b] to-[#15151b]">
                                <span className="text-white/25 text-4xl mb-2">
                                  🎬
                                </span>
                                <span className="text-white/40 text-xs">
                                  暂无海报
                                </span>

                                {item.pic?.trim() && (
                                  <img
                                    src={item.pic}
                                    alt={item.name}
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    className="absolute inset-0 z-10 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                    onError={(event) => {
                                      event.currentTarget.style.display = 'none';
                                    }}
                                  />
                                )}
                              </div>

                              <div className="p-2.5 flex flex-col gap-1">
                                <span className="text-[13px] font-bold text-white/90 truncate">
                                  {item.name}
                                </span>

                                <span className="text-[11px] text-white/40 truncate">
                                  {item.year || '年份未知'}
                                  {item.remarks ? ` · ${item.remarks}` : ''}
                                </span>

                                <span className="text-[10px] text-white/30 truncate">
                                  {item.sourceName}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
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

            <div className="p-3 bg-white/5 border-t border-white/10 flex items-center gap-2">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey
                  ) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="输入电影名或操作指令…"
                disabled={busy}
                maxLength={2000}
                className="flex-1 bg-transparent text-sm text-white outline-none placeholder-white/30 px-2"
              />

              <button
                onClick={() => send()}
                disabled={!input.trim() || busy}
                className="w-8 h-8 rounded-full bg-blue-600 disabled:opacity-30 text-white flex items-center justify-center hover:bg-blue-500 transition"
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
