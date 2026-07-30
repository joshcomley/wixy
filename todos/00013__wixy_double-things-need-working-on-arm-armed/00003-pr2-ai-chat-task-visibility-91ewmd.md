# 00003 [91ewmd] PR 2 — unmissable AI-chat task visibility

## What
Give the site owner a live task list while the AI chat works, instead of just a fading
"Assistant is working…" strip. See brief "WORKSTREAM 2":
- 2a. `wixy-tasks` fenced-JSON-block protocol added to `wixy_server/templates/chat_preamble.md`
  (mind: no bare `---` line — `test_preamble.py` pins this); new `wixy_server/chat_tasks.py`
  (`extract_tasks`); `routes_chat.py:_stream_events` emits a new `tasks` SSE event.
- 2b. `admin-ui/src/chatPanel.ts` — prominent work banner (working/all-done/hidden) + sticky
  task card; extend `ConversationStreamEvent` in `api.ts`.
- 2c. Conversation list shows working state too — server enrich `working: bool` per
  conversation (TTL-cached ~5s), list row pulses.
- Docs (`contracts.md`, `ai-chat.md`) + 1 decisions entry.

## Acceptance
Same test/build/lint gate as PR1. Live check: real conversation, small real request, watch
banner/tasks appear, list row pulses from another tab.

## Links
Brief section "WORKSTREAM 2 (PR 2)". Depends on PR1 merged first (sequential per brief).
