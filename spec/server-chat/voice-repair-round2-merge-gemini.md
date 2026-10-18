# Voice Repair Round 2 — All-Proposal MERGE (Gemini 4 Argon)

**Reviewer:** Gemini 4 Argon (High)
**Target commit:** `4983cc662730f1a18bd95a5337d9c1a1fc45cb1b` (`origin/cmd/workspace-00048`)
**Proposals Read & Merged (Zero Self-Privilege):**
- `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00048__wixy_implement-voip-voice-over-ip-for-wixy-ch/spec/server-chat/voice-repair-round2-proposal-astra.md` (Astra)
- `D:/Servers/Cmd/Storage/clones/wixy__worktrees/00050__wixy_group-therapy-propose-reviewer-gemini-fo/spec/server-chat/voice-repair-round2-proposal-gemini.md` (Gemini)

---

## Executive Resolution of the Five Merge Splits

| Issue | Selected Mechanism | Adopted From | Rejected Mechanism & Why |
|---|---|---|---|
| **M1** | **Server:** Always include `"requestId": call.request_id` on the caller's `ended` envelope (`if key == call.caller and call.request_id:`).<br>**Client:** When `m["type"] === "ended" && m["callId"] !== callId` and `outgoingRequest !== null && m["requestId"] === outgoingRequest`, always clear `outgoingRequest = null`, and call `teardownCall(...)` only when `callId === null`. Also guard `callButton` click with `outgoingRequest !== null`. | **Server:** Astra (unconditional caller correlation).<br>**Client:** Gemini (clears `outgoingRequest` even if glare `incoming` set `callId`, while tearing down only if `callId === null`). | **Rejected:** Gemini's server-side `had_outgoing` gate (which only attached `requestId` when `outgoing` was still in `peer.controls`). If the caller's writer coroutine already popped `outgoing` from `peer.controls` (`popleft()`) but had not completed delivery/adoption when `finish()` ran, gating on `had_outgoing` omitted `requestId`. Updating the existing test assertion in `test_accept_overflow_is_a_clean_transition` (`if peer is a: ended["requestId"] = "r"`) is cleaner and covers all races.<br>**Rejected:** Astra's client-side `callId === null` outer condition on clearing `outgoingRequest`, which left `outgoingRequest` non-null when a crossing `incoming` call had already set `callId` before the losing request's `ended` arrived. |
| **M2** | **Server broker:** Shared `_media_other(self, peer: Peer, now: float) -> Peer \| None` helper called from both `@transition frame()` and `@transition next_media()` before sequence/credit mutation, checking `self.permitted(peer)`, `call.state == "connected"`, `now < call.until`, and `self.permitted(other)` — calling **`self.remove(...)`** (not `self.finish("unavailable")`) on whichever endpoint failed `self.permitted(...)` and `self.finish("timeout")` when `now >= call.until`.<br>**Server route:** In `calls_socket` `finally:`, classify `time.time() >= peer.deadline or peer.grant_until == 0` as `4401` and `time.monotonic() >= peer.grant_until` as `4408` when `close_code != 1001`. | **Structure & placement:** Astra (`_media_other` shared helper + `routes_livechat_calls.py` `4401`/`4408` split).<br>**Expired-endpoint action:** Gemini (`self.remove(...)` on the unpermitted peer instead of `self.finish("unavailable")`). | **Rejected:** Astra's `self.finish("unavailable")` when `not self.permitted(peer) or not self.permitted(other)`. Calling `finish("unavailable")` without `remove(unpermitted_peer)` leaves the expired/revoked peer in `self.peers` with `closed == False`, emits `ended` + `presence` to the unauthorized socket, and broadcasts the unauthorized peer as `"available": True` in `presence` to surviving peers until the next 100 ms `monitor()` tick. Calling `self.remove(unpermitted_peer)` immediately unlinks it from `self.peers`, finishes the call, wakes its writer to exit, and preserves `peer.deadline` and `peer.grant_until` untouched for the route's `4401`/`4408` close classification.<br>**Rejected:** Gemini's duplicated inline checks in `frame()` and `next_media()`, and Gemini's inaccurate prose comment about `assert_invariants()` / 1 Hz monitor cadence (actual `monitor()` in `routes_livechat_calls.py:98-106` runs `broker.tick(peer)` every `0.1` s and `ping` every 20 ticks; `grants()` refreshes every `2` s with a `2.5` s monotonic lease; `@transition` tracks `self.depth` and drains `self.evicting`). |
| **M3** | **Owner-validated recovery in `panel.ts`:** Keep `controller.ts`'s `pagehide()` as an unconditional `detach()`. In `panel.ts`, record `restorePresencePending = event.persisted && chatAttached && state.kind === "chat"` in `onPageHide`, clear it on `detachChatView()` and `teardown()`, trigger `onVisible()` from `onPageShow` when `event.persisted && !disposed && win.document.visibilityState !== "hidden"`, and at the end of `onVisible()` (after `shielded`, `fading`, `decoy`, and `idleRanOutWhileAway()` gates) run `restoreCachedPresence()` which checks `msUntilExpiry() <= 0` (`onExpiry()`) and calls `chatView?.attach(session)`. | **Adopted:** Astra's `panel.ts` owner-validated recovery. | **Rejected:** Gemini's independent `pageshow`/`visibilitychange` listener inside `controller.ts`. An independent controller listener has no visibility into `panel.ts`'s `state.kind` (`"shielded"`, `"fading"`), `idleRanOutWhileAway()`, or device-grant silent renewal (`onExpiry() -> renewSession("expiry")`), and under adverse listener order or `pageshow`-before-`visibilitychange` can open a presence socket before `panel.ts` locks or shields, or permanently detach an expired token that `panel.ts` was about to silently renew via an active device grant. Using `chatView?.attach(session)` also keeps `admin-ui/src/server/types.ts` (`ServerChatView` frozen interface) untouched and recovers the SSE stream after BFCache freeze. |
| **L1** | In `controller.ts`, change `activateAudio()`'s `catch` block from `teardownCall("Calls unavailable in this browser")` to `end("Calls unavailable in this browser")`. | **Identical in both proposals** (Astra & Gemini). | **Rejected:** None (both proposals converged on the exact same 1-line fix). |
| **L2** | In `controller.ts`, scope `deps.isMicBusy()` inside the connected-socket clause of `render()`:<br>`callButton.disabled = outgoingRequest !== null \|\| (socket?.readyState === 1 && (targets.value === "" \|\| deps.isMicBusy()));`<br>and call `render();` at the top of `pulse()`. | **Combined synthesis** (Astra's `render()` in `pulse()` + merge-brief gap resolution scoping `deps.isMicBusy()` to `socket?.readyState === 1`). | **Rejected:** Putting `deps.isMicBusy()` outside `socket?.readyState === 1` (present in both Round 2 proposals). When the socket is disconnected (`socket === null`, `timer === null`), `callButton` is `"Reconnect calls"` whose click handler (`if (!socket \|\| socket.readyState !== 1) { if (session) open(session, label); return; }`) only opens the presence WebSocket and never touches the microphone. Gating `deps.isMicBusy()` outside `socket?.readyState === 1` can leave `"Reconnect calls"` permanently disabled if a voice-note recording starts and stops while the call socket is disconnected (since `pulse()` is not running while `socket === null`). Scoping `deps.isMicBusy()` inside `socket?.readyState === 1` avoids gating reconnection and eliminates the dead-pulse state with zero extra timers or API plumbing. |
| **C1** | **Avoid duplicate `presence()` broadcasts at source (`_drop` and `Invite`) instead of stripping `"presence"` in `emit()`.**<br>In `_drop(peer)`: `had_call = bool(self.call and self.call.contains(peer))`; only call `self.presence()` at the end of `_drop` `if not had_call:` (because `self.finish("disconnected")` already called `self.presence()` after `del self.peers[peer.id]`).<br>In `Invite`: only call `self.presence()` `if not peer.closed and not target_peer.closed:` (if `outgoing` or `incoming` overflowed, `_drop` at the end of `@transition` will call `finish("disconnected") -> self.presence()`). | **Refinement of Astra's C1** (verified **MEASURED-KNOWING** against `wixy_server/tests/test_livechat_call_repairs.py`). | **Rejected:** Astra's `if message.get("type") == "presence": peer.controls = deque(m for m in peer.controls if m.get("type") != "presence")` in `emit()`. **MEASURED-KNOWING discriminator:** Running `pytest wixy_server/tests/test_livechat_call_repairs.py` on Astra's `emit()` change **FAILS `test_connected_and_presence_overflow_are_clean_transitions` at line 364** (`AssertionError: assert b.closed and not c.closed and list(broker.peers) == [c.id]`) because line 360 (`b.controls.extend({"type": "ping"} for _ in range(16 - len(b.controls)))`) pads a queue that already contains a `"presence"` from `finish()` to 16 items and tests that `broker.add(c)` (`self.presence()`) overflows and evicts `b`! Avoiding the redundant second `self.presence()` in `_drop()` and the doomed intermediate `self.presence()` in `Invite` keeps the 14-ping survivor alive on partner disconnect (`b.closed is (fill_b >= 15)`) while keeping `test_connected_and_presence_overflow_are_clean_transitions` 100% green! |

---

## Detailed Resolution of Merge Brief Splits (1–5)

### 1. M1: Unconditional Caller `ended.requestId` vs. `had_outgoing` Gate
- **Decision:** Always include `"requestId": call.request_id` on `call.caller`'s `ended` envelope in `CallBroker.finish()`, and update `test_accept_overflow_is_a_clean_transition` in `wixy_server/tests/test_livechat_call_repairs.py` so caller `a`'s expected `ended` dict includes `"requestId": "r"`.
- **Why:** In `routes_livechat_calls.py`, `write()` pops controls with `message = peer.controls.popleft()` before `await ws.send_json(message)`. If `finish()` runs after `outgoing` was popped from `peer.controls` (or if `outgoing` was purged before `popleft()`), unconditional caller correlation guarantees the caller's `ended` envelope always carries `requestId`.
- **Client safety (`controller.ts`):**
  ```ts
  } else if (m["type"] === "ended" && m["callId"] !== callId) {
    if (outgoingRequest !== null && m["requestId"] === outgoingRequest) {
      outgoingRequest = null;
      if (callId === null) {
        teardownCall(
          m["reason"] === "unavailable" || m["reason"] === "disconnected"
            ? "That person is unavailable"
            : "Call ended",
        );
      }
    }
    return;
  }
  ```
  - **Early decline / target overflow before `outgoing`:** `callId === null` and `m["requestId"] === outgoingRequest` -> clears `outgoingRequest = null`, stops the empty `CallAudio` graph, calls `deps.onBusy(false)`, and restores the `Call` button.
  - **Writer dequeued `outgoing` and delivered it before `ended`:** `callId` equals `m["callId"]`, so `m["callId"] !== callId` is false and the normal `else if (m["type"] === "ended") { teardownCall("Call ended"); }` branch tears down the call.
  - **Wrong `requestId`:** `m["requestId"] !== outgoingRequest` -> ignored; pending attempt is untouched.
  - **Glare (crossing `incoming` won and set `callId`, or user already clicked `Answer`):** `callId !== null` and `m["callId"] !== callId` -> `outgoingRequest` is retired (`outgoingRequest = null`), and `if (callId === null)` prevents `teardownCall(...)`, so the winning incoming/preparing/connected call and its Answer audio graph survive untouched.

### 2. M2: Shared `_media_other` Gate + `self.remove` on Expired Endpoint + Route Close Codes
- **Decision:** Centralize the connected-pair, lifetime, and dual-member authority check in `CallBroker._media_other(self, peer: Peer, now: float) -> Peer | None`, called from both `@transition frame()` and `@transition next_media()`.
- **Why `self.remove(expired_peer)` instead of `self.finish("unavailable")`:**
  - When `not self.permitted(peer)` or `not self.permitted(other)` is detected at media admission or dequeue, that endpoint's credential has expired (`time.time() >= deadline`), its device grant was confirmed revoked (`grant_until == 0`), or its 2.5 s grant-refresh lease expired (`time.monotonic() >= grant_until`).
  - Calling `self.remove(...)` (which runs `_drop(...)`) unlinks the unpermitted peer from `self.peers` **before** calling `self.finish("disconnected")`, so:
    1. No `ended` or `presence` control is queued to the unpermitted peer.
    2. Surviving peers receive a single accurate `presence` snapshot with the unpermitted peer already removed (never advertising an expired/revoked peer as `"available": True`).
    3. `unpermitted_peer.closed = True` and `unpermitted_peer.wake.set()` wake its `write()` loop immediately so its socket closes right away instead of waiting for the 100 ms `monitor()` tick.
    4. Neither `deadline` nor `grant_until` is modified by `remove()`, so `calls_socket`'s `finally:` block classifies `time.time() >= peer.deadline or peer.grant_until == 0` -> `4401`, `time.monotonic() >= peer.grant_until` -> `4408`, `CancelledError` -> `1001`, and `CallCapacityError` -> `4429`.
- **Zero native work per frame:** `_media_other` reads only in-memory floats (`peer.deadline`, `peer.grant_until`, `call.until`).

### 3. M3: Owner-Validated `panel.ts` Recovery vs. Independent `controller.ts` Recovery
- **Decision:** Adopt Astra's owner-validated recovery in `admin-ui/src/server/panel.ts` (`restorePresencePending` + `onPageShow` + `onVisible() -> restoreCachedPresence() -> chatView?.attach(session)`), leaving `controller.ts`'s `pagehide()` as an unconditional `detach()`.
- **Why:**
  1. `panel.ts` owns all lock, shield, fading, `idleRanOutWhileAway()`, and `onExpiry()` / `renewSession("expiry")` policies. Keeping `controller.ts` passive (`pagehide -> detach()`, reconnect only when `attach()` is called by its owner) guarantees `controller.ts` can **never** open a presence WebSocket before `panel.ts` evaluates lock/shield/idle/expiry policy, under either listener registration order or when `pageshow` fires while `document.visibilityState === "hidden"`.
  2. When `msUntilExpiry() <= 0` upon BFCache restore, `panel.ts` runs `onExpiry()`, which silently re-mints the token via `renewSession("expiry") -> adoptSession()` when a bound device grant is active, or locks with `"expired"` otherwise.
  3. Calling `chatView?.attach(session)` uses the existing frozen `ServerChatView.attach` re-attach contract (`admin-ui/src/server/types.ts:104-110`), preserving draft text and in-flight uploads while reopening the SSE stream and re-attaching `calls` presence (`calls.attach(session, identity.getName() ?? "Device")`).

### 4. L1 & L2: Constructor Failure Decline + Microphone Busy Affordance Without Gating Reconnect
- **Decision:**
  - **L1:** `activateAudio()`'s `catch` block calls `end("Calls unavailable in this browser")`. On `Answer` (`state === "incoming"`, `callId !== null`), `end()` tears down locally first and sends `{ type: "decline", callId }`. On `Call` before `invite` (`callId === null`, `outgoingRequest === null`), `end()` tears down locally and sends nothing.
  - **L2:** In `render()`, set:
    ```ts
    callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && (targets.value === "" || deps.isMicBusy()));
    ```
    and call `render()` at the start of `pulse()`.
  - **Why this resolves the disconnected-pulse / Reconnect gap:** When `socket?.readyState === 1`, the 100 ms `pulse()` timer is active and `callButton` is `"Call"`, so `deps.isMicBusy()` disables and re-enables `"Call"` within 100 ms without waiting for a `presence` frame. When the socket is disconnected (`socket === null`, `timer === null`), `callButton` is `"Reconnect calls"`, whose click handler only opens the presence WebSocket (`open(session, label)`) and never touches the microphone; scoping `deps.isMicBusy()` inside `socket?.readyState === 1` ensures `"Reconnect calls"` is never stranded disabled while `pulse()` is stopped.

### 5. C1: Avoiding Duplicate `presence` Broadcasts Without Breaking 16-Control Overflow
- **Decision:** Avoid emitting the duplicate `self.presence()` in `_drop(peer)` when `had_call` is true (`self.finish("disconnected")` already called `self.presence()` after `del self.peers[peer.id]`), and in `Invite` only call `self.presence()` when `not peer.closed and not target_peer.closed`.
- **Why (MEASURED-KNOWING):**
  - Stripping `m.get("type") != "presence"` inside `emit()` (Astra's C1) broke `test_connected_and_presence_overflow_are_clean_transitions` (`wixy_server/tests/test_livechat_call_repairs.py:364`) because that test extends a peer's `controls` (which already contains a `"presence"` from `finish()`) with `ping`s to length 16 and asserts that `broker.add(c)` (`self.presence()`) overflows and evicts that peer.
  - Eliminating the redundant second `self.presence()` in `_drop(peer)` (`if not had_call: self.presence()`) and skipping the intermediate `self.presence()` in `Invite` when `peer.closed or target_peer.closed` ensures each outer transition emits at most **one** final `presence` snapshot (saving the 14-ping survivor when its partner disconnects: `b.closed is (fill_b >= 15)`), while preserving genuine 16-control overflow in `test_connected_and_presence_overflow_are_clean_transitions`!

---

## Exact Merged Production & Test Diff (`4983cc6`)

All diffs below were applied and verified (**MEASURED-KNOWING**) in isolated worktree `00050` against `4983cc6`, then reverted so the checkout remains clean.

```diff
diff --git a/wixy_server/livechat/call_broker.py b/wixy_server/livechat/call_broker.py
index 37b8595..4fe03b7 100644
--- a/wixy_server/livechat/call_broker.py
+++ b/wixy_server/livechat/call_broker.py
@@ -148,6 +148,7 @@ class Peer:
 class Call:
     caller: str
     callee: str
+    request_id: str = ""
     id: str = field(default_factory=lambda: uuid4().hex)
     state: str = "ringing"
     until: float = field(default_factory=lambda: time.monotonic() + 30)
@@ -249,7 +250,10 @@ class CallBroker:
                 peer.sequence, peer.sample, peer.muted = -1, -480, False
                 # Invalidate already queued prepare/connected/lease controls too.
                 peer.controls = deque(m for m in peer.controls if m.get("callId") != call.id)
-                self.emit(peer, {"type": "ended", "callId": call.id, "reason": reason})
+                terminal: JsonObject = {"type": "ended", "callId": call.id, "reason": reason}
+                if key == call.caller and call.request_id:
+                    terminal["requestId"] = call.request_id
+                self.emit(peer, terminal)
         self.presence()

     @transition
@@ -263,7 +267,8 @@ class CallBroker:
             return
         peer.closed = True
         del self.peers[peer.id]
-        if self.call and self.call.contains(peer):
+        had_call = bool(self.call and self.call.contains(peer))
+        if had_call:
             self.finish("disconnected")
         peer.media.clear()
         peer.outstanding.clear()
@@ -272,7 +277,8 @@ class CallBroker:
         peer.last_terminal = None
         peer.controls.clear()
         peer.wake.set()
-        self.presence()
+        if not had_call:
+            self.presence()

     @transition
     def shutdown(self) -> None:
@@ -309,7 +315,7 @@ class CallBroker:
                 # Correlated, so a crossing caller's loss never erases its incoming call.
                 self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
                 return
-            invited = self.call = Call(peer.id, target_peer.id)
+            invited = self.call = Call(peer.id, target_peer.id, request_id=command.requestId)
             self.emit(
                 peer,
                 {
@@ -320,7 +326,8 @@ class CallBroker:
                 },
             )
             self.emit(target_peer, {"type": "incoming", "callId": invited.id, "peer": peer.label})
-            self.presence()
+            if not peer.closed and not target_peer.closed:
+                self.presence()
             return
         call = self.call
         if call is not None and now >= call.until:
@@ -378,11 +385,35 @@ class CallBroker:
         assert self.call and self.call.contains(peer)
         return self.peers[self.call.callee if peer.id == self.call.caller else self.call.caller]

+    def _media_other(self, peer: Peer, now: float) -> Peer | None:
+        """Called only inside a synchronous transition; no native work per frame."""
+        if not self.permitted(peer):
+            self.remove(peer)
+            return None
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
+        if not self.permitted(other):
+            self.remove(other)
+            return None
+        return other
+
     @transition
     def frame(self, peer: Peer, data: bytes) -> None:
         now = time.monotonic()
         epoch, seq, sample, lease = unpack_frame(data)
-        if not self.permitted(peer) or not peer.media_budget.take(now):
+        if not self.permitted(peer):
+            self.remove(peer)
+            raise ValueError("media permission")
+        if not peer.media_budget.take(now):
             raise ValueError("media permission")
         if epoch == peer.last_terminal:
             return  # Former-pair in-flight audio is discarded, never rerouted.
@@ -396,6 +427,9 @@ class CallBroker:
             or peer.muted
         ):
             raise ValueError("media permission")
+        receiver = self._media_other(peer, now)
+        if receiver is None:
+            return
         if seq <= peer.sequence or sample <= peer.sample or sample != seq * 480:
             raise ValueError("sample sequence")
         if seq - peer.sequence > 1000:
@@ -403,20 +437,21 @@ class CallBroker:
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
diff --git a/wixy_server/routes_livechat_calls.py b/wixy_server/routes_livechat_calls.py
index 99c1cf4..c5b4d83 100644
--- a/wixy_server/routes_livechat_calls.py
+++ b/wixy_server/routes_livechat_calls.py
@@ -223,8 +223,11 @@ async def calls_socket(ws: WebSocket) -> None:
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
diff --git a/admin-ui/src/server/call/controller.ts b/admin-ui/src/server/call/controller.ts
index 5f569f4..af3e17d 100644
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -35,7 +35,7 @@ export function createCallController(deps: CallDeps) {
   targets.addEventListener("change", () => { selectedTarget = targets.value || null; render(); });
   const callButton = button("Call", () => {
     if (!socket || socket.readyState !== 1) { if (session) open(session, label); return; }
-    if (!targets.value || deps.isMicBusy() || callId) return;
+    if (!targets.value || deps.isMicBusy() || callId || outgoingRequest !== null) return;
     if (!activateAudio()) return;
     deps.onBusy(true);
     outgoingRequest = crypto.randomUUID();
@@ -100,7 +100,7 @@ export function createCallController(deps: CallDeps) {
     const inCall = callId !== null;
     targets.hidden = inCall;
     callButton.hidden = inCall;
-    callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && targets.value === "");
+    callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && (targets.value === "" || deps.isMicBusy()));
     acceptButton.hidden = state !== "incoming";
     acceptButton.disabled = answerPending || deps.isMicBusy();
     muteButton.hidden = state !== "connected";
@@ -179,10 +179,10 @@ export function createCallController(deps: CallDeps) {
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
@@ -272,6 +272,18 @@ export function createCallController(deps: CallDeps) {
       if (outgoingRequest === null || m["requestId"] !== outgoingRequest) return;
       outgoingRequest = null;
       if (callId === null) teardownCall("That person is unavailable");
+    } else if (m["type"] === "ended" && m["callId"] !== callId) {
+      if (outgoingRequest !== null && m["requestId"] === outgoingRequest) {
+        outgoingRequest = null;
+        if (callId === null) {
+          teardownCall(
+            m["reason"] === "unavailable" || m["reason"] === "disconnected"
+              ? "That person is unavailable"
+              : "Call ended",
+          );
+        }
+      }
+      return;
     } else if (m["callId"] !== callId || !callId) {
       return; // Late terminal/readiness messages cannot revive a canceled attempt.
     } else if (m["type"] === "prepare" && (state === "outgoing" || state === "incoming")) {
diff --git a/admin-ui/src/server/panel.ts b/admin-ui/src/server/panel.ts
index d231537..3efade8 100644
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
@@ -226,6 +226,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
   }

   function detachChatView(): void {
+    restorePresencePending = false;
     if (!chatAttached) return;
     chatView?.detach();
     chatView?.element.remove();
@@ -1015,13 +1016,37 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
    * chat's memory is about to be discarded anyway. A page that goes into the back/forward
    * cache (`persisted`) can be restored open, so it stays an ordinary background switch. */
   let unloading = false;
+  let restorePresencePending = false;

   function onPageHide(event: PageTransitionEvent): void {
     unloading = !event.persisted;
+    restorePresencePending = event.persisted && chatAttached && state.kind === "chat";
   }

-  function onPageShow(): void {
+  function onPageShow(event: PageTransitionEvent): void {
     unloading = false;
+    if (event.persisted && !disposed && win.document.visibilityState !== "hidden") onVisible();
+  }
+
+  function restoreCachedPresence(): void {
+    if (
+      !restorePresencePending ||
+      disposed ||
+      !chatAttached ||
+      state.kind !== "chat" ||
+      session === null ||
+      win.document.visibilityState === "hidden"
+    ) {
+      return;
+    }
+    restorePresencePending = false;
+    if (msUntilExpiry() <= 0) {
+      onExpiry();
+      return;
+    }
+    // Existing reattach contract refreshes chat/stream and only fresh call presence.
+    // No old call, microphone, graph or suspension is restored.
+    chatView?.attach(session);
   }

   function onHidden(): void {
@@ -1084,7 +1109,11 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
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
@@ -1113,6 +1142,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
     element: root,
     teardown(): void {
       disposed = true;
+      restorePresencePending = false;
       // Routing away from `/admin/server` is itself one of R6's lock causes
       // — run it through the reducer (rather than skipping straight to
       // cleanup) so a mid-chat departure still detaches/aborts/pauses
diff --git a/wixy_server/tests/test_livechat_call_repairs.py b/wixy_server/tests/test_livechat_call_repairs.py
index ddaf374..0405edd 100644
--- a/wixy_server/tests/test_livechat_call_repairs.py
+++ b/wixy_server/tests/test_livechat_call_repairs.py
@@ -325,7 +325,7 @@ def test_invite_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None
             assert not [m for m in survivor.controls if m["type"] in ("incoming", "outgoing")]


-@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 14), (16, 0), (0, 16)])
+@pytest.mark.parametrize(("fill_a", "fill_b"), [(16, 15), (16, 14), (16, 0), (0, 16)])
 def test_accept_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None:
     broker, (a, b) = _peers()
     broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
@@ -335,12 +335,14 @@ def test_accept_overflow_is_a_clean_transition(fill_a: int, fill_b: int) -> None
     _fill(b, fill_b)
     broker.command(b, CallAction(type="accept", callId=epoch))
     assert broker.call is None
-    assert a.closed is (fill_a == 16) and b.closed is (fill_b >= 14)
+    assert a.closed is (fill_a == 16) and b.closed is (fill_b >= 15)
     for peer in (a, b):
         stale = [m for m in peer.controls if m.get("callId") == epoch and m["type"] != "ended"]
         assert not stale
         if not peer.closed:
-            ended = {"type": "ended", "callId": epoch, "reason": "disconnected"}
+            ended: dict[str, object] = {"type": "ended", "callId": epoch, "reason": "disconnected"}
+            if peer is a:
+                ended["requestId"] = "r"
             assert ended in peer.controls
```

---

## Evidence Classification & Remaining Integration Discriminators

### Executed by This Reviewer on the Combined Patch (**MEASURED-KNOWING**)
- `pytest wixy_server/tests/test_livechat_calls.py wixy_server/tests/test_livechat_call_repairs.py -n 0 -q --tb=short`: **`44 passed, 4 warnings in 9.77s`** (including `(16, 15)` and `(16, 14)` in `test_accept_overflow_is_a_clean_transition` and `test_connected_and_presence_overflow_are_clean_transitions`).
- `mypy wixy_server/livechat/call_broker.py wixy_server/routes_livechat_calls.py wixy_server/tests/test_livechat_call_repairs.py`: **`Success: no issues found in 3 source files`**.
- `ruff check wixy_server/livechat/call_broker.py wixy_server/routes_livechat_calls.py wixy_server/tests/test_livechat_call_repairs.py`: **`All checks passed!`**.
- `npx vitest run tests/server/call.test.ts tests/server/callAudio.test.ts tests/server/callRepairs.test.ts tests/server/callWorklet.test.ts tests/server/panelGrant.test.ts`: **`5 passed (5), 220 passed (220)`**.
- `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.sw.json` in `admin-ui/`): **exit code `0`** (resolving Astra's unexecuted `tsc` gap).

### Cited from Peer Proposal (**CITED**)
- Astra's in-memory `panel.ts` + `controller.ts` 7-scenario BFCache matrix (`voice-repair-round2-proposal-astra.md` §M3) and route close-code seam table (`4408` / `4401` / `1001` / `4429`).

### Remaining Parent Integration Obligations & Unexecuted Gates
1. **Regression tests to commit in parent workspace 48:**
   - Add the Round 2 `M1` + `M2` tests to `wixy_server/tests/test_livechat_call_repairs.py` (covering target-overflow on `Invite`, early `decline` before `outgoing` drain, writer-popped `outgoing` race, both endpoints' `deadline` / `grant_until == 0` / overdue `0 < grant_until <= monotonic`, connected `call.until` expiry before `next_media()` and `frame()`, and route `4408` vs `4401` close-code classification).
   - Add the Round 2 `M1`, `L1`, and `L2` tests to `admin-ui/tests/server/callRepairs.test.ts` (including glare safety when `callId !== null`, wrong `requestId`, `Answer` constructor throw declining immediately, `Call` constructor throw sending nothing, `Call` disabling/enabling on `pulse()` as `isMicBusy()` toggles, and `"Reconnect calls"` remaining enabled when `socket === null` after recording stops).
   - Add the Round 2 `M3` persisted `pagehide`/`pageshow` recovery test (including `pageshow`-while-hidden followed by `visibilitychange -> visible`, lock/expiry/dispose negative controls, and active-call teardown on `pagehide` with presence-only restore) to `admin-ui/tests/server/panelGrant.test.ts` (or `panel.test.ts`).
2. **LF Bundle Rebuild & Docs:**
   - Update `docs/ai/contracts.md`, `docs/ai/invariants.md` (Inv 55), `docs/ai/livechat.md`, and `docs/ai/testing.md` as specified in Astra's doc list.
   - Ensure LF line endings and run `npm run build` in `admin-ui/` so committed bundles in `wixy_server/static/admin/` have zero drift.
3. **Unexecuted Physical / Deployment Gates (Honest Label: UNEXECUTED):**
   - Real Android Chrome / iPad Safari / iPhone browser BFCache and WebAudio/AudioWorklet lifecycle, production tunnel/Access, 15-minute duplex audio quality, and Slots drain/hard-stop remain post-integration gates.
