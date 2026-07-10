# Milestone 10 slice 5: E2E 7 (chat UX) — closing milestone 10

The final slice of milestone 10: `e2e/tests/chat-ux.spec.ts` (spec/08 §2's
E2E 7 — "new conversation → scripted fake replies incl. tool-activity rows +
status dot transitions; send-retry on injected 502; offline banner on
fake-cmd stop"), plus the fixture wiring it needs. All 5 slices are now
merged; milestone 10 is CLOSED.

## Decision 1: the E2E fixture uses the SAME `FakeCmdServer` the Python unit
suite uses, not a hand-rolled TS stub

`e2e/fixture_server.py` now starts a real `wixy_server.tests.fake_cmd
.FakeCmdServer` (the exact same ephemeral-port uvicorn double
`test_cmdchat.py`/`test_routes_chat.py` already exercise) and injects a
`CmdChatClient` pointed at it into `create_app(cmdchat_client=...)` — the
exact same parameter slice 2 added specifically for this purpose
(decisions/00032). One fake, one behavior contract, exercised from both test
layers — rather than a second, independently-maintained TypeScript fake that
could drift from what `cmdchat.py` actually expects. This also directly
reuses the approach prototyped ad hoc during slice 4's own real-browser
verification pass (decisions/00034) — nothing new to invent here, just
formalized into the checked-in fixture.

`FakeCmdState` gained `default_ready_after_polls` (applied to every session
`create_session` makes) so E2E-created conversations become ready almost
immediately with zero per-conversation fixture wiring — unit tests are
unaffected (default `0`, unchanged from the implicit prior behavior; the 46
tests in `test_cmdchat.py`/`test_routes_chat.py` that touch `FakeCmdState`
all still pass unmodified).

## Decision 2: four fixture-only `/test/chat/*` endpoints, mirroring E2E 6's
own established pattern

- `POST /test/chat/set-messages` — scripts a fake reply (any mix of
  `text`/`tool_use`/`tool_result` kinds) into the conversation the browser
  already created through the REAL admin UI.
- `POST /test/chat/set-send-status` — injects a bad status code for the next
  send, and resets it — the send-retry leg.
- `POST /test/chat/stop-fake-cmd` — the offline-banner leg. Deliberately a
  one-way action (no restart endpoint): the shared, `workers: 1` fixture
  server serves every spec file in one process, and no OTHER spec touches
  chat/cmd, so stopping it as the LAST thing `chat-ux.spec.ts` does is safe.
  Confirmed by running the full 9-spec suite locally — every other flow
  still passes regardless of run order relative to this one.

All three (plus the pre-existing `/test/simulate-upstream-commit`) are
`include_in_schema=False`, never imported by product code, exactly matching
this file's own established convention.

## Decision 3: "status dot transitions" is asserted via two distinct
observation points, not by racing a UI round-trip

The first draft tried to catch the LIST view's dot still showing "pending"
by navigating away and back after creation — this was **genuinely flaky**,
caught by actually running the test (not assumed correct): the fixture's own
fast readiness config (`default_ready_after_polls=1` + a 0.2s poll interval)
resolves readiness within ~0.2-0.4s, faster than the navigate-away-and-back
round trip takes, so "pending" was already gone by the time the assertion
ran. Fixed by asserting "pending" from the `POST .../conversations` response
body itself (a synchronous fact at the exact moment of creation — no race at
all) and asserting "ready" separately, later, via a generously-timed wait on
the list view — two real observation points of the same underlying
transition, neither of them racing the fixture's own deliberately-fast
timing.

## Decision 4: the retry assertion checks EXACT idempotency-key reuse, not
just "an error appeared"

While planning this test (specifically, thinking through how to assert
"retry" meaningfully), tracing through `chatPanel.ts`'s own `send()`
uncovered a real bug: it minted a fresh idempotency key on every call,
including a manual retry — violating spec/06 §1/§3's explicit "same
idempotency key" requirement. Fixed in slice 4 (PR #43, before it merged —
see decisions/00034's own closing note) with a `pendingIdempotencyKey`
cleared only on success. This test's own assertion —
`retryBody.idempotencyKey` equals the FIRST attempt's exactly, captured via
`page.waitForRequest`'s `postDataJSON()` on both the failed and retried
`POST .../messages` calls — is the thing that would have caught this bug
directly, had it been written first. Recorded here as the concrete reason
"assert the real observable, not just that something rendered" matters (this
whole chain's own repeated lesson, reconfirmed once more).

## Milestone 10 is CLOSED

All 5 slices merged (PRs #40-44). Full verification: 535 Python tests, mypy
strict (91 files), ruff clean; 215 admin-ui tests, `tsc --noEmit` clean,
bundle committed; all 9 E2E flows green locally (E2E 1-8 plus the new E2E 7),
confirmed via a full un-sharded local run, not just per-file. The
`@pytest.mark.live_cmd` smoke test (spec/06 §4) remains written-but-unrun,
deliberately deferred to milestone 13's live verification pass per spec's
own scoping (decisions/00033) — not milestone 10's job to execute.

## Files changed

- `e2e/fixture_server.py` — `FakeCmdServer` + `CmdChatClient` wiring, 3 new
  `/test/chat/*` endpoints.
- `wixy_server/tests/fake_cmd.py` — `FakeCmdState.default_ready_after_polls`.
- `e2e/tests/chat-ux.spec.ts` (new) — E2E 7.

**Verification**: mypy strict clean (91 source files — `e2e/` is outside
mypy's configured scope, `["builder", "wixy_server"]`, but ruff DOES cover
it and is clean), ruff check + format clean, full Python suite green (535
passed, unchanged — this slice touches no Python production code path any
existing test exercises differently). Full local E2E run: 9/9 passed.
