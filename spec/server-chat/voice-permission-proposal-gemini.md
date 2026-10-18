# Voice Lifecycle Permission Repair — Gemini 4 Argon PROPOSE

- **Reviewer:** Gemini 4 Argon (High) (`e593b848-ae0b-46f4-9611-941755bf2b74`)
- **Target candidate:** `b2c01b60eb7bb4b11e9b1dde335f245c452cf625` (`origin/cmd/workspace-00048`)
- **Issue:** Pending call permission on persisted `pagehide` (`panel-first pagehide during pending micPermission misses default lock; reverse order locks`)
- **Verification status:** **MEASURED-KNOWING** (RED and GREEN both executed in isolated worktree `00050`)

---

## 1. Root-Cause Verification Against Candidate `b2c01b6`

In `admin-ui/src/server/panel.ts` (`b2c01b6`), `mountServerPanel` registers `win.addEventListener("pagehide", onPageHide)` at mount time (`panel.ts:1116`), whereas `createCallController` registers its own `win.addEventListener("pagehide", onPageHide)` later when `ensureChatView()` constructs the chat view on first unlock (`controller.ts:289`). Because DOM listeners on the same `EventTarget` (`win`) execute in registration order, **panel-first (`controllerFirst = false`) is the normal production execution order**.

When a call is in `prepareCall()` awaiting `attempt.prepare()` (`controller.ts:227`), the call controller holds `hooks.suspend("micPermission")` (`controller.ts:224`). When `pagehide` (`persisted: true`) fires:

1. **`panel.ts`'s `onPageHide` runs first (`panel.ts:1022-1026`):**
   - Sets `restorePresencePending = true` (`event.persisted && chatAttached && state.kind === "chat"`).
   - Calls `onHidden()` (`panel.ts:1042-1050`).
   - Line 1044 sets `hiddenTransitionHandled = true` **before** line 1050 checks `if (isPickerOrMicOpen()) return;`.
   - Because `controller.ts`'s `pagehide` listener has not run yet, `suspensionsByReason.get("micPermission")` is still `1`, so `onHidden()` returns early at line 1050 without locking or shielding, leaving `hiddenTransitionHandled = true` and `restorePresencePending = true`.
2. **`controller.ts`'s `onPageHide` runs second in the same `pagehide` dispatch (`controller.ts:285-287`):**
   - Calls `detach()` -> `teardownCall("")` -> `releasePermission()`, invoking `release()` on the `"micPermission"` suspension (`panel.ts:710-716`).
3. **Why both `hiddenEvent = false` and `hiddenEvent = true` fail when `controllerFirst = false`:**
   - **When `hiddenEvent = false` (persisted `pagehide` with no subsequent `visibilitychange`):** `release()` (`panel.ts:710-716`) decrements `"micPermission"` to `0`, but nothing re-evaluates the persisted-`pagehide` hidden transition after the call teardown releases its `micPermission` hold.
   - **When `hiddenEvent = true` (persisted `pagehide` followed by `visibilitychange -> hidden`):** `onVisibilityChange()` calls `onHidden()`, which exits immediately at `if (unloading || hiddenTransitionHandled) return;` (`panel.ts:1043`) because `hiddenTransitionHandled` was prematurely set to `true` on the waived `onPageHide` call.
   - On subsequent `pageshow` (`persisted: true`), `onVisible()` sees `state.kind === "chat"` and `restorePresencePending === true`, so `restoreCachedPresence()` reattaches the unlocked chat view instead of having locked on `pagehide`.

---

## 2. Proposed Repair (`admin-ui/src/server/panel.ts`)

### Design

1. **Do not mark `hiddenTransitionHandled = true` when `isPickerOrMicOpen()` waives `onHidden()`:**
   Move `hiddenTransitionHandled = true` (and `pageHidePendingHidden = false`) to immediately **after** `if (isPickerOrMicOpen()) return;`. A hidden check that was waived by an active `filePicker` or `micPermission` exemption has not handled the hidden transition.
2. **Track `pageHidePendingHidden` across `onPageHide({ persisted: true })` and suspension `release()`:**
   - Set `pageHidePendingHidden = event.persisted` in `onPageHide`.
   - Clear `pageHidePendingHidden = false` once `onHidden()` passes `if (isPickerOrMicOpen()) return;`, or on `onVisible()`, `detachChatView()`, or `teardown()`.
   - In `hooks.suspend(reason)`'s `release()`, if `pageHidePendingHidden && !isPickerOrMicOpen()`, invoke `onHidden()`.
   - When `controller.ts`'s `pagehide` listener detaches the call and releases `"micPermission"` (even if no subsequent `visibilitychange` event ever fires), `release()` immediately completes the deferred persisted-`pagehide` `onHidden()` transition and locks/shields according to `hiddenPolicy(currentLockSettings())`.
   - Meanwhile, both exemption controls remain intact:
     - **Control 1 (genuinely held `filePicker`/`micPermission` across `pagehide` -> `pageshow`):** `release()` is not called before `pageshow`, so `isPickerOrMicOpen()` stays `true` during `pagehide`, `onVisible()` clears `pageHidePendingHidden = false`, and `restoreCachedPresence()` reattaches (`detachCalls === 0`, `attachCalls` length `2`).
     - **Control 2 (ordinary non-cache `visibilitychange -> hidden` -> `release()` -> `visibilitychange -> visible`):** No `pagehide` occurred, so `pageHidePendingHidden` is `false`; `release()` while hidden does not trigger `onHidden()`, preserving the ordinary non-cache prompt return exemption (`detachCalls === 0`, `attachCalls` length `1`).

### Exact Code Diff (`admin-ui/src/server/panel.ts`)

```diff
diff --git a/admin-ui/src/server/panel.ts b/admin-ui/src/server/panel.ts
index 8d83a0d..d2b58ae 100644
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
@@ -211,6 +211,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
   let chatView: ServerChatView | null = null;
   let chatAttached = false;
   let restorePresencePending = false;
+  let pageHidePendingHidden = false;
   let verifyRequestSeq = 0;
   /** Stale-response filter for the grant unlock a mount starts, like `verifyRequestSeq`. */
   let grantRequestSeq = 0;
@@ -228,6 +229,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {

   function detachChatView(): void {
     restorePresencePending = false;
+    pageHidePendingHidden = false;
     if (!chatAttached) return;
     chatView?.detach();
     chatView?.element.remove();
@@ -713,6 +715,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
         if (safetyTimer !== null) win.clearTimeout(safetyTimer);
         decrementSuspension(reason);
         if (totalSuspensionCount === 0 && idleTimerArmed) armIdleTimer();
+        if (pageHidePendingHidden && !isPickerOrMicOpen()) onHidden();
       }
       return release;
     },
@@ -1022,6 +1025,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
   function onPageHide(event: PageTransitionEvent): void {
     unloading = !event.persisted;
     restorePresencePending = event.persisted && chatAttached && state.kind === "chat";
+    pageHidePendingHidden = event.persisted;
     if (event.persisted) onHidden();
   }

@@ -1041,13 +1045,14 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {

   function onHidden(): void {
     if (unloading || hiddenTransitionHandled) return;
-    hiddenTransitionHandled = true;
     lastHideAtMs = win.performance.now();
     // A lock event reported up to a second BEFORE the page hid belongs to this hide, and proves
     // the device delivers them as they happen.
     proveIfCausal();
     // R7: an open file picker or a pending mic-permission prompt never lock, nor shield.
     if (isPickerOrMicOpen()) return;
+    hiddenTransitionHandled = true;
+    pageHidePendingHidden = false;
     if (state.kind === "shielded") {
       // Away again before the last switch resolved. That is a second switch in one absence, so
       // the cause can no longer be read: keep the decoy up, drop any pending restore, and lock
@@ -1077,6 +1082,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {

   function onVisible(): void {
     hiddenTransitionHandled = false;
+    pageHidePendingHidden = false;
     if (state.kind === "shielded") {
       cancelShieldResolve();
       // A switch that can no longer be read, or a lock event already seen (causal, or late and
@@ -1135,6 +1141,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
     teardown(): void {
       disposed = true;
       restorePresencePending = false;
+      pageHidePendingHidden = false;
       // Routing away from `/admin/server` is itself one of R6's lock causes
       // — run it through the reducer (rather than skipping straight to
       // cleanup) so a mid-chat departure still detaches/aborts/pauses
```

---

## 3. Red-First Test & Measured RED / GREEN Evidence (**MEASURED-KNOWING**)

### Test Coverage (`admin-ui/tests/server/panel.test.ts`)

Exercises the real `mountServerPanel` and real `createCallController` together across all 4 combinations of `controllerFirst` (`false` / `true`) and `hiddenEvent` (`false` / `true`), plus the two exemption control tests (`cache restoration honors a genuinely held %s exemption` and `ordinary non-cache %s return retains its existing exemption`):

```ts
  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("pending call permission cannot waive cache lock (controller first=%s, hidden event=%s)", async (controllerFirst, hiddenEvent) => {
    setHidden(false);
    const registration = vi.spyOn(window, "addEventListener");
    class CallSocket {
      readyState = 1;
      bufferedAmount = 0;
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      receive(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
    }
    const sockets: CallSocket[] = [];
    const controllers: ReturnType<typeof createCallController>[] = [];
    const prepare = vi.fn(() => new Promise<void>(() => {}));
    const stop = vi.fn();
    let attaches = 0;
    let detaches = 0;
    const createServerChatView: CreateServerChatView = ({ win, hooks }) => {
      const calls = createCallController({ win, hooks, isMicBusy: () => false, onBusy: vi.fn(),
        socketFactory: () => {
          const socket = new CallSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        audioFactory: () => ({ prepare, stop, start: vi.fn(), setMuted: vi.fn(),
          pulse: vi.fn(), play: vi.fn(), captureLease: vi.fn() }),
      });
      controllers.push(calls);
      const element = document.createElement("div");
      element.className = "wx-srv-thread";
      element.append(calls.element);
      return { element,
        attach: (session) => { attaches++; calls.attach(session, "A"); },
        detach: () => { detaches++; calls.detach(); },
        dispose: () => calls.dispose(),
      };
    };
    const { panel } = await unlockedChat({ createServerChatView });
    try {
      const hides = registration.mock.calls.filter(([type]) => type === "pagehide").map(([, handler]) => handler);
      expect(hides).toHaveLength(2); // Real panel and real controller, no surrogate release.
      if (controllerFirst) {
        for (const handler of hides) window.removeEventListener("pagehide", handler);
        for (const handler of [...hides].reverse()) window.addEventListener("pagehide", handler);
      }
      const socket = sockets[0]!;
      const calls = controllers[0]!;
      const callId = "a".repeat(32);
      socket.onopen?.();
      socket.receive({ type: "welcome", deadline: expiresIn(3600) });
      socket.receive({ type: "incoming", callId, peer: "B" });
      [...calls.element.querySelectorAll("button")].find((button) => button.textContent === "Answer")!.click();
      socket.receive({ type: "prepare", callId });
      expect(prepare).toHaveBeenCalledTimes(1); // Its await holds the real panel micPermission.
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      if (hiddenEvent) {
        setHidden(true);
        document.dispatchEvent(new Event("visibilitychange"));
      }
      setHidden(false);
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      expect(stop).toHaveBeenCalledTimes(1);
      expect(detaches).toBe(1);
      expect(attaches).toBe(1);
      expect(sockets).toHaveLength(1);
    } finally { panel.teardown(); registration.mockRestore(); }
  });
```

### Measured RED (unmodified `panel.ts` at `b2c01b6`)

Command: `npx vitest run tests/server/panel.test.ts`

```text
 ❯ tests/server/panel.test.ts (72 tests | 2 failed) 394ms
     × pending call permission cannot waive cache lock (controller first=false, hidden event=false) 13ms
     × pending call permission cannot waive cache lock (controller first=false, hidden event=true) 9ms
     ✓ pending call permission cannot waive cache lock (controller first=true, hidden event=false) 5ms
     ✓ pending call permission cannot waive cache lock (controller first=true, hidden event=true) 4ms
     ✓ cache restoration honors a genuinely held filePicker exemption 3ms
     ✓ cache restoration honors a genuinely held micPermission exemption 4ms
     ✓ ordinary non-cache filePicker return retains its existing exemption 4ms
     ✓ ordinary non-cache micPermission return retains its existing exemption 3ms

 FAIL  tests/server/panel.test.ts > mountServerPanel > pending call permission cannot waive cache lock (controller first=false, hidden event=false)
 FAIL  tests/server/panel.test.ts > mountServerPanel > pending call permission cannot waive cache lock (controller first=false, hidden event=true)
AssertionError: expected +0 to be 1 // Object.is equality
    632|       expect(detaches).toBe(1);
```

### Measured GREEN (with proposed `panel.ts` diff applied)

Command: `npx vitest run tests/server/panel.test.ts tests/server/panelGrant.test.ts tests/server/callRepairs.test.ts; npm run typecheck`

```text
 ✓ tests/server/callRepairs.test.ts (22 tests) 44ms
 ✓ tests/server/panelGrant.test.ts (188 tests) 541ms
 ✓ tests/server/panel.test.ts (72 tests) 353ms

 Test Files  3 passed (3)
      Tests  282 passed (282)

> wixy-admin-ui@0.1.0 typecheck
> tsc --noEmit && tsc -p tsconfig.sw.json
```

---

## 4. Limits & Layer Check

- **Layer check (`panel.ts` vs `controller.ts`):**
  - `controller.ts` already tears down its call and releases `"micPermission"` on `pagehide` (`if (e.persisted) detach()`, `controller.ts:286`). The defect is strictly in `panel.ts`'s lifecycle bookkeeping (`hiddenTransitionHandled` consumed before `isPickerOrMicOpen()`, and no re-evaluation when a suspension that blocked a persisted `pagehide` is released during that same `pagehide`).
  - Fixing this in `panel.ts` makes the panel invariant independent of listener registration order between `panel.ts` and any child view (`chatView`, `controller.ts`, or voice-note recorder).
- **Ordering invariance (`visibilitychange -> hidden` before `pagehide`):**
  - Because `hiddenTransitionHandled = true` is moved after `if (isPickerOrMicOpen()) return;`, even if a browser fires `visibilitychange -> hidden` *before* `pagehide (persisted: true)` while `micPermission` is still held, the initial `visibilitychange` does not consume `hiddenTransitionHandled`, so `pagehide` + `release()` still locks cleanly.
- **No double-locking or re-entrancy hazards:**
  - When `controllerFirst = false`, `controller.ts`'s `pagehide` listener calls `detach()` -> `releasePermission()` -> `release()` -> `onHidden()`. Inside `onHidden()`, `hiddenTransitionHandled` is set to `true` and `pageHidePendingHidden` to `false` before `dispatch({ type: "lock", cause: "hidden" })` runs `detachChatView()`. Even if `detachChatView()` calls `chatView.detach()` -> `calls.detach()`, `release()` is already idempotent (`if (released) return;`) and `hiddenTransitionHandled` is already `true`.
- **Invariants preserved:**
  - Explicit consenting socket pair, third same-login browser isolation, dedicated `voiceCall` idle-only suspension, immediate stop on lock/detach, zero persistence/transcription, and ordinary non-cache `filePicker`/`micPermission` prompt exemptions are all preserved untouched.

---

## 5. Group Therapy Pre-Commitments

- **What I would drop first for a better option:**
  - The exact boolean name `pageHidePendingHidden` (or whether `onPageHide` defers `onHidden()` via a microtask vs triggering on `release()`), provided any alternative handles both `hiddenEvent = false` and `hiddenEvent = true` synchronously during the `pagehide` turn without relying on listener registration order.
- **What I will defend hardest and why:**
  1. **Moving `hiddenTransitionHandled = true` to *after* `if (isPickerOrMicOpen()) return;` in `onHidden()` (`panel.ts:1044-1050`):** Setting `hiddenTransitionHandled = true` before checking `isPickerOrMicOpen()` is a state-machine bug whenever a waived hide is followed by a real hide or suspension teardown before `onVisible()`.
  2. **Re-evaluating `onHidden()` in `release()` when `pageHidePendingHidden && !isPickerOrMicOpen()` (`panel.ts:718`):** This is what guarantees that a persisted `pagehide` without a subsequent `visibilitychange` (`hiddenEvent = false`) still locks when a child `pagehide` listener releases its `micPermission` hold after `panel.ts`'s `onPageHide` already ran, while keeping Control 1 (genuinely held exemption across `pagehide`/`pageshow`) and Control 2 (ordinary non-cache `visibilitychange` exemption) 100% intact.
