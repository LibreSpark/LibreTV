"use client";

import React from "react";

type FridayOrbVisualProps = {
  state?: "standby" | "listening" | "thinking" | "speaking" | "completed";
};

/** Friday 的纯视觉球体；只呈现传入状态，不持有语音、对话或搜索状态。 */
export function FridayOrbVisual({ state = "standby" }: FridayOrbVisualProps) {
  return (
    <div className="friday-orb-visual" data-state={state} aria-hidden="true">
      <div className="friday-orb-inner" />
      <div className="friday-orb-fluid" />
      <div className="friday-orb-rim" />
      <div className="friday-orb-glint" />
      <div className="friday-orb-glint-small" />
    </div>
  );
}
