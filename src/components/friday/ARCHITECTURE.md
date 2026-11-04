# Friday component boundaries

This document records the implemented extraction boundaries for the Friday-first homepage. It describes ownership and protected runtime contracts.

## Current composition

- `AIFloatingBall` is the single mounted orchestrator. It wires the Friday reducer, panel lifecycle, app-store source selection, and the existing `toggle-friday-panel` / `friday-open-detail` event contracts.
- `FridayOrbVisual` is a pure visual component. It renders orb layers only and owns no microphone, speech-recognition, chat, or search state.
- `FridayStyles` contains the floating assistant's global stylesheet. Every selector is scoped beneath `.friday-root`; the restore control is also rendered inside that root.
- `useFridayVoiceController` owns browser speech-recognition and speech-synthesis lifecycles, voice-session refs/timers, permission and recognition errors, and callbacks/state returned to the orchestrator.
- `useFridayChatSession` owns the AI SDK transport and `useChat` session. It preserves the `/api/chat` endpoint and the current source/filter request body.
- `useFridaySources` owns source and adult-filter configuration resolution. It does not own search requests or movie-detail navigation.
- `useFridayRequestLifecycle` maps chat busy/error transitions to request IDs and reducer events, including completion, failure, and cancellation.
- `useFridayResponseController` handles completed assistant responses, speech handoff, request-error feedback, and the short-lived completion indicator.
- `useFridayFabController` owns floating-orb dragging, viewport clamping, click suppression after dragging, hide, and restore interactions.
- `useFridayMovieTransition` owns the pending movie payload, close animation, fallback timer, duplicate-trigger guard, and `friday-open-detail` dispatch.
- `useFridayPanelEvents` owns Escape handling and the shared `toggle-friday-panel` custom-event listener.
- `FridayPanel` owns panel presentation and composes `FridayConversation` and `FridayComposer`. It receives explicit state and callbacks; it does not call `useChat`, access the app store, or construct speech-recognition objects.
- `src/lib/friday/message.ts` contains pure message text and movie-result parsing. The panel re-exports these helpers for existing imports.
- `FridayHero` is the homepage's centered voice entry. It emits `toggle-friday-panel` with `listen: true`; the single mounted `AIFloatingBall` owns the actual microphone session.
- `HomeSearchSection` owns only traditional search-form presentation. URL state, search history, source selection, API requests, and result aggregation remain in `HomeContent`.

## Ownership boundaries

### Voice and chat

The voice controller must not own `useChat`, movie search, app-store source selection, detail navigation, or panel layout. Keep the real user-gesture requirement for the first microphone start and preserve the user-facing permission and fallback behavior.

The chat-session hook must not own speech recognition, speech synthesis, panel visibility, or movie-detail navigation. Keep the endpoint and request payload stable.

### Conversation panel

`FridayPanel` receives:
- open/closing/expanded and agent/voice display states
- messages, movie result data, loading/error state and input value
- callbacks for close, send, microphone toggle, interrupt, expand, hide, and movie selection

Movie selection is forwarded through `onOpenMovie`; the orchestrator continues to own the existing `friday-open-detail` event contract.

### Orchestrator

`AIFloatingBall` remains the single composition point for the hooks, reducer, panel, and existing event contracts. The header must mount exactly one instance, including when the floating launcher itself is hidden on the V2 homepage.

## Protected contracts

- `toggle-friday-panel` event name and `{ reset: false }` detail
- `friday-open-detail` event name and existing movie payload
- `/api/chat` transport and current source/filter payload
- search APIs, resource APIs, `?q=` / `?s=` URL behavior, detail modal, and player behavior
- microphone start remains inside the synchronous user-gesture call chain

The `HOME_V2` feature flag selects the Friday-first homepage shell while the legacy route remains the default when the flag is off. The V2 shell reuses the existing search form, recommendation APIs, detail modal, and result pipeline; its visual rules are scoped to `.home-v2`.
