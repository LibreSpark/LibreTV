"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

import {
  useAppStore,
  resolveSource,
  isSourceDisabled,
  isInDisabledSubscription,
} from "@/lib/store";

type SourceConfig = {
  key: string;
  name: string;
  url: string;
  detail?: string;
  isAdult?: boolean;
  [key: string]: unknown;
};

type MovieItem = {
  sourceKey?: string;
  sourceName?: string;
  vodId?: string | number;
  name?: string;
  pic?: string;
  typeName?: string;
  year?: string | number;
  area?: string;
  remarks?: string;
  sourceUrl?: string;
  isAdult?: boolean;
};

type MovieData = {
  searchId: string;
  keyword: string;
  total?: number;
  totalFound?: number;
  returnedCount?: number;
  outcomes?: Array<{
    sourceKey: string;
    ok: boolean;
    list: MovieItem[];
    error?: string;
    timedOut?: boolean;
    ms?: number;
  }>;
  results: MovieItem[];
  createdAt?: number;
};

type FridayProps = {
  /**
   * 显式传入 sources 时，以传入值为准。
   * 不传时，自动从 Store 的 selectedKeys 获取已启用来源。
   */
  sources?: SourceConfig[];
  /**
   * 显式传入时，以传入值为准。
   * 不传时，自动同步 Store 的 yellowFilter。
   */
  filterAdult?: boolean;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
};

type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: SpeechRecognitionEventLike) => void)
    | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const MAX_INPUT_LENGTH = 1000;
const MAX_MOVIE_CARDS = 60;
const FAB_SIZE = 62;
const DRAG_THRESHOLD = 6;

function getPartText(message: any): string {
  if (!message || !Array.isArray(message.parts)) {
    return "";
  }

  return message.parts
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text || ""))
    .join("");
}

function getMovieDataParts(messages: any[]): MovieData[] {
  const output: MovieData[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray(message.parts)
    ) {
      continue;
    }

    for (const part of message.parts) {
      if (part?.type !== "data-movies") {
        continue;
      }

      const data = part.data as MovieData | undefined;

      if (
        !data ||
        typeof data.searchId !== "string" ||
        !Array.isArray(data.results)
      ) {
        continue;
      }

      if (seen.has(data.searchId)) {
        continue;
      }

      seen.add(data.searchId);

      output.push({
        ...data,
        results: data.results
          .filter(
            (item): item is MovieItem =>
              Boolean(item) && typeof item === "object",
          )
          .slice(0, MAX_MOVIE_CARDS),
      });
    }
  }

  return output;
}

function cancelBrowserSpeech(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.speechSynthesis?.cancel();
  } catch {
    // iOS Safari 某些状态下 cancel 可能抛错。
  }
}

function MovieCards({
  data,
  onOpen,
}: {
  data: MovieData;
  onOpen: (movie: MovieItem) => void;
}) {
  const total =
    data.totalFound ??
    data.total ??
    data.results.length;

  if (!data.results.length) {
    return (
      <div className="friday-empty-result">
        没有找到相关影片，可以换个关键词试试。
      </div>
    );
  }

  return (
    <div className="friday-movie-section">
      <div className="friday-result-heading">
        <span>搜索结果 · {data.keyword}</span>
        <span className="friday-result-count">
          {total} 条
        </span>
      </div>

      <div className="friday-movie-grid">
        {data.results.map((movie, index) => {
          const key = [
            movie.sourceKey || "",
            movie.vodId || "",
            movie.name || "",
            index,
          ].join("-");

          return (
            <button
              type="button"
              key={key}
              className="friday-movie-card"
              onClick={() => onOpen(movie)}
            >
              <div className="friday-poster">
                {movie.pic ? (
                  <img
                    src={movie.pic}
                    alt={movie.name || "影片海报"}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}

                <div className="friday-poster-fallback">
                  <span>▶</span>
                </div>

                {movie.remarks ? (
                  <span className="friday-poster-remark">
                    {movie.remarks}
                  </span>
                ) : null}
              </div>

              <div className="friday-movie-info">
                <div className="friday-movie-name">
                  {movie.name || "未命名影片"}
                </div>

                <div className="friday-movie-meta">
                  {[movie.year, movie.typeName, movie.area]
                    .filter(Boolean)
                    .join(" · ") || "影视资源"}
                </div>

                <div className="friday-movie-source">
                  {movie.sourceName ||
                    movie.sourceKey ||
                    "未知来源"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function AIFloatingBall({
  sources,
  filterAdult,
}: FridayProps) {
  const appStore = useAppStore();

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fabPosition, setFabPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const recognitionRef =
    useRef<SpeechRecognitionLike | null>(null);

  const utteranceRef =
    useRef<SpeechSynthesisUtterance | null>(null);

  const voiceTextRef = useRef("");
  const lastSpokenMessageRef = useRef("");
  const panelRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const dragResetTimerRef = useRef<number | null>(null);

  /**
   * 从 Store 中获取真正启用的来源。
   * selectedKeys 是用户当前启用的来源 key。
   * 同时排除健康状态停用和订阅停用的来源。
   */
  const storeSources = useMemo<SourceConfig[]>(() => {
    const selectedKeys = Array.isArray(appStore.selectedKeys)
      ? appStore.selectedKeys
      : [];

    const result: SourceConfig[] = [];

    for (const key of selectedKeys) {
      if (!key) {
        continue;
      }

      if (isSourceDisabled(appStore, key)) {
        continue;
      }

      if (isInDisabledSubscription(appStore, key)) {
        continue;
      }

      const source = resolveSource(appStore, key);

      if (!source) {
        continue;
      }

      result.push(source as SourceConfig);
    }

    return result;
  }, [
    appStore.selectedKeys,
    appStore.customAPIs,
    appStore.envSources,
    appStore.sourceHealth,
    appStore.subscriptions,
  ]);

  /**
   * 父组件显式传入 sources 时优先使用传入值；
   * 否则使用 Store 中筛选后的真实来源。
   */
  const activeSources = sources ?? storeSources;

  /**
   * 成人内容过滤默认跟随 Store 的 yellowFilter。
   */
  const activeFilterAdult =
    filterAdult ?? Boolean(appStore.yellowFilter);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: {
          sources: activeSources,
          filterAdult: activeFilterAdult,
        },
      }),
    [activeSources, activeFilterAdult],
  );

  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
  } = useChat({
    transport,
    onError: (chatError) => {
      console.error("[Friday] Chat error:", chatError);
    },
  });

  const busy =
    status === "submitted" ||
    status === "streaming";

  const movieData = useMemo(
    () => getMovieDataParts(messages as any[]),
    [messages],
  );

  const stopSpeech = useCallback(() => {
    utteranceRef.current = null;
    cancelBrowserSpeech();
    setSpeaking(false);
  }, []);

  const stopAllVoice = useCallback(() => {
    const recognition = recognitionRef.current;

    recognitionRef.current = null;

    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // 忽略 iOS Safari abort 异常。
      }
    }

    voiceTextRef.current = "";
    setListening(false);

    utteranceRef.current = null;
    cancelBrowserSpeech();
    setSpeaking(false);
  }, []);

  const openPanel = useCallback(() => {
    setOpen(true);

    if (typeof document !== "undefined") {
      document.body.classList.add("friday-popup-lock");
    }
  }, []);

  const closePanel = useCallback(() => {
    stopAllVoice();
    setOpen(false);
    setExpanded(false);

    if (typeof document !== "undefined") {
      document.body.classList.remove("friday-popup-lock");
    }
  }, [stopAllVoice]);

  const interrupt = useCallback(() => {
    stopAllVoice();

    if (busy) {
      stop();
    }
  }, [busy, stop, stopAllVoice]);

  const handleSend = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();

      if (!content || busy) {
        return;
      }

      if (content.length > MAX_INPUT_LENGTH) {
        return;
      }

      stopAllVoice();
      setInput("");

      try {
        await sendMessage({
          text: content,
        });
      } catch (sendError) {
        console.error("[Friday] Send failed:", sendError);
      }
    },
    [input, busy, sendMessage, stopAllVoice],
  );

  const handleOpenMovie = useCallback(
    (movie: MovieItem) => {
      if (typeof window === "undefined") {
        return;
      }

      stopAllVoice();

      window.dispatchEvent(
        new CustomEvent("friday-open-detail", {
          detail: movie,
        }),
      );
    },
    [stopAllVoice],
  );

  const startListening = useCallback(() => {
    if (busy || listening) {
      return;
    }

    const SpeechRecognitionClass =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      window.alert(
        "当前浏览器暂不支持语音识别，请使用键盘输入。",
      );
      return;
    }

    stopSpeech();

    const previousRecognition = recognitionRef.current;
    recognitionRef.current = null;

    if (previousRecognition) {
      try {
        previousRecognition.abort();
      } catch {
        // ignore
      }
    }

    voiceTextRef.current = "";

    const recognition = new SpeechRecognitionClass();

    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) {
        return;
      }

      setListening(true);
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) {
        return;
      }

      let finalText = "";
      let interimText = "";

      for (
        let index = 0;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const transcript =
          result?.[0]?.transcript || "";

        if (result.isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      const recognizedText = finalText || interimText;

      voiceTextRef.current = recognizedText;

      setInput(
        recognizedText.slice(0, MAX_INPUT_LENGTH),
      );
    };

    recognition.onerror = () => {
      if (recognitionRef.current !== recognition) {
        return;
      }

      recognitionRef.current = null;
      setListening(false);
    };

    recognition.onend = () => {
      /**
       * 关键保护：
       * 旧识别实例结束时，不允许清空新识别实例。
       */
      if (recognitionRef.current !== recognition) {
        return;
      }

      recognitionRef.current = null;
      setListening(false);
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (recognitionError) {
      console.error(
        "[Friday] Speech recognition start failed:",
        recognitionError,
      );

      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }

      setListening(false);
    }
  }, [busy, listening, stopSpeech]);

  const speakText = useCallback(
    (text: string, messageId: string) => {
      if (!voiceEnabled || !text.trim()) {
        return;
      }

      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
      ) {
        return;
      }

      stopSpeech();

      const utterance = new SpeechSynthesisUtterance(text);

      utterance.lang = "zh-CN";
      utterance.rate = 1;
      utterance.pitch = 1;

      utterance.onstart = () => {
        if (utteranceRef.current !== utterance) {
          return;
        }

        setSpeaking(true);
      };

      utterance.onend = () => {
        if (utteranceRef.current !== utterance) {
          return;
        }

        utteranceRef.current = null;
        setSpeaking(false);
      };

      utterance.onerror = () => {
        if (utteranceRef.current !== utterance) {
          return;
        }

        utteranceRef.current = null;
        setSpeaking(false);
      };

      lastSpokenMessageRef.current = messageId;
      utteranceRef.current = utterance;

      try {
        window.speechSynthesis.speak(utterance);
      } catch (speechError) {
        console.error(
          "[Friday] Speech synthesis failed:",
          speechError,
        );

        if (utteranceRef.current === utterance) {
          utteranceRef.current = null;
        }

        setSpeaking(false);
      }
    },
    [voiceEnabled, stopSpeech],
  );

  /**
   * 只在一轮回复结束后播报。
   * 不在流式 token 到达时重复朗读。
   */
  useEffect(() => {
    if (
      status !== "ready" ||
      !voiceEnabled ||
      !open
    ) {
      return;
    }

    const lastAssistant = [...(messages as any[])]
      .reverse()
      .find(
        (message) => message?.role === "assistant",
      );

    if (!lastAssistant?.id) {
      return;
    }

    if (
      lastSpokenMessageRef.current === lastAssistant.id
    ) {
      return;
    }

    const text = getPartText(lastAssistant);

    if (text.trim()) {
      speakText(text, lastAssistant.id);
    }
  }, [
    messages,
    status,
    voiceEnabled,
    open,
    speakText,
  ]);

  /**
   * 新消息、影片卡片或加载状态变化时滚动到底部。
   */
  useEffect(() => {
    if (!open) {
      return;
    }

    const container = messagesRef.current;

    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, movieData, busy, error, open]);

  useEffect(() => {
    setMounted(true);

    return () => {
      stopAllVoice();

      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
      }

      if (typeof document !== "undefined") {
        document.body.classList.remove(
          "friday-popup-lock",
        );
      }
    };
  }, [stopAllVoice]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener(
        "keydown",
        handleKeyDown,
      );
    };
  }, [open, closePanel]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 100);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  const clearConversation = useCallback(() => {
    interrupt();
    setMessages([]);
    lastSpokenMessageRef.current = "";
    setInput("");
  }, [interrupt, setMessages]);

  /**
   * 悬浮球拖拽。
   * 使用 Pointer Events，同时兼容触屏和鼠标。
   */
  const handleFabPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (open) {
        return;
      }

      const rect =
        event.currentTarget.getBoundingClientRect();

      dragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };

      try {
        event.currentTarget.setPointerCapture(
          event.pointerId,
        );
      } catch {
        // 部分浏览器可能不支持 pointer capture。
      }
    },
    [open],
  );

  const handleFabPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;

      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;

      if (
        !drag.moved &&
        Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD
      ) {
        return;
      }

      drag.moved = true;
      suppressClickRef.current = true;

      const maxLeft = Math.max(
        0,
        window.innerWidth - FAB_SIZE,
      );

      const maxTop = Math.max(
        0,
        window.innerHeight - FAB_SIZE,
      );

      const left = Math.min(
        maxLeft,
        Math.max(0, event.clientX - drag.offsetX),
      );

      const top = Math.min(
        maxTop,
        Math.max(0, event.clientY - drag.offsetY),
      );

      setFabPosition({ left, top });
    },
    [],
  );

  const handleFabPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;

      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }

      const wasMoved = drag.moved;

      dragRef.current = null;

      if (wasMoved) {
        suppressClickRef.current = true;

        if (dragResetTimerRef.current !== null) {
          window.clearTimeout(
            dragResetTimerRef.current,
          );
        }

        dragResetTimerRef.current =
          window.setTimeout(() => {
            suppressClickRef.current = false;
            dragResetTimerRef.current = null;
          }, 250);
      }
    },
    [],
  );

  const handleFabClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    openPanel();
  }, [openPanel]);

  if (!mounted) {
    return null;
  }

  const content = (
    <>
      <style jsx global>{`
        .friday-popup-lock {
          overflow: hidden !important;
        }

        .friday-root {
          position: fixed;
          z-index: 99999;
          right: 20px;
          bottom: max(22px, env(safe-area-inset-bottom));
          font-family:
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            "PingFang SC",
            "Microsoft YaHei",
            sans-serif;
        }

        /* 液态金属黑银悬浮球 */
        .friday-fab {
          position: relative;
          isolation: isolate;
          display: grid;
          place-items: center;
          width: 62px;
          height: 62px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.72);
          border-radius: 50%;
          color: #fff;
          cursor: grab;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          background:
            radial-gradient(
              circle at 27% 18%,
              rgba(255,255,255,.98) 0,
              rgba(255,255,255,.58) 7%,
              transparent 25%
            ),
            radial-gradient(
              ellipse at 72% 82%,
              rgba(90,90,100,.95) 0,
              transparent 44%
            ),
            linear-gradient(
              135deg,
              #f8fafc 0%,
              #858995 17%,
              #17191f 36%,
              #d9dce2 53%,
              #555965 70%,
              #08090d 100%
            );
          box-shadow:
            0 8px 28px rgba(0,0,0,.48),
            0 0 0 1px rgba(255,255,255,.12),
            inset 0 2px 4px rgba(255,255,255,.85),
            inset 0 -5px 10px rgba(0,0,0,.75),
            inset 3px 0 8px rgba(255,255,255,.22);
          font-size: 25px;
          font-weight: 900;
          text-shadow:
            0 1px 2px rgba(0,0,0,.85),
            0 0 12px rgba(255,255,255,.45);
          transition:
            transform .2s ease,
            box-shadow .2s ease,
            filter .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-fab::before {
          position: absolute;
          z-index: -1;
          inset: 5px;
          border: 1px solid rgba(255,255,255,.36);
          border-radius: 50%;
          background:
            linear-gradient(
              145deg,
              rgba(255,255,255,.28),
              transparent 42%,
              rgba(0,0,0,.35)
            );
          content: "";
          box-shadow:
            inset 0 1px 5px rgba(255,255,255,.48),
            inset 0 -3px 6px rgba(0,0,0,.45);
        }

        .friday-fab::after {
          position: absolute;
          z-index: -1;
          top: -45%;
          left: -65%;
          width: 65%;
          height: 190%;
          transform: rotate(35deg);
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255,255,255,.65),
            transparent
          );
          content: "";
          animation: friday-metal-shine 5s ease-in-out infinite;
        }

        .friday-fab:active {
          cursor: grabbing;
          transform: scale(.94);
          box-shadow:
            0 4px 15px rgba(0,0,0,.55),
            inset 0 3px 8px rgba(0,0,0,.55);
        }

        @keyframes friday-metal-shine {
          0%, 65% {
            left: -75%;
            opacity: 0;
          }
          72% {
            opacity: .9;
          }
          88%, 100% {
            left: 130%;
            opacity: 0;
          }
        }

        .friday-panel {
          position: fixed;
          right: 14px;
          bottom: calc(96px + env(safe-area-inset-bottom));
          display: flex;
          flex-direction: column;
          width: min(430px, calc(100vw - 28px));
          height: min(680px, calc(100dvh - 125px));
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 24px;
          color: #f8fafc;
          background:
            linear-gradient(
              145deg,
              rgba(31,32,43,.82),
              rgba(10,11,18,.78)
            );
          -webkit-backdrop-filter: blur(30px) saturate(155%);
          backdrop-filter: blur(30px) saturate(155%);
          box-shadow:
            0 25px 80px rgba(0,0,0,.62),
            inset 0 1px 0 rgba(255,255,255,.16),
            0 0 35px rgba(148,95,255,.1);
          animation: friday-in .2s ease-out;
        }

        .friday-panel.friday-expanded {
          right: 8px;
          bottom: 8px;
          width: calc(100vw - 16px);
          height: calc(100dvh - 16px);
          max-height: calc(100dvh - 16px);
          border-radius: 20px;
        }

        @keyframes friday-in {
          from {
            opacity: 0;
            transform: translateY(12px) scale(.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .friday-header {
          min-height: 66px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255,255,255,.1);
          background:
            linear-gradient(
              110deg,
              rgba(47,34,65,.78),
              rgba(22,25,43,.76)
            );
          -webkit-backdrop-filter: blur(30px);
          backdrop-filter: blur(30px);
        }

        .friday-brand {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .friday-avatar {
          width: 40px;
          height: 40px;
          flex: 0 0 40px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(255,255,255,.3);
          border-radius: 14px;
          background:
            radial-gradient(
              circle at 28% 20%,
              #fff,
              transparent 30%
            ),
            linear-gradient(
              140deg,
              #d9dce2,
              #555965 40%,
              #11131a 72%,
              #aeb3bd
            );
          color: white;
          font-weight: 900;
          text-shadow: 0 2px 5px #000;
          box-shadow:
            0 4px 16px rgba(0,0,0,.35),
            inset 0 1px 2px rgba(255,255,255,.7);
        }

        .friday-brand-name {
          font-size: 15px;
          font-weight: 800;
          letter-spacing: .3px;
        }

        .friday-brand-sub {
          margin-top: 3px;
          color: #b8b4c9;
          font-size: 11px;
        }

        .friday-header-actions {
          display: flex;
          gap: 7px;
        }

        .friday-icon-btn {
          width: 35px;
          height: 35px;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 11px;
          background: rgba(255,255,255,.09);
          color: #eee;
          cursor: pointer;
          font-size: 16px;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-icon-btn:active {
          background: rgba(255,255,255,.2);
        }

        .friday-messages {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 16px 13px 20px;
          scroll-behavior: smooth;
          -webkit-overflow-scrolling: touch;
        }

        .friday-welcome {
          padding: 25px 15px;
          text-align: center;
          color: #d6d3e2;
        }

        .friday-welcome-icon {
          width: 58px;
          height: 58px;
          display: grid;
          place-items: center;
          margin: 0 auto 14px;
          border: 1px solid rgba(255,255,255,.3);
          border-radius: 19px;
          background:
            radial-gradient(
              circle at 25% 20%,
              #fff,
              transparent 28%
            ),
            linear-gradient(
              135deg,
              #d9dce2,
              #555965 45%,
              #11131a 75%,
              #aeb3bd
            );
          color: white;
          font-size: 25px;
          font-weight: 900;
          text-shadow: 0 2px 5px #000;
          box-shadow: 0 8px 25px rgba(0,0,0,.35);
        }

        .friday-welcome-title {
          margin-bottom: 8px;
          color: white;
          font-size: 18px;
          font-weight: 800;
        }

        .friday-welcome-text {
          color: #aaa8ba;
          font-size: 13px;
          line-height: 1.8;
        }

        .friday-message {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          margin: 0 0 15px;
        }

        .friday-message-user {
          flex-direction: row-reverse;
        }

        .friday-message-avatar {
          width: 29px;
          height: 29px;
          flex: 0 0 29px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 10px;
          background: rgba(255,255,255,.1);
          color: #e9d5ff;
          font-size: 12px;
          font-weight: 800;
        }

        .friday-message-user .friday-message-avatar {
          background: rgba(120,85,190,.55);
          color: white;
        }

        .friday-bubble {
          max-width: calc(100% - 38px);
          padding: 10px 12px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 14px;
          background: rgba(35,35,49,.78);
          color: #eceaf4;
          font-size: 13px;
          line-height: 1.75;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-message-user .friday-bubble {
          border-color: rgba(196,181,253,.18);
          background: rgba(76,52,125,.86);
          color: white;
        }

        .friday-status {
          margin: 0 0 12px 37px;
          color: #c4a5ff;
          font-size: 12px;
        }

        .friday-error {
          margin: 8px 0;
          padding: 10px 11px;
          border: 1px solid rgba(248,113,113,.3);
          border-radius: 11px;
          background: rgba(127,29,29,.25);
          color: #fca5a5;
          font-size: 12px;
          line-height: 1.6;
        }

        .friday-input-area {
          padding: 12px;
          padding-bottom: max(12px, env(safe-area-inset-bottom));
          border-top: 1px solid rgba(255,255,255,.1);
          background: rgba(19,19,31,.78);
          -webkit-backdrop-filter: blur(30px);
          backdrop-filter: blur(30px);
        }

        .friday-input-box {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          padding: 8px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 16px;
          background: rgba(255,255,255,.07);
          box-shadow: inset 0 1px 4px rgba(0,0,0,.2);
        }

        .friday-textarea {
          flex: 1;
          min-width: 0;
          max-height: 110px;
          resize: none;
          border: 0;
          outline: 0;
          background: transparent;
          color: white;
          font-size: 14px;
          line-height: 1.55;
          padding: 6px 4px;
        }

        .friday-textarea::placeholder {
          color: #89869d;
        }

        .friday-textarea:disabled {
          opacity: .55;
        }

        .friday-send-btn {
          width: 39px;
          height: 39px;
          flex: 0 0 39px;
          border: 1px solid rgba(255,255,255,.22);
          border-radius: 13px;
          background:
            linear-gradient(
              135deg,
              #e6e8ed,
              #666b78 48%,
              #22252e
            );
          color: white;
          font-size: 17px;
          cursor: pointer;
          box-shadow:
            0 3px 10px rgba(0,0,0,.28),
            inset 0 1px 2px rgba(255,255,255,.5);
        }

        .friday-send-btn:disabled {
          opacity: .35;
          cursor: not-allowed;
        }

        .friday-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-top: 9px;
          color: #89869d;
          font-size: 11px;
        }

        .friday-tool-group {
          display: flex;
          align-items: center;
          gap: 7px;
        }

        .friday-tool-btn {
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 9px;
          padding: 7px 9px;
          background: rgba(255,255,255,.07);
          color: #c4bfd5;
          cursor: pointer;
          font-size: 11px;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-tool-btn.active {
          border-color: rgba(196,181,253,.2);
          background: rgba(168,85,247,.22);
          color: #e1c8ff;
        }

        .friday-tool-btn:disabled {
          opacity: .4;
          cursor: not-allowed;
        }

        .friday-movie-section {
          margin: 4px 0 17px 36px;
        }

        .friday-result-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 9px;
          color: #e9d5ff;
          font-size: 12px;
          font-weight: 700;
        }

        .friday-result-count {
          flex: 0 0 auto;
          color: #c4a5ff;
          font-weight: 500;
        }

        .friday-movie-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 9px;
        }

        .friday-movie-card {
          min-width: 0;
          display: flex;
          gap: 8px;
          padding: 7px;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 12px;
          background: rgba(35,35,49,.78);
          color: white;
          text-align: left;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-movie-card:active {
          background: rgba(65,54,88,.85);
          transform: scale(.99);
        }

        .friday-poster {
          position: relative;
          width: 56px;
          height: 78px;
          flex: 0 0 56px;
          overflow: hidden;
          border-radius: 7px;
          background: #302b43;
        }

        .friday-poster img {
          position: absolute;
          z-index: 1;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .friday-poster-fallback {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: #c4b5fd;
          background:
            linear-gradient(
              145deg,
              rgba(255,255,255,.08),
              transparent
            );
        }

        .friday-poster-remark {
          position: absolute;
          z-index: 2;
          right: 2px;
          bottom: 2px;
          left: 2px;
          overflow: hidden;
          padding: 2px 3px;
          border-radius: 3px;
          background: rgba(0,0,0,.72);
          color: white;
          font-size: 9px;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-info {
          min-width: 0;
          flex: 1;
          padding: 3px 0;
        }

        .friday-movie-name {
          display: -webkit-box;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          color: #f5f3ff;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.5;
        }

        .friday-movie-meta {
          margin-top: 5px;
          overflow: hidden;
          color: #a5a3b8;
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-source {
          margin-top: 5px;
          overflow: hidden;
          color: #c4a5ff;
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-empty-result {
          margin: 4px 0 14px 36px;
          color: #aaa8ba;
          font-size: 12px;
        }

        @media (max-width: 380px) {
          .friday-panel {
            right: 8px;
            width: calc(100vw - 16px);
          }

          .friday-movie-card {
            gap: 6px;
            padding: 6px;
          }

          .friday-poster {
            width: 48px;
            height: 70px;
            flex-basis: 48px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .friday-panel {
            animation: none;
          }

          .friday-fab {
            transition: none;
          }

          .friday-fab::after {
            animation: none;
          }
        }
      `}</style>

      <div className="friday-root">
        {!open ? (
          <button
            type="button"
            className="friday-fab"
            aria-label="打开 Friday AI 助手"
            style={
              fabPosition
                ? {
                    position: "fixed",
                    left: fabPosition.left,
                    top: fabPosition.top,
                    right: "auto",
                    bottom: "auto",
                  }
                : undefined
            }
            onPointerDown={handleFabPointerDown}
            onPointerMove={handleFabPointerMove}
            onPointerUp={handleFabPointerUp}
            onPointerCancel={handleFabPointerUp}
            onClick={handleFabClick}
          >
            F
          </button>
        ) : null}

        {open ? (
          <section
            ref={panelRef}
            className={`friday-panel ${
              expanded ? "friday-expanded" : ""
            }`}
            aria-label="Friday AI 助手"
          >
            <header className="friday-header">
              <div className="friday-brand">
                <div className="friday-avatar">F</div>

                <div>
                  <div className="friday-brand-name">
                    Friday
                  </div>

                  <div className="friday-brand-sub">
                    {busy
                      ? "正在思考…"
                      : "LibreTV 智能影视助手"}
                  </div>
                </div>
              </div>

              <div className="friday-header-actions">
                <button
                  type="button"
                  className="friday-icon-btn"
                  title="新对话"
                  aria-label="新对话"
                  onClick={clearConversation}
                >
                  ↻
                </button>

                <button
                  type="button"
                  className="friday-icon-btn"
                  title={expanded ? "缩小窗口" : "展开窗口"}
                  aria-label={
                    expanded ? "缩小窗口" : "展开窗口"
                  }
                  onClick={() =>
                    setExpanded((value) => !value)
                  }
                >
                  {expanded ? "↙" : "↗"}
                </button>

                <button
                  type="button"
                  className="friday-icon-btn"
                  title="关闭"
                  aria-label="关闭"
                  onClick={closePanel}
                >
                  ×
                </button>
              </div>
            </header>

            <div
              ref={messagesRef}
              className="friday-messages"
            >
              {messages.length === 0 ? (
                <div className="friday-welcome">
                  <div className="friday-welcome-icon">
                    F
                  </div>

                  <div className="friday-welcome-title">
                    你好，我是 Friday
                  </div>

                  <div className="friday-welcome-text">
                    想看什么电影、电视剧或动漫？
                    <br />
                    也可以让我帮你查找 LibreTV 的影视资源。
                  </div>
                </div>
              ) : null}

              {(messages as any[]).map((message) => {
                const isUser = message.role === "user";
                const text = getPartText(message);

                return (
                  <div
                    key={message.id}
                    className={`friday-message ${
                      isUser ? "friday-message-user" : ""
                    }`}
                  >
                    <div className="friday-message-avatar">
                      {isUser ? "你" : "F"}
                    </div>

                    {text ? (
                      <div className="friday-bubble">
                        {text}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              {movieData.map((data) => (
                <MovieCards
                  key={data.searchId}
                  data={data}
                  onOpen={handleOpenMovie}
                />
              ))}

              {busy ? (
                <div className="friday-status">
                  {status === "submitted"
                    ? "Friday 正在接收消息…"
                    : "Friday 正在处理，请稍候…"}
                </div>
              ) : null}

              {error ? (
                <div className="friday-error">
                  {error.message ||
                    "请求失败，请稍后重试。"}
                </div>
              ) : null}
            </div>

            <footer className="friday-input-area">
              <div className="friday-input-box">
                <textarea
                  ref={inputRef}
                  className="friday-textarea"
                  value={input}
                  rows={1}
                  maxLength={MAX_INPUT_LENGTH}
                  placeholder={
                    listening
                      ? "正在听你说话…"
                      : "输入电影名称或发送消息…"
                  }
                  disabled={busy}
                  onChange={(event) => {
                    setInput(
                      event.target.value.slice(
                        0,
                        MAX_INPUT_LENGTH,
                      ),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                />

                <button
                  type="button"
                  className="friday-send-btn"
                  disabled={busy || !input.trim()}
                  aria-label="发送消息"
                  onClick={() => void handleSend()}
                >
                  ➤
                </button>
              </div>

              <div className="friday-tools">
                <div className="friday-tool-group">
                  <button
                    type="button"
                    className={`friday-tool-btn ${
                      listening ? "active" : ""
                    }`}
                    disabled={busy}
                    onClick={() => {
                      if (listening) {
                        recognitionRef.current?.stop();
                      } else {
                        startListening();
                      }
                    }}
                  >
                    {listening ? "停止听写" : "语音输入"}
                  </button>

                  <button
                    type="button"
                    className={`friday-tool-btn ${
                      voiceEnabled ? "active" : ""
                    }`}
                    onClick={() => {
                      if (voiceEnabled) {
                        stopSpeech();
                      }

                      setVoiceEnabled((value) => !value);
                    }}
                  >
                    {voiceEnabled
                      ? "语音播报开"
                      : "语音播报关"}
                  </button>
                </div>

                <div className="friday-tool-group">
                  {speaking ? (
                    <button
                      type="button"
                      className="friday-tool-btn active"
                      onClick={stopSpeech}
                    >
                      停止播报
                    </button>
                  ) : null}

                  {busy ? (
                    <button
                      type="button"
                      className="friday-tool-btn active"
                      onClick={interrupt}
                    >
                      中断
                    </button>
                  ) : null}
                </div>
              </div>
            </footer>
          </section>
        ) : null}
      </div>
    </>
  );

  return createPortal(content, document.body);
}
