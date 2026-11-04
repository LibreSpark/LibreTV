"use client";

import React from "react";
import type { RefObject } from "react";
import { FridayOrbVisual } from "@/components/friday/FridayOrbVisual";
import { FridayConversation } from "@/components/friday/FridayConversation";
import { FridayComposer } from "@/components/friday/FridayComposer";

const MAX_MOVIE_CARDS = 60;

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
