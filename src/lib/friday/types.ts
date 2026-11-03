export type VoiceState =
  | "idle"
  | "requesting"
  | "listening"
  | "recognizing"
  | "speaking"
  | "recovering"
  | "unsupported"
  | "error";

export type AgentState =
  | "idle"
  | "thinking"
  | "executing"
  | "rendering"
  | "completed"
  | "error";

export type SurfaceState =
  | "closed"
  | "launcher"
  | "compact"
  | "expanded"
  | "result";

export type FridayErrorSource = "voice" | "agent" | "bridge";

export type FridayError = {
  code: string;
  message: string;
};

export type FridayState = {
  voice: VoiceState;
  agent: AgentState;
  surface: SurfaceState;
  voiceSessionId: number;
  requestId: number;
  errors: Partial<Record<FridayErrorSource, FridayError>>;
};

export type FridayEvent =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "EXPAND" }
  | { type: "COLLAPSE" }
  | { type: "SHOW_RESULT" }
  | { type: "VOICE_START_REQUESTED"; sessionId: number }
  | { type: "VOICE_STARTED"; sessionId: number }
  | { type: "VOICE_FINAL_TEXT"; sessionId: number }
  | { type: "VOICE_ENDED"; sessionId: number }
  | { type: "VOICE_SPEAK_START"; sessionId: number }
  | { type: "VOICE_SPEAK_END"; sessionId: number }
  | { type: "VOICE_FAILED"; sessionId: number; code: string; message: string }
  | { type: "VOICE_RECOVERED"; sessionId: number }
  | { type: "VOICE_STOP"; sessionId?: number }
  | { type: "MESSAGE_SUBMITTED"; requestId: number }
  | { type: "TOOL_STARTED"; requestId: number }
  | { type: "TOOL_FINISHED"; requestId: number }
  | { type: "RESPONSE_RENDERING"; requestId: number }
  | { type: "RESPONSE_COMPLETED"; requestId: number }
  | { type: "REQUEST_FAILED"; requestId: number; code: string; message: string }
  | { type: "REQUEST_CANCELLED"; requestId: number }
  | { type: "BRIDGE_FAILED"; code: string; message: string }
  | { type: "BRIDGE_RECOVERED" };
