"use client";

import React from "react";
import type { RefObject } from "react";
import FridayOrb from "@/components/friday/FridayOrb";
import { LiquidGlassSurface } from "@/components/ui/liquid-glass";
import { FridayConversation } from "@/components/friday/FridayConversation";
import { FridayComposer } from "@/components/friday/FridayComposer";
import { getMovieDataForMessage, getPartText } from "@/lib/friday/message";
import type { FridayWorkflowView } from "@/components/friday/useFridayChatSession";
import type { TaskSnapshot } from "@/lib/friday/task-runtime";


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
  immersive: boolean;
  closing: boolean;
  auroraState: "standby" | "listening" | "thinking" | "speaking" | "completed";
  audioLevel: number;
  agentState: string;
  voiceState: string;
  stateLabel: string;
  onAnimationEnd: (event: React.AnimationEvent<HTMLElement>) => void;
  onClose: () => void;
  messagesRef: RefObject<HTMLDivElement | null>;
  messages: MessageLike[];
  workflowBySearchId: Record<string, FridayWorkflowView>;
  onRetryWorkflow: (searchId: string) => void;
  restoredTasks: TaskSnapshot[];
  onRetryInterruptedTask: (taskId: string) => void;
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
  language: "zh" | "en";
  onLanguageChange: (language: "zh" | "en") => void;
  assistantId: "friday" | "jarvis" | "lin-meimei";
  onAssistantChange: (assistantId: "friday" | "jarvis" | "lin-meimei") => void;
  wakeWordEnabled: boolean;
  onWakeWordChange: (enabled: boolean) => void;
  onRevokeSession: () => void;
  onClearTaskHistory: () => void;
};

export { getMovieDataForMessage, getPartText } from "@/lib/friday/message";








export function FridayPanel({
  expanded, immersive, closing, auroraState, audioLevel, agentState, voiceState, stateLabel,
  onAnimationEnd, onClose, messagesRef, messages, workflowBySearchId, onRetryWorkflow, restoredTasks, onRetryInterruptedTask, listening, busy, status,
  error, speaking, completed, voiceSessionActive, inputRef, input, setInput,
  onSend, onToggleListening, voiceError, voiceEnabled, onToggleVoiceEnabled,
  onClearConversation, onStopSpeechAndResume, onInterrupt, onToggleExpanded,
  onHideAssistant, onOpenMovie, language, onLanguageChange, assistantId, onAssistantChange,
  wakeWordEnabled, onWakeWordChange, onRevokeSession, onClearTaskHistory,
}: FridayPanelProps) {
  const typedMessages = messages;
  const conversationEntries = typedMessages.map((message) => ({
    id: message.id,
    isUser: message.role === "user",
    text: getPartText(message),
    movies: getMovieDataForMessage(message),
    workflows: workflowBySearchId,
  }));
  return (
              <LiquidGlassSurface
                as="section"
                variant="panel"
                className={`friday-panel ${
                  expanded ? "friday-expanded" : ""
                } ${immersive ? "friday-immersive" : ""} ${closing ? "friday-closing" : ""}`}
                data-state={auroraState}
                data-agent-state={agentState}
                data-voice-state={voiceState}
                aria-label={language === "en" ? "Friday AI assistant" : "Friday AI 助手"}
                aria-hidden={closing}
                onAnimationEnd={onAnimationEnd}
              >
                <div className="friday-canvas-top">
                  <div className="friday-wordmark">{assistantId === "jarvis" ? "Jarvis" : assistantId === "lin-meimei" ? "林妹妹" : "Friday"}</div>
                  <select className="friday-tool-btn" aria-label={language === "en" ? "Assistant profile" : "助手角色"} value={assistantId} onChange={(event) => onAssistantChange(event.target.value as "friday" | "jarvis" | "lin-meimei")}>
                    <option value="friday">Friday</option>
                    <option value="jarvis">Jarvis</option>
                    <option value="lin-meimei">林妹妹</option>
                  </select>
                  <button type="button" className="friday-tool-btn" aria-label={language === "en" ? "Switch language" : "切换语言"} title={language === "en" ? "Switch to Chinese" : "切换到 English"} onClick={() => onLanguageChange(language === "zh" ? "en" : "zh")}>{language === "zh" ? "中文 / EN" : "EN / 中文"}</button>
    
                  <div className="friday-header-actions">
                    <div className="friday-state-wrap">
                      <span className="friday-status-dot" />
                      <span>{stateLabel}</span>
                    </div>
    
                    <button
                      type="button"
                      className="friday-close-btn"
                      title={language === "en" ? "Close Friday" : "关闭 Friday"}
                      aria-label={language === "en" ? "Close Friday" : "关闭 Friday"}
                      onClick={onClose}
                    >
                      ×
                    </button>
                  </div>
                </div>
    
                <details className="friday-settings" style={{ margin: "0 16px 12px", padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.045)", color: "inherit" }}>
                  <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                    {language === "en" ? "Voice & session settings" : "语音与会话控制中心"}
                  </summary>
                  <div style={{ display: "grid", gap: 10, marginTop: 10, fontSize: 12 }}>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={wakeWordEnabled}
                        onChange={(event) => onWakeWordChange(event.target.checked)}
                      />
                      <span>
                        <strong>{language === "en" ? "Require a wake phrase" : "启用前台唤醒词确认"}</strong>
                        <span style={{ display: "block", opacity: 0.72, marginTop: 3 }}>
                          {language === "en"
                            ? "When the panel is open and listening, say “Friday” or “Hey Friday” before your command. This does not enable background or always-on listening."
                            : "仅在 Friday 面板打开且正在聆听时生效，说“Friday”或“嘿 Friday”后再说指令；不支持后台常驻监听。"}
                        </span>
                      </span>
                    </label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button type="button" className="friday-tool-btn" onClick={onRevokeSession}>
                        {language === "en" ? "End current session & clear chat" : "结束当前会话并清空对话"}
                      </button>
                      <button type="button" className="friday-tool-btn" onClick={onClearTaskHistory}>
                        {language === "en" ? "Delete local task history" : "删除本地任务记录"}
                      </button>
                    </div>
                  </div>
                </details>

                {restoredTasks.length > 0 ? (
                  <details className="friday-restored-tasks" style={{ margin: "0 16px 12px", padding: "10px 12px", borderRadius: 12, background: "rgba(255,255,255,0.05)", color: "inherit" }}>
                    <summary style={{ cursor: "pointer", fontSize: 13 }}>
                      {language === "en" ? `Local task history · ${restoredTasks.length}` : `本地任务记录 · ${restoredTasks.length}`}
                    </summary>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, opacity: 0.85 }}>
                      {restoredTasks.slice(0, 12).map((task) => (
                        <li key={task.taskId} style={{ margin: "4px 0" }}>
                          <strong>{task.agent}</strong> · {task.status === "running" ? (language === "en" ? "Last recorded as running; not auto-resumed after reload" : "上次记录为运行中，刷新后未自动续跑") : task.status === "queued" ? (language === "en" ? "Queued" : "等待执行") : task.status === "succeeded" ? (language === "en" ? "Completed" : "已完成") : task.status === "failed" ? (language === "en" ? "Failed" : "失败") : task.status === "cancelled" ? (language === "en" ? "Cancelled" : "已取消") : (language === "en" ? "Waiting" : "等待中")}
                          {task.error?.code === "TASK_INTERRUPTED" && task.error.retryable && !task.sideEffect ? (
                            <button type="button" className="friday-tool-btn" style={{ marginLeft: 8 }} onClick={() => onRetryInterruptedTask(task.taskId)}>
                              {language === "en" ? "Resume safe workflow" : "恢复可安全重试的工作流"}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <FridayConversation
                  messagesRef={messagesRef}
                  messages={conversationEntries}
                  listening={listening}
                  busy={busy}
                  status={status}
                  error={error}
                  onOpenMovie={onOpenMovie}
                  onRetryWorkflow={onRetryWorkflow}
                  language={language}
                />
    
                <div className="friday-orb-stage">
                  <span className="friday-orb-status" role="status" aria-live="polite" aria-atomic="true">
                    {voiceError
                      ? (language === "en" ? "Voice unavailable — retry or type" : "语音暂时不可用，可重试或使用文字输入")
                      : listening
                        ? (language === "en" ? "Tell me what you want to watch" : "请说出你想看的影片")
                      : busy
                        ? (language === "en" ? "Connecting to video sources" : "正在连接影视资源")
                        : speaking
                          ? (language === "en" ? "Speaking" : "正在为你播报")
                          : completed
                            ? (language === "en" ? "Ready" : "已经为你准备好了")
                            : voiceSessionActive
                              ? (language === "en" ? "Waiting to resume listening" : "等待恢复语音聆听")
                              : (language === "en" ? "Friday standing by" : "Friday 随时待命")}
                  </span>
    
                  <FridayOrb state={auroraState === "listening" ? "LISTENING" : auroraState === "thinking" ? "THINKING" : auroraState === "speaking" ? "SPEAKING" : "IDLE"} audioLevel={audioLevel} theme="auto" interactive={false} />
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
                  language={language}
                />
              </LiquidGlassSurface>
  );
}
