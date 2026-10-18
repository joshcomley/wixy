# Group Therapy Round 2 — Independent PROPOSE (Gemini 4 Argon)

**Reviewer:** Gemini 4 Argon (High)
**Target commit:** `4983cc662730f1a18bd95a5337d9c1a1fc45cb1b` (`origin/cmd/workspace-00048`)
**Scope:** Independent code + test repairs for all five Round 2 audit findings (`M1`, `M2`, `M3`, `L1`, `L2`) from `voice-call-implementation-audit-round2.md` and `voice-repair-round2-brief.md`.

---

## Pre-Commitment: Drop First vs. Defend Hardest

- **Drop first in MERGE (if a peer has a cleaner equivalent):** **L2 (`Call` button `disabled` refresh inside `pulse()`)** or **M3 (`visibilitychange` secondary listener alongside `pageshow`)**.
  - *Why:* For L2, polling `deps.isMicBusy()` inside the existing 100 ms `pulse()` loop alongside `render()` is zero-plumbing and immediate (<100 ms), but if a peer wires an explicit callback from `panel.ts`'s voice-note recorder start/stop into the call controller (e.g. `calls.refresh()`), I will happily adopt the event-driven notification or keep both. Similarly for M3, if a peer places all `pageshow` call-presence re-attachment directly inside `panel.ts`'s `onPageShow()` (calling `calls.attach(state.session, currentCallDeviceLabel())` when `state.kind === "chat"` after verifying `!idleRanOutWhileAway()` and `msUntilExpiry() > 0`) together with `controller.ts` `pageshow` handling, either decomposition is clean so long as both standalone `createCallController` and `panel.ts` enforce session/idle/lock gates.
- **Defend hardest in MERGE:** **M2 (dual-member authority + call-lifetime enforcement on both `frame()` admission and `next_media()` dequeue, with `@transition` on `next_media` and `4401` vs `4408` close-code separation)** and **M1 (request-correlated terminal recovery when `finish()` purges an unsent `outgoing` control)**.
  - *Why (M2):* Checking only `self.permitted(peer)` on the caller of `next_media(receiver)` leaves already-queued frames from a sender whose `deadline` or `grant_until` expired after `frame()` admission deliverable to the receiver until a 1 Hz `tick()` happens to run—and fails to call `self.remove(expired_peer)`, leaving `broker.call` alive and `peer.media`/`peer.outstanding` populated. Making `next_media` a `@transition` method and checking `self.permitted` on **both** call members plus `now >= call.until` in both `frame()` and `next_media()` (using only cached in-memory timestamps `peer.deadline`, `peer.grant_until`, and `call.until`—zero SQLite/network I/O on the media path) closes the authority and 2-hour lifetime window completely.
  - *Why (M1):* Preserving `test_accept_overflow_is_a_clean_transition` (which asserts `{"type": "ended", "callId": epoch, "reason": "disconnected"} in peer.controls` when `outgoing` was already drained) while fixing the caller hang when `outgoing` is still queued in `peer.controls` requires detecting `had_outgoing` **before** `finish()` purges `peer.controls` and attaching `"requestId": call.request_id` to `ended` when an unsent `outgoing` was purged. On the client, `controller.ts` must clear `outgoingRequest` on a matching `ended.requestId`, and only call `teardownCall(...)` when `callId === null` so a crossing glare `incoming` call that already won and set `callId` is never clobbered.

---

## Cross-Layer & Invariant Verification Summary

All five repairs preserve the non-negotiable voice-call invariants:
1. **Explicit 2-party socket consent & 3rd-device isolation:** No repair broadcasts audio, ring state, or prompts to a third unlocked browser/tab under the same login.
2. **In-memory only:** Zero persistence, zero SQLite/disk touches on media admission/dequeue, zero transcript/history rows.
3. **Idle-lock & expiry discipline:** Only `connected` (or `muted` while connected) and active `getUserMedia` permission prompts hold dedicated idle-lock suspensions (`voiceCall`, `voiceCallPermission`). `pagehide` immediately ends any active call and releases both suspensions; `pageshow` restores only idle presence (`open(session, label)`) when the session is still unlocked and unexpired, and never auto-dials or auto-answers.

### Measured Verification Summary (Isolated Worktree `00050` on `4983cc6`)

- **RED (unmodified `4983cc6` with new Round 2 discriminator tests):**
  - Python (`pytest wixy_server/tests/test_livechat_call_repairs.py -n 0 -q --tb=short`): **`2 failed, 19 passed`** (`test_r2_m1_...` and `test_r2_m2_...` failed as predicted).
  - TypeScript (`npx vitest run tests/server/callRepairs.test.ts`): **`4 failed | 16 passed`** (`M1`, `M3`, `L1`, `L2` failed as predicted).
- **GREEN (with all 5 proposed repairs applied):**
  - Python (`pytest wixy_server/tests/test_livechat_calls.py wixy_server/tests/test_livechat_call_repairs.py -n 0 -q --tb=short`): **`45 passed in 9.70s`**.
  - Python typecheck & lint (`mypy` + `ruff check`): **`Success: no issues found in 3 source files`**, **`All checks passed!`**.
  - TypeScript (`npx vitest run tests/server/call.test.ts tests/server/callAudio.test.ts tests/server/callRepairs.test.ts tests/server/callWorklet.test.ts` + `npm run typecheck`): **`4 passed (4), 36 passed (36)`**, `tsc --noEmit` exit `0`.

---

## Finding M1 — Caller Pending-Invite Stranding When `finish()` Purges Unsent `outgoing`

### Root Cause & Cross-Layer Trace
1. In `wixy_server/livechat/call_broker.py`, `Invite` handling creates `self.call = Call(peer.id, target_peer.id)`, enqueues `{"type": "outgoing", "callId": invited.id, "requestId": command.requestId, ...}` in `peer.controls`, and then enqueues `{"type": "incoming", ...}` in `target_peer.controls`.
2. If `self.emit(target_peer, incoming)` overflows `target_peer.controls` (`len >= 16`), `emit()` immediately calls `self.remove(target_peer) -> self.finish("disconnected")` inside the same `command()` turn—before the caller's writer coroutine has drained `outgoing`. The same purge happens if the callee declines or disconnects before the caller's writer drains `outgoing`.
3. `finish()` executes `peer.controls = deque(m for m in peer.controls if m.get("callId") != call.id)`, deleting the unsent `outgoing` message, and then emits `{"type": "ended", "callId": call.id, "reason": reason}` without `requestId`.
4. In `admin-ui/src/server/call/controller.ts`, the caller clicked `Call`, which created an empty `CallAudio` graph (`activateAudio()`), called `deps.onBusy(true)`, set `outgoingRequest = crypto.randomUUID()`, and left `callId === null` awaiting `outgoing`. When `ended` arrives without `outgoing` ever having arrived, `m["callId"] !== callId || !callId` (line 274) drops `ended`, leaving `outgoingRequest !== null`, `callButton.disabled === true`, `endButton.hidden === true`, `deps.onBusy(true)`, and the empty `CallAudio` graph leaked until socket teardown.
5. **Compatibility discriminator:** Existing test `test_accept_overflow_is_a_clean_transition` (`wixy_server/tests/test_livechat_call_repairs.py:343`) drains `a.controls` before triggering overflow on `Accept` and asserts exact dict equality `{"type": "ended", "callId": epoch, "reason": "disconnected"} in peer.controls`. Attaching `"requestId"` to `ended` **only** when `finish()` actually purges an unsent `outgoing` from `call.caller`'s `peer.controls` (`had_outgoing`) preserves exact dict shape once `outgoing` has been sent while guaranteeing `requestId` correlation whenever `outgoing` was purged prior to delivery.

### Proposed Code Diff (`M1`)

```diff
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
@@ -241,6 +242,10 @@ class CallBroker:
         for key in (call.caller, call.callee):
             peer = self.peers.get(key)
             if peer:
+                had_outgoing = key == call.caller and any(
+                    m.get("type") == "outgoing" and m.get("callId") == call.id
+                    for m in peer.controls
+                )
                 peer.last_terminal = call.id
                 peer.media.clear()
                 peer.outstanding.clear()
@@ -249,7 +254,10 @@ class CallBroker:
                 peer.sequence, peer.sample, peer.muted = -1, -480, False
                 # Invalidate already queued prepare/connected/lease controls too.
                 peer.controls = deque(m for m in peer.controls if m.get("callId") != call.id)
-                self.emit(peer, {"type": "ended", "callId": call.id, "reason": reason})
+                ended: JsonObject = {"type": "ended", "callId": call.id, "reason": reason}
+                if had_outgoing and call.request_id:
+                    ended["requestId"] = call.request_id
+                self.emit(peer, ended)
         self.presence()

     @transition
@@ -309,7 +317,7 @@ class CallBroker:
                 # Correlated, so a crossing caller's loss never erases its incoming call.
                 self.emit(peer, {"type": "unavailable", "requestId": command.requestId})
                 return
-            invited = self.call = Call(peer.id, target_peer.id)
+            invited = self.call = Call(peer.id, target_peer.id, request_id=command.requestId)
             self.emit(
                 peer,
                 {
```

```diff
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
@@ -272,6 +275,18 @@ export function createCallController(deps: CallDeps) {
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
```

### Limits & Layer Check (`M1`)
- If a crossing `incoming` call arrived before the correlated `ended` (glare case), `callId` is already set to the winning incoming call's id; `m["type"] === "ended" && m["callId"] !== callId` clears `outgoingRequest = null` without calling `teardownCall(...)`, preserving the incoming call offer.
- If `outgoing` was already delivered to the caller before `finish()`, `callId` on the caller already equals `call.id`, so the normal `m["type"] === "ended"` branch tears down the call via `callId`.

---

## Finding M2 — Media Dequeue / Admission Authority & Call-Lifetime Enforcement

### Root Cause & Cross-Layer Trace
1. `CallBroker.next_media(receiver)` in `wixy_server/livechat/call_broker.py:412` was not decorated with `@transition` and only checked `if not self.permitted(peer) or not call or call.state != "connected":`. It did **not** check:
   - whether `call.contains(peer)` holds,
   - whether `now >= call.until` (the 2-hour connected call cap), or
   - whether the **sender** (the other call member) is still `self.permitted(sender)` at dequeue time.
   Furthermore, when `self.permitted(peer)` was false in `next_media(peer)`, it only cleared `peer.media` and returned `None` instead of calling `self.remove(peer)` to close the unauthorized peer and finish the call.
2. `CallBroker.frame(sender, data)` checked `self.permitted(peer)` (raising `ValueError` without `self.remove(peer)`) and later checked `self.permitted(receiver)`, calling `self.finish("disconnected")` without `self.remove(receiver)` when the receiver lost permission, and never checked `now >= call.until`.
3. In `wixy_server/routes_livechat_calls.py:226`, the `finally:` block only mapped `time.time() >= peer.deadline or peer.grant_until == 0` to `4401`, leaving `close_code = 4403` when `read()` exited via `ValueError("media permission")` due to operational grant-refresh failure (`0 < peer.grant_until <= time.monotonic()`), whereas `tick()` mapped that condition to `4408`.

### Proposed Code Diff (`M2`)

```diff
--- a/wixy_server/livechat/call_broker.py
+++ b/wixy_server/livechat/call_broker.py
@@ -382,8 +390,24 @@ class CallBroker:
     def frame(self, peer: Peer, data: bytes) -> None:
         now = time.monotonic()
         epoch, seq, sample, lease = unpack_frame(data)
-        if not self.permitted(peer) or not peer.media_budget.take(now):
+        if not self.permitted(peer):
+            self.remove(peer)
+            raise ValueError("media permission")
+        if not peer.media_budget.take(now):
             raise ValueError("media permission")
+        call = self.call
+        if call is not None and call.contains(peer):
+            if now >= call.until:
+                self.finish("timeout")
+                return
+            other_id = call.callee if peer.id == call.caller else call.caller
+            other_peer = self.peers.get(other_id)
+            if other_peer is None or not self.permitted(other_peer):
+                if other_peer is not None:
+                    self.remove(other_peer)
+                else:
+                    self.finish("disconnected")
+                return
         if epoch == peer.last_terminal:
             return  # Former-pair in-flight audio is discarded, never rerouted.
         call = self.call
@@ -409,14 +433,28 @@ class CallBroker:
         receiver.media.append((epoch, forward_frame(data, receiver.playout[0])))
         receiver.wake.set()

+    @transition
     def next_media(self, peer: Peer) -> bytes | None:
+        now = time.monotonic()
+        if not self.permitted(peer):
+            self.remove(peer)
+            return None
         call = self.call
-        if not self.permitted(peer) or not call or call.state != "connected":
+        if not call or not call.contains(peer) or call.state != "connected":
             peer.media.clear()
             return None
+        if now >= call.until:
+            self.finish("timeout")
+            return None
+        sender = self.peers.get(call.callee if peer.id == call.caller else call.caller)
+        if sender is None or not self.permitted(sender):
+            if sender is not None:
+                self.remove(sender)
+            else:
+                self.finish("disconnected")
+            return None
         if len(peer.outstanding) >= 5:
             return None
-        now = time.monotonic()
         while peer.media:
             epoch, data = peer.media.popleft()
             if epoch != call.id or peer.playout[1] <= now:
```

```diff
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
```

### Limits & Layer Check (`M2`)
- **Zero I/O on media path:** `self.permitted(...)` and `now >= call.until` read only in-memory floats (`peer.deadline`, `peer.grant_until`, `call.until`). Grant DB refresh remains exclusively in the 5-second background `refresh_grant` task in `routes_livechat_calls.py`.
- **`@transition` invariant checks:** Adding `@transition` to `next_media` guarantees `assert_invariants()` runs after every media dequeue or authority/timeout termination.

---

## Finding M3 — Mobile BFCache (`pagehide` / `pageshow`) Call Bar Recovery

### Root Cause & Cross-Layer Trace
1. In `admin-ui/src/server/call/controller.ts:337`, `win.addEventListener("pagehide", pagehide)` called `detach()`, which set `session = null` and `element.hidden = true`, and registered no `pageshow` or `visibilitychange` listener.
2. In `admin-ui/src/server/panel.ts:1023`, `onPageShow()` only set `unloading = false` without re-evaluating `idleRanOutWhileAway()` or `msUntilExpiry() <= 0` or re-attaching the call bar.
3. On iPad Safari and Android Chrome, a cached page restoration (`pagehide` -> `pageshow`) left the Server panel unlocked in `"chat"` state with `calls.element.hidden === true` and `session === null`, permanently hiding the call bar until a manual lock/unlock or full reload.

### Proposed Code Diff (`M3`)

```diff
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -88,6 +88,8 @@ export function createCallController(deps: CallDeps) {
   let answerPending = false;
   let selectedTarget: string | null = null;
   let callUntil = 0;
+  let suspendedByPageHide = false;
+  let disposed = false;

   function button(text: string, action: () => void): HTMLButtonElement {
@@ -300,6 +315,7 @@ export function createCallController(deps: CallDeps) {
     if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; old.close(1000); }
   }
   function open(next: ServerSession, name: string): void {
+    suspendedByPageHide = false;
     disconnect();
     session = next;
     label = name;
@@ -334,17 +350,51 @@ export function createCallController(deps: CallDeps) {
     timer = win.setInterval(pulse, 100);
     render();
   }
-  function pagehide(): void { detach(); }
+  function pagehide(): void {
+    if (disposed || !session) return;
+    suspendedByPageHide = true;
+    disconnect();
+    element.hidden = true;
+  }
+  function restoreFromPageHide(): void {
+    if (!suspendedByPageHide || disposed || !session) return;
+    if (win.document.visibilityState === "hidden") return;
+    suspendedByPageHide = false;
+    if (Date.now() / 1000 >= session.expiresAt) {
+      detach();
+      return;
+    }
+    element.hidden = false;
+    if (!socket) open(session, label);
+  }
   win.addEventListener("pagehide", pagehide);
-  function detach(): void { disconnect(); session = null; element.hidden = true; }
+  win.addEventListener("pageshow", restoreFromPageHide);
+  win.document.addEventListener("visibilitychange", restoreFromPageHide);
+  function detach(): void {
+    suspendedByPageHide = false;
+    disconnect();
+    session = null;
+    element.hidden = true;
+  }
   return {
     element,
     attach(next: ServerSession, name: string): void {
+      if (disposed) return;
+      if (Date.now() / 1000 >= next.expiresAt) {
+        detach();
+        return;
+      }
       element.hidden = false;
       if (session?.token === next.token && socket) return;
       open(next, name);
     },
     detach,
-    dispose(): void { detach(); win.removeEventListener("pagehide", pagehide); },
+    dispose(): void {
+      disposed = true;
+      detach();
+      win.removeEventListener("pagehide", pagehide);
+      win.removeEventListener("pageshow", restoreFromPageHide);
+      win.document.removeEventListener("visibilitychange", restoreFromPageHide);
+    },
   };
 }
```

```diff
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
@@ -1022,6 +1022,15 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {

   function onPageShow(): void {
     unloading = false;
+    if (state.kind === "chat") {
+      if (idleRanOutWhileAway()) {
+        dispatch({ type: "lock", cause: "idleAway" });
+        return;
+      }
+      if (msUntilExpiry() <= 0) {
+        onExpiry();
+      }
+    }
   }

   function onHidden(): void {
```

### Limits & Layer Check (`M3`)
- **Ordering with `panel.ts`:** `panel.ts` registers `win.addEventListener("pageshow", onPageShow)` before `createCallController` is constructed or in the same window lifecycle; even if `restoreFromPageHide` runs first or second, `onPageShow()` immediately locks (`calls.detach()`) if `idleRanOutWhileAway()` or `msUntilExpiry() <= 0`, and `restoreFromPageHide()` independently checks `Date.now() / 1000 >= session.expiresAt`, `!disposed`, `suspendedByPageHide`, and `session !== null`.
- **No call resurrection:** `pagehide()` calls `disconnect()` which runs `teardownCall("")`, closing the WebSocket, stopping any audio/mic, and releasing `voiceCall` and `voiceCallPermission` idle-lock suspensions. `restoreFromPageHide()` only opens a fresh presence WebSocket in `"idle"` state.

---

## Finding L1 — Synchronous `activateAudio()` Failure on `Answer` Does Not Decline

### Root Cause & Cross-Layer Trace
In `admin-ui/src/server/call/controller.ts:182`, `activateAudio()` caught synchronous `AudioContext` / `audioFactory` construction errors and called `teardownCall("Calls unavailable in this browser")`. When triggered from `acceptButton` (`Answer`), `state` was `"incoming"` and `callId` was set to the ringing call's id. Calling `teardownCall(...)` instead of `end(...)` cleared `callId = null` without sending `{ type: "decline", callId }`, leaving the broker and caller ringing for the full 30-second timeout while the callee UI looked idle.

### Proposed Code Diff (`L1`)

```diff
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -179,9 +181,10 @@ export function createCallController(deps: CallDeps) {
         },
       );
       return true;
-    } catch { teardownCall("Calls unavailable in this browser"); return false; }
+    } catch { end("Calls unavailable in this browser"); return false; }
   }
```

### Limits & Layer Check (`L1`)
- When `activateAudio()` fails on **`Answer`**: `state === "incoming"` and `callId !== null`, so `end(...)` captures `endedId = callId` and `action = "decline"`, runs `teardownCall(...)` locally first, and sends `{ type: "decline", callId: endedId }`.
- When `activateAudio()` fails on **`Call`**: `callId === null` and `outgoingRequest === null` (since `outgoingRequest` is only assigned after `activateAudio()` returns `true`), so `end(...)` runs `teardownCall(...)` locally and sends no network frame and does not disconnect the socket.

---

## Finding L2 — `Call` Button Does Not Visibly Disable While Voice Note Owns Microphone

### Root Cause & Cross-Layer Trace
In `admin-ui/src/server/call/controller.ts:103`, `render()` computed:
```ts
callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && targets.value === "");
```
Unlike `acceptButton.disabled = answerPending || deps.isMicBusy()` (which was also refreshed in `pulse()`), `callButton.disabled` omitted `deps.isMicBusy()` in both `render()` and `pulse()`.

### Proposed Code Diff (`L2`)

```diff
--- a/admin-ui/src/server/call/controller.ts
+++ b/admin-ui/src/server/call/controller.ts
@@ -100,7 +102,7 @@ export function createCallController(deps: CallDeps) {
     const inCall = callId !== null;
     targets.hidden = inCall;
     callButton.hidden = inCall;
-    callButton.disabled = outgoingRequest !== null || (socket?.readyState === 1 && targets.value === "");
+    callButton.disabled = outgoingRequest !== null || deps.isMicBusy() || (socket?.readyState === 1 && targets.value === "");
     acceptButton.hidden = state !== "incoming";
     acceptButton.disabled = answerPending || deps.isMicBusy();
     muteButton.hidden = state !== "connected";
@@ -183,6 +184,7 @@ export function createCallController(deps: CallDeps) {
   }
   function pulse(): void {
+    callButton.disabled = outgoingRequest !== null || deps.isMicBusy() || (socket?.readyState === 1 && targets.value === "");
     if (state === "incoming") acceptButton.disabled = answerPending || deps.isMicBusy();
     const now = win.performance.now();
```

### Limits & Layer Check (`L2`)
- When the socket is disconnected (`Reconnect calls` mode), if a voice-note recording is active (`deps.isMicBusy() === true`), `callButton.disabled` is `true`; as soon as recording stops (`deps.isMicBusy() === false`), the 100 ms `pulse()` timer (when connected) or `render()` enables `Call` without requiring a new `presence` frame.
- *Minor edge note:* When the socket is disconnected (`timer === null`), `pulse()` is not ticking; if a user starts and stops a voice note while the call socket is disconnected, `render()` is not automatically re-run until socket/target interaction unless `panel.ts` notifies `calls`. In normal unlocked operation the presence socket is open and `timer` runs every 100 ms.

---

## RED-First Discriminator Tests & Measured RED / GREEN Evidence

### 1. Python Discriminator Tests (`wixy_server/tests/test_livechat_call_repairs.py`)

```python
def test_r2_m1_terminal_purge_before_outgoing_delivers_correlated_terminal_to_caller() -> None:
    # 1. Target overflows on incoming during Invite: caller's unsent outgoing is purged,
    #    but caller receives a request-correlated terminal control so its pending request clears.
    broker, (a, b) = _peers(2)
    a.controls.clear()
    _fill(b, 16)
    broker.command(a, Invite(type="invite", requestId="req-overflow", targetConnectionId=b.id))
    assert broker.call is None and not a.closed and b.closed
    assert not [m for m in a.controls if m.get("type") == "outgoing"]
    correlated_overflow = [
        m
        for m in a.controls
        if m.get("requestId") == "req-overflow" and m.get("type") in ("unavailable", "ended")
    ]
    assert correlated_overflow

    # 2. Callee declines before caller's writer drains outgoing: outgoing is purged,
    #    and caller still receives a request-correlated terminal control.
    broker2, (a2, b2) = _peers(2)
    a2.controls.clear()
    b2.controls.clear()
    broker2.command(a2, Invite(type="invite", requestId="req-decline", targetConnectionId=b2.id))
    assert broker2.call is not None
    epoch = broker2.call.id
    broker2.command(b2, CallAction(type="decline", callId=epoch))
    assert broker2.call is None
    assert not [m for m in a2.controls if m.get("type") == "outgoing"]
    correlated_decline = [
        m
        for m in a2.controls
        if m.get("requestId") == "req-decline" and m.get("type") in ("unavailable", "ended")
    ]
    assert correlated_decline


def test_r2_m2_media_admission_and_dequeue_enforce_both_members_authority_and_lifetime() -> None:
    from uuid import UUID

    from wixy_server.livechat.call_protocol import HEADER, Ack, Lease

    def make_frame(epoch: str, seq: int, lease: int) -> bytes:
        return HEADER.pack(
            1, 1, 0, UUID(hex=epoch).bytes, seq, seq * 480, lease, 0, bytes(8)
        ) + bytes(960)

    def connected_pair() -> tuple[CallBroker, Peer, Peer, str]:
        broker, (a, b) = _peers(2)
        broker.command(a, Invite(type="invite", requestId="r", targetConnectionId=b.id))
        assert broker.call is not None
        epoch = broker.call.id
        broker.command(b, CallAction(type="accept", callId=epoch))
        broker.command(a, CallAction(type="ready", callId=epoch))
        broker.command(b, CallAction(type="ready", callId=epoch))
        broker.tick(a)
        broker.command(b, Lease(type="lease", callId=epoch, lease=1))
        return broker, a, b, epoch

    # 1. Sender effective deadline expires between enqueue and dequeue (without tick).
    broker, a, b, epoch = connected_pair()
    broker.frame(a, make_frame(epoch, 0, a.lease_counter))
    assert len(b.media) == 1
    a.deadline = time.time() - 1
    assert broker.next_media(b) is None
    assert broker.call is None and a.closed and not b.closed and not b.media and not b.outstanding

    # 2. Sender grant confirmed revoked (grant_until = 0) between enqueue and dequeue.
    broker, a, b, epoch = connected_pair()
    broker.frame(a, make_frame(epoch, 0, a.lease_counter))
    a.grant_until = 0
    assert broker.next_media(b) is None
    assert broker.call is None and a.closed and not b.closed and not b.media

    # 3. Sender operational refresh failure (0 < grant_until <= monotonic) before dequeue.
    broker, a, b, epoch = connected_pair()
    broker.frame(a, make_frame(epoch, 0, a.lease_counter))
    a.grant_until = time.monotonic() - 0.01
    assert broker.next_media(b) is None
    assert broker.call is None and a.closed and not b.closed and not b.media

    # 4. Connected call's 2-hour until deadline expires before dequeue or before frame admission.
    broker, a, b, epoch = connected_pair()
    broker.frame(a, make_frame(epoch, 0, a.lease_counter))
    assert broker.call is not None
    broker.call.until = time.monotonic() - 0.01
    assert broker.next_media(b) is None
    assert broker.call is None and not a.closed and not b.closed and not b.media
    assert {"type": "ended", "callId": epoch, "reason": "timeout"} in b.controls

    broker, a, b, epoch = connected_pair()
    assert broker.call is not None
    broker.call.until = time.monotonic() - 0.01
    broker.frame(a, make_frame(epoch, 0, a.lease_counter))
    assert broker.call is None and not a.closed and not b.closed and not b.media

    # 5. Receiver deadline expires before sender frame admission -> call ends, receiver removed.
    broker, a, b, epoch = connected_pair()
    b.deadline = time.time() - 1
    broker.frame(a, make_frame(epoch, 0, a.lease_counter))
    assert broker.call is None and b.closed and not a.closed and not b.media
    _ = Ack
```

- **Measured RED output (before repair on `4983cc6`):**
  ```text
  FAILED wixy_server/tests/test_livechat_call_repairs.py::test_r2_m1_terminal_purge_before_outgoing_delivers_correlated_terminal_to_caller
    wixy_server\tests\test_livechat_call_repairs.py:399: in test_r2_m1_terminal_purge_before_outgoing_delivers_correlated_terminal_to_caller
      assert correlated_overflow
    E   assert []
  FAILED wixy_server/tests/test_livechat_call_repairs.py::test_r2_m2_media_admission_and_dequeue_enforce_both_members_authority_and_call_lifetime
    wixy_server\tests\test_livechat_call_repairs.py:445: in test_r2_m2_media_admission_and_dequeue_enforce_both_members_authority_and_call_lifetime
      assert broker.next_media(b) is None
    E   AssertionError: assert b'\x01\x01\x00\x00...' is None
  2 failed, 19 passed in 0.45s
  ```
- **Measured GREEN output (after repair):**
  ```text
  45 passed, 4 warnings in 9.70s
  Success: no issues found in 3 source files (mypy)
  All checks passed! (ruff)
  ```

### 2. TypeScript Discriminator Tests (`admin-ui/tests/server/callRepairs.test.ts`)

```ts
describe("Round 2 audit discriminators (M1, M3, L1, L2)", () => {
  it("M1: terminal-before-outgoing (overflow or early decline) clears caller pending request, stops empty graph, and preserves glare incoming call", () => {
    const busy: boolean[] = [];
    const socket = new Socket();
    let stops = 0;
    let creates = 0;
    const controller = createCallController({
      win: window,
      isMicBusy: () => false,
      onBusy: (b) => busy.push(b),
      hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
      socketFactory: () => socket as unknown as WebSocket,
      audioFactory: () => {
        creates++;
        return {
          prepare: async () => {},
          start: vi.fn(),
          stop: () => { stops++; },
          setMuted: vi.fn(),
          pulse: vi.fn(),
          play: vi.fn(),
          captureLease: vi.fn(),
        };
      },
    });
    controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
    socket.onopen?.();
    socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
    socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
    const callBtn = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === "Call")!;
    const endBtn = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === "End call")!;
    callBtn.click();
    const reqId = (JSON.parse(socket.sent.at(-1) as string) as { requestId: string }).requestId;
    socket.receive({ type: "presence", peers: [] });
    socket.receive({ type: "ended", callId: ID, reason: "disconnected", requestId: reqId });
    socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
    expect({
      callDisabled: callBtn.disabled,
      endHidden: endBtn.hidden,
      stops,
      creates,
      controllerBusy: busy.at(-1),
    }).toEqual({
      callDisabled: false,
      endHidden: true,
      stops: 1,
      creates: 1,
      controllerBusy: false,
    });
    controller.dispose();
  });

  it("M3: cached-page restoration (pagehide/pageshow) restores only presence for a valid unlocked owner and never after lock, expiry, or dispose", () => {
    const sockets: Socket[] = [];
    let session = { token: "secret", expiresAt: Date.now() / 1000 + 3600 };
    const controller = createCallController({
      win: window,
      isMicBusy: () => false,
      onBusy: vi.fn(),
      hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
      socketFactory: () => {
        const s = new Socket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
    controller.attach(session, "A");
    expect(controller.element.hidden).toBe(false);
    expect(sockets).toHaveLength(1);

    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(controller.element.hidden).toBe(true);
    expect(sockets[0]?.close).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(controller.element.hidden).toBe(false);
    expect(sockets).toHaveLength(2);

    // Negative control 1: explicit detach (lock) prevents restoration
    controller.detach();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(controller.element.hidden).toBe(true);
    expect(sockets).toHaveLength(2);

    // Negative control 2: session expires while hidden before pageshow (or already expired on attach)
    session = { token: "expiring", expiresAt: Date.now() / 1000 + 3600 };
    controller.attach(session, "A");
    expect(sockets).toHaveLength(3);
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    session.expiresAt = Date.now() / 1000 - 10;
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(controller.element.hidden).toBe(true);
    expect(sockets).toHaveLength(3);
    controller.attach({ token: "already-expired", expiresAt: Date.now() / 1000 - 10 }, "A");
    expect(controller.element.hidden).toBe(true);
    expect(sockets).toHaveLength(3);

    // Negative control 3: dispose prevents restoration
    controller.attach({ token: "secret2", expiresAt: Date.now() / 1000 + 3600 }, "A");
    expect(sockets).toHaveLength(4);
    controller.dispose();
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(controller.element.hidden).toBe(true);
    expect(sockets).toHaveLength(4);
  });

  it("L1: synchronous audio creation failure on Answer declines immediately; caller failure before invite sends no call action", () => {
    const socket = new Socket();
    const controller = createCallController({
      win: window,
      isMicBusy: () => false,
      onBusy: vi.fn(),
      hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
      socketFactory: () => socket as unknown as WebSocket,
      audioFactory: () => {
        throw new Error("AudioContext refused");
      },
    });
    controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
    socket.onopen?.();
    socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
    socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
    const callBtn = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === "Call")!;
    callBtn.click();
    expect(socket.sent).toHaveLength(1); // only auth

    socket.receive({ type: "incoming", callId: ID, peer: "B" });
    const answerBtn = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === "Answer")!;
    answerBtn.click();
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: "decline", callId: ID });
    controller.dispose();
  });

  it("L2: Call visibly disables while voice note owns microphone and re-enables on pulse without presence update", () => {
    let micBusy = true;
    const socket = new Socket();
    const controller = createCallController({
      win: window,
      isMicBusy: () => micBusy,
      onBusy: vi.fn(),
      hooks: { suspend: () => vi.fn(), lockNow: vi.fn() },
      socketFactory: () => socket as unknown as WebSocket,
    });
    controller.attach({ token: "secret", expiresAt: Date.now() / 1000 + 3600 }, "A");
    socket.onopen?.();
    socket.receive({ type: "welcome", deadline: Date.now() / 1000 + 3600 });
    socket.receive({ type: "presence", peers: [{ id: TARGET, label: "B", available: true }] });
    const callBtn = [...controller.element.querySelectorAll("button")].find((b) => b.textContent === "Call")!;
    expect(callBtn.disabled).toBe(true);
    micBusy = false;
    vi.advanceTimersByTime(100);
    expect(callBtn.disabled).toBe(false);
    micBusy = true;
    vi.advanceTimersByTime(100);
    expect(callBtn.disabled).toBe(true);
    controller.dispose();
  });
});
```

- **Measured RED output (before repair on `4983cc6`):**
  ```text
  FAIL tests/server/callRepairs.test.ts (20 tests | 4 failed)
    × M1: expected { callDisabled: true, controllerBusy: true, creates: 1, endHidden: true, stops: 0 }
          to deeply equal { callDisabled: false, controllerBusy: false, creates: 1, endHidden: true, stops: 1 }
    × M3: expected true to be false (controller.element.hidden remained true after pageshow)
    × L1: expected { type: 'auth', v: 1, token: 'secret', label: 'A' }
          to deeply equal { type: 'decline', callId: '0123456789abcdef0123456789abcdef' }
    × L2: expected false to be true (callBtn.disabled was false while isMicBusy() === true)
  ```
- **Measured GREEN output (after repair):**
  ```text
  ✓ tests/server/callWorklet.test.ts (6 tests)
  ✓ tests/server/call.test.ts (9 tests)
  ✓ tests/server/callAudio.test.ts (1 test)
  ✓ tests/server/callRepairs.test.ts (20 tests)
  Test Files  4 passed (4)
       Tests  36 passed (36)
  tsc --noEmit && tsc -p tsconfig.sw.json (exit 0)
  ```
