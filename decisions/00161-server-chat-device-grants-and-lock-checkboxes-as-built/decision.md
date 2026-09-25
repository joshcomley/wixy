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
