# Voice-call implementation audit — workspace 48

Reviewed candidate: **4829f606fcfbf53f05f1dc955bce35abb4ce3695**.
Relevant base: **7a952c6cc590e5acf67996c1a7cbcc1b474a7ddc**.
Review date: 2026-10-18. Independent senior security/concurrency review; this reviewer
did not author the architecture. Intent: [voice-call specification](04-voice-calls.md)
and [senior architecture review](voice-call-architecture-review.md).

**Verdict: CHANGES REQUIRED for local implementation acceptance. C0 / H1 / M4 / L0.**
The authentication and immutable-pair design have substantial correct protections,
but the worker bound, capture freshness, queue-overflow transitions and browser
control ownership still have reproducible defects. This is **not launch approval**.
The separate physical-device/tunnel/quality/Slots gates below remain unproven even
after these repairs. No implementation files, branches, commits, pushes or PRs were
changed by this review; this report is the only repository addition.

Severity usage: C = critical compromise; H = substantial security/resource isolation
failure; M = material correctness or explicit safety-bound failure; L = minor issue.
No unauthorized third-party media disclosure was found in this pass.

## H1 — Native asyncio cancellation releases slots before grant workers finish

**Locations:** `wixy_server/routes_livechat_calls.py:158-170, 201-205`;
`wixy_server/routes_livechat_calls.py:106-130`;
`wixy_server/livechat/tokens.py:243-250`. The related non-abandonment assumption is
also documented at `routes_livechat_calls.py:153-154`.

`asyncio.timeout(5)` includes the off-thread initial device-grant lookup. Native
asyncio cancellation interrupts the await of `anyio.to_thread.run_sync` in this
installed stack despite its default `abandon_on_cancel=False`. The underlying
thread continues; the route's `finally` releases its pending slot. Likewise,
`run_peer` calls `Task.cancel()` on the refresh worker and joins the cancelled
async task, which is not evidence that its synchronous database work finished.
The AnyIO limiter also ceases to account for that abandoned work. Thus the stated
4-pending/8-connection limits do not bound actual database workers.

**Reproduction, executed against this source:** use `calls_socket` with a synthetic
WebSocket carrying a correctly minted, grant-bound unlock token and a store whose
`is_device_grant_live` waits on a `threading.Event`. Use the explicit development
Access bypass only to isolate this cancellation test. Start four auth routes,
allow their real five-second auth deadlines to expire, and repeat four times
without releasing the event. The store counted actual entered, not-yet-returned
synchronous calls. Results after each batch:

```text
pending: 0 connections: 0 blocked grant threads: 4
pending: 0 connections: 0 blocked grant threads: 8
pending: 0 connections: 0 blocked grant threads: 12
pending: 0 connections: 0 blocked grant threads: 16
```

All blocked workers were released at probe completion. A smaller direct probe of
`validate_server_token` inside `asyncio.timeout` also returned `TimeoutError` while
its synchronous worker remained running. Production follows the same token/grant
helper after its independent Access check; this is not an Access bypass finding.

**Impact:** during a blocked/slow database or storage failure, repeated authorized
connections can grow orphan worker/resource consumption beyond the advertised
site bounds. The per-email admission budget is applied only in `broker.add`, after
the problematic initial lookup, so it does not constrain this path. Normal fast
SQLite lookups do not demonstrate the failure; blocked work is the trigger.

**Concrete repair:** make actual worker completion own a fixed-capacity permit,
independent of route/task cancellation. Keep bounded references to outstanding
worker futures, and reject new work when capacity is occupied; do not release a
permit merely because its awaiting task timed out. Separate prompt fail-closed
socket/media termination from worker accounting. Apply this to initial auth,
periodic grant refresh and verifier cancellation. Merely adding `asyncio.shield`
without retaining/accounting for the still-running job is insufficient. Add a
blocked-store test that exceeds multiple admission cycles, native cancellation of
an admitted refresh, and shutdown; assert actual live work stays within its cap.

## M1 — Capture buffers are relabelled with a newer freshness lease

**Locations:** `admin-ui/src/server/call/worklet.ts:79-83`;
`admin-ui/src/server/call/audio.ts:41-47`;
`admin-ui/src/server/call/controller.ts:147-158, 257-259`;
`wixy_server/livechat/call_broker.py:285-291`.

The worklet posts only `{type: "capture", pcm}`. Neither capture time nor the
server capture lease associated with sample production crosses the MessagePort.
When the main thread eventually handles that buffer, the controller stamps its
*current* `captureLease`. A queued old frame can therefore acquire a lease issued
after its samples were recorded. The server correctly checks the supplied lease,
but that lease no longer establishes the age of these samples. The sample index
is derived from send sequence, so it cannot recover their original capture time.

**Reproduction, executed:** bundle the current controller with a controlled clock
and audio callback. Connect with capture lease 1; retain a PCM buffer produced at
20 ms. At 250 ms, deliver server capture lease 2 before delivering the queued PCM
callback. The main-thread watchdog has not exceeded 300 ms. The emitted binary
frame contains **lease 2**, not the lease under which the buffer was produced.
Then exercise the current broker with lease 1 issued at 0 ms and lease 2 issued at
200 ms, and deliver that frame at 450 ms with a valid receiver lease. Result:

```text
queued capture made at 20 ms, delivered at 250 ms, stamped capture lease: 2
430 ms old capture relabeled with lease 2 was forwarded: True
```

The corresponding original lease would have expired at 300 ms. This is a
deterministic component-level timing reproduction, not a measured network result.
It demonstrates the ruling's prohibited relabelling across the worklet boundary.
The existing 450 ms main-thread-stall test ends the call and misses this
sub-300-ms scheduling stall followed by transport delay.

**Concrete repair:** bind each capture buffer to the server-issued lease while
its samples are produced, and return that immutable lease plus capture-time/sample
metadata with the transferable buffer. Propagate it unchanged to the wire; drop
expired buffers while returning their storage to the pool. Do not refresh a
buffer's lease at main-thread receipt. Scope metadata to the call generation.
Test delayed MessagePort delivery interleaved with newer WS leases, subsequent
network delay, mute/unmute and buffer-pool recycling. Preserve the independent
receiver-issued playout deadline as well.

## M2 — Control-queue overflow re-enters and invalidates a paired transition

**Locations:** `wixy_server/livechat/call_broker.py:101-107, 152-181, 233-244`;
`wixy_server/routes_livechat_calls.py:187-198`.

`emit` synchronously calls `remove` on queue overflow. Removal can call `finish`
and `presence`, which emit more messages and remove other peers. The enclosing
accept/ready transition then continues indexing `self.peers[key]` as though both
participants and the call still existed. No await is needed for this reentrancy.

**Reproduction, executed:** use the existing `peers()` test helper, invite A to B,
clear their control queues, fill A to the legal capacity of 16 and B to 14 with
ping controls, then execute B's `accept`. Enqueuing A's prepare removes A;
terminal/presence emissions overflow and remove B; the next paired lookup raises:

```text
overflow exception: KeyError
overflow terminal state: None caller closed: True callee closed: True
```

The same unchecked paired-lookup pattern exists when emitting `connected`.
Backpressured writers plus bursts of valid controls/presence can exercise the
queue boundary. The route does not catch `KeyError`, so this escapes as an ASGI
failure rather than the intended fixed terminal outcome. Cleanup in this probe
did destroy the pair; no media leak or persistent call was observed.

**Concrete repair:** make overflow an explicit transition result, or defer its
removals until the current transition is finished. After an emission that can
terminate ownership, verify the same call object/epoch and peer membership before
continuing; never index mutable membership on the assumption that emit succeeded.
Do not merely swallow `KeyError`. Add accept, second-ready, presence and shutdown
tests with both queues near/full, proving deterministic terminal messages where
deliverable, no exceptions and no stale prepare/connected controls.

## M3 — A crossing invite's busy reply erases the winning incoming invitation

**Locations:** `wixy_server/livechat/call_broker.py:196-215`;
`admin-ui/src/server/call/controller.ts:34-44, 237-245`.

The broker correctly serializes simultaneous invitations: one reserves the pair,
and the other receives `unavailable`. That rejection has no request identifier.
The browser handles every `unavailable` with unconditional `teardownCall`, even
when it has already received the winning call's `incoming` message.

**Reproduction, executed with the compiled current controller:** B clicks Call
for A; A's invitation wins at the broker. Deliver B's ordered `incoming` followed
by `unavailable` for B's losing outgoing request. Observed:

```text
before: Incoming call from A
after: That person is unavailable
answer hidden: true
terminal sent: false
```

B can no longer answer or decline the winning invitation, while the broker and A
remain reserved/ringing until timeout or A cancels. The existing glare test checks
broker pair identity only, so it does not detect this client/server mismatch.

**Concrete repair:** correlate invitation responses using `requestId`, retain
outgoing-attempt ownership separately from the current incoming call, and clear
only the rejected outgoing attempt/resources. Preserve the winning incoming
invitation and require its explicit Answer gesture. Test both crossing orders,
late busy replies and cancellation; assert browser and broker state agree without
waiting for the ring timeout. Do not convert a losing Call click into an answer.

## M4 — Main-to-worklet lease traffic has no credit or graph-liveness bound

**Locations:** `admin-ui/src/server/call/controller.ts:166-184, 306`;
`admin-ui/src/server/call/audio.ts:75-78`;
`admin-ui/src/server/call/worklet.ts:35-36`.

Each 100 ms pulse posts another lease to the worklet without acknowledgement or
a maximum outstanding-control count. The five transferable capture buffers bound
capture traffic, and server credits bound playback frames, but neither bounds
these lease messages. If the rendering/worklet thread stops servicing its port
while the main thread/context remain apparently running, control messages keep
accumulating. During a muted/silent call there may be no media acknowledgement to
expose this: the server continues receiving fresh leases and pong responses from
the main thread. Those responses do not prove the audio graph is alive.

**Reproduction, executed using the current `CallAudio`:** prepare/start with a
stub worklet whose port does not consume messages, invoke `lease()` 10,000 times,
and count posted lease controls: **10,000**, with no acknowledgement or refusal.
This models a stopped consumer; it is not a claim that a healthy browser queues
10,000 controls. At the real pulse rate that is 1,000 seconds, inside the two-hour
call maximum. The lifetime cap is not the specified fixed-capacity port bound.

**Concrete repair:** permit at most one/fixed-small number of lease controls in
flight, coalesce subsequent desired updates, and have the worklet acknowledge
processing with the current generation. Fail the call when graph acknowledgement
misses the freshness/liveness deadline. Audit enabled/stop controls at the same
boundary. Add a running-context/stalled-port test during a muted call; assert
bounded pending controls and prompt explicit end, rather than indefinite apparent
connectivity. Keep the existing capture-pool and playback-credit bounds.

## Checks that passed, and limits of the evidence

The checkout was clean initially and HEAD matched the requested full SHA before
and during review. Source, intent, changed docs and relevant tests were inspected;
the supplied suite totals were not treated as a substitute for code review.

Independently executed in this pass:

- `python -m pytest wixy_server/tests/test_livechat_calls.py -q`: **22 passed**,
  using the repository's fixed four-worker configuration. Includes a real Uvicorn
  fragmented 6,000-byte message rejected with 1009 under `SERVER_OPTIONS`.
- From `admin-ui`, `npm test -- tests/server/call.test.ts
  tests/server/callAudio.test.ts tests/server/callWorklet.test.ts`: **10 passed**.
- The additional cancellation/route-cap, queue-overflow, controller-glare,
  capture-lease and stopped-worklet probes described above. They import/bundle
  the current source without editing it. Local reproducibility artifacts:
  `C:/Users/josh/AppData/Local/Temp/wixy-audit-4829f606.py` (add `--slow` for the
  four real five-second route timeout batches) and
  `C:/Users/josh/AppData/Local/Temp/wixy-audit-4829f606.cjs` (run from repo root).
- `git diff --check` passed; the four call TypeScript sources are LF. No asset
  rebuild or full-suite/CI rerun was performed during this frozen audit.

Source-supported positive conclusions:

- The WS route independently uses the RS256 JWKS verifier with configured
  audience/issuer, requires verified email and finite future expiry, and rejects
  wrong/missing/duplicate Origin, duplicate assertion headers, query strings and
  non-exact subprotocol selection before accepting. Production does not trust the
  email header. The explicit dev bypass is separate.
- The first frame uses strict bounded JSON and the shared unlock-token validator,
  including grant revocation. Auth fields are discarded after verification, and
  effective expiry is the minimum of Access/unlock expiry. Cached permission is
  checked on commands, media receive and sends; periodic checks continue in mute.
  The normal grant refresh is two seconds, with a 2.5-second fail-closed cache.
  H1 concerns the lifetime/accounting of the underlying work, not a demonstrated
  authorization bypass.
- Socket IDs, not email/token equality, own the immutable pair. Source and tests
  support same-email/same-token calling and rejection of third-party actions and
  media. Both consent before microphone acquisition; both ready before media.
  There is no auto-answer or automatic call resumption.
- Route workers are fixed in number per admitted connection; application control
  and media queues, receiver outstanding frames and capture-transfer buffers
  have explicit capacities. The intentional control bucket is **80/s, burst
  100**, as adopted in the spec/brief; the provisional 30/s is not a finding.
  H1 and M4 identify bounds that those visible counts do not establish.
- `SERVER_OPTIONS` is shared by the production main entry and E2E fixture:
  reassembled limit 4096, receive queue 4, compression disabled, graceful shutdown
  two seconds. This version is expressly single-process. No schema change or call
  persistence, SSE insertion, transcription or application token/PCM logging was
  found in the new path. Deployment-edge logging and real Slots drain were not
  inspected live.
- Audio teardown stops tracks and disconnects/closes the graph. Generation checks
  protect late permission/readiness/rejection; stopped checks follow resume,
  addModule and getUserMedia. Call detach is wired through chat detach/dispose,
  pagehide and token replacement. Existing panel detach handles actual lock and
  shield. Voice-note arbitration blocks concurrent microphone ownership.
- The dedicated `voiceCall` suspension leaves tab/screen preferences intact.
  Releasing the last suspension calls the existing idle reset, updating both
  monotonic and wall-clock activity; another suspension still keeps idle paused.
  Muting does not release the call suspension. Auth-close teardown precedes the
  unauthorized hook, including when that hook chooses renewal.
- The worklet uses the actual context rate, fractional capture/playback resampling,
  a fixed 4,800-sample ring (200 ms), 60 ms startup fill, bounded drift correction
  and per-sample playout expiry. Its tests check 44.1/48 kHz capture tone and
  silence after expiry. These are distinct from successful socket connection.
  They do not establish prolonged clock-drift quality, speakerphone echo control
  or aliasing quality; M1 separately breaks capture provenance/freshness.

The checked-in browser integration test was read, not rerun here. Its rendered
synthetic duplex, 450 ms stall, muted idle, panic track-stop and remote idle checks
are useful reported evidence. They do not cover the five adversarial findings.
The dedicated new audio unit test covers late getUserMedia; the full controlled
resume/addModule, shield/restore, stale-attempt and background-policy matrix is
not demonstrated by these ten focused tests. Add targeted regressions with the
repairs, including in-call grant revocation/blocked refresh while muted. The two
unrelated game-test edits are equivalent import/type narrowing changes on review;
this pass did not rerun their tests or the reported whole-repository checks.

## Separate live acceptance gate — still open

Do not certify launch readiness from this report, passing synthetic Chromium
audio, or a connected WebSocket. The parent still needs observed evidence for:

1. Two physical devices on distinct external networks through the **actual HTTPS
   hostname, CF Access and hub tunnel**, including the intended phone/browser.
   Deliberate Call/Answer, real mic/speaker output and both directions must work.
2. A minimum **15-minute duplex** run with silence, mute/unmute, chat use,
   headphones then speakerphone/double-talk. Record ephemeral aggregate counters
   and listening observations, never conversation audio or transcripts.
3. Measured synthetic one-way p95 mouth-to-ear target **<=300 ms**, with method
   and sample count; forced-stall freshness without delayed bursts; queue/memory
   stability; +100 ms RTT, 30 ms jitter and 1% loss yielding intelligible audio
   or prompt explicit failure. Check actual phone CPU/underruns and echo quality.
4. Actual lock/shield/pagehide, configured hidden/screen policy, token/grant
   expiry/revocation, network loss and tunnel/server restart while audio flows.
   Prove local track/playback termination and bounded remote silence; reconnect
   restores availability only. Verify muted/background idle behavior under the
   claimed supported policies, with platform termination limitations explicit.
5. **Actual Slots blue/green drain:** old call sockets terminate within the
   bounded service transition; overlapping instances do not masquerade as shared
   presence or resurrect a call. The shared Uvicorn option is not proof of the
   deployed lifecycle.

Repair and locally regress H1/M1–M4, freeze the new SHA for focused re-review, and
keep the live gate explicitly open until its own evidence exists.

## Target-browser clarification after verdict

The parent relayed the operator's targets: Android Chrome; the regular peer's
actual iPhone browser is still unconfirmed (Safari or Chrome). An iPad and spare
Android are available. The first planned live pair is **Android Chrome + iPad
Safari**. Passing that pair must not close the separate actual-iPhone acceptance.
This clarification does not change the reviewed SHA, severity counts or verdict;
no additional tests or implementation changes were made for it.

Source-based mobile/Safari considerations within the existing live gate:

- `controller.ts:141-164` constructs `CallAudio` synchronously from the Call or
  Answer handler; `audio.ts:15-18` immediately calls `AudioContext.resume()`.
  This preserves the deliberate user gesture for initial context activation
  without acquiring the microphone before mutual consent. It is the correct
  seam to validate on the target Safari device, not proof of browser acceptance.
- Preparation later awaits that activation, loads the worklet and requests the
  microphone, then requires a running context and live tracks
  (`audio.ts:21-38`). If the context loses activation while ringing/preparing,
  the current behavior ends the attempt; there is no separate Enable audio
  gesture within that attempt. Check a delayed answer and permission interaction
  on the target devices. A clean explicit failure must not be recorded as
  successful audio activation, and a browser-specific retry flow must not bypass
  consent or the existing preparation deadline.
- `audio.ts:60-62` treats context suspension as failure; pagehide, detach and
  stopped checks protect lifecycle boundaries. The controller also ends a
  connected call after a main-thread pulse gap over 300 ms. These are fail-closed
  behaviors, not a guarantee that a mobile browser will sustain background or
  screen-off audio. Validate them against the existing hidden/screen policy and
  muted-idle requirements, including return from background/BFCache; restoration
  must not resume a call. M1 and M4 still apply to the audio-thread boundaries.

Physical microphone permission, output routing, audio interruptions, speakerphone
quality and actual browser lifecycle outcomes remain observations required from
the existing device gate, not conclusions supplied by Chromium fake-mic evidence.
