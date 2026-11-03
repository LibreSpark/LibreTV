
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

type MessagePartLike = {
  type?: string;
  text?: string;
  data?: unknown;
};

type MessageLike = {
  id: string;
  role: string;
  parts?: MessagePartLike[];
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

function getPartText(message: MessageLike): string {
  if (!Array.isArray(message.parts)) return "";

  return message.parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("");
}

function getMovieDataForMessage(message: MessageLike): MovieData[] {
  if (!Array.isArray(message.parts)) return [];

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
            movie.vodId ?? "",
            movie.name || "",
            movie.vodId == null ? index : "",
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
      <div className="friday-orb-inner" />
      <div className="friday-orb-fluid" />
      <div className="friday-orb-rim" />
      <div className="friday-orb-glint" />
      <div className="friday-orb-glint-small" />
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
  const pendingVoiceTextRef = useRef("");
  const handleSendRef = useRef<(text?: string) => Promise<void>>(
    async () => {},
  );

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

  const typedMessages = messages as unknown as MessageLike[];
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
      ? "正在聆听"
      : auroraState === "thinking"
        ? "正在寻找合适的影视资源"
        : auroraState === "speaking"
          ? "Friday 正在回复"
          : auroraState === "completed"
            ? "已完成"
            : "随时为你服务";

  const stopSpeech = useCallback(() => {
    utteranceRef.current = null;
    cancelBrowserSpeech();
    setSpeaking(false);
  }, []);

  const stopAllVoice = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    pendingVoiceTextRef.current = "";

    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // 忽略浏览器 abort 异常。
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

  const handleSend = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();

      if (!content || busy || closing) return;
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
    [input, busy, closing, sendMessage, stopAllVoice],
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

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
        // 忽略旧实例异常。
      }
    }

    pendingVoiceTextRef.current = "";

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

      const recognizedText = (finalText || interimText)
        .trim()
        .slice(0, MAX_INPUT_LENGTH);

      if (recognizedText) {
        setInput(recognizedText);
      }

      if (finalText.trim()) {
        pendingVoiceTextRef.current = finalText
          .trim()
          .slice(0, MAX_INPUT_LENGTH);
      }
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

      const finalText = pendingVoiceTextRef.current.trim();
      pendingVoiceTextRef.current = "";

      if (finalText && !busy) {
        setInput("");
        void handleSendRef.current(finalText);
      }
    };

    recognitionRef.current = recognition;

    try {
      // 必须在用户点击事件的同步调用链内启动。
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

  const openPanel = useCallback(() => {
    clearMovieCloseTimer();

    pendingMovieRef.current = null;
    movieDispatchedRef.current = false;

    setClosing(false);
    setOpen(true);
    setExpanded(false);
    setVoiceError("");

    if (typeof document !== "undefined") {
      document.body.classList.add("friday-popup-lock");
    }
  }, [clearMovieCloseTimer]);

  const openAndListen = useCallback(() => {
    openPanel();

    // 不放进 useEffect 或 setTimeout，尽量保留点击手势授权。
    startListening();
  }, [openPanel, startListening]);

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
    [closing, stopAllVoice, clearMovieCloseTimer, finalizeMovieOpen],
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

    const lastAssistant = [...typedMessages]
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
  }, [typedMessages, status, voiceEnabled, open, speakText]);

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

  const resizeTextarea = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;

    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 110)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

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
    const handleResize = () => {
      setFabPosition((current) =>
        current ? clampFabPosition(current) : current,
      );
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [clampFabPosition]);

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
        // 某些浏览器不支持 pointer capture。
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

      setFabPosition(
        clampFabPosition({
          left: event.clientX - drag.offsetX,
          top: event.clientY - drag.offsetY,
        }),
      );
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
      }, 350);
    },
    [],
  );

  const handleFabClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    openAndListen();
  }, [openAndListen]);

  const lastAssistantMessage = [...typedMessages]
    .reverse()
    .find((message) => message.role === "assistant");

  const latestAssistantText = lastAssistantMessage
    ? getPartText(lastAssistantMessage)
    : "";

  const latestMovieData = lastAssistantMessage
    ? getMovieDataForMessage(lastAssistantMessage)
    : [];

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
          color: #fff;
          pointer-events: none;
        }

        .friday-root button,
        .friday-root textarea,
        .friday-root section {
          pointer-events: auto;
        }

        /* ================================
           V2.1 液态玻璃球
        ================================= */

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
          filter: drop-shadow(0 9px 18px rgba(0,0,0,.25));
        }

        .friday-fab:active {
          cursor: grabbing;
        }

        .friday-orb-visual {
          position: relative;
          isolation: isolate;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.48);
          border-radius: 46% 54% 52% 48% / 49% 44% 56% 51%;
          background:
            radial-gradient(
              ellipse at 28% 17%,
              rgba(255,255,255,.22),
              transparent 24%
            ),
            radial-gradient(
              ellipse at 75% 80%,
              rgba(92,95,160,.14),
              transparent 46%
            ),
            rgba(15,18,29,.19);
          box-shadow:
            0 0 0 1px rgba(255,255,255,.08),
            0 0 19px rgba(111,194,255,.15),
            0 0 32px rgba(190,117,255,.13),
            inset 0 1px 2px rgba(255,255,255,.48),
            inset 0 -2px 7px rgba(0,0,0,.19);
          -webkit-backdrop-filter: blur(2px) saturate(175%);
          backdrop-filter: blur(2px) saturate(175%);
          animation:
            friday-orb-morph 9s ease-in-out infinite,
            friday-orb-breathe 4.8s ease-in-out infinite;
          transition:
            border-radius .45s ease,
            transform .45s cubic-bezier(.2,.8,.2,1);
        }

        .friday-orb-inner {
          position: absolute;
          z-index: 0;
          inset: 3px;
          border-radius: inherit;
          background:
            radial-gradient(
              ellipse at 29% 18%,
              rgba(255,255,255,.17),
              transparent 25%
            ),
            radial-gradient(
              ellipse at 70% 72%,
              rgba(113,99,183,.13),
              transparent 43%
            ),
            radial-gradient(
              ellipse at 50% 52%,
              rgba(17,23,38,.18),
              rgba(9,13,25,.11) 60%,
              rgba(3,5,12,.24) 100%
            );
          box-shadow:
            inset 0 0 9px rgba(0,0,0,.18),
            inset 0 1px 3px rgba(255,255,255,.22);
        }

        .friday-orb-fluid {
          position: absolute;
          z-index: 1;
          inset: 8%;
          border-radius: 48% 52% 57% 43% / 55% 43% 57% 45%;
          background:
            radial-gradient(
              ellipse at 20% 38%,
              rgba(102,231,255,.27),
              transparent 39%
            ),
            radial-gradient(
              ellipse at 82% 32%,
              rgba(183,132,255,.25),
              transparent 38%
            ),
            radial-gradient(
              ellipse at 55% 90%,
              rgba(255,180,135,.2),
              transparent 44%
            );
          mix-blend-mode: screen;
          opacity: .78;
          animation: friday-fluid-drift 8s ease-in-out infinite alternate;
          pointer-events: none;
        }

        .friday-orb-rim {
          position: absolute;
          z-index: 2;
          inset: 0;
          padding: 1.7px;
          border-radius: inherit;
          background: conic-gradient(
            from 15deg,
            rgba(120,220,255,.95),
            rgba(185,151,255,.92),
            rgba(255,211,180,.94),
            rgba(255,255,255,.98),
            rgba(104,233,221,.94),
            rgba(115,155,255,.95),
            rgba(120,220,255,.95)
          );
          -webkit-mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask:
            linear-gradient(#fff 0 0) content-box,
            linear-gradient(#fff 0 0);
          mask-composite: exclude;
          filter: drop-shadow(0 0 2px rgba(167,220,255,.55));
          pointer-events: none;
          animation: friday-orb-spectrum 12s linear infinite;
        }

        .friday-orb-glint {
          position: absolute;
          z-index: 3;
          top: 10%;
          left: 17%;
          width: 29%;
          height: 11%;
          border-radius: 50%;
          transform: rotate(-32deg);
          background: linear-gradient(
            90deg,
            rgba(255,255,255,.94),
            rgba(255,255,255,.38) 60%,
            transparent
          );
          filter: blur(.25px);
          opacity: .9;
          pointer-events: none;
        }

        .friday-orb-glint-small {
          position: absolute;
          z-index: 3;
          top: 23%;
          left: 13%;
          width: 8%;
          height: 4%;
          border-radius: 50%;
          background: rgba(255,255,255,.9);
          box-shadow: 0 0 6px rgba(255,255,255,.65);
          transform: rotate(-32deg);
          pointer-events: none;
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
          0%,100% { transform: scale(.97); filter: brightness(1); }
          50% { transform: scale(1.045); filter: brightness(1.16); }
        }

        @keyframes friday-orb-spectrum {
          from { filter: hue-rotate(0deg); }
          to { filter: hue-rotate(360deg); }
        }

        @keyframes friday-fluid-drift {
          0% { transform: translate(-3%,2%) rotate(-8deg) scale(.94); }
          50% { transform: translate(3%,-2%) rotate(8deg) scale(1.08); }
          100% { transform: translate(-1%,3%) rotate(3deg) scale(1.02); }
        }

        .friday-fab:active .friday-orb-visual {
          transform: scale(.86);
          border-radius: 42% 58% 60% 40% / 57% 43% 57% 43%;
        }

        /* ================================
           Siri 式胶囊容器
        ================================= */

        .friday-panel {
          position: fixed;
          right: 18px;
          bottom: calc(110px + env(safe-area-inset-bottom, 0px));
          display: flex;
          flex-direction: column;
          width: min(500px, calc(100vw - 28px));
          max-height: min(430px, calc(100dvh - 130px));
          min-height: 176px;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255,255,255,.27);
          border-radius: 29px;
          color: #fff;
          background:
            linear-gradient(
              145deg,
              rgba(255,255,255,.16),
              rgba(255,255,255,.035) 45%,
              rgba(255,255,255,.075)
            ),
            rgba(12,15,25,.77);
          -webkit-backdrop-filter: blur(32px) saturate(165%);
          backdrop-filter: blur(32px) saturate(165%);
          box-shadow:
            0 22px 75px rgba(0,0,0,.36),
            inset 0 1px 0 rgba(255,255,255,.3),
            inset 0 -1px 0 rgba(255,255,255,.06);
          transform-origin: bottom right;
          animation: friday-capsule-in .48s cubic-bezier(.18,.82,.2,1);
        }

        @keyframes friday-capsule-in {
          0% {
            opacity: 0;
            transform: translate3d(24px,35px,0) scale(.72);
            border-radius: 50px;
          }
          65% {
            opacity: 1;
            transform: translate3d(-3px,-3px,0) scale(1.025);
          }
          100% {
            transform: translate3d(0,0,0) scale(1);
            border-radius: 29px;
          }
        }

        .friday-panel.friday-expanded {
          right: 8px;
          bottom: 8px;
          width: min(650px, calc(100vw - 16px));
          height: min(780px, calc(100dvh - 16px));
          max-height: calc(100dvh - 16px);
          min-height: 320px;
          border-radius: 34px;
          animation: friday-expanded-in .38s cubic-bezier(.2,.8,.2,1);
        }

        @keyframes friday-expanded-in {
          from {
            opacity: .7;
            transform: translateY(24px) scale(.97);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .friday-panel.friday-closing {
          pointer-events: none;
          animation: friday-panel-close .25s ease-in forwards;
        }

        @keyframes friday-panel-close {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: translate(16px,15px) scale(.94); }
        }

        .friday-panel::before {
          position: absolute;
          z-index: -1;
          inset: 0;
          border-radius: inherit;
          background:
            radial-gradient(
              ellipse at 50% 110%,
              rgba(115,183,255,.19),
              transparent 55%
            ),
            radial-gradient(
              ellipse at 90% 0%,
              rgba(203,143,255,.13),
              transparent 45%
            );
          content: "";
          pointer-events: none;
        }

        /* 胶囊顶部 */

        .friday-canvas-top {
          position: relative;
          z-index: 3;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          min-height: 48px;
          padding: 13px 18px 4px;
        }

        .friday-wordmark {
          color: rgba(255,255,255,.96);
          font-family: Georgia, "Times New Roman", serif;
          font-size: 21px;
          font-weight: 400;
          letter-spacing: -.8px;
          text-shadow: 0 1px 12px rgba(255,255,255,.15);
        }

        .friday-state-wrap {
          display: flex;
          align-items: center;
          gap: 9px;
          color: rgba(255,255,255,.67);
          font-size: 11px;
        }

        .friday-status-dot {
          width: 9px;
          height: 9px;
          flex: 0 0 9px;
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: #8de7dc;
          box-shadow: 0 0 8px rgba(116,239,224,.8);
          cursor: pointer;
          animation: friday-dot-pulse 1.8s ease-in-out infinite;
        }

        @keyframes friday-dot-pulse {
          0%,100% { opacity: .6; transform: scale(.85); }
          50% { opacity: 1; transform: scale(1.18); }
        }

        /* 消息区域 */

        .friday-messages {
          position: relative;
          z-index: 1;
          flex: 1 1 auto;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 10px 19px 14px;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,.17) transparent;
        }

        .friday-panel:not(.friday-expanded) .friday-messages {
          max-height: 180px;
        }

        .friday-welcome {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-height: 82px;
          padding: 4px 0 12px;
        }

        .friday-welcome-kicker {
          margin-bottom: 7px;
          color: rgba(255,255,255,.43);
          font-size: 9px;
          letter-spacing: 2px;
        }

        .friday-welcome-title {
          margin: 0 0 5px;
          color: #fff;
          font-size: 20px;
          font-weight: 500;
          letter-spacing: -.6px;
        }

        .friday-welcome-text {
          color: rgba(255,255,255,.65);
          font-size: 12px;
          line-height: 1.7;
        }

        .friday-message {
          display: flex;
          justify-content: flex-start;
          margin: 0 0 12px;
          animation: friday-message-in .3s ease both;
        }

        .friday-message-user {
          justify-content: flex-end;
        }

        @keyframes friday-message-in {
          from { opacity: 0; transform: translateY(7px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .friday-message-content {
          max-width: 96%;
          color: rgba(255,255,255,.95);
          font-size: 13px;
          line-height: 1.75;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-message-user .friday-message-content {
          max-width: 86%;
          padding: 8px 12px;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 16px 16px 4px 16px;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.86);
        }

        .friday-status {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 7px 0 12px;
          color: rgba(202,226,255,.88);
          font-size: 11px;
          animation: friday-status-pulse 1.8s ease-in-out infinite;
        }

        .friday-status::before {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #9edfff;
          box-shadow: 0 0 9px #9edfff;
          content: "";
        }

        @keyframes friday-status-pulse {
          0%,100% { opacity: .6; }
          50% { opacity: 1; }
        }

        .friday-error {
          margin: 9px 0;
          padding: 10px 12px;
          border: 1px solid rgba(248,113,113,.2);
          border-radius: 14px;
          background: rgba(127,29,29,.18);
          color: #fca5a5;
          font-size: 12px;
          line-height: 1.6;
        }

        /* 球体与状态波纹 */

        .friday-orb-stage {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          gap: 10px;
          min-height: 42px;
          padding: 0 15px 9px;
          pointer-events: none;
        }

        .friday-orb-stage .friday-orb-visual {
          width: 38px;
          height: 38px;
          flex: 0 0 38px;
        }

        .friday-orb-status {
          color: rgba(255,255,255,.69);
          font-size: 11px;
          letter-spacing: .3px;
        }

        .friday-panel[data-state="listening"] .friday-orb-visual {
          animation-duration: 5s, 1.5s;
          filter: brightness(1.22);
        }

        .friday-panel[data-state="thinking"] .friday-orb-visual {
          animation-duration: 2.5s, 1.1s;
          filter: brightness(1.24) saturate(1.3);
        }

        .friday-panel[data-state="speaking"] .friday-orb-visual {
          animation-duration: 2s, .75s;
          filter: brightness(1.28);
        }

        /* 输入栏 */

        .friday-input-area {
          position: relative;
          z-index: 4;
          flex: 0 0 auto;
          padding: 10px 13px calc(11px + env(safe-area-inset-bottom, 0px));
          border-top: 1px solid rgba(255,255,255,.1);
          background: rgba(10,13,22,.27);
          -webkit-backdrop-filter: blur(18px);
          backdrop-filter: blur(18px);
        }

        .friday-input-box {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          min-height: 47px;
          padding: 6px 7px 6px 12px;
          border: 1px solid rgba(255,255,255,.24);
          border-radius: 25px;
          background:
            linear-gradient(
              145deg,
              rgba(255,255,255,.15),
              rgba(255,255,255,.045)
            ),
            rgba(22,25,35,.48);
          -webkit-backdrop-filter: blur(22px) saturate(160%);
          backdrop-filter: blur(22px) saturate(160%);
          box-shadow:
            0 8px 25px rgba(0,0,0,.16),
            inset 0 1px 0 rgba(255,255,255,.2);
        }

        .friday-plus-btn {
          display: grid;
          place-items: center;
          width: 30px;
          height: 34px;
          flex: 0 0 30px;
          padding: 0;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.8);
          font-size: 24px;
          font-weight: 200;
          cursor: pointer;
        }

        .friday-plus-btn:disabled {
          opacity: .45;
          cursor: default;
        }

        .friday-input-divider {
          width: 1px;
          height: 23px;
          flex: 0 0 1px;
          margin: 5px 1px;
          background: rgba(255,255,255,.18);
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
          font-size: 13px;
          line-height: 1.65;
          padding: 6px 0;
        }

        .friday-textarea::placeholder {
          color: rgba(255,255,255,.53);
        }

        .friday-textarea:disabled {
          opacity: .5;
        }

        .friday-send-btn,
        .friday-mic-btn {
          display: grid;
          place-items: center;
          width: 35px;
          height: 35px;
          flex: 0 0 35px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 50%;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.94);
          cursor: pointer;
          font-size: 17px;
          transition: background .2s ease, transform .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-send-btn {
          border-color: rgba(255,255,255,.8);
          background: #f5f5f5;
          color: #151515;
          font-size: 20px;
        }

        .friday-send-btn:disabled {
          opacity: .4;
          cursor: not-allowed;
        }

        .friday-mic-btn.active {
          border-color: rgba(130,221,255,.7);
          background: rgba(89,185,255,.23);
          color: #b8eaff;
          animation: friday-dot-pulse 1.4s ease-in-out infinite;
        }

        .friday-send-btn:active,
        .friday-mic-btn:active {
          transform: scale(.91);
        }

        .friday-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 22px;
          margin-top: 5px;
          padding: 0 7px;
        }

        .friday-tool-group {
          display: flex;
          align-items: center;
          gap: 11px;
        }

        .friday-tool-btn {
          padding: 4px 2px;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.57);
          cursor: pointer;
          font-family: inherit;
          font-size: 10px;
        }

        .friday-tool-btn.active {
          color: #a9dcff;
        }

        .friday-tool-btn:disabled {
          opacity: .35;
          cursor: not-allowed;
        }

        .friday-voice-error {
          margin: 6px 6px 0;
          color: #ffb4a8;
          font-size: 10px;
          line-height: 1.55;
        }

        /* 影视结果 */

        .friday-movie-section {
          margin: 10px 0 16px;
        }

        .friday-result-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 10px;
          color: rgba(255,255,255,.93);
          font-size: 11px;
          font-weight: 600;
        }

        .friday-result-count {
          color: rgba(255,255,255,.55);
          font-weight: 400;
        }

        .friday-movie-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }

        .friday-movie-card {
          display: flex;
          min-width: 0;
          gap: 8px;
          padding: 7px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 14px;
          background: rgba(255,255,255,.075);
          color: white;
          text-align: left;
          cursor: pointer;
          transition: background .2s ease, transform .2s ease;
        }

        .friday-movie-card:active {
          background: rgba(255,255,255,.15);
          transform: scale(.985);
        }

        .friday-poster {
          position: relative;
          width: 48px;
          height: 68px;
          flex: 0 0 48px;
          overflow: hidden;
          border-radius: 8px;
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
          font-size: 8px;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-info {
          min-width: 0;
          flex: 1;
          padding: 2px 0;
        }

        .friday-movie-name {
          display: -webkit-box;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          color: rgba(255,255,255,.96);
          font-size: 11px;
          font-weight: 600;
          line-height: 1.5;
        }

        .friday-movie-meta {
          margin-top: 4px;
          overflow: hidden;
          color: rgba(255,255,255,.55);
          font-size: 9px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-source {
          margin-top: 4px;
          overflow: hidden;
          color: rgba(190,221,255,.85);
          font-size: 9px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-empty-result {
          margin: 10px 0;
          color: rgba(255,255,255,.65);
          font-size: 12px;
        }

        /* 展开模式 */

        .friday-expanded .friday-messages {
          max-height: none;
          padding: 20px 24px;
        }

        .friday-expanded .friday-welcome {
          min-height: 220px;
        }

        .friday-expanded .friday-welcome-title {
          font-size: 34px;
        }

        .friday-expanded .friday-message-content {
          font-size: 15px;
        }

        .friday-expanded .friday-orb-stage {
          min-height: 62px;
        }

        .friday-expanded .friday-orb-stage .friday-orb-visual {
          width: 56px;
          height: 56px;
          flex-basis: 56px;
        }

        /* 移动端 */

        @media (max-width: 600px) {
          .friday-root {
            right: 16px;
            bottom: max(20px, env(safe-area-inset-bottom, 0px));
          }

          .friday-panel {
            right: 8px;
            bottom: calc(100px + env(safe-area-inset-bottom, 0px));
            width: calc(100vw - 16px);
            max-height: min(390px, calc(100dvh - 115px));
            border-radius: 26px;
          }

          .friday-panel.friday-expanded {
            right: 4px;
            bottom: 0;
            width: calc(100vw - 8px);
            height: 100dvh;
            max-height: 100dvh;
            border-radius: 27px 27px 0 0;
          }

          .friday-canvas-top {
            padding:
              max(13px, env(safe-area-inset-top, 0px))
              16px 4px;
          }

          .friday-messages {
            padding-right: 15px;
            padding-left: 15px;
          }

          .friday-expanded .friday-messages {
            padding: 18px 17px;
          }

          .friday-input-area {
            padding-right: 10px;
            padding-left: 10px;
          }

          .friday-movie-grid {
            gap: 7px;
          }

          .friday-movie-card {
            gap: 6px;
            padding: 6px;
          }

          .friday-poster {
            width: 43px;
            height: 63px;
            flex-basis: 43px;
          }

          .friday-fab {
            width: 68px;
            height: 68px;
          }
        }

        @media (max-height: 520px) {
          .friday-panel.friday-expanded {
            bottom: 4px;
            height: calc(100dvh - 8px);
            min-height: 0;
            border-radius: 22px;
          }

          .friday-canvas-top {
            min-height: 40px;
            padding-top: 8px;
          }

          .friday-expanded .friday-welcome {
            min-height: 120px;
          }

          .friday-orb-stage {
            min-height: 34px;
          }

          .friday-input-area {
            padding-top: 6px;
          }

          .friday-tools {
            margin-top: 2px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .friday-fab *,
          .friday-panel,
          .friday-orb-visual,
          .friday-orb-fluid,
          .friday-orb-rim,
          .friday-status-dot,
          .friday-message,
          .friday-status {
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
            background: rgba(12,15,25,.97);
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
            aria-label="打开 Friday 并开始语音聆听"
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
            aria-label="Friday AI 助手"
            aria-hidden={closing}
            onAnimationEnd={handlePanelAnimationEnd}
          >
            <div className="friday-canvas-top">
              <div className="friday-wordmark">Friday</div>

              <div className="friday-state-wrap">
                <span>{stateLabel}</span>

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
                    {listening
                      ? "我正在聆听。告诉我你想看什么电影或电视剧。"
                      : "告诉我你想看什么，或者让我帮你寻找更好的影视资源。"}
                  </div>
                </div>
              ) : null}

              {typedMessages.map((message) => {
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
                    : "正在为你寻找合适的影视资源…"}
                </div>
              ) : null}

              {error ? (
                <div className="friday-error">
                  {error.message || "请求失败，请稍后重试。"}
                </div>
              ) : null}
            </div>

            <div className="friday-orb-stage">
              <span className="friday-orb-status">
                {listening
                  ? "请说出你想看的影片"
                  : busy
                    ? "正在连接影视资源"
                    : speaking
                      ? "正在为你播报"
                      : completed
                        ? "已经为你准备好了"
                        : "Friday 随时待命"}
              </span>
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
                    className="friday-tool-btn active"
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded ? "收起面板" : "展开对话"}
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
