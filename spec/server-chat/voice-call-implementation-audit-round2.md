# Independent voice-call implementation audit — round 2

**Reviewed HEAD:** `4983cc662730f1a18bd95a5337d9c1a1fc45cb1b`
**Base:** `7a952c6cc590e5acf67996c1a7cbcc1b474a7ddc`
**Date:** 2026-10-18
**Reviewer:** fresh senior implementation-audit session; did not author the proposals or repairs.

**Code verdict: CHANGES REQUIRED — C0 / H0 / M3 / L2.**

The authorization admission, native-work accounting, socket-pair ownership and
audio provenance repairs are substantially sound. However, terminal cleanup can
strand an outgoing attempt, the media send path misses a sender-authorization
boundary, and cached-page restoration loses the call interface. These are
independently reproduced issues in this exact candidate, despite the passing
focused suites. The two low findings are smaller failure-handling/UI omissions.

**Launch verdict: NOT READY / external acceptance still unproven.** Repairing the
code findings does not establish physical-device, production-tunnel, sustained
quality or Slots acceptance.

## Scope and evidence discipline

Read the acceptance packet, current `04-voice-calls.md`, its adopted architecture
ruling, the current repair ruling, current contracts/Inv 55/livechat/runbook, and
the actual server/browser implementation and integration. The packet was treated
as intent and a list of claimed evidence, not proof. No previous audit or proposal
document was opened or reused. A lane lookup incidentally returned historical
monitor summaries; they were not used as evidence or as the verdict.

HEAD and the initially clean worktree were checked. No implementation changes,
branches, commits, push, PR, merge, agents, full CI or blanket regression reruns.
The sole authored file is this report. New discriminators used Python and
in-memory esbuild/Node/jsdom execution of the current source, without adding test
files or replacing implementation methods.

## Findings

### M1 — A terminal transition can strand an outgoing attempt before it learns its call ID

**Locations:** `wixy_server/livechat/call_broker.py:237–253,312–323`;
`admin-ui/src/server/call/controller.ts:36–46,99–108,184–193,255–276`.

`finish()` correctly removes queued controls carrying the terminated call ID,
including an unsent `outgoing`. It then sends `ended` with only that call ID. The
caller still has an `outgoingRequest`, but has never received its server-assigned
`callId`. The controller ignores the terminal message at lines 275–276. It does
not clear the pending request, stop its empty AudioContext or release `onBusy`.
`callUntil` is still zero, so its call timeout cannot recover this state.

**Reproduction, using the real broker output as input to the real controller:**

1. Attach A and B; A selects B and clicks Call. Retain the emitted request ID.
2. Give B a full 16-control queue, then submit A's actual `Invite` to the broker.
3. B overflows on `incoming`. Deferred eviction finishes the call and removes
   A's queued `outgoing` before the route writer can send it.
4. Feed A's surviving controls to the compiled controller and run its pulse.

Observed broker state: `call_exists=false`, `caller_closed=false`,
`target_closed=true`. A receives presence, `ended {callId, reason:disconnected}`,
and final presence; no correlated `outgoing` or `unavailable`.

Observed client state:

```json
{"callDisabled":true,"endHidden":true,"stops":0,"creates":1,"controllerBusy":true}
```

The caller cannot call or cancel and voice-note recording stays disabled until
an unrelated detach/reconnect/expiry. This is not microphone capture before
consent: the retained graph is the empty gesture-activated context.

A second broker discriminator, without overflow, submitted `decline` before
draining A's `outgoing`; it produced the same uncorrelated terminal sequence.
Thus the issue is not confined to the overflow test setup. Independent socket
writers can deliver the callee's prompt while the caller's writer is delayed.

**Concrete repair:** Preserve the invitation's originating request ID in call
state and ensure every terminal-before-outgoing path delivers a matching terminal
result to the caller. For example, emit a correlated `unavailable` for the
originating request as well as the epoch's `ended`, or explicitly support a
request-correlated terminal envelope. Only retire that matching pending attempt;
do not disturb a newer winning incoming/accepted call. Keep stale phase controls
purged. Add a broker-to-controller regression for both target-overflow and
decline-before-outgoing, asserting graph stop, `onBusy(false)`, no pending request
and usable controls. The existing overflow tests assert removal of `outgoing`
but do not check what the surviving caller does with the remaining messages.

### M2 — Media fast paths can forward after the sender's authorization or call lifetime ends

**Locations:** `wixy_server/livechat/call_broker.py:381–426,429–450`;
`wixy_server/routes_livechat_calls.py:80–105,119–123`.

`next_media(receiver)` checks only the receiver's authorization, connected state
and receiver playout expiry. It does not check the other member's effective
Access/unlock deadline or grant deadline. A frame queued while A was authorized
can therefore be newly submitted for B's socket after A becomes unauthorized.
The writer's preceding `permitted(peer)` also refers only to B. Separately,
neither `frame()` nor `next_media()` checks the connected call's `until` deadline;
those paths rely on a later monitor tick.

**Reproduction:** Connect A/B, issue capture and receiver leases, and queue one
valid A frame for B. Let A's effective authorization deadline pass before calling
`next_media(B)`, without calling the periodic monitor first. An actual wall-clock
probe used A's deadline 25 ms ahead and waited 40 ms, while B's authorization and
300 ms lease remained valid:

```json
{"sender_permitted":false,"queued_frame_forwarded":true}
```

Additional focused state-boundary controls:

| Boundary before `next_media(B)` | Result |
|---|---|
| A's effective authorization expired | Frame forwarded |
| A's grant check marked `grant_until=0` | Frame forwarded |
| Connected call's `until` expired | Frame forwarded |
| B's authorization expired, negative control | Frame correctly withheld |

The normal monitor cadence limits this to a scheduling window, nominally up to
100 ms plus scheduling delay; this is not an unbounded authorization bypass or
delivery to a third device. Nevertheless, the specified per-media-send gate is
missing. This concerns bytes not yet submitted to the socket, not the explicitly
acknowledged impossibility of recalling bytes already in the network/device.

**Concrete repair:** At both media admission and dequeue, verify the current
epoch, connected lifetime and both pair members' cached authorization. If either
member/lifetime has ended, atomically terminate or discard the call's pending
media/credits before sending any further frame. Do not invoke native verification
per frame; the existing cached deadlines suffice. Retain correct 4401 versus
operational-close classification. Add clock-boundary tests between enqueue and
dequeue and before receive, without requiring a preceding `tick()` to make them
pass; include confirmed revocation and the two-hour lifetime boundary.

### M3 — Restoring a cached, still-unlocked page leaves the call interface hidden

**Locations:** `admin-ui/src/server/call/controller.ts:337–348`;
`admin-ui/src/server/panel.ts:1023–1025,1052–1053,1062–1087`;
`admin-ui/src/server/chatView.ts:119–120,137–157`.

The call controller's `pagehide` always invokes full `detach()`, which nulls its
session, closes presence and hides the element. It has no `pageshow` recovery.
The panel's `pageshow` only clears `unloading`; with hidden policy `ignore`, a
still-valid, still-unlocked chat is not reattached on visibility restoration.
Consequently the call UI/presence remains absent until an unrelated reattachment.
The adopted architecture explicitly requires cached-page restoration to start
fresh presence without resuming audio.

**Reproduction:** Attach the real controller with valid session/presence, then
dispatch `pagehide {persisted:true}` followed by `pageshow {persisted:true}`.
Observed `element.hidden=true`, socket creations still `1`. Explicitly calling
`attach` afterwards produces `hidden=false`, socket creations `2`, confirming
the missing restoration transition. Current panel source establishes why its
ignore-policy restoration path does not supply that attach.

This is a deterministic event/lifecycle discriminator, not a claim to have
measured a physical browser's back/forward-cache eligibility.

**Concrete repair:** Make cached-page restoration an explicit transition owned
by the still-attached chat/panel. Reattach presence only if that owner remains
unlocked and its session remains valid after the existing expiry/hidden-policy
checks. Distinguish page suspension from an actual lock/dispose so the latter
cannot regain authority. Do not restore call ID, graph, microphone or suspension;
new Call/Answer gestures remain required. Test both the valid ignore-policy
restore and locked/expired/disposed negative controls.

### L1 — Synchronous audio creation failure on Answer leaves the peer ringing

**Locations:** `admin-ui/src/server/call/controller.ts:48–54,138–145,146–182`.

`activateAudio()` catches a synchronous constructor/factory exception and calls
`teardownCall()`, discarding the incoming call ID without notifying the server.
This can occur when `AudioContext` is unavailable or construction is refused.
The callee sees “Calls unavailable in this browser”, but the server/caller still
reserve the ringing pair until its 30-second timeout; the callee cannot decline
the now-hidden invitation.

**Reproduction:** Deliver an incoming invitation, have the real controller's
audio factory throw synchronously, then click Answer. Observed outbound controls
contain only the original auth message: no accept, decline, end or failed. The
local call is cleared and the failure text appears.

**Concrete repair:** Use the existing `end()` terminal path in this catch, so
local teardown happens first and the retained incoming ID is then declined (or
send a valid failure control). Caller-side failure before an invite must still
send no fabricated call action. Test both roles and immediate server reservation
release rather than waiting for the ring timeout.

### L2 — Call remains visibly enabled while voice-note recording owns the microphone

**Locations:** `admin-ui/src/server/call/controller.ts:36–38,99–105,184–185`;
`admin-ui/src/server/thread.ts:3007–3008`.

The handler correctly refuses to start a call when `isMicBusy()` is true, so
microphone exclusivity is preserved. However, Call's disabled state never checks
that condition and only Answer is refreshed during pulses. With a target
available and a voice note recording, Call appears actionable but silently does
nothing, contrary to the specified disabled Call/Accept affordance.

**Reproduction:** Attach with `isMicBusy() === true` and an available target.
Observed `Call.disabled=false`; clicking creates no graph and emits no invite.

**Concrete repair:** Include microphone ownership in Call's rendered disabled
state and refresh it when recorder ownership changes (or through the existing
bounded pulse). Preserve the handler guard. Test busy-to-idle as well as
idle-to-busy so the button becomes usable again without a presence event.

## What was independently verified

| Area | Assessment in this candidate |
|---|---|
| Admission gates | Exact configured Origin, no query, public subprotocol, independent shared RS256/audience/issuer verification, nonempty email and finite future expiry; first-frame token uses shared identity/grant validation. No bypass found. |
| Native capacity | `CallWork.run` owns 4 admission / 8 refresh slots until actual future completion or pre-start cancellation; separate executors avoid AnyIO's HTTP limiter. Cancellation/timeouts do not recycle running permits. Operational failures do not falsely instruct owner lock. Native jobs remain non-killable; process exit is not certified. |
| Consent and isolation | One immutable socket pair, same-email/token support, explicit acceptance and both-ready gating. Third socket cannot answer/end/join or receive PCM. Crossing invitations and repeated Answer are guarded. |
| Overflow and terminal epochs | Deferred outer-transition eviction and nested-finally depth recovery work. Removed peers lose media/credits/leases. One previous epoch permits only bounded benign drops, not stale accept/ready or third-party authority. M1 is the remaining cross-layer terminal-result defect. |
| Audio freshness/resource bounds | Fixed frame/header/rate checks; five capture buffers and receiver credits; bounded relay/ring. Production-bound lease/revision/first-sample metadata, rejection/recycling, one coalesced state control, render-quantum acknowledgement and remaining original wall/audio expiry are implemented. No additional defect established in these mechanisms. M2 is the send-authorization/lifetime boundary. |
| Lock and idle | Actual detach/dispose/token replacement invalidates generations and stops audio; late microphone permission is stopped. Connected/muted calls own one dedicated idle suspension; release restarts the existing countdown. Tab/screen rules remain authoritative. M3 concerns presence recovery after cache restoration, not audio continuing through a lock. |
| Target selection | A selected busy/disappeared device does not silently become another available tab. Ordinary chat message synchronization remains shared across unlocked views. |
| Deployment/privacy shape | Production module entry point and E2E fixture share 4096-byte / four-message / no-compression Uvicorn options. Standalone runs that module entry point. Broker is one-process, memory-only; call code adds no store schema/SSE/audio history/transcription path. Self-hosted worklet and checked source/worklet working files are LF. TLS is not E2EE. |

Independent focused executions, both successful:

```text
python -m pytest wixy_server/tests/test_livechat_calls.py wixy_server/tests/test_livechat_call_repairs.py -q -p no:cacheprovider
43 passed (configured four workers), including signed-JWT and real fragmented-oversize Uvicorn tests.

# From admin-ui:
npm exec vitest run tests/server/call.test.ts tests/server/callAudio.test.ts tests/server/callRepairs.test.ts tests/server/callWorklet.test.ts -- --maxWorkers=4
4 files / 32 tests passed.
```

The new discriminators described above also executed against this HEAD. The
first version of the cross-layer harness used an incorrect `ServerAuth` fixture
argument and failed before exercising implementation; that harness error was
corrected before the reported observations. No implementation repair was made.

The parent's 1,702 frontend regressions, strict types/lint/format, LF rebuild and
three-browser Chromium duplex/stall/privacy run are **reported parent evidence**;
they were not rerun or independently certified here. The browser test source was
inspected. A base-to-HEAD `git diff --check` additionally reports trailing spaces
in proposal/merge Markdown artifacts, so a working-tree-only diff check must not
be described as a clean check of the whole candidate range. This is a delivery
hygiene note, not an additional runtime finding; those proposal bodies were not
used to derive the audit.

## Launch readiness remains separate

The following gates remain open regardless of a future clean code audit:

- Physical devices, including actual Android Chrome/iPad Safari and the actual
  iPhone browser; microphone/speaker, echo/double-talk and background behavior.
- Actual production HTTPS hostname, Cloudflare Access and tunnel, including
  different networks and cellular operation.
- A measured 15-minute duplex/speakerphone run, latency distribution/sample
  counts, jitter/loss stress, bounded resource use, and no delayed audio bursts.
- Actual Slots drain/hard-stop, including blocked native verification/grant work.
  `shutdown(wait=False)` and the declared `force_kill_host` setting do not prove
  that the deployed old process and sockets are stopped within the required bound.

Do not infer any of those from unit tests, injected lifecycle events, synthetic
Chromium audio or the passing native-worker quota tests. After the medium repairs,
freeze a new candidate and verify the specific discriminators and affected
regressions; this report does not clear this SHA for delivery or launch.
