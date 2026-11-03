import type { FridayEvent, FridayState } from "./types";

export const initialFridayState: FridayState = {
  voice: "idle",
  agent: "idle",
  surface: "closed",
  voiceSessionId: 0,
  requestId: 0,
  errors: {},
};

export function fridayReducer(
  state: FridayState,
  event: FridayEvent,
): FridayState {
  switch (event.type) {
    case "OPEN":
      return {
        ...state,
        surface: state.surface === "closed" ? "launcher" : state.surface,
      };

    case "CLOSE":
      return {
        ...state,
        surface: "closed",
        voice: "idle",
        errors: { ...state.errors, voice: undefined },
      };

    case "EXPAND":
      return state.surface === "closed"
        ? state
        : { ...state, surface: "expanded" };

    case "COLLAPSE":
      return state.surface === "closed"
        ? state
        : { ...state, surface: "compact" };

    case "SHOW_RESULT":
      return state.surface === "closed"
        ? state
        : { ...state, surface: "result" };

    case "VOICE_START_REQUESTED":
      return {
        ...state,
        voice: "requesting",
        voiceSessionId: event.sessionId,
        errors: { ...state.errors, voice: undefined },
      };

    case "VOICE_STARTED":
      return event.sessionId !== state.voiceSessionId ||
        state.voice !== "requesting"
        ? state
        : { ...state, voice: "listening" };

    case "VOICE_FINAL_TEXT":
      return event.sessionId !== state.voiceSessionId ||
        state.voice !== "listening"
        ? state
        : { ...state, voice: "recognizing" };

    case "VOICE_ENDED":
      return event.sessionId !== state.voiceSessionId
        ? state
        : { ...state, voice: "idle" };

    case "VOICE_SPEAK_START":
      return event.sessionId !== state.voiceSessionId
        ? state
        : { ...state, voice: "speaking" };

    case "VOICE_SPEAK_END":
      return event.sessionId !== state.voiceSessionId ||
        state.voice !== "speaking"
        ? state
        : { ...state, voice: "idle" };

    case "VOICE_FAILED":
      return event.sessionId !== state.voiceSessionId
        ? state
        : {
            ...state,
            voice: "error",
            errors: {
              ...state.errors,
              voice: { code: event.code, message: event.message },
            },
          };

    case "VOICE_RECOVERED":
      return event.sessionId !== state.voiceSessionId ||
        state.voice !== "recovering"
        ? state
        : {
            ...state,
            voice: "listening",
            errors: { ...state.errors, voice: undefined },
          };

    case "VOICE_STOP":
      return event.sessionId !== undefined &&
        event.sessionId !== state.voiceSessionId
        ? state
        : {
            ...state,
            voice: "idle",
            errors: { ...state.errors, voice: undefined },
          };

    case "MESSAGE_SUBMITTED":
      return {
        ...state,
        agent: "thinking",
        requestId: event.requestId,
        errors: { ...state.errors, agent: undefined },
      };

    case "TOOL_STARTED":
      return event.requestId !== state.requestId ||
        state.agent === "idle" ||
        state.agent === "completed" ||
        state.agent === "error"
        ? state
        : { ...state, agent: "executing" };

    case "TOOL_FINISHED":
      return event.requestId !== state.requestId ||
        state.agent !== "executing"
        ? state
        : { ...state, agent: "thinking" };

    case "RESPONSE_RENDERING":
      return event.requestId !== state.requestId ||
        state.agent === "idle" ||
        state.agent === "completed" ||
        state.agent === "error"
        ? state
        : { ...state, agent: "rendering" };

    case "RESPONSE_COMPLETED":
      return event.requestId !== state.requestId
        ? state
        : {
            ...state,
            agent: "completed",
            surface: state.surface === "closed" ? "closed" : "result",
          };

    case "REQUEST_FAILED":
      return event.requestId !== state.requestId
        ? state
        : {
            ...state,
            agent: "error",
            errors: {
              ...state.errors,
              agent: { code: event.code, message: event.message },
            },
          };

    case "REQUEST_CANCELLED":
      return event.requestId !== state.requestId
        ? state
        : {
            ...state,
            agent: "idle",
            errors: { ...state.errors, agent: undefined },
          };

    case "BRIDGE_FAILED":
      return {
        ...state,
        errors: {
          ...state.errors,
          bridge: { code: event.code, message: event.message },
        },
      };

    case "BRIDGE_RECOVERED":
      return {
        ...state,
        errors: { ...state.errors, bridge: undefined },
      };

    default:
      return state;
  }
}
