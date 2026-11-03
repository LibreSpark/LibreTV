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

type SourceConfig = {
  key: string;
  name: string;
  url: string;
  detail?: string;
  isAdult?: boolean;
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
  total: number;
  outcomes: Array<{
    sourceKey: string;
    ok: boolean;
    list: MovieItem[];
    error?: string;
    timedOut?: boolean;
    ms?: number;
  }>;
  results: MovieItem[];
  createdAt: number;
};

type FridayProps = {
  /**
   * 当前 LibreTV 启用的视频源。
   * 请由挂载 AIFloatingBall 的页面传入真实启用源。
   */
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

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const MAX_INPUT_LENGTH = 1000;
const MAX_MOVIE_CARDS = 60;

function getPartText(message: any): string {
  if (!message || !Array.isArray(message.parts)) return "";

  return message.parts
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text || ""))
    .join("");
}

function getMovieDataParts(messages: any[]): MovieData[] {
  const output: MovieData[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.parts)) {
      continue;
    }

    for (const part of message.parts) {
      if (part?.type !== "data-movies") continue;

      const data = part.data as MovieData | undefined;

      if (
        !data ||
        typeof data.searchId !== "string" ||
        !Array.isArray(data.results)
      ) {
        continue;
      }

      if (seen.has(data.searchId)) continue;
      seen.add(data.searchId);

      output.push({
        ...data,
        results: data.results
          .filter((item) => item && typeof item === "object")
          .slice(0, MAX_MOVIE_CARDS),
      });
    }
  }

  return output;
}

function stopSpeech() {
  if (typeof window === "undefined") return;

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
        <span>搜索结果</span>
        <span className="friday-result-count">
          {data.total} 条
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

export default function AIFloatingBall({
  sources = [],
  filterAdult = true,
}: FridayProps) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceTextRef = useRef("");
  const lastSpokenMessageRef = useRef("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: {
          sources,
          filterAdult,
        },
      }),
    [sources, filterAdult],
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

  const movieData = useMemo(
    () => getMovieDataParts(messages as any[]),
    [messages],
  );

  const stopAllVoice = useCallback(() => {
    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }

    recognitionRef.current = null;
    setListening(false);

    stopSpeech();
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

    if (typeof document !== "undefined") {
      document.body.classList.remove("friday-popup-lock");
    }
  }, [stopAllVoice]);

  const interrupt = useCallback(() => {
    stopAllVoice();

    if (busy) {
      stop();
    }
  }, [busy, stop, stopAllVoice, stop]);

  const handleSend = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim();

      if (!content || busy) return;

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

  const handleOpenMovie = useCallback((movie: MovieItem) => {
    if (typeof window === "undefined") return;

    stopAllVoice();

    window.dispatchEvent(
      new CustomEvent("friday-open-detail", {
        detail: movie,
      }),
    );
  }, [stopAllVoice]);

  const startListening = useCallback(() => {
    if (busy || listening) return;

    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      alert("当前浏览器暂不支持语音识别，请使用键盘输入。");
      return;
    }

    stopSpeech();
    setSpeaking(false);

    try {
      recognitionRef.current?.abort();
    } catch {
      // ignore
    }

    const recognition = new SpeechRecognitionClass();

    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript || "";

        if (result.isFinal) {
          finalText += text;
        } else {
          interimText += text;
        }
      }

      voiceTextRef.current = finalText || interimText;
      setInput(voiceTextRef.current.slice(0, MAX_INPUT_LENGTH));
    };

    recognition.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (recognitionError) {
      console.error("[Friday] Speech recognition start failed:", recognitionError);
      setListening(false);
      recognitionRef.current = null;
    }
  }, [busy, listening]);

  const speakText = useCallback((text: string, messageId: string) => {
    if (!voiceEnabled || !text.trim()) return;
    if (!("speechSynthesis" in window)) return;

    stopSpeech();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1;

    utterance.onstart = () => {
      setSpeaking(true);
    };

    utterance.onend = () => {
      setSpeaking(false);
    };

    utterance.onerror = () => {
      setSpeaking(false);
    };

    lastSpokenMessageRef.current = messageId;

    try {
      window.speechSynthesis.speak(utterance);
    } catch (speechError) {
      console.error("[Friday] Speech synthesis failed:", speechError);
      setSpeaking(false);
    }
  }, [voiceEnabled]);

  // 只在一轮回复结束后播报，避免每个流式 token 都重新朗读。
  useEffect(() => {
    if (status !== "ready" || !voiceEnabled || !open) return;

    const lastAssistant = [...(messages as any[])]
      .reverse()
      .find((message) => message?.role === "assistant");

    if (!lastAssistant?.id) return;
    if (lastSpokenMessageRef.current === lastAssistant.id) return;

    const text = getPartText(lastAssistant);

    if (text.trim()) {
      speakText(text, lastAssistant.id);
    }
  }, [messages, status, voiceEnabled, open, speakText]);

  useEffect(() => {
    setMounted(true);

    return () => {
      stopAllVoice();

      if (typeof document !== "undefined") {
        document.body.classList.remove("friday-popup-lock");
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

  if (!mounted) return null;

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
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
            "PingFang SC", "Microsoft YaHei", sans-serif;
        }

        .friday-fab {
          width: 58px;
          height: 58px;
          border: 1px solid rgba(255,255,255,.28);
          border-radius: 50%;
          color: white;
          cursor: pointer;
          background:
            radial-gradient(circle at 30% 25%, #ff9bd8, transparent 40%),
            linear-gradient(135deg, #ec4899, #7c3aed 58%, #2563eb);
          box-shadow: 0 8px 30px rgba(124,58,237,.42);
          font-size: 25px;
          font-weight: 800;
          transition: transform .2s ease, box-shadow .2s ease;
        }

        .friday-fab:active {
          transform: scale(.93);
        }

        .friday-panel {
          position: fixed;
          right: 14px;
          bottom: calc(92px + env(safe-area-inset-bottom));
          width: min(430px, calc(100vw - 28px));
          height: min(680px, calc(100dvh - 125px));
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 22px;
          background: #10101a;
          color: #f8fafc;
          box-shadow: 0 20px 70px rgba(0,0,0,.55);
          animation: friday-in .18s ease-out;
        }

        .friday-panel.friday-expanded {
          right: 8px;
          bottom: 8px;
          width: calc(100vw - 16px);
          height: calc(100dvh - 16px);
          max-height: calc(100dvh - 16px);
          border-radius: 18px;
        }

        @keyframes friday-in {
          from { opacity: 0; transform: translateY(12px) scale(.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .friday-header {
          min-height: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid rgba(255,255,255,.08);
          background: linear-gradient(110deg, #21152f, #15172c);
        }

        .friday-brand {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .friday-avatar {
          width: 38px;
          height: 38px;
          flex: 0 0 38px;
          display: grid;
          place-items: center;
          border-radius: 13px;
          background: linear-gradient(135deg, #ec4899, #7c3aed);
          font-weight: 900;
          box-shadow: 0 4px 16px rgba(236,72,153,.25);
        }

        .friday-brand-name {
          font-size: 15px;
          font-weight: 800;
        }

        .friday-brand-sub {
          margin-top: 3px;
          color: #a5a3b8;
          font-size: 11px;
        }

        .friday-header-actions {
          display: flex;
          gap: 7px;
        }

        .friday-icon-btn {
          width: 34px;
          height: 34px;
          border: 0;
          border-radius: 10px;
          background: rgba(255,255,255,.08);
          color: #eee;
          cursor: pointer;
          font-size: 15px;
        }

        .friday-messages {
          flex: 1;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 16px 13px 20px;
          scroll-behavior: smooth;
        }

        .friday-welcome {
          padding: 25px 15px;
          text-align: center;
          color: #d6d3e2;
        }

        .friday-welcome-icon {
          width: 54px;
          height: 54px;
          display: grid;
          place-items: center;
          margin: 0 auto 14px;
          border-radius: 18px;
          background: linear-gradient(135deg, #ec4899, #6d28d9);
          font-size: 24px;
          font-weight: 900;
        }

        .friday-welcome-title {
          margin-bottom: 8px;
          font-size: 18px;
          font-weight: 800;
          color: white;
        }

        .friday-welcome-text {
          color: #aaa8ba;
          font-size: 13px;
          line-height: 1.7;
        }

        .friday-message {
          display: flex;
          margin: 0 0 15px;
          gap: 8px;
          align-items: flex-start;
        }

        .friday-message-user {
          flex-direction: row-reverse;
        }

        .friday-message-avatar {
          width: 28px;
          height: 28px;
          flex: 0 0 28px;
          display: grid;
          place-items: center;
          border-radius: 10px;
          background: #29243c;
          color: #e9d5ff;
          font-size: 12px;
          font-weight: 800;
        }

        .friday-message-user .friday-message-avatar {
          background: #433078;
          color: white;
        }

        .friday-bubble {
          max-width: calc(100% - 38px);
          padding: 10px 12px;
          border: 1px solid rgba(255,255,255,.07);
          border-radius: 13px;
          background: #1b1b29;
          color: #eceaf4;
          font-size: 13px;
          line-height: 1.7;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .friday-message-user .friday-bubble {
          background: #49317c;
          border-color: rgba(196,181,253,.12);
          color: white;
        }

        .friday-status {
          margin: 0 0 12px 37px;
          color: #a78bfa;
          font-size: 12px;
        }

        .friday-error {
          margin: 8px 0;
          padding: 9px 11px;
          border: 1px solid rgba(248,113,113,.25);
          border-radius: 10px;
          background: rgba(127,29,29,.2);
          color: #fca5a5;
          font-size: 12px;
        }

        .friday-input-area {
          padding: 12px;
          border-top: 1px solid rgba(255,255,255,.08);
          background: #141421;
        }

        .friday-input-box {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          padding: 8px;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 15px;
          background: #202031;
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
          line-height: 1.5;
          padding: 6px 4px;
        }

        .friday-textarea::placeholder {
          color: #77758a;
        }

        .friday-send-btn {
          width: 38px;
          height: 38px;
          flex: 0 0 38px;
          border: 0;
          border-radius: 12px;
          background: linear-gradient(135deg, #ec4899, #7c3aed);
          color: white;
          font-size: 17px;
          cursor: pointer;
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
          border: 0;
          border-radius: 8px;
          padding: 6px 9px;
          background: rgba(255,255,255,.07);
          color: #c4bfd5;
          cursor: pointer;
          font-size: 11px;
        }

        .friday-tool-btn.active {
          background: rgba(168,85,247,.22);
          color: #d8b4fe;
        }

        .friday-movie-section {
          margin: 4px 0 17px 36px;
        }

        .friday-result-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 9px;
          color: #e9d5ff;
          font-size: 12px;
          font-weight: 700;
        }

        .friday-result-count {
          color: #a78bfa;
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
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 11px;
          background: #1b1b29;
          color: white;
          text-align: left;
          cursor: pointer;
        }

        .friday-movie-card:active {
          background: #29243b;
        }

        .friday-poster {
          position: relative;
          width: 56px;
          height: 78px;
          flex: 0 0 56px;
          overflow: hidden;
          border-radius: 6px;
          background: #302b43;
        }

        .friday-poster img {
          position: absolute;
          z-index: 1;
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
          background: rgba(0,0,0,.7);
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
          color: #a78bfa;
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
        }
      `}</style>

      <div className="friday-root">
        {!open ? (
          <button
            type="button"
            className="friday-fab"
            aria-label="打开 Friday AI 助手"
            onClick={openPanel}
          >
            F
          </button>
        ) : null}

        {open ? (
          <section
            ref={panelRef}
            className={`friday-panel ${expanded ? "friday-expanded" : ""}`}
            aria-label="Friday AI 助手"
          >
            <header className="friday-header">
              <div className="friday-brand">
                <div className="friday-avatar">F</div>
                <div>
                  <div className="friday-brand-name">Friday</div>
                  <div className="friday-brand-sub">
                    {busy ? "正在思考…" : "LibreTV 智能影视助手"}
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
                  aria-label={expanded ? "缩小窗口" : "展开窗口"}
                  onClick={() => setExpanded((value) => !value)}
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

            <div className="friday-messages">
              {messages.length === 0 ? (
                <div className="friday-welcome">
                  <div className="friday-welcome-icon">F</div>
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
                      <div className="friday-bubble">{text}</div>
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
                      ? "正在听你说话…"
                      : "输入电影名称或发送消息…"
                  }
                  disabled={busy}
                  onChange={(event) => {
                    setInput(event.target.value.slice(0, MAX_INPUT_LENGTH));
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
                        setSpeaking(false);
                      }

                      setVoiceEnabled((value) => !value);
                    }}
                  >
                    {voiceEnabled ? "语音播报开" : "语音播报关"}
                  </button>
                </div>

                <div className="friday-tool-group">
                  {speaking ? (
                    <button
                      type="button"
                      className="friday-tool-btn active"
                      onClick={() => {
                        stopSpeech();
                        setSpeaking(false);
                      }}
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
