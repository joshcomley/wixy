# 00161 - Server chat device grants and the two lock checkboxes, as built

## Need

The operator asked for a per-device "Keep this device unlocked" setting, PIN-gated to turn on
(`spec/server-chat/03-permanent-unlock.md` §1-§7), and then for two checkboxes, "Lock when I change
tab" and "Lock when I lock my screen" (§8, amended twice by the Architect). This records the
choices that the spec leaves open or that the build forced, so a later reader can tell which are
deliberate. Inv 48 is the rule; livechat.md §15 is the tour.

## Decided

**Server**
- A grant is `sha256(secret)` in `device_grants` (migration v7); the secret is shown once. One
  `_verify_pin` helper serves `/unlock` and enrolment so their cmd mapping cannot drift, and one
  `_request_guard_refusal` guards all four grant routes plus `/unlock`.
- **Another identity's grant, an unknown id and a malformed id are all `404 not_found`; revoking your
  own already-revoked grant is `204`.** The spec says "fails" for the first and "idempotent" for the
  second and names no status. Uniform 404 leaks nothing about which grants exist.
- `unlock-with-grant` treats a well-formed JSON object with bad or missing fields as a normal
  `401 grant_invalid` failure (counted by the limiter); a body that is not a JSON object at all is a
  `422` and is NOT counted, so line noise cannot lock the owner out of their own device.
- `Cache-Control: no-store` on the two credential-bearing responses (201 and the token-minting 200).
  The spec does not ask; the secret is returned exactly once, so it must not be cached.
- The two `DELETE` routes require `Content-Type: application/json` even with no body, because the
  spec puts them behind the same guard. The client sends it.
- The failure limiter is per process and in memory. A 256-bit secret cannot be guessed; the limit
  only stops a misbehaving client hammering the database, so cross-process accuracy is not worth a
  shared store.

**Client**
- **The fallback when the browser cannot tell a screen lock from a tab switch is "lock if EITHER box
  is ticked", not "follow the tab box".** Spec §8 says the screen box "follows the tab checkbox". They
  agree whenever the boxes agree. They differ only if the stored values disagree when the detector is
  lost (permission revoked later): following the tab box would turn "tab off, screen on" into "never
  lock", silently dropping a lock the owner asked for. The sheet also writes BOTH keys when the tab box
  is toggled in that mode, so the stored values re-converge.
- A hidden document in any state other than an open chat (revealed, pin, verifying, fading, granting)
  still locks at once whatever the boxes say. The boxes govern the chat, which is the thing they are
  settings of.
- **Silent renewal re-attaches the chat view with the new session** instead of adding a new method to
  the frozen `ServerChatView`. `thread.ts`'s retry button already calls `attach` on an attached thread;
  the reattach path already reopens the stream from its saved cursor and refreshes the signed media
  URLs (bound to the OLD token's expiry, so they must be refreshed or they die 12 h in). `types.ts`
  now documents that `attach` may be called again. The first-unlock name prompt no longer wipes a
  half-typed name on such a call, and `detach` resets it so the next visit starts fresh.
- A renewal waits (up to the last minute) while a voice note or video plays, because refreshing the
  media URLs restarts playback; a 401 within 10 s of a renewal locks instead of renewing again.
- A shield clears the idle timer, so on return the panel compares the wall clock with the last
  activity and locks if the idle period ran out while away (unless a grant is active or a suspension
  holds the timer). The same check runs on returning from a background switch that was ignored
  (both boxes unticked), because a suspended phone need not advance `performance.now()`.
- **An unload is not a background switch.** Browsers fire `pagehide` then `visibilitychange → hidden`
  when a page is reloaded, navigated away or closed. Treated as "the owner changed tab" (both boxes
  are ticked by default) it locked the chat and PAUSED the grant, so every reload asked for the PIN
  again. `panel.ts` records `pagehide` with `persisted === false` and ignores the hide that follows;
  a `persisted` pagehide (back/forward cache, which can restore the page open) still counts as a
  background switch. Found by the Playwright reload test, not by any unit test (jsdom never unloads).
- The inline "Keep this device unlocked" PIN pad is excluded from R3's multi-tap detector
  (`data-srv-gesture-exempt`): its digit keys are tapped in quick succession by design and would
  otherwise lock the chat on the second tap.
- While a mount is minting its token the panel shows nothing at all, not even the decoy: a flash of
  disguise followed by the chat would tell a bystander which is which.
- `LockCause` gained `screenLock`; a multi-tap is a deliberate lock and pauses the grant like panic.

**Round 2b: an independent opus review and an Architect ruling, both against the built code above**

Before delivery, an independent reviewer (a second opus-tier read of the same diff) found eight
issues, two of them real security-relevant fail-open bugs; the Architect separately ruled on one
question the review raised that the spec itself did not answer. Every fix below shipped in the
same PR as the original build, so Inv 42/48 and livechat.md §15 already describe the AS-BUILT
(post-fix) behaviour — this records WHY it changed from the first draft.

- **(CRITICAL, reviewer) The shield was pausing the grant only when it RESOLVED, not when it
  BEGAN.** A page reloaded, closed, or discarded mid-shield (before the 500 ms window elapsed)
  found the grant still marked active on the next mount and opened straight into the chat with no
  PIN — exactly the state "keep this device unlocked" must never allow after an unresolved
  background switch. Fixed: `beginShield` writes the pause immediately; only a completed restore
  (`commitShieldRestore`) undoes it. `grantUsable()` was widened to still treat a shielded-but-
  paused chat as active, purely so a token due to expire mid-shield can keep renewing — the pause
  and "is renewal owed" are separate questions.
- **(HIGH, reviewer) A pending restore-after-renewal ignored a second hide or screen lock.** If the
  shield was waiting on a token renewal to complete a restore and the owner switched away again (or
  a screen lock fired) before it landed, the renewal would land and restore the chat behind the
  owner's back. Fixed: `shieldTainted`, set by a second hide or a lock event arriving mid-wait,
  forces the eventual return to stay locked regardless of what the evidence otherwise says.
- **(HIGH, Architect ruling) The spec's "an event was seen during the absence" test does not say
  WHEN it must have been dispatched, and that gap is exploitable both ways**: a screen lock reported
  hours after an unrelated return (a batched, out-of-order event) would wrongly prove a device or
  wrongly restore a chat it says nothing about. Ruled (full text:
  `GET http://127.0.0.1:9321/intercomm/609d16c6a9074e82a1147b6a8f79ef9c`, 2026-09-25): the cause
  must be judged from the event's `performance.now()` dispatch time — CAUSAL only inside
  `[hideAt-1000ms, hideAt+2000ms]` (the 1 s pre-hide allowance because a device may report a lock
  just ahead of the page actually hiding); a tab change requires PROVEN plus NO event of any kind,
  causal or batched, anywhere in the window; everything else is ambiguous and stays locked. The
  proof itself is now earned only by a causal event, never a batched one. Implemented as the pure
  `screenLockEvidence` + `classifyHide` functions in `lockModel.ts` so the rule is unit-testable
  without a fake clock driving the whole panel.
- **(MEDIUM, reviewer) Any 401 from `unlock-with-grant`, not only `grant_invalid`, was clearing the
  grant.** The route's own contract only ever sends `401 {"error":"grant_invalid"}` (contracts.md),
  but the client sits behind Cloudflare Access and a shared fetch layer, so a 401 the app itself
  never produced (an edge failure, a malformed response) is not impossible, and was previously
  read exactly like a real `grant_invalid` and silently forgot a working grant. Fixed: only a JSON
  body of exactly `{"error":"grant_invalid"}` clears the keys; every other 401/failure keeps the
  grant and shows the decoy.
- **(MEDIUM, reviewer) A renewal still in flight at teardown could resurrect a disposed chat.** A
  `disposed` flag, set in `teardown()` and checked by every async continuation that touches the
  session or the DOM, closes this off.
- **Departure, found necessary while fixing the above (not in the original brief): a transient
  renewal failure (anything but `grant_invalid`) now retries every 30 s until the token actually
  expires**, instead of locking on the first failure. A renewal can fail for reasons that have
  nothing to do with the grant (a dropped request, a 5xx); locking on the first blip would defeat
  the point of the feature for a device with a flaky connection.
- Low findings, also fixed: the screen-lock proof is cleared on mount when there is no detector able
  to have earned it (permission revoked, or no Idle Detection API at all); a hide while `granting`
  drops the in-flight mint and retries once the decoy is visible again
  (`retryGrantUnlockOnVisible`) instead of adopting whatever answer eventually arrives; an idle
  period that ran out while the page was away now locks the returning chat INSTANTLY (`idleAway`)
  rather than waiting for a touch that could otherwise be mistaken for activity; an idle fade
  already in progress when the page went away is completed on return, not left for a touch to
  cancel; the settings sheet's dynamic notes (`keepNote`, the auto-lock note, `lockNote`,
  `signOutStatus`) are `role="status"` and linked from their checkbox(es) via `aria-describedby`.

## Not done, and why

- **The on-device timing check on the operator's Android phone** (order and timing of
  `visibilitychange` and the detector's events for a power-button lock, an app switch and a tab
  switch) is unverified: it needs the phone. The design fails closed without it, so shipping is safe;
  an unproven device keeps locking on every switch. Tell the operator plainly if his phone turns out
  to be unable to tell the two apart.
- **PIN rotation does not revoke grants.** cmd exposes no revision to compare, and the spec does not
  ask for it. The runbook says to use "Sign out other devices" after rotating for a lost device.
- No list of a person's grants is shown anywhere; the spec names only revoke-one and revoke-all.

## Watch for

- Migration numbers are shared with the reactions and transcription work: `_LATEST_SCHEMA_VERSION` is
  the single place to renumber, and the store tests import it rather than repeating the number.
- Anything new that reads the unlock token from a stored place would break Inv 41. The grant secret is
  the only credential that may live in `localStorage`, and it can only mint a token.
