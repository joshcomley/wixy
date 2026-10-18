# Voice-call repair proposal — Opus reviewer (Group Therapy PROPOSE, round 1)

Candidate: implementation `4829f606`, reviewed at detached `74c9578` (adds the audit and the
brief). Written 2026-10-18 ~10:20 UTC in this reviewer's own isolated checkout
(`…\wixy__worktrees\00049__wixy_group-therapy-propose-reviewer-opus-for`). Nothing was
committed, pushed or opened as a PR. I did not read any other proposal.

**Summary.** I reproduced all five findings myself with new tests that fail on the
unmodified candidate. I did not reuse the auditor's probe scripts. None of the five is
misdiagnosed. I found one more defect next to M2: a leftover `prepare` reaches the
surviving peer, without needing the KeyError. And one next to M3: a second Call/Answer
leaves the first attempt's AudioContext open. Each fix below keeps the existing
ownership boundaries:

| Finding | Repair boundary | New artifact? |
|---|---|---|
| H1 orphan workers | `CallBroker.offload`: a fixed executor plus a permit released by the **job's own completion**. Initial Access verification, the initial grant lookup and the periodic grant refresh all go through it. | Yes, one method + executor on the broker that already owns `pending`/`connections`. Needed because AnyIO's limiter is released by the awaiter. |
| M2 overflow reentrancy | `@transition` on every public broker mutator. Overflow only marks the peer and queues an eviction, which runs after the outermost transition finishes. | Yes, a small decorator. It enforces the module's stated rule ("mutations never await: ownership is atomic") in one place instead of a check after every emit. |
| M3 busy erases incoming | `unavailable` carries the `requestId`. The client tracks `outgoingRequest` separately from `callId`. | No. It uses the existing `requestId` field. |
| M1 relabelled capture | The worklet binds `{lease, generation, at}` to each buffer at its first sample. Main thread checks generation and age, forwards the lease unchanged, and always returns the buffer. | No. It extends the existing capture message. |
| M4 unbounded controls | `lease`/`enabled` posts become one coalesced `state` message with **one in flight**. The worklet acknowledges by `seq`. The call fails if no ack arrives within 300 ms. | No. Two message types are replaced by one. |

Privacy and policy are unchanged: same consent, two sockets, idle-only pause, actual
lock/detach still ends audio at once, and a third same-login device gets no audio or
incoming prompt. Nothing is persisted. Ordinary chat messages still sync to every
unlocked view; this proposal changes nothing there.

## Measured outcomes (all executed locally on this checkout)

Red means the same new test run against the **unmodified** candidate source. Green
means the same test after the repair.

| Test | Red (candidate) | Green (repair) |
|---|---|---|
| `test_cancelled_auth_cannot_orphan_unbounded_grant_workers` (H1): 5 batches × 4 real `calls_socket` routes with a grant-bound token, a store blocked on an Event, and **native `Task.cancel()`** of each route | `AssertionError: 20`: **20 blocked grant threads alive** with `broker.pending == 0`; every route closed **4401** (cancelled auth locks the client) | live and entered threads each **≤ 12** (asserted); refused routes close **4429** (asserted present), never 4401; after release, `broker.work == 0` and live == 0 |
| `test_accept_overflow_is_a_clean_transition[16-14]` (M2, the audit's case) | `KeyError` at `call_broker.py:235` | no exception; call gone; both peers evicted |
| `…[16-0]` (M2, B survives) | **leftover `prepare`** in B's queue after the call ended (KeyError not needed) | B has `ended{reason:disconnected}` and no leftover prepare |
| `…[0-16]` | passed (callee overflow before caller) | passed |
| `test_connected_and_presence_overflow_are_clean_transitions` (M2: second-ready, presence, shutdown) | **leftover `connected`** delivered to B after A's overflow ended the call | no leftover `connected`; presence overflow evicts B cleanly; shutdown empties |
| `test_busy_reply_is_correlated_to_its_request` (M3 server) | `unavailable` had no `requestId` | `{"type":"unavailable","requestId":"b-1"}` |
| vitest `M3 … keeps the winning incoming call` | status `That person is unavailable`, Answer hidden | `Incoming call from B` kept; Answer sends `accept`; losing attempt's audio stopped exactly once |
| vitest `M3 … ignores a refusal for another request` | stale refusal tore down the live attempt | ignored; its own refusal still tears down |
| vitest `M3 … decline before the crossing refusal` | refusal overwrote state | decline stands, nothing revived |
| vitest `M1 … sends the lease bound when samples were produced` | frame lease **`[2]`** (relabelled) | **`[1]`** |
| vitest worklet `binds lease, generation and time at sample production` | n/a (new message protocol) | half-filled buffer keeps lease 1 after lease 2 arrives; next buffer gets lease 2; expired capture lease produces no samples; acks echo seq 1,2 |
| vitest `M4 … one coalesced control in flight` (muted, 10,000 `lease()` calls) | **10,002** posted controls | **≤ 1** posted; `onFailure` once after 301 ms with no ack |
| vitest `M4 … newest coalesced state after ack` / `M1 … drops old generation / over-age capture, recycles` | failed (no API) | pass: only the fresh buffer goes out with lease 3; all 3 buffers returned to the pool (5 initial + 3 = 8 `buffer` posts) |

Wider checks after the repair: `pytest -k "livechat_call or unlock or token or grant"`
**340 passed** (includes the 22 original call tests). `mypy` (strict, 244 files)
clean, `ruff check` clean. In `admin-ui`: `vitest run tests/server tests/serverChatView.test.ts`
**1223 passed**, `tsc --noEmit` clean, `npm run build` ok, `git diff --check` clean, and
all sources are LF.
**Not executed:** the full Python suite, the Playwright `e2e/tests/server-calls.spec.ts`
(it doesn't reference the changed message names, but the real-browser worklet `state`
handshake is unproven until it runs), and every physical-device, tunnel or quality gate.
Those stay open.

Two existing worklet tests were moved from the old `lease`/`enabled` messages to the
`state` message. That is a deliberate protocol change, not a weakened assertion. The
`call.test.ts` audio stub gained `captureLease`.

## H1 — job-owned worker permits

**Root cause, confirmed.** The awaiter's cancellation (from the internal
`asyncio.timeout(5)`, an outer task cancel, or `run_peer`'s `task.cancel()` on `grants`)
returns control to the `finally` that frees `pending`/`connections`, while the thread
keeps running. The AnyIO limiter token is tied to the awaiter in the same way. New
finding from the red run: a cancelled auth closes with **4401**, so the client calls
`lockNow("unauthorized")` and the owner gets locked out for a server-side stall.

**Repair** (diff in the appendix):
- `CallBroker.offload(job)` takes a permit under `work_lock` **before** submitting to a
  dedicated `ThreadPoolExecutor(WORK_CAP=12)`. `12 = 4 pending + 8 connections`, each
  awaiting at most one job, so legitimate load is never refused while no work is orphaned.
- The permit is released by `future.add_done_callback`, which fires when the job
  **actually finishes**, or when a queued job is cancelled before it starts. Cancelling
  the `asyncio.wrap_future` awaiter cancels only a job that has not started. A running
  job keeps its permit.
- At capacity, offload raises `CallCapacityError`. The route maps it to **4429** and
  never to 4401. A refresh that hits capacity ends the call and closes the socket (fail
  closed) without locking.
- All three synchronous paths use it: `access_identity` (JWKS verifier), the initial
  `validate_server_token(..., offload=broker.offload)`, and the `grants()` refresh. The
  HTTP path keeps its default (`anyio.to_thread.run_sync`) through the new keyword
  parameter, so HTTP routes are unchanged.
- `shutdown()` refuses new work, then calls `executor.shutdown(wait=False,
  cancel_futures=True)`. Queued jobs are cancelled. Running ones keep their permits.

**Limits.**
- A blocked synchronous SQLite or JWKS call **cannot be interrupted**. What is bounded is
  the **number** of threads (≤ 12 for the broker), not how long they live.
- The executor's threads are non-daemon, so a call blocked forever can delay process exit
  past the 2 s graceful window. Before this repair, AnyIO's workers were also unbounded in
  count. The Slots drain gate should observe this.
- I tested native cancellation from outside the route. The internal 5 s `asyncio.timeout`
  uses the same cancellation mechanism, but I did not run it in real time. The auditor's
  `--slow` probe covers that variant.
- The `dev_no_auth` bypass skipped Access verification in the test only, to isolate the
  grant path.

**Layer check.** The broker already owns admission accounting. Putting job accounting
next to it avoids a second, separately owned counter. Adding `asyncio.shield` alone is
the rejected shape: it still frees route accounting.

## M2 — overflow as a deferred, transition-safe eviction

**Root cause, confirmed, and wider than the KeyError.** In addition to the `KeyError`,
when the caller overflows during `accept`, the callee still gets `prepare` *after* the
call ended. When the caller overflows during the second `ready`, the callee still gets
`connected`. Both are leftover controls; the client currently ignores them only because
its own `callId` was already cleared.

**Repair.**
- `emit` no longer calls `remove`. On a full queue it sets `closed`, clears the queue,
  wakes the writer and appends the peer to `evicting`.
- `@transition` (depth counter) wraps `emit/add/presence/finish/remove/shutdown/command/frame/tick`.
  Only the outermost exit runs the eviction loop, through a non-decorated `drop()` (the
  former body of `remove`).
- Cascades (finish → emit → overflow) are appended to the same queue and drained in the
  same loop. While the transition runs, membership and `self.call` stay stable, so paired
  lookups and `other()` stay valid.
- Afterwards, `finish()` filters the surviving peer's call-scoped controls and queues
  `ended`. So no leftover `prepare`/`connected` survives, and the outcome is fixed:
  `ended` if the survivor's queue has room, otherwise eviction (socket close).
- No exception is swallowed. `ValueError` paths still propagate after the eviction drain.

**Limits.** A future public mutator added without `@transition` would bring the hazard
back. I propose an invariant line in `docs/ai/invariants.md`, Inv 55: "every public
broker mutation is a `@transition`; overflow never mutates membership inline."

**Layer check.** The alternative (emit returns a bool and every call site re-checks
membership/epoch) puts the invariant at 7+ call sites. The decorator makes the existing
"atomic transition" boundary real in one place.

## M3 — correlated busy replies

**Root cause, confirmed.** Broker ordering guarantees `incoming` (the winner) is queued
before the crossing `unavailable`. The client treated any `unavailable` as "end
everything".

**Repair.**
- Server: `{"type":"unavailable","requestId":<that request>}`.
- Client: `pendingInvite: boolean` becomes `outgoingRequest: string | null`.
- If `incoming` arrives while `outgoingRequest` is set, the client's own invite must lose
  (there is only one call slot). It invalidates the epoch, stops **that attempt's** audio
  and clears busy. It keeps the request id so the matching refusal is recognised.
- `unavailable` is ignored unless its `requestId` matches `outgoingRequest`. When it
  matches, it clears the request and tears down only if there is no `callId`. So:
  - a lone refusal still shows "That person is unavailable";
  - a crossing refusal keeps the incoming prompt, and Answer still needs its own gesture;
  - a stale refusal for an older request is ignored;
  - a refusal after a Decline cannot revive anything (`teardownCall` cleared the request).
- `activateAudio` now `stop()`s any existing `audio` first. This closes the separate leak
  where the Answer gesture overwrote the Call gesture's AudioContext without closing it.

**Both orderings.** A wins: B sees incoming, then the refusal (tested). B wins: A sees
incoming, then its refusal. This is symmetric code; the broker test covers the queue
order. Late reply: tested. Cancellation: a Decline before the refusal is tested. A
Cancel with no `callId` still disconnects, as today.

**Limits.**
- A duplicate `requestId` within 60 s still gets no reply at all (unchanged). The client
  never reuses one.
- Update the `docs/ai/contracts.md:17` row to `unavailable {requestId}`.

**Layer check.** No new artifact. It uses the wire field that already exists.

## M1 — capture provenance bound at production

**Root cause, confirmed.** I discriminated it with the auditor's exact interleaving at
the controller seam: capture lease 1, then lease 2, then a buffer produced under lease 1.
The frame went out stamped **2**.

**Repair.**
- On the server's `capture` message (only while connected), the controller calls
  `audio.captureLease(id)`. CallAudio puts `{captureLease: id, captureUntil:
  currentTime + 0.3}` into the coalesced graph state (see M4).
- The worklet's capture gate is now its **own** `captureLease > 0 && currentTime <
  captureUntil`, instead of the playout lease.
- At a buffer's first sample, the worklet records `bufferLease`/`bufferAt`. The
  `capture` post carries `{pcm, lease, generation, at}`. If the lease changes
  mid-buffer, the buffer keeps the **older** lease, which is the conservative choice.
- CallAudio forwards the buffer only if it is running and unmuted, the generation equals
  the current mute generation, and `currentTime - at ≤ 0.3` s. It passes the bound
  `lease` to the controller, which writes it to the wire unchanged. The buffer always
  goes back to the pool, so the five-buffer pool bound is intact.
- The controller's `captureLease`/`captureLeaseAt` state and its relabel line are gone.
  Sequence and sample index derivation, the playout lease map and per-frame `until` are
  unchanged, so playout freshness is unaffected.

**Why the server check now proves age.** The worklet can only learn lease N after the
server issued it. Samples tagged N were produced after issue(N). The server accepts N
only before issue(N) + 300 ms. So every forwarded sample is under 300 ms old at relay
receipt, with no shared clocks.

**Limits.**
- `at` is the render clock of the first sample. A buffer spans 20 ms, so worst-case age
  is lease + 20 ms. The server-side bound is still exact.
- Mute generations scope buffers within one call. Each call has its own node, so a node
  scopes the call.
- Not executed in a real browser.

## M4 — one coalesced, acknowledged control in flight

**Root cause, confirmed.** 10,000 `lease()` calls posted 10,002 controls to a port that
never consumed them.

**Repair.**
- CallAudio keeps `desired: GraphState` (`playUntil, captureLease, captureUntil,
  enabled, generation`).
- `lease()`, `captureLease()` and `setMuted()` only update `desired` and call `sync()`.
  `sync()` posts `{type:"state", seq, ...desired}` only if nothing is unacknowledged and
  the desired object changed. Otherwise it coalesces.
- If the unacknowledged control is more than 300 ms old (`performance.now`), `sync()`
  calls `onFailure()`, which ends the call through the existing path ("Audio
  unavailable").
- The worklet applies the state and posts `{type:"state", seq}` back. On that ack,
  CallAudio sends the newest coalesced state.
- Because lease pulses continue every 100 ms **while muted**, a stalled render thread is
  caught during mute and silence. That is exactly the case the audit flagged.
- `enabled` traffic is in the same single slot (with a generation, which M1 also uses).
  `stop` is one terminal post, followed by `port.close()`.
- Unchanged: the capture pool (≤ 5 transferables), `play` (≤ 5 by server credits) and
  `admitted` acks.

**Limits.**
- 300 ms is the same budget as the playout lease. Past it the worklet has already gone
  silent, so failing is honest. Real-phone false-positive rates under load are unmeasured
  (device gate).
- If the main thread stops calling `sync()`, the controller's existing 300 ms pulse-gap
  check ends the call instead.

## Required doc edits (not made here: this is a proposal)

`docs/ai/contracts.md`:
- `unavailable {requestId}`
- 4429 also means "call work capacity"
- the worklet `state`/ack message

`docs/ai/livechat.md` and `invariants.md` Inv 55:
- the job-owned work cap of 12
- overflow defers eviction to the end of the transition
- capture provenance is bound in the worklet
- one main-to-worklet control in flight

## Precommitment

- **Drop first: my M4 shape** (merging `enabled`/lease/capture-lease into one acknowledged
  state). It is correct and measured, but it is the most stylistic choice. I'd swap it
  for any proposal that keeps the "≤ 1 unacknowledged control + ack-deadline failure"
  property with less protocol churn, as long as the property itself is kept.
- **Defend hardest: H1's job-owned permit, and the 4429 (not 4401) mapping.** It is the
  only High finding. Any repair whose accounting is released by the awaiter (shield,
  timeout-then-free, AnyIO limiter) fails the red test above. And today's cancelled-auth
  4401 locks the owner out during a server stall. That is a user-visible defect the audit
  didn't name.

## Appendix A — source repair diff (against `74c9578`)

```diff
diff --git a/admin-ui/src/server/call/audio.ts b/admin-ui/src/server/call/audio.ts
index a55afb8..849c01f 100644
--- a/admin-ui/src/server/call/audio.ts
+++ b/admin-ui/src/server/call/audio.ts
@@ -1,5 +1,7 @@
 /** Owns one attempt's audio resources, including resources returned after cancellation. */
 declare const WIXY_CALL_WORKLET_URL: string;
+const LEASE_S = 0.3;
+interface GraphState { playUntil: number; captureLease: number; captureUntil: number; enabled: boolean; generation: number }
 export class CallAudio {
   private context: AudioContext;
   private stream: MediaStream | null = null;
@@ -9,8 +11,14 @@ export class CallAudio {
   private running = false;
   private muted = false;
   private activation: Promise<void>;
+  // One coalesced main-to-worklet control in flight; the worklet's ack proves it is live.
+  private desired: GraphState = { playUntil: 0, captureLease: 0, captureUntil: 0, enabled: false, generation: 0 };
+  private posted: GraphState | null = null;
+  private sentSeq = 0;
+  private ackedSeq = 0;
+  private sentAt = 0;
 
-  constructor(private onCapture: (pcm: ArrayBuffer) => void, private onAdmitted: (sequence: number) => void,
+  constructor(private onCapture: (pcm: ArrayBuffer, lease: number) => void, private onAdmitted: (sequence: number) => void,
     private onFailure: () => void) {
     this.context = new AudioContext();
     // Called synchronously from Call/Accept user gestures, before any server await.
@@ -43,8 +51,14 @@ export class CallAudio {
         if (this.stopped) return;
         if (data["type"] === "capture" && data["pcm"] instanceof ArrayBuffer) {
           const pcm = data["pcm"];
-          if (this.running && !this.muted) this.onCapture(pcm);
+          // Lease, generation and production time were bound by the worklet; never relabel.
+          if (this.running && !this.muted && typeof data["lease"] === "number" && data["lease"] > 0
+            && data["generation"] === this.desired.generation && typeof data["at"] === "number"
+            && this.context.currentTime - data["at"] <= LEASE_S) this.onCapture(pcm, data["lease"]);
           if (!this.stopped) this.node?.port.postMessage({ type: "buffer", pcm }, [pcm]);
+        } else if (data["type"] === "state" && data["seq"] === this.sentSeq) {
+          this.ackedSeq = this.sentSeq;
+          this.sync();
         } else if (data["type"] === "admitted" && typeof data["sequence"] === "number") {
           this.onAdmitted(data["sequence"]);
         }
@@ -70,13 +84,33 @@ export class CallAudio {
   setMuted(muted: boolean): void {
     this.muted = muted;
     for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
-    this.node?.port.postMessage({ type: "enabled", enabled: this.running && !muted });
+    // A new generation invalidates every capture buffer produced before this change.
+    this.desired = { ...this.desired, enabled: this.running && !muted, generation: this.desired.generation + 1 };
+    this.sync();
   }
   lease(): number {
-    const until = this.context.currentTime + 0.3;
-    this.node?.port.postMessage({ type: "lease", until });
+    const until = this.context.currentTime + LEASE_S;
+    this.desired = { ...this.desired, playUntil: until };
+    this.sync();
     return until;
   }
+  captureLease(lease: number): void {
+    this.desired = { ...this.desired, captureLease: lease, captureUntil: this.context.currentTime + LEASE_S };
+    this.sync();
+  }
+  private sync(): void {
+    if (this.stopped || !this.node) return;
+    if (this.sentSeq !== this.ackedSeq) {
+      // Coalesce while unacknowledged; a graph that stops servicing its port fails.
+      if (performance.now() - this.sentAt > LEASE_S * 1000) this.onFailure();
+      return;
+    }
+    if (this.posted === this.desired) return;
+    this.posted = this.desired;
+    this.sentSeq++;
+    this.sentAt = performance.now();
+    this.node.port.postMessage({ type: "state", seq: this.sentSeq, ...this.desired });
+  }
   play(pcm: ArrayBuffer, sequence: number, until: number): void {
     if (!this.stopped && this.running && until > this.context.currentTime) {
       this.node?.port.postMessage({ type: "play", pcm, sequence, until }, [pcm]);
diff --git a/admin-ui/src/server/call/controller.ts b/admin-ui/src/server/call/controller.ts
index 56c733e..e515bf7 100644
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -8,6 +8,7 @@ export interface CallAudioHandle {
   stop(): void;
   setMuted(muted: boolean): void;
   lease(): number;
+  captureLease(lease: number): void;
   play(pcm: ArrayBuffer, sequence: number, until: number): void;
 }
 export interface CallDeps {
@@ -16,7 +17,7 @@ export interface CallDeps {
   isMicBusy: () => boolean;
   onBusy: (busy: boolean) => void;
   socketFactory?: (url: string, protocol: string) => WebSocket;
-  audioFactory?: (capture: (pcm: ArrayBuffer) => void, admitted: (sequence: number) => void,
+  audioFactory?: (capture: (pcm: ArrayBuffer, lease: number) => void, admitted: (sequence: number) => void,
     failed: () => void) => CallAudioHandle;
 }
 
@@ -36,8 +37,8 @@ export function createCallController(deps: CallDeps) {
     if (!targets.value || deps.isMicBusy() || callId) return;
     if (!activateAudio()) return;
     deps.onBusy(true);
-    pendingInvite = true;
-    if (!send({ type: "invite", requestId: crypto.randomUUID(), targetConnectionId: targets.value })) {
+    outgoingRequest = crypto.randomUUID();
+    if (!send({ type: "invite", requestId: outgoingRequest, targetConnectionId: targets.value })) {
       end("Calls unavailable");
       return;
     }
@@ -75,14 +76,13 @@ export function createCallController(deps: CallDeps) {
   let lastPulse = win.performance.now();
   let lastMessage = lastPulse;
   let sequence = 0;
-  let captureLease = 0;
-  let captureLeaseAt = 0;
   let playoutId = 0;
   let leases = new Map<number, { at: number; until: number }>();
   let muted = false;
   let backlogAt: number | null = null;
   let deadline = 0;
-  let pendingInvite = false;
+  // The one unanswered invite this tab sent; busy replies are matched to it.
+  let outgoingRequest: string | null = null;
   let callUntil = 0;
 
   function button(text: string, action: () => void): HTMLButtonElement {
@@ -96,7 +96,7 @@ export function createCallController(deps: CallDeps) {
     const inCall = callId !== null;
     targets.hidden = inCall;
     callButton.hidden = inCall;
-    callButton.disabled = pendingInvite || (socket?.readyState === 1 && targets.options.length === 0);
+    callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && targets.options.length === 0);
     acceptButton.hidden = state !== "incoming";
     acceptButton.disabled = deps.isMicBusy();
     muteButton.hidden = state !== "connected";
@@ -117,11 +117,10 @@ export function createCallController(deps: CallDeps) {
     releaseCall?.();
     releaseCall = null;
     callId = null;
-    pendingInvite = false;
+    outgoingRequest = null;
     callUntil = 0;
     state = "idle";
     muted = false;
-    captureLease = 0;
     sequence = 0;
     playoutId = 0;
     leases.clear();
@@ -132,7 +131,7 @@ export function createCallController(deps: CallDeps) {
   }
   function end(message: string): void {
     const endedId = callId;
-    const wasPending = pendingInvite;
+    const wasPending = outgoingRequest !== null;
     const action = state === "incoming" ? "decline" : "end";
     teardownCall(message); // Stop locally before best-effort network activity.
     if (endedId) send({ type: action, callId: endedId });
@@ -140,22 +139,22 @@ export function createCallController(deps: CallDeps) {
   }
   function activateAudio(): boolean {
     if (deps.isMicBusy()) return false;
+    audio?.stop(); // Never orphan an earlier attempt's context.
     const attemptEpoch = ++callEpoch;
     try {
       audio = (deps.audioFactory ?? ((capture, ack, fail) => new CallAudio(capture, ack, fail)))(
-        (pcm) => {
+        (pcm, lease) => {
           if (attemptEpoch !== callEpoch) return;
           if (state !== "connected" || !callId || muted || !socket || socket.readyState !== 1) return;
           const now = win.performance.now();
           if (now - lastPulse > LEASE_MS) { end("Call interrupted"); return; }
-          if (!captureLease || now - captureLeaseAt > LEASE_MS) return;
           if (socket.bufferedAmount > 8192) {
             backlogAt ??= now;
             if (now - backlogAt > 250) end("Connection too slow");
             return;
           }
           backlogAt = null;
-          socket.send(encodeFrame(callId, sequence++, captureLease, pcm));
+          socket.send(encodeFrame(callId, sequence++, lease, pcm));
         },
         (seq) => { if (attemptEpoch === callEpoch && state === "connected" && callId) send({ type: "ack", callId, sequence: seq }); },
         () => { if (attemptEpoch === callEpoch) end("Audio unavailable"); },
@@ -236,13 +235,22 @@ export function createCallController(deps: CallDeps) {
       if (Array.from(targets.options).some((o) => o.value === selected)) targets.value = selected;
     } else if (m["type"] === "incoming" || m["type"] === "outgoing") {
       if (callId || typeof m["callId"] !== "string") throw new Error("Invalid invite");
+      if (m["type"] === "incoming" && outgoingRequest !== null) {
+        // A crossing invite lost to this one. Release only that attempt's audio; keep the
+        // request id so its busy reply is recognised. Answer still needs its own gesture.
+        callEpoch++;
+        audio?.stop();
+        audio = null;
+        deps.onBusy(false);
+      } else outgoingRequest = null;
       callId = m["callId"];
-      pendingInvite = false;
       state = m["type"];
       callUntil = win.performance.now() + 30_000;
       status.textContent = state === "incoming" ? `Incoming call from ${String(m["peer"]).slice(0, 32)}` : "Calling…";
     } else if (m["type"] === "unavailable") {
-      teardownCall("That person is unavailable");
+      if (outgoingRequest === null || m["requestId"] !== outgoingRequest) return;
+      outgoingRequest = null;
+      if (callId === null) teardownCall("That person is unavailable");
     } else if (m["callId"] !== callId || !callId) {
       return; // Late terminal/readiness messages cannot revive a canceled attempt.
     } else if (m["type"] === "prepare" && (state === "outgoing" || state === "incoming")) {
@@ -254,9 +262,8 @@ export function createCallController(deps: CallDeps) {
       releaseCall = hooks.suspend("voiceCall");
       status.textContent = "On a voice call";
       pulse();
-    } else if (m["type"] === "capture" && typeof m["lease"] === "number") {
-      captureLease = m["lease"];
-      captureLeaseAt = win.performance.now();
+    } else if (m["type"] === "capture" && typeof m["lease"] === "number" && state === "connected") {
+      audio?.captureLease(m["lease"]);
     } else if (m["type"] === "ended") {
       teardownCall("Call ended");
     }
diff --git a/admin-ui/src/server/call/worklet.ts b/admin-ui/src/server/call/worklet.ts
index be73a72..5e21738 100644
--- a/admin-ui/src/server/call/worklet.ts
+++ b/admin-ui/src/server/call/worklet.ts
@@ -16,6 +16,12 @@ class CallAudioProcessor extends AudioWorkletProcessor {
   private alpha = 1 - Math.exp(-2 * Math.PI * 10_000 / sampleRate);
   private enabled = false;
   private leaseUntil = 0;
+  private captureLease = 0;
+  private captureUntil = 0;
+  private generation = 0;
+  // Provenance of the buffer being filled, bound at its first sample.
+  private bufferLease = 0;
+  private bufferAt = 0;
   private ring = new Float32Array(4800);
   private deadlines = new Float64Array(4800);
   private read = 0;
@@ -29,11 +35,15 @@ class CallAudioProcessor extends AudioWorkletProcessor {
       const data = event.data;
       if (data["type"] === "buffer" && data["pcm"] instanceof ArrayBuffer) {
         if (this.pool.length < 5 && data["pcm"].byteLength === 960) this.pool.push(data["pcm"]);
-      } else if (data["type"] === "enabled") {
+      } else if (data["type"] === "state" && typeof data["seq"] === "number"
+        && typeof data["playUntil"] === "number" && typeof data["captureLease"] === "number"
+        && typeof data["captureUntil"] === "number" && typeof data["generation"] === "number") {
+        this.leaseUntil = data["playUntil"];
+        this.captureLease = data["captureLease"];
+        this.captureUntil = data["captureUntil"];
         this.enabled = data["enabled"] === true;
-        this.captured = 0;
-      } else if (data["type"] === "lease" && typeof data["until"] === "number") {
-        this.leaseUntil = data["until"];
+        if (data["generation"] !== this.generation) { this.generation = data["generation"]; this.captured = 0; }
+        this.port.postMessage({ type: "state", seq: data["seq"] });
       } else if (data["type"] === "play" && data["pcm"] instanceof ArrayBuffer
         && typeof data["until"] === "number" && typeof data["sequence"] === "number") {
         const pcm = new DataView(data["pcm"]);
@@ -50,6 +60,7 @@ class CallAudioProcessor extends AudioWorkletProcessor {
       } else if (data["type"] === "stop") {
         this.enabled = false;
         this.leaseUntil = 0;
+        this.captureUntil = 0;
         this.flush();
         this.port.close();
       }
@@ -60,7 +71,7 @@ class CallAudioProcessor extends AudioWorkletProcessor {
 
   process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
     const input = inputs[0]?.[0];
-    if (input !== undefined && this.enabled && currentTime < this.leaseUntil) {
+    if (input !== undefined && this.enabled && this.captureLease > 0 && currentTime < this.captureUntil) {
       for (const value of input) {
         // Bounded low-pass plus fractional-rate interpolation; native contexts may
         // run at 44.1 or 48 kHz regardless of getUserMedia's sample-rate preference.
@@ -73,12 +84,14 @@ class CallAudioProcessor extends AudioWorkletProcessor {
             if (buffer !== undefined) this.capture = new DataView(buffer);
           }
           if (this.capture !== null) {
+            if (this.captured === 0) { this.bufferLease = this.captureLease; this.bufferAt = currentTime; }
             const fraction = 1 - this.capturePhase * sampleRate / 24_000;
             const sample = this.previous + Math.max(0, Math.min(1, fraction)) * (this.low - this.previous);
             this.capture.setInt16(this.captured * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true);
             if (++this.captured === 480) {
               const pcm = this.capture.buffer as ArrayBuffer;
-              this.port.postMessage({ type: "capture", pcm }, [pcm]);
+              this.port.postMessage({ type: "capture", pcm, lease: this.bufferLease,
+                generation: this.generation, at: this.bufferAt }, [pcm]);
               this.capture = null;
               this.captured = 0;
             }
diff --git a/wixy_server/livechat/call_broker.py b/wixy_server/livechat/call_broker.py
index ca8993f..96507e4 100644
--- a/wixy_server/livechat/call_broker.py
+++ b/wixy_server/livechat/call_broker.py
@@ -7,9 +7,14 @@ the route's bounded workers, never inside these state transitions.
 from __future__ import annotations
 
 import asyncio
+import functools
+import threading
 import time
 from collections import deque
+from collections.abc import Callable
+from concurrent.futures import ThreadPoolExecutor
 from dataclasses import dataclass, field
+from typing import Concatenate
 from uuid import uuid4
 
 from builder.jsontypes import JsonObject
@@ -27,6 +32,32 @@ from wixy_server.livechat.call_protocol import (
 )
 from wixy_server.livechat.tokens import ServerAuth
 
+# 4 pending auth sockets + 8 connections, each awaiting at most one synchronous job.
+WORK_CAP = 12
+
+
+class CallCapacityError(RuntimeError):
+    """Synchronous auth/grant work is at its fixed cap; fail closed without locking."""
+
+
+def transition[**P, R](
+    method: Callable[Concatenate[CallBroker, P], R],
+) -> Callable[Concatenate[CallBroker, P], R]:
+    """Queue overflow only marks a peer; membership changes after the outermost step."""
+
+    @functools.wraps(method)
+    def wrapper(self: CallBroker, /, *args: P.args, **kwargs: P.kwargs) -> R:
+        self.depth += 1
+        try:
+            return method(self, *args, **kwargs)
+        finally:
+            if self.depth == 1:
+                while self.evicting:
+                    self.drop(self.evicting.popleft())
+            self.depth -= 1
+
+    return wrapper
+
 
 @dataclass
 class Budget:
@@ -97,16 +128,48 @@ class CallBroker:
         self.connections = 0
         # Bounded identity table; do not evict live rate limits under a flood.
         self.admissions: dict[str, Budget] = {}
+        self.depth = 0
+        self.evicting: deque[Peer] = deque()
+        # Started-or-queued synchronous jobs. A permit is released by the job itself,
+        # never by its awaiter's cancellation, so abandoned threads stay counted.
+        self.work = 0
+        self.work_lock = threading.Lock()
+        self.executor = ThreadPoolExecutor(WORK_CAP, thread_name_prefix="wixy-call")
 
+    async def offload[T](self, job: Callable[[], T]) -> T:
+        with self.work_lock:
+            if self.closed or self.work >= WORK_CAP:
+                raise CallCapacityError("call work capacity")
+            self.work += 1
+        try:
+            future = self.executor.submit(job)
+        except BaseException:
+            self.finished_work(None)
+            raise
+        future.add_done_callback(self.finished_work)
+        # Cancelling this await cancels only a not-yet-started job; a running one keeps
+        # its permit until it actually returns.
+        return await asyncio.wrap_future(future)
+
+    def finished_work(self, _future: object) -> None:
+        with self.work_lock:
+            self.work -= 1
+
+    @transition
     def emit(self, peer: Peer, message: JsonObject) -> None:
         if peer.closed:
             return
         if len(peer.controls) >= 16:
-            self.remove(peer)
+            # Fail this socket now; unlink it once the enclosing transition completes.
+            peer.closed = True
+            peer.controls.clear()
+            peer.wake.set()
+            self.evicting.append(peer)
             return
         peer.controls.append(message)
         peer.wake.set()
 
+    @transition
     def add(self, peer: Peer) -> bool:
         now = time.monotonic()
         if self.closed or len(self.peers) >= 8:
@@ -126,6 +189,7 @@ class CallBroker:
         self.presence()
         return True
 
+    @transition
     def presence(self) -> None:
         busy = (self.call.caller, self.call.callee) if self.call else ()
         for peer in list(self.peers.values()):
@@ -149,6 +213,7 @@ class CallBroker:
             and time.monotonic() < peer.grant_until
         )
 
+    @transition
     def finish(self, reason: str) -> None:
         call, self.call = self.call, None
         if call is None:
@@ -166,7 +231,11 @@ class CallBroker:
                 self.emit(peer, {"type": "ended", "callId": call.id, "reason": reason})
         self.presence()
 
+    @transition
     def remove(self, peer: Peer) -> None:
+        self.drop(peer)
+
+    def drop(self, peer: Peer) -> None:
         if self.peers.get(peer.id) is not peer:
             peer.closed = True
             peer.wake.set()
@@ -180,12 +249,17 @@ class CallBroker:
         peer.wake.set()
         self.presence()
 
+    @transition
     def shutdown(self) -> None:
         self.closed = True
         self.finish("unavailable")
         for peer in list(self.peers.values()):
             self.remove(peer)
+        # Queued jobs are cancelled; running synchronous calls cannot be interrupted
+        # and keep their permits until they return.
+        self.executor.shutdown(wait=False, cancel_futures=True)
 
+    @transition
     def command(self, peer: Peer, command: Command) -> None:
         now = time.monotonic()
         if not self.permitted(peer) or not peer.controls_budget.take(now):
@@ -208,7 +282,8 @@ class CallBroker:
                 or not self.permitted(target_peer)
                 or not peer.invites_budget.take(now)
             ):
-                self.emit(peer, {"type": "unavailable"})
+                # Correlated, so a crossing caller's loss never erases its incoming call.
+                self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
                 return
             invited = self.call = Call(peer.id, target_peer.id)
             self.emit(peer, {"type": "outgoing", "callId": invited.id, "peer": target_peer.label})
@@ -264,6 +339,7 @@ class CallBroker:
         assert self.call and self.call.contains(peer)
         return self.peers[self.call.callee if peer.id == self.call.caller else self.call.caller]
 
+    @transition
     def frame(self, peer: Peer, data: bytes) -> None:
         now = time.monotonic()
         epoch, seq, sample, lease = unpack_frame(data)
@@ -308,6 +384,7 @@ class CallBroker:
             return data
         return None
 
+    @transition
     def tick(self, peer: Peer) -> None:
         now = time.monotonic()
         if not self.permitted(peer) or now - peer.pong_at > 6:
diff --git a/wixy_server/livechat/tokens.py b/wixy_server/livechat/tokens.py
index 7472140..44cbee7 100644
--- a/wixy_server/livechat/tokens.py
+++ b/wixy_server/livechat/tokens.py
@@ -24,6 +24,7 @@ import json
 import os
 import secrets
 import time
+from collections.abc import Awaitable, Callable
 from dataclasses import dataclass
 from pathlib import Path
 from typing import TYPE_CHECKING, NamedTuple
@@ -231,16 +232,24 @@ async def require_server_token(request: Request) -> ServerAuth:
 
 
 async def validate_server_token(
-    token: str, *, email: str, secret: bytes, store: LiveChatStore
+    token: str,
+    *,
+    email: str,
+    secret: bytes,
+    store: LiveChatStore,
+    offload: Callable[[Callable[[], bool]], Awaitable[bool]] = anyio.to_thread.run_sync,
 ) -> ServerAuth:
-    """Shared HTTP/WS gate, including revocation of device-bound credentials."""
+    """Shared HTTP/WS gate, including revocation of device-bound credentials.
+
+    Calls pass the broker's job-owned `offload`, so a cancelled awaiter cannot free
+    accounting while the synchronous grant lookup still runs."""
     try:
         auth = verify_unlock_token(secret, token, email=email, now=time.time())
     except InvalidTokenError:
         raise _locked_401() from None
     grant_id = auth.grant_id
     if grant_id is not None:
-        live = await anyio.to_thread.run_sync(
+        live = await offload(
             lambda: store.is_device_grant_live(
                 grant_id=grant_id,
                 email=auth.email,
diff --git a/wixy_server/routes_livechat_calls.py b/wixy_server/routes_livechat_calls.py
index 5cd146f..26236b1 100644
--- a/wixy_server/routes_livechat_calls.py
+++ b/wixy_server/routes_livechat_calls.py
@@ -7,13 +7,12 @@ import math
 import time
 from typing import Any
 
-import anyio
 import httpx
 from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
 from pydantic import ValidationError
 
 from wixy_server.auth import AccessVerificationError
-from wixy_server.livechat.call_broker import CallBroker, Peer
+from wixy_server.livechat.call_broker import CallBroker, CallCapacityError, Peer
 from wixy_server.livechat.call_protocol import COMMAND, PROTOCOL, Authenticate
 from wixy_server.livechat.grants import GRANT_IDLE_EXPIRY_S
 from wixy_server.livechat.store import LiveChatStore
@@ -34,7 +33,9 @@ def upgrade_allowed(ws: WebSocket, origins: frozenset[str]) -> bool:
     )
 
 
-async def access_identity(ws: WebSocket, settings: Settings) -> tuple[str, float]:
+async def access_identity(
+    ws: WebSocket, settings: Settings, broker: CallBroker
+) -> tuple[str, float]:
     if settings.dev_no_auth:
         # Same explicit development-only bypass as HTTP; never enabled in production.
         return ws.headers.get("cf-access-authenticated-user-email", ""), time.time() + 43200
@@ -42,7 +43,7 @@ async def access_identity(ws: WebSocket, settings: Settings) -> tuple[str, float
     if not token:
         raise ValueError("access")
     verify = ws.app.state.call_access_verifier
-    claims: dict[str, Any] = await anyio.to_thread.run_sync(lambda: verify(token))
+    claims: dict[str, Any] = await broker.offload(lambda: verify(token))
     email, exp = claims.get("email"), claims.get("exp")
     if (
         not isinstance(email, str)
@@ -103,7 +104,7 @@ async def run_peer(ws: WebSocket, broker: CallBroker, peer: Peer, store: LiveCha
         if peer.auth.grant_id is None:
             await asyncio.Future[None]()
         while not peer.closed:
-            live = await anyio.to_thread.run_sync(
+            live = await broker.offload(
                 lambda: store.is_device_grant_live(
                     grant_id=peer.auth.grant_id or "",
                     email=peer.auth.email,
@@ -150,9 +151,9 @@ async def calls_socket(ws: WebSocket) -> None:
     close_code = 4401
     try:
         settings: Settings = ws.app.state.settings
-        # The pending admission cap is held until off-thread verification finishes,
-        # including cancellation; do not abandon threads and silently free the cap.
-        email, access_exp = await access_identity(ws, settings)
+        # Socket slots bound sockets; broker.offload separately bounds the synchronous
+        # verifier/grant jobs, which outlive a cancelled or timed-out awaiter.
+        email, access_exp = await access_identity(ws, settings, broker)
         await ws.accept(subprotocol=PROTOCOL)
         accepted = True
         async with asyncio.timeout(5):
@@ -167,6 +168,7 @@ async def calls_socket(ws: WebSocket) -> None:
                 email=email,
                 secret=ws.app.state.livechat_secret,
                 store=store,
+                offload=broker.offload,
             )
         peer = Peer(auth, auth_frame.label.strip() or "Device", min(auth.exp, access_exp))
         del auth_frame, packet, text
@@ -184,6 +186,8 @@ async def calls_socket(ws: WebSocket) -> None:
         close_code = (
             4401 if time.time() >= peer.deadline or time.monotonic() >= peer.grant_until else 1000
         )
+    except CallCapacityError:
+        close_code = 4429  # Server busy, not an authorization failure: never lock.
     except (
         AccessVerificationError,
         HTTPException,
```

## Appendix B — red/green test files (new + migrated)

```diff
diff --git a/admin-ui/tests/server/call.test.ts b/admin-ui/tests/server/call.test.ts
index 37d029d..06fdf7a 100644
--- a/admin-ui/tests/server/call.test.ts
+++ b/admin-ui/tests/server/call.test.ts
@@ -23,7 +23,7 @@ function setup(prepare: () => Promise<void> = async () => {}) {
   const releases: { reason: string; release: ReturnType<typeof vi.fn> }[] = [];
   const audio: CallAudioHandle = {
     prepare: vi.fn(prepare), start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
-    lease: () => 0.3, play: vi.fn(),
+    lease: () => 0.3, play: vi.fn(), captureLease: vi.fn(),
   };
   const lock = vi.fn();
   const controller = createCallController({ win: window, isMicBusy: () => false, onBusy: vi.fn(),
diff --git a/admin-ui/tests/server/callRepairs.test.ts b/admin-ui/tests/server/callRepairs.test.ts
new file mode 100644
index 0000000..3b066e9
--- /dev/null
+++ b/admin-ui/tests/server/callRepairs.test.ts
@@ -0,0 +1,166 @@
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
+import { createCallController, type CallAudioHandle } from "../../src/server/call/controller";
+import { CallAudio } from "../../src/server/call/audio";
+
+class Socket {
+  readyState = 1;
+  bufferedAmount = 0;
+  binaryType = "";
+  onopen: (() => void) | null = null;
+  onmessage: ((event: { data: unknown }) => void) | null = null;
+  onclose: ((event: { code: number }) => void) | null = null;
+  onerror: (() => void) | null = null;
+  sent: (string | ArrayBuffer)[] = [];
+  send(data: string | ArrayBuffer) { this.sent.push(data); }
+  close = vi.fn();
+  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
+}
+const ID = "a".repeat(32);
+const TARGET = "b".repeat(32);
+type Factory = NonNullable<Parameters<typeof createCallController>[0]["audioFactory"]>;
+
+function setup() {
+  const socket = new Socket();
+  let capture: ((pcm: ArrayBuffer, lease: number) => void) | null = null;
+  const audio = {
+    prepare: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
+    lease: () => 0.3, play: vi.fn(), captureLease: vi.fn(),
+  } as unknown as CallAudioHandle;
+  const factory = vi.fn((c: (pcm: ArrayBuffer, lease: number) => void) => { capture = c; return audio; });
+  const controller = createCallController({ win: window, isMicBusy: () => false, onBusy: vi.fn(),
+    hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
+    socketFactory: () => socket as unknown as WebSocket,
+    audioFactory: factory as unknown as Factory,
+  });
+  controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
+  socket.onopen?.();
+  socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
+  socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
+  const click = (text: string) => {
+    const button = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === text && !b.hidden);
+    if (!button) throw new Error(`Missing ${text}`);
+    button.click();
+  };
+  const controls = () => socket.sent.filter((s): s is string => typeof s === "string")
+    .map((s) => JSON.parse(s) as Record<string, unknown>);
+  const answer = () => [...controller.element.querySelectorAll("button")].find((b) => b.textContent === "Answer");
+  return { controller, socket, audio, factory, click, controls, answer, capture: () => capture };
+}
+
+beforeEach(() => vi.useFakeTimers());
+afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
+
+describe("M3 crossing invitations", () => {
+  it("keeps the winning incoming call when the crossing outgoing request is refused", () => {
+    const f = setup();
+    f.click("Call");
+    const invite = f.controls().find((m) => m["type"] === "invite");
+    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
+    f.socket.receive({ type: "unavailable", requestId: invite?.["requestId"] });
+    expect(f.controller.element.textContent).toContain("Incoming call from B");
+    expect(f.answer()?.hidden).toBe(false);
+    f.click("Answer");
+    expect(f.controls().at(-1)).toEqual({ type: "accept", callId: ID });
+    expect(f.audio.stop).toHaveBeenCalledTimes(1); // only the losing attempt's audio
+    f.controller.dispose();
+  });
+  it("ignores a refusal for another request; still tears down its own refusal", () => {
+    const f = setup();
+    f.click("Call");
+    const invite = f.controls().find((m) => m["type"] === "invite");
+    f.socket.receive({ type: "unavailable", requestId: "older" });
+    expect(f.controller.element.textContent).not.toContain("unavailable");
+    f.socket.receive({ type: "unavailable", requestId: invite?.["requestId"] });
+    expect(f.controller.element.textContent).toContain("That person is unavailable");
+    f.controller.dispose();
+  });
+  it("a decline before the crossing refusal arrives is not revived or re-ended by it", () => {
+    const f = setup();
+    f.click("Call");
+    const invite = f.controls().find((m) => m["type"] === "invite");
+    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
+    f.click("Decline");
+    f.socket.receive({ type: "unavailable", requestId: invite?.["requestId"] });
+    expect(f.controls().at(-1)).toEqual({ type: "decline", callId: ID });
+    expect(f.answer()?.hidden).toBe(true);
+    expect(f.controller.element.textContent).not.toContain("unavailable");
+    f.controller.dispose();
+  });
+});
+
+describe("M1 capture provenance", () => {
+  it("sends the lease bound when samples were produced, never the newest one", async () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "outgoing", callId: ID, peer: "B" });
+    f.socket.receive({ type: "prepare", callId: ID });
+    await Promise.resolve();
+    f.socket.receive({ type: "connected", callId: ID });
+    f.socket.receive({ type: "capture", callId: ID, lease: 1 });
+    f.socket.receive({ type: "capture", callId: ID, lease: 2 });
+    f.capture()?.(new ArrayBuffer(960), 1);
+    const frames = f.socket.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
+    expect(frames.map((b) => new DataView(b).getUint32(32))).toEqual([1]);
+    f.controller.dispose();
+  });
+});
+
+function stubGraph() {
+  const posted: Record<string, unknown>[] = [];
+  const port = { onmessage: null as ((e: { data: Record<string, unknown> }) => void) | null,
+    postMessage: (m: Record<string, unknown>) => posted.push(m), close: vi.fn() };
+  const context = { state: "running", currentTime: 0, resume: async () => {}, close: async () => {},
+    audioWorklet: { addModule: async () => {} }, destination: {},
+    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }), onstatechange: null };
+  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
+  vi.stubGlobal("AudioWorkletNode", class { port = port; connect = vi.fn(); disconnect = vi.fn(); onprocessorerror = null; });
+  const track = { readyState: "live", enabled: true, stop: vi.fn(), addEventListener: vi.fn() };
+  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
+  return { posted, port, context };
+}
+
+describe("M4 worklet control bound", () => {
+  it("keeps one coalesced control in flight and fails a graph that stops acknowledging", async () => {
+    const g = stubGraph();
+    const failed = vi.fn();
+    const audio = new CallAudio(vi.fn(), vi.fn(), failed);
+    await audio.prepare();
+    audio.start();
+    audio.setMuted(true); // muted calls still pulse leases; no media acknowledgement exists
+    for (let i = 0; i < 10_000; i++) audio.lease();
+    const controls = g.posted.filter((m) => m["type"] !== "buffer" && m["type"] !== "play");
+    expect(controls.length).toBeLessThanOrEqual(1);
+    expect(failed).not.toHaveBeenCalled();
+    vi.advanceTimersByTime(301);
+    audio.lease();
+    expect(failed).toHaveBeenCalledTimes(1);
+  });
+  it("sends the newest coalesced state after acknowledgement", async () => {
+    const g = stubGraph();
+    const audio = new CallAudio(vi.fn(), vi.fn(), vi.fn());
+    await audio.prepare();
+    audio.start();
+    audio.captureLease(7);
+    audio.setMuted(true);
+    const first = g.posted.filter((m) => m["type"] === "state");
+    expect(first).toHaveLength(1);
+    g.port.onmessage?.({ data: { type: "state", seq: first[0]?.["seq"] } });
+    const last = g.posted.filter((m) => m["type"] === "state").at(-1);
+    expect(last).toMatchObject({ captureLease: 7, enabled: false });
+  });
+  it("drops capture from an old mute generation or older than its lease, and recycles it", async () => {
+    const g = stubGraph();
+    const captured = vi.fn();
+    const audio = new CallAudio(captured, vi.fn(), vi.fn());
+    await audio.prepare();
+    audio.start();
+    const state = g.posted.filter((m) => m["type"] === "state").at(-1);
+    const generation = state?.["generation"];
+    g.context.currentTime = 1;
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, generation, at: 0.5 } });
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, generation: -1, at: 0.9 } });
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, generation, at: 0.9 } });
+    expect(captured.mock.calls.map((c) => c[1])).toEqual([3]);
+    expect(g.posted.filter((m) => m["type"] === "buffer")).toHaveLength(8);
+  });
+});
diff --git a/admin-ui/tests/server/callWorklet.test.ts b/admin-ui/tests/server/callWorklet.test.ts
index ad5b583..124f6d3 100644
--- a/admin-ui/tests/server/callWorklet.test.ts
+++ b/admin-ui/tests/server/callWorklet.test.ts
@@ -25,8 +25,7 @@ describe("bounded call audio worklet", () => {
   it.each([44_100, 48_000])("resamples a 440 Hz tone from %s Hz and caps capture at five transferred frames", async (rate) => {
     const { node, sent, message } = await processor(rate);
     for (let i = 0; i < 5; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
-    message({ type: "lease", until: 0.3 });
-    message({ type: "enabled", enabled: true });
+    message({ type: "state", seq: 1, playUntil: 0.3, captureLease: 1, captureUntil: 0.3, enabled: true, generation: 1 });
     const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate) * 0.5);
     node.process([[input]], [[new Float32Array(128)]]);
     const frames = sent.filter((m) => m["type"] === "capture");
@@ -42,7 +41,7 @@ describe("bounded call audio worklet", () => {
 
   it("silences expired playout when the main thread never sends stop", async () => {
     const { node, message } = await processor(48_000);
-    message({ type: "lease", until: 0.3 });
+    message({ type: "state", seq: 1, playUntil: 0.3, captureLease: 1, captureUntil: 0.3, enabled: true, generation: 1 });
     for (let sequence = 0; sequence < 3; sequence++) {
       const pcm = new ArrayBuffer(960);
       const view = new DataView(pcm);
@@ -55,8 +54,24 @@ describe("bounded call audio worklet", () => {
     vi.stubGlobal("currentTime", 0.31);
     node.process([], [[output]]);
     expect(output.every((value) => value === 0)).toBe(true);
-    message({ type: "lease", until: 0.61 });
+    message({ type: "state", seq: 2, playUntil: 0.61, captureLease: 2, captureUntil: 0.61, enabled: false, generation: 1 });
     node.process([], [[output]]);
     expect(output.every((value) => value === 0)).toBe(true);
   });
+
+  it("binds lease, generation and time at sample production; a later lease never relabels", async () => {
+    const { node, sent, message } = await processor(48_000);
+    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
+    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, generation: 4 });
+    node.process([[new Float32Array(480)]], [[new Float32Array(128)]]); // half of buffer one, lease 1
+    message({ type: "state", seq: 2, playUntil: 1, captureLease: 2, captureUntil: 1, enabled: true, generation: 4 });
+    node.process([[new Float32Array(1440)]], [[new Float32Array(128)]]);
+    const frames = sent.filter((m) => m["type"] === "capture");
+    expect(frames.map((m) => [m["lease"], m["generation"]])).toEqual([[1, 4], [2, 4]]);
+    expect(sent.filter((m) => m["type"] === "state").map((m) => m["seq"])).toEqual([1, 2]);
+    message({ type: "state", seq: 3, playUntil: 1, captureLease: 2, captureUntil: 0, enabled: true, generation: 4 });
+    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
+    node.process([[new Float32Array(1920)]], [[new Float32Array(128)]]);
+    expect(sent.filter((m) => m["type"] === "capture")).toHaveLength(2); // expired capture lease: no samples
+  });
 });
diff --git a/wixy_server/tests/test_livechat_call_repairs.py b/wixy_server/tests/test_livechat_call_repairs.py
new file mode 100644
index 0000000..01faa73
--- /dev/null
+++ b/wixy_server/tests/test_livechat_call_repairs.py
@@ -0,0 +1,170 @@
+"""Round-1 repair discriminators: H1 worker bound, M2 overflow reentrancy, M3 busy correlation."""
+
+from __future__ import annotations
+
+import asyncio
+import json
+import threading
+import time
+from types import SimpleNamespace
+from typing import Any
+
+import pytest
+
+from wixy_server.livechat.call_broker import CallBroker, Peer
+from wixy_server.livechat.call_protocol import PROTOCOL, CallAction, Invite
+from wixy_server.livechat.tokens import ServerAuth, mint_unlock_token
+from wixy_server.routes_livechat_calls import calls_socket
+
+ORIGIN = "https://example.test"
+EMAIL = "admin@example.test"
+SECRET = b"s" * 32
+
+
+class BlockedStore:
+    def __init__(self) -> None:
+        self.release = threading.Event()
+        self.entered = 0
+        self.live = 0
+        self.lock = threading.Lock()
+
+    def is_device_grant_live(self, **_: Any) -> bool:
+        with self.lock:
+            self.entered += 1
+            self.live += 1
+        self.release.wait(10)
+        with self.lock:
+            self.live -= 1
+        return True
+
+
+class FakeSocket:
+    def __init__(self, app: Any, token: str) -> None:
+        self.app = app
+        self.scope: dict[str, Any] = {"query_string": b"", "subprotocols": [PROTOCOL]}
+        self.headers = _Headers({"origin": ORIGIN, "cf-access-authenticated-user-email": EMAIL})
+        self.token = token
+        self.closed: int | None = None
+
+    async def accept(self, subprotocol: str | None = None) -> None:
+        return None
+
+    async def receive(self) -> dict[str, Any]:
+        text = json.dumps({"type": "auth", "v": 1, "token": self.token, "label": "X"})
+        return {"type": "websocket.receive", "text": text}
+
+    async def close(self, code: int = 1000) -> None:
+        self.closed = code
+
+
+class _Headers(dict[str, str]):
+    def getlist(self, key: str) -> list[str]:
+        return [self[key]] if key in self else []
+
+
+def _token() -> str:
+    token, _ = mint_unlock_token(SECRET, email=EMAIL, ttl_s=300, now=time.time(), grant_id="a" * 32)
+    return token
+
+
+def test_cancelled_auth_cannot_orphan_unbounded_grant_workers() -> None:
+    store = BlockedStore()
+    broker = CallBroker()
+    app = SimpleNamespace(
+        state=SimpleNamespace(
+            livechat_call_broker=broker,
+            call_origins=frozenset({ORIGIN}),
+            settings=SimpleNamespace(dev_no_auth=True),
+            livechat_store=store,
+            livechat_secret=SECRET,
+        )
+    )
+    token = _token()
+
+    async def batches() -> list[int | None]:
+        codes: list[int | None] = []
+        for _ in range(5):
+            sockets = [FakeSocket(app, token) for _ in range(4)]
+            tasks = [asyncio.create_task(calls_socket(s)) for s in sockets]  # type: ignore[arg-type]
+            await asyncio.sleep(0.2)
+            for task in tasks:  # Native cancellation, as a timeout/shutdown would deliver.
+                task.cancel()
+            await asyncio.gather(*tasks, return_exceptions=True)
+            assert broker.pending == 0
+            codes.extend(s.closed for s in sockets)
+        return codes
+
+    try:
+        codes = asyncio.run(batches())
+        # 20 cancelled auths; actual synchronous workers never exceed the fixed cap.
+        assert store.live <= 12, store.live
+        assert store.entered <= 12, store.entered
+        assert 4429 in codes
+    finally:
+        store.release.set()
+    deadline = time.monotonic() + 5
+    while store.live and time.monotonic() < deadline:
+        time.sleep(0.01)
+    assert store.live == 0
+    assert getattr(broker, "work", 0) == 0
+
+
+def _peers() -> tuple[CallBroker, Peer, Peer]:
+    broker = CallBroker()
+    auth = ServerAuth(EMAIL, int(time.time() + 300))
+    a, b = (Peer(auth, label, time.time() + 300) for label in "AB")
+    assert broker.add(a) and broker.add(b)
+    return broker, a, b
+
+
+@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 14), (16, 0), (0, 16)])
+def test_accept_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None:
+    broker, a, b = _peers()
+    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
+    assert broker.call
+    epoch = broker.call.id
+    for peer, fill in ((a, fill_a), (b, fill_b)):
+        peer.controls.clear()
+        for _ in range(fill):
+            peer.controls.append({"type": "ping"})
+    broker.command(b, CallAction(type="accept", callId=epoch))
+    assert broker.call is None
+    assert a.closed is (fill_a == 16) and b.closed is (fill_b >= 14)
+    for peer in (a, b):
+        stale = [m for m in peer.controls if m.get("callId") == epoch and m["type"] != "ended"]
+        assert not stale
+        if not peer.closed:
+            assert any(
+                m == {"type": "ended", "callId": epoch, "reason": "disconnected"}
+                for m in peer.controls
+            )
+
+
+def test_connected_and_presence_overflow_are_clean_transitions() -> None:
+    broker, a, b = _peers()
+    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
+    assert broker.call
+    epoch = broker.call.id
+    broker.command(b, CallAction(type="accept", callId=epoch))
+    broker.command(a, CallAction(type="ready", callId=epoch))
+    a.controls.clear()
+    a.controls.extend({"type": "ping"} for _ in range(16))
+    broker.command(b, CallAction(type="ready", callId=epoch))
+    assert broker.call is None and a.closed and not b.closed
+    assert not [m for m in b.controls if m.get("type") == "connected"]
+    b.controls.extend({"type": "ping"} for _ in range(16 - len(b.controls)))
+    auth = ServerAuth(EMAIL, int(time.time() + 300))
+    c = Peer(auth, "C", time.time() + 300)
+    assert broker.add(c)  # presence to the full peer evicts it; no KeyError.
+    assert b.closed and not c.closed and list(broker.peers) == [c.id]
+    broker.shutdown()
+    assert not broker.peers
+
+
+def test_busy_reply_is_correlated_to_its_request() -> None:
+    broker, a, b = _peers()
+    broker.command(a, Invite(type="invite", requestId="a-1", targetConnectionId=b.id))
+    broker.command(b, Invite(type="invite", requestId="b-1", targetConnectionId=a.id))
+    types = [m["type"] for m in b.controls]
+    assert "incoming" in types and types.index("incoming") < types.index("unavailable")
+    assert b.controls[-1] == {"type": "unavailable", "requestId": "b-1"}
```

Committed bundles were rebuilt locally (`wixy_server/static/admin/{admin.js,admin.js.map,call-worklet.js}`) and are not reproduced here; regenerate with `npm run build` after applying.
