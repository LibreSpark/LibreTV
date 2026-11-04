# Friday component boundaries

This document records the safe extraction boundaries for the homepage refactor. It does not change runtime behavior.

## Current composition

- `AIFloatingBall` remains the single mounted orchestrator. It owns the Friday state machine, chat transport, app-store source selection, panel lifecycle, and the existing `toggle-friday-panel` / `friday-open-detail` event contracts.
- `FridayOrbVisual` is a pure visual component. It renders the orb layers only and owns no microphone, speech-recognition, chat, or search state.
- `useFridayVoiceController` now owns browser speech-recognition and speech-synthesis lifecycles, voice-session refs/timers, permission and recognition errors, and the callbacks/state returned to the orchestrator.
- `AIFloatingBall` remains the single orchestrator for chat transport, request state, app-store source selection, panel lifecycle, and movie-detail events. It passes the current busy/open/closing refs and message callback into the voice controller.
- The conversation panel markup and its scoped styles are still hosted by `AIFloatingBall`; panel extraction remains a separate follow-up after the new hook passes CI and behavior checks.

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

Target: `FridayPanel`

A presentation component receiving explicit props:
- open/closing/expanded and agent/voice display states
- messages, movie result data, loading/error state and input value
- callbacks for close, send, microphone toggle, interrupt, expand, hide, restore, and movie selection

It must not call `useChat`, access the app store, construct speech-recognition objects, or change search/detail URL contracts. Movie selection must continue to emit the existing `friday-open-detail` event through the orchestrator.

### Orchestrator

`AIFloatingBall` remains responsible for wiring the voice controller, panel, chat transport, reducer, and existing event contracts. The header must mount exactly one instance.

## Protected contracts

- `toggle-friday-panel` event name and `{ reset: false }` detail
- `friday-open-detail` event name and existing movie payload
- `/api/chat` transport and current source/filter payload
- search APIs, resource APIs, `?q=` / `?s=` URL behavior, detail modal, and player behavior

Any later extraction must be behavior-preserving and reviewed as a separate diff before the homepage visual work begins.
