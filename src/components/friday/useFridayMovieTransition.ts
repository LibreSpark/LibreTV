"use client";

import { useCallback, useEffect, useRef } from "react";
import type { AnimationEvent, Dispatch, MutableRefObject, SetStateAction } from "react";

type MovieTransitionOptions<TMovie> = {
  openRef: MutableRefObject<boolean>;
  closingRef: MutableRefObject<boolean>;
  busyRef: MutableRefObject<boolean>;
  setClosing: Dispatch<SetStateAction<boolean>>;
  setOpen: Dispatch<SetStateAction<boolean>>;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  stopAllVoice: () => void;
  stop: () => void;
};

export function useFridayMovieTransition<TMovie>({
  openRef,
  closingRef,
  busyRef,
  setClosing,
  setOpen,
  setExpanded,
  stopAllVoice,
  stop,
}: MovieTransitionOptions<TMovie>) {
  const pendingMovieRef = useRef<TMovie | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const dispatchedRef = useRef(false);

  const clearMovieCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const resetPendingMovie = useCallback(() => {
    clearMovieCloseTimer();
    pendingMovieRef.current = null;
    dispatchedRef.current = false;
  }, [clearMovieCloseTimer]);

  const finalizeMovieOpen = useCallback(() => {
    if (dispatchedRef.current) return;

    const movie = pendingMovieRef.current;
    if (!movie) {
      setClosing(false);
      closingRef.current = false;
      return;
    }

    dispatchedRef.current = true;
    pendingMovieRef.current = null;
    clearMovieCloseTimer();
    closingRef.current = false;
    setClosing(false);

    window.dispatchEvent(
      new CustomEvent("friday-open-detail", { detail: movie }),
    );
  }, [clearMovieCloseTimer, closingRef, setClosing]);

  const handleOpenMovie = useCallback(
    (movie: TMovie) => {
      if (typeof window === "undefined") return;
      if (closingRef.current || dispatchedRef.current) return;

      stopAllVoice();
      if (busyRef.current) stop();

      pendingMovieRef.current = movie;
      dispatchedRef.current = false;
      openRef.current = false;
      closingRef.current = true;

      setClosing(true);
      setOpen(false);
      setExpanded(false);

      clearMovieCloseTimer();
      closeTimerRef.current = window.setTimeout(finalizeMovieOpen, 250);
    },
    [
      busyRef,
      closingRef,
      clearMovieCloseTimer,
      finalizeMovieOpen,
      openRef,
      setClosing,
      setExpanded,
      setOpen,
      stop,
      stopAllVoice,
    ],
  );

  const handlePanelAnimationEnd = useCallback(
    (event: AnimationEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.animationName !== "friday-panel-close") return;
      if (closingRef.current) finalizeMovieOpen();
    },
    [closingRef, finalizeMovieOpen],
  );

  useEffect(() => clearMovieCloseTimer, [clearMovieCloseTimer]);

  return {
    clearMovieCloseTimer,
    resetPendingMovie,
    handleOpenMovie,
    handlePanelAnimationEnd,
  };
}
