# Voice repair round 2 — Astra independent PROPOSE

**Candidate:** `4983cc662730f1a18bd95a5337d9c1a1fc45cb1b`
**Base:** `7a952c6cc590e5acf67996c1a7cbcc1b474a7ddc`
**Date:** 2026-10-18
**Phase:** independent PROPOSE, all five findings. Not an implementation approval.

I accept all five diagnoses after examining the candidate and executing focused
red/green trials. I propose the four-file patch below. It exists only in memory
and this proposal; the parent's implementation files remain unchanged.

I did not open the Gemini proposal or fetch its overflow-message detail. The
parent's short heads-up named duplicate presence. I separately reproduced that
case against current code and include a bounded optional repair below. All
measurements here are **MEASURED-KNOWING**: I knew the audit's expected defects
(and the parent's duplicate-presence hint). They are not new blind corroboration
of my own audit. No other family's agreement is claimed.

## Proposed mechanisms and layer checks

### M1 — Correlate a terminal result with the originating invitation

Store the already bounded `requestId` on the single in-memory Call. Add that
field to the caller's `ended` envelope, without adding another queue item.
The controller may retire a matching pending outgoing request **only when it has
no adopted call ID**. Known-epoch terminal handling remains unchanged. A new
incoming/accepted call cannot be destroyed by an old request's terminal message.

This closes both target-overflow and decline-before-outgoing. Do not preserve
a stale `outgoing` merely to teach the client its terminated epoch. Do not turn
every unknown `ended` into global teardown. A timeout alone would mask the
missing result and retain the stuck graph/recording lock unnecessarily.

**Layer:** broker owns the request-to-epoch association; controller owns the
pending attempt. Neither identity-wide signaling nor a new persistence layer
is needed. One request string (maximum 64 characters) is retained on one Call.

### M2 — Gate media with both cached authorities and the connected deadline

Use a synchronous `_media_other(peer, now)` helper under the existing transition
boundary. It validates pair membership/state, connected lifetime, existence of
the opposite endpoint and both endpoints' cached authorization. An expired
pair/lifetime finishes the call before further media admission or dequeue.
`next_media` becomes a transition because it can now perform terminal cleanup.
The helper is invoked before sequence mutation/queue admission and before
receiver credits are consumed.

Do not change `deadline` or `grant_until` to manufacture a cause. In particular,
an overdue refresh is not store-confirmed revocation. The route's final close
classification must also cover the exceptional media-permission path:
absolute expiry or `grant_until == 0` → 4401; overdue refresh → 4408;
cancellation remains 1001. Capacity still remains 4429 when no authorization
deadline has actually elapsed.

The existing source already gates the submitting peer before protocol handling
and checks the recipient at admission. The missing checks are the whole-call
lifetime and the sender at **dequeue**. The helper centralizes the valid-pair
rule; it is not permission to skip existing malformed-frame, stale-epoch,
mute, rate or sequence validation.

**Layer:** broker's synchronous media boundary plus the route's close-code
boundary. No per-frame database/JWKS work, task creation, executor changes or
new authorization mechanism. The actual 4/8 native quotas remain intact.

### M3 — Restore fresh presence only through the existing lock-policy owner

Keep the controller's unconditional pagehide teardown. Add one boolean to the
panel, recording that an attached, unlocked chat passed through a persisted
pagehide. An actual panel detach or disposal invalidates this marker.

On persisted pageshow, run the existing visible/hidden-policy resolution when
the document is visible. At the end of `onVisible`, **after** its shield/fade/
idle handling, consume the marker only for a still-attached, unlocked,
non-disposed owner. Expiry goes through existing `onExpiry`; a valid session
goes through the existing `chatView.attach(session)` contract.

If pageshow arrives before visibility becomes visible, retain the marker until
the visibility event runs the same policy path. Repeated pageshow/visibility
events cannot reopen twice. Shield restoration already uses the ordinary attach
path after the shield's own decision; actual detach clears our marker.

**Layer:** panel owns policy, expiry and owner lifetime. The call controller
must not independently resurrect a cached token. No new authority callback or
second lock state machine is introduced.

**Explicit tradeoff:** the existing attach contract also refreshes chat history,
signed media URLs and the SSE stream, as it does for token renewal. Only call
presence returns: no call ID, graph, mic or voiceCall suspension returns.
This avoids broadening the frozen view interface but performs an extra ordinary
chat refresh on a valid cache restore. That behavior must be checked with the
real chatView/thread integration; the measured fixture below replaces that
container while retaining the real panel and real call controller.

### L1 — Use the existing terminal path when audio construction throws

Replace `activateAudio`'s catch-only local teardown with `end(...)`.
On Answer, `end` captures the incoming ID, tears down locally, and declines it.
On Call before an invitation exists, it sends no invented call action.
The normal asynchronous preparation/permission failure paths remain unchanged.

**Layer:** controller failure ownership. The server should not infer a
construction failure from silence or rely on the 30-second ring timeout.

### L2 — Render microphone ownership and refresh it on the existing pulse

Include `isMicBusy()` in Call's disabled predicate and call the small existing
render function at each already-existing 100 ms pulse. This updates both Call
and Answer without waiting for presence. Keep the click-handler ownership
guard; the disabled state is an affordance, not authorization.

**Layer:** local UI state. No server changes, new polling timer or microphone
ownership API. Existing pulse cadence remains bounded at ten per second.

### C1 — Optional companion repair: coalesce queued presence snapshots

The parent named the duplicate-broadcast concern; current source and my new
trial confirm it. In `emit`, remove any queued presence snapshot before
appending its replacement, before evaluating the unchanged 16-control cap.
Never coalesce or drop terminal, consent, readiness or ping controls.

A connected survivor with 14 queued ping controls is currently removed when
its partner disconnects: terminal → first presence → duplicate presence crosses
the cap. With this change it stays present with exactly 16 controls, containing
one final presence. This also avoids exposing needless intermediate busy
snapshots after terminal cleanup.

**Layer:** bounded output queue semantics for replaceable state, not a larger
queue cap. At most 16 entries are scanned; no asynchronous buffering or new
worker. A queue genuinely full of nonreplaceable controls still overflows.

This is my first item to drop in MERGE if another proposal achieves one final
presence broadcast per outer transition with a smaller, equally proven change.
My measured fix is not privileged because it is mine.

## Exact production patch

This diff is against the exact candidate above. It was generated from the
same in-memory replacements used for the reported green trials. It is a
proposal artifact, not an applied parent-worktree change.

```diff
--- a/wixy_server/livechat/call_broker.py
+++ b/wixy_server/livechat/call_broker.py
@@ -148,6 +148,7 @@
 class Call:
     caller: str
     callee: str
+    request_id: str
     id: str = field(default_factory=lambda: uuid4().hex)
     state: str = "ringing"
     until: float = field(default_factory=lambda: time.monotonic() + 30)
@@ -179,6 +180,9 @@
     def emit(self, peer: Peer, message: JsonObject) -> None:
         if peer.closed:
             return
+        if message.get("type") == "presence":
+            # Presence is a current snapshot, not a history of intermediate states.
+            peer.controls = deque(m for m in peer.controls if m.get("type") != "presence")
         if len(peer.controls) >= 16:
             # Fail this socket now; unlink it once the enclosing transition completes.
             peer.closed = True
@@ -249,7 +253,10 @@
                 peer.sequence, peer.sample, peer.muted = -1, -480, False
                 # Invalidate already queued prepare/connected/lease controls too.
                 peer.controls = deque(m for m in peer.controls if m.get("callId") != call.id)
-                self.emit(peer, {"type": "ended", "callId": call.id, "reason": reason})
+                terminal: JsonObject = {"type": "ended", "callId": call.id, "reason": reason}
+                if key == call.caller:
+                    terminal["requestId"] = call.request_id
+                self.emit(peer, terminal)
         self.presence()

     @transition
@@ -309,7 +316,7 @@
                 # Correlated, so a crossing caller's loss never erases its incoming call.
                 self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
                 return
-            invited = self.call = Call(peer.id, target_peer.id)
+            invited = self.call = Call(peer.id, target_peer.id, request_id=command.requestId)
             self.emit(
                 peer,
                 {
@@ -378,6 +385,25 @@
         assert self.call and self.call.contains(peer)
         return self.peers[self.call.callee if peer.id == self.call.caller else self.call.caller]

+    def _media_other(self, peer: Peer, now: float) -> Peer | None:
+        """Called only inside a synchronous transition; no native work per frame."""
+        call = self.call
+        if call is None or call.state != "connected" or not call.contains(peer):
+            return None
+        if now >= call.until:
+            self.finish("timeout")
+            return None
+        other_id = call.callee if peer.id == call.caller else call.caller
+        other = self.peers.get(other_id)
+        if other is None:
+            self.finish("disconnected")
+            return None
+        if not self.permitted(peer) or not self.permitted(other):
+            # Preserve auth/grant deadlines for the route's close-code classification.
+            self.finish("unavailable")
+            return None
+        return other
+
     @transition
     def frame(self, peer: Peer, data: bytes) -> None:
         now = time.monotonic()
@@ -396,6 +422,9 @@
             or peer.muted
         ):
             raise ValueError("media permission")
+        receiver = self._media_other(peer, now)
+        if receiver is None:
+            return
         if seq <= peer.sequence or sample <= peer.sample or sample != seq * 480:
             raise ValueError("sample sequence")
         if seq - peer.sequence > 1000:
@@ -403,20 +432,21 @@
         peer.sequence, peer.sample = seq, sample
         if not any(n == lease and until > now for n, until in peer.capture_leases):
             return  # Stale TCP audio is discarded, never made fresh by receipt.
-        receiver = self.other(peer)
-        if not self.permitted(receiver) or receiver.playout[1] <= now:
+        if receiver.playout[1] <= now:
             return
         receiver.media.append((epoch, forward_frame(data, receiver.playout[0])))
         receiver.wake.set()

+    @transition
     def next_media(self, peer: Peer) -> bytes | None:
+        now = time.monotonic()
         call = self.call
-        if not self.permitted(peer) or not call or call.state != "connected":
+        if self._media_other(peer, now) is None:
             peer.media.clear()
             return None
+        assert call is not None
         if len(peer.outstanding) >= 5:
             return None
-        now = time.monotonic()
         while peer.media:
             epoch, data = peer.media.popleft()
             if epoch != call.id or peer.playout[1] <= now:
--- a/wixy_server/routes_livechat_calls.py
+++ b/wixy_server/routes_livechat_calls.py
@@ -223,8 +223,11 @@
             broker.connections -= 1
         if peer:
             broker.remove(peer)
-            if close_code != 1001 and (time.time() >= peer.deadline or peer.grant_until == 0):
-                close_code = 4401
+            if close_code != 1001:
+                if time.time() >= peer.deadline or peer.grant_until == 0:
+                    close_code = 4401
+                elif time.monotonic() >= peer.grant_until:
+                    close_code = 4408
         if accepted:
             try:
                 async with asyncio.timeout(0.25):
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -100,7 +100,7 @@
     const inCall = callId !== null;
     targets.hidden = inCall;
     callButton.hidden = inCall;
-    callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && targets.value === "");
+    callButton.disabled = deps.isMicBusy() || outgoingRequest !== null || (socket?.readyState === 1 && targets.value === "");
     acceptButton.hidden = state !== "incoming";
     acceptButton.disabled = answerPending || deps.isMicBusy();
     muteButton.hidden = state !== "connected";
@@ -179,10 +179,10 @@
         },
       );
       return true;
-    } catch { teardownCall("Calls unavailable in this browser"); return false; }
+    } catch { end("Calls unavailable in this browser"); return false; }
   }
   function pulse(): void {
-    if (state === "incoming") acceptButton.disabled = answerPending || deps.isMicBusy();
+    render(); // Recorder ownership can change without a presence event.
     const now = win.performance.now();
     const stale = now - lastPulse > LEASE_MS;
     lastPulse = now;
@@ -272,6 +272,9 @@
       if (outgoingRequest === null || m["requestId"] !== outgoingRequest) return;
       outgoingRequest = null;
       if (callId === null) teardownCall("That person is unavailable");
+    } else if (m["type"] === "ended" && callId === null && outgoingRequest !== null
+      && m["requestId"] === outgoingRequest) {
+      teardownCall("Call ended"); // Terminal before this request learned its call ID.
     } else if (m["callId"] !== callId || !callId) {
       return; // Late terminal/readiness messages cannot revive a canceled attempt.
     } else if (m["type"] === "prepare" && (state === "outgoing" || state === "incoming")) {
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
@@ -226,6 +226,7 @@
   }

   function detachChatView(): void {
+    restorePresencePending = false;
     if (!chatAttached) return;
     chatView?.detach();
     chatView?.element.remove();
@@ -1015,13 +1016,26 @@
    * chat's memory is about to be discarded anyway. A page that goes into the back/forward
    * cache (`persisted`) can be restored open, so it stays an ordinary background switch. */
   let unloading = false;
+  let restorePresencePending = false;

   function onPageHide(event: PageTransitionEvent): void {
     unloading = !event.persisted;
-  }
-
-  function onPageShow(): void {
+    restorePresencePending = event.persisted && chatAttached && state.kind === "chat";
+  }
+
+  function onPageShow(event: PageTransitionEvent): void {
     unloading = false;
+    if (event.persisted && !disposed && win.document.visibilityState !== "hidden") onVisible();
+  }
+
+  function restoreCachedPresence(): void {
+    if (!restorePresencePending || disposed || !chatAttached || state.kind !== "chat"
+      || session === null || win.document.visibilityState === "hidden") return;
+    restorePresencePending = false;
+    if (msUntilExpiry() <= 0) { onExpiry(); return; }
+    // Existing reattach contract refreshes chat/stream and only fresh call presence.
+    // No old call, microphone, graph or suspension is restored.
+    chatView?.attach(session);
   }

   function onHidden(): void {
@@ -1084,7 +1098,11 @@
     // Timers can stall while a page is in the background: if the idle period ran out while
     // away, lock NOW — instantly, with no fade a touch could cancel — instead of waiting for a
     // timer that may never have fired.
-    if (state.kind === "chat" && idleRanOutWhileAway()) dispatch({ type: "lock", cause: "idleAway" });
+    if (state.kind === "chat" && idleRanOutWhileAway()) {
+      dispatch({ type: "lock", cause: "idleAway" });
+      return;
+    }
+    restoreCachedPresence();
   }

   function onVisibilityChange(): void {
@@ -1113,6 +1131,7 @@
     element: root,
     teardown(): void {
       disposed = true;
+      restorePresencePending = false;
       // Routing away from `/admin/server` is itself one of R6's lock causes
       // — run it through the reducer (rather than skipping straight to
       // cleanup) so a mid-chat departure still detaches/aborts/pauses
```

## Measured red/green discriminators

The Python trial read the original module, optionally applied precisely the
above replacements to the string, registered an isolated module in
`sys.modules`, and executed it. It did not monkeypatch the candidate broker's
methods into giving desired results. All ordinary Call/Peer state transitions,
protocol models and packet encoding were the actual implementation.

The browser trial used esbuild `write:false` with source replacements supplied
through `onLoad`, then ran the compiled controller/panel under jsdom. It
supplied fake socket/audio resources at the existing dependency seams.
Broker controls for M1 came from the actual Python trial, with the same
originating request ID used by the controller. Both original and trial branches
were executed, not just expected results written down.

### M1 and the companion queue case

| Discriminator | Candidate RED | In-memory proposed GREEN |
|---|---|---|
| Target has 16 queued controls; caller sends invite; feed survivor controls to controller | No outgoing or request-correlated terminal; graph stops 0; busy true | Caller terminal includes its request ID; graph stops 1; busy false |
| Callee declines before caller's outgoing is drained; feed broker controls to controller | Graph stops 0; busy true | Graph stops 1; busy false |
| Losing outgoing becomes incoming; user Answers; old request's terminal arrives | Winning Answer retained | Winning Answer retained: two created graphs, only losing graph stopped, busy true |
| Pending invite receives terminal for a different request | Pending attempt retained | Pending attempt retained; no graph stop |
| Partner disconnects while survivor has 14 ping controls | Survivor removed; zero controls | Survivor alive; 16 controls, exactly one presence |

The negative glare control specifically has an adopted incoming ID, so the
new pre-epoch terminal branch is not allowed to run. Server-known epoch
terminal handling continues through the existing branch.

**Coverage limit:** these are actual broker-to-controller controls across two
in-memory runtimes, not a new real-browser/socket timing run. Writer ordering
and a real network backpressure test remain integration checks.

### M2

For each dequeue test, connect A/B, give B a valid receiver lease, issue A's
capture lease and queue a valid A frame. Cross the named boundary before
`next_media(B)`, without a prior `tick`.

| Boundary | Candidate RED/control | Proposed GREEN |
|---|---|---|
| Sender Access/unlock deadline expired | Sent; call still connected | Not sent; call finished |
| Sender confirmed grant revocation | Sent; call still connected | Not sent; call finished |
| Sender refresh deadline overdue, not revoked | Sent; call still connected | Not sent; call finished |
| Receiver authorization expired | Already not sent, but call not synchronously finished | Not sent; call finished |
| Receiver confirmed revocation | Already not sent, but call not synchronously finished | Not sent; call finished |
| Receiver refresh overdue | Already not sent, but call not synchronously finished | Not sent; call finished |
| Connected lifetime expired | Sent; call still connected | Not sent; call finished |
| New incoming PCM after connected lifetime expiry | One frame queued; call still connected | Zero frames queued; call finished |

A separate **route close-classification seam test** ran the real
`calls_socket`/finally logic with a controlled `run_peer` failure:

| Cause before media-permission exception | Candidate | Proposed |
|---|---:|---:|
| Refresh overdue | 4403 | 4408 |
| Grant explicitly revoked (`grant_until=0`) | 4401 | 4401 |
| Effective credential expired | 4401 | 4401 |
| Cancellation | 1001 | 1001 |

The route seam replaced only `run_peer` to deterministically raise at the
boundary. It does not establish timing of native grant checks; the existing
4/8 cancellation/timeout/native-work regressions must still be run on the
integrated patch. The new helper itself calls no native work.

**Retained limit:** bytes already submitted to transport/device cannot be
recalled. This fixes the authorization decision for still-unsent media.
It does not promise hard real-time scheduler deadlines.

### M3

Used the **actual panel, lock reducer, gesture/PIN flow and actual controller**,
with a small injected chat-view container delegating attach/detach/dispose to
that controller, fake socket creation, and no audio factory success.
Document visibility and persisted page transition events were injected.
The auth HTTP response and platform screen detection were fixtures.

| Scenario | Candidate | Proposed |
|---|---|---|
| Valid unlocked owner, both hidden policies ignore | 1 attach / 1 socket; calls hidden | 2 attaches / 2 sockets; calls visible |
| Pageshow first occurs while document still hidden, then becomes visible | Calls remain hidden | One fresh presence connection; calls visible |
| Default hidden policy locks | No restoration | No restoration |
| Manual Escape lock while cached | No restoration | No restoration |
| Token expired while cached; idle held separately to isolate expiry | No restoration | No restoration |
| Panel disposed before pageshow | No restoration | No restoration |
| Connected call enters cache, then valid restore | Old graph stops and idle suspension releases; calls remain hidden | Old graph stops and idle suspension releases; only presence returns |

The first six scenarios created **zero audio graphs**; their audio factory would
throw if invoked. An additional connected-call discriminator used a functioning
fake audio handle through the real consent/prepare/connected controls. Both red
and green created/started one graph, stopped it once on pagehide, and acquired
and released one voiceCall suspension. The green restored a second presence
socket with graph creation/start and suspension counts still exactly one: no
audio or suspension was reacquired. No restoration path sent a new invite or
accept. The marker is consumed once even when both pageshow and visibilitychange
arrive.

**Coverage limits:** actual chatView/thread refresh side effects, grant-backed
expiry renewal, the platform-dependent screen-detection/shield branch, actual
browser BFCache eligibility and physical device lifecycle are **UNEXECUTED**.
No synthetic event test certifies Safari or mobile background behavior.

### L1 and L2

| Discriminator | Candidate RED/control | Proposed GREEN |
|---|---|---|
| Incoming call; audio factory throws synchronously on Answer | Outbound types: auth only | Outbound types: auth, decline |
| Audio factory throws on Call before an invite exists | Auth only | Auth only; no fabricated terminal action |
| Recorder goes idle → busy without presence update | Call still enabled | Call disabled by next pulse |
| Same recorder goes busy → idle | Call enabled | Call enabled again by next pulse |
| Click while recorder busy | No invitation (existing guard) | No invitation (guard retained) |

**Limit:** factory-throw is a controlled resource-construction seam, not a
physical browser AudioContext exhaustion test. Immediate server release for
L1 uses the already-existing callee-decline transition; parent should also
exercise that path with two actual sockets.

## Validation status, honest limits and exact integration obligations

- Python sources from the proposed strings compile. Ruff check and Ruff format
  check through stdin both returned 0 for broker and route.
- esbuild successfully compiled the in-memory controller and panel together.
- The JavaScript TypeScript compiler-host attempt failed **before checking
  source**, because the installed TypeScript 7 package did not expose
  `ts.sys.readFile` on that API. Therefore **strict TypeScript is UNEXECUTED**,
  not green. Full mypy is also **UNEXECUTED** for the proposed source.
- An initial trial replacement had incorrect continuation indentation in
  `finish` and raised before completing the overflow green. The replacement
  was corrected and all reported red/green matrices rerun; the diff above is
  the corrected version. This failed trial is not counted as green.
- No full CI, blanket suite, real browser duplex rerun, bundle write or source
  edit was performed here. The previous audit's 43 server / 32 frontend passing
  suites apply to the original candidate only, not to these changes.

Parent integration must add focused regression assertions to
`test_livechat_call_repairs.py`, `callRepairs.test.ts` and
`panel.test.ts` matching these matrices. In particular:

1. Consume actual broker controls for early decline and invite overflow in the
   controller fixture; assert exactly one graph stop, onBusy(false), cleared
   pending invite and usable controls after fresh available presence.
2. Assert that a terminal for the losing outgoing request does not clear a
   newer incoming/preparing/connected Answer graph. Add wrong-request and
   known-epoch terminal controls.
3. At receive/dequeue boundaries, test both endpoints' absolute expiry, zero
   grant deadline, nonzero overdue refresh and connected lifetime. Assert no
   media or credits survive terminal cleanup, with no preceding tick.
4. Include the route's overdue-refresh exception path, real confirmed
   revocation, cancellation and native capacity failure. Require 4408/4401/
   1001/4429 respectively; do not collapse all failures to unauthorized.
5. Use the real chatView in an additional cache-restore test, including grant
   renewal during expiry and shield resolution. Assert presence-only behavior,
   no graph/mic/voiceCall reacquisition, preservation of draft state, and no
   restoration after actual lock/disposal.
6. Assert the Answer constructor failure releases the broker reservation
   without waiting for ring timeout; caller construction failure sends no
   call action. Check recorder availability changes without presence events.
7. Keep the 14-ping survivor regression if C1 is selected; retain genuine
   overflow tests for 16 nonreplaceable controls. Cap remains 16.

The existing Python accept-overflow test has an exact `ended` dictionary.
Where the survivor is caller A, update its expected envelope as follows (callee
expectations remain unchanged):

```python
ended = {"type": "ended", "callId": epoch, "reason": "disconnected"}
if peer is a:
    ended["requestId"] = "r"
assert ended in peer.controls
```

Do not loosen that assertion to an uncorrelated generic terminal.

**Exact documentation changes to accompany integration:**

- In `docs/ai/contracts.md`, change the server envelope description to
  `ended {callId,reason,requestId?}` and append:
  “The caller's ended envelope includes its original requestId. A client with
  no adopted call ID may retire only the matching pending outgoing request.
  A late outgoing terminal cannot affect a newer incoming/accepted call.”
- In `docs/ai/invariants.md` Inv 55, append:
  “Media admission and dequeue check both members' cached authorization and
  the connected lifetime without waiting for a monitor tick. Persisted-page
  restoration runs after owner lock/expiry policy and reconnects only fresh
  presence; actual detach/dispose prevents restoration.”
- In the voice-call section of `docs/ai/livechat.md`, document caller terminal
  correlation, the media pair gate, cached-page owner restoration through
  ordinary attach, and (if selected) replacement of queued presence snapshots.
- In `docs/ai/testing.md`, add the cache restore, terminal-before-outgoing and
  enqueue/dequeue deadline discriminators to the existing repair-test list.
- Rebuild LF bundles only after the source is integrated and strict checks
  pass. Source and generated assets must remain together in the frozen
  candidate. Do not represent this proposal's in-memory code as committed
  bundle proof.

## Precommit for MERGE

**Drop first:** C1's queue-coalescing implementation if a peer supplies a
smaller proven single-final-presence mechanism; do not keep both blindly.
Next most replaceable is M3's use of whole-view attach if a narrow presence-only
owner seam has better real integration evidence without retaining revoked
authority or duplicating policy.

**Defend hardest:** the M2 check of **both** cached authorities and lifetime at
the last unsent-media boundary, with operational versus revoked close
classification preserved. A monitor-only repair leaves the demonstrated gap.
Also retain M1's exact request correlation: broad unknown-terminal teardown
would trade an availability bug for destruction of a newer consented call.

My proposal has no privilege in the subsequent all-proposal MERGE. Prefer
discriminating coverage and smaller justified mechanisms, not agreement counts.

## Launch boundary

No proposal or component green certifies physical Android/iPad/iPhone browser
behavior, production hostname/Access/tunnel, 15-minute duplex/speakerphone
quality, latency/jitter/loss or actual Slots drain/hard-stop with blocked native
workers. Those gates remain open. Parent owns integration, a new frozen
candidate, fresh independent review and delivery.
