# e2e: every test starts from a pristine Server chat

## Symptom
The required e2e job failed at random. PR #344 (2026-10-28): `server-wyr.spec.ts` "the chat is full screen" saw `.wx-srv-tabs` visible (an earlier test's unfinished Adventure Time round was OFFERED as a tab), and `server-calls.spec.ts` "microphone rejection" failed once (caller notice hidden; not reproduced locally in 6 throttled, 3 serial and 24 parallel runs, so it is NOT claimed fixed by the reset beyond removing leftover call state as a cause). Earlier: a double-tap pressed an earlier Adventure card's Play button.

## Root cause
One fixture server per Playwright worker means one Server chat shared, in sequence, by every test on that worker, and which tests share a worker varies per run. Messages, game rounds, grants, call state, PIN lockout and fake-cmd transcription settings leaked between tests. Reproduced red: `WIXY_E2E_WORKERS=1 npx playwright test server-adventure server-wyr` fails wyr:117; green with the reset.

## Decided
- `e2e/fixture_server.py` gets a test-only `POST /test/server/reset` (never in the product app): the product's `wipe_for_scrub` + the storage sweep the real wipe route runs, then what a wipe keeps (device grants, push subscriptions, `adv_settings`), then in-memory state (call broker sessions and admission budgets, rate limiters, fake-cmd transcription settings, PIN lockout, delete-response delay). The DB file is never replaced under live connections.
- `e2e/fixtures.ts` runs it from one test-scoped auto fixture, `serverChatReset`. No spec cleans up after itself or relies on leftovers.
- Item toolbar (`editor/src/overlay.ts`): the one floating toolbar now carries `data-wx-toolbar-list` / `data-wx-toolbar-index` naming its item. `collection-edit.spec.ts` presses only that item's toolbar (hover + press retried together) and waits for the PATCH that edits `showcase.items` (`waitForNextDraftPatchAccepted(page, { path })`), because a loaded run's wait was satisfied by a footer-link PATCH. The product behaviour is unchanged; only an inspection attribute was added.
- Image checks in the Adventure spec poll until the photo has loaded instead of sampling `complete`/`naturalWidth` once.
- `page.clock.install()` does not pause time; use `freezeClock`.

## Watch for
- A new piece of server state outside the store or `app.state` must be added to the reset.
- Page CPU throttling (CDP, 6-12x) did NOT break the live-delivery or microphone-rejection tests; failures seen only in one 11-minute full run (a 6.6-minute test against a 30 s timeout) were whole-machine stalls on a shared box, not test logic. Do not widen timeouts for them.
