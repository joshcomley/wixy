# Pending permission during cached-page hide — Astra independent PROPOSE

Source: `b2c01b60eb7bb4b11e9b1dde335f245c452cf625`.
Scope: the one pending-permission/listener-order defect only.
No other proposal read. No implementation edits or new agents.

## Finding and evidence

**CITED:** parent brief `voice-lifecycle-permission-repair-brief.md` reports
the real-panel/real-controller four-cell discriminator: panel-first fails
with and without a later hidden event; controller-first passes both. Audio
stops once in all cells. This is an owner lock-policy defect, not continued
audio. Those results are not my measurements.

Source inspection confirms that a single boolean currently conflates two
outcomes: hidden policy was applied, or a temporary picker/permission exemption
prevented applying it. Controller teardown can remove the latter later in the
same pagehide dispatch. Deduplication must retain that distinction.

## Exact proposed patch

Use a three-valued replacement for the existing transition flag, rather than
another controller policy path. Revisit only an exempted **cached-page** hide,
only when the exemption has actually disappeared, and before restoring presence.
Preserve the original hide timestamp/evidence when revisiting its policy.

```diff
--- a/admin-ui/src/server/panel.ts
+++ b/admin-ui/src/server/panel.ts
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
+    if (restorePresencePending && hiddenTransition === "exempt" && !isPickerOrMicOpen()) {
+      hiddenTransition = "none";
+      onHidden(true);
+    }
+    hiddenTransition = "none";
```

All other logic remains as in the frozen candidate. In particular, actual
detach/disposal already clears `restorePresencePending`; persisted pageshow
while still hidden does not invoke onVisible; the subsequent visible event does.
`onPageHide` still sets the pending marker and invokes the existing onHidden.
Nonpersisted unloading does not create a pending restoration.

The `recheckPolicy` argument is private to this owner and used only by onVisible.
It is not a new browser event handler or authority interface. Its sole effect
is to prevent a deferred policy decision from changing when the hide happened.
Otherwise a shield would classify screen-lock evidence relative to return time.

## Expected discrimination, not a green claim

**UNEXECUTED GREEN:** no patched runtime, typecheck or regression suite was run
in this bounded proposal. These are source-based predictions for parent proof:

| Cell | Expected result |
|---|---|
| Panel-first pagehide while call permission held | Hide records exempt; controller teardown releases permission; visible recheck applies default lock before any attach |
| Same, with a later hidden event | Duplicate notification stays deduplicated; visible recheck still applies lock |
| Controller-first, no later hidden | Permission already released; original onHidden applies lock; no pending restoration remains |
| Controller-first, later hidden | Existing handled dedup remains; no second lock or restore |
| Pageshow occurs while still hidden | No visible recheck/attach yet; recheck runs on eventual visibilitychange |
| Genuine filePicker or micPermission still held at return | Exemption retained; no forced hidden lock or shield |
| Ordinary picker/permission hide without persisted pagehide | No restore marker, so no new retrospective policy check |
| Hidden policy ignore after canceled permission | Recheck returns through ignore; exactly one fresh presence attach |
| Shield policy after canceled permission | Recheck creates shield using original lastHideAtMs; normal onVisible shield decision runs before restore |
| Genuine second hide after an intervening visible event | Transition has reset to none; existing shield-taint/re-hide behavior applies |
| Manual lock/dispose while cached | Pending marker cleared; no attach or revived authority |
| Nonpersisted unload | Existing unloading guard and no restoration remain |

Default lock must detach before a socket factory can run; final hidden UI alone
does not prove that ordering. Assert one audio stop, released permission handle,
zero fresh call socket on denied return and no invite/accept/audio resurrection.
Use both pagehide listener orders and both visibility/pageshow orders. Retain
grant renewal, shield restore and actual lock controls in the affected tests.

## Limits and layer check

This deliberately postpones the canceled-exemption decision until the next
visible transition. Audio/socket teardown still happens immediately in the
controller on pagehide. It does not claim that a backgrounded cached panel is
already logically locked before returning; it ensures no fresh presence is
restored before the owner resolves the disappeared exemption.

The current hook exposes filePicker/micPermission reasons, not which operation
released one. Therefore a genuine exemption that ends while a page is cached
also receives a fresh policy decision at return. Ordinary chooser visibility
round trips are unchanged, and an exemption still held at return is honored.
This conservative cached-page behavior is explicit; if product policy requires
remembering a completed genuine chooser exemption across BFCache, that needs
an operation-ownership discriminator which this minimal patch does not invent.

No new timer, microtask, controller authority, view contract, store, persistence,
worker or recording. One existing flag becomes an explicit three-valued outcome;
one existing policy function receives an internal recheck argument.

Reject merely moving the handled assignment below the exemption: with no later
hidden event, nothing would apply policy before the existing restore. Reject
unconditionally rerunning onHidden on return: it can falsely taint an already
handled shield and can restamp causal evidence. Reject a queued callback alone:
cache suspension does not give that callback an authority-before-restore proof.

## Precommit

**Drop first:** the tri-state spelling if another proposal has a smaller equally
clear representation with the same four-cell and shield-evidence coverage.
The private recheck argument may likewise be replaced by a small extracted
policy body if that is better supported by the actual tests.

**Defend hardest:** a vanished exemption is not a completed policy decision;
the owner must resolve it before any fresh presence, independent of listener
order and even when no hidden notification arrives. Preserve genuine live
exemptions and original hide evidence. My proposal has no privilege in MERGE.

Parent owns combined selection, integration, measured green and proportionate
fresh acceptance. The prior audit PASS does not cover this newly confirmed cell.
