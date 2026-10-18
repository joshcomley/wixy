# 00001 [vpc48a] Live voice calls through hub

## What / Why

Add two-person live audio calling to the unlocked Server panel, coordinated through hub and the operator's internet connection.

## Context + current state

First implementation audit is complete and blocks delivery: C0/H1/M4/L0 at
`4829f606fcfbf53f05f1dc955bce35abb4ce3695`; report
`spec/server-chat/voice-call-implementation-audit.md`. Reopen relay/browser repair work.
Five demonstrated defects: real worker lifetime under cancellation, capture freshness
relabelling, reentrant overflow, crossed-invite UI ownership and unbounded worklet
lease controls. Use Group Therapy independent proposals -> all-proposal merge ->
parent ruling/local repairs -> fresh audit. Round brief:
`spec/server-chat/voice-repair-round1-brief.md`. No launch approval; no third-party
audio disclosure found by that audit. Add live third-browser negative control.

Operator device answer banked in decision 1867: Android Chrome; another participant
uses iPhone with browser not yet confirmed; iPad and spare Android available. No
participant names in repo artifacts. Call audio is pair-only; ordinary messages can
appear on other unlocked chat views. Privacy answer recorded separately in Answers.

Implementation is now locally proven (not delivered). Frozen brief is
`spec/server-chat/04-voice-calls.md`. New modules: Python call protocol/broker/socket route,
shared token validator, bounded Uvicorn options; TS controller/audio/worklet/protocol,
thread mic arbitration and lifecycle integration. Committed generated bundles required.

Evidence before audit: all 2,570 frontend tests passed (then a new decline test plus
focused rerun: 73 passed); 78 token/Access/call tests passed with four workers; 121
device-grant/Access integration regressions passed; 22 call tests include real Uvicorn
fragmented oversize rejection. Real two-context Playwright synthetic duplex passed,
including rendered sound, 450 ms main-thread stall, fresh call consent, muted idle pause,
panic track teardown and fresh remote idle countdown. Python lint/format and full mypy
(243 source files), TS strict and asset rebuild passed. Updated an old chat-view mock for
the new thread seam and existing game-test type narrowing/imports to restore full mypy.

Known unresolved acceptance: physical devices, actual HTTPS/Access/tunnel path, 15-minute
duplex/speakerphone, latency/loss and actual Slots drain. Do not claim production quality.
Operator decision 1867 asks phone/browser and second-device availability; it is delayed,
and independent review continues. Parent owns staging/live proof and final delivery.

Architecture investigation underway. No implementation or delivery record yet. Existing transport is authenticated HTTP/SSE through Cloudflare Tunnel. Browser unlock tokens live only in memory and travel in a custom request header. Calls must stop audio capture/playback on actual chat lock, detach and disposal. Existing device settings can change hidden-tab locking; preserve that policy. No call audio recording or transcription.

Review dispatched to native specialist `/root/voice_architecture`, GPT-6 Astra high, after Claude relations reviewer failed its weekly allowance gate. Expected output: `spec/server-chat/voice-call-architecture-review.md`; next action on return: parent freezes modular brief and creates delivery record. Parent owns follow-up on the specialist's completion event (one bounded design pass). The relation `371cc3b4-4bdd-4f1d-af8b-aab99e1611a2` is NOT an accepted ruling: its oracle synthesis cites unrelated device-grants and robots-header audit briefs. Do not use it as architecture approval. Operator question recorded as Answers entry 2951.

## Relevant files + commits

Operator clarification (2026-10-18): "Locking the chat will stop it, but the automatic lock countdown should pause when on a voice chat, just like when recording a voice note." Binding acceptance: a connected call, including muted, suspends the automatic idle countdown using the existing suspension mechanism. Call end releases the suspension and starts a fresh full idle period. Actual lock still immediately stops microphone capture and playback. Sent to architecture reviewer before ruling.

`admin-ui/src/server/{chatView,panel,types}.ts`, `wixy_server/livechat/tokens.py`, `wixy_server/routes_livechat.py`, `docs/ai/livechat.md`, `spec/server-chat/00-brief.md`.

## How to continue + acceptance

Recovery after operator status request: native specialist was no longer listed and left no report; no implementation had begun. Replaced with persistent cmd run `13d7720e2a1e4ff481f8ae3d091baa9a`, reviewer session `e174171d-e4c4-4e0c-9923-428b591aecdd` (Codex GPT-6 Astra high, 900-second bound). Lane watchdog `e60d3e8b-a7e0-4cd4-8c00-7b6be0453dec` has 600-second tolerance; parent follow-up wake `sw_00346888a6c5413ca2851e1b34cfa728` due epoch 1792315620. Parent remains the named owner: consume report on arrival, freeze brief/create delivery tasks, implement and carry through merge. If report absent at follow-up, diagnose/recover reviewer immediately. Status answer logged as Answers 2952. Do not mistake submitted/running wrapper for completed review.

Owner: workspace full-stack developer. Next: obtain the architecture ruling, freeze the modular brief, create guarded delivery record/tasks and build with a fast local test loop. Review the final candidate, deliver through the workspace merge endpoint, and record confirmed merge SHA. Calls require explicit answer, mute and hang-up; reject a third participant; no stale audio after disconnect or lock. Validate real audio between browser contexts and teardown races, plus appropriate authentication and isolation tests. Assess latency/bandwidth and disclose browser background limits.

## Links

Workspace 48; session `584ebce2-4cdf-4fa7-9125-fa0f2f631216`; feature branch `cmd/workspace-00048`.
