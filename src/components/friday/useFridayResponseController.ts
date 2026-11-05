"use client";

import { useEffect, useRef } from "react";
import type { MessageLike } from "@/components/friday/FridayPanel";
import {
  getPartText,
  getMovieDataForMessage,
} from "@/components/friday/FridayPanel";

type MutableRef<T> = {
  current: T;
};

type FridayResponseControllerOptions = {
  messages: MessageLike[];
  status: string;
  open: boolean;
  error?: { message?: string } | null;
  voiceEnabled: boolean;
  completed: boolean;
  voiceSessionActiveRef: MutableRef<boolean>;
  lastSpokenMessageRef: MutableRef<string>;
  speakText: (text: string, messageId: string) => void;
  scheduleVoiceResume: () => void;
  setSpeaking: (value: boolean) => void;
  setCompleted: (value: boolean) => void;
  setVoiceError: (message: string) => void;
};

/**
 * Coordinates post-response speech, request-error feedback, and the
 * short-lived completion indicator. Recognition startup remains in the
 * voice controller so its first call stays inside the user's click event.
 */
export function useFridayResponseController({
  messages,
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
}: FridayResponseControllerOptions) {
  const lastCompletedMessageRef = useRef("");

  useEffect(() => {
    if (status !== "ready" || !open) return;

    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message?.role === "assistant");

    if (!lastAssistant?.id) return;
    if (lastCompletedMessageRef.current === lastAssistant.id) return;

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
    messages,
    status,
    open,
    voiceEnabled,
    lastSpokenMessageRef,
    speakText,
    setCompleted,
    scheduleVoiceResume,
  ]);

  useEffect(() => {
    if (!error) return;

    setSpeaking(false);
    setCompleted(false);

    if (voiceSessionActiveRef.current) {
      setVoiceError("Friday 请求失败，请检查网络后重新尝试。");
      scheduleVoiceResume();
    }
  }, [error, setSpeaking, voiceSessionActiveRef, setVoiceError]);

  useEffect(() => {
    if (!completed) return;

    const timer = window.setTimeout(() => {
      setCompleted(false);
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [completed, setCompleted]);
}
