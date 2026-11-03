
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

type SpeechRecognitionErrorLike = Event & {
  error?: string;
  message?: string;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
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
const MOVIE_CLOSE_DELAY = 250;

function getPartText(message: any): string {
  if (!message || !Array.isArray(message.parts)) return "";

  return message.parts
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text || ""))
    .join("");
}

function getMovieDataForMessage(message: any): MovieData[] {
  if (!message || !Array.isArray(message.parts)) return [];

  const output: MovieData[] = [];
  const seen = new Set<string>();

  for (const part of message.parts) {
    if (part?.type !== "data-movies") continue;

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
  if (typeof window === "undefined") return;

  try {
    window.speechSynthesis?.cancel();
  } catch {
    // 忽略浏览器语音取消异常。
  }
}

function getSpeechErrorMessage(error?: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限被拒绝，请在浏览器设置中允许麦克风访问。";
    case "audio-capture":
      return "没有检测到可用的麦克风，请检查设备设置。";
    case "network":
      return "语音识别网络连接异常，请检查网络后重试。";
    case "no-speech":
      return "没有检测到语音，请靠近麦克风再试一次。";
    case "language-not-supported":
      return "当前浏览器暂不支持中文语音识别。";
    case "aborted":
      return "";
    default:
      return "语音识别暂时不可用，请检查麦克风权限或改用键盘输入。";
  }
}

function MovieCards({
  data,
  onOpen,
}: {
  data: MovieData;
  onOpen: (movie: MovieItem) => void;
}) {
  const total = data.totalFound ?? data.total ?? data.results.length;

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
        <span className="friday-result-count">{total} 条</span>
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

                <div className="friday-poster-fallback">▶</div>

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
                  {movie.sourceName || movie.sourceKey || "未知来源"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrbVisual() {
  return (
    <div className="friday-orb-visual" aria-hidden="true">
      <div className="friday-orb-core" />
      <div className="friday-orb-refraction" />
      <div className="friday-orb-highlight" />
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
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [voiceError, setVoiceError] = useState("");

  const [fabPosition, setFabPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const lastSpokenMessageRef = useRef("");
  const lastCompletedMessageRef = useRef("");

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const dragResetTimerRef = useRef<number | null>(null);

  const pendingMovieRef = useRef<MovieItem | null>(null);
  const movieCloseTimerRef = useRef<number | null>(null);
  const movieDispatchedRef = useRef(false);

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
  const activeFilterAdult = filterAdult ?? Boolean(appStore.yellowFilter);

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

  const busy = status === "submitted" || status === "streaming";

  const auroraState: AuroraState = speaking
    ? "speaking"
    : listening
      ? "listening"
      : busy
        ? "thinking"
        : completed
          ? "completed"
          : "standby";

  const stateLabel =
    auroraState === "listening"
      ? "Listening..."
      : auroraState === "thinking"
        ? "Thinking..."
        : auroraState === "speaking"
          ? "Speaking..."
          : auroraState === "completed"
            ? "Completed"
            : "";

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

    setListening(false);
    utteranceRef.current = null;
    cancelBrowserSpeech();
    setSpeaking(false);
  }, []);

  const clearMovieCloseTimer = useCallback(() => {
    if (movieCloseTimerRef.current !== null) {
      window.clearTimeout(movieCloseTimerRef.current);
      movieCloseTimerRef.current = null;
    }
  }, []);

  const finalizeMovieOpen = useCallback(() => {
    if (movieDispatchedRef.current) return;

    const movie = pendingMovieRef.current;

    if (!movie) {
      setClosing(false);
      return;
    }

    movieDispatchedRef.current = true;
    pendingMovieRef.current = null;

    clearMovieCloseTimer();
    setClosing(false);

    window.dispatchEvent(
      new CustomEvent("friday-open-detail", {
        detail: movie,
      }),
    );
  }, [clearMovieCloseTimer]);

  const openPanel = useCallback(() => {
    clearMovieCloseTimer();

    pendingMovieRef.current = null;
    movieDispatchedRef.current = false;

    setClosing(false);
    setOpen(true);
    setVoiceError("");

    if (typeof document !== "undefined") {
      document.body.classList.add("friday-popup-lock");
    }
  }, [clearMovieCloseTimer]);

  const closePanel = useCallback(() => {
    clearMovieCloseTimer();

    pendingMovieRef.current = null;
    movieDispatchedRef.current = false;

    stopAllVoice();
    setClosing(false);
    setOpen(false);
    setExpanded(false);

    if (typeof document !== "undefined") {
      document.body.classList.remove("friday-popup-lock");
    }
  }, [clearMovieCloseTimer, stopAllVoice]);

  const handleOpenMovie = useCallback(
    (movie: MovieItem) => {
      if (typeof window === "undefined") return;
      if (closing || movieDispatchedRef.current) return;

      stopAllVoice();

      pendingMovieRef.current = movie;
      movieDispatchedRef.current = false;

      setClosing(true);
      setOpen(false);
      setExpanded(false);

      if (typeof document !== "undefined") {
        document.body.classList.remove("friday-popup-lock");
      }

      clearMovieCloseTimer();

      movieCloseTimerRef.current = window.setTimeout(() => {
        finalizeMovieOpen();
      }, MOVIE_CLOSE_DELAY);
    },
    [
      closing,
      stopAllVoice,
      clearMovieCloseTimer,
      finalizeMovieOpen,
    ],
  );

  const handlePanelAnimationEnd = useCallback(
    (event: React.AnimationEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.animationName !== "friday-panel-close") return;
      if (closing) finalizeMovieOpen();
    },
    [closing, finalizeMovieOpen],
  );

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
      setVoiceError("");
      setCompleted(false);
      setInput("");

      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }

      try {
        await sendMessage({ text: content });
      } catch (sendError) {
        console.error("[Friday] Send failed:", sendError);
      }
    },
    [input, busy, sendMessage, stopAllVoice],
  );

  const resizeTextarea = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;

    element.style.height = "auto";

    const nextHeight = Math.min(element.scrollHeight, 110);
    element.style.height = `${nextHeight}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  const startListening = useCallback(() => {
    if (busy || listening || closing) return;

    setVoiceError("");

    if (
      typeof window === "undefined" ||
      !window.isSecureContext
    ) {
      setVoiceError(
        "语音识别需要安全连接，请使用 HTTPS 网站或 localhost。",
      );
      return;
    }

    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setVoiceError(
        "当前浏览器暂不支持语音识别，请使用键盘输入，或尝试更新浏览器。",
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
        // 忽略旧识别实例异常。
      }
    }

    const recognition = new SpeechRecognitionClass();

    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      if (recognitionRef.current !== recognition) return;

      setListening(true);
      setVoiceError("");
    };

    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;

      let finalText = "";
      let interimText = "";

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript || "";

        if (result.isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      const recognizedText = finalText || interimText;

      setInput(recognizedText.slice(0, MAX_INPUT_LENGTH));
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;

      recognitionRef.current = null;
      setListening(false);

      const message = getSpeechErrorMessage(event.error);

      if (message) {
        setVoiceError(message);
      }
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
      setVoiceError("语音识别启动失败，请检查麦克风权限后重试。");
    }
  }, [busy, listening, closing, stopSpeech]);

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
        console.error("[Friday] Speech synthesis failed:", speechError);

        if (utteranceRef.current === utterance) {
          utteranceRef.current = null;
        }

        setSpeaking(false);
      }
    },
    [voiceEnabled, stopSpeech],
  );

  useEffect(() => {
    if (status !== "ready" || !open) return;

    const lastAssistant = [...(messages as any[])]
      .reverse()
      .find((message) => message?.role === "assistant");

    if (!lastAssistant?.id) return;

    const text = getPartText(lastAssistant);
    if (!text.trim()) return;

    if (lastCompletedMessageRef.current === lastAssistant.id) {
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
  }, [messages, status, voiceEnabled, open, speakText]);

  useEffect(() => {
    if (!completed) return;

    const timer = window.setTimeout(() => {
      setCompleted(false);
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [completed]);

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
      clearMovieCloseTimer();

      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
      }

      if (typeof document !== "undefined") {
        document.body.classList.remove("friday-popup-lock");
      }
    };
  }, [stopAllVoice, clearMovieCloseTimer]);

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

    return () => window.clearTimeout(timer);
  }, [open]);

  const clearConversation = useCallback(() => {
    interrupt();
    setMessages([]);
    lastSpokenMessageRef.current = "";
    lastCompletedMessageRef.current = "";
    setCompleted(false);
    setVoiceError("");
    setInput("");

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  }, [interrupt, setMessages]);

  const clampFabPosition = useCallback(
    (position: { left: number; top: number }) => {
      const margin = 8;

      const maxLeft = Math.max(
        margin,
        window.innerWidth - FAB_SIZE - margin,
      );

      const maxTop = Math.max(
        margin,
        window.innerHeight - FAB_SIZE - margin,
      );

      return {
        left: Math.min(maxLeft, Math.max(margin, position.left)),
        top: Math.min(maxTop, Math.max(margin, position.top)),
      };
    },
    [],
  );

  useEffect(() => {
    if (!fabPosition) return;

    const handleResize = () => {
      setFabPosition((current) =>
        current ? clampFabPosition(current) : current,
      );
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [fabPosition, clampFabPosition]);

  const handleFabPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (open || closing) return;

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
    [open, closing],
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

      const nextPosition = clampFabPosition({
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
      });

      setFabPosition(nextPosition);
    },
    [clampFabPosition],
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

  if (!mounted) return null;

  const content = (
    <>
      <style jsx global>{`
        .friday-popup-lock {
          overflow: hidden !important;
          overscroll-behavior: none;
        }

        .friday-root {
          position: fixed;
          z-index: 99999;
          right: 22px;
          bottom: max(24px, env(safe-area-inset-bottom, 0px));
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
            "SF Pro Text", "PingFang SC", sans-serif;
        }

        /* 悬浮球按钮 */
        .friday-fab {
          position: relative;
          display: grid;
          place-items: center;
          width: 72px;
          height: 72px;
          padding: 0;
          overflow: visible;
          border: 0;
          border-radius: 50%;
          background: transparent;
          cursor: grab;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-fab:active {
          cursor: grabbing;
        }

        /* 球体统一视觉结构 */
        .friday-orb-visual {
          position: relative;
          isolation: isolate;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.36);
          border-radius: 46% 54% 52% 48% / 49% 44% 56% 51%;
          background: #080a12;
          box-shadow:
            0 10px 32px rgba(0,0,0,.38),
            0 0 24px rgba(119,133,255,.2),
            inset 0 1px 2px rgba(255,255,255,.25),
            inset 0 -8px 15px rgba(0,0,0,.7);
          animation: friday-orb-morph 9s ease-in-out infinite,
            friday-orb-breathe 4.8s ease-in-out infinite;
        }

        .friday-orb-core {
          position: absolute;
          z-index: 0;
          inset: 2px;
          border-radius: inherit;
          background:
            radial-gradient(
              ellipse at 28% 18%,
              rgba(255,255,255,.12),
              transparent 28%
            ),
            radial-gradient(
              ellipse at 75% 76%,
              rgba(99,83,190,.16),
              transparent 48%
            ),
            radial-gradient(
              ellipse at 50% 50%,
              #111522 0%,
              #080a12 65%,
              #03040a 100%
            );
          box-shadow:
            inset 0 0 18px rgba(0,0,0,.85),
            inset 0 1px 4px rgba(255,255,255,.13);
        }

        .friday-orb-refraction {
          position: absolute;
          z-index: 2;
          inset: 0;
          padding: 1.6px;
          border-radius: inherit;
          background: conic-gradient(
            from 0deg,
            rgba(100,158,255,.9),
            rgba(146,108,255,.95),
            rgba(255,169,123,.95),
            rgba(255,225,174,.92),
            rgba(93,224,214,.88),
            rgba(100,158,255,.9)
          );
          -webkit-mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          mask-composite: exclude;
          pointer-events: none;
          animation: friday-orb-spectrum 12s linear infinite;
        }

        .friday-orb-highlight {
          position: absolute;
          z-index: 3;
          top: 11%;
          left: 17%;
          width: 27%;
          height: 13%;
          border-radius: 50%;
          transform: rotate(-32deg);
          background: linear-gradient(
            90deg,
            rgba(255,255,255,.8),
            rgba(255,255,255,.12)
          );
          filter: blur(1px);
          opacity: .78;
          pointer-events: none;
        }

        .friday-fab .friday-orb-visual {
          width: 100%;
          height: 100%;
        }

        @keyframes friday-orb-morph {
          0%,100% {
            border-radius: 46% 54% 52% 48% / 49% 44% 56% 51%;
          }
          35% {
            border-radius: 55% 45% 44% 56% / 44% 56% 44% 56%;
          }
          70% {
            border-radius: 43% 57% 58% 42% / 55% 45% 55% 45%;
          }
        }

        @keyframes friday-orb-breathe {
          0%,100% {
            scale: .96;
            filter: brightness(.98);
          }
          50% {
            scale: 1.045;
            filter: brightness(1.13);
          }
        }

        @keyframes friday-orb-spectrum {
          from { filter: hue-rotate(0deg); }
          to { filter: hue-rotate(360deg); }
        }

        /* 面板 */
        .friday-panel {
          position: fixed;
          right: 18px;
          bottom: calc(112px + env(safe-area-inset-bottom, 0px));
          display: flex;
          flex-direction: column;
          width: min(540px, calc(100vw - 28px));
          height: min(720px, calc(100dvh - 135px));
          min-height: 380px;
          min-width: 0;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255,255,255,.19);
          border-radius: 36px;
          color: #fff;
          background:
            linear-gradient(
              145deg,
              rgba(255,255,255,.09),
              rgba(255,255,255,.018) 42%,
              rgba(255,255,255,.045)
            ),
            rgba(7,9,15,.94);
          -webkit-backdrop-filter: blur(30px) saturate(155%);
          backdrop-filter: blur(30px) saturate(155%);
          box-shadow:
            0 30px 100px rgba(0,0,0,.5),
            inset 0 1px 0 rgba(255,255,255,.2),
            inset 0 -1px 0 rgba(255,255,255,.055);
          transform-origin: bottom right;
          animation: friday-canvas-open .42s cubic-bezier(.2,.8,.2,1);
        }

        .friday-panel.friday-closing {
          pointer-events: none;
          animation: friday-panel-close .25s ease-in forwards;
        }

        @keyframes friday-canvas-open {
          from {
            opacity: 0;
            transform: translate3d(18px,24px,0) scale(.92);
          }
          to {
            opacity: 1;
            transform: translate3d(0,0,0) scale(1);
          }
        }

        @keyframes friday-panel-close {
          from {
            opacity: 1;
            transform: translate3d(0,0,0) scale(1);
          }
          to {
            opacity: 0;
            transform: translate3d(18px,18px,0) scale(.94);
          }
        }

        .friday-panel::before {
          position: absolute;
          z-index: -1;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          background:
            radial-gradient(
              ellipse at 50% 100%,
              rgba(255,215,145,.09),
              transparent 55%
            ),
            linear-gradient(
              120deg,
              rgba(255,255,255,.06),
              transparent 30%,
              transparent 70%,
              rgba(255,255,255,.035)
            );
          content: "";
        }

        .friday-panel.friday-expanded {
          right: 8px;
          bottom: 8px;
          width: calc(100vw - 16px);
          height: calc(100dvh - 16px);
          max-height: calc(100dvh - 16px);
          border-radius: 32px;
        }

        /* 极光背景 */
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
          transition: opacity 1s ease, height 1s ease, filter 1s ease;
        }

        .friday-aurora::before,
        .friday-aurora::after {
          position: absolute;
          inset: 0;
          pointer-events: none;
          content: "";
        }

        .friday-aurora::before {
          background: radial-gradient(
            ellipse 52% 72% at 50% 100%,
            rgba(255,255,255,.95),
            rgba(255,246,211,.85) 13%,
            rgba(255,207,94,.72) 30%,
            rgba(255,190,80,.25) 52%,
            transparent 76%
          );
          animation: friday-aurora-white 6s ease-in-out infinite;
        }

        .friday-aurora::after {
          inset: -10% -12% 0;
          background:
            radial-gradient(
              ellipse 48% 72% at 22% 100%,
              rgba(124,224,190,.4),
              transparent 72%
            ),
            radial-gradient(
              ellipse 48% 72% at 80% 100%,
              rgba(135,226,199,.35),
              transparent 72%
            ),
            radial-gradient(
              ellipse 60% 72% at 53% 100%,
              rgba(255,196,94,.34),
              transparent 76%
            );
          animation: friday-aurora-color 9s ease-in-out infinite alternate;
        }

        .friday-aurora-core {
          position: absolute;
          right: 8%;
          bottom: -4%;
          left: 8%;
          height: 48%;
          border-radius: 50%;
          background: radial-gradient(
            ellipse at 50% 100%,
            rgba(255,255,255,.85),
            rgba(255,220,128,.5) 28%,
            rgba(255,220,128,.08) 66%,
            transparent 78%
          );
          filter: blur(22px);
          opacity: .75;
          animation: friday-aurora-core 5.5s ease-in-out infinite;
        }

        @keyframes friday-aurora-white {
          0%,100% { transform: translateY(0) scaleX(1); opacity: .78; }
          50% { transform: translateY(-5%) scaleX(1.13); opacity: 1; }
        }

        @keyframes friday-aurora-color {
          0% { transform: translateX(-3%) scaleX(.94); }
          50% { transform: translate(2%,-4%) scaleX(1.08); }
          100% { transform: translateX(-1%) scaleX(1.02); }
        }

        @keyframes friday-aurora-core {
          0%,100% { transform: scale(.9); opacity: .58; }
          50% { transform: scale(1.14); opacity: .92; }
        }

        .friday-panel[data-state="standby"] .friday-aurora {
          height: 42%;
          opacity: .65;
          animation: friday-aurora-breathe 7s ease-in-out infinite;
        }

        @keyframes friday-aurora-breathe {
          0%,100% { transform: scaleX(.94) scaleY(.92); }
          50% { transform: scaleX(1.08) scaleY(1.08); }
        }

        .friday-panel[data-state="listening"] .friday-aurora {
          height: 47%;
          opacity: .83;
          animation: friday-aurora-listen 2.8s ease-in-out infinite;
        }

        @keyframes friday-aurora-listen {
          0%,100% { transform: scaleX(.98) scaleY(.96); }
          50% { transform: scaleX(1.08) scaleY(1.05); }
        }

        .friday-panel[data-state="thinking"] .friday-aurora {
          height: 54%;
          opacity: .96;
          filter: blur(19px);
          animation: friday-aurora-thinking 2.2s ease-in-out infinite;
        }

        @keyframes friday-aurora-thinking {
          0%,100% { transform: scaleX(1.15) scaleY(.88); }
          50% { transform: scaleX(.78) scaleY(1.12); }
        }

        .friday-panel[data-state="speaking"] .friday-aurora {
          height: 59%;
          opacity: 1;
          filter: blur(17px);
          animation: friday-aurora-speaking .72s ease-in-out infinite alternate;
        }

        @keyframes friday-aurora-speaking {
          from { transform: scaleX(.91) scaleY(.91); }
          to { transform: scaleX(1.13) scaleY(1.12); }
        }

        .friday-panel[data-state="completed"] .friday-aurora {
          height: 47%;
          opacity: .86;
          animation: friday-aurora-completed 1.8s ease-out both;
        }

        @keyframes friday-aurora-completed {
          0% { transform: scaleX(.72) scaleY(.8); opacity: 1; }
          65% { transform: scaleX(1.14) scaleY(1.12); opacity: .9; }
          100% { transform: scale(1); opacity: .65; }
        }

        /* 顶栏 */
        .friday-canvas-top {
          position: relative;
          z-index: 3;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          min-height: 60px;
          padding: 18px 23px 8px;
        }

        .friday-wordmark {
          color: rgba(255,255,255,.94);
          font-family: Georgia, "Times New Roman", serif;
          font-size: 25px;
          font-weight: 400;
          letter-spacing: -1px;
          text-shadow: 0 1px 12px rgba(255,255,255,.12);
        }

        .friday-state-wrap {
          display: flex;
          align-items: center;
          gap: 9px;
          color: rgba(255,255,255,.58);
          font-size: 10px;
          letter-spacing: 1.2px;
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
          0%,100% { opacity: .62; transform: scale(.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }

        /* 消息列表 */
        .friday-messages {
          position: relative;
          z-index: 1;
          flex: 1 1 auto;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 22px 27px 24px;
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
          color: rgba(255,255,255,.68);
          font-size: 15px;
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
          from { opacity: 0; transform: translateY(9px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .friday-message-content {
          max-width: 94%;
          color: rgba(255,255,255,.94);
          font-size: 16px;
          line-height: 1.85;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-message-user .friday-message-content {
          max-width: 86%;
          color: rgba(255,255,255,.78);
          text-align: right;
        }

        .friday-status {
          margin: 14px 0 18px;
          color: rgba(255,224,160,.86);
          font-size: 12px;
          letter-spacing: .4px;
          animation: friday-status-breathe 1.8s ease-in-out infinite;
        }

        .friday-error {
          margin: 12px 0;
          padding: 12px 14px;
          border: 1px solid rgba(248,113,113,.2);
          border-radius: 16px;
          background: rgba(127,29,29,.18);
          color: #fca5a5;
          font-size: 13px;
          line-height: 1.7;
        }

        /* 球体区域：正常 Flex 排版，不遮挡消息 */
        .friday-orb-stage {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex: 0 0 auto;
          gap: 12px;
          min-height: 90px;
          padding: 0 22px 10px;
          pointer-events: none;
        }

        .friday-orb-status {
          padding-bottom: 8px;
          color: rgba(255,255,255,.6);
          font-size: 11px;
          font-weight: 300;
          letter-spacing: .6px;
          text-shadow: 0 1px 10px rgba(0,0,0,.35);
        }

        .friday-orb-stage .friday-orb-visual {
          width: 86px;
          height: 86px;
          flex: 0 0 86px;
          box-shadow:
            0 0 35px rgba(110,132,255,.18),
            0 12px 35px rgba(0,0,0,.3),
            inset 0 1px 3px rgba(255,255,255,.2);
        }

        .friday-panel[data-state="listening"] .friday-orb-visual {
          animation-duration: 4s, 2.3s;
          filter: brightness(1.15);
        }

        .friday-panel[data-state="thinking"] .friday-orb-visual {
          animation-duration: 3s, 1.7s;
          filter: brightness(1.2) saturate(1.25);
        }

        .friday-panel[data-state="speaking"] .friday-orb-visual {
          animation-duration: 2.4s, 1s;
          filter: brightness(1.24);
        }

        /* 输入栏 */
        .friday-input-area {
          position: relative;
          z-index: 4;
          flex: 0 0 auto;
          margin-top: auto;
          padding: 14px 21px calc(14px + env(safe-area-inset-bottom, 0px));
          background: linear-gradient(
            to bottom,
            rgba(7,9,15,.84),
            rgba(7,9,15,.97)
          );
          -webkit-backdrop-filter: blur(24px) saturate(150%);
          backdrop-filter: blur(24px) saturate(150%);
          border-top: 1px solid rgba(255,255,255,.075);
        }

        .friday-input-box {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          min-height: 57px;
          padding: 9px 10px 9px 15px;
          border: 1px solid rgba(255,255,255,.24);
          border-radius: 28px;
          background:
            linear-gradient(
              145deg,
              rgba(255,255,255,.13),
              rgba(255,255,255,.045)
            ),
            rgba(22,23,29,.82);
          -webkit-backdrop-filter: blur(22px) saturate(160%);
          backdrop-filter: blur(22px) saturate(160%);
          box-shadow:
            0 12px 35px rgba(0,0,0,.25),
            inset 0 1px 0 rgba(255,255,255,.2);
        }

        .friday-plus-btn {
          display: grid;
          place-items: center;
          width: 34px;
          height: 37px;
          flex: 0 0 34px;
          padding: 0;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.78);
          font-size: 27px;
          font-weight: 200;
          cursor: pointer;
        }

        .friday-plus-btn:disabled {
          opacity: .55;
          cursor: default;
        }

        .friday-input-divider {
          width: 1px;
          height: 26px;
          flex: 0 0 1px;
          margin: 5px 1px;
          background: rgba(255,255,255,.19);
        }

        .friday-textarea {
          flex: 1;
          min-width: 0;
          max-height: 110px;
          resize: none;
          overflow-y: auto;
          border: 0;
          outline: 0;
          background: transparent;
          color: #fff;
          font-family: inherit;
          font-size: 14px;
          line-height: 1.65;
          padding: 7px 0;
        }

        .friday-textarea::placeholder {
          color: rgba(255,255,255,.54);
        }

        .friday-textarea:disabled {
          opacity: .5;
        }

        .friday-send-btn,
        .friday-mic-btn {
          display: grid;
          place-items: center;
          width: 39px;
          height: 39px;
          flex: 0 0 39px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 50%;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.92);
          cursor: pointer;
          font-size: 18px;
          transition: background .2s ease, transform .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-send-btn {
          border-color: rgba(255,255,255,.85);
          background: #f5f5f5;
          color: #151515;
          font-size: 21px;
          font-weight: 500;
        }

        .friday-send-btn:disabled {
          opacity: .42;
          cursor: not-allowed;
        }

        .friday-mic-btn.active {
          border-color: rgba(255,192,104,.6);
          background: rgba(255,175,75,.2);
          color: #ffd18b;
          animation: friday-status-breathe 1.5s ease-in-out infinite;
        }

        .friday-send-btn:active,
        .friday-mic-btn:active {
          transform: scale(.92);
        }

        .friday-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          min-height: 24px;
          margin-top: 8px;
          padding: 0 8px;
        }

        .friday-tool-group {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .friday-tool-btn {
          padding: 4px 2px;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.55);
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

        .friday-voice-error {
          margin: 8px 6px 0;
          color: #ffb4a8;
          font-size: 11px;
          line-height: 1.55;
        }

        /* 电影卡片 */
        .friday-movie-section {
          margin: 12px 0 27px;
        }

        .friday-result-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          color: rgba(255,255,255,.92);
          font-size: 12px;
          font-weight: 600;
        }

        .friday-result-count {
          color: rgba(255,255,255,.55);
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
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 16px;
          background: rgba(255,255,255,.075);
          -webkit-backdrop-filter: blur(15px);
          backdrop-filter: blur(15px);
          color: white;
          text-align: left;
          cursor: pointer;
          transition: background .2s ease, transform .2s ease;
        }

        .friday-movie-card:active {
          background: rgba(255,255,255,.14);
          transform: scale(.985);
        }

        .friday-poster {
          position: relative;
          width: 55px;
          height: 78px;
          flex: 0 0 55px;
          overflow: hidden;
          border-radius: 9px;
          background: rgba(20,22,27,.8);
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
          color: rgba(255,255,255,.96);
          font-size: 12px;
          font-weight: 600;
          line-height: 1.5;
        }

        .friday-movie-meta {
          margin-top: 5px;
          overflow: hidden;
          color: rgba(255,255,255,.55);
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-source {
          margin-top: 5px;
          overflow: hidden;
          color: rgba(255,220,160,.85);
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-empty-result {
          margin: 12px 0;
          color: rgba(255,255,255,.65);
          font-size: 13px;
        }

        /* 移动端 */
        @media (max-width: 600px) {
          .friday-panel {
            right: 8px;
            bottom: 0;
            width: calc(100vw - 16px);
            height: calc(100dvh - 8px);
            max-height: calc(100dvh - 8px);
            min-height: 320px;
            border-radius: 30px 30px 0 0;
          }

          .friday-panel.friday-expanded {
            right: 4px;
            bottom: 0;
            width: calc(100vw - 8px);
            height: 100dvh;
            max-height: 100dvh;
            border-radius: 28px 28px 0 0;
          }

          .friday-canvas-top {
            padding:
              max(16px, env(safe-area-inset-top, 0px))
              19px 6px;
          }

          .friday-messages {
            padding: 19px 21px 18px;
          }

          .friday-welcome {
            min-height: 235px;
          }

          .friday-welcome-title {
            font-size: clamp(29px, 8vw, 38px);
          }

          .friday-input-area {
            padding-right: 12px;
            padding-left: 12px;
          }

          .friday-orb-stage {
            min-height: 78px;
            padding-right: 17px;
            padding-bottom: 7px;
          }

          .friday-orb-stage .friday-orb-visual {
            width: 72px;
            height: 72px;
            flex-basis: 72px;
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
            border-radius: 24px;
          }

          .friday-canvas-top {
            min-height: 42px;
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
          }

          .friday-tools {
            margin-top: 4px;
          }

          .friday-orb-stage {
            min-height: 64px;
          }

          .friday-orb-stage .friday-orb-visual {
            width: 58px;
            height: 58px;
            flex-basis: 58px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .friday-fab *,
          .friday-panel,
          .friday-aurora,
          .friday-aurora::before,
          .friday-aurora::after,
          .friday-aurora-core,
          .friday-orb-visual,
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

        @supports not (
          (backdrop-filter: blur(1px)) or
          (-webkit-backdrop-filter: blur(1px))
        ) {
          .friday-panel {
            background: rgba(7,9,15,.97);
          }

          .friday-input-box,
          .friday-movie-card {
            background: rgba(35,37,44,.96);
          }
        }
      `}</style>

      <div className="friday-root">
        {!open && !closing ? (
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
            <OrbVisual />
          </button>
        ) : null}

        {open || closing ? (
          <section
            className={`friday-panel ${
              expanded ? "friday-expanded" : ""
            } ${closing ? "friday-closing" : ""}`}
            data-state={auroraState}
            aria-label="Friday 空间式 AI 助手"
            aria-hidden={closing}
            onAnimationEnd={handlePanelAnimationEnd}
          >
            <div className="friday-aurora" aria-hidden="true">
              <div className="friday-aurora-core" />
            </div>

            <div className="friday-canvas-top">
              <div className="friday-wordmark">Friday</div>

              <div className="friday-state-wrap">
                <span>{stateLabel || " "}</span>

                <button
                  type="button"
                  className="friday-status-dot"
                  title="收起 Friday"
                  aria-label="收起 Friday"
                  onClick={closePanel}
                />
              </div>
            </div>

            <div ref={messagesRef} className="friday-messages">
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
                const messageMovies = getMovieDataForMessage(message);

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

            <div className="friday-orb-stage">
              <span className="friday-orb-status">{stateLabel}</span>
              <OrbVisual />
            </div>

            <footer className="friday-input-area">
              <div className="friday-input-box">
                <button
                  type="button"
                  className="friday-plus-btn"
                  aria-label="附加功能"
                  title="附加功能暂未接入"
                  disabled
                >
                  +
                </button>

                <div className="friday-input-divider" />

                <textarea
                  ref={inputRef}
                  className="friday-textarea"
                  value={input}
                  rows={1}
                  maxLength={MAX_INPUT_LENGTH}
                  placeholder={
                    listening ? "正在聆听…" : "询问 Friday..."
                  }
                  disabled={busy || closing}
                  onChange={(event) => {
                    setInput(
                      event.target.value.slice(0, MAX_INPUT_LENGTH),
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
                  disabled={busy || closing}
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
                  {listening ? "Ⅱ" : "♩"}
                </button>

                <button
                  type="button"
                  className="friday-send-btn"
                  disabled={busy || closing || !input.trim()}
                  aria-label="发送消息"
                  onClick={() => void handleSend()}
                >
                  ↑
                </button>
              </div>

              {voiceError ? (
                <div className="friday-voice-error" role="status">
                  {voiceError}
                </div>
              ) : null}

              <div className="friday-tools">
                <div className="friday-tool-group">
                  <button
                    type="button"
                    className={`friday-tool-btn ${
                      voiceEnabled ? "active" : ""
                    }`}
                    onClick={() => {
                      if (voiceEnabled) stopSpeech();
                      setVoiceEnabled((value) => !value);
                    }}
                  >
                    {voiceEnabled ? "语音开启" : "语音关闭"}
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
                    {expanded ? "收缩" : "展开"}
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
