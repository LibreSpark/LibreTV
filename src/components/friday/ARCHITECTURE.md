# Friday component boundaries

This document records the safe extraction boundaries for the homepage refactor. It does not change runtime behavior.

## Current composition

- `AIFloatingBall` remains the single mounted orchestrator. It owns the Friday state machine, chat transport, app-store source selection, panel lifecycle, and the existing `toggle-friday-panel` / `friday-open-detail` event contracts.
- `FridayOrbVisual` is a pure visual component. It renders the orb layers only and owns no microphone, speech-recognition, chat, or search state.
- `useFridayVoiceController` now owns browser speech-recognition and speech-synthesis lifecycles, voice-session refs/timers, permission and recognition errors, and the callbacks/state returned to the orchestrator.
- `AIFloatingBall` remains the single orchestrator for chat transport, request state, app-store source selection, panel lifecycle, and movie-detail events. It passes the current busy/open/closing refs and message callback into the voice controller.
- `FridayPanel` owns the conversation panel's presentation markup, message rendering, movie-card rendering, and input/tool controls. It receives state and callbacks through explicit props; it does not call `useChat`, access the app store, or own voice lifecycle.
- `FridayHero` is the homepage's centered voice entry. It emits the shared `toggle-friday-panel` event with `listen: true`; `AIFloatingBall` remains the only owner of the actual microphone session.
- `HomeSearchSection` owns only the traditional search form presentation. URL state, search history data, source selection, API requests, and result aggregation remain in `HomeContent`.

## Next extraction boundaries

### Voice controller

Implemented: `useFridayVoiceController`

Owns only browser voice lifecycle:
- SpeechRecognition construction, start/stop/abort and event handlers
- speech synthesis start/cancel and utterance lifecycle
- voice-session refs, resume scheduling, permission and recognition error state
- callbacks/state returned to the orchestrator

It must not own `useChat`, movie search, app-store source selection, detail navigation, or panel layout. Keep the real user-gesture requirement for microphone start and preserve the current user-facing error/fallback behavior. The hook is wired into `AIFloatingBall`; it is not a dormant parallel implementation.

### Conversation panel

Implemented: `FridayPanel`

A presentation component receiving explicit props:
- open/closing/expanded and agent/voice display states
- messages, movie result data, loading/error state and input value
- callbacks for close, send, microphone toggle, interrupt, expand, hide, restore, and movie selection

It does not call `useChat`, access the app store, or construct speech-recognition objects. Movie selection is forwarded through `onOpenMovie`; the orchestrator continues to emit the existing `friday-open-detail` event.

### Orchestrator

`AIFloatingBall` remains responsible for wiring the voice controller, panel, chat transport, reducer, and existing event contracts. The header must mount exactly one instance.

## Protected contracts

- `toggle-friday-panel` event name and `{ reset: false }` detail
- `friday-open-detail` event name and existing movie payload
- `/api/chat` transport and current source/filter payload
- search APIs, resource APIs, `?q=` / `?s=` URL behavior, detail modal, and player behavior

The `HOME_V2` feature flag now selects a Friday-first homepage shell while the legacy route remains the default when the flag is off. The V2 shell reuses the existing search form, recommendation APIs, detail modal, and result pipeline; its visual rules are scoped to `.home-v2`.
