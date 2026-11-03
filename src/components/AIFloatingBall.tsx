
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
  sources?: SourceConfig[];
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
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
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

type AuroraState =
  | "standby"
  | "listening"
  | "thinking"
  | "speaking"
  | "completed";

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const MAX_INPUT_LENGTH = 1000;
const MAX_MOVIE_CARDS = 60;
const FAB_SIZE = 72;
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

/**
 * 影片数据按消息归属提取。
 * 避免所有搜索结果统一堆在消息列表末尾。
 */
function getMovieDataForMessage(message: any): MovieData[] {
  if (!message || !Array.isArray(message.parts)) {
    return [];
  }

  const output: MovieData[] = [];
  const seen = new Set<string>();

  for (const part of message.parts) {
    if (part?.type !== "data-movies") {
      continue;
    }

    const data = part.data as MovieData | undefined;

    if (
      !data ||
      typeof data.searchId !== "string" ||
      !Array.isArray(data.results) ||
      seen.has(data.searchId)
    ) {
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
  const [completed, setCompleted] = useState(false);
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
  const lastCompletedMessageRef = useRef("");

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const dragResetTimerRef = useRef<number | null>(null);

  /**
   * 从 Store 中获取真正启用的来源。
   */
  const storeSources = useMemo<SourceConfig[]>(() => {
    const selectedKeys = Array.isArray(appStore.selectedKeys)
      ? appStore.selectedKeys
      : [];

    const result: SourceConfig[] = [];

    for (const key of selectedKeys) {
      if (!key) continue;
      if (isSourceDisabled(appStore, key)) continue;
      if (isInDisabledSubscription(appStore, key)) continue;

      const source = resolveSource(appStore, key);

      if (source) {
        result.push(source as SourceConfig);
      }
    }

    return result;
  }, [
    appStore.selectedKeys,
    appStore.customAPIs,
    appStore.envSources,
    appStore.sourceHealth,
    appStore.subscriptions,
  ]);

  const activeSources = sources ?? storeSources;

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

  /**
   * Friday 的视觉状态机。
   */
  const auroraState: AuroraState = speaking
    ? "speaking"
    : listening
      ? "listening"
      : busy
        ? "thinking"
        : completed
          ? "completed"
          : "standby";

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

      if (!content || busy) return;
      if (content.length > MAX_INPUT_LENGTH) return;

      stopAllVoice();
      setCompleted(false);
      setInput("");

      try {
        await sendMessage({ text: content });
      } catch (sendError) {
        console.error("[Friday] Send failed:", sendError);
      }
    },
    [input, busy, sendMessage, stopAllVoice],
  );

  const handleOpenMovie = useCallback(
    (movie: MovieItem) => {
      if (typeof window === "undefined") return;

      stopAllVoice();

      window.dispatchEvent(
        new CustomEvent("friday-open-detail", {
          detail: movie,
        }),
      );
    },
    [stopAllVoice],
  );

  /**
   * 语音识别。
   * 每个回调均校验实例身份，防止旧实例污染新状态。
   */
  const startListening = useCallback(() => {
    if (busy || listening) return;

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
      if (recognitionRef.current !== recognition) return;
      setListening(true);
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;

      let finalText = "";
      let interimText = "";

      for (
        let index = 0;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || "";

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
      if (recognitionRef.current !== recognition) return;

      recognitionRef.current = null;
      setListening(false);
    };

    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;

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

  /**
   * 使用系统语音播报。
   */
  const speakText = useCallback(
    (text: string, messageId: string) => {
      if (!voiceEnabled || !text.trim()) return;

      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
      ) {
        return;
      }

      stopSpeech();
      setCompleted(false);

      const utterance = new SpeechSynthesisUtterance(text);

      utterance.lang = "zh-CN";
      utterance.rate = 1;
      utterance.pitch = 1;

      utterance.onstart = () => {
        if (utteranceRef.current !== utterance) return;
        setSpeaking(true);
      };

      utterance.onend = () => {
        if (utteranceRef.current !== utterance) return;

        utteranceRef.current = null;
        setSpeaking(false);
        setCompleted(true);
      };

      utterance.onerror = () => {
        if (utteranceRef.current !== utterance) return;

        utteranceRef.current = null;
        setSpeaking(false);
        setCompleted(true);
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
   * 回复结束后只播报一次。
   */
  useEffect(() => {
    if (status !== "ready" || !open) return;

    const lastAssistant = [...(messages as any[])]
      .reverse()
      .find((message) => message?.role === "assistant");

    if (!lastAssistant?.id) return;

    const text = getPartText(lastAssistant);

    if (!text.trim()) return;

    if (
      lastCompletedMessageRef.current === lastAssistant.id
    ) {
      return;
    }

    lastCompletedMessageRef.current = lastAssistant.id;

    if (
      voiceEnabled &&
      lastSpokenMessageRef.current !== lastAssistant.id
    ) {
      speakText(text, lastAssistant.id);
    } else if (!voiceEnabled) {
      setCompleted(true);
    }
  }, [
    messages,
    status,
    voiceEnabled,
    open,
    speakText,
  ]);

  /**
   * 完成状态短暂展示，然后回到待机。
   */
  useEffect(() => {
    if (!completed) return;

    const timer = window.setTimeout(() => {
      setCompleted(false);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [completed]);

  /**
   * 新消息、影片卡片或加载状态变化时滚动到底部。
   */
  useEffect(() => {
    if (!open) return;

    const container = messagesRef.current;

    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy, error, open]);

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
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePanel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, closePanel]);

  useEffect(() => {
    if (!open) return;

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  const clearConversation = useCallback(() => {
    interrupt();
    setMessages([]);
    lastSpokenMessageRef.current = "";
    lastCompletedMessageRef.current = "";
    setCompleted(false);
    setInput("");
  }, [interrupt, setMessages]);

  /**
   * 悬浮球拖拽。
   */
  const handleFabPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (open) return;

      const rect = event.currentTarget.getBoundingClientRect();

      dragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 部分浏览器不支持 pointer capture。
      }
    },
    [open],
  );

  const handleFabPointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;

      if (!drag || drag.pointerId !== event.pointerId) return;

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

      if (!drag || drag.pointerId !== event.pointerId) return;

      const wasMoved = drag.moved;
      dragRef.current = null;

      if (!wasMoved) return;

      suppressClickRef.current = true;

      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
      }

      dragResetTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        dragResetTimerRef.current = null;
      }, 250);
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
          right: 22px;
          bottom: max(24px, env(safe-area-inset-bottom));
          font-family:
            -apple-system,
            BlinkMacSystemFont,
            "SF Pro Display",
            "SF Pro Text",
            "PingFang SC",
            "Microsoft YaHei",
            sans-serif;
        }

        /* =========================================
           01. 液态金属球体
        ========================================= */

        .friday-fab {
          position: relative;
          isolation: isolate;
          display: grid;
          place-items: center;
          width: 72px;
          height: 72px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.42);
          border-radius: 43% 57% 54% 46% / 48% 42% 58% 52%;
          color: #fff;
          cursor: grab;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          background:
            radial-gradient(
              ellipse at 28% 19%,
              rgba(255,255,255,.98) 0,
              rgba(255,255,255,.7) 5%,
              transparent 24%
            ),
            radial-gradient(
              ellipse at 70% 78%,
              rgba(255,184,107,.7) 0,
              transparent 29%
            ),
            radial-gradient(
              ellipse at 28% 78%,
              rgba(111,128,255,.72) 0,
              transparent 38%
            ),
            radial-gradient(
              ellipse at 75% 25%,
              rgba(190,119,255,.6) 0,
              transparent 35%
            ),
            linear-gradient(
              145deg,
              #f5f7fa 0%,
              #697080 19%,
              #151820 42%,
              #a6aab5 58%,
              #292d38 78%,
              #07090e 100%
            );
          box-shadow:
            0 12px 34px rgba(0,0,0,.48),
            0 0 25px rgba(177,165,255,.18),
            inset 0 2px 5px rgba(255,255,255,.8),
            inset 0 -7px 14px rgba(0,0,0,.8);
          font-size: 20px;
          font-weight: 700;
          letter-spacing: -1px;
          text-shadow: 0 2px 8px rgba(0,0,0,.7);
          animation:
            friday-orb-morph 8s ease-in-out infinite,
            friday-orb-float 5s ease-in-out infinite;
          transition:
            transform .25s ease,
            filter .25s ease,
            box-shadow .25s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-fab::before {
          position: absolute;
          z-index: -1;
          inset: -20%;
          border-radius: 50%;
          background:
            conic-gradient(
              from 0deg,
              rgba(105,140,255,.05),
              rgba(183,120,255,.75),
              rgba(255,164,112,.78),
              rgba(255,221,151,.72),
              rgba(102,224,201,.48),
              rgba(105,140,255,.05)
            );
          filter: blur(9px);
          opacity: .76;
          content: "";
          animation: friday-orb-spectrum 13s linear infinite;
        }

        .friday-fab::after {
          position: absolute;
          top: -45%;
          left: -65%;
          width: 62%;
          height: 190%;
          transform: rotate(35deg);
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255,255,255,.82),
            rgba(177,220,255,.24),
            transparent
          );
          content: "";
          animation: friday-orb-shine 7s ease-in-out infinite;
        }

        .friday-fab:active {
          cursor: grabbing;
          transform: scale(.94);
        }

        @keyframes friday-orb-morph {
          0%, 100% {
            border-radius: 43% 57% 54% 46% / 48% 42% 58% 52%;
          }
          35% {
            border-radius: 54% 46% 43% 57% / 44% 57% 43% 56%;
          }
          68% {
            border-radius: 47% 53% 58% 42% / 57% 45% 55% 43%;
          }
        }

        @keyframes friday-orb-float {
          0%, 100% {
            transform: translate3d(0,0,0);
          }
          50% {
            transform: translate3d(0,-5px,0);
          }
        }

        @keyframes friday-orb-spectrum {
          from {
            transform: rotate(0deg) scale(1);
          }
          to {
            transform: rotate(360deg) scale(1.04);
          }
        }

        @keyframes friday-orb-shine {
          0%, 66% {
            left: -75%;
            opacity: 0;
          }
          73% {
            opacity: .9;
          }
          90%, 100% {
            left: 135%;
            opacity: 0;
          }
        }

        /* =========================================
           02. Spatial Ambient Canvas
        ========================================= */

        .friday-panel {
          position: fixed;
          right: 18px;
          bottom: calc(112px + env(safe-area-inset-bottom));
          display: flex;
          flex-direction: column;
          width: min(540px, calc(100vw - 28px));
          height: min(720px, calc(100dvh - 135px));
          min-height: 380px;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255,255,255,.055);
          border-radius: 38px;
          color: #f8f8f5;
          background:
            radial-gradient(
              ellipse at 50% 110%,
              rgba(80,90,72,.1),
              transparent 52%
            ),
            linear-gradient(
              155deg,
              #090b0c 0%,
              #050707 58%,
              #080a09 100%
            );
          box-shadow:
            0 30px 100px rgba(0,0,0,.68),
            0 0 1px rgba(255,255,255,.25);
          transform-origin: bottom right;
          animation: friday-canvas-open .52s cubic-bezier(.2,.8,.2,1);
        }

        .friday-panel.friday-expanded {
          right: 8px;
          bottom: 8px;
          width: calc(100vw - 16px);
          height: calc(100dvh - 16px);
          max-height: calc(100dvh - 16px);
          border-radius: 34px;
        }

        @keyframes friday-canvas-open {
          from {
            opacity: 0;
            transform: translate3d(22px,30px,0) scale(.72);
            border-radius: 50%;
          }
          to {
            opacity: 1;
            transform: translate3d(0,0,0) scale(1);
            border-radius: 38px;
          }
        }

        /* SVG 流体扰动的降级基础效果 */
        .friday-filter-defs {
          position: absolute;
          width: 0;
          height: 0;
          pointer-events: none;
        }

        /* =========================================
           03. Aurora Engine
        ========================================= */

        .friday-aurora {
          position: absolute;
          z-index: -1;
          right: -24%;
          bottom: -13%;
          left: -24%;
          height: 44%;
          pointer-events: none;
          opacity: .8;
          filter: blur(25px);
          transform: translateZ(0);
          transform-origin: center bottom;
          transition:
            opacity 1.2s ease,
            height 1.2s ease,
            filter 1.2s ease,
            transform 1.2s ease;
        }

        .friday-aurora::before,
        .friday-aurora::after {
          position: absolute;
          inset: 0;
          content: "";
          pointer-events: none;
        }

        .friday-aurora::before {
          background:
            radial-gradient(
              ellipse 52% 72% at 50% 100%,
              rgba(255,255,255,.98) 0%,
              rgba(255,246,211,.92) 12%,
              rgba(255,207,94,.78) 29%,
              rgba(255,190,80,.36) 47%,
              transparent 76%
            );
          animation: friday-aurora-white 6s ease-in-out infinite;
        }

        .friday-aurora::after {
          inset: -10% -12% 0;
          background:
            radial-gradient(
              ellipse 48% 72% at 22% 100%,
              rgba(124,224,190,.42),
              transparent 72%
            ),
            radial-gradient(
              ellipse 48% 72% at 80% 100%,
              rgba(135,226,199,.36),
              transparent 72%
            ),
            radial-gradient(
              ellipse 60% 72% at 53% 100%,
              rgba(255,196,94,.38),
              transparent 76%
            );
          animation: friday-aurora-color 10s ease-in-out infinite alternate;
        }

        .friday-aurora-core {
          position: absolute;
          right: 8%;
          bottom: -4%;
          left: 8%;
          height: 48%;
          border-radius: 50%;
          background:
            radial-gradient(
              ellipse at 50% 100%,
              rgba(255,255,255,.9),
              rgba(255,220,128,.55) 28%,
              rgba(255,220,128,.08) 66%,
              transparent 78%
            );
          filter: blur(22px);
          opacity: .75;
          animation: friday-aurora-core 5.5s ease-in-out infinite;
        }

        @keyframes friday-aurora-white {
          0%, 100% {
            transform: translate3d(0,0,0) scaleX(1);
            opacity: .78;
          }
          50% {
            transform: translate3d(0,-5%,0) scaleX(1.13);
            opacity: 1;
          }
        }

        @keyframes friday-aurora-color {
          0% {
            transform: translate3d(-3%,0,0) scaleX(.94);
          }
          50% {
            transform: translate3d(2%,-4%,0) scaleX(1.08);
          }
          100% {
            transform: translate3d(-1%,0,0) scaleX(1.02);
          }
        }

        @keyframes friday-aurora-core {
          0%, 100% {
            transform: scale(.9);
            opacity: .58;
          }
          50% {
            transform: scale(1.14);
            opacity: .92;
          }
        }

        /* 待机：缓慢呼吸 */
        .friday-panel[data-state="standby"] .friday-aurora {
          height: 42%;
          opacity: .65;
          filter: blur(29px);
          animation: friday-aurora-breathe 7s ease-in-out infinite;
        }

        @keyframes friday-aurora-breathe {
          0%, 100% {
            transform: scaleX(.94) scaleY(.92);
          }
          50% {
            transform: scaleX(1.08) scaleY(1.08);
          }
        }

        /* 聆听：轻微波动 */
        .friday-panel[data-state="listening"] .friday-aurora {
          height: 47%;
          opacity: .83;
          filter: blur(23px);
          animation: friday-aurora-listen 2.8s ease-in-out infinite;
        }

        @keyframes friday-aurora-listen {
          0%, 100% {
            transform: scaleX(.98) scaleY(.96);
          }
          50% {
            transform: scaleX(1.08) scaleY(1.05);
          }
        }

        /* 思考：向中心聚拢 */
        .friday-panel[data-state="thinking"] .friday-aurora {
          height: 54%;
          opacity: .96;
          filter: blur(19px);
          animation: friday-aurora-thinking 2.2s ease-in-out infinite;
        }

        .friday-panel[data-state="thinking"] .friday-aurora::before {
          animation-duration: 2.2s;
        }

        .friday-panel[data-state="thinking"] .friday-aurora::after {
          animation-duration: 3s;
        }

        @keyframes friday-aurora-thinking {
          0%, 100% {
            transform: scaleX(1.15) scaleY(.88);
          }
          50% {
            transform: scaleX(.78) scaleY(1.12);
          }
        }

        /* 播报：语音活动脉冲。
           当前 speechSynthesis 不暴露真实音频振幅，
           此处是语音活动状态动画，不代表真实波形分析。 */
        .friday-panel[data-state="speaking"] .friday-aurora {
          height: 59%;
          opacity: 1;
          filter: blur(17px);
          animation: friday-aurora-speaking .72s ease-in-out infinite alternate;
        }

        .friday-panel[data-state="speaking"] .friday-aurora-core {
          animation-duration: .72s;
        }

        @keyframes friday-aurora-speaking {
          from {
            transform: scaleX(.91) scaleY(.91);
          }
          to {
            transform: scaleX(1.13) scaleY(1.12);
          }
        }

        /* 完成：舒展后回归平静 */
        .friday-panel[data-state="completed"] .friday-aurora {
          height: 47%;
          opacity: .86;
          filter: blur(25px);
          animation: friday-aurora-completed 1.8s ease-out both;
        }

        @keyframes friday-aurora-completed {
          0% {
            transform: scaleX(.72) scaleY(.8);
            opacity: 1;
          }
          65% {
            transform: scaleX(1.14) scaleY(1.12);
            opacity: .9;
          }
          100% {
            transform: scaleX(1) scaleY(1);
            opacity: .65;
          }
        }

        /* =========================================
           04. Canvas 内容与排版
        ========================================= */

        .friday-canvas-top {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          min-height: 54px;
          padding: 17px 22px 8px;
        }

        .friday-wordmark {
          color: rgba(255,255,255,.42);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 4px;
        }

        .friday-state-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          color: rgba(255,255,255,.5);
          font-size: 10px;
          letter-spacing: .5px;
        }

        .friday-status-dot {
          width: 8px;
          height: 8px;
          flex: 0 0 8px;
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: #f3a34b;
          box-shadow:
            0 0 7px rgba(255,170,75,.8),
            0 0 17px rgba(255,170,75,.36);
          cursor: pointer;
          animation: friday-status-breathe 2.4s ease-in-out infinite;
        }

        @keyframes friday-status-breathe {
          0%, 100% {
            opacity: .62;
            transform: scale(.85);
          }
          50% {
            opacity: 1;
            transform: scale(1.15);
          }
        }

        .friday-messages {
          position: relative;
          z-index: 1;
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 22px 27px 150px;
          scroll-behavior: smooth;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,.15) transparent;
        }

        .friday-welcome {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-height: 270px;
          padding: 30px 0 60px;
          color: #f7f7f2;
          text-align: left;
        }

        .friday-welcome-kicker {
          margin-bottom: 18px;
          color: rgba(255,255,255,.44);
          font-size: 10px;
          letter-spacing: 3px;
        }

        .friday-welcome-title {
          max-width: 390px;
          margin: 0 0 18px;
          color: #fff;
          font-size: clamp(29px, 6vw, 42px);
          font-weight: 500;
          letter-spacing: -1.8px;
          line-height: 1.28;
        }

        .friday-welcome-text {
          max-width: 370px;
          color: rgba(255,255,255,.64);
          font-size: 15px;
          font-weight: 400;
          line-height: 1.85;
        }

        .friday-message {
          display: flex;
          align-items: flex-start;
          justify-content: flex-start;
          margin: 0 0 27px;
          animation: friday-message-in .35s ease both;
        }

        .friday-message-user {
          justify-content: flex-end;
        }

        @keyframes friday-message-in {
          from {
            opacity: 0;
            transform: translateY(9px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .friday-message-content {
          max-width: 94%;
          color: rgba(255,255,255,.9);
          font-size: 16px;
          font-weight: 400;
          line-height: 1.85;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-message-user .friday-message-content {
          max-width: 86%;
          color: rgba(255,255,255,.62);
          text-align: right;
        }

        .friday-status {
          margin: 14px 0 18px;
          color: rgba(255,224,160,.78);
          font-size: 12px;
          letter-spacing: .4px;
          animation: friday-status-breathe 1.8s ease-in-out infinite;
        }

        .friday-error {
          margin: 12px 0;
          padding: 12px 14px;
          border: 1px solid rgba(248,113,113,.18);
          border-radius: 16px;
          background: rgba(127,29,29,.12);
          color: #fca5a5;
          font-size: 13px;
          line-height: 1.7;
        }

        /* =========================================
           05. 极简输入区
        ========================================= */

        .friday-input-area {
          position: absolute;
          z-index: 4;
          right: 0;
          bottom: 0;
          left: 0;
          padding: 18px 21px max(19px, env(safe-area-inset-bottom));
          background:
            linear-gradient(
              to bottom,
              rgba(5,7,7,0),
              rgba(5,7,7,.78) 24%,
              rgba(5,7,7,.94)
            );
        }

        .friday-input-box {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          min-height: 54px;
          padding: 9px 11px 9px 17px;
          border: 1px solid rgba(255,255,255,.11);
          border-radius: 22px;
          background: rgba(255,255,255,.055);
          -webkit-backdrop-filter: blur(22px);
          backdrop-filter: blur(22px);
          box-shadow:
            0 8px 30px rgba(0,0,0,.2),
            inset 0 1px 0 rgba(255,255,255,.045);
        }

        .friday-textarea {
          flex: 1;
          min-width: 0;
          max-height: 110px;
          resize: none;
          border: 0;
          outline: 0;
          background: transparent;
          color: #fff;
          font-family: inherit;
          font-size: 14px;
          line-height: 1.65;
          padding: 6px 0;
        }

        .friday-textarea::placeholder {
          color: rgba(255,255,255,.37);
        }

        .friday-textarea:disabled {
          opacity: .5;
        }

        .friday-send-btn,
        .friday-mic-btn {
          width: 37px;
          height: 37px;
          flex: 0 0 37px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 50%;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.88);
          cursor: pointer;
          font-size: 15px;
          transition:
            background .2s ease,
            transform .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-send-btn:active,
        .friday-mic-btn:active {
          transform: scale(.92);
          background: rgba(255,255,255,.2);
        }

        .friday-send-btn:disabled {
          opacity: .3;
          cursor: not-allowed;
        }

        .friday-mic-btn.active {
          border-color: rgba(255,192,104,.45);
          background: rgba(255,175,75,.16);
          color: #ffd18b;
          animation: friday-status-breathe 1.5s ease-in-out infinite;
        }

        .friday-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          min-height: 28px;
          margin-top: 9px;
          padding: 0 5px;
          color: rgba(255,255,255,.36);
          font-size: 10px;
        }

        .friday-tool-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .friday-tool-btn {
          padding: 4px 2px;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.48);
          cursor: pointer;
          font-family: inherit;
          font-size: 10px;
        }

        .friday-tool-btn.active {
          color: #f5c77d;
        }

        .friday-tool-btn:disabled {
          opacity: .35;
          cursor: not-allowed;
        }

        /* =========================================
           06. 影片卡片
        ========================================= */

        .friday-movie-section {
          margin: 12px 0 27px;
        }

        .friday-result-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          color: rgba(255,255,255,.86);
          font-size: 12px;
          font-weight: 600;
        }

        .friday-result-count {
          color: rgba(255,255,255,.46);
          font-weight: 400;
        }

        .friday-movie-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }

        .friday-movie-card {
          min-width: 0;
          display: flex;
          gap: 9px;
          padding: 8px;
          border: 1px solid rgba(255,255,255,.075);
          border-radius: 16px;
          background: rgba(255,255,255,.045);
          color: white;
          text-align: left;
          cursor: pointer;
          transition:
            background .2s ease,
            transform .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-movie-card:active {
          background: rgba(255,255,255,.1);
          transform: scale(.985);
        }

        .friday-poster {
          position: relative;
          width: 55px;
          height: 78px;
          flex: 0 0 55px;
          overflow: hidden;
          border-radius: 9px;
          background: #202321;
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
          color: rgba(255,255,255,.58);
          background: linear-gradient(145deg,#303632,#111512);
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
          color: rgba(255,255,255,.92);
          font-size: 12px;
          font-weight: 600;
          line-height: 1.5;
        }

        .friday-movie-meta {
          margin-top: 5px;
          overflow: hidden;
          color: rgba(255,255,255,.45);
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-source {
          margin-top: 5px;
          overflow: hidden;
          color: rgba(218,205,169,.78);
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-empty-result {
          margin: 12px 0;
          color: rgba(255,255,255,.52);
          font-size: 13px;
        }

        /* =========================================
           07. 移动端适配
        ========================================= */

        @media (max-width: 600px) {
          .friday-panel {
            right: 8px;
            bottom: max(8px, env(safe-area-inset-bottom));
            width: calc(100vw - 16px);
            height: min(760px, calc(100dvh - 16px - env(safe-area-inset-top)));
            min-height: 320px;
            border-radius: 32px;
          }

          .friday-panel.friday-expanded {
            right: 4px;
            bottom: 4px;
            width: calc(100vw - 8px);
            height: calc(100dvh - 8px);
            border-radius: 30px;
          }

          .friday-canvas-top {
            padding: 17px 19px 6px;
          }

          .friday-messages {
            padding: 19px 21px 145px;
          }

          .friday-welcome {
            min-height: 235px;
          }

          .friday-welcome-title {
            font-size: clamp(29px, 8vw, 38px);
          }

          .friday-input-area {
            padding-right: 14px;
            padding-left: 14px;
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

        @media (max-height: 520px) {
          .friday-panel {
            bottom: 6px;
            height: calc(100dvh - 12px);
            min-height: 0;
          }

          .friday-canvas-top {
            min-height: 40px;
            padding-top: 9px;
          }

          .friday-welcome {
            min-height: 150px;
            padding-top: 12px;
          }

          .friday-welcome-title {
            font-size: 26px;
          }

          .friday-input-area {
            padding-top: 8px;
            padding-bottom: 8px;
          }

          .friday-tools {
            margin-top: 4px;
          }
        }

        /* =========================================
           08. 减少动态效果
        ========================================= */

        @media (prefers-reduced-motion: reduce) {
          .friday-fab,
          .friday-fab::before,
          .friday-fab::after,
          .friday-panel,
          .friday-aurora,
          .friday-aurora::before,
          .friday-aurora::after,
          .friday-aurora-core,
          .friday-status-dot,
          .friday-message {
            animation: none !important;
          }

          .friday-fab,
          .friday-send-btn,
          .friday-mic-btn,
          .friday-movie-card {
            transition: none !important;
          }
        }
      `}</style>

      {/* SVG 流体滤镜定义，浏览器不支持时仍有渐变降级 */}
      <svg
        className="friday-filter-defs"
        aria-hidden="true"
        focusable="false"
      >
        <filter id="friday-aurora-distortion">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.025"
            numOctaves="2"
            seed="8"
            result="noise"
          >
            <animate
              attributeName="baseFrequency"
              values="0.012 0.025;0.018 0.035;0.012 0.025"
              dur="12s"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="13"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

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
            className={`friday-panel ${
              expanded ? "friday-expanded" : ""
            }`}
            data-state={auroraState}
            aria-label="Friday 空间式 AI 助手"
          >
            <div className="friday-aurora" aria-hidden="true">
              <div className="friday-aurora-core" />
            </div>

            <div className="friday-canvas-top">
              <div className="friday-wordmark">
                FRIDAY
              </div>

              <div className="friday-state-wrap">
                <span>
                  {auroraState === "listening"
                    ? "LISTENING"
                    : auroraState === "thinking"
                      ? "THINKING"
                      : auroraState === "speaking"
                        ? "SPEAKING"
                        : auroraState === "completed"
                          ? "COMPLETED"
                          : "READY"}
                </span>

                <button
                  type="button"
                  className="friday-status-dot"
                  title="收起 Friday"
                  aria-label="收起 Friday"
                  onClick={closePanel}
                />
              </div>
            </div>

            <div
              ref={messagesRef}
              className="friday-messages"
            >
              {messages.length === 0 ? (
                <div className="friday-welcome">
                  <div className="friday-welcome-kicker">
                    YOUR AMBIENT AI
                  </div>

                  <div className="friday-welcome-title">
                    你好，我是 Friday。
                  </div>

                  <div className="friday-welcome-text">
                    告诉我你想看什么，或者让我帮你寻找更好的影视资源。
                  </div>
                </div>
              ) : null}

              {(messages as any[]).map((message) => {
                const isUser = message.role === "user";
                const text = getPartText(message);
                const messageMovies =
                  getMovieDataForMessage(message);

                return (
                  <React.Fragment key={message.id}>
                    {text ? (
                      <div
                        className={`friday-message ${
                          isUser ? "friday-message-user" : ""
                        }`}
                      >
                        <div className="friday-message-content">
                          {text}
                        </div>
                      </div>
                    ) : null}

                    {messageMovies.map((data) => (
                      <MovieCards
                        key={data.searchId}
                        data={data}
                        onOpen={handleOpenMovie}
                      />
                    ))}
                  </React.Fragment>
                );
              })}

              {busy ? (
                <div className="friday-status">
                  {status === "submitted"
                    ? "Friday 正在接收消息…"
                    : "Friday 正在思考…"}
                </div>
              ) : null}

              {error ? (
                <div className="friday-error">
                  {error.message || "请求失败，请稍后重试。"}
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
                      ? "正在聆听…"
                      : "向 Friday 说点什么…"
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
                  className={`friday-mic-btn ${
                    listening ? "active" : ""
                  }`}
                  disabled={busy}
                  aria-label={
                    listening ? "停止语音输入" : "开始语音输入"
                  }
                  onClick={() => {
                    if (listening) {
                      recognitionRef.current?.stop();
                    } else {
                      startListening();
                    }
                  }}
                >
                  {listening ? "Ⅱ" : "◉"}
                </button>

                <button
                  type="button"
                  className="friday-send-btn"
                  disabled={busy || !input.trim()}
                  aria-label="发送消息"
                  onClick={() => void handleSend()}
                >
                  ↑
                </button>
              </div>

              <div className="friday-tools">
                <div className="friday-tool-group">
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
                    {voiceEnabled ? "语音播报开启" : "语音播报关闭"}
                  </button>

                  <button
                    type="button"
                    className="friday-tool-btn"
                    onClick={clearConversation}
                  >
                    新对话
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

                  <button
                    type="button"
                    className="friday-tool-btn"
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? "收缩画布" : "展开画布"}
                  </button>
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
