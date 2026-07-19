# Two real bugs in the worker's FastAPI app, caught by tests interfering with each other

## Symptom

`wixy_server/tests/test_worker_app.py` (`wixy_server.worker.app`'s HTTP-level
tests) showed 6 of 12 tests failing — but every failure passed cleanly when run
in isolation (`pytest test_worker_app.py::TestCreateConversation::
test_first_message_triggers_a_background_agent_run` alone: green). Running the
whole file: red. This is the exact "works alone, fails in the suite" signature
this repo's own doctrine says to never dismiss as a flake without
root-causing — and it turned out to hide two real, independent bugs.

## Bug 1: a module-level `APIRouter` shared across every `create_worker_app()` call

`wixy_server/worker/app.py`'s first draft declared `router = APIRouter(prefix=
"/conversations")` at MODULE scope, matching `wixy_server/routes_engine.py`'s
own top-level-router convention. That convention is safe there because
`routes_engine.py`'s handlers read everything from `request.app.state.*`
dynamically — no per-app-instance data is captured in a closure. This worker's
own handlers are different: they close directly over `state` (a `WorkerState`
instance), `resolved_settings`, and `client_factory` — all constructed fresh
inside `create_worker_app()` on every call, specifically so each test gets its
own isolated app.

A module-level `router`, though, is a SINGLETON — every call to
`create_worker_app()` (once per test) kept **appending** new route-handler
closures to the SAME router object rather than getting a fresh one. FastAPI
matches routes in registration order, first match wins. So the SECOND test's
`app.include_router(router)` silently included the FIRST test's closures too —
and since the first-registered handler for a given path always wins, every
test after the first one had its requests quietly served by the FIRST test's
stale `state`/`resolved_settings`/`client_factory`, not its own.

This exactly explains both observed symptoms:
- `test_402s_past_the_monthly_budget` (budget `0.0`) actually ran against the
  FIRST test's own `resolved_settings` (budget `40.0`, the default) — `0.0 >=
  40.0` is `False`, so it never refused, returning 202 instead of the expected
  402.
- Tests spawning a background agent run and polling for an assistant reply
  timed out — the request was served by a stale closure bound to an EARLIER
  test's `client_factory` (often one built from an empty `episodes` list), so
  the fake SDK yielded nothing, silently, forever.

**Fix**: construct `router = APIRouter(...)` INSIDE `create_worker_app()`,
alongside `state`/`resolved_settings`, so every call gets its own router with
handlers correctly closed over THAT call's own objects.

**Watch for this pattern elsewhere**: any future FastAPI app-factory whose
route handlers close over per-instance state directly (rather than reading
`request.app.state`) needs its `APIRouter` constructed INSIDE the factory too
— module-level is only safe for the `request.app.state`-reading style.

## Bug 2: `POST /conversations/{id}/messages` returned 200, not the 202 the client requires

`wixy_server/ai/anthropic_backend.py`'s `AnthropicAIBackend.send()` explicitly
requires `response.status_code == 202` (matching `create_conversation`'s own
202 and cmd's own "sends are 202 Accepted" convention) — raising
`AIBackendError` on anything else. `wixy_server/worker/app.py`'s
`send_message` handler returned a bare `dict` with no explicit status code,
which FastAPI defaults to 200. This would have broken EVERY real send in
production — `AnthropicAIBackend.send()` would raise on its very first call.

Only caught because `test_worker_app.py::TestSendMessage::
test_send_appends_user_message_and_runs_a_turn` asserted the literal status
code, not just the response body — a reminder that a route test asserting
only `response.json() == {...}` without also checking `response.status_code`
would have missed this entirely.

**Fix**: `@router.post("/{conv_id}/messages", ..., status_code=202)` — the
decorator-level `status_code` param, since this handler has two return points
(the idempotent-retry early return and the normal path) and both need the
same code, cheaper than wrapping every `return` in an explicit `JSONResponse`.

## What to watch for

Any future new route added to `wixy_server/worker/app.py` needs its expected
status code checked against what `wixy_server/ai/anthropic_backend.py`'s
client actually requires for that call — the two files are a matched pair and
nothing enforces they agree except tests exercising both, or careful
cross-reading. Consider, in a later slice, a small shared constant module for
the expected status per route rather than duplicating the literal `202`/`404`
checks independently on each side.
