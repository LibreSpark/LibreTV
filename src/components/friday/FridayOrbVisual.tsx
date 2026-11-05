"use client";

import React, { useState } from "react";

type FridayOrbVisualProps = {
  state?: "standby" | "listening" | "thinking" | "speaking" | "completed";
  isListening?: boolean;
};

/**
 * Media-first Friday orb. The MP4 is composited with screen blending by CSS;
 * a lightweight CSS orb remains visible if the media file cannot be loaded.
 */
export function FridayOrbVisual({
  state = "standby",
  isListening = false,
}: FridayOrbVisualProps) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const currentState = isListening ? "listening" : state;

  return (
    <div
      className="friday-orb-visual"
      data-state={currentState}
      role="img"
      aria-label={currentState === "listening" ? "Friday 正在聆听" : "Friday"}
    >
      {!mediaFailed ? (
        <video
          className="friday-orb-media"
          src="/media/paraplex-1080x1080.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          onError={() => setMediaFailed(true)}
          aria-hidden="true"
        />
      ) : (
        <span className="friday-orb-fallback" aria-hidden="true" />
      )}
      {currentState === "listening" ? (
        <span className="friday-orb-listening">Listening...</span>
      ) : null}
    </div>
  );
}
