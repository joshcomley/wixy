# 00010 [9d7m9x] M10 WX — AI chat

## What
`cmdchat.py` client + fake-cmd test double, conversations store, create/pending/ready
flow, send w/ idempotency, poll->SSE fan-out, chat panel UI (markdown, tool rows, status
dot, preview-updated chip, offline banner), handover-follow; E2E 7; preamble template.

## Why
Owner-experience bullet #4 (chat with an AI, "exactly like chatting in cmd").

## Context / current state
Depends on 00006 (server core) and 00009 (publish/draft-status chip integration point) —
both DONE. Milestone 10 is genuinely new territory (async polling + websocket +
idempotent-send + handover-follow, unlike M7-M9's extend-an-existing-foundation shape) —
sliced backend-first, matching M6-M9's own pattern:

- Slice 1 [DONE]: `wixy_server/cmdchat.py` (new) — the one client module spec/06 §1's
  preamble mandates for every cmd call. Raw endpoint wrappers (`new_chat`, `get_chain`,
  `send_message`, `get_messages`, `get_status`) plus a higher-level `wait_until_ready`
  orchestration (races a bounded 2s-interval readiness poll against a best-effort
  `/ws/chat-pending` websocket subscription for an early failure signal, per spec/06
  §1's exact readiness contract — graceful degradation to pure polling if the WS never
  connects). Retry policy (10s timeout, 2 retries on connect errors) centralized in one
  `_request` helper. Found and fixed a real bug via testing (not assumed correct): a
  `CmdChatError` raised inside `wait_until_ready`'s task group came out wrapped in a
  `BaseExceptionGroup` (native asyncio TaskGroup semantics), which would have defeated a
  caller's plain `except CmdChatError` — fixed by unwrapping a single-exception group
  before re-raising. `wixy_server/templates/chat_preamble.md` (new, 1404 bytes, under
  spec's 1.5KB cap). `wixy_server/tests/fake_cmd.py` (new) — a combined fake-cmd FastAPI
  app (spec/06 §4), tested via `httpx.ASGITransport` for plain HTTP and a real
  ephemeral-port `uvicorn`-in-a-thread (`FakeCmdServer`) for the websocket (ASGI
  transports can't do the upgrade) — found and fixed a second real bug (cross-thread
  `asyncio.Queue.put_nowait` from the test's loop into the server thread's loop; fixed
  with `call_soon_threadsafe`). Added `websockets>=13.0` (server extra). No admin API
  routes or `chats.json` store yet — later slices consume this interface. Full
  reasoning: decisions/00031.
- Slice 2 [PLANNED]: conversations store (`chats.json`, spec/04 §2) + create/pending/
  ready flow (`POST`/`GET /api/admin/chat/conversations`) + wire the `chats` field in
  `GET /api/admin/state` (currently a hardcoded `[]`).
- Slice 3 [PLANNED]: send w/ idempotency (`POST .../messages`) + poll->SSE fan-out
  (`GET .../stream`) + rename + handover-follow (chain-endpoint adoption). Candidate
  point to also add the one `@pytest.mark.live_cmd` smoke test (spec/06 §4) against the
  REAL local cmd this workspace runs inside — a genuine end-to-end opportunity most
  milestones don't get.
- Slice 4 [PLANNED]: chat panel UI (admin-ui) — conversation list, `#/chat/<conv>` view
  (markdown, tool-activity rows, status dot, composer, offline banner, preview-updated
  chip). The router already has the `chat` route scaffolded (`comingSoon` placeholder in
  shell.ts) from an earlier milestone's spec/05 read — this slice replaces it for real.
- Slice 5 [PLANNED]: E2E 7 (chat UX) + closing.

Never call the Anthropic API directly — all inference via cmd's new-chat/send/messages
endpoints per spec 06 (enforced in `cmdchat.py`: it only ever talks to localhost
9320/9321, never api.anthropic.com).

## Relevant files
- spec/06-ai-chat.md (full — exact endpoints, lifecycle, preamble, failure table)
- spec/08-testing-acceptance.md §1 (fake cmd server test list), §2 E2E 7, §4 (@live_cmd
  smoke, run during M13 verification not CI)

## How to continue + acceptance
cmd endpoints verified against cmd CODE not the stale docs/ai/contracts.md. Readiness =
404->200 transition poll (max 120s) + WS pending-state subscribe — DONE (slice 1,
`cmdchat.wait_until_ready`). Handover-follow via /chain endpoint — client method DONE
(slice 1, `get_chain`), route-level adoption still PLANNED (slice 3). Embedded chat has
NO publish tool (enforced by the preamble template, DONE slice 1 — never at the HTTP
layer, since wixy has no way to constrain what the agent's cmd session does beyond
instructing it). E2E 7 (scripted fake replies, tool rows, status transitions, send-retry
on 502, offline banner) still PLANNED (slice 5).

## Links
PR (slice 1): (fill in when opened)
