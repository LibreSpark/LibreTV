"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent } from "react";

type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

type Options = {
  openRef: MutableRefObject<boolean>;
  closingRef: MutableRefObject<boolean>;
  onOpen: () => void;
  onClose: () => void;
};

const FAB_SIZE = 68;
const DRAG_THRESHOLD = 6;

function clampPosition(position: { left: number; top: number }) {
  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - FAB_SIZE - margin);
  const maxTop = Math.max(margin, window.innerHeight - FAB_SIZE - margin);

  return {
    left: Math.min(maxLeft, Math.max(margin, position.left)),
    top: Math.min(maxTop, Math.max(margin, position.top)),
  };
}

/** Owns only the floating orb's drag, visibility, and restore interactions. */
export function useFridayFabController({
  openRef,
  closingRef,
  onOpen,
  onClose,
}: Options) {
  const [fabHidden, setFabHidden] = useState(false);
  const [fabPosition, setFabPosition] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const dragResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const handleResize = () => {
      setFabPosition((current) => (current ? clampPosition(current) : current));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    return () => {
      if (dragResetTimerRef.current !== null) {
        window.clearTimeout(dragResetTimerRef.current);
      }
    };
  }, []);

  const handleFabPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (openRef.current || closingRef.current) return;

    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers do not support pointer capture.
    }
  }, [openRef, closingRef]);

  const handleFabPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < DRAG_THRESHOLD) return;

    drag.moved = true;
    suppressClickRef.current = true;
    setFabPosition(clampPosition({
      left: event.clientX - drag.offsetX,
      top: event.clientY - drag.offsetY,
    }));
  }, []);

  const handleFabPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const wasMoved = drag.moved;
    dragRef.current = null;
    if (!wasMoved) return;

    suppressClickRef.current = true;
    if (dragResetTimerRef.current !== null) {
      window.clearTimeout(dragResetTimerRef.current);
    }
    dragResetTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      dragResetTimerRef.current = null;
    }, 350);
  }, []);

  const handleFabClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpen();
  }, [onOpen]);

  const hideAssistant = useCallback(() => {
    onClose();
    setFabHidden(true);
  }, [onClose]);

  const restoreAssistant = useCallback(() => {
    setFabHidden(false);
    setFabPosition(null);
  }, []);

  return {
    fabHidden,
    fabPosition,
    handleFabPointerDown,
    handleFabPointerMove,
    handleFabPointerUp,
    handleFabClick,
    hideAssistant,
    restoreAssistant,
  };
}
