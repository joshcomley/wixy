# Subsystem: AI chat (cmd integration)

The admin Chat panel gives the site owner a conversational assistant that edits the site repo
via branch → PR → merge to `main`, landing changes in the owner's draft preview (never
auto-published). **Every wixy conversation is a real cmd chat** — same agents, same
subscription, same transcripts. Spec: [`spec/06-ai-chat.md`](../../spec/06-ai-chat.md). Hard
rule: no direct Anthropic API anywhere (Inv 13).

## What "cmd" is here

The fleet's self-hosted chat spawner on the same hub VM, exposing **two localhost-only,
unauthenticated** HTTP surfaces (the browser never touches them — the admin origin is
`ca.cinnamons.uk`; wixy polls cmd server-side and fans out over SSE):
- **cmd portal** — `http://127.0.0.1:9320` — lifecycle: new-chat, readiness, handover chain,
  send, `ws://…/ws/chat-pending`.
- **Cmd-Chats** — `http://127.0.0.1:9321` — decoded messages + status for a session.

These base URLs are **hardcoded module constants** (`DEFAULT_PORTAL_BASE_URL` /
`DEFAULT_CHATS_BASE_URL`), overridable only via the `CmdChatClient` constructor (tests/E2E) —
they are **not** env vars or settings. The only cmd-pointing *config* is the registry's
`cmdProject` field (which cmd project, not which host).

## The single client (`cmdchat.py:CmdChatClient`)

The **only** module that talks to cmd. One `httpx.AsyncClient`, async-context-managed; 10s
timeout (`DEFAULT_TIMEOUT_S`), up to 3 attempts on `httpx.TransportError`
(`DEFAULT_MAX_ATTEMPTS`); every failure surfaces as `CmdChatError` (a structured error, never
a silent hang). No auth/keys (localhost only).

| Method | Call | Returns |
|---|---|---|
| `new_chat(cmd_project, prompt)` | `POST :9320/api/project/{cmd_project}/new-chat` (202) | `NewChatResult(session_id, workspace_id, pending_state)` |
| `send_message(session_id, text, idempotency_key)` | `POST :9320/api/session/{id}/send` (202) | `SendResult(buffered, pending_state)` |
| `get_chain(session_id)` | `GET :9320/api/session/{id}/chain` | root→leaf handover chain |
| `wait_until_ready(session_id)` | races a readiness poll (`GET :9320/api/session/{id}`, 404→200) vs `ws://…/ws/chat-pending` | `ReadyOutcome \| FailedOutcome(reason,…)` |
| `get_messages(session_id, *, limit=80, include_thinking=False, before=None)` | `GET :9321/sessions/{id}/messages` | `list[ChatMessage]` (already decoded — no raw JSONL parsing in wixy) |
| `get_status(session_id)` | `GET :9321/sessions/{id}/status` | `ChatStatus(activity, process_kind, handover_state, raw)` |

`ChatMessage.kind ∈ text | tool_use | tool_result | thinking | error`. `wait_until_ready`
distinguishes a **`CmdChatError`** (cmd unreachable → propagates, UI shows offline banner)
from a **`FailedOutcome`** (`workspace_failed`/`cli_failed`/`timeout` → provisioning failed).
(`cmdchat.py:186` uses PEP 758 unparenthesized `except` — Inv 14.)

## Conversations store (`chats.py`)

`Storage/projects/<slug>/chats.json` — `{"conversations":[{convId, sessionId, title,
createdAt}]}`, camelCase, oldest-first, written atomically. Only durable identity is
persisted — **not** live status. Transient status lives in `app.state.chat_runtime`
(`ChatRuntimeEntry(status, failure_reason?, failure_message?)`); a conversation absent from
that map reads as `ready` (decisions/00032). `conversation_summary(conv, runtime)` →
`{convId, title, createdAt, status, failureReason, failureMessage}` is the one wire shape used
by both the chat routes and `/api/admin/state`'s `chats` snapshot. `update_session_id` is the
handover-follow mutation (adopt the chain's leaf as the live session).

## Chat routes (`routes_chat.py`, prefix `/api/admin/chat`)

Route table + SSE event envelopes are in [contracts.md](contracts.md) §2, §4. Key behaviours:
- **Create** builds the prompt as `<preamble>\n\n---\n\n<firstMessage>` (or preamble alone),
  `new_chat`s, mints `conv_id = uuid4().hex`, persists, sets runtime `pending`, and spawns
  `_track_readiness` on the app's background task group.
- **Stream** (`_stream_events`, SSE) is a server-side poll→fan-out: wait for readiness (via
  the shared tracker, not a second poller), then every `poll_interval_s` (default 1.2s)
  `get_status` + `get_messages` and diff against `sent_messages` (cmd has no `since=` filter),
  emitting `message`/`status`/`error` events. **Handover-follow:** on a non-null
  `handover_state`, fetch the chain; if the leaf ≠ current session, `update_session_id`, switch
  to the leaf, reset diffing state, continue seamlessly. A `CmdChatError` within
  `transcript_grace_s` (15s) of ready → quiet retry (brand-new-session transcript lag); past
  that → `error` event + back off at `offline_retry_s` (10s). Timing is overridable via
  `app.state.chat_stream_timing` so tests don't wait real seconds.
- **Send** carries an `idempotencyKey` (the UI generates it once per compose attempt and
  reuses it on retry, for server-side dedupe).

## Preamble (`templates/chat_preamble.md`)

Prepended once at creation (<1.5 KB). Sets: identity (the site assistant for Cottage
Aesthetics, working in a worktree of the *site* repo); audience (the **owner**, not a
developer → plain language, restate vague asks then act); "read the repo's `CLAUDE.md`
first"; a routing map (copy/images → `content/`+`images/`; layout/pages → `pages/`+
`partials/`; look-and-feel → `theme/theme.json`); the quality gate (`python -m builder
validate` + tests before shipping); ship discipline (branch → PR → merge; **never publish** —
merging only updates the draft; tell the owner to press Publish); and a scope fence (requests
about the wixy *engine itself* are out of scope — note them for the operator).

## Chat panel UI (`admin-ui/src/chatPanel.ts`)

`mountChatPanel(conversation, deps)` → list view (`#/chat`, polls `getConversations` every 2s,
status dot per `ConversationSummary.status`) or detail view (`#/chat/<conv>`). Detail opens a
browser `EventSource` on the stream route (`api.ts:openConversationStream`); `message` events
render markdown bubbles (`markdown.ts`, `createElement`/`textContent` only — never
`innerHTML`), collapse contiguous tool runs into a "⚙ n actions" group, and filter `thinking`
unless the reasoning toggle is on (which reconnects the stream with `?includeThinking=true`).
An `error` event shows the offline banner (the server already auto-retries). Non-user messages
trigger a throttled upstream check that toggles the "Preview updated — review changes" chip.
Send generates the idempotency key once per attempt (reused on a failed retry). **Handover is
fully server-side** — the UI just surfaces `handoverState`.

## Config & test doubles

`create_app(..., cmdchat_client=None, chat_stream_timing=None)` defaults `cmdchat_client` to a
real `CmdChatClient()`; the E2E fixture (`e2e/fixture_server.py`) points both base URLs at one
fake-cmd port. `wixy_server/tests/fake_cmd.py` implements both surfaces as one FastAPI double
(`create_fake_cmd_app` via ASGITransport for HTTP; `FakeCmdServer` real ephemeral-port uvicorn
for the websocket), making the chat suite hermetic. One `@pytest.mark.live_cmd` smoke test
does a real "reply with the word pong" round-trip against local cmd (excluded from CI by the
default `addopts`).
