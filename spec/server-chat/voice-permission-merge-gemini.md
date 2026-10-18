# Narrow Permission Lifecycle — ALL-Proposal MERGE (Gemini 4 Argon)

- **Reviewer:** Gemini 4 Argon (High) (`e593b848-ae0b-46f4-9508-f1d56a9cae84`)
- **Base candidate:** `b2c01b60eb7bb4b11e9b1dde335f245c452cf625`
- **Inputs:**
  - Parent brief: `spec/server-chat/voice-permission-merge-brief.md`
  - Astra proposal: `spec/server-chat/voice-permission-proposal-astra.md`
  - Gemini proposal: `spec/server-chat/voice-permission-proposal-gemini.md`
- **Verification status:** **MEASURED-KNOWING** (`283 passed (283)` across `panel.test.ts` [73 tests], `panelGrant.test.ts` [188 tests], `callRepairs.test.ts` [22 tests], plus `npm run typecheck` in isolated worktree `00050`)

---

## 1. Adopted vs. Rejected Changes & Provenance

| Element | Decision | Provenance | Rationale |
|---|---|---|---|
| Replace `hiddenTransitionHandled: boolean` with `hiddenTransition: "none" \| "exempt" \| "handled"` | **ADOPT** | Astra | Prevents conflating a temporary `filePicker`/`micPermission` exemption with a completed hidden-policy decision, while deduplicating repeated `visibilitychange -> hidden` events during an active exemption. |
| Guard `lastHideAtMs = win.performance.now(); proveIfCausal();` behind `if (!recheckPolicy)` in `onHidden(recheckPolicy = false)` | **ADOPT** | Astra | Preserves the original hide timestamp and causal screen-lock evidence when an initially exempt hide is later completed (`recheckPolicy = true`). Fixes Gemini's timestamp-reset flaw where a delayed exemption release overwrote `lastHideAtMs`. |
| Gate cached-policy completion on existing `restorePresencePending` instead of adding `pageHidePendingHidden` | **ADOPT** | Astra + Brief | `restorePresencePending` already has the exact required lifetime: set on eligible persisted `pagehide` (`event.persisted && chatAttached && state.kind === "chat"`), cleared on lock/shield (`detachChatView()`) and dispose (`teardown()`), consumed on `restoreCachedPresence()`, and never set on ordinary non-cache `visibilitychange` hides. **DROP** Gemini's redundant `pageHidePendingHidden` boolean. |
| Complete exempt persisted-`pagehide` policy immediately in `release()` (`if (restorePresencePending && hiddenTransition === "exempt" && !isPickerOrMicOpen()) onHidden(true);`) and when `onPageHide` follows an earlier exempt `visibilitychange -> hidden` | **ADOPT** | Gemini + Astra synthesis | **REJECT** Astra's deferral of the logical lock until `onVisible()`. Immediate completion during the `pagehide` dispatch (and when an exempt `visibilitychange` hide is followed by `pagehide`) guarantees that `chatView.detach()` (`detaches === 1`), `session` clearing, and `pauseGrantForLock("hidden")` / `beginShield()` (`setGrantPaused(win, true)`) happen before the page sits in BFCache or is evicted while away, matching `controllerFirst = true` timing. |

---

## 2. Resolution of Brief Questions

### A. Immediate Release-Time Policy vs. Return-Time Policy
- **Immediate completion is strictly better than deferring until `onVisible()`:**
  1. In `controllerFirst = true`, `chatView.detach()` (`detaches === 1`) and `pauseGrantForLock("hidden")` / `beginShield()` (`setGrantPaused(win, true)`) execute **during the `pagehide` dispatch**, before the page rests in BFCache or returns.
  2. As `panel.ts:940-943` notes, BFCache entries can be discarded while away without `pageshow`/`onVisible()` ever running; deferring `onHidden(true)` until `onVisible()` leaves the chat DOM attached, `session` live, and the device grant unpaused in `localStorage` across the entire hidden absence, and fails the `expect(detaches).toBe(1)` assertion immediately after `pagehide`.
  3. Additionally, if `visibilitychange -> hidden` fires first while `micPermission` is held (`hiddenTransition = "exempt"`), then `release()` runs (ordinary chooser return still exempt because `restorePresencePending === false`), and *then* `pagehide (persisted: true)` fires (`restorePresencePending = true`), allowing `onHidden()` to transition `"exempt" -> "handled"` when `restorePresencePending && !isPickerOrMicOpen()` completes the lock immediately on `pagehide` (`completes an exempt visibility hide when permission ended before persisted pagehide`).

### B. Actual Ordering & Idempotence on `release()` Re-entry into Controller Teardown
- Tracing `controller.ts` during panel-first `pagehide`:
  1. `controller.ts`'s `pagehide` listener calls `detach()` -> `disconnect()` (`socketEpoch++`, `teardownCall("")`).
  2. Inside `teardownCall("")` (`controller.ts:115-122`):
     - `callEpoch++` runs first.
     - `audio?.stop(); audio = null;` runs at lines 117–118 **before** `releasePermission?.()` at line 119.
     - At line 119, `releasePermission?.()` invokes `panel.ts`'s `release()`.
  3. Inside `panel.ts`'s `release()` (`panel.ts:710-718`):
     - `if (released) return; released = true;` runs first, then `decrementSuspension("micPermission")`.
     - `if (restorePresencePending && hiddenTransition === "exempt" && !isPickerOrMicOpen()) onHidden(true);` transitions `hiddenTransition = "handled"`, clears `restorePresencePending = false` in `detachChatView()`, and calls `chatView.detach()` -> `calls.detach()`.
  4. In the inner `calls.detach()` -> `disconnect()`:
     - `audio` is already `null` (`stop` is not called a second time: `expect(stop).toHaveBeenCalledTimes(1)`).
     - `releasePermission?.()` hits `if (released) return;` in `panel.ts` (idempotent no-op).
     - `const old = socket; socket = null; if (old) { ... old.close(1000); }` closes the call socket once and nulls `socket`.
  5. When the outer `teardownCall("")` and `disconnect()` resume:
     - `releasePermission = null`, `releaseCall = null`, state fields are already reset (`idempotent`).
     - In outer `disconnect()`, `const old = socket` reads `null`, so `old.close(1000)` is not called again (`expect(socket.close).toHaveBeenCalledTimes(1)`).

### C. Preserving Original Hide Timestamp & Causal Screen-Lock Evidence
- When `onHidden()` runs on the initial hide (`hiddenTransition === "none"`, `recheckPolicy === false`), it stamps `lastHideAtMs = win.performance.now()` and calls `proveIfCausal()` once, then sets `hiddenTransition = "exempt"`.
- Any duplicate `visibilitychange -> hidden` while `hiddenTransition === "exempt"` and `!restorePresencePending || isPickerOrMicOpen()` returns at once without touching `lastHideAtMs`.
- When the exemption ends and policy completes (`recheckPolicy = true`, either via `release()` or via `onPageHide -> onHidden()`), `if (!recheckPolicy)` skips `lastHideAtMs = win.performance.now()` and `proveIfCausal()`, preserving the original hide's timestamp for `beginShield()` (`shieldHideAtMs = lastHideAtMs`).

### D. Exact Lifetime of `restorePresencePending`
- Set only in `onPageHide`: `restorePresencePending = event.persisted && chatAttached && state.kind === "chat"`.
- Cleared in `detachChatView()` on every `"lock"` or `"shield"` transition, cleared in `teardown()` on dispose, and consumed in `restoreCachedPresence()` on valid return.
- Remains `false` on ordinary non-cache `visibilitychange` hides and non-persisted unloads (`event.persisted === false`).

---

## 3. Exact Combined Repair (`admin-ui/src/server/panel.ts`)

```diff
diff --git a/admin-ui/src/server/panel.ts b/admin-ui/src/server/panel.ts
index 8d83a0d..77ae4a6 100644
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
@@ -713,6 +713,9 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
         if (safetyTimer !== null) win.clearTimeout(safetyTimer);
         decrementSuspension(reason);
         if (totalSuspensionCount === 0 && idleTimerArmed) armIdleTimer();
+        if (restorePresencePending && hiddenTransition === "exempt" && !isPickerOrMicOpen()) {
+          onHidden(true);
+        }
       }
       return release;
     },
@@ -1017,7 +1020,7 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
    * chat's memory is about to be discarded anyway. A page that goes into the back/forward
    * cache (`persisted`) can be restored open, so it stays an ordinary background switch. */
   let unloading = false;
-  let hiddenTransitionHandled = false;
+  let hiddenTransition: "none" | "exempt" | "handled" = "none";

   function onPageHide(event: PageTransitionEvent): void {
     unloading = !event.persisted;
@@ -1039,15 +1042,24 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
     chatView?.attach(session);
   }

-  function onHidden(): void {
-    if (unloading || hiddenTransitionHandled) return;
-    hiddenTransitionHandled = true;
-    lastHideAtMs = win.performance.now();
+  function onHidden(recheckPolicy = false): void {
+    if (unloading || hiddenTransition === "handled") return;
+    if (hiddenTransition === "exempt") {
+      if (!restorePresencePending || isPickerOrMicOpen()) return;
+      recheckPolicy = true;
+    }
+    hiddenTransition = "handled";
     // A lock event reported up to a second BEFORE the page hid belongs to this hide, and proves
     // the device delivers them as they happen.
-    proveIfCausal();
+    if (!recheckPolicy) {
+      lastHideAtMs = win.performance.now();
+      proveIfCausal();
+    }
     // R7: an open file picker or a pending mic-permission prompt never lock, nor shield.
-    if (isPickerOrMicOpen()) return;
+    if (isPickerOrMicOpen()) {
+      hiddenTransition = "exempt";
+      return;
+    }
     if (state.kind === "shielded") {
       // Away again before the last switch resolved. That is a second switch in one absence, so
       // the cause can no longer be read: keep the decoy up, drop any pending restore, and lock
@@ -1076,7 +1088,8 @@ export function mountServerPanel(deps: ServerPanelDeps): ServerPanel {
   }

   function onVisible(): void {
-    hiddenTransitionHandled = false;
+    if (hiddenTransition === "exempt") onHidden(true);
+    hiddenTransition = "none";
     if (state.kind === "shielded") {
       cancelShieldResolve();
       // A switch that can no longer be read, or a lock event already seen (causal, or late and
```

---

## 4. Measured Verification (**MEASURED-KNOWING**)

Executed in isolated worktree `00050` against parent workspace 48's full `admin-ui/tests/server/panel.test.ts` (including all 4 cells of `pending call permission cannot waive cache lock` with `expect(detaches).toBe(1)` immediately after `pagehide`, `expect(socket.close).toHaveBeenCalledTimes(1)`, the 4 exemption control cells, and `completes an exempt visibility hide when permission ended before persisted pagehide`), then reverted (`git checkout -- admin-ui`):

```text
 ✓ tests/server/callRepairs.test.ts (22 tests) 40ms
 ✓ tests/server/panelGrant.test.ts (188 tests) 552ms
 ✓ tests/server/panel.test.ts (73 tests) 350ms

 Test Files  3 passed (3)
      Tests  283 passed (283)

> wixy-admin-ui@0.1.0 typecheck
> tsc --noEmit && tsc -p tsconfig.sw.json
```
