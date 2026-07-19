# 00005 [ts699l] M5 — AI backend interface extraction

## What
Extract the existing `wixy_server/cmdchat.py` surface into a protocol
(`wixy_server/ai/backend.py`) the chat routes consume: `create_conversation(preamble,
first_message) -> conv_ref`, `send(conv_ref, text)`, `read(conv_ref, after) -> [messages]`,
`status(conv_ref)`, plus capability flags (e.g. `supports_handover_chains`). `cmd` backend
= today's code moved behind it, BEHAVIOR-IDENTICAL — fleet sets WIXY_AI_BACKEND=cmd;
existing tests keep passing against the fake cmd server (`wixy_server/tests/fake_cmd.py`).

## Why
Pure refactor that makes M6's `anthropic` backend a second implementation of the same
interface rather than a fork of the chat routes. No behavior change on the fleet path.

## Context / current state
`cmdchat.py` full surface mapped 2026-07-19 (see M1 sidecar's Explore report): `CmdChatClient`
class with new_chat/send_message/get_messages/get_status/watch_pending etc. This is the
thing to wrap, not rewrite. `wixy_server/tests/test_cmdchat.py` (449 lines) is the existing
coverage that must stay green untouched in behavior.

## Relevant files + commits
`wixy_server/ai/__init__.py` + `ai/backend.py` (new: AIBackend Protocol,
ConversationRef, AIBackendError, CmdAIBackend), `wixy_server/app.py` (constructs
CmdAIBackend, exposes app.state.ai_backend alongside the unchanged
app.state.cmdchat_client), `wixy_server/routes_chat.py` (consumes AIBackend
throughout; `_prompt_for` deleted, its logic moved into CmdAIBackend.create_conversation),
`wixy_server/tests/test_routes_chat.py` (17 fixture-wiring updates, zero assertion
changes), `decisions/00056`. Branch: `indep/m5-ai-backend-interface` (stacked on M1 —
touches settings.py-adjacent territory conceptually, though this milestone itself
didn't add WIXY_AI_BACKEND, deliberately — decisions/00056 decision 5).

Self-caught-and-fixed mid-flight: an over-broad replace_all during the mechanical
test-wiring pass wrongly renamed 10 unrelated test functions' fixture parameters
(ones using cmdchat_client for create_app, not _stream_events) — caught immediately
via mypy + the test suite, fixed with 10 individually-anchored edits. Full account in
decisions/00056's "what to watch for".

One flaky test observed under full-suite load (TestStateChatsField::
test_state_reflects_created_conversations) — third occurrence of the known
full-suite-contention timing-flake class already documented in decisions/00025 and
00053; passed cleanly in isolation and on immediate re-run, not chased further.

## How to continue + acceptance
CI-gated only, auto-merge on green. Acceptance: all existing chat/cmdchat tests pass
unmodified in assertions (only their target/import may change); no route-visible behavior
change on the fleet edition. Met: ruff/mypy clean, full suite 578 passed.

PR: https://github.com/joshcomley/wixy/pull/70 (branch indep/m5-ai-backend-interface,
stacked on #67/M1). Blocked on the same CI outage as #66-69.

## Links
spec/independence/05 §1; spec/independence/09 row 5.
