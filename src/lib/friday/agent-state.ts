
export type FridayPhase =
  | "idle"
  | "listening"
  | "recognizing"
  | "thinking"
  | "executing"
  | "rendering"
  | "result"
  | "recovering"
  | "error";

export type FridayVoiceStatus =
  | "idle"
  | "requesting"
  | "listening"
  | "recognizing"
  | "speaking"
  | "recovering"
  | "error";

export type FridayTaskStatus =
  | "idle"
  | "thinking"
  | "executing"
  | "rendering"
  | "completed"
  | "error";

export type FridayVisualMode =
  | "hidden"
  | "orb"
  | "dots"
  | "capsule"
  | "card";

export type FridayResultKind =
  | "text"
  | "movie"
  | "map"
  | "poi"
  | "event"
  | "action"
  | "mixed"
  | null;

export interface FridayAgentState {
  phase: FridayPhase;
  voice: FridayVoiceStatus;
  task: FridayTaskStatus;
  visual: FridayVisualMode;

  sessionId: string | null;
  taskId: string | null;

  taskLabel: string;
  errorMessage: string | null;
  resultKind: FridayResultKind;

  revision: number;
}

export type FridayAgentEvent =
  | { type: "SESSION_START"; sessionId: string }
  | { type: "MIC_REQUEST"; sessionId: string }
  | { type: "MIC_LISTENING"; sessionId: string }
  | { type: "VOICE_RECOGNIZING"; sessionId: string }
  | { type: "VOICE_SPEAKING"; sessionId: string }
  | { type: "VOICE_RECOVERING"; sessionId: string; message?: string }
  | { type: "VOICE_ERROR"; sessionId: string; message: string }
  | { type: "REQUEST_START"; sessionId: string; taskId: string; label?: string }
  | { type: "TOOL_START"; sessionId: string; taskId: string; label: string }
  | { type: "TOOL_FINISH"; sessionId: string; taskId: string; nextLabel?: string }
  | { type: "RESULT_START"; sessionId: string; taskId: string }
  | { type: "RESULT_READY"; sessionId: string; taskId: string; kind: Exclude<FridayResultKind, null> }
  | { type: "REQUEST_ERROR"; sessionId: string; taskId: string; message: string }
  | { type: "CONTINUE"; sessionId: string }
  | { type: "CANCEL"; sessionId?: string }
  | { type: "CLOSE" };

const INITIAL_STATE: FridayAgentState = {
  phase: "idle",
  voice: "idle",
  task: "idle",
  visual: "hidden",

  sessionId: null,
  taskId: null,

  taskLabel: "",
  errorMessage: null,
  resultKind: null,

  revision: 0,
};

function visualFor(phase: FridayPhase): FridayVisualMode {
  switch (phase) {
    case "listening":
      return "orb";

    case "recognizing":
    case "thinking":
    case "recovering":
      return "dots";

    case "executing":
      return "capsule";

    case "rendering":
    case "result":
    case "error":
      return "card";

    case "idle":
    default:
      return "hidden";
  }
}

function withPhase(
  state: FridayAgentState,
  patch: Partial<FridayAgentState>,
  phase: FridayPhase,
): FridayAgentState {
  return {
    ...state,
    ...patch,
    phase,
    visual: visualFor(phase),
    revision: state.revision + 1,
  };
}

export function reduceFridayState(
  state: FridayAgentState,
  event: FridayAgentEvent,
): FridayAgentState {
  // 新会话开始、关闭和取消属于会话边界事件。
  // 其他旧会话事件一律忽略，防止过期回调污染新会话。
  if (
    "sessionId" in event &&
    event.type !== "SESSION_START" &&
    state.sessionId !== event.sessionId
  ) {
    return state;
  }

  switch (event.type) {
    case "SESSION_START":
      return withPhase(
        state,
        {
          voice: "idle",
          task: "idle",
          sessionId: event.sessionId,
          taskId: null,
          taskLabel: "",
          errorMessage: null,
          resultKind: null,
        },
        "idle",
      );

    case "MIC_REQUEST":
      return withPhase(
        state,
        {
          voice: "requesting",
          task: "idle",
          errorMessage: null,
        },
        "recovering",
      );

    case "MIC_LISTENING":
      return withPhase(
        state,
        {
          voice: "listening",
          task: "idle",
          errorMessage: null,
        },
        "listening",
      );

    case "VOICE_RECOGNIZING":
      return withPhase(
        state,
        {
          voice: "recognizing",
          task: "thinking",
        },
        "recognizing",
      );

    case "VOICE_SPEAKING":
      return withPhase(
        state,
        {
          voice: "speaking",
        },
        state.phase === "idle" ? "result" : state.phase,
      );

    case "VOICE_RECOVERING":
      return withPhase(
        state,
        {
          voice: "recovering",
          errorMessage: event.message ?? null,
        },
        "recovering",
      );

    case "VOICE_ERROR":
      return withPhase(
        state,
        {
          voice: "error",
          errorMessage: event.message,
        },
        "error",
      );

    case "REQUEST_START":
      return withPhase(
        state,
        {
          voice: "idle",
          task: "thinking",
          taskId: event.taskId,
          taskLabel: event.label ?? "正在理解你的请求",
          errorMessage: null,
          resultKind: null,
        },
        "thinking",
      );

    case "TOOL_START":
      if (state.taskId !== event.taskId) return state;

      return withPhase(
        state,
        {
          task: "executing",
          taskLabel: event.label,
          errorMessage: null,
        },
        "executing",
      );

    case "TOOL_FINISH":
      if (state.taskId !== event.taskId) return state;

      return withPhase(
        state,
        {
          task: "thinking",
          taskLabel: event.nextLabel ?? "正在整理结果",
        },
        "thinking",
      );

    case "RESULT_START":
      if (state.taskId !== event.taskId) return state;

      return withPhase(
        state,
        {
          task: "rendering",
          taskLabel: "正在呈现结果",
        },
        "rendering",
      );

    case "RESULT_READY":
      if (state.taskId !== event.taskId) return state;

      return withPhase(
        state,
        {
          task: "completed",
          taskLabel: "",
          resultKind: event.kind,
          errorMessage: null,
        },
        "result",
      );

    case "REQUEST_ERROR":
      if (state.taskId !== event.taskId) return state;

      return withPhase(
        state,
        {
          task: "error",
          errorMessage: event.message,
          taskLabel: "任务执行失败",
        },
        "error",
      );

    case "CONTINUE":
      return withPhase(
        state,
        {
          voice: "idle",
          task: "idle",
          taskId: null,
          taskLabel: "",
          errorMessage: null,
          resultKind: null,
        },
        "idle",
      );

    case "CANCEL":
      if (
        event.sessionId &&
        state.sessionId !== event.sessionId
      ) {
        return state;
      }

      return {
        ...INITIAL_STATE,
        revision: state.revision + 1,
      };

    case "CLOSE":
      return {
        ...INITIAL_STATE,
        revision: state.revision + 1,
      };

    default:
      return state;
  }
}

export function createFridayStateStore() {
  let state = INITIAL_STATE;
  const listeners = new Set<() => void>();

  return {
    getState(): FridayAgentState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispatch(event: FridayAgentEvent): FridayAgentState {
      const next = reduceFridayState(state, event);

      if (next !== state) {
        state = next;
        listeners.forEach(listener => listener());
      }

      return state;
    },

    reset(): void {
      state = {
        ...INITIAL_STATE,
        revision: state.revision + 1,
      };
      listeners.forEach(listener => listener());
    },
  };
}

// 浏览器端共享状态仓库。
// React 组件和语音/Agent 管理器应共用这一实例。
export const fridayStateStore = createFridayStateStore();
