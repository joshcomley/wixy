# Server-chat e2e specs must leave the 400 ms multi-tap window between taps inside the chat view

## Symptom
`server-chat.spec.ts` "A -> B live delivery" failed at "B's reply never reaches A". B's send
looked like it worked, but the reply was never posted and B's stream showed `net::ERR_ABORTED`.

## Root cause (measured, not inferred)
Lock-state tracing in `panel.ts`'s dispatch showed `multiTap chat->decoy` on B's Send click,
about 2.5 s after B's page loaded. R3 locks the panel instantly on two taps inside the chat
view less than `MULTI_TAP_INTERVAL_MS` (400 ms, `admin-ui/src/server/constants.ts`) apart.
Playwright taps Send within a few ms of the first-unlock name prompt's Continue tap, far faster
than a person, so the spec tripped the panic gesture. The chat view detached, its stream
aborted, and the composer that Send belonged to disappeared. The idle lock did fire, but ~10 s
later, after B was already locked, so it was not the cause.

Two earlier readings were wrong and are recorded so nobody re-tries them:
- "The backend/notifier drops the second event": a raw curl listener received it every time.
- "B idle-locks while waiting, add `keepAlive(pageB)`": that whole run took under 10 s, and with
  that one-line fix alone the A-to-B test still failed on the clean-state run (a mouse *move* is
  not a tap, and takes milliseconds). Only that first run counts: the two repeats on the same
  fixture server were contaminated by the first run's leftover rows.

A distinct, real product bug sat underneath this one and is fixed by P4 (`1e5af5e`):
`panel.ts` never called `MultiTapDetector.reset()` on entering "chat", so PIN-pad taps could
combine with the first chat-view tap. That fix is necessary but was not sufficient for this spec.

## Decided
`unlockServer()` in `server-chat.spec.ts` waits `MULTI_TAP_INTERVAL_MS + 100` ms after the
Continue tap. Any server e2e spec that unlocks and then taps inside the chat view (the media
spec will) must do the same, or space its taps by at least the window. Message text in specs
that share the one-project-per-file fixture server carries a per-run tag so leftover rows from
an earlier run cannot collide with locators.

## Watch for
- A spec that unlocks and immediately taps Send / a thread control: same failure, and it
  reads as "delivery is broken" rather than "locked".
- Do not lengthen `MULTI_TAP_INTERVAL_MS` or add a "grace period" to make specs pass: it is a
  security gesture (R3) and the spec is what should follow it, not the reverse.
