# 00010 [9d7m9x] M10 WX — AI chat

## What
`cmdchat.py` client + fake-cmd test double, conversations store, create/pending/ready
flow, send w/ idempotency, poll->SSE fan-out, chat panel UI (markdown, tool rows, status
dot, preview-updated chip, offline banner), handover-follow; E2E 7; preamble template.

## Why
Owner-experience bullet #4 (chat with an AI, "exactly like chatting in cmd").

## Context / current state
Depends on 00006 (server core) and 00009 (publish/draft-status chip integration point).
Never call the Anthropic API directly — all inference via cmd's new-chat/send/messages
endpoints per spec 06.

## Relevant files
- spec/06-ai-chat.md (full — exact endpoints, lifecycle, preamble, failure table)
- spec/08-testing-acceptance.md §1 (fake cmd server test list), §2 E2E 7, §4 (@live_cmd
  smoke, run during M13 verification not CI)

## How to continue + acceptance
cmd endpoints verified against cmd CODE not the stale docs/ai/contracts.md. Readiness =
404->200 transition poll (max 120s) + WS pending-state subscribe. Handover-follow via
/chain endpoint. Embedded chat has NO publish tool. E2E 7 (scripted fake replies, tool
rows, status transitions, send-retry on 502, offline banner) passing.

## Links
PR: (fill in when opened)
