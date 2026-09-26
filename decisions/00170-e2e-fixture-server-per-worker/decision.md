## Symptom

219 Playwright tests took about 8.7 minutes locally (522 s) and 7.3-8 minutes on CI. The operator's
report: it "should be 10 to 100 times faster", suspecting the app was set up again between tests.

## Root cause (measured, and the first hypothesis was wrong)

Summing every test's own duration gave 514 s against a 522 s wall time, so nothing is rebuilt
between tests and the fixture server boots once. The time was the tests themselves, run strictly one
after another: `playwright.config.ts` had `workers: 1` plus a single shared `webServer`, on the
grounds that every spec shares the site's one draft overlay (two workers PATCHing it raced on the
overlay rev, a real 409) and each chat spec shares the one chat. The config comment named the exit:
"revisit if the suite ever needs per-file isolated fixture servers".

## What was decided

- `e2e/fixtures.ts`: a worker-scoped, `auto` fixture boots a private `fixture_server.py` per worker on a
  free port (5-9 s cold start; it already builds its own temp git origin, storage and PIN app under a
  private `mkdtemp`) and overrides `baseURL`. Specs import `test`/`expect` from `../fixtures`.
  `browser.newContext()` inherits the worker's `baseURL`, so specs that build contexts by hand work
  unchanged.
- No shared `webServer`, no fixed port. Whole spec files go to whichever worker is free; tests inside a
  file stay serial (`fullyParallel: false`).
- Worker count: `WIXY_E2E_WORKERS`, default 3/4 of the cores capped at 4 (3 on CI's 4 vCPUs, 4 on
  the hub). Never `auto`. At 4 workers on 4 vCPUs the server-side photo bake behind section-panel's
  "align a photo pair" save ran past its 5 s wait on CI.

## Measured result

Local: 522 s serial -> 211 s on 4 workers, 219/219 (about 2.5x). CI: 7.3-8 min -> 242 s, 254 s, 253 s
on three consecutive green runs (3 workers). Per-test durations grow ~47% under 4-way contention, so
the ceiling is well below the 4x the worker count suggests, and nowhere near 10-100x with real
browsers and two-user flows.

## Defects the parallel run exposed (each was real, none was "flake")

- `waitForNextDraftPatchAccepted` looped on `page.waitForResponse`, registering its next listener only
  after a 409 arrived; the queue's immediate replay could land the 200 in that gap and the wait hung.
  One listener now stays attached across retries.
- The view-once viewport cases matched "any view-once bubble" on the recipient's page. Earlier cases
  leave unopened view-once messages on the worker's server, so the assertion passed against a
  leftover (never checking the new message) or hit a strict-mode error on a slower runner. Now the
  accepted 201 of the send is awaited and the bubble is found by its `seq`.
- server-reply's mobile long-press pressed the optimistic echo, which the confirmed message then
  replaces mid-press; it now waits for `data-message-seq`.

## What to watch for

- A new spec must import from `../fixtures`, and must not assume it runs first or alone on its server:
  earlier files on the same worker leave messages and view-once items behind. Look messages up by their
  own `seq`/unique text, never "the one bubble of this kind".
- A one-way `/test/chat/stop-fake-cmd` (chat-ux) still poisons the rest of THAT worker's server, exactly
  as it poisoned the shared one before; nothing else touches chat/cmd.
- A worker restarts after a failed test and boots a fresh server (a few seconds), so a failure also resets
  that worker's accumulated state.
- Remaining cost is mostly fixed real-time waits: 86 `waitForTimeout` call sites and 98 logins each
  sleeping ~1 s (500 ms affordance reveal window + 500 ms tap spacing), with the login helper copied into
  13 specs. Replacing them (fake clock as server-lock.spec.ts already does, or shared conditions) is the
  next measured lever, worth roughly 10-15% of summed test time. Reusing one unlocked chat across tests is
  not possible by design: a reload locks the chat.
- The repo's testing rule still applies: do not classify a Server-chat e2e failure as host load on a
  handful of retries (docs/ai/testing.md asks for 10/10 on an unloaded node).
