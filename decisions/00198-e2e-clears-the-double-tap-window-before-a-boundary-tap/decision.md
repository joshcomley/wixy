# E2E clears the double-tap window before a boundary tap, and CI keeps failure screenshots

`server-reply.spec.ts` "desktop" failed intermittently with `.wx-srv-bubble-mine` (Josh's own message)
"element(s) not found" after the quote was tapped. The retained trace showed page A back on the
decoy: Send was tapped at 3.741 s and the reply's quote (a `data-srv-gesture-boundary` control) at
4.101 s, 360 ms later. A boundary tap closes a run opened by any earlier tap inside
`MULTI_TAP_INTERVAL_MS` (400 ms) and locks the chat (gestures.ts, R3 v1.5), so the thread was
detached. This is the specified double-tap lock, not a product defect; the test simply raced it
because Purdy's reply can arrive within a few hundred ms of Josh's Send.

Decision: the test waits `MULTI_TAP_INTERVAL_MS + 100` before tapping the quote. Tests that tap two
controls in quick succession on one page must respect that window, as `unlockServer` already does.

Also decided: `playwright.config.ts` sets `screenshot: "only-on-failure"` and CI uploads
`e2e/test-results/` (7 days) when the e2e job fails. `trace: "retain-on-failure"` was measured and
rejected: full suite at 4 workers 248 s without, 325 s with (+31 %), and one traced run hung
`context.close()` for 27 s until the test timeout.
