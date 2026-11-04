"use client";

import React from "react";
import type { RefObject } from "react";
import { FridayOrbVisual } from "@/components/friday/FridayOrbVisual";
import { FridayMovieResults } from "@/components/friday/FridayMovieResults";

const MAX_MOVIE_CARDS = 60;
const MAX_INPUT_LENGTH = 1000;

export type MovieItem = {
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

export type MovieData = {
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

export type MessagePartLike = {
  type?: string;
  text?: string;
  data?: unknown;
};

export type MessageLike = {
  id: string;
  role: string;
  parts?: MessagePartLike[];
};



type FridayPanelProps = {
  expanded: boolean;
  closing: boolean;
  auroraState: string;
  agentState: string;
  voiceState: string;
  stateLabel: string;
  onAnimationEnd: (event: React.AnimationEvent<HTMLElement>) => void;
  onClose: () => void;
  messagesRef: RefObject<HTMLDivElement | null>;
  messages: MessageLike[];
  listening: boolean;
  busy: boolean;
  status: string;
  error?: { message?: string } | null;
  speaking: boolean;
  completed: boolean;
  voiceSessionActive: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  onToggleListening: () => void;
  voiceError: string;
  voiceEnabled: boolean;
  onToggleVoiceEnabled: () => void;
  onClearConversation: () => void;
  onStopSpeechAndResume: () => void;
  onInterrupt: () => void;
  onToggleExpanded: () => void;
  onHideAssistant: () => void;
  onOpenMovie: (movie: MovieItem) => void;
};

export function getPartText(message: MessageLike): string {
  if (!Array.isArray(message.parts)) return "";

  return message.parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("");
}

export function getMovieDataForMessage(message: MessageLike): MovieData[] {
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








export function FridayPanel({
  expanded, closing, auroraState, agentState, voiceState, stateLabel,
  onAnimationEnd, onClose, messagesRef, messages, listening, busy, status,
  error, speaking, completed, voiceSessionActive, inputRef, input, setInput,
  onSend, onToggleListening, voiceError, voiceEnabled, onToggleVoiceEnabled,
  onClearConversation, onStopSpeechAndResume, onInterrupt, onToggleExpanded,
  onHideAssistant, onOpenMovie,
}: FridayPanelProps) {
  const typedMessages = messages;
  return (
              <section
                className={`friday-panel ${
                  expanded ? "friday-expanded" : ""
                } ${closing ? "friday-closing" : ""}`}
                data-state={auroraState}
                data-agent-state={agentState}
                data-voice-state={voiceState}
                aria-label="Friday AI 助手"
                aria-hidden={closing}
                onAnimationEnd={onAnimationEnd}
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
                      onClick={onClose}
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
                          <FridayMovieResults
                            key={data.searchId}
                            data={data}
                            onOpen={onOpenMovie}
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
    
                  <FridayOrbVisual />
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
                          onSend();
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
                      onClick={onToggleListening}
                    >
                      {listening ? "Ⅱ" : "♩"}
                    </button>
    
                    <button
                      type="button"
                      className="friday-send-btn"
                      disabled={busy || closing || !input.trim()}
                      aria-label="发送消息"
                      onClick={onSend}
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
                        onClick={onToggleVoiceEnabled}
                      >
                        {voiceEnabled ? "语音播报开启" : "语音播报关闭"}
                      </button>
    
                      <button
                        type="button"
                        className="friday-tool-btn"
                        onClick={onClearConversation}
                      >
                        新对话
                      </button>
                    </div>
    
                    <div className="friday-tool-group">
                      {speaking ? (
                        <button
                          type="button"
                          className="friday-tool-btn active"
                          onClick={onStopSpeechAndResume}
                        >
                          停止播报
                        </button>
                      ) : null}
    
                      {busy ? (
                        <button
                          type="button"
                          className="friday-tool-btn active"
                          onClick={onInterrupt}
                        >
                          中断
                        </button>
                      ) : null}
    
                      <button
                        type="button"
                        className="friday-tool-btn active"
                        onClick={onToggleExpanded}
                      >
                        {expanded ? "收起面板" : "展开对话"}
                      </button>
    
                      <button
                        type="button"
                        className="friday-tool-btn"
                        onClick={onHideAssistant}
                      >
                        隐藏助手
                      </button>
                    </div>
                  </div>
                </footer>
              </section>
  );
}
