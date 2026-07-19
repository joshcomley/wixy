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
`wixy_server/ai/{__init__.py,backend.py}` (new — `AIBackendError`, `ConversationRef`
frozen dataclass, `AIBackend` Protocol, `CmdAIBackend` wrapping `CmdChatClient`),
`wixy_server/app.py` (wires `CmdAIBackend`), `wixy_server/routes_chat.py` (full
rewrite onto `AIBackend`/`ConversationRef`), `wixy_server/tests/test_routes_chat.py`
(7 functions' fixture renamed to `ai_backend`). Branch: `indep/m5-ai-backend-interface`
(stacked on M1). decisions/00056 (includes a self-review note on a replace_all
mistake that briefly mis-renamed 10 unrelated functions — caught via mypy, fixed).

**PR renumbered #70 -> #73.** Same incident as M3's #69->#72: PR #67 (M1) merged with
`--delete-branch`, GitHub auto-CLOSED every other open PR based on that branch instead
of retargeting. Branch + commits untouched (head
`c314752cec3375451ec4e855364967ee04992ecc`), recreated as a fresh PR against `main`
directly. Not yet Fable-reviewed under either number.

## How to continue + acceptance
CI-gated only, auto-merge on green (PR #73). Acceptance: all existing chat/cmdchat tests
pass unmodified in assertions (only their target/import may change); no route-visible
behavior change on the fleet edition — verified via the full suite.

## Links
spec/independence/05 §1; spec/independence/09 row 5.
