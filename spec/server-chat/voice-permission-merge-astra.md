# Pending-permission lifecycle — Astra ALL-proposal MERGE

Candidate: `b2c01b60eb7bb4b11e9b1dde335f245c452cf625`.
One issue only. Both complete proposal artifacts read; my proposal has no privilege.
No implementation edits or new test executions.

## Selection

Take **Gemini's immediate release-time policy completion**, **Astra's explicit
exempt-versus-handled outcome and original hide timestamp**, and reuse the
existing **restorePresencePending** marker instead of adding
`pageHidePendingHidden`. Drop Astra's deferred-until-visible timing: it is not
required for safety, and safe synchronous completion gives the same logical
lock timing in both listener orders.

Drop Gemini's repeated ordinary `onHidden()` timestamp capture when an exemption
ends. A release long after the hide must not move screen-lock causal evidence
to release time. Retain genuine still-held exemptions and ordinary non-cache
chooser returns. This is a newly composed patch, not either proposal unchanged.

## Exact minimal combined patch

Against the frozen parent source, modify only `panel.ts`:

```diff
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
@@
         decrementSuspension(reason);
         if (totalSuspensionCount === 0 && idleTimerArmed) armIdleTimer();
+        if (restorePresencePending && hiddenTransition === "exempt" && !isPickerOrMicOpen()) {
+          hiddenTransition = "none";
+          onHidden(true);
+        }
@@
-  let hiddenTransitionHandled = false;
+  let hiddenTransition: "none" | "exempt" | "handled" = "none";
@@
-  function onHidden(): void {
-    if (unloading || hiddenTransitionHandled) return;
-    hiddenTransitionHandled = true;
-    lastHideAtMs = win.performance.now();
+  function onHidden(recheckPolicy = false): void {
+    if (unloading || hiddenTransition !== "none") return;
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
@@
   function onVisible(): void {
-    hiddenTransitionHandled = false;
+    hiddenTransition = "none";
```

Do not add Astra's return-time recheck as a second path. Suspension removal
already runs through the idempotent release hook. Do not add Gemini's second
pending flag. No controller changes, timers, microtasks or public APIs.

## Timing and reentrancy: checked against actual source

These are source deductions, not newly measured greens:

1. Panel-first pagehide marks restore pending and records an exempt hide. The
   controller then calls disconnect -> teardownCall -> releasePermission. That
   release immediately finishes the owner policy before pagehide returns.
2. Controller-first release runs before restore pending is set, so it cannot
   invent a cached hide. The later panel pagehide sees no permission exemption
   and applies the normal policy. No hidden notification is required in either
   order. A duplicate hidden event is ignored after policy is handled.
3. `release()` sets its own `released=true` **before** decrementing or invoking
   the new policy check. Before invoking releasePermission, teardownCall stops
   audio and sets `audio=null`. The new onHidden sets transition handled before
   dispatching lock/shield. `detachChatView` clears restorePresencePending before
   calling the child detach. Thus nested controller teardown sees null audio,
   an already released permission handle, and no pending cache-policy recheck.
4. Nested disconnect clears/closes the socket; outer disconnect subsequently
   reads null socket. Epoch increments and local clear/render may repeat, but
   audio stop, suspension decrement and socket close must not repeat. The
   onBusy(false) callback may repeat and already has to tolerate ordinary nested
   cleanup. Assert resource counts; do not claim “no reentrancy”. It is bounded
   reentrancy whose idempotence depends on this inspected ordering.
5. Any idle timer briefly armed by release is disarmed by the resulting lock
   transition; no asynchronous callback can interleave in this synchronous stack.

## Why the existing pending marker is sufficient

It is set only for an eligible attached chat on persisted pagehide, cleared
before actual lock/detach and disposal, and consumed before successful restore.
That is exactly the owner lifetime in which this cached hidden policy may need
completion. The additional `hiddenTransition === "exempt"` gate distinguishes
unfinished policy from ignore/lock/shield already handled.

If the first hide was visibilitychange while exempt, it records exempt even
without the cache marker; later persisted pagehide supplies the marker, and
release completes policy. Ordinary non-cache release has no marker and stays
unchanged. If permission was released before pagehide, its ordinary visibility
hide may still be marked exempt: the persisted pagehide must then complete it.
**This last ordering requires the following additional line**, after setting
restorePresencePending in onPageHide and before calling onHidden:

```ts
if (event.persisted && hiddenTransition === "exempt" && !isPickerOrMicOpen()) {
  hiddenTransition = "none";
  onHidden(true);
}
```

Keep the existing `if (event.persisted) onHidden();` afterward. It is then a
no-op for an already completed policy. This preserves the first hide's timestamp
even in visibility-hidden -> release -> persisted-pagehide ordering, rather
than losing the exemption's completion between the two lifecycle signals.

On visible return, resetting transition to none ends the absence. A genuinely
held exemption may allow restoration, which consumes the marker; releasing it
later cannot retrospectively lock. If pageshow occurs while hidden, no reset
or restoration happens yet. Actual detach/dispose prevents both recheck and
recovery. Nonpersisted unload clears the marker and preserves unloading logic.

## Evidence and focused acceptance

**CITED:** parent four-cell RED; Gemini's MEASURED-KNOWING proposal reports
four-cell repair and held/ordinary filePicker/micPermission controls, 282 focused
tests and strict TypeScript green. Those runs used Gemini's additional pending
flag and timestamp-resetting onHidden, not this merged patch. Astra's original
proposal had UNEXECUTED GREEN. No new blind or knowing measurements here.

**Combined GREEN: UNEXECUTED.** Parent must prove the four cells and four exemption
controls, plus these distinguishing assertions:

- Assert default-lock detach immediately after pagehide, before pageshow; only
  checking after return cannot distinguish my former delayed proposal.
- Both listener orders: audio.stop once, socket.close once, permission release
  decrement once, no fresh socket/attach, no runaway nested teardown.
- Advance time between exempt hide and release; verify lastHideAtMs stays the
  original hide and shield classification uses original screen-lock evidence.
- Visibility-hidden -> release -> persisted pagehide uses the additional
  precheck above; include the same sequence with a still-held exemption.
- Ignore policy yields one fresh presence only; shield/re-hide and grant renewal
  retain their existing owner path. A visible interval resets the transition so
  a real second hide can still taint an unresolved shield.
- Actual lock/disposal and nonpersisted unload leave no pending authority.

The hook cannot distinguish why a genuine exemption ended while cached; it
conservatively applies current hidden policy when the final exemption releases.
This is Gemini's immediate behavior, explicitly selected, not an unmentioned
change to ordinary chooser-return policy. No scope expansion into device proof
or broad audit; parent owns focused integration and proportionate acceptance.

## Layer and remaining judgement

One owner outcome flag replaces a boolean; one existing idempotent release
notifies that owner; the existing restore marker bounds lifetime. No second
lock machine or state store. Prefer this combination for immediate policy and
preserved evidence. If resource-count tests contradict the inspected nested
teardown ordering, return to local repair rather than calling citation a green.

No PR, merge or launch approval. The earlier audit PASS does not cover this
new composition, and live acceptance/delivery proof remain separate.
