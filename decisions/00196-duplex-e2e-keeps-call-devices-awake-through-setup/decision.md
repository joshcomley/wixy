# Symptom

`e2e/tests/server-calls.spec.ts` "duplex sound, muted idle pause, panic stop and fresh idle countdown"
failed intermittently in full runs (twice on 2026-10-28, never in ~35 targeted runs), always as
"Test timeout of 90000ms exceeded" followed by `browserContext.close: Protocol error
(Target.disposeBrowserContext): Failed to find context` (or "Test ended") from the `finally`. Sometimes it
was stuck on `getByRole('radio', { name: /Receiver/ })` after `toHaveCount(2)` had passed, sometimes on
"Connecting audio…".

# Root cause (measured)

Not leftover state (the per-test reset already clears the call broker, peers and admission budgets) and not
a product race. The test unlocks three devices in turn and only the Observer got synthetic activity. The
unlocked chat's idle lock is `IDLE_LOCK_MS` = 10 s and a RINGING call deliberately does not pause it (only a
connected call does, Inv 55, `docs/ai/livechat.md`). On a loaded machine the setup (three unlocks, the dialog,
Answer) takes longer than 10 s, so the Receiver (or the Caller) idle-locks, `chatView.detach()` closes its
call socket, and the broker's presence drops it. The open picker then re-renders without it (so the radio
the test waits for vanishes right after the count check passed), or the ring/connect never completes.

Reproduced RED deterministically: an 11 s pause after the unlocks, while only the Observer is active, fails
the test with exactly the same timeout. The `browserContext.close` error is a symptom: the 90 s test timeout
fires while the `finally` is closing the contexts, and Playwright reports the teardown race.

# Decision

Harness fix, no product change (the idle lock and the ringing rule are decided behaviour). The test moves the
mouse on the Caller and Receiver every second from their own unlock until both are muted, then stops, so the
muted-idle phase still proves that only the connected call, not activity, holds them open. Same GREEN under
the 11 s pause. Never add a longer idle period to the app to cover a slow test.

# Watch for

Any e2e that needs several unlocked devices at once must keep each one active during setup (10 s lock), and
must stop that activity before asserting anything about the idle countdown.
