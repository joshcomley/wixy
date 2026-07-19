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
(fill in as PR lands)

## How to continue + acceptance
CI-gated only, auto-merge on green. Acceptance: all existing chat/cmdchat tests pass
unmodified in assertions (only their target/import may change); no route-visible behavior
change on the fleet edition.

## Links
spec/independence/05 §1; spec/independence/09 row 5.
