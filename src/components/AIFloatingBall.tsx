
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
import { FridayOrbVisual } from "@/components/friday/FridayOrbVisual";
import { FridayPanel, getPartText, getMovieDataForMessage } from "@/components/friday/FridayPanel";
import type { MessageLike, MovieItem } from "@/components/friday/FridayPanel";
import { useFridayVoiceController } from "@/components/friday/useFridayVoiceController";
import { useFridayFabController } from "@/components/friday/useFridayFabController";
import { useFridayResponseController } from "@/components/friday/useFridayResponseController";
import { useFridayRequestLifecycle } from "@/components/friday/useFridayRequestLifecycle";
import { useFridayPanelEvents } from "@/components/friday/useFridayPanelEvents";
import { useFridayMovieTransition } from "@/components/friday/useFridayMovieTransition";

import { useFridaySources, type FridaySourceConfig } from "@/components/friday/useFridaySources";



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
const FAB_SIZE = 68;
const MOVIE_CLOSE_DELAY = 250;

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
    voiceSessionActiveRef, startListeningRef, scheduleVoiceResume, setSpeaking,
    clearVoiceResumeTimer, setVoiceSession, stopRecognition, stopSpeech,
    stopAllVoice, speakText, toggleVoiceEnabled,
    stopSpeechAndResume, toggleListening, setVoiceError, setCompleted,
    lastSpokenMessageRef,
  } = useFridayVoiceController({
    busyRef, openRef, closingRef, dispatchMachine, setInput, handleSendRef,
  });

  const { activeSources, activeFilterAdult } = useFridaySources(sources, filterAdult);

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

  const openPanel = useCallback(() => {
    resetPendingMovie();
    clearVoiceResumeTimer();

    closingRef.current = false;
    openRef.current = true;

    setClosing(false);
    setOpen(true);
    dispatchMachine({ type: "OPEN" });
    setExpanded(false);
    setVoiceError("");
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
  }, [messages, busy, error, open]);

  useEffect(() => {
    setMounted(true);

    return () => {
      openRef.current = false;
      closingRef.current = false;

      clearMovieCloseTimer();

    };
  }, [clearMovieCloseTimer]);

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
      </div>

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
    </>
  );

  return createPortal(content, document.body);
}
