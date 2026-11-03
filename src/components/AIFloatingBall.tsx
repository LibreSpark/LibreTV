
"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { fridayReducer, initialFridayState } from "@/lib/friday/state";

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
const FAB_SIZE = 68;
const DRAG_THRESHOLD = 6;
const MOVIE_CLOSE_DELAY = 250;
const VOICE_RESUME_DELAY = 700;

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
      return "没有检测到语音，请点击麦克风重新聆听。";
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
  const [machineState, dispatchMachine] = useReducer(
    fridayReducer,
    initialFridayState,
  );

  const requestSequenceRef = useRef(0);
  const activeRequestIdRef = useRef(0);
  const observedBusyRef = useRef(false);

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
  const [fabHidden, setFabHidden] = useState(false);
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const [fabPosition, setFabPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const openRef = useRef(false);
  const closingRef = useRef(false);
  const busyRef = useRef(false);
  const listeningRef = useRef(false);
  const voiceSessionActiveRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const recognitionErrorRef = useRef("");
  const pendingVoiceTextRef = useRef("");
  const manualVoiceStopRef = useRef(false);
  const voiceResumeTimerRef = useRef<number | null>(null);

  const lastSpokenMessageRef = useRef("");
  const lastCompletedMessageRef = useRef("");

  const handleSendRef = useRef<
    (text?: string, keepVoiceSession?: boolean) => Promise<void>
  >(async () => {});

  const startListeningRef = useRef<(automatic?: boolean) => void>(() => {});

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

  useEffect(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;

    if (error) {
      dispatchMachine({
        type: "REQUEST_FAILED",
        requestId,
        code: "chat_request_failed",
        message: error.message || "消息请求失败",
      });
      activeRequestIdRef.current = 0;
      observedBusyRef.current = false;
      return;
    }

    if (busy) {
      observedBusyRef.current = true;
      return;
    }

    if (observedBusyRef.current) {
      dispatchMachine({ type: "RESPONSE_COMPLETED", requestId });
      activeRequestIdRef.current = 0;
      observedBusyRef.current = false;
    }
  }, [busy, error]);

  // 同步引用，避免回调读取到上一轮渲染的状态。
  busyRef.current = busy;
  listeningRef.current = listening;
  closingRef.current = closing;

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

  const clearVoiceResumeTimer = useCallback(() => {
    if (voiceResumeTimerRef.current !== null) {
      window.clearTimeout(voiceResumeTimerRef.current);
      voiceResumeTimerRef.current = null;
    }
  }, []);

  const setVoiceSession = useCallback((active: boolean) => {
    voiceSessionActiveRef.current = active;
    setVoiceSessionActive(active);

    if (!active) {
      dispatchMachine({
        type: "VOICE_STOP",
        sessionId: voiceSessionIdRef.current,
      });
      voiceSessionIdRef.current += 1;
    }
  }, []);

  const stopSpeech = useCallback(() => {
    utteranceRef.current = null;
    cancelBrowserSpeech();
    setSpeaking(false);
  }, []);

  const stopRecognition = useCallback((abort = true) => {
    const recognition = recognitionRef.current;

    recognitionRef.current = null;
    listeningRef.current = false;
    pendingVoiceTextRef.current = "";
    recognitionErrorRef.current = "";
    setListening(false);

    if (!recognition) return;

    try {
      if (abort) {
        recognition.abort();
      } else {
        recognition.stop();
      }
    } catch {
      // 忽略浏览器识别实例已结束的异常。
    }
  }, []);

  const stopAllVoice = useCallback(() => {
    setVoiceSession(false);
    clearVoiceResumeTimer();
    stopRecognition(true);
    stopSpeech();
  }, [
    setVoiceSession,
    clearVoiceResumeTimer,
    stopRecognition,
    stopSpeech,
  ]);

  const clearMovieCloseTimer = useCallback(() => {
    if (movieCloseTimerRef.current !== null) {
      window.clearTimeout(movieCloseTimerRef.current);
      movieCloseTimerRef.current = null;
    }
  }, []);

  const scheduleVoiceResume = useCallback(() => {
    clearVoiceResumeTimer();

    if (!voiceSessionActiveRef.current) return;
    if (!openRef.current || closingRef.current) return;
    if (busyRef.current) return;
    if (speaking) return;

    const sessionId = voiceSessionIdRef.current;

    voiceResumeTimerRef.current = window.setTimeout(() => {
      voiceResumeTimerRef.current = null;

      if (sessionId !== voiceSessionIdRef.current) return;
      if (!voiceSessionActiveRef.current) return;
      if (!openRef.current || closingRef.current) return;
      if (busyRef.current || listeningRef.current) return;

      startListeningRef.current(true);
    }, VOICE_RESUME_DELAY);
  }, [clearVoiceResumeTimer, speaking]);

  const startListening = useCallback(
    (automatic = false) => {
      if (busyRef.current) return;
      if (listeningRef.current) return;
      if (closingRef.current) return;
      if (!openRef.current) return;

      if (!automatic && !voiceSessionActiveRef.current) {
        setVoiceSession(true);
      }

      if (!voiceSessionActiveRef.current) return;

      clearVoiceResumeTimer();
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

      const sessionId = voiceSessionIdRef.current;
      dispatchMachine({ type: "VOICE_START_REQUESTED", sessionId });

      pendingVoiceTextRef.current = "";
      recognitionErrorRef.current = "";
      manualVoiceStopRef.current = false;

      const recognition = new SpeechRecognitionClass();

      recognition.lang = "zh-CN";
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = () => {
        if (recognitionRef.current !== recognition) return;
        if (sessionId !== voiceSessionIdRef.current) return;

        listeningRef.current = true;
        setListening(true);
        dispatchMachine({ type: "VOICE_STARTED", sessionId });
        setVoiceError("");
      };

      recognition.onresult = (event) => {
        if (recognitionRef.current !== recognition) return;
        if (sessionId !== voiceSessionIdRef.current) return;

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
          dispatchMachine({ type: "VOICE_FINAL_TEXT", sessionId });
          pendingVoiceTextRef.current = finalText
            .trim()
            .slice(0, MAX_INPUT_LENGTH);
        }
      };

      recognition.onerror = (event) => {
        if (recognitionRef.current !== recognition) return;
        if (sessionId !== voiceSessionIdRef.current) return;

        recognitionErrorRef.current = event.error || "unknown";

        const message = getSpeechErrorMessage(event.error);

        if (message) {
          dispatchMachine({
            type: "VOICE_FAILED",
            sessionId,
            code: event.error || "unknown",
            message,
          });
          setVoiceError(message);
        }
      };

      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return;
        if (sessionId !== voiceSessionIdRef.current) return;

        recognitionRef.current = null;
        listeningRef.current = false;
        setListening(false);
        dispatchMachine({ type: "VOICE_ENDED", sessionId });

        const finalText = pendingVoiceTextRef.current.trim();
        const recognitionError = recognitionErrorRef.current;
        const wasManualStop = manualVoiceStopRef.current;

        pendingVoiceTextRef.current = "";
        recognitionErrorRef.current = "";
        manualVoiceStopRef.current = false;

        if (finalText) {
          setInput("");
          // 手动停止时提交最终文本后结束语音会话；自然结束则保留连续聆听会话。
          void handleSendRef.current(finalText, !wasManualStop);
          return;
        }

        if (wasManualStop) {
          setVoiceSession(false);
          return;
        }

        if (!voiceSessionActiveRef.current) return;

        if (
          recognitionError &&
          recognitionError !== "aborted"
        ) {
          if (recognitionError === "no-speech") {
            setVoiceError("没有识别到语音，请点击麦克风重新聆听。");
          }

          // 权限、网络和设备错误不自动循环重启。
          return;
        }

        if (openRef.current && !busyRef.current) {
          setVoiceError(
            "本次没有识别到完整语音，请点击麦克风继续。",
          );
        }
      };

      recognitionRef.current = recognition;

      try {
        // 首次启动必须在用户点击的同步调用链内。
        recognition.start();
      } catch (recognitionError) {
        console.error(
          "[Friday] Speech recognition start failed:",
          recognitionError,
        );

        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }

        dispatchMachine({
          type: "VOICE_FAILED",
          sessionId,
          code: "start-failed",
          message: "语音识别启动失败",
        });
        listeningRef.current = false;
        setListening(false);

        setVoiceError(
          automatic
            ? "浏览器未允许自动恢复麦克风，请点击麦克风继续聆听。"
            : "语音识别启动失败，请检查麦克风权限后重试。",
        );
      }
    },
    [
      clearVoiceResumeTimer,
      setVoiceSession,
      stopSpeech,
    ],
  );

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const openPanel = useCallback(() => {
    clearMovieCloseTimer();
    clearVoiceResumeTimer();

    pendingMovieRef.current = null;
    movieDispatchedRef.current = false;

    closingRef.current = false;
    openRef.current = true;

    setClosing(false);
    setOpen(true);
    dispatchMachine({ type: "OPEN" });
    setExpanded(false);
    setVoiceError("");
    setFabHidden(false);
  }, [clearMovieCloseTimer, clearVoiceResumeTimer]);

  const openAndListen = useCallback(() => {
    openPanel();

    // 先同步更新引用，再启动识别。
    openRef.current = true;
    closingRef.current = false;

    setVoiceSession(true);

    // 保留真实用户点击手势。
    startListeningRef.current(false);
  }, [openPanel, setVoiceSession]);

  const handleSend = useCallback(
    async (text?: string, keepVoiceSession = false) => {
      const content = (text ?? input).trim();

      if (!content || busyRef.current || closingRef.current) return;
      if (content.length > MAX_INPUT_LENGTH) return;

      if (keepVoiceSession) {
        clearVoiceResumeTimer();
        stopRecognition(true);
        stopSpeech();
      } else {
        stopAllVoice();
      }

      setVoiceError("");
      setCompleted(false);
      setInput("");

      const requestId = ++requestSequenceRef.current;
      activeRequestIdRef.current = requestId;
      observedBusyRef.current = false;
      dispatchMachine({ type: "MESSAGE_SUBMITTED", requestId });

      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }

      try {
        await sendMessage({ text: content });
      } catch (sendError) {
        console.error("[Friday] Send failed:", sendError);

        if (activeRequestIdRef.current) {
          dispatchMachine({
            type: "REQUEST_FAILED",
            requestId: activeRequestIdRef.current,
            code: "send-failed",
            message: "消息发送失败，请检查网络后重试。",
          });
          activeRequestIdRef.current = 0;
        }
        setVoiceError("消息发送失败，请检查网络后重试。");

        if (keepVoiceSession && voiceSessionActiveRef.current) {
          setVoiceSession(false);
        }
      }
    },
    [
      input,
      sendMessage,
      clearVoiceResumeTimer,
      stopRecognition,
      stopSpeech,
      stopAllVoice,
      setVoiceSession,
    ],
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const finalizeMovieOpen = useCallback(() => {
    if (movieDispatchedRef.current) return;

    const movie = pendingMovieRef.current;

    if (!movie) {
      setClosing(false);
      closingRef.current = false;
      return;
    }

    movieDispatchedRef.current = true;
    pendingMovieRef.current = null;

    clearMovieCloseTimer();

    closingRef.current = false;
    setClosing(false);

    window.dispatchEvent(
      new CustomEvent("friday-open-detail", {
        detail: movie,
      }),
    );
  }, [clearMovieCloseTimer]);

  const closePanel = useCallback(() => {
    clearMovieCloseTimer();

    pendingMovieRef.current = null;
    movieDispatchedRef.current = false;

    openRef.current = false;
    closingRef.current = false;

    stopAllVoice();

    if (busyRef.current) {
      stop();
    }

    setClosing(false);
    setOpen(false);
    dispatchMachine({ type: "CLOSE" });
    if (busyRef.current && activeRequestIdRef.current) {
      dispatchMachine({
        type: "REQUEST_CANCELLED",
        requestId: activeRequestIdRef.current,
      });
      activeRequestIdRef.current = 0;
      observedBusyRef.current = false;
    }
    setExpanded(false);
  }, [clearMovieCloseTimer, stopAllVoice, stop]);

  const handleOpenMovie = useCallback(
    (movie: MovieItem) => {
      if (typeof window === "undefined") return;
      if (closingRef.current || movieDispatchedRef.current) return;

      stopAllVoice();

      if (busyRef.current) {
        stop();
      }

      pendingMovieRef.current = movie;
      movieDispatchedRef.current = false;

      openRef.current = false;
      closingRef.current = true;

      setClosing(true);
      setOpen(false);
      setExpanded(false);

      clearMovieCloseTimer();

      movieCloseTimerRef.current = window.setTimeout(() => {
        finalizeMovieOpen();
      }, MOVIE_CLOSE_DELAY);
    },
    [
      stopAllVoice,
      stop,
      clearMovieCloseTimer,
      finalizeMovieOpen,
    ],
  );

  const handlePanelAnimationEnd = useCallback(
    (event: React.AnimationEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.animationName !== "friday-panel-close") return;

      if (closingRef.current) {
        finalizeMovieOpen();
      }
    },
    [finalizeMovieOpen],
  );

  const interrupt = useCallback(() => {
    stopAllVoice();

    if (busyRef.current) {
      stop();
    }
  }, [stopAllVoice, stop]);

  const speakText = useCallback(
    (text: string, messageId: string) => {
      if (!voiceEnabled || !text.trim()) {
        setSpeaking(false);
        setCompleted(true);
        scheduleVoiceResume();
        return;
      }

      if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
      ) {
        setSpeaking(false);
        setCompleted(true);
        setVoiceError("当前浏览器不支持语音播报。");
        scheduleVoiceResume();
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
        scheduleVoiceResume();
      };

      utterance.onerror = () => {
        if (utteranceRef.current !== utterance) return;

        utteranceRef.current = null;
        setSpeaking(false);
        setCompleted(true);
        scheduleVoiceResume();
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
        setCompleted(true);
        scheduleVoiceResume();
      }
    },
    [
      voiceEnabled,
      stopSpeech,
      scheduleVoiceResume,
    ],
  );

  // 只在本轮 AI 回复真正完成后播报一次。
  useEffect(() => {
    if (status !== "ready" || !open) return;

    const lastAssistant = [...typedMessages]
      .reverse()
      .find((message) => message?.role === "assistant");

    if (!lastAssistant?.id) return;

    if (lastCompletedMessageRef.current === lastAssistant.id) {
      return;
    }

    const text = getPartText(lastAssistant);
    const movieData = getMovieDataForMessage(lastAssistant);

    if (!text.trim() && movieData.length === 0) return;

    lastCompletedMessageRef.current = lastAssistant.id;

    if (text.trim()) {
      if (
        voiceEnabled &&
        lastSpokenMessageRef.current !== lastAssistant.id
      ) {
        speakText(text, lastAssistant.id);
      } else {
        setCompleted(true);
        scheduleVoiceResume();
      }
    } else {
      setCompleted(true);
      scheduleVoiceResume();
    }
  }, [
    typedMessages,
    status,
    voiceEnabled,
    open,
    speakText,
    scheduleVoiceResume,
  ]);

  // 请求异常时，不让用户误以为麦克风仍在聆听。
  useEffect(() => {
    if (!error) return;

    setSpeaking(false);

    if (voiceSessionActiveRef.current) {
      setVoiceError("Friday 请求失败，请检查网络后重新尝试。");
    }
  }, [error]);

  // 关闭语音播报时，取消当前播报并尝试恢复监听。
  const toggleVoiceEnabled = useCallback(() => {
    if (voiceEnabled) {
      stopSpeech();

      if (voiceSessionActiveRef.current) {
        scheduleVoiceResume();
      }
    }

    setVoiceEnabled((value) => !value);
  }, [voiceEnabled, stopSpeech, scheduleVoiceResume]);

  // 手动停止播报后恢复语音会话。
  const stopSpeechAndResume = useCallback(() => {
    stopSpeech();

    if (voiceSessionActiveRef.current) {
      scheduleVoiceResume();
    }
  }, [stopSpeech, scheduleVoiceResume]);

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
      openRef.current = false;
      closingRef.current = false;

      voiceSessionActiveRef.current = false;
      voiceSessionIdRef.current += 1;

      clearVoiceResumeTimer();
      stopRecognition(true);
      stopSpeech();
      clearMovieCloseTimer();

      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
      }
    };
  }, [
    clearVoiceResumeTimer,
    stopRecognition,
    stopSpeech,
    clearMovieCloseTimer,
  ]);

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
      if (openRef.current || closingRef.current) return;

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
    [],
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

  const hideAssistant = useCallback(() => {
    closePanel();
    setFabHidden(true);
  }, [closePanel]);

  const restoreAssistant = useCallback(() => {
    setFabHidden(false);
    setFabPosition(null);
  }, []);

  if (!mounted) return null;

  const content = (
    <>
      <style jsx global>{`
        .friday-root {
          position: fixed;
          z-index: 30;
          right: 16px;
          bottom: max(20px, env(safe-area-inset-bottom, 0px));
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

        .friday-fab {
          position: relative;
          display: grid;
          place-items: center;
          width: ${FAB_SIZE}px;
          height: ${FAB_SIZE}px;
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
          filter: drop-shadow(0 8px 16px rgba(0,0,0,.24));
        }

        .friday-fab:active { cursor: grabbing; }

        .friday-orb-visual {
          position: relative;
          isolation: isolate;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.55);
          border-radius: 46% 54% 52% 48% / 49% 44% 56% 51%;
          background:
            radial-gradient(ellipse at 28% 17%,rgba(255,255,255,.22),transparent 24%),
            radial-gradient(ellipse at 75% 80%,rgba(92,95,160,.14),transparent 46%),
            rgba(15,18,29,.19);
          box-shadow:
            0 0 0 1px rgba(255,255,255,.08),
            0 0 16px rgba(111,194,255,.16),
            0 0 25px rgba(190,117,255,.12),
            inset 0 1px 2px rgba(255,255,255,.5),
            inset 0 -2px 7px rgba(0,0,0,.16);
          -webkit-backdrop-filter: blur(2px) saturate(175%);
          backdrop-filter: blur(2px) saturate(175%);
          animation: friday-orb-morph 9s ease-in-out infinite,
            friday-orb-breathe 4.8s ease-in-out infinite;
          transition: border-radius .45s ease, transform .45s ease;
        }

        .friday-orb-inner {
          position: absolute;
          z-index: 0;
          inset: 3px;
          border-radius: inherit;
          background:
            radial-gradient(ellipse at 29% 18%,rgba(255,255,255,.17),transparent 25%),
            radial-gradient(ellipse at 70% 72%,rgba(113,99,183,.13),transparent 43%),
            radial-gradient(ellipse at 50% 52%,rgba(17,23,38,.18),rgba(9,13,25,.11) 60%,rgba(3,5,12,.24) 100%);
          box-shadow: inset 0 0 8px rgba(0,0,0,.16),
            inset 0 1px 3px rgba(255,255,255,.22);
        }

        .friday-orb-fluid {
          position: absolute;
          z-index: 1;
          inset: 8%;
          border-radius: 48% 52% 57% 43% / 55% 43% 57% 45%;
          background:
            radial-gradient(ellipse at 20% 38%,rgba(102,231,255,.28),transparent 39%),
            radial-gradient(ellipse at 82% 32%,rgba(183,132,255,.25),transparent 38%),
            radial-gradient(ellipse at 55% 90%,rgba(255,180,135,.2),transparent 44%),
            radial-gradient(ellipse at 12% 78%,rgba(119,48,77,.16),transparent 40%);
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
          -webkit-mask: linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask: linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
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
          background: linear-gradient(90deg,rgba(255,255,255,.94),rgba(255,255,255,.38) 60%,transparent);
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
          0%,100% { border-radius: 46% 54% 52% 48% / 49% 44% 56% 51%; }
          35% { border-radius: 55% 45% 44% 56% / 44% 56% 44% 56%; }
          70% { border-radius: 43% 57% 58% 42% / 55% 45% 55% 45%; }
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

        .friday-restore {
          position: fixed;
          right: 8px;
          bottom: max(22px,env(safe-area-inset-bottom,0px));
          z-index: 30;
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.25);
          border-radius: 50%;
          background: rgba(18,22,34,.7);
          color: rgba(255,255,255,.85);
          font-family: Georgia,serif;
          font-size: 15px;
          box-shadow: 0 4px 16px rgba(0,0,0,.22);
          -webkit-backdrop-filter: blur(12px);
          backdrop-filter: blur(12px);
          cursor: pointer;
          pointer-events: auto;
        }

        .friday-panel {
          position: fixed;
          right: 14px;
          bottom: calc(96px + env(safe-area-inset-bottom,0px));
          z-index: 30;
          display: flex;
          flex-direction: column;
          width: min(370px,calc(100vw - 28px));
          max-height: min(360px,calc(100dvh - 118px));
          min-height: 150px;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255,255,255,.27);
          border-radius: 25px;
          color: #fff;
          background:
            linear-gradient(145deg,rgba(255,255,255,.15),rgba(255,255,255,.035) 45%,rgba(255,255,255,.075)),
            rgba(12,15,25,.83);
          -webkit-backdrop-filter: blur(25px) saturate(165%);
          backdrop-filter: blur(25px) saturate(165%);
          box-shadow: 0 18px 55px rgba(0,0,0,.32),
            inset 0 1px 0 rgba(255,255,255,.3),
            inset 0 -1px 0 rgba(255,255,255,.06);
          transform-origin: bottom right;
          animation: friday-capsule-in .42s cubic-bezier(.18,.82,.2,1);
          pointer-events: auto;
        }

        @keyframes friday-capsule-in {
          0% { opacity: 0; transform: translate3d(20px,25px,0) scale(.78); border-radius: 45px; }
          65% { opacity: 1; transform: translate3d(-2px,-2px,0) scale(1.02); }
          100% { transform: translate3d(0,0,0) scale(1); border-radius: 25px; }
        }

        .friday-panel.friday-expanded {
          right: 8px;
          bottom: 8px;
          width: min(650px,calc(100vw - 16px));
          height: min(780px,calc(100dvh - 16px));
          max-height: calc(100dvh - 16px);
          min-height: 300px;
          border-radius: 30px;
          animation: friday-expanded-in .35s cubic-bezier(.2,.8,.2,1);
        }

        @keyframes friday-expanded-in {
          from { opacity: .7; transform: translateY(20px) scale(.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
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
            radial-gradient(ellipse at 50% 110%,rgba(115,183,255,.19),transparent 55%),
            radial-gradient(ellipse at 90% 0%,rgba(203,143,255,.13),transparent 45%);
          content: "";
          pointer-events: none;
        }

        .friday-canvas-top {
          position: relative;
          z-index: 3;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex: 0 0 auto;
          min-height: 46px;
          padding: 10px 14px 3px 17px;
        }

        .friday-wordmark {
          color: rgba(255,255,255,.96);
          font-family: Georgia,"Times New Roman",serif;
          font-size: 20px;
          font-weight: 400;
          letter-spacing: -.8px;
          text-shadow: 0 1px 12px rgba(255,255,255,.15);
        }

        .friday-header-actions {
          display: flex;
          align-items: center;
          gap: 9px;
        }

        .friday-state-wrap {
          display: flex;
          align-items: center;
          gap: 7px;
          color: rgba(255,255,255,.67);
          font-size: 10px;
        }

        .friday-status-dot {
          width: 7px;
          height: 7px;
          flex: 0 0 7px;
          border-radius: 50%;
          background: #8de7dc;
          box-shadow: 0 0 8px rgba(116,239,224,.8);
          animation: friday-dot-pulse 1.8s ease-in-out infinite;
        }

        .friday-close-btn {
          display: grid;
          place-items: center;
          width: 29px;
          height: 29px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 50%;
          background: rgba(255,255,255,.08);
          color: rgba(255,255,255,.88);
          font-size: 19px;
          line-height: 1;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-close-btn:active {
          background: rgba(255,255,255,.2);
          transform: scale(.94);
        }

        @keyframes friday-dot-pulse {
          0%,100% { opacity: .6; transform: scale(.85); }
          50% { opacity: 1; transform: scale(1.18); }
        }

        .friday-messages {
          position: relative;
          z-index: 1;
          flex: 1 1 auto;
          min-height: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 8px 17px 12px;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,.17) transparent;
        }

        .friday-panel:not(.friday-expanded) .friday-messages {
          max-height: 150px;
        }

        .friday-welcome {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-height: 75px;
          padding: 4px 0 10px;
        }

        .friday-welcome-kicker {
          margin-bottom: 6px;
          color: rgba(255,255,255,.43);
          font-size: 9px;
          letter-spacing: 2px;
        }

        .friday-welcome-title {
          margin: 0 0 5px;
          color: #fff;
          font-size: 19px;
          font-weight: 500;
          letter-spacing: -.6px;
        }

        .friday-welcome-text {
          color: rgba(255,255,255,.65);
          font-size: 11px;
          line-height: 1.65;
        }

        .friday-message {
          display: flex;
          justify-content: flex-start;
          margin: 0 0 11px;
          animation: friday-message-in .3s ease both;
        }

        .friday-message-user { justify-content: flex-end; }

        @keyframes friday-message-in {
          from { opacity: 0; transform: translateY(7px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .friday-message-content {
          max-width: 96%;
          color: rgba(255,255,255,.95);
          font-size: 12px;
          line-height: 1.72;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-message-user .friday-message-content {
          max-width: 86%;
          padding: 7px 11px;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 15px 15px 4px 15px;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.9);
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

        .friday-orb-stage {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          gap: 9px;
          min-height: 38px;
          padding: 0 14px 7px;
          pointer-events: none;
        }

        .friday-orb-stage .friday-orb-visual {
          width: 32px;
          height: 32px;
          flex: 0 0 32px;
        }

        .friday-orb-status {
          color: rgba(255,255,255,.69);
          font-size: 10px;
          letter-spacing: .3px;
        }

        .friday-panel[data-state="listening"] .friday-orb-visual {
          animation-duration: 5s,1.5s;
          filter: brightness(1.22);
        }

        .friday-panel[data-state="thinking"] .friday-orb-visual {
          animation-duration: 2.5s,1.1s;
          filter: brightness(1.24) saturate(1.3);
        }

        .friday-panel[data-state="speaking"] .friday-orb-visual {
          animation-duration: 2s,.75s;
          filter: brightness(1.28);
        }

        .friday-input-area {
          position: relative;
          z-index: 4;
          flex: 0 0 auto;
          padding: 9px 11px calc(9px + env(safe-area-inset-bottom,0px));
          border-top: 1px solid rgba(255,255,255,.1);
          background: rgba(10,13,22,.27);
          -webkit-backdrop-filter: blur(15px);
          backdrop-filter: blur(15px);
        }

        .friday-input-box {
          display: flex;
          align-items: flex-end;
          gap: 7px;
          min-height: 44px;
          padding: 5px 6px 5px 10px;
          border: 1px solid rgba(255,255,255,.24);
          border-radius: 24px;
          background: linear-gradient(145deg,rgba(255,255,255,.15),rgba(255,255,255,.045)),rgba(22,25,35,.48);
          -webkit-backdrop-filter: blur(18px) saturate(160%);
          backdrop-filter: blur(18px) saturate(160%);
          box-shadow: 0 8px 25px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.2);
        }

        .friday-plus-btn {
          display: grid;
          place-items: center;
          width: 27px;
          height: 32px;
          flex: 0 0 27px;
          padding: 0;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.8);
          font-size: 22px;
          font-weight: 200;
          cursor: pointer;
        }

        .friday-plus-btn:disabled { opacity: .4; cursor: default; }

        .friday-input-divider {
          width: 1px;
          height: 21px;
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
          font-size: 12px;
          line-height: 1.65;
          padding: 5px 0;
        }

        .friday-textarea::placeholder { color: rgba(255,255,255,.53); }
        .friday-textarea:disabled { opacity: .5; }

        .friday-send-btn,
        .friday-mic-btn {
          display: grid;
          place-items: center;
          width: 33px;
          height: 33px;
          flex: 0 0 33px;
          padding: 0;
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 50%;
          background: rgba(255,255,255,.1);
          color: rgba(255,255,255,.94);
          cursor: pointer;
          font-size: 16px;
          transition: background .2s ease,transform .2s ease;
          -webkit-tap-highlight-color: transparent;
        }

        .friday-send-btn {
          border-color: rgba(255,255,255,.8);
          background: #f5f5f5;
          color: #151515;
          font-size: 19px;
        }

        .friday-send-btn:disabled,
        .friday-mic-btn:disabled {
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
        .friday-mic-btn:active { transform: scale(.91); }

        .friday-tools {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 7px;
          min-height: 21px;
          margin-top: 4px;
          padding: 0 6px;
        }

        .friday-tool-group {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
        }

        .friday-tool-btn {
          padding: 4px 2px;
          border: 0;
          background: transparent;
          color: rgba(255,255,255,.57);
          cursor: pointer;
          font-family: inherit;
          font-size: 9px;
          white-space: nowrap;
        }

        .friday-tool-btn.active { color: #a9dcff; }
        .friday-tool-btn:disabled { opacity: .35; cursor: not-allowed; }

        .friday-voice-error {
          margin: 6px 6px 0;
          color: #ffb4a8;
          font-size: 10px;
          line-height: 1.55;
        }

        .friday-movie-section { margin: 10px 0 15px; }

        .friday-result-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 9px;
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
          grid-template-columns: repeat(2,minmax(0,1fr));
          gap: 8px;
        }

        .friday-movie-card {
          display: flex;
          min-width: 0;
          gap: 8px;
          padding: 7px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 13px;
          background: rgba(255,255,255,.075);
          color: white;
          text-align: left;
          cursor: pointer;
          transition: background .2s ease,transform .2s ease;
        }

        .friday-movie-card:active {
          background: rgba(255,255,255,.15);
          transform: scale(.985);
        }

        .friday-poster {
          position: relative;
          width: 46px;
          height: 65px;
          flex: 0 0 46px;
          overflow: hidden;
          border-radius: 7px;
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

        .friday-movie-meta,
        .friday-movie-source {
          margin-top: 4px;
          overflow: hidden;
          font-size: 9px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .friday-movie-meta { color: rgba(255,255,255,.55); }
        .friday-movie-source { color: rgba(190,221,255,.85); }

        .friday-empty-result {
          margin: 10px 0;
          color: rgba(255,255,255,.65);
          font-size: 12px;
        }

        .friday-expanded .friday-messages {
          max-height: none;
          padding: 18px 23px;
        }

        .friday-expanded .friday-welcome { min-height: 180px; }
        .friday-expanded .friday-welcome-title { font-size: 32px; }
        .friday-expanded .friday-message-content { font-size: 14px; }
        .friday-expanded .friday-orb-stage { min-height: 55px; }

        .friday-expanded .friday-orb-stage .friday-orb-visual {
          width: 48px;
          height: 48px;
          flex-basis: 48px;
        }

        @media (max-width:600px) {
          .friday-root {
            right: 16px;
            bottom: max(20px,env(safe-area-inset-bottom,0px));
          }

          .friday-panel {
            right: 8px;
            bottom: calc(92px + env(safe-area-inset-bottom,0px));
            width: calc(100vw - 16px);
            max-height: min(370px,calc(100dvh - 108px));
            border-radius: 24px;
          }

          .friday-panel.friday-expanded {
            right: 4px;
            bottom: 0;
            width: calc(100vw - 8px);
            height: 100dvh;
            max-height: 100dvh;
            border-radius: 25px 25px 0 0;
          }

          .friday-canvas-top {
            padding: max(10px,env(safe-area-inset-top,0px)) 13px 3px;
          }

          .friday-messages {
            padding-right: 14px;
            padding-left: 14px;
          }

          .friday-expanded .friday-messages { padding: 16px; }

          .friday-input-area {
            padding-right: 9px;
            padding-left: 9px;
          }

          .friday-movie-grid { gap: 7px; }

          .friday-movie-card {
            gap: 6px;
            padding: 6px;
          }

          .friday-poster {
            width: 42px;
            height: 61px;
            flex-basis: 42px;
          }
        }

        @media (max-height:520px) {
          .friday-panel.friday-expanded {
            bottom: 4px;
            height: calc(100dvh - 8px);
            min-height: 0;
            border-radius: 20px;
          }

          .friday-canvas-top {
            min-height: 38px;
            padding-top: 7px;
          }

          .friday-expanded .friday-welcome { min-height: 100px; }
          .friday-orb-stage { min-height: 32px; }
          .friday-input-area { padding-top: 5px; }
          .friday-tools { margin-top: 2px; }
        }

        @media (prefers-reduced-motion:reduce) {
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

        @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))) {
          .friday-panel { background: rgba(12,15,25,.97); }
          .friday-input-box,
          .friday-movie-card { background: rgba(35,37,44,.96); }
        }
      `}</style>

      <div className="friday-root">
        {!open && !closing && !fabHidden ? (
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
            data-agent-state={machineState.agent}
            data-voice-state={machineState.voice}
            aria-label="Friday AI 助手"
            aria-hidden={closing}
            onAnimationEnd={handlePanelAnimationEnd}
          >
            <div className="friday-canvas-top">
              <div className="friday-wordmark">Friday</div>

              <div className="friday-header-actions">
                <div className="friday-state-wrap">
                  <span className="friday-status-dot" />
                  <span>{stateLabel}</span>
                </div>

                <button
                  type="button"
                  className="friday-close-btn"
                  title="关闭 Friday"
                  aria-label="关闭 Friday"
                  onClick={closePanel}
                >
                  ×
                </button>
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
                        : voiceSessionActive
                          ? "等待恢复语音聆听"
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
                  title={
                    listening
                      ? "停止本次聆听"
                      : "开始语音输入或恢复连续对话"
                  }
                  onClick={() => {
                    if (listeningRef.current) {
                      // 不提前结束 session：等待 onresult/onend 收齐最终识别文本。
                      manualVoiceStopRef.current = true;
                      clearVoiceResumeTimer();

                      try {
                        recognitionRef.current?.stop();
                      } catch {
                        manualVoiceStopRef.current = false;
                        stopRecognition(true);
                        setVoiceSession(false);
                      }
                    } else {
                      setVoiceSession(true);
                      startListeningRef.current(false);
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
                    onClick={toggleVoiceEnabled}
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
                      onClick={stopSpeechAndResume}
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

                  <button
                    type="button"
                    className="friday-tool-btn"
                    onClick={hideAssistant}
                  >
                    隐藏助手
                  </button>
                </div>
              </div>
            </footer>
          </section>
        ) : null}
      </div>

      {fabHidden && !open ? (
        <button
          type="button"
          className="friday-restore"
          aria-label="恢复 Friday 助手"
          title="恢复 Friday"
          onClick={restoreAssistant}
        >
          F
        </button>
      ) : null}
    </>
  );

  return createPortal(content, document.body);
}
