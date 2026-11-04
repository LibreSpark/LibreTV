"use client";

import React from "react";

/** Friday 的纯视觉球体；不持有语音、对话或搜索状态。 */
export function FridayOrbVisual() {
  return (
    <div className="friday-orb-visual" aria-hidden="true">
      <div className="friday-orb-inner" />
      <div className="friday-orb-fluid" />
      <div className="friday-orb-rim" />
      <div className="friday-orb-glint" />
      <div className="friday-orb-glint-small" />
    </div>
  );
}
