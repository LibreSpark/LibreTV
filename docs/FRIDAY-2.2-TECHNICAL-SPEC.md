# LibreTV Friday 2.2 — Technical Specification

> Status: Architecture baseline  
> Target: LibreTV web application (Next.js App Router, React 19, TypeScript)  
> Implementation branch: `feature/friday-2.2-architecture`  
> Rule: preserve current movie search, UI data stream, and player bridge contracts unless a migration is explicitly tested.

## 1. Product and platform boundary

Friday is an in-page web assistant, not an iOS system assistant. It may borrow the interaction language of Siri/Dynamic Island, but must use browser capabilities only.

| Native concept | Friday implementation |
|---|---|
| SwiftUI | React + TypeScript |
| Core Animation | CSS transitions/keyframes; optional Framer Motion only if approved and installed |
| Metal shader | CSS gradients first; Canvas/WebGL only for a separately measured visual requirement |
| ActivityKit / Dynamic Island | React Portal + fixed floating container + CSS morphing states |
| App Intents / SiriKit | typed Agent tools with server-side validation |
| MapKit | optional map provider behind a typed component contract |
| Native widgets | allow-listed React result components |

Non-goals: iOS system overlay, Dynamic Island integration, ActivityKit, App Intents, arbitrary HTML rendering from model output, and automatic browser permission bypass.

## 2. Current implementation baseline

- UI entry: `src/components/AIFloatingBall.tsx` (currently a large client component).
- API: `src/app/api/chat/route.ts` (AI SDK stream; currently exposes `search_movie`).
- Chat transport: `@ai-sdk/react` + `DefaultChatTransport`.
- Existing movie results: `data-movies` UI data parts, rendered as movie cards.
- Existing agent loop: `stepCountIs(6)`; keep bounded multi-step execution.
- Existing player integration: retain current window/event bridge and movie-open behavior; do not replace it as part of the state-machine extraction.
- Existing speech: browser SpeechRecognition / webkitSpeechRecognition and speechSynthesis, with browser-dependent availability.

## 3. Target component and module architecture

```text
FridayRoot (AIFloatingBall compatibility entry)
├── FridayPortal
│   ├── FridayBackdrop
│   ├── FridayFloatingContainer
│   │   ├── FridayMorphingSurface
│   │   │   ├── FluidOrb
│   │   │   ├── ExecutionCapsule
│   │   │   └── ResultSurface
│   │   ├── VoiceStatus
│   │   ├── ConversationRenderer
│   │   │   ├── TextMessage
│   │   │   ├── MovieResults
│   │   │   ├── MapResult (future, only with validated schema/provider)
│   │   │   ├── POIResult (future)
│   │   │   └── ActionResult (future, allow-listed actions)
│   │   └── ContextualActions
│   └── FloatingLauncher
└── FridayEngine
    ├── FridayState (reducer + typed events)
    ├── VoiceEngine (browser adapter)
    ├── AgentTransport (AI SDK adapter)
    ├── ResultRegistry (allow-listed renderers + validators)
    └── LibreTVBridge (existing player/store integration)
```

### Proposed file boundaries

| File | Responsibility |
|---|---|
| `src/lib/friday/types.ts` | shared state, event, capability and result types |
| `src/lib/friday/state.ts` | pure reducer, transition guards, initial state |
| `src/lib/friday/state.test.ts` | transition and invalid-event tests |
| `src/lib/friday/voice.ts` | SpeechRecognition feature detection and typed browser adapter |
| `src/lib/friday/voice.test.ts` | pure capability/error mapping tests; browser APIs mocked only where available |
| `src/lib/friday/results.ts` | safe parsing/validation of structured result parts |
| `src/components/friday/FridayMorphingSurface.tsx` | state-driven visual surface |
| `src/components/friday/VoiceStatus.tsx` | microphone/listening/error/visualizer presentation |
| `src/components/friday/ConversationRenderer.tsx` | allow-listed result rendering |
| `src/components/AIFloatingBall.tsx` | compatibility composition; keep existing public props and player callbacks |

Implementation may adjust file names after inspecting imports, but responsibilities and contracts remain stable.

## 4. Unified state model

Do not collapse independent concerns into one `isLoading` or `isListening` flag. Keep three orthogonal state dimensions:

```ts
type VoiceState =
  | "idle" | "requesting" | "listening" | "recognizing"
  | "speaking" | "recovering" | "unsupported" | "error";

type AgentState =
  | "idle" | "thinking" | "executing" | "rendering" | "completed" | "error";

type SurfaceState =
  | "closed" | "launcher" | "compact" | "expanded" | "result";

type FridayState = {
  voice: VoiceState;
  agent: AgentState;
  surface: SurfaceState;
  voiceSessionId: number;
  requestId: number;
  error: { source: "voice" | "agent" | "bridge"; code: string; message: string } | null;
};
```

### Events

- Surface: `OPEN`, `CLOSE`, `EXPAND`, `COLLAPSE`, `SHOW_RESULT`.
- Voice: `VOICE_START_REQUESTED`, `VOICE_STARTED`, `VOICE_FINAL_TEXT`, `VOICE_ENDED`, `VOICE_SPEAK_START`, `VOICE_SPEAK_END`, `VOICE_FAILED`, `VOICE_RECOVERED`, `VOICE_STOP`.
- Agent: `MESSAGE_SUBMITTED`, `TOOL_STARTED`, `TOOL_FINISHED`, `RESPONSE_RENDERING`, `RESPONSE_COMPLETED`, `REQUEST_FAILED`, `REQUEST_CANCELLED`.
- Bridge: `BRIDGE_FAILED`, `BRIDGE_RECOVERED`.

### Transition rules

1. `idle → listening` only after a direct user gesture starts recognition successfully.
2. `listening → recognizing → thinking` when a final transcript is accepted and submitted.
3. `thinking ↔ executing` may repeat; tool calls are not assumed to be one-shot.
4. `thinking/executing → rendering → completed` only after the stream finishes and validated result parts are available.
5. Voice and Agent are independent: a user may stop voice without cancelling an in-flight agent request, unless the explicit cancel action requests both.
6. A stale callback must be ignored unless its session/request ID matches the current state.
7. `CLOSE` must stop active speech/recognition and cancel resume scheduling; request cancellation follows the existing explicit stop semantics.
8. Errors are scoped. A microphone error must not overwrite an agent error, and vice versa.
9. Automatic voice resume is opt-in per voice session, delayed, and cancelled on close, manual stop, permission error, unsupported browser, or a newer session.
10. Every transition is deterministic and unit-testable without a DOM.

## 5. Voice Engine contract

### Responsibilities

- Detect `SpeechRecognition` / `webkitSpeechRecognition` support.
- Start recognition synchronously from the initiating click/tap handler to satisfy browser user-gesture requirements.
- Normalize transcript, end, abort and error events.
- Track a monotonically increasing session ID; ignore stale events.
- Provide explicit `start`, `stop`, `abort`, `speak`, `cancelSpeech`, and `dispose` operations.
- Expose capability and error codes to UI; never claim microphone access is active before `onstart`.
- Keep TTS separate from recognition and avoid concurrent speech/recognition unless deliberately supported.
- Offer keyboard input whenever recognition is unsupported or denied.

### Browser constraints

- HTTPS (or localhost) is required for relevant microphone/browser speech features.
- Web Speech API support and behavior vary by browser and iOS version; iOS Safari must be tested on real devices.
- A webpage cannot silently grant microphone permission or guarantee continuous background listening.
- Permission denial, no microphone, no speech, network errors and unsupported API must have distinct UI messages.

### Acceptance

- First tap invokes `recognition.start()` in the same synchronous user-gesture call chain.
- UI changes to listening only on `onstart`.
- Repeated taps cannot create overlapping recognition instances.
- Stop/close invalidates pending callbacks and timers.
- Permission/network/device errors do not enter an automatic restart loop.
- Text entry remains fully usable if speech recognition is unavailable.

## 6. Agent Engine and server contract

- Keep AI SDK streaming and the current `search_movie` tool behavior intact.
- Preserve the existing bounded tool loop (`stepCountIs(6)`) and add tools only with strict Zod input/output schemas.
- Tool use is intent-gated: ordinary chat must not invoke tools; movie lookup invokes `search_movie`; player actions require an explicit supported intent.
- Tool execution status is emitted as typed data events, not inferred from arbitrary assistant prose.
- The model never supplies executable HTML, JavaScript, CSS, arbitrary URLs for privileged actions, or raw player commands.
- Every tool validates on the server and enforces request abort, input size, source limits and per-tool constraints.
- Tool errors are structured and user-safe; secrets and internal stack traces are never returned.

### Initial tool registry

| Tool | Status | Guard |
|---|---|---|
| `search_movie` | existing | explicit media search intent; current source validation |
| `control_player` | planned | enum action + bounded numeric arguments; only existing player bridge actions |
| `fetch_sources` | planned | explicit source-discovery request; validate and cap all returned source entries |
| `update_api_config` | deferred | requires user confirmation before mutating configuration |

Do not add map/navigation tools in 2.2 unless a real map provider, data contract, privacy review and UX are specified.

## 7. Structured Component Renderer

- Renderer accepts only known part types and validated payloads.
- Existing `data-movies` schema and card behavior are backward-compatible.
- Unknown or malformed data parts are ignored safely and may show a generic fallback.
- Never use `dangerouslySetInnerHTML` for model output.
- Actions are mapped through a local allow-list and typed callbacks; no model-generated function names or arbitrary event handlers.
- Add new result types only with schema, validator, renderer, error fallback and tests delivered together.

Initial result registry:
- `text`: ordinary assistant text.
- `data-movies`: current movie result payload.
- `data-agent-status`: planned, typed execution status.
- `data-action`: planned, allow-listed user-confirmable action.

## 8. LibreTV Bridge contract

- Preserve the current player-open protocol, event names, global callbacks, movie payload shape and delayed close behavior until each has characterization tests.
- Wrap existing integration behind a small adapter; do not rename/remove public globals in the first migration.
- Bridge calls must be idempotent where possible and return explicit success/failure.
- Opening a movie must not leave the Friday overlay blocking player controls.
- Bridge failure must not corrupt chat/voice state.

## 9. Visual system

- Surface morphs from launcher → compact listening/thinking capsule → expanded conversation → result presentation.
- CSS transitions are the baseline; respect `prefers-reduced-motion`.
- Keep text contrast and touch targets accessible; maintain keyboard focus and Escape close behavior.
- Floating container must not intercept player controls outside its actual hit area.
- Do not claim a system-level overlay or Dynamic Island integration.
- WebGL/Canvas is not part of the first milestone; use current CSS orb and refine it without adding a rendering dependency.

## 10. Delivery milestones

| Milestone | Scope | Required exit criteria |
|---|---|---|
| 2.2.1 | State machine extraction | reducer tests cover normal, repeated-tool, cancel, stale callback and error paths; no UI behavior regression |
| 2.2.2 | Ambient/morphing surface | all surface states render; reduced-motion path; overlay does not block player |
| 2.2.3 | Voice Engine extraction | first-tap start, explicit unsupported/error states, no duplicate sessions; real iOS Safari test checklist |
| 2.2.4 | Agent status and multi-tool flow | repeated tool cycles visible; bounded execution; ordinary chat has zero tool calls |
| 2.2.5 | Structured result renderer | movie cards unchanged; malformed/unknown parts safe; renderer registry tests |
| 2.2.6 | LibreTV Bridge adapter | movie open, player control, close timing and legacy event compatibility tests |

## 11. Test and release gates

For every milestone:
1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run build`
5. Verify no secrets or user-provided content are interpreted as instructions.
6. Verify mobile Safari and desktop Chromium manually for browser-specific voice/overlay behavior.

No production deployment is part of this architecture branch. Each milestone is delivered in a dedicated commit/PR and must pass checks before the next milestone is merged.

## 12. First implementation slice

Start with 2.2.1 only:
- Add pure state/event types and reducer.
- Add comprehensive reducer unit tests.
- Integrate the reducer in the existing component in a compatibility-first manner.
- Do not yet rewrite recognition, TTS, movie search, player bridge, API tools or visual CSS.
- Compare current behavior before/after and retain existing public component props and bridge contracts.
