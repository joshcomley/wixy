# 00001 [vpc48a] Live voice calls through hub

## Completed delivery

Published via https://github.com/joshcomley/wixy/pull/328, confirmed merge
`22571a22efe72ebb975702b0539c8a5e41bade0c`. Final candidate `6df9f8a` passed
all release checks (including the full browser rerun after an unrelated photo
alignment timeout, also passed twice locally). Production origin and public
`/api/version` return the exact merge; blue slot, internal `/healthz`200.
The operator reported the phone call works, requested the final phone icon right
of⋯, no drop-down and separate Call confirmation, then authorized publication.
All four delivery tasks are done; cmd's delivery record recovered the externally
confirmed PR merge and marks this delivery complete.

The required independent capability and permission-delta audits passed; final UI
and consent changes were locally proven with2617 frontend tests, strict types,
LF bundles, actual Chromium confirmation/duplex/privacy/stall/mute/panic flow and
cached-page recovery. Formal15-minute speakerphone, latency/jitter/loss, all mobile
platforms and blocked-native-worker measurements are not claimed; see
`spec/server-chat/voice-delivery-validation.md`. Historical progress below is
retained for provenance. The source-only probe inherited untracked at handover
is preserved at `.scratch/inherited-voice_preview_probe.py`.

## What / Why

Add two-person live audio calling to the unlocked Server panel, coordinated through hub and the operator's internet connection.

## Context + current state

LATEST: operator reports actual phone call works, requests compact phone/hang-up
icons next to⋯, and says "Once that's done, please publish it!" UI source+LF
bundles updated; strictTS/37 affected tests pass, idle320/360/390/768 and incoming
visual checks fit themed header. Final actual synthetic duplex run submitted,
then PR/checks/merge. No new runtime transport/auth/lifecycle change. Preview's
runtime moved from Playwright's cleared test-results into registered workspace
.scratch/voice-preview-runtime; retained SQLite moved intact, configuration and
fixture reconstructed. Launcher refuses test-results placement. No production
storage touched. Formal sustained/performance/blocked-worker evidence not supplied.

LATEST OVERRIDE: private preview deployed directly under Devfleet WixyCallPreview,
immutable177e0a9 source, real Access/PIN, separate data. Public URL is
https://wixy-call-test.cinnamons.uk/admin/server . Local health200/API401 and
public Access login200 verified. Grid plan withdrawn (decision1869 obsolete),
hub worker unchanged, no2hour cutoff. Physical login/audio and remaining gates
still need observed results. See voice-preview-acceptance.md current deployment.

LATEST: preview preparation and measured local origin preflight recorded in
spec/server-chat/voice-preview-acceptance.md. Full-host operator-only Access app
exists; fresh local fixture/storage, port9488, real auth/PIN verifier. Persistent
origin not started: hub Grid worker explicitly stopped (user_requested_stop=true).
Decision1869 asks whether it may restart; pending task t-1d5830f7a029 cancelled
without starting. No DNS/ingress changes. Physical/performance/Slots gates open.

Continuation verified HEAD a2030d5410042b60ebfb0b4c0543c1ef9e1edd7f.
Focused independent Astra audit complete: PASS C0/H0/M0/L0 for the exact
cached-permission lifecycle delta, report voice-permission-implementation-audit.md.
Reviewer independently ran 293 affected tests and strict TypeScript; checked
actual owner composition, LF and embedded source-map consistency. This is code
evidence only. Preview commissioning, physical Android/iPad/iPhone, real Access
and tunnel across networks, sustained duplex/performance and actual Slots
shutdown remain open. No PR or delivery merge. No Job Master for wixy.
Earlier CURRENT paragraphs below are historical.

CURRENT FINAL REPAIR: BOTH permission MERGE reports complete/read; mechanisms
converge. Parent implemented immediate release/pagehide/before-visible cached
policy completion with tri-state exemption outcome and original hide timestamp,
using existing restore marker. Read voice-permission-ruling.md.284 affected
tests+strict TS+LF build pass; full1724 chat frontend tests pass before final
one-line defensive helper invocation, affected284+types pass again after it.
Real Chromium cache/draft/presence-only recovery passes before final invocation.
Parent next freezes exact corrected head and dispatches NEW focused senior audit
per voice-permission-audit-packet.md. Backend/media unchanged from b2c01b6;
reuse still-applicable62-test/duplex proof. No PR/merge or physical acceptance.
Parent owns exact-head review, live gates and confirmed final delivery merge SHA.
All older paragraphs below are history, including the previous proposal waits.

CURRENT OVERRIDE: round3 audit completed PASS C0/H0/M0/L0 at b2c01b6, but did
NOT execute the late micPermission/order concern. Parent then reproduced it
with REAL panel + REAL call controller and pending prepare: panel-first2fails,
controller-first2passes, each with/without a later hidden notification. Audio
stops once; default hidden-lock policy is skipped only in panel-first order.
No clean delivery clearance yet. Browser repair reopened. One-issue bounded
Group Therapy PROPOSE sent Astra finder bf81fcb6 (routes successor fdd6f26b)
and Gemini c2ee5b92; brief `voice-lifecycle-permission-repair-brief.md`.
Outputs parent voice-permission-proposal-astra.md and sibling workspace50
voice-permission-proposal-gemini.md. Parent sends BOTH to EACH for narrow MERGE,
then implements/proves with four-cell discriminator and affected regressions.
No broad redesign; source runtime still b2c01b6, new test only so far. Parent
retains physical/tunnel/quality/Slots gates and confirmed merge-SHA ownership.

Permission proposals BOTH read; narrow MERGE dispatched to EACH with BOTH paths
in `voice-permission-merge-brief.md`, equal-standing and provenance requirements.
Astra proposes tri-state/before-restore recheck preserving original hide timestamp;
Gemini measures282 affected tests green with immediate suspension-release recheck
and additional pending flag. Resolve timing, reentrant teardown and original
causal evidence; parent then IMPLEMENTS. Outputs parent voice-permission-merge-astra.md
and siblingworkspace50 voice-permission-merge-gemini.md. Deadline3min, follow-up
sw_4d47f8eded8645328dd9e9d05f036e68; no broad review. Parent added4 green genuine
exemption controls, keeping the4-cell bug discriminator2red/2green before repair.

CURRENT: round2 all-proposal convergence implemented and parent-locally proven.
Read `spec/server-chat/voice-repair-round2-ruling.md`. Selected shared cached
pair gate/immediate removal, unconditional caller terminal correlation, panel-owned
cache recovery, immediate constructor-failure decline, microphone-aware affordance
with usable reconnect/final render, source-level duplicate-presence suppression.
Parent additionally reproduced/fixed missing-hidden-event lock-policy bypass on
persisted pagehide using idempotent existing onHidden handling.62 server call
tests,1,714 frontend chat tests, full strict types/lint/format and LF build pass.
Real Grid scoped browser job t-0e00986d0993 DONE exit0:2 tests pass30.9s, duplex/
stall/muted-idle/panic/third-browser isolation and real-view draft-preserving
presence-only cache recovery. Generic hub Grid submissions were cancelled while
queued; supported requirements.task_class=ci-scoped ran immediately.
Parent next freezes this locally proven candidate and dispatches a NEW independent
senior audit against `voice-repair-round3-audit-packet.md`; no audited edits while
open. Physical/tunnel/quality/Slots gates remain open; no PR or merge exists.
Parent retains delivery through confirmed merge SHA. All older paragraphs are history.

LATEST ROUND 2: fresh independent audit at 4983cc6 returned CHANGES REQUIRED,
C0/H0/M3/L2. Report: `spec/server-chat/voice-call-implementation-audit-round2.md`.
Reopen relay/browser tasks. Five repairs: request-correlated early terminal,
both-member/lifetime media gates, owner-validated cached-page presence restore,
Answer construction failure terminal notification, recorder-busy Call state.
Parent owns Group Therapy round 2, local implementation and fresh verification;
brief: `spec/server-chat/voice-repair-round2-brief.md`. Selected available families
Astra + Gemini (Claude quota-walled). Independent proposals first, then every
proposal to every reviewer, parent adjudication. No PR, merge or live acceptance.
Angel quota incident acknowledged; parent owns monitoring with recovery wake.
Gemini round-1 late proposal/stop acknowledged; not counted as third MERGE vote.
Older status below is historical, including the previous pending-audit claim.

Round2 PROPOSE: Astra artifact complete/read at
`spec/server-chat/voice-repair-round2-proposal-astra.md`, exact four-file patch,
in-memory red/greens all five; strict types/real integration explicitly unexecuted.
Gemini artifact absent at first check, but native step183 versus translated135
and recent source-store activity establish ongoing work, not failure. Parent
next: read its actual proposal, then send BOTH complete artifacts to EACH seat
for equal-standing MERGE. Existing parent wake sw_c0739fa218914279b82398c823bc7d66
and per-seat watchdogs own follow-up. No implementation edits yet.

Round2 MERGE dispatched: BOTH complete proposal artifacts read; Gemini artifact
exists in workspace50 at `spec/server-chat/voice-repair-round2-proposal-gemini.md`.
Both reviewers received `spec/server-chat/voice-repair-round2-merge-brief.md`
with both paths and equal-standing/provenance requirements. Await parent Astra
`voice-repair-round2-merge-astra.md` and sibling Gemini
`voice-repair-round2-merge-gemini.md`. Main split is panel-owned cached-page
recovery versus autonomous controller recovery. Also resolve unconditional
request correlation, shared media gate/expired endpoint cleanup, and disconnected
recorder/reconnect affordance. Parent next reads both, rules mechanisms, builds
locally and verifies; no implementation changed during this design comparison.

Round2 local RED baseline added while comparison runs: 14 focused backend cases
fail (early-terminal correlation in3 queue states, both-member admission/dequeue
deadline matrix, bounded presence replacement). Frontend exposes terminal,
constructor failure, mic affordance and disconnect render failures; cache owner
tests2fail/3negative-controls-pass. Actual Chromium persisted-page test also
fails at hidden call bar after pageshow, using full panel/chatView/thread. First
browser attempt failed before app startup due Python Store alias; rerun with
WIXY_E2E_PYTHON real3.14 reached the real defect. Runtime source remains4983cc6;
only regression tests/report/task files changed. Astra combined report read;
Gemini missing at due follow-up but native steps214/306 advancing, not dead.
Neutral status query sent; bounded wake sw_7e8d478523ce4321931b8b56b03291ea
owns next action. Parent integrates after concrete comparison/adjudication.

LATEST: two-family MERGE is complete and parent integration is locally proven.
Read `spec/server-chat/voice-repair-round1-ruling.md` and both merge reports. Parent
adopted futures with separate 4/8 executors, deferred eviction, production-bound capture,
render-quantum acknowledgements/original expiry and correlated invitation ownership.
Five extra parent discriminators failed red then passed: repeated Answer, delayed ack
with frozen audio clock, recycle-on-callback-error, admitted-route cancellation close
code and nested transition cleanup. The real-browser loop then exposed late former-pair
messages disconnecting presence and target-selection failover to the observer; both
have red/green discriminators and repairs. Removed-peer credit/lease erasure also fixed.

Current proof: 43 server call/repair tests pass with four workers; 1,702 frontend chat
regressions pass with four workers; strict TS, full mypy (244 files), ruff/format and
rebuilt LF assets pass. Real three-context Chromium synthetic duplex test PASSED
(28.4 s test, 35.2 s total): rendered sound, 450 ms stall, fresh consent, muted idle
pause, panic cleanup/fresh countdown, zero PCM/no prompt/no microphone on an unrelated
unlocked third browser. After stall both call contexts closed but sockets stayed open;
no unexpected visibility changes. This is local privacy proof, not physical-device,
production-tunnel, latency/loss/15-minute speakerphone or Slots acceptance.

Next owner/action: parent freezes repair candidate and dispatches a NEW senior auditor,
not either proposer. Keep implementation unchanged during that audit. Then parent owns
private live test exposure, physical gates and final PR/checks/one confirmed merge.
No PR or delivery merge exists. Device decision 1867 is answered in chat; Answers 2957
has the verified local third-browser result and the ordinary-message-sync distinction.
The older paragraphs below are historical progress, not current completion claims.

First implementation audit is complete and blocks delivery: C0/H1/M4/L0 at
`4829f606fcfbf53f05f1dc955bce35abb4ce3695`; report
`spec/server-chat/voice-call-implementation-audit.md`. Reopen relay/browser repair work.
Five demonstrated defects: real worker lifetime under cancellation, capture freshness
relabelling, reentrant overflow, crossed-invite UI ownership and unbounded worklet
lease controls. Use Group Therapy independent proposals -> all-proposal merge ->
parent ruling/local repairs -> fresh audit. Round brief:
`spec/server-chat/voice-repair-round1-brief.md`. No launch approval; no third-party
audio disclosure found by that audit. Add live third-browser negative control.

Repair PROPOSE seats (no implementation delegation): Astra finder
`300d1225-5c81-4261-801b-bbdc484df0ea` writes
`spec/server-chat/voice-repair-proposal-astra.md` in this checkout; Opus
`a6f2f9cc-cb23-44cc-b306-b8e87c785495` owns isolated workspace 49
`D:/Servers/Cmd/Storage/clones/wixy__worktrees/00049__wixy_group-therapy-propose-reviewer-opus-for`
and writes `spec/server-chat/voice-repair-proposal-opus.md` there; Gemini
`c2ee5b92-d84b-443e-9508-f1d56a9cae84` owns isolated workspace
`14bddc5b-fda4-45d5-a4b4-70ea322a38b7` and writes its own
`spec/server-chat/voice-repair-proposal-gemini.md` (resolve actual cwd from reply/diagnose).
All receive the same brief at source commit 74c9578; do not read each other's proposals
before phase MERGE. Parent owns next action on completion: read every actual artifact,
send ALL proposal paths to EVERY reviewer with equal standing and provenance labels,
then rule on mechanism convergence, implement locally and obtain a fresh independent
audit. Each lane has a 1200-second watchdog; parent follow-up is armed separately.
Do not wait in a foreground loop. No PR is open and no launch/live acceptance exists.

PROPOSE progress: Opus's complete artifact is copied intact into this checkout at
`spec/server-chat/voice-repair-proposal-opus.md`; its own isolated trial reports all
five reds/greens, 340 Python and 1,223 focused TS checks, strict types. Astra's complete
`spec/server-chat/voice-repair-proposal-astra.md` has component greens and explicitly
unexecuted M1/M4 integration greens; do not inflate that evidence. Gemini proposal not
yet present at its expected path. Diagnosis shows native `max_step_idx=37` while
translated-reader `last_step_idx=-1`; this is not proof of death or a never-started
worker. Sent a neutral status query (working/finished/blocked), not a restart command.
Parent next: take Gemini reply/artifact or repair a demonstrated infrastructure block;
then send ALL actual proposals together for MERGE. Existing 900-second parent wake
`sw_06ddcbcde1cf4c818615294894ca46e5` and per-seat watchdogs remain the follow-up.

At the scheduled proposal follow-up, parent selected the two completed independent
families (Astra + Opus) for MERGE rather than waiting indefinitely for Gemini's missing
artifact. Stop is requested from Gemini; do NOT call it dead or count its work as a
third result. Both selected reviewers receive BOTH actual proposal paths and the
merge brief with equal standing. Outputs: parent
`spec/server-chat/voice-repair-merge-astra.md` and Opus workspace 49
`spec/server-chat/voice-repair-merge-opus.md`. Parent owns convergence adjudication,
local repair implementation and fresh audit; neither proposer can certify launch.

Astra MERGE complete and banked at `spec/server-chat/voice-repair-merge-astra.md`:
actual executor futures with separate 4/8 work quotas, deferred overflow eviction,
immutable production-time capture, render-quantum acknowledgements tied to receiver
leases, and correlated incoming/outgoing ownership. It explicitly finds Opus's
"never 4401" claim stronger than its test and code establish; repair operational
termination mapping and test absence of unauthorized-lock callbacks. Opus MERGE
remains next input; do not treat one merge recommendation as both-family convergence.
The parent MERGE wake `sw_ae2aae9f070a497ba54ea7e106e336e6` remains active.

Gemini stop was requested via peer and discovered documented
`POST /api/session/{id}/interrupt`; response was `ok:false, via:provider-kill`.
Subsequent diagnosis still showed a live driver/native unread store, so stop is NOT
confirmed. Do not claim stopped/dead and do not count its absent result. Its work is
outside the selected two-family panel and cannot hold delivery progression hostage.

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
