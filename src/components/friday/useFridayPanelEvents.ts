"use client";

import { useEffect } from "react";

type FridayPanelEventsOptions = {
  open: boolean;
  closePanel: () => void;
  clearConversation: () => void;
  openAndListen: () => void;
  openImmersiveAndListen: () => void;
  openPanel: () => void;
};

/** Connects Friday's panel to keyboard and homepage custom events. */
export function useFridayPanelEvents({
  open,
  closePanel,
  clearConversation,
  openAndListen,
  openImmersiveAndListen,
  openPanel,
}: FridayPanelEventsOptions) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, closePanel]);

  useEffect(() => {
    const handleToggleFridayPanel = (event: Event) => {
      window.__FRIDAY_PENDING_OPEN__ = false;
      const detail = (
        event as CustomEvent<{ reset?: boolean; listen?: boolean; immersive?: boolean }>
      ).detail;

      if (detail?.reset) clearConversation();

      if (detail?.listen && detail?.immersive) {
        openImmersiveAndListen();
      } else if (detail?.listen) {
        openAndListen();
      } else {
        openPanel();
      }
    };

    window.addEventListener("toggle-friday-panel", handleToggleFridayPanel);
    return () => {
      window.removeEventListener("toggle-friday-panel", handleToggleFridayPanel);
    };
  }, [clearConversation, openAndListen, openImmersiveAndListen, openPanel]);
}
