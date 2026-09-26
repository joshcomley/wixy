# 00001 [g491g0] e2e: replace the fixed login sleeps (next measured speed lever)

## What
Cut the fixed real-time waits in the e2e suite's Server-chat login flow: 86 `waitForTimeout` call sites, 98
logins each sleeping ~1 s (500 ms for the affordance's 400 ms ignore window, plus MULTI_TAP_INTERVAL_MS + 100
after unlock so the next tap is not read as a double-tap panic lock). The login helper is copy-pasted into 13
specs (server-chat, composer-focus, layout, lock, media, message-text, permanent-unlock, push, reactions, reply,
send-no-flicker, tap-precision, view-once).

## Why
After the per-worker fixture change (decisions/00170, PR #279) the suite is 211 s locally / ~245 s on CI. Summed
test time is ~757 s under 4-way contention; the sleeps are roughly 100 s of it (10-15%), concentrated in the
two-user specs (two logins per test). Operator's Q-019 (Answers log) asked for 10-100x; this is the next measured
step and is NOT expected to reach that (real browsers, two-user flows).

## Context + current state
- server-lock.spec.ts and server-permanent-unlock.spec.ts already use Playwright `page.clock` (install, then
  `runFor(401)`) and average 0.8-1.0 s per test versus 3-8 s for specs on real sleeps.
- `page.clock.install()` fakes every timer on the page, so applying it wholesale to specs that wait on real app
  timers (viewer auto-close 2 s, 12 s delayed delete, long-press 500 ms) needs care: verify time still flows
  (no `pauseAt`), or scope the fake clock to the login phase only.
- Overlapping the two logins of a two-user test (`Promise.all`) is an even cheaper first cut.

## Relevant files
e2e/tests/server-*.spec.ts (each has its own `unlockServer`/`revealAndOpenPinPad`/`withServerPage`),
e2e/fixtures.ts, admin-ui/src/server/gestures.ts (the 400 ms multi-tap window), spec/server-chat (R2 v1.3 reveal
window, R3 double-tap lock).

## How to continue + acceptance
1. Consolidate the 13 login helpers into one shared module first (behaviour-preserving), then change its waits.
2. Measure before/after with the same per-test profile (sum of durations and wall time, full run on the same
   worker count); keep only changes that show a measured gain.
3. Acceptance: 219/219 locally and three consecutive green CI e2e runs; no new sleeps; the
   "PIN-pad taps leave no leftover multi-tap count" and reveal-window tests still pass unchanged.

## Links
decisions/00170-e2e-fixture-server-per-worker/, PR #279 (2194d50), Answers log Q-019.
