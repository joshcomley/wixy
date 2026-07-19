# M6 backend-contract test suite: routes_chat.py was only ever tested against cmd

## Context

spec/independence/05 §4: "Backend-contract test suite runs against BOTH: the
fake cmd server AND a fake Agent-SDK harness (scripted tool-use episodes)."
The handover framed this as a judgment call: "separate thorough files may
already satisfy this." This entry records the actual finding and what closed
the gap.

## The gap: routes_chat.py's own test suite never used the anthropic backend

`test_routes_chat.py` (the ROUTE-layer test suite for `/api/admin/chat/*`)
constructs `create_app(..., cmdchat_client=cmdchat_client)` in EVERY single
test — every one of them exercises `routes_chat.py` exclusively through
`CmdAIBackend`. Meanwhile `test_anthropic_backend.py` thoroughly tests
`AnthropicAIBackend` itself (the CLIENT), and `test_worker_runner.py`/
`test_worker_app.py` thoroughly test the WORKER side (the "fake Agent-SDK
harness" spec's own wording names) — but nothing had ever proven that
`routes_chat.py`, the piece that's SUPPOSED to be entirely backend-agnostic
(M5's whole point, decisions/00056), actually behaves identically when a
different concrete `AIBackend` is plugged into `app.state.ai_backend`.

Reading `routes_chat.py` shows it has exactly ONE spot that branches on
backend type at all (`client.supports_handover_chains`, gating the
handover-chain-follow logic in `_stream_events`) — everywhere else it calls
the shared protocol generically. That's a low-risk profile, but "the code
looks backend-agnostic" and "a test has verified it stays that way" are
different claims, and only the second one is what spec's own checklist
language asks for.

## What was added: test_routes_chat_backend_contract.py

A NEW file, not a retrofit of `test_routes_chat.py`'s ~900 lines into a
parametrized suite — retrofitting every existing cmd-specific test (title-
truncation string logic, the cmd-project-registry lookup, prompt-composition
details that are genuinely done differently per backend — see below) would
have been high-risk, low-value churn for behavior that's either pure HTTP-
layer logic already proven once, or doesn't have a meaningful anthropic
analog at all. Instead: a focused set of tests proving the CORE shared
contract — create (with/without a first message) → transitions to ready →
send (idempotency, buffered-state, 404, backend-error-mapping) → stream
delivers messages (including the thinking-hide/show toggle) → unknown-
conversation 404s — holds for `AnthropicAIBackend` + `fake_worker.py` too,
plus one test proving the ONE spot that DOES branch on backend type
(`supports_handover_chains=False`) behaves correctly (never attempts to
follow a chain, `handoverState` stays `None`).

Deliberately NOT duplicated: `CmdAIBackend`'s own prompt-composition test
(`AnthropicAIBackend` doesn't replicate that logic client-side at all — it
sends `preamble`/`firstMessage` separately and the WORKER combines them,
already covered by `test_worker_app.py`); the cmd-project-registry-lookup
test (no anthropic analog — the worker resolves its OWN target repo from its
own env, decisions/00060, not from anything `routes_chat.py` passes it); and
handover-chain-FOLLOWING itself (genuinely doesn't apply — the new test
proves the DIVERGENT-but-correct behavior instead, not a duplicate of the
same behavior).

## The real bug this surfaced: fake_worker.py never actually filtered thinking messages

Writing the "hides thinking by default" contract test against the anthropic
backend failed for real — not a test-authoring mistake, `fake_worker.py`'s
`GET /conversations/{id}/messages` route accepted the `includeThinking` query
param and silently ignored it, always returning every message regardless.
`wixy_server/worker/app.py`'s REAL equivalent route does filter
(`if not includeThinking: items = [m for m in items if m.kind != "thinking"]`)
— the fake had drifted from the real implementation it's supposed to stand in
for, and nothing had ever exercised that specific query param against it
before this contract-test pass. Fixed to match the real route's filtering
exactly. This is precisely the kind of gap spec's own "runs against... a fake
Agent-SDK harness" language exists to catch — a fake that LOOKS like it
models the real thing can silently stop doing so once nothing exercises the
specific behavior it's supposed to fake.

## A second, smaller bug: the wrong endpoint for a readiness-transition test

The new create-conversation "becomes ready" test initially polled
`GET /api/admin/state` (mirroring a DIFFERENT existing cmd test's approach)
— which 503s under this test file's fixtures, because that route also needs
a real, successfully-cloned site checkout, and these tests deliberately use
an unreachable fake repo URL (the chat routes never touch the site checkout
at all, so nothing else in this file needed one). `test_routes_chat.py`'s
OWN `test_transitions_to_ready_once_tracker_resolves` polls the lighter,
more targeted `GET /api/admin/chat/conversations` instead — switched to match
that exact, already-correct precedent rather than inventing a new approach.
