import { describe, expect, it } from "vitest";

import { fridayReducer, initialFridayState } from "./state";

describe("fridayReducer", () => {
  it("opens, expands, collapses and closes the surface", () => {
    const opened = fridayReducer(initialFridayState, { type: "OPEN" });
    expect(opened.surface).toBe("launcher");

    const expanded = fridayReducer(opened, { type: "EXPAND" });
    expect(expanded.surface).toBe("expanded");

    const collapsed = fridayReducer(expanded, { type: "COLLAPSE" });
    expect(collapsed.surface).toBe("compact");

    const closed = fridayReducer(collapsed, { type: "CLOSE" });
    expect(closed.surface).toBe("closed");
    expect(closed.voice).toBe("idle");
  });

  it("tracks a complete voice recognition lifecycle", () => {
    let state = fridayReducer(initialFridayState, {
      type: "VOICE_START_REQUESTED",
      sessionId: 1,
    });
    expect(state.voice).toBe("requesting");

    state = fridayReducer(state, { type: "VOICE_STARTED", sessionId: 1 });
    expect(state.voice).toBe("listening");

    state = fridayReducer(state, { type: "VOICE_FINAL_TEXT", sessionId: 1 });
    expect(state.voice).toBe("recognizing");

    state = fridayReducer(state, { type: "VOICE_ENDED", sessionId: 1 });
    expect(state.voice).toBe("idle");
  });

  it("ignores stale voice callbacks", () => {
    const state = fridayReducer(initialFridayState, {
      type: "VOICE_START_REQUESTED",
      sessionId: 7,
    });

    const stale = fridayReducer(state, {
      type: "VOICE_STARTED",
      sessionId: 6,
    });

    expect(stale).toBe(state);
  });

  it("supports repeated tool execution cycles for one request", () => {
    let state = fridayReducer(initialFridayState, {
      type: "MESSAGE_SUBMITTED",
      requestId: 10,
    });

    state = fridayReducer(state, { type: "TOOL_STARTED", requestId: 10 });
    expect(state.agent).toBe("executing");

    state = fridayReducer(state, { type: "TOOL_FINISHED", requestId: 10 });
    expect(state.agent).toBe("thinking");

    state = fridayReducer(state, { type: "TOOL_STARTED", requestId: 10 });
    expect(state.agent).toBe("executing");

    state = fridayReducer(state, { type: "TOOL_FINISHED", requestId: 10 });
    expect(state.agent).toBe("thinking");

    state = fridayReducer(state, {
      type: "RESPONSE_RENDERING",
      requestId: 10,
    });
    expect(state.agent).toBe("rendering");

    state = fridayReducer(state, {
      type: "RESPONSE_COMPLETED",
      requestId: 10,
    });
    expect(state.agent).toBe("completed");
    expect(state.surface).toBe("result");
  });

  it("ignores stale agent events from older requests", () => {
    const state = fridayReducer(initialFridayState, {
      type: "MESSAGE_SUBMITTED",
      requestId: 2,
    });

    const stale = fridayReducer(state, {
      type: "TOOL_STARTED",
      requestId: 1,
    });

    expect(stale).toBe(state);
  });

  it("keeps voice and agent errors isolated", () => {
    let state = fridayReducer(initialFridayState, {
      type: "VOICE_START_REQUESTED",
      sessionId: 3,
    });

    state = fridayReducer(state, {
      type: "VOICE_FAILED",
      sessionId: 3,
      code: "not-allowed",
      message: "Microphone permission denied",
    });

    state = fridayReducer(state, {
      type: "MESSAGE_SUBMITTED",
      requestId: 4,
    });

    state = fridayReducer(state, {
      type: "REQUEST_FAILED",
      requestId: 4,
      code: "network",
      message: "Request failed",
    });

    expect(state.errors.voice?.code).toBe("not-allowed");
    expect(state.errors.agent?.code).toBe("network");
  });

  it("does not reopen a closed surface when a request completes", () => {
    let state = fridayReducer(initialFridayState, {
      type: "MESSAGE_SUBMITTED",
      requestId: 5,
    });

    state = fridayReducer(state, { type: "CLOSE" });
    state = fridayReducer(state, {
      type: "RESPONSE_COMPLETED",
      requestId: 5,
    });

    expect(state.surface).toBe("closed");
    expect(state.agent).toBe("completed");
  });

  it("clears an agent error when a new request starts", () => {
    let state = fridayReducer(initialFridayState, {
      type: "MESSAGE_SUBMITTED",
      requestId: 8,
    });

    state = fridayReducer(state, {
      type: "REQUEST_FAILED",
      requestId: 8,
      code: "timeout",
      message: "Timed out",
    });

    state = fridayReducer(state, {
      type: "MESSAGE_SUBMITTED",
      requestId: 9,
    });

    expect(state.agent).toBe("thinking");
    expect(state.errors.agent).toBeUndefined();
  });
});
