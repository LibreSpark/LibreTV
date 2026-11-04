"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type { FridayEvent } from "@/lib/friday/types";

type FridayRequestLifecycleOptions = {
  busy: boolean;
  error?: { message?: string } | null;
  dispatchMachine: Dispatch<FridayEvent>;
};

export function useFridayRequestLifecycle({
  busy,
  error,
  dispatchMachine,
}: FridayRequestLifecycleOptions) {
  const requestSequenceRef = useRef(0);
  const activeRequestIdRef = useRef(0);
  const observedBusyRef = useRef(false);

  const beginRequest = useCallback(() => {
    const requestId = ++requestSequenceRef.current;
    activeRequestIdRef.current = requestId;
    observedBusyRef.current = false;
    dispatchMachine({ type: "MESSAGE_SUBMITTED", requestId });
    return requestId;
  }, [dispatchMachine]);

  const failActiveRequest = useCallback(
    (code: string, message: string) => {
      const requestId = activeRequestIdRef.current;
      if (!requestId) return;

      dispatchMachine({
        type: "REQUEST_FAILED",
        requestId,
        code,
        message,
      });
      activeRequestIdRef.current = 0;
      observedBusyRef.current = false;
    },
    [dispatchMachine],
  );

  const cancelActiveRequest = useCallback(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;

    dispatchMachine({ type: "REQUEST_CANCELLED", requestId });
    activeRequestIdRef.current = 0;
    observedBusyRef.current = false;
  }, [dispatchMachine]);

  useEffect(() => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return;

    if (error) {
      dispatchMachine({
        type: "REQUEST_FAILED",
        requestId,
        code: "chat_request_failed",
        message: error.message || "消息请求失败",
      });
      activeRequestIdRef.current = 0;
      observedBusyRef.current = false;
      return;
    }

    if (busy) {
      observedBusyRef.current = true;
      return;
    }

    if (observedBusyRef.current) {
      dispatchMachine({ type: "RESPONSE_COMPLETED", requestId });
      activeRequestIdRef.current = 0;
      observedBusyRef.current = false;
    }
  }, [busy, error, dispatchMachine]);

  return { beginRequest, failActiveRequest, cancelActiveRequest };
}
