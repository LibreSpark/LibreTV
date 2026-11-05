
"use client";

import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FridayStyles } from "@/components/friday/FridayStyles";
import { fridayReducer, initialFridayState } from "@/lib/friday/state";
import { FridayOrbVisual } from "@/components/friday/FridayOrbVisual";
import { FridayPanel, getPartText, getMovieDataForMessage } from "@/components/friday/FridayPanel";
import type { MovieItem } from "@/components/friday/FridayPanel";
import { useFridayVoiceController } from "@/components/friday/useFridayVoiceController";
import { useFridayFabController } from "@/components/friday/useFridayFabController";
import { useFridayResponseController } from "@/components/friday/useFridayResponseController";
import { useFridayRequestLifecycle } from "@/components/friday/useFridayRequestLifecycle";
import { useFridayPanelEvents } from "@/components/friday/useFridayPanelEvents";
import { useFridayMovieTransition } from "@/components/friday/useFridayMovieTransition";

import { useFridaySources, type FridaySourceConfig } from "@/components/friday/useFridaySources";
import { useFridayChatSession } from "@/components/friday/useFridayChatSession";



type FridayProps = {
  sources?: FridaySourceConfig[];
  filterAdult?: boolean;
  showFab?: boolean;
};

type AuroraState =
  | "standby"
  | "listening"
  | "thinking"
  | "speaking"
  | "completed";

const MAX_INPUT_LENGTH = 1000;

export default function AIFloatingBall({
  sources,
  filterAdult,
  showFab = true,
}: FridayProps) {
  const [machineState, dispatchMachine] = useReducer(
    fridayReducer,
    initialFridayState,
  );


  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [immersive, setImmersive] = useState(false);

  const openRef = useRef(false);
  const closingRef = useRef(false);
  const busyRef = useRef(false);

  const handleSendRef = useRef<
    (text?: string, keepVoiceSession?: boolean) => Promise<void>
  >(async () => {});

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);


  const {
    listening, voiceEnabled, speaking, completed, voiceError, voiceSessionActive,
    voiceSessionActiveRef, startListening, scheduleVoiceResume, setSpeaking,
    clearVoiceResumeTimer, setVoiceSession, stopRecognition, stopSpeech,
    stopAllVoice, speakText, toggleVoiceEnabled,
    stopSpeechAndResume, toggleListening, setVoiceError, setCompleted,
    lastSpokenMessageRef,
  } = useFridayVoiceController({
    busyRef, openRef, closingRef, dispatchMachine, setInput, handleSendRef,
  });

  const { activeSources, activeFilterAdult } = useFridaySources(sources, filterAdult);

  const {
    typedMessages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    busy,
  } = useFridayChatSession({
    sources: activeSources,
    filterAdult: activeFilterAdult,
  });

  const { beginRequest, failActiveRequest, cancelActiveRequest } =
    useFridayRequestLifecycle({ busy, error, dispatchMachine });

  // 同步引用，避免回调读取到上一轮渲染的状态。
  busyRef.current = busy;
  closingRef.current = closing;

  const {
    clearMovieCloseTimer,
    resetPendingMovie,
    handleOpenMovie,
    handlePanelAnimationEnd,
  } = useFridayMovieTransition<MovieItem>({
    openRef,
    closingRef,
    busyRef,
    setClosing,
    setOpen,
    setExpanded,
    stopAllVoice,
    stop,
  });

  const auroraState: AuroraState = speaking
    ? "speaking"
    : listening
      ? "listening"
      : busy
        ? "thinking"
        : completed
          ? "completed"
          : "standby";

  const stateLabel = voiceError
    ? "语音暂不可用，可重试或使用文字输入"
    : auroraState === "listening"
      ? "正在聆听"
      : auroraState === "thinking"
        ? "正在寻找合适的影视资源"
        : auroraState === "speaking"
          ? "Friday 正在回复"
          : auroraState === "completed"
            ? "已完成"
            : "随时为你服务";

  const openPanel = useCallback(() => {
    resetPendingMovie();
    clearVoiceResumeTimer();

    closingRef.current = false;
    openRef.current = true;

    setClosing(false);
    setOpen(true);
    dispatchMachine({ type: "OPEN" });
    setExpanded(false);
    setImmersive(false);
    setVoiceError("");
  }, [resetPendingMovie, clearVoiceResumeTimer, setVoiceError]);

  const openAndListen = useCallback(() => {
    openPanel();

    // 先同步更新引用，再启动识别。
    openRef.current = true;
    closingRef.current = false;

    setVoiceSession(true);

    // 保留真实用户点击手势。
    startListening(false);
  }, [openPanel, startListening]);

  const openImmersiveAndListen = useCallback(() => {
    openPanel();
    openRef.current = true;
    closingRef.current = false;
    setImmersive(true);
    setExpanded(true);
    setVoiceSession(true);
    // 保留真实用户点击手势，直接启动现有语音识别器。
    startListening(false);
  }, [openPanel, startListening, setVoiceSession]);

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

      beginRequest();

      if (inputRef.current) {
        inputRef.current.style.height = "auto";
      }

      try {
        await sendMessage({ text: content });
      } catch (sendError) {
        console.error("[Friday] Send failed:", sendError);

        failActiveRequest("send-failed", "消息发送失败，请检查网络后重试。");
        setVoiceError("消息发送失败，请检查网络后重试。");

        if (keepVoiceSession && voiceSessionActiveRef.current) {
          setVoiceSession(false);
        }
      }
    },
    [
      input,
      sendMessage,
      beginRequest,
      failActiveRequest,
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

  useEffect(() => {
    const handleHomepageVoiceSubmit = (event: Event) => {
      const text = (
        event as CustomEvent<{ text?: string }>
      ).detail?.text?.trim();
      if (!text) return;

      // 首页麦克风的识别结果直接进入 Friday 对话/影视解析流程。
      openPanel();
      window.setTimeout(() => {
        void handleSendRef.current(text);
      }, 0);
    };

    window.addEventListener("friday-submit-message", handleHomepageVoiceSubmit);
    return () => {
      window.removeEventListener("friday-submit-message", handleHomepageVoiceSubmit);
    };
  }, [openPanel]);

  useEffect(() => {
    if (!immersive) return;
    const wasAlreadyLocked = document.body.classList.contains("friday-popup-lock");
    document.body.classList.add("friday-popup-lock");
    return () => {
      if (!wasAlreadyLocked) {
        document.body.classList.remove("friday-popup-lock");
      }
    };
  }, [immersive]);

  const closePanel = useCallback(() => {
    resetPendingMovie();

    openRef.current = false;
    closingRef.current = false;

    stopAllVoice();

    if (busyRef.current) {
      stop();
    }

    setClosing(false);
    setOpen(false);
    dispatchMachine({ type: "CLOSE" });
    if (busyRef.current) {
      cancelActiveRequest();
    }
    setExpanded(false);
    setImmersive(false);
  }, [resetPendingMovie, stopAllVoice, stop, cancelActiveRequest]);

  const {
    fabHidden,
    fabPosition,
    handleFabPointerDown,
    handleFabPointerMove,
    handleFabPointerUp,
    handleFabClick,
    hideAssistant,
    restoreAssistant,
  } = useFridayFabController({
    openRef,
    closingRef,
    onOpen: openAndListen,
    onClose: closePanel,
  });

  const interrupt = useCallback(() => {
    stopAllVoice();

    if (busyRef.current) {
      stop();
    }
  }, [stopAllVoice, stop]);

  useFridayResponseController({
    messages: typedMessages,
    status,
    open,
    error,
    voiceEnabled,
    completed,
    voiceSessionActiveRef,
    lastSpokenMessageRef,
    speakText,
    scheduleVoiceResume,
    setSpeaking,
    setCompleted,
    setVoiceError,
  });

  useEffect(() => {
    if (!open) return;

    const container = messagesRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [typedMessages, busy, error, open]);

  useEffect(() => {
    setMounted(true);

    if (window.__FRIDAY_PENDING_OPEN__) {
      window.__FRIDAY_PENDING_OPEN__ = false;
      openPanel();
    }

    return () => {
      openRef.current = false;
      closingRef.current = false;

      clearMovieCloseTimer();

    };
  }, [clearMovieCloseTimer, openPanel]);

  const clearConversation = useCallback(() => {
    interrupt();

    setMessages([]);
    lastSpokenMessageRef.current = "";

    setCompleted(false);
    setVoiceError("");
    setInput("");

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  }, [interrupt, setMessages]);

  useFridayPanelEvents({
    open,
    closePanel,
    clearConversation,
    openAndListen,
    openImmersiveAndListen,
    openPanel,
  });

  const resizeTextarea = useCallback(() => {
    const element = inputRef.current;
    if (!element) return;

    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 110)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  if (!mounted) return null;

  const content = (
    <>
      <FridayStyles />

      <div className="friday-root">
        {showFab && !open && !closing && !fabHidden ? (
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
            <FridayOrbVisual />
          </button>
        ) : null}

        {open || closing ? (
          <FridayPanel
            expanded={expanded}
            immersive={immersive}
            closing={closing}
            auroraState={auroraState}
            agentState={machineState.agent}
            voiceState={machineState.voice}
            stateLabel={stateLabel}
            onAnimationEnd={handlePanelAnimationEnd}
            onClose={closePanel}
            messagesRef={messagesRef}
            messages={typedMessages}
            listening={listening}
            busy={busy}
            status={status}
            error={error}
            speaking={speaking}
            completed={completed}
            voiceSessionActive={voiceSessionActive}
            inputRef={inputRef}
            input={input}
            setInput={setInput}
            onSend={() => { void handleSend(); }}
            onToggleListening={toggleListening}
            voiceError={voiceError}
            voiceEnabled={voiceEnabled}
            onToggleVoiceEnabled={toggleVoiceEnabled}
            onClearConversation={clearConversation}
            onStopSpeechAndResume={stopSpeechAndResume}
            onInterrupt={interrupt}
            onToggleExpanded={() => setExpanded((value) => !value)}
            onHideAssistant={hideAssistant}
            onOpenMovie={handleOpenMovie}
          />
        ) : null}
      {showFab && fabHidden && !open ? (
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
      </div>
    </>
  );

  return createPortal(content, document.body);
}
