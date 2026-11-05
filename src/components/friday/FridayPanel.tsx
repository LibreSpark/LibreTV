"use client";

import React from "react";
import type { RefObject } from "react";
import { FridayOrbVisual } from "@/components/friday/FridayOrbVisual";
import { FridayConversation } from "@/components/friday/FridayConversation";
import { FridayComposer } from "@/components/friday/FridayComposer";
import { getMovieDataForMessage, getPartText } from "@/lib/friday/message";


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
  auroraState: "standby" | "listening" | "thinking" | "speaking" | "completed";
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

export { getMovieDataForMessage, getPartText } from "@/lib/friday/message";








export function FridayPanel({
  expanded, closing, auroraState, agentState, voiceState, stateLabel,
  onAnimationEnd, onClose, messagesRef, messages, listening, busy, status,
  error, speaking, completed, voiceSessionActive, inputRef, input, setInput,
  onSend, onToggleListening, voiceError, voiceEnabled, onToggleVoiceEnabled,
  onClearConversation, onStopSpeechAndResume, onInterrupt, onToggleExpanded,
  onHideAssistant, onOpenMovie,
}: FridayPanelProps) {
  const typedMessages = messages;
  const conversationEntries = typedMessages.map((message) => ({
    id: message.id,
    isUser: message.role === "user",
    text: getPartText(message),
    movies: getMovieDataForMessage(message),
  }));
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
    
                <FridayConversation
                  messagesRef={messagesRef}
                  messages={conversationEntries}
                  listening={listening}
                  busy={busy}
                  status={status}
                  error={error}
                  onOpenMovie={onOpenMovie}
                />
    
                <div className="friday-orb-stage">
                  <span className="friday-orb-status" role="status" aria-live="polite" aria-atomic="true">
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
    
                  <FridayOrbVisual state={auroraState} />
                </div>
    
                <FridayComposer
                  inputRef={inputRef}
                  input={input}
                  setInput={setInput}
                  busy={busy}
                  closing={closing}
                  listening={listening}
                  onSend={onSend}
                  onToggleListening={onToggleListening}
                  voiceError={voiceError}
                  voiceEnabled={voiceEnabled}
                  onToggleVoiceEnabled={onToggleVoiceEnabled}
                  onClearConversation={onClearConversation}
                  speaking={speaking}
                  onStopSpeechAndResume={onStopSpeechAndResume}
                  onInterrupt={onInterrupt}
                  onToggleExpanded={onToggleExpanded}
                  expanded={expanded}
                  onHideAssistant={onHideAssistant}
                />
              </section>
  );
}
