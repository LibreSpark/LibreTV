"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { FridayEvent } from "@/lib/friday/types";

type SpeechRecognitionAlternativeLike = { transcript: string };
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

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type Options = {
  busyRef: MutableRefObject<boolean>;
  openRef: MutableRefObject<boolean>;
  closingRef: MutableRefObject<boolean>;
  dispatchMachine: Dispatch<FridayEvent>;
  setInput: Dispatch<SetStateAction<string>>;
  handleSendRef: MutableRefObject<
    (text?: string, keepVoiceSession?: boolean) => Promise<void>
  >;
};

const MAX_INPUT_LENGTH = 1000;
const VOICE_RESUME_DELAY = 700;

export function shouldEndVoiceSession(error?: string): boolean {
  return Boolean(error && error !== "aborted" && error !== "no-speech");
}

export function getSpeechErrorMessage(error?: string): string {
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
      return "当前浏览器暂不支持中文语音识别，请使用键盘输入。";
    case "aborted":
      return "";
    default:
      return "语音识别暂时不可用，请检查麦克风权限或改用键盘输入。";
  }
}

/** 只管理浏览器语音识别/播报生命周期；不负责聊天、搜索、详情或面板布局。 */
export function useFridayVoiceController({
  busyRef,
  openRef,
  closingRef,
  dispatchMachine,
  setInput,
  handleSendRef,
}: Options) {
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  const setSpeakingState = useCallback((value: boolean) => {
    speakingRef.current = value;
    setSpeaking(value);
  }, []);
  const [completed, setCompleted] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const lastSpokenMessageRef = useRef("");

  const listeningRef = useRef(false);
  const voiceSessionActiveRef = useRef(false);
  const voiceSessionIdRef = useRef(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const recognitionErrorRef = useRef("");
  const pendingVoiceTextRef = useRef("");
  const manualVoiceStopRef = useRef(false);
  const voiceResumeTimerRef = useRef<number | null>(null);
  const startListeningRef = useRef<(automatic?: boolean) => void>(() => {});

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
  }, [dispatchMachine]);

  const stopSpeech = useCallback((notifyMachine = true) => {
    utteranceRef.current = null;
    if (typeof window !== "undefined") {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        // 忽略浏览器语音取消异常。
      }
    }
    setSpeakingState(false);
    if (notifyMachine) {
      dispatchMachine({
        type: "VOICE_STOP",
        sessionId: voiceSessionIdRef.current,
      });
    }
  }, [setSpeakingState, dispatchMachine]);

  const stopRecognition = useCallback((abort = true) => {
    const recognition = recognitionRef.current;

    recognitionRef.current = null;
    listeningRef.current = false;
    pendingVoiceTextRef.current = "";
    recognitionErrorRef.current = "";
    setListening(false);

    if (!recognition) return;

    try {
      if (abort) recognition.abort();
      else recognition.stop();
    } catch {
      // 忽略浏览器识别实例已结束的异常。
    }
  }, []);

  const stopAllVoice = useCallback(() => {
    setVoiceSession(false);
    clearVoiceResumeTimer();
    stopRecognition(true);
    stopSpeech();
  }, [setVoiceSession, clearVoiceResumeTimer, stopRecognition, stopSpeech]);

  const scheduleVoiceResume = useCallback(() => {
    clearVoiceResumeTimer();

    if (!voiceSessionActiveRef.current) return;
    if (!openRef.current || closingRef.current) return;
    if (busyRef.current || speakingRef.current) return;

    const sessionId = voiceSessionIdRef.current;
    voiceResumeTimerRef.current = window.setTimeout(() => {
      voiceResumeTimerRef.current = null;

      if (sessionId !== voiceSessionIdRef.current) return;
      if (!voiceSessionActiveRef.current) return;
      if (!openRef.current || closingRef.current) return;
      if (busyRef.current || listeningRef.current) return;

      startListeningRef.current(true);
    }, VOICE_RESUME_DELAY);
  }, [clearVoiceResumeTimer, openRef, closingRef, busyRef]);

  const startListening = useCallback((automatic = false) => {
    if (busyRef.current || listeningRef.current) return;
    if (closingRef.current || !openRef.current) return;

    if (!automatic && !voiceSessionActiveRef.current) {
      setVoiceSession(true);
    }
    if (!voiceSessionActiveRef.current) return;

    clearVoiceResumeTimer();
    setVoiceError("");

    if (typeof window === "undefined" || !window.isSecureContext) {
      setVoiceSession(false);
      setVoiceError("语音识别需要安全连接，请使用 HTTPS 网站或 localhost。");
      return;
    }

    const SpeechRecognitionClass =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setVoiceSession(false);
      setVoiceError("当前浏览器暂不支持语音识别，请使用键盘输入。");
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

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new SpeechRecognitionClass();
    } catch {
      dispatchMachine({
        type: "VOICE_FAILED",
        sessionId: voiceSessionIdRef.current,
        code: "constructor-failed",
        message: "无法初始化语音识别，请检查浏览器兼容性或改用键盘输入。",
      });
      setVoiceSession(false);
      setVoiceError("无法初始化语音识别，请检查浏览器兼容性或改用键盘输入。");
      return;
    }

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
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }

      const recognizedText = (finalText || interimText)
        .trim()
        .slice(0, MAX_INPUT_LENGTH);
      if (recognizedText) setInput(recognizedText);

      if (finalText.trim()) {
        dispatchMachine({ type: "VOICE_FINAL_TEXT", sessionId });
        pendingVoiceTextRef.current = finalText.trim().slice(0, MAX_INPUT_LENGTH);
      }
    };

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      if (sessionId !== voiceSessionIdRef.current) return;

      recognitionErrorRef.current = event.error || "unknown";
      const message = getSpeechErrorMessage(event.error);
      listeningRef.current = false;
      setListening(false);
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
        void handleSendRef.current(finalText, !wasManualStop);
        return;
      }
      if (wasManualStop) {
        setVoiceSession(false);
        return;
      }
      if (!voiceSessionActiveRef.current) return;

      if (recognitionError && recognitionError !== "aborted") {
        if (recognitionError === "no-speech") {
          setVoiceError("没有识别到语音，请点击麦克风重新聆听。");
        } else if (shouldEndVoiceSession(recognitionError)) {
          // 权限、设备或网络错误后结束本轮会话，避免残留活动态。
          // 用户修复问题后仍可再次点击麦克风启动新会话。
          setVoiceSession(false);
        }
        return;
      }
      if (openRef.current && !busyRef.current) {
        setVoiceError("本次没有识别到完整语音，请点击麦克风继续。");
      }
    };

    recognitionRef.current = recognition;
    try {
      // 首次启动必须在用户点击的同步调用链内。
      recognition.start();
    } catch (recognitionError) {
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
      const errorName =
        recognitionError instanceof Error ? recognitionError.name : "";
      const startErrorMessage =
        errorName === "NotAllowedError" || errorName === "SecurityError"
          ? "浏览器未授予麦克风权限，请在网站设置中允许麦克风访问。"
          : errorName === "InvalidStateError"
            ? "语音识别仍在启动，请稍后再点击麦克风。"
            : automatic
              ? "浏览器未允许自动恢复麦克风，请点击麦克风继续聆听。"
              : "语音识别启动失败，请检查麦克风权限后重试。";
      setVoiceSession(false);
      setVoiceError(startErrorMessage);
    }
  }, [
    busyRef,
    closingRef,
    openRef,
    setVoiceSession,
    clearVoiceResumeTimer,
    setVoiceError,
    stopSpeech,
    dispatchMachine,
    setInput,
    handleSendRef,
  ]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const speakText = useCallback((text: string, messageId: string) => {
    if (!voiceEnabled || !text.trim()) {
      setSpeakingState(false);
      setCompleted(true);
      scheduleVoiceResume();
      return;
    }

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSpeakingState(false);
      setCompleted(true);
      dispatchMachine({
        type: "VOICE_FAILED",
        sessionId: voiceSessionIdRef.current,
        code: "speech-synthesis-unsupported",
        message: "当前浏览器不支持语音播报。",
      });
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
      setSpeakingState(true);
      dispatchMachine({
        type: "VOICE_SPEAK_START",
        sessionId: voiceSessionIdRef.current,
      });
    };
    utterance.onend = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setSpeakingState(false);
      setCompleted(true);
      dispatchMachine({
        type: "VOICE_SPEAK_END",
        sessionId: voiceSessionIdRef.current,
      });
      scheduleVoiceResume();
    };
    utterance.onerror = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setSpeakingState(false);
      setCompleted(true);
      dispatchMachine({
        type: "VOICE_FAILED",
        sessionId: voiceSessionIdRef.current,
        code: "speech-synthesis-error",
        message: "语音播报中断",
      });
      setVoiceError("语音播报中断，请继续使用文字或重新开启语音。");
      scheduleVoiceResume();
    };

    lastSpokenMessageRef.current = messageId;
    utteranceRef.current = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch (speechError) {
      console.error("[Friday] Speech synthesis failed:", speechError);
      if (utteranceRef.current === utterance) utteranceRef.current = null;
      setSpeakingState(false);
      setCompleted(true);
      dispatchMachine({
        type: "VOICE_FAILED",
        sessionId: voiceSessionIdRef.current,
        code: "speech-synthesis-start-failed",
        message: "语音播报启动失败",
      });
      setVoiceError("语音播报启动失败，请继续使用文字或重新开启语音。");
      scheduleVoiceResume();
    }
  }, [voiceEnabled, stopSpeech, scheduleVoiceResume, setVoiceError, dispatchMachine]);

  const toggleVoiceEnabled = useCallback(() => {
    if (voiceEnabled) {
      stopSpeech();
      if (voiceSessionActiveRef.current) scheduleVoiceResume();
    }
    setVoiceEnabled((value) => !value);
  }, [voiceEnabled, stopSpeech, scheduleVoiceResume]);

  const stopSpeechAndResume = useCallback(() => {
    stopSpeech();
    if (voiceSessionActiveRef.current) scheduleVoiceResume();
  }, [stopSpeech, scheduleVoiceResume]);

  const toggleListening = useCallback(() => {
    if (listeningRef.current) {
      // 等待 onresult/onend 收齐最终识别文本，不提前结束 session。
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
  }, [clearVoiceResumeTimer, stopRecognition, setVoiceSession]);

  useEffect(() => {
    return () => {
      voiceSessionActiveRef.current = false;
      voiceSessionIdRef.current += 1;
      clearVoiceResumeTimer();
      stopRecognition(true);
      stopSpeech(false);
    };
  }, [clearVoiceResumeTimer, stopRecognition, stopSpeech]);

  return {
    listening,
    voiceEnabled,
    speaking,
    completed,
    voiceError,
    voiceSessionActive,
    voiceSessionActiveRef,
    startListeningRef,
    scheduleVoiceResume,
    setSpeaking: setSpeakingState,
    clearVoiceResumeTimer,
    setVoiceSession,
    stopRecognition,
    stopSpeech,
    stopAllVoice,
    startListening,
    speakText,
    toggleVoiceEnabled,
    stopSpeechAndResume,
    toggleListening,
    setVoiceError,
    setCompleted,
    lastSpokenMessageRef,
  };
}
