"use client";

import React from "react";
import type { RefObject } from "react";

const MAX_INPUT_LENGTH = 1000;

export function FridayComposer({
  inputRef, input, setInput, busy, closing, listening, onSend, onToggleListening,
  voiceError, voiceEnabled, onToggleVoiceEnabled, onClearConversation,
  speaking, onStopSpeechAndResume, onInterrupt, onToggleExpanded, expanded, onHideAssistant,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  closing: boolean;
  listening: boolean;
  onSend: () => void;
  onToggleListening: () => void;
  voiceError: string;
  voiceEnabled: boolean;
  onToggleVoiceEnabled: () => void;
  onClearConversation: () => void;
  speaking: boolean;
  onStopSpeechAndResume: () => void;
  onInterrupt: () => void;
  onToggleExpanded: () => void;
  expanded: boolean;
  onHideAssistant: () => void;
}) {
  return (
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
        aria-describedby={voiceError ? "friday-voice-error" : undefined}
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
      <div
        id="friday-voice-error"
        className="friday-voice-error"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
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
  );
}