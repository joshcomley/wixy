# Voice-call repair MERGE — Opus reviewer, round 1

MERGE phase per `voice-repair-round1-merge-brief.md`. I read both proposals in full from
the parent checkout: `voice-repair-proposal-astra.md` and `voice-repair-proposal-opus.md`.
The Opus file there is byte-identical to mine (checked with `cmp`). My own proposal had
no privilege: every mechanism below was chosen on a stated discriminator.

The trial integration lives only in my isolated checkout, detached at `74c9578`:
`D:\Servers\Cmd\Storage\clones\wixy__worktrees\00049__wixy_group-therapy-propose-reviewer-opus-for`.
Nothing was committed, pushed, merged or opened as a PR, and no agents were used. The
parent's checkout was read only. Appendix A is the complete merged source diff against
`74c9578`; Appendix B is the tests.

**Evidence labels.**
- **MEASURED-BLIND**: executed in phase 1, before I had read Astra's proposal.
- **MEASURED-KNOWING**: executed during this merge, after reading Astra, including tests
  aimed at her claims.
- **CITED**: taken from Astra's report without me re-running her artifacts.

I kept three levels of proof separate:
- **Component green**: a unit or broker test.
- **Integrated green (local, not in a browser)**: the real route, broker, controller and
  CallAudio code together, with stub sockets and stub audio graphs.
- **Device proof**: none. Every physical-device, tunnel, quality and Slots gate remains
  open.

## Verdict

**Converged on mechanism for all five findings.** Two splits remain. Each has a concrete
discriminator, and neither changes any acceptance test:
1. The H1 job owner (fixed executor versus retained AnyIO tasks). I selected the
   executor, on a measured discriminator.
2. The M2 boundary (deferred eviction versus per-pair epoch checks). Both pass every
   current discriminator. I selected deferred eviction on structural grounds, stated
   below.

None of the five diagnoses was rejected: both reviewers reproduced every one
independently.

Additional defects found while merging, all fixed in the merged candidate:
- A cancelled auth, an internal auth timeout and a slow (not revoked) grant refresh all
  closed with **4401**. That code makes the browser lock the chat, so a server-side stall
  locked the owner out.
  - The cancelled-auth case was MEASURED-BLIND red in phase 1: 20 routes, every one 4401.
  - The internal-timeout and slow-refresh cases on the candidate are read from source,
    not executed: `close_code` defaults to 4401, and the post-run expression yields 4401
    when `monotonic >= grant_until`.
- The merged candidate restricts 4401 to a validator refusal, an expired session, or a
  revocation the store actually confirmed.

## Measured results of the merged candidate (MEASURED-KNOWING unless marked)

| Discriminator | Result |
|---|---|
| 20 natively cancelled auths, store blocked (route-level) | **4 real workers**, admission permits 4, `pending == 0`, codes ⊆ {1001, 4429}, **no 4401**; permits return to 0 after release. Phase-1 red on the candidate: 20 workers, all 4401 (MEASURED-BLIND). |
| Internal 5 s auth timeout, 4 routes + 1 late | codes **[4408, 4408, 4408, 4408, 4429]**, 4 live workers, permits retained past the timeout |
| Slow refresh (store blocks after admission and the first refresh) | close **4408** (fail closed, no lock). Revoked refresh (store returns False): **4401** |
| Admission saturated by 4 cancelled blocked jobs | admission refuses; **refresh still runs**; refresh saturated (8) refuses; shutdown refuses new admission; all permits return to 0 |
| Job cancelled **before start** | its permit freed at once; the running job's permit kept until it returns |
| Process exit with one blocked job | **both** mechanisms hang the interpreter at exit (killed by a 6 s `timeout`, exit 124): ThreadPoolExecutor, and a retained `anyio.to_thread.run_sync` task. Neither design can kill native work. |
| AnyIO shared default thread limiter while 12 call jobs are blocked | retained AnyIO tasks: **12 of 40 borrowed**. Dedicated executor: **0 of 40**. |
| M2 overflow at invite (4 queue fills), accept (3 fills), second-ready, presence, shutdown | no exception, no leftover incoming/outgoing/prepare/connected, survivor gets `ended`. Phase-1 red on the candidate: `KeyError` plus leftover prepare and connected (MEASURED-BLIND). |
| M3 broker, both winner orders + third same-login socket | winner's `outgoing` carries its `requestId`; loser gets `incoming` queued before `unavailable{requestId}`; third socket gets only `presence`; accept still succeeds |
| M3 controller: incoming→busy, busy→incoming, Answer→late busy, Decline→late busy, other-request busy, opposite-role `outgoing` correlation | all pass. The losing Call graph is stopped exactly once; the Answer graph is never stopped; no automatic `accept`. Phase-1 red: teardown of the winning prompt (MEASURED-BLIND). |
| M1 controller: lease 1 frame delivered after lease 2 | wire lease **[1]**. Phase-1 red: `[2]` (MEASURED-BLIND). |
| M1 worklet: half buffer under lease 1, then lease 2 | buffer one keeps lease 1, buffer two gets lease 2; expired capture lease captures nothing; a mute revision discards the partial buffer and tags the next one with the new revision |
| M1 CallAudio: old revision, at > 300 ms age, future `at`, fresh | only the fresh buffer forwarded with its own lease; **all 4 buffers recycled** (5 initial + 4 = 9 buffer posts) |
| M4: start; 10,000 × (pulse + captureLease + mute toggle) with no render | **0 posts at start; exactly 1 control posted**; no receiver lease issued; mute applied to the track immediately; `onFailure` once at the first sync ≥ 300 ms. Phase-1 red: 10,002 posts (MEASURED-BLIND). |
| M4: ack from a port handler alone vs from `process()` | worklet posts **no ack** until a render quantum runs; then acks seq 1 |
| M4: rendered ack | one receiver lease, remaining in (0, 300] ms; the newest coalesced state (captureLease 7, enabled false) posted next; a same-`playUntil` ack issues no second lease |
| M4: late ack (≥ 300 ms) / stale ack after stop | late fails once; stale after stop revives nothing (no lease, no failure, one `stop` post) |
| Controller: pulses send no receiver lease until the graph acks; `remainingMs` 0 ends the call | pass |

Suites after the merge:
- `pytest -k "livechat_call or unlock or token or grant"`: **350 passed**. After that run
  I added the 10 s verifier timeout, then re-ran only the call route and broker files:
  **38 passed**.
- `mypy` strict, 244 files: clean. `ruff check`: clean.
- `vitest run tests/server tests/serverChatView.test.ts`: **1229 passed** before the
  busy→incoming case was added (that case passed in a focused 12/12 run).
- `tsc --noEmit`: clean. `npm run build`: ok. `git diff --check`: clean. Sources are LF.
- **Not executed:** Playwright `e2e/tests/server-calls.spec.ts`, so the real-browser
  `state`/ack handshake through an actual AudioWorklet is unproven. Also not executed: the
  full Python suite, and every device, tunnel, quality and Slots gate.

## H1 — synchronous completion owns capacity

**Converged:**
- capacity is owned by the job's actual completion, not by its awaiter;
- no waiting queue (refuse at capacity);
- capacity refusal is 4429, never 4401;
- injection through `validate_server_token`, so HTTP keeps its default.

**Took from Astra:**
- **Separate owners: admission 4** (Access verifier + initial grant) and **refresh 8**.
  This keeps the nominal 4 + 8 = 12 bound I had as a single shared cap. Discriminator
  (MEASURED-KNOWING): with admission saturated by blocked jobs, refresh still runs. A
  slow JWKS endpoint therefore cannot fail live calls' grant refresh. With my phase-1
  shared 12, twelve slow verifier jobs would have starved every live call's refresh. That
  outcome is derived from the design, not executed.
- **Busy, timeout and capacity are not unauthorized.** I extended this to the whole route
  (my own addition, beyond both proposals):
  - 1001 for cancellation and shutdown;
  - 4403 for protocol and validation errors;
  - **4408** for the internal auth deadline, a write timeout, and a grant cache that went
    stale without the store refusing;
  - 4401 only when `validate_server_token` refuses (`HTTPException`), the session
    deadline passes, or a refresh returned *not live* (`grant_until == 0`).

  Audio still fails closed in every one of these cases.
- A `10 s` timeout around Access verification is adopted so that a pre-accept socket
  cannot hold its pending slot forever while JWKS hangs. Its permit stays counted.
  Implemented; covered only by the existing auth tests, with no dedicated discriminator.

**Selected mechanism: a fixed `ThreadPoolExecutor` per owner, with the permit released
in `future.add_done_callback`.** I rejected the retained private AnyIO task, on two
measured discriminators:
1. Retained AnyIO jobs hold the **process-wide** AnyIO limiter. Twelve blocked call jobs
   borrowed 12 of its 40 tokens, which every HTTP `to_thread` call in Wixy shares. The
   dedicated executor borrowed 0.
2. The executor gives clean **pre-start cancellation**: `wrap_future` cancellation
   cancels a not-yet-started future, which fires the same done-callback. In Astra's
   design, a private task cancelled before `invoke` starts (only at loop teardown)
   never releases. That is harmless only because the owner is already closed.

The two designs are equal on shutdown (measured): neither can interrupt a running
synchronous call, and **both block interpreter exit** until it returns. This is the named
shutdown limit. The Slots drain or hard-stop must handle it; a 250 ms in-process drain
cannot. I therefore rejected Astra's lifespan `drain(0.25)`: it waits but changes no
outcome. `CallWork.close()` refuses new work and cancels queued jobs without blocking
shutdown.

The owners live on `CallBroker`, which already owns `pending`, `connections` and
`shutdown()`, rather than on `app.state` plus an `app.py` edit. That means one fewer
lifecycle seam.

**Acceptance tests:**
- `test_cancelled_auth_cannot_orphan_unbounded_grant_workers`
- `test_internal_auth_timeout_keeps_permits_and_does_not_lock`
- `test_refresh_slow_is_not_revocation[True-4408, False-4401]`
- `test_admission_saturation_cannot_starve_refresh_and_vice_versa`
- `test_job_cancelled_before_start_releases_its_permit`
- the existing `test_live_socket_pair_and_revoked_grant`

## M2 — overflow inside an ownership transition

**Converged:**
- no swallowed `KeyError`;
- no leftover `incoming`/`prepare`/`connected` after the pair has ended;
- invite, accept, second-ready, presence and shutdown are all covered (Astra
  contributed the invite case: CITED for her helper, MEASURED-KNOWING for the merged
  candidate across 4 queue fills).

**Remaining split, with my selection: deferred eviction at the outermost `@transition`
boundary** (my phase-1 design) over Astra's `emit_pair` with `self.call is call` checks.
Both pass every current discriminator. Astra's runs are CITED, mine MEASURED-KNOWING.
I chose deferred eviction because:
1. **Membership cannot change during any transition**, so every `self.peers[...]`,
   `other()` and paired lookup stays valid in every mutator: `Mute`, `frame`, `tick`,
   `add` and `shutdown`, not only the three call sites `emit_pair` guards.
2. It turns the module's existing contract ("mutations never await: ownership is
   atomic") into one enforced boundary, instead of a helper that every future
   paired-emission site must remember to use.
3. Cascades (finish → emit → overflow → presence → overflow) are drained in one loop
   instead of nesting `remove` inside `finish` inside `emit`.

Astra's own precommitment (drop her M2 helper first for a smaller safe boundary) is
noted as evidence, not as a vote.

**Cost:** an overflowed peer is marked closed but still listed in other peers'
presence for the remainder of the same synchronous step. A corrected presence follows
in the same drain.

**Concrete discriminator, should the parent prefer `emit_pair`:** add a mutator that
indexes `self.peers[...]` after an emit outside the three helper sites. Today none
exists, so the split is about future-proofing, not a present defect.

**Acceptance tests:**
- `test_invite_overflow_is_a_clean_transition` (4 fills)
- `test_accept_overflow_is_a_clean_transition` (3 fills)
- `test_connected_and_presence_overflow_are_clean_transitions`
- `test_slow_receiver_and_control_flood_end_in_bounded_state` (existing)

## M3 — crossing invites

**Converged fully on mechanism:**
- `unavailable{requestId}`;
- a single client `outgoingRequest` kept separately from `callId`;
- when `incoming` arrives while a request is pending, stop the losing Call graph, clear
  busy and keep the request id;
- a busy reply tears down only if it matches the pending request and there is no
  `callId`;
- the Answer gesture builds its own graph and `accept` is never automatic.

**Took from Astra:** `requestId` on `outgoing`, with the client ignoring an `outgoing`
that does not match its own pending request. This gives ownership symmetry for the
opposite role, and the two existing fixtures were updated.

**Kept from mine:** `activateAudio` stops any prior graph before building one. This is
defensive and never touches a newer Answer graph, because the losing graph is retired
on arrival of `incoming` and busy never stops audio (tested).

**Acceptance tests:** the broker's
`test_crossing_invites_correlate_every_reply_and_keep_third_device_out[a,b]`, and six
controller cases in `callRepairs.test.ts`.

## M1 + M4 — one acknowledged graph-control slot, immutable capture provenance

**Converged:**
- `lease` and `enabled` posts are replaced by one coalesced `state` snapshot with at
  most **one** unacknowledged;
- capture metadata is bound at production and never relabelled, with mute revisions;
- dropped buffers are recycled to the fixed pool;
- the playback ring, credits and drift correction are unchanged.

**Took from Astra (these change my phase-1 M4, which I had precommitted to drop first):**
- **The acknowledgement comes from `process()`, not from the port handler.** The
  worklet keeps a single pending slot and applies and acks it at the top of the next
  render quantum. My phase-1 worklet acked inside `onmessage`, which proves only that the
  port was read. The new worklet test fails that shape: the absence of the phase-1 ack is
  read from its source, not re-run.
- **A receiver playout lease is issued only after a rendered acknowledgement**
  (`onLeaseReady(until, remainingMs)`). This means the relay forwards audio to us only
  while our graph is proven rendering. Muted graphs still render silent quanta, so
  liveness holds during mute.
- Per-sample `startedAt = currentTime + index/sampleRate`. Reset the partial buffer,
  phase and filter on a change of `enabled` or `revision`. A late ack (≥ 300 ms) fails.
  `start()` posts nothing and cannot fail synchronously before the controller takes its
  `voiceCall` suspension; the first `pulse()` follows that.

**Kept from mine:**
- **Capture-lease changes are pushed as soon as the slot is free**, and an ack sends the
  newest *changed* desired state. Astra held them until the next 100 ms pulse; I rejected
  that.
  - Bound: posts per second never exceed the rate of desired-state changes (≈ 20/s). The
    10,000-iteration test measured one post with no render. So this is not a
    render-rate loop.
  - Reason (an analysis, **not measured**): the relay accepts lease N only before
    issue(N) + 300 ms. With pulse-only delivery the worklet learns N up to 100 ms later,
    which cuts the tolerated capture→relay delay from roughly 180 ms to roughly 80 ms.
    That is below the review's +100 ms RTT stress case.
- A local `captureUntil` capture gate, so capture stops when server capture leases stop
  arriving, rather than streaming frames the relay will discard.
- A numeric mute `revision`.

**Rejected:**
- Astra's per-call UUID `generation` on every message. Each `CallAudio` owns its own
  node and `MessagePort`, closed at `stop()`, and the `stopped` guard rejects late
  messages. The stale-ack-after-stop test passes without it (MEASURED-KNOWING).
- "Never send on ack". Covered above.

**Limits:**
- Failure is detected at the first sync ≥ 300 ms after the unacknowledged post: up to
  about 400 ms with 100 ms pulses. The worklet's own leases still expire at 300 ms.
- A buffer's worst-case age is bounded by its first sample's time. The relay's check
  stays exact.
- Real AudioWorklet scheduling, Safari activation and mobile throttling are unproven.

**Acceptance tests:**
- the 4 `M4 graph control bound` cases, 2 `M1/M4 controller` cases and 2 controller
  provenance cases in `callRepairs.test.ts`;
- the 3 new worklet cases in `callWorklet.test.ts`;
- the existing tone, 44.1/48 kHz and expired-playout tests, migrated to `state`.

## Integration changes (exact: Appendix A)

- `wixy_server/livechat/call_broker.py`:
  - `CallCapacityError`;
  - `CallWork(capacity, name)` (executor, done-callback permit, `close()`);
  - `@transition` and deferred `evicting`/`drop()`;
  - `admission_work = CallWork(4)` and `refresh_work = CallWork(8)`;
  - `unavailable` and `outgoing` carry `requestId`;
  - `shutdown()` closes both owners.
- `wixy_server/routes_livechat_calls.py`:
  - the verifier uses `admission_work` under `asyncio.timeout(10)`;
  - the initial grant check uses `offload=admission_work.run`;
  - refresh uses `refresh_work`;
  - the close-code vocabulary above.
- `wixy_server/livechat/tokens.py`: an optional `offload` keyword, with HTTP unchanged.
- `admin-ui/src/server/call/{audio,worklet,controller}.ts`:
  - `state` messages with a seq and an ack from `process()`;
  - `pulse()`, `captureLease()`, and a fourth `leaseReady` factory callback;
  - capture `{lease, revision, at}`;
  - `outgoingRequest`.
- Rebuilt bundles: `wixy_server/static/admin/{admin.js,admin.js.map,call-worklet.js}`.

**Docs in the same PR** (not written here):
- `docs/ai/contracts.md`:
  - `outgoing{callId,peer,requestId}` and `unavailable{requestId}`;
  - close codes 1001 / 4403 / 4408 / 4429 / 4401 with their meanings;
  - the worklet `state`/ack contract.
- `docs/ai/livechat.md` and `invariants.md` Inv 55:
  - job-owned admission 4 and refresh 8 permits, and the exit limit;
  - every public broker mutator is a `@transition`;
  - capture provenance is bound in the worklet;
  - one rendered-ack control slot;
  - a receiver lease only after a rendered ack.
- `CLAUDE.md`'s call line is unchanged.

**Integration order for the parent:**
1. H1 and the close codes;
2. M2;
3. M3 (wire and client together);
4. M1 + M4 together.

Then rebuild the LF bundles, run the focused suites and Playwright
`server-calls.spec.ts` once, freeze a SHA, and hand it to **fresh** reviewers.

**Preserved:**
- explicit two-socket consent and both-ready media;
- a third same-login browser gets no incoming prompt, audio or participation (broker
  negative control above);
- a connected or muted call pauses only the idle lock;
- actual lock, shield, detach, pagehide and token change still tear down at once;
- no persistence, recording or transcription.

Ordinary chat messages still sync to every unlocked view; nothing here changes that.
Physical Android Chrome + iPad Safari, a separate actual-iPhone check, the tunnel,
quality and the Slots drain all remain open.

## Appendix A — merged source diff (against `74c9578`)

```diff
diff --git a/admin-ui/src/server/call/audio.ts b/admin-ui/src/server/call/audio.ts
index a55afb8..5839bcf 100644
--- a/admin-ui/src/server/call/audio.ts
+++ b/admin-ui/src/server/call/audio.ts
@@ -1,5 +1,7 @@
 /** Owns one attempt's audio resources, including resources returned after cancellation. */
 declare const WIXY_CALL_WORKLET_URL: string;
+const LEASE_S = 0.3;
+interface GraphState { playUntil: number; captureLease: number; captureUntil: number; enabled: boolean; revision: number }
 export class CallAudio {
   private context: AudioContext;
   private stream: MediaStream | null = null;
@@ -9,9 +11,16 @@ export class CallAudio {
   private running = false;
   private muted = false;
   private activation: Promise<void>;
+  // One coalesced main-to-worklet control in flight. The worklet acknowledges it from
+  // process(), so an ack proves a render quantum ran, not merely that the port was read.
+  private desired: GraphState = { playUntil: 0, captureLease: 0, captureUntil: 0, enabled: false, revision: 0 };
+  private posted: GraphState | null = null;
+  private flight: { seq: number; at: number; state: GraphState } | null = null;
+  private seq = 0;
+  private issuedUntil = 0;

-  constructor(private onCapture: (pcm: ArrayBuffer) => void, private onAdmitted: (sequence: number) => void,
-    private onFailure: () => void) {
+  constructor(private onCapture: (pcm: ArrayBuffer, lease: number) => void, private onAdmitted: (sequence: number) => void,
+    private onFailure: () => void, private onLeaseReady: (until: number, remainingMs: number) => void = () => {}) {
     this.context = new AudioContext();
     // Called synchronously from Call/Accept user gestures, before any server await.
     this.activation = this.context.resume();
@@ -43,8 +52,26 @@ export class CallAudio {
         if (this.stopped) return;
         if (data["type"] === "capture" && data["pcm"] instanceof ArrayBuffer) {
           const pcm = data["pcm"];
-          if (this.running && !this.muted) this.onCapture(pcm);
+          // Lease, mute revision and first-sample time were bound by the worklet; never relabel.
+          const at = data["at"];
+          const now = this.context.currentTime;
+          if (this.running && !this.muted && typeof data["lease"] === "number" && data["lease"] > 0
+            && data["revision"] === this.desired.revision && typeof at === "number"
+            && at <= now && now - at <= LEASE_S) this.onCapture(pcm, data["lease"]);
+          // Forwarded and dropped buffers alike return to the fixed pool.
           if (!this.stopped) this.node?.port.postMessage({ type: "buffer", pcm }, [pcm]);
+        } else if (data["type"] === "state" && this.flight !== null && data["seq"] === this.flight.seq) {
+          const flight = this.flight;
+          this.flight = null;
+          if (performance.now() - flight.at >= LEASE_S * 1000) { this.onFailure(); return; }
+          const until = flight.state.playUntil;
+          if (this.running && until > this.issuedUntil) {
+            const remainingMs = Math.min(LEASE_S * 1000, (until - this.context.currentTime) * 1000);
+            if (remainingMs <= 0) { this.onFailure(); return; }
+            this.issuedUntil = until;
+            this.onLeaseReady(until, remainingMs); // Receiver lease only for a rendering graph.
+          }
+          this.sync();
         } else if (data["type"] === "admitted" && typeof data["sequence"] === "number") {
           this.onAdmitted(data["sequence"]);
         }
@@ -66,16 +93,44 @@ export class CallAudio {
     }
   }

-  start(): void { this.running = true; this.setMuted(false); }
+  /** Never posts or fails synchronously: the controller acquires its call suspension, then pulses. */
+  start(): void {
+    this.running = true;
+    this.muted = false;
+    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = true;
+    this.desired = { ...this.desired, enabled: true, revision: this.desired.revision + 1 };
+  }
   setMuted(muted: boolean): void {
+    if (muted !== this.muted) this.desired = { ...this.desired, revision: this.desired.revision + 1 };
     this.muted = muted;
     for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
-    this.node?.port.postMessage({ type: "enabled", enabled: this.running && !muted });
+    // A new revision invalidates every capture buffer produced before this change.
+    this.desired = { ...this.desired, enabled: this.running && !muted };
+    this.sync();
+  }
+  /** 100 ms cadence while connected, including muted/silent calls. */
+  pulse(): void {
+    this.desired = { ...this.desired, playUntil: this.context.currentTime + LEASE_S };
+    this.sync();
   }
-  lease(): number {
-    const until = this.context.currentTime + 0.3;
-    this.node?.port.postMessage({ type: "lease", until });
-    return until;
+  captureLease(lease: number): void {
+    if (!Number.isSafeInteger(lease) || lease <= this.desired.captureLease) return;
+    // Pushed as soon as the slot is free, not held for the next pulse: every 100 ms of
+    // delay here is 100 ms less network budget before the relay's 300 ms expiry.
+    this.desired = { ...this.desired, captureLease: lease, captureUntil: this.context.currentTime + LEASE_S };
+    this.sync();
+  }
+  private sync(): void {
+    if (this.stopped || !this.node || !this.running) return;
+    if (this.flight !== null) {
+      // Coalesce while unacknowledged; a graph that stops rendering fails the call.
+      if (performance.now() - this.flight.at >= LEASE_S * 1000) this.onFailure();
+      return;
+    }
+    if (this.posted === this.desired) return;
+    this.posted = this.desired;
+    this.flight = { seq: ++this.seq, at: performance.now(), state: this.desired };
+    this.node.port.postMessage({ type: "state", seq: this.seq, ...this.desired });
   }
   play(pcm: ArrayBuffer, sequence: number, until: number): void {
     if (!this.stopped && this.running && until > this.context.currentTime) {
@@ -86,6 +141,7 @@ export class CallAudio {
     if (this.stopped) return;
     this.stopped = true;
     this.running = false;
+    this.flight = null;
     for (const track of this.stream?.getTracks() ?? []) track.stop();
     this.stream = null;
     this.source?.disconnect();
diff --git a/admin-ui/src/server/call/controller.ts b/admin-ui/src/server/call/controller.ts
index 56c733e..65c2e02 100644
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -7,7 +7,8 @@ export interface CallAudioHandle {
   start(): void;
   stop(): void;
   setMuted(muted: boolean): void;
-  lease(): number;
+  pulse(): void;
+  captureLease(lease: number): void;
   play(pcm: ArrayBuffer, sequence: number, until: number): void;
 }
 export interface CallDeps {
@@ -16,8 +17,8 @@ export interface CallDeps {
   isMicBusy: () => boolean;
   onBusy: (busy: boolean) => void;
   socketFactory?: (url: string, protocol: string) => WebSocket;
-  audioFactory?: (capture: (pcm: ArrayBuffer) => void, admitted: (sequence: number) => void,
-    failed: () => void) => CallAudioHandle;
+  audioFactory?: (capture: (pcm: ArrayBuffer, lease: number) => void, admitted: (sequence: number) => void,
+    failed: () => void, leaseReady: (until: number, remainingMs: number) => void) => CallAudioHandle;
 }

 /** One attachment's presence and one explicit call attempt; never auto-resumes audio. */
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
@@ -140,25 +139,36 @@ export function createCallController(deps: CallDeps) {
   }
   function activateAudio(): boolean {
     if (deps.isMicBusy()) return false;
+    audio?.stop(); // Never orphan an earlier attempt's context.
     const attemptEpoch = ++callEpoch;
     try {
-      audio = (deps.audioFactory ?? ((capture, ack, fail) => new CallAudio(capture, ack, fail)))(
-        (pcm) => {
+      audio = (deps.audioFactory ?? ((capture, ack, fail, ready) => new CallAudio(capture, ack, fail, ready)))(
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
+        (until, remainingMs) => {
+          // A receiver playout lease is issued only after the graph proved it rendered.
+          if (attemptEpoch !== callEpoch || state !== "connected" || !callId) return;
+          if (!(remainingMs > 0 && remainingMs <= LEASE_MS)) { end("Audio unavailable"); return; }
+          const now = win.performance.now();
+          const id = ++playoutId;
+          leases.set(id, { at: now + remainingMs, until });
+          for (const [key, lease] of leases) if (lease.at <= now) leases.delete(key);
+          if (leases.size > 4) leases.delete(leases.keys().next().value as number);
+          if (!send({ type: "lease", callId, lease: id })) end("Connection too slow");
+        },
       );
       return true;
     } catch { teardownCall("Calls unavailable in this browser"); return false; }
@@ -176,11 +186,7 @@ export function createCallController(deps: CallDeps) {
     }
     if (state === "connected" && callId && audio) {
       if (stale) { end("Call interrupted"); return; }
-      const id = ++playoutId;
-      leases.set(id, { at: now + LEASE_MS, until: audio.lease() });
-      for (const [key, lease] of leases) if (lease.at <= now) leases.delete(key);
-      if (leases.size > 4) leases.delete(leases.keys().next().value as number);
-      send({ type: "lease", callId, lease: id });
+      audio.pulse();
     }
   }
   async function prepare(id: string): Promise<void> {
@@ -235,14 +241,25 @@ export function createCallController(deps: CallDeps) {
       }
       if (Array.from(targets.options).some((o) => o.value === selected)) targets.value = selected;
     } else if (m["type"] === "incoming" || m["type"] === "outgoing") {
+      // An outgoing reply must answer this tab's own pending request.
+      if (m["type"] === "outgoing" && (outgoingRequest === null || m["requestId"] !== outgoingRequest)) return;
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
@@ -254,9 +271,8 @@ export function createCallController(deps: CallDeps) {
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
index be73a72..015a354 100644
--- a/admin-ui/src/server/call/worklet.ts
+++ b/admin-ui/src/server/call/worklet.ts
@@ -16,6 +16,16 @@ class CallAudioProcessor extends AudioWorkletProcessor {
   private alpha = 1 - Math.exp(-2 * Math.PI * 10_000 / sampleRate);
   private enabled = false;
   private leaseUntil = 0;
+  private captureLease = 0;
+  private captureUntil = 0;
+  private revision = 0;
+  // Single slot: the main thread keeps at most one state unacknowledged.
+  private pending: { seq: number; playUntil: number; captureLease: number; captureUntil: number;
+    enabled: boolean; revision: number } | null = null;
+  // Provenance of the buffer being filled, bound at its first sample and never updated.
+  private bufferLease = 0;
+  private bufferRevision = 0;
+  private bufferAt = 0;
   private ring = new Float32Array(4800);
   private deadlines = new Float64Array(4800);
   private read = 0;
@@ -29,11 +39,11 @@ class CallAudioProcessor extends AudioWorkletProcessor {
       const data = event.data;
       if (data["type"] === "buffer" && data["pcm"] instanceof ArrayBuffer) {
         if (this.pool.length < 5 && data["pcm"].byteLength === 960) this.pool.push(data["pcm"]);
-      } else if (data["type"] === "enabled") {
-        this.enabled = data["enabled"] === true;
-        this.captured = 0;
-      } else if (data["type"] === "lease" && typeof data["until"] === "number") {
-        this.leaseUntil = data["until"];
+      } else if (data["type"] === "state" && typeof data["seq"] === "number"
+        && typeof data["playUntil"] === "number" && typeof data["captureLease"] === "number"
+        && typeof data["captureUntil"] === "number" && typeof data["revision"] === "number") {
+        this.pending = { seq: data["seq"], playUntil: data["playUntil"], captureLease: data["captureLease"],
+          captureUntil: data["captureUntil"], enabled: data["enabled"] === true, revision: data["revision"] };
       } else if (data["type"] === "play" && data["pcm"] instanceof ArrayBuffer
         && typeof data["until"] === "number" && typeof data["sequence"] === "number") {
         const pcm = new DataView(data["pcm"]);
@@ -50,6 +60,8 @@ class CallAudioProcessor extends AudioWorkletProcessor {
       } else if (data["type"] === "stop") {
         this.enabled = false;
         this.leaseUntil = 0;
+        this.captureUntil = 0;
+        this.pending = null;
         this.flush();
         this.port.close();
       }
@@ -59,9 +71,25 @@ class CallAudioProcessor extends AudioWorkletProcessor {
   private flush(): void { this.read = 0; this.count = 0; this.playPhase = 0; this.playing = false; }

   process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
+    const state = this.pending;
+    if (state !== null) {
+      this.pending = null;
+      if (state.enabled !== this.enabled || state.revision !== this.revision) {
+        this.captured = 0;
+        this.capturePhase = 0;
+        this.low = this.previous = 0;
+      }
+      this.enabled = state.enabled;
+      this.revision = state.revision;
+      this.captureLease = state.captureLease;
+      this.captureUntil = state.captureUntil;
+      this.leaseUntil = state.playUntil;
+      this.port.postMessage({ type: "state", seq: state.seq }); // Proof a quantum rendered.
+    }
     const input = inputs[0]?.[0];
-    if (input !== undefined && this.enabled && currentTime < this.leaseUntil) {
-      for (const value of input) {
+    if (input !== undefined && this.enabled && this.captureLease > 0 && currentTime < this.captureUntil) {
+      for (let index = 0; index < input.length; index++) {
+        const value = input[index] ?? 0;
         // Bounded low-pass plus fractional-rate interpolation; native contexts may
         // run at 44.1 or 48 kHz regardless of getUserMedia's sample-rate preference.
         this.low += this.alpha * (value - this.low);
@@ -73,12 +101,18 @@ class CallAudioProcessor extends AudioWorkletProcessor {
             if (buffer !== undefined) this.capture = new DataView(buffer);
           }
           if (this.capture !== null) {
+            if (this.captured === 0) {
+              this.bufferLease = this.captureLease;
+              this.bufferRevision = this.revision;
+              this.bufferAt = currentTime + index / sampleRate;
+            }
             const fraction = 1 - this.capturePhase * sampleRate / 24_000;
             const sample = this.previous + Math.max(0, Math.min(1, fraction)) * (this.low - this.previous);
             this.capture.setInt16(this.captured * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true);
             if (++this.captured === 480) {
               const pcm = this.capture.buffer as ArrayBuffer;
-              this.port.postMessage({ type: "capture", pcm }, [pcm]);
+              this.port.postMessage({ type: "capture", pcm, lease: this.bufferLease,
+                revision: this.bufferRevision, at: this.bufferAt }, [pcm]);
               this.capture = null;
               this.captured = 0;
             }
diff --git a/wixy_server/livechat/call_broker.py b/wixy_server/livechat/call_broker.py
index ca8993f..e5fcbc8 100644
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
@@ -28,6 +33,69 @@ from wixy_server.livechat.call_protocol import (
 from wixy_server.livechat.tokens import ServerAuth


+class CallCapacityError(RuntimeError):
+    """Synchronous auth/grant work is at its fixed cap; fail closed without locking."""
+
+
+class CallWork:
+    """Fixed-capacity synchronous jobs whose permits are released by the job itself.
+
+    A cancelled or timed-out awaiter never frees a permit while its thread still runs;
+    a job cancelled before it starts frees it through the same done-callback. Its own
+    executor keeps blocked call work off AnyIO's shared default thread limiter.
+    """
+
+    def __init__(self, capacity: int, name: str) -> None:
+        self.capacity = capacity
+        self.work = 0
+        self.closed = False
+        self.lock = threading.Lock()
+        self.executor = ThreadPoolExecutor(capacity, thread_name_prefix=name)
+
+    async def run[T](self, job: Callable[[], T]) -> T:
+        with self.lock:
+            if self.closed or self.work >= self.capacity:
+                raise CallCapacityError("call work capacity")
+            self.work += 1
+        try:
+            future = self.executor.submit(job)
+        except BaseException:
+            self.finished(None)
+            raise
+        future.add_done_callback(self.finished)
+        return await asyncio.wrap_future(future)
+
+    def finished(self, _future: object) -> None:
+        with self.lock:
+            self.work -= 1
+
+    def close(self) -> None:
+        """Queued jobs are cancelled; running synchronous calls cannot be interrupted
+        and keep their permits (and the process's exit) until they return."""
+        with self.lock:
+            self.closed = True
+        self.executor.shutdown(wait=False, cancel_futures=True)
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
+
 @dataclass
 class Budget:
     rate: float
@@ -97,16 +165,28 @@ class CallBroker:
         self.connections = 0
         # Bounded identity table; do not evict live rate limits under a flood.
         self.admissions: dict[str, Budget] = {}
+        self.depth = 0
+        self.evicting: deque[Peer] = deque()
+        # Separate owners: a slow Access/JWKS verifier cannot starve live calls' grant
+        # refresh, and orphaned refreshes cannot block new admissions. Nominal 4 + 8.
+        self.admission_work = CallWork(4, "wixy-call-admission")
+        self.refresh_work = CallWork(8, "wixy-call-refresh")

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
@@ -126,6 +206,7 @@ class CallBroker:
         self.presence()
         return True

+    @transition
     def presence(self) -> None:
         busy = (self.call.caller, self.call.callee) if self.call else ()
         for peer in list(self.peers.values()):
@@ -149,6 +230,7 @@ class CallBroker:
             and time.monotonic() < peer.grant_until
         )

+    @transition
     def finish(self, reason: str) -> None:
         call, self.call = self.call, None
         if call is None:
@@ -166,7 +248,11 @@ class CallBroker:
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
@@ -180,12 +266,16 @@ class CallBroker:
         peer.wake.set()
         self.presence()

+    @transition
     def shutdown(self) -> None:
         self.closed = True
         self.finish("unavailable")
         for peer in list(self.peers.values()):
             self.remove(peer)
+        self.admission_work.close()
+        self.refresh_work.close()

+    @transition
     def command(self, peer: Peer, command: Command) -> None:
         now = time.monotonic()
         if not self.permitted(peer) or not peer.controls_budget.take(now):
@@ -208,10 +298,19 @@ class CallBroker:
                 or not self.permitted(target_peer)
                 or not peer.invites_budget.take(now)
             ):
-                self.emit(peer, {"type": "unavailable"})
+                # Correlated, so a crossing caller's loss never erases its incoming call.
+                self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
                 return
             invited = self.call = Call(peer.id, target_peer.id)
-            self.emit(peer, {"type": "outgoing", "callId": invited.id, "peer": target_peer.label})
+            self.emit(
+                peer,
+                {
+                    "type": "outgoing",
+                    "callId": invited.id,
+                    "peer": target_peer.label,
+                    "requestId": command.requestId,
+                },
+            )
             self.emit(target_peer, {"type": "incoming", "callId": invited.id, "peer": peer.label})
             self.presence()
             return
@@ -264,6 +363,7 @@ class CallBroker:
         assert self.call and self.call.contains(peer)
         return self.peers[self.call.callee if peer.id == self.call.caller else self.call.caller]

+    @transition
     def frame(self, peer: Peer, data: bytes) -> None:
         now = time.monotonic()
         epoch, seq, sample, lease = unpack_frame(data)
@@ -308,6 +408,7 @@ class CallBroker:
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
index 5cd146f..2d14be5 100644
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
@@ -42,7 +43,10 @@ async def access_identity(ws: WebSocket, settings: Settings) -> tuple[str, float
     if not token:
         raise ValueError("access")
     verify = ws.app.state.call_access_verifier
-    claims: dict[str, Any] = await anyio.to_thread.run_sync(lambda: verify(token))
+    # Bounded wait so a hung JWKS fetch cannot hold a pre-accept socket forever; the
+    # job itself keeps its admission permit until it actually returns.
+    async with asyncio.timeout(10):
+        claims: dict[str, Any] = await broker.admission_work.run(lambda: verify(token))
     email, exp = claims.get("email"), claims.get("exp")
     if (
         not isinstance(email, str)
@@ -103,7 +107,7 @@ async def run_peer(ws: WebSocket, broker: CallBroker, peer: Peer, store: LiveCha
         if peer.auth.grant_id is None:
             await asyncio.Future[None]()
         while not peer.closed:
-            live = await anyio.to_thread.run_sync(
+            live = await broker.refresh_work.run(
                 lambda: store.is_device_grant_live(
                     grant_id=peer.auth.grant_id or "",
                     email=peer.auth.email,
@@ -147,12 +151,14 @@ async def calls_socket(ws: WebSocket) -> None:
     peer: Peer | None = None
     accepted = False
     connection_slot = False
-    close_code = 4401
+    # 4401 tells the browser to lock: only a refused/revoked/expired credential earns it.
+    # Cancellation/shutdown is 1001; a missed deadline is 4408; capacity is 4429.
+    close_code = 1001
     try:
         settings: Settings = ws.app.state.settings
-        # The pending admission cap is held until off-thread verification finishes,
-        # including cancellation; do not abandon threads and silently free the cap.
-        email, access_exp = await access_identity(ws, settings)
+        # Socket slots bound sockets; broker's CallWork owners separately bound the
+        # synchronous verifier/grant jobs, which outlive a cancelled or timed-out awaiter.
+        email, access_exp = await access_identity(ws, settings, broker)
         await ws.accept(subprotocol=PROTOCOL)
         accepted = True
         async with asyncio.timeout(5):
@@ -167,6 +173,7 @@ async def calls_socket(ws: WebSocket) -> None:
                 email=email,
                 secret=ws.app.state.livechat_secret,
                 store=store,
+                offload=broker.admission_work.run,
             )
         peer = Peer(auth, auth_frame.label.strip() or "Device", min(auth.exp, access_exp))
         del auth_frame, packet, text
@@ -181,23 +188,30 @@ async def calls_socket(ws: WebSocket) -> None:
         connection_slot = True
         close_code = 4403
         await run_peer(ws, broker, peer, store)
-        close_code = (
-            4401 if time.time() >= peer.deadline or time.monotonic() >= peer.grant_until else 1000
-        )
+        if time.time() >= peer.deadline or peer.grant_until == 0:
+            close_code = 4401  # Expired session or a store-confirmed revoked grant.
+        elif time.monotonic() >= peer.grant_until:
+            close_code = 4408  # Refresh too slow: fail closed, but unproven revocation.
+        else:
+            close_code = 1000
+    except CallCapacityError:
+        close_code = 4429  # Server busy, not an authorization failure: never lock.
+    except HTTPException:
+        close_code = 4401  # The shared token/grant validator refused the credential.
+    except TimeoutError:
+        close_code = 4408
     except (
         AccessVerificationError,
-        HTTPException,
         ValueError,
         TypeError,
         RuntimeError,
         httpx.HTTPError,
         ValidationError,
-        TimeoutError,
         WebSocketDisconnect,
         OSError,
     ):
         # Fixed reason/code only. Never log auth JSON, PCM, labels or validation payloads.
-        pass
+        close_code = 4403
     finally:
         if pending:
             broker.pending -= 1
```

## Appendix B — merged red/green tests (new + migrated)

```diff
diff --git a/admin-ui/tests/server/call.test.ts b/admin-ui/tests/server/call.test.ts
index 37d029d..e9ab241 100644
--- a/admin-ui/tests/server/call.test.ts
+++ b/admin-ui/tests/server/call.test.ts
@@ -23,7 +23,7 @@ function setup(prepare: () => Promise<void> = async () => {}) {
   const releases: { reason: string; release: ReturnType<typeof vi.fn> }[] = [];
   const audio: CallAudioHandle = {
     prepare: vi.fn(prepare), start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
-    lease: () => 0.3, play: vi.fn(),
+    pulse: vi.fn(), play: vi.fn(), captureLease: vi.fn(),
   };
   const lock = vi.fn();
   const controller = createCallController({ win: window, isMicBusy: () => false, onBusy: vi.fn(),
@@ -60,7 +60,7 @@ describe("live-call consent and lifetime", () => {
     const f = setup();
     f.click("Call");
     expect(f.audio.prepare).not.toHaveBeenCalled();
-    f.socket.receive({ type: "outgoing", callId: ID, peer: "B" });
+    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
     expect(f.releases).toHaveLength(0);
     f.socket.receive({ type: "prepare", callId: ID });
     await Promise.resolve();
@@ -83,7 +83,7 @@ describe("live-call consent and lifetime", () => {
     let resolve!: () => void;
     const f = setup(() => new Promise<void>((done) => { resolve = done; }));
     f.click("Call");
-    f.socket.receive({ type: "outgoing", callId: ID, peer: "B" });
+    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.controls().find((m) => m["type"] === "invite")?.["requestId"] });
     f.socket.receive({ type: "prepare", callId: ID });
     f.controller.detach();
     expect(f.audio.stop).toHaveBeenCalledTimes(1);
diff --git a/admin-ui/tests/server/callRepairs.test.ts b/admin-ui/tests/server/callRepairs.test.ts
new file mode 100644
index 0000000..f8f09c2
--- /dev/null
+++ b/admin-ui/tests/server/callRepairs.test.ts
@@ -0,0 +1,245 @@
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
+type Capture = (pcm: ArrayBuffer, lease: number) => void;
+type Ready = (until: number, remainingMs: number) => void;
+
+function setup() {
+  const socket = new Socket();
+  const graphs: { audio: CallAudioHandle; capture: Capture; ready: Ready }[] = [];
+  const factory = vi.fn((capture: Capture, _ack: unknown, _fail: unknown, ready: Ready) => {
+    const audio = {
+      prepare: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), setMuted: vi.fn(),
+      pulse: vi.fn(), play: vi.fn(), captureLease: vi.fn(),
+    } as unknown as CallAudioHandle;
+    graphs.push({ audio, capture, ready });
+    return audio;
+  });
+  const controller = createCallController({ win: window, isMicBusy: () => false, onBusy: vi.fn(),
+    hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
+    socketFactory: () => socket as unknown as WebSocket,
+    audioFactory: factory as unknown as Factory,
+  });
+  controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
+  socket.onopen?.();
+  socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
+  socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
+  const button = (text: string) => [...controller.element.querySelectorAll("button")].find((b) => b.textContent === text);
+  const click = (text: string) => {
+    const found = button(text);
+    if (!found || found.hidden) throw new Error(`Missing ${text}`);
+    found.click();
+  };
+  const controls = () => socket.sent.filter((s): s is string => typeof s === "string")
+    .map((s) => JSON.parse(s) as Record<string, unknown>);
+  const requestId = () => controls().find((m) => m["type"] === "invite")?.["requestId"];
+  return { controller, socket, graphs, click, button, controls, requestId };
+}
+
+async function connected() {
+  const f = setup();
+  f.click("Call");
+  f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.requestId() });
+  f.socket.receive({ type: "prepare", callId: ID });
+  await Promise.resolve();
+  f.socket.receive({ type: "connected", callId: ID });
+  return f;
+}
+
+beforeEach(() => vi.useFakeTimers());
+afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
+
+describe("M3 crossing invitations", () => {
+  it("incoming then busy: keeps the winning call; Answer is a separate gesture and graph", () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
+    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
+    expect(f.controller.element.textContent).toContain("Incoming call from B");
+    expect(f.button("Answer")?.hidden).toBe(false);
+    expect(f.controls().some((m) => m["type"] === "accept")).toBe(false); // never auto-answered
+    f.click("Answer");
+    expect(f.controls().at(-1)).toEqual({ type: "accept", callId: ID });
+    expect(f.graphs).toHaveLength(2);
+    expect(f.graphs[0]?.audio.stop).toHaveBeenCalledTimes(1); // only the losing Call graph
+    expect(f.graphs[1]?.audio.stop).not.toHaveBeenCalled();
+    f.controller.dispose();
+  });
+  it("Answer then late busy: the newer Answer graph survives", () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
+    f.click("Answer");
+    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
+    f.socket.receive({ type: "prepare", callId: ID });
+    expect(f.graphs[1]?.audio.stop).not.toHaveBeenCalled();
+    expect(f.graphs[1]?.audio.prepare).toHaveBeenCalledTimes(1);
+    f.controller.dispose();
+  });
+  it("busy then incoming (defensive order): the incoming call is still offered, not answered", () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
+    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
+    expect(f.controller.element.textContent).toContain("Incoming call from B");
+    expect(f.button("Answer")?.hidden).toBe(false);
+    expect(f.controls().some((m) => m["type"] === "accept")).toBe(false);
+    expect(f.graphs[0]?.audio.stop).toHaveBeenCalledTimes(1);
+    f.controller.dispose();
+  });
+  it("busy for another request is ignored; its own busy tears down", () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "unavailable", requestId: "older" });
+    expect(f.controller.element.textContent).not.toContain("unavailable");
+    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
+    expect(f.controller.element.textContent).toContain("That person is unavailable");
+    f.controller.dispose();
+  });
+  it("Decline then late busy: nothing revived or re-sent", () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "incoming", callId: ID, peer: "B" });
+    f.click("Decline");
+    const sent = f.controls().length;
+    f.socket.receive({ type: "unavailable", requestId: f.requestId() });
+    expect(f.controls()).toHaveLength(sent);
+    expect(f.controls().at(-1)).toEqual({ type: "decline", callId: ID });
+    expect(f.button("Answer")?.hidden).toBe(true);
+    expect(f.controller.element.textContent).not.toContain("unavailable");
+    f.controller.dispose();
+  });
+  it("opposite role: an outgoing reply must answer this tab's pending request", () => {
+    const f = setup();
+    f.click("Call");
+    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: "someone-else" });
+    expect(f.controller.element.textContent).not.toContain("Calling");
+    f.socket.receive({ type: "outgoing", callId: ID, peer: "B", requestId: f.requestId() });
+    expect(f.controller.element.textContent).toContain("Calling");
+    f.controller.dispose();
+  });
+});
+
+describe("M1 capture provenance and M4 lease issuance at the controller", () => {
+  it("sends the lease bound at production, never the newest one", async () => {
+    const f = await connected();
+    f.socket.receive({ type: "capture", callId: ID, lease: 1 });
+    f.socket.receive({ type: "capture", callId: ID, lease: 2 });
+    f.graphs[0]?.capture(new ArrayBuffer(960), 1);
+    const frames = f.socket.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
+    expect(frames.map((b) => new DataView(b).getUint32(32))).toEqual([1]);
+    f.controller.dispose();
+  });
+  it("pulses the graph but issues a receiver lease only on a rendered acknowledgement", async () => {
+    const f = await connected();
+    vi.advanceTimersByTime(500);
+    expect(f.graphs[0]?.audio.pulse).toHaveBeenCalled();
+    expect(f.controls().some((m) => m["type"] === "lease")).toBe(false);
+    f.graphs[0]?.ready(0.3, 250);
+    expect(f.controls().filter((m) => m["type"] === "lease")).toHaveLength(1);
+    f.graphs[0]?.ready(0.4, 0);
+    expect(f.controller.element.textContent).toContain("Audio unavailable");
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
+  const states = () => posted.filter((m) => m["type"] === "state");
+  const ack = (seq: unknown) => port.onmessage?.({ data: { type: "state", seq } });
+  return { posted, port, context, track, states, ack };
+}
+
+async function graph() {
+  const g = stubGraph();
+  const failed = vi.fn();
+  const ready = vi.fn();
+  const captured = vi.fn();
+  const audio = new CallAudio(captured, vi.fn(), failed, ready);
+  await audio.prepare();
+  audio.start();
+  return { ...g, audio, failed, ready, captured };
+}
+
+describe("M4 graph control bound", () => {
+  it("start posts nothing; a muted call keeps one coalesced control and fails a stalled render", async () => {
+    const g = await graph();
+    expect(g.states()).toHaveLength(0);
+    g.audio.pulse();
+    g.audio.setMuted(true);
+    expect(g.track.enabled).toBe(false); // Mute is immediate at the track, not queued.
+    for (let i = 0; i < 10_000; i++) { g.audio.pulse(); g.audio.captureLease(i + 1); g.audio.setMuted(i % 2 === 0); }
+    expect(g.posted.filter((m) => m["type"] !== "buffer")).toHaveLength(1);
+    expect(g.failed).not.toHaveBeenCalled();
+    expect(g.ready).not.toHaveBeenCalled();
+    vi.advanceTimersByTime(300);
+    g.audio.pulse();
+    expect(g.failed).toHaveBeenCalledTimes(1);
+  });
+  it("a rendered ack issues one receiver lease and sends the newest coalesced state", async () => {
+    const g = await graph();
+    g.audio.pulse();
+    g.audio.captureLease(7);
+    g.audio.setMuted(true);
+    g.ack(g.states()[0]?.["seq"]);
+    expect(g.ready).toHaveBeenCalledTimes(1);
+    expect(g.ready.mock.calls[0]?.[1]).toBeGreaterThan(0);
+    expect(g.ready.mock.calls[0]?.[1]).toBeLessThanOrEqual(300);
+    expect(g.states()).toHaveLength(2);
+    expect(g.states()[1]).toMatchObject({ captureLease: 7, enabled: false });
+    g.ack(g.states()[1]?.["seq"]); // Same playUntil: no second receiver lease.
+    expect(g.ready).toHaveBeenCalledTimes(1);
+  });
+  it("a late acknowledgement fails; a stale one after stop revives nothing", async () => {
+    const g = await graph();
+    g.audio.pulse();
+    vi.advanceTimersByTime(300);
+    g.ack(g.states()[0]?.["seq"]);
+    expect(g.failed).toHaveBeenCalledTimes(1);
+    const h = await graph();
+    h.audio.pulse();
+    h.audio.stop();
+    h.ack(h.states()[0]?.["seq"]);
+    expect(h.ready).not.toHaveBeenCalled();
+    expect(h.failed).not.toHaveBeenCalled();
+    expect(h.posted.filter((m) => m["type"] === "stop")).toHaveLength(1);
+  });
+  it("drops capture from an old mute revision or older than its lease, and recycles every buffer", async () => {
+    const g = await graph();
+    g.audio.pulse();
+    const revision = g.states()[0]?.["revision"];
+    g.context.currentTime = 1;
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision, at: 0.5 } });
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision: -1, at: 0.9 } });
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision, at: 1.2 } });
+    g.port.onmessage?.({ data: { type: "capture", pcm: new ArrayBuffer(960), lease: 3, revision, at: 0.9 } });
+    expect(g.captured.mock.calls.map((c) => c[1])).toEqual([3]);
+    expect(g.posted.filter((m) => m["type"] === "buffer")).toHaveLength(9);
+  });
+});
diff --git a/admin-ui/tests/server/callWorklet.test.ts b/admin-ui/tests/server/callWorklet.test.ts
index ad5b583..f725843 100644
--- a/admin-ui/tests/server/callWorklet.test.ts
+++ b/admin-ui/tests/server/callWorklet.test.ts
@@ -25,8 +25,7 @@ describe("bounded call audio worklet", () => {
   it.each([44_100, 48_000])("resamples a 440 Hz tone from %s Hz and caps capture at five transferred frames", async (rate) => {
     const { node, sent, message } = await processor(rate);
     for (let i = 0; i < 5; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
-    message({ type: "lease", until: 0.3 });
-    message({ type: "enabled", enabled: true });
+    message({ type: "state", seq: 1, playUntil: 0.3, captureLease: 1, captureUntil: 0.3, enabled: true, revision: 1 });
     const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate) * 0.5);
     node.process([[input]], [[new Float32Array(128)]]);
     const frames = sent.filter((m) => m["type"] === "capture");
@@ -42,7 +41,7 @@ describe("bounded call audio worklet", () => {

   it("silences expired playout when the main thread never sends stop", async () => {
     const { node, message } = await processor(48_000);
-    message({ type: "lease", until: 0.3 });
+    message({ type: "state", seq: 1, playUntil: 0.3, captureLease: 1, captureUntil: 0.3, enabled: true, revision: 1 });
     for (let sequence = 0; sequence < 3; sequence++) {
       const pcm = new ArrayBuffer(960);
       const view = new DataView(pcm);
@@ -55,8 +54,42 @@ describe("bounded call audio worklet", () => {
     vi.stubGlobal("currentTime", 0.31);
     node.process([], [[output]]);
     expect(output.every((value) => value === 0)).toBe(true);
-    message({ type: "lease", until: 0.61 });
+    message({ type: "state", seq: 2, playUntil: 0.61, captureLease: 2, captureUntil: 0.61, enabled: false, revision: 1 });
     node.process([], [[output]]);
     expect(output.every((value) => value === 0)).toBe(true);
   });
+
+  it("binds lease, mute revision and time at sample production; a later lease never relabels", async () => {
+    const { node, sent, message } = await processor(48_000);
+    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
+    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, revision: 4 });
+    node.process([[new Float32Array(480)]], [[new Float32Array(128)]]); // half of buffer one, lease 1
+    message({ type: "state", seq: 2, playUntil: 1, captureLease: 2, captureUntil: 1, enabled: true, revision: 4 });
+    node.process([[new Float32Array(1440)]], [[new Float32Array(128)]]);
+    const frames = sent.filter((m) => m["type"] === "capture");
+    expect(frames.map((m) => [m["lease"], m["revision"]])).toEqual([[1, 4], [2, 4]]);
+    expect(sent.filter((m) => m["type"] === "state").map((m) => m["seq"])).toEqual([1, 2]);
+    message({ type: "state", seq: 3, playUntil: 1, captureLease: 2, captureUntil: 0, enabled: true, revision: 4 });
+    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
+    node.process([[new Float32Array(1920)]], [[new Float32Array(128)]]);
+    expect(sent.filter((m) => m["type"] === "capture")).toHaveLength(2); // expired capture lease: no samples
+  });
+
+  it("acknowledges state only from a rendered quantum, never from the port handler alone", async () => {
+    const { node, sent, message } = await processor(48_000);
+    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: false, revision: 1 });
+    expect(sent.filter((m) => m["type"] === "state")).toHaveLength(0);
+    node.process([], [[new Float32Array(128)]]);
+    expect(sent.filter((m) => m["type"] === "state").map((m) => m["seq"])).toEqual([1]);
+  });
+  it("a mute revision discards the partial buffer and tags the next one with the new revision", async () => {
+    const { node, sent, message } = await processor(48_000);
+    for (let i = 0; i < 2; i++) message({ type: "buffer", pcm: new ArrayBuffer(960) });
+    message({ type: "state", seq: 1, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, revision: 1 });
+    node.process([[new Float32Array(480)]], [[new Float32Array(128)]]);
+    message({ type: "state", seq: 2, playUntil: 1, captureLease: 1, captureUntil: 1, enabled: true, revision: 3 });
+    node.process([[new Float32Array(960)]], [[new Float32Array(128)]]);
+    const frames = sent.filter((m) => m["type"] === "capture");
+    expect(frames.map((m) => m["revision"])).toEqual([3]);
+  });
 });
diff --git a/wixy_server/tests/test_livechat_call_repairs.py b/wixy_server/tests/test_livechat_call_repairs.py
new file mode 100644
index 0000000..6d701f9
--- /dev/null
+++ b/wixy_server/tests/test_livechat_call_repairs.py
@@ -0,0 +1,307 @@
+"""Round-1 repair discriminators: H1 work ownership, M2 overflow transitions, M3 correlation."""
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
+from wixy_server.livechat.call_broker import CallBroker, CallCapacityError, CallWork, Peer
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
+    """Grant lookups block after `free` fast calls; `live_result` models revocation."""
+
+    def __init__(self, free: int = 0, live_result: bool = True) -> None:
+        self.release = threading.Event()
+        self.free = free
+        self.live_result = live_result
+        self.entered = 0
+        self.live = 0
+        self.lock = threading.Lock()
+
+    def is_device_grant_live(self, **_: Any) -> bool:
+        with self.lock:
+            self.entered += 1
+            call = self.entered
+            self.live += 1
+        try:
+            if call > self.free:
+                self.release.wait(10)
+            return self.live_result or call == 1
+        finally:
+            with self.lock:
+                self.live -= 1
+
+
+class _Headers(dict[str, str]):
+    def getlist(self, key: str) -> list[str]:
+        return [self[key]] if key in self else []
+
+
+class FakeSocket:
+    def __init__(self, app: Any, token: str) -> None:
+        self.app = app
+        self.scope: dict[str, Any] = {"query_string": b"", "subprotocols": [PROTOCOL]}
+        self.headers = _Headers({"origin": ORIGIN, "cf-access-authenticated-user-email": EMAIL})
+        self.token = token
+        self.closed: int | None = None
+        self.sent: list[Any] = []
+        self.authed = False
+
+    async def accept(self, subprotocol: str | None = None) -> None:
+        return None
+
+    async def receive(self) -> dict[str, Any]:
+        if self.authed:
+            await asyncio.Event().wait()  # A quiet, connected client.
+        self.authed = True
+        text = json.dumps({"type": "auth", "v": 1, "token": self.token, "label": "X"})
+        return {"type": "websocket.receive", "text": text}
+
+    async def send_json(self, message: Any) -> None:
+        self.sent.append(message)
+
+    async def send_bytes(self, data: bytes) -> None:
+        self.sent.append(data)
+
+    async def close(self, code: int = 1000) -> None:
+        self.closed = code
+
+
+def _app(store: Any, broker: CallBroker) -> Any:
+    return SimpleNamespace(
+        state=SimpleNamespace(
+            livechat_call_broker=broker,
+            call_origins=frozenset({ORIGIN}),
+            settings=SimpleNamespace(dev_no_auth=True),  # Isolates the grant path only.
+            livechat_store=store,
+            livechat_secret=SECRET,
+        )
+    )
+
+
+def _token() -> str:
+    token, _ = mint_unlock_token(SECRET, email=EMAIL, ttl_s=300, now=time.time(), grant_id="a" * 32)
+    return token
+
+
+def _drain(store: BlockedStore, broker: CallBroker) -> None:
+    store.release.set()
+    deadline = time.monotonic() + 5
+    while (store.live or broker.admission_work.work or broker.refresh_work.work) and (
+        time.monotonic() < deadline
+    ):
+        time.sleep(0.01)
+    assert store.live == 0
+    assert broker.admission_work.work == 0 and broker.refresh_work.work == 0
+
+
+def test_cancelled_auth_cannot_orphan_unbounded_grant_workers() -> None:
+    store, broker = BlockedStore(), CallBroker()
+    app, token = _app(store, broker), _token()
+
+    async def batches() -> list[int | None]:
+        codes: list[int | None] = []
+        for _ in range(5):
+            sockets = [FakeSocket(app, token) for _ in range(4)]
+            tasks = [asyncio.create_task(calls_socket(s)) for s in sockets]  # type: ignore[arg-type]
+            await asyncio.sleep(0.2)
+            for task in tasks:  # Native cancellation, as an outer timeout/shutdown delivers.
+                task.cancel()
+            await asyncio.gather(*tasks, return_exceptions=True)
+            assert broker.pending == 0
+            codes.extend(s.closed for s in sockets)
+        return codes
+
+    try:
+        codes = asyncio.run(batches())
+        assert store.live == 4 and store.entered == 4  # 20 cancelled auths, 4 real workers.
+        assert broker.admission_work.work == 4
+        assert 4401 not in codes  # Cancellation/busy never instructs the browser to lock.
+        assert set(codes) <= {1001, 4429}
+    finally:
+        _drain(store, broker)
+
+
+def test_internal_auth_timeout_keeps_permits_and_does_not_lock() -> None:
+    store, broker = BlockedStore(), CallBroker()
+    app, token = _app(store, broker), _token()
+
+    async def batch() -> list[int | None]:
+        sockets = [FakeSocket(app, token) for _ in range(4)]
+        await asyncio.gather(*(calls_socket(s) for s in sockets))  # type: ignore[arg-type]
+        late = FakeSocket(app, token)
+        await calls_socket(late)  # type: ignore[arg-type]
+        return [s.closed for s in sockets] + [late.closed]
+
+    try:
+        codes = asyncio.run(batch())  # The route's own 5 s deadline, not an outer cancel.
+        assert codes == [4408, 4408, 4408, 4408, 4429]
+        assert store.live == 4 and broker.pending == 0 and broker.admission_work.work == 4
+    finally:
+        _drain(store, broker)
+
+
+@pytest.mark.parametrize(("live_result", "expected"), [(True, 4408), (False, 4401)])
+def test_refresh_slow_is_not_revocation(live_result: bool, expected: int) -> None:
+    # Call 1 = admission, call 2 = first refresh; the next refresh blocks (or revokes).
+    store = BlockedStore(free=2, live_result=live_result)
+    broker = CallBroker()
+    socket = FakeSocket(_app(store, broker), _token())
+    try:
+        asyncio.run(asyncio.wait_for(calls_socket(socket), 8))  # type: ignore[arg-type]
+        assert socket.closed == expected
+        assert broker.connections == 0 and not broker.peers
+    finally:
+        _drain(store, broker)
+
+
+def test_admission_saturation_cannot_starve_refresh_and_vice_versa() -> None:
+    broker = CallBroker()
+    gate = threading.Event()
+
+    async def scenario() -> None:
+        blocked = [asyncio.create_task(broker.admission_work.run(gate.wait)) for _ in range(4)]
+        await asyncio.sleep(0.05)
+        for task in blocked:
+            task.cancel()
+        with pytest.raises(CallCapacityError):
+            await broker.admission_work.run(lambda: True)
+        assert await broker.refresh_work.run(lambda: True) is True
+        refresh = [asyncio.create_task(broker.refresh_work.run(gate.wait)) for _ in range(8)]
+        await asyncio.sleep(0.05)
+        with pytest.raises(CallCapacityError):
+            await broker.refresh_work.run(lambda: True)
+        broker.shutdown()
+        with pytest.raises(CallCapacityError):
+            await broker.admission_work.run(lambda: True)
+        gate.set()
+        await asyncio.gather(*refresh, return_exceptions=True)
+
+    asyncio.run(scenario())
+    deadline = time.monotonic() + 5
+    while (broker.admission_work.work or broker.refresh_work.work) and time.monotonic() < deadline:
+        time.sleep(0.01)
+    assert broker.admission_work.work == 0 and broker.refresh_work.work == 0
+
+
+def test_job_cancelled_before_start_releases_its_permit() -> None:
+    work = CallWork(1, "probe")
+    gate = threading.Event()
+
+    async def scenario() -> None:
+        running = asyncio.create_task(work.run(gate.wait))
+        await asyncio.sleep(0.05)
+        work.capacity = 2  # Admit one queued job behind the single executor thread.
+        queued = asyncio.create_task(work.run(lambda: True))
+        await asyncio.sleep(0.05)
+        queued.cancel()
+        await asyncio.gather(queued, return_exceptions=True)
+        assert work.work == 1  # The never-started job freed its permit; the running one did not.
+        gate.set()
+        await running
+
+    asyncio.run(scenario())
+    assert work.work == 0
+
+
+def _peers(count: int = 2) -> tuple[CallBroker, list[Peer]]:
+    broker = CallBroker()
+    auth = ServerAuth(EMAIL, int(time.time() + 300))
+    peers = [Peer(auth, label, time.time() + 300) for label in "ABC"[:count]]
+    for peer in peers:
+        assert broker.add(peer)
+    return broker, peers
+
+
+def _fill(peer: Peer, count: int) -> None:
+    peer.controls.clear()
+    peer.controls.extend({"type": "ping"} for _ in range(count))
+
+
+@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 14), (16, 0), (0, 16), (15, 15)])
+def test_invite_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None:
+    broker, (a, b) = _peers()
+    _fill(a, fill_a)
+    _fill(b, fill_b)
+    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
+    for peer in (a, b):
+        if peer.closed:
+            assert peer.id not in broker.peers
+    if a.closed or b.closed:
+        assert broker.call is None
+        survivor = b if a.closed else a
+        if not survivor.closed:
+            assert not [m for m in survivor.controls if m["type"] in ("incoming", "outgoing")]
+
+
+@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 14), (16, 0), (0, 16)])
+def test_accept_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None:
+    broker, (a, b) = _peers()
+    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
+    assert broker.call
+    epoch = broker.call.id
+    _fill(a, fill_a)
+    _fill(b, fill_b)
+    broker.command(b, CallAction(type="accept", callId=epoch))
+    assert broker.call is None
+    assert a.closed is (fill_a == 16) and b.closed is (fill_b >= 14)
+    for peer in (a, b):
+        stale = [m for m in peer.controls if m.get("callId") == epoch and m["type"] != "ended"]
+        assert not stale
+        if not peer.closed:
+            ended = {"type": "ended", "callId": epoch, "reason": "disconnected"}
+            assert ended in peer.controls
+
+
+def test_connected_and_presence_overflow_are_clean_transitions() -> None:
+    broker, (a, b) = _peers()
+    broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
+    assert broker.call
+    epoch = broker.call.id
+    broker.command(b, CallAction(type="accept", callId=epoch))
+    broker.command(a, CallAction(type="ready", callId=epoch))
+    _fill(a, 16)
+    broker.command(b, CallAction(type="ready", callId=epoch))
+    assert broker.call is None and a.closed and not b.closed
+    assert not [m for m in b.controls if m.get("type") == "connected"]
+    b.controls.extend({"type": "ping"} for _ in range(16 - len(b.controls)))
+    auth = ServerAuth(EMAIL, int(time.time() + 300))
+    c = Peer(auth, "C", time.time() + 300)
+    assert broker.add(c)  # Presence to the full peer evicts it; no KeyError.
+    assert b.closed and not c.closed and list(broker.peers) == [c.id]
+    broker.shutdown()
+    assert not broker.peers
+
+
+@pytest.mark.parametrize("winner", ["a", "b"])
+def test_crossing_invites_correlate_every_reply_and_keep_third_device_out(winner: str) -> None:
+    broker, (a, b, c) = _peers(3)
+    first, second = (a, b) if winner == "a" else (b, a)
+    for peer in (a, b, c):
+        peer.controls.clear()
+    broker.command(first, Invite(type="invite", requestId="w", targetConnectionId=second.id))
+    broker.command(second, Invite(type="invite", requestId="l", targetConnectionId=first.id))
+    assert broker.call and broker.call.caller == first.id and broker.call.callee == second.id
+    outgoing = [m for m in first.controls if m["type"] == "outgoing"]
+    assert outgoing and outgoing[0]["requestId"] == "w"
+    types = [m["type"] for m in second.controls]
+    assert types.index("incoming") < types.index("unavailable")
+    assert {"type": "unavailable", "requestId": "l"} in second.controls
+    # The same-login third device sees only availability, never the call controls.
+    assert {m["type"] for m in c.controls} <= {"presence"}
+    broker.command(second, CallAction(type="accept", callId=broker.call.id))
+    assert broker.call.state == "preparing"
```

Rebuilt committed bundles (`wixy_server/static/admin/{admin.js,admin.js.map,call-worklet.js}`) are not reproduced; regenerate with `npm run build` from LF sources.
