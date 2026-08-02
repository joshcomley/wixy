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
| `new_chat(cmd_project, prompt)` | `POST :9320/api/project/{cmd_project}/new-chat` (202) — body also carries `spawned_by_session_id: ""` (`UNPARENTED_SPAWNED_BY`) + `model: "claude-sonnet-5"` (`CHAT_MODEL`); see below | `NewChatResult(session_id, workspace_id, pending_state)` |
| `send_message(session_id, text, idempotency_key)` | `POST :9320/api/session/{id}/send` (202) | `SendResult(buffered, pending_state)` |
| `get_chain(session_id)` | `GET :9320/api/session/{id}/chain` | root→leaf handover chain |
| `wait_until_ready(session_id)` | races a readiness poll (`GET :9320/api/session/{id}`, 404→200) vs `ws://…/ws/chat-pending` | `ReadyOutcome \| FailedOutcome(reason,…)` |
| `get_messages(session_id, *, limit=80, include_thinking=False, before=None)` | `GET :9321/sessions/{id}/messages` | `list[ChatMessage]` (already decoded — no raw JSONL parsing in wixy) |
| `get_status(session_id)` | `GET :9321/sessions/{id}/status` | `ChatStatus(activity, process_kind, handover_state, raw)` |

`ChatMessage.kind ∈ text | tool_use | tool_result | thinking | error`. `wait_until_ready`
distinguishes a **`CmdChatError`** (cmd unreachable → propagates, UI shows offline banner)
from a **`FailedOutcome`** (`workspace_failed`/`cli_failed`/`timeout` → provisioning failed).
(`cmdchat.py:186` uses PEP 758 unparenthesized `except` — Inv 14.)

**The create call's two non-obvious body fields** (`decisions/00092-chat-create-lineage-and-model`):

- `spawned_by_session_id: ""` — **required by cmd**; omitted/null is a 400, not a default
  (cmd's `engine/spawn_lineage.py`, its decisions/00071). `""` is cmd's "deliberately
  unparented, top-level chat" sentinel — what every Wixy conversation is (owner-started in
  the admin panel, never an agent's subordinate work). Omitting it made every "New
  conversation" fail as the owner-visible `request failed with status 502`.
- `model: "claude-sonnet-5"` — pinned, **not** inherited: cmd defaults a fresh Claude chat to
  Opus, so spec/06's original "omit for the account default" no longer yields the intended
  tier. Matches the standalone edition's `worker/runner.py::DEFAULT_MODEL`. `effort` is still
  omitted (account default).

Because these unit tests run against `tests/fake_cmd.py`, a cmd-side contract change is
invisible until the live smoke test or production. **Mirror any such change in the fake
first, then fix the caller** — the fake accepting anything is exactly how the 502 shipped
green. The fake now 400s a create with no `spawned_by_session_id`, as cmd does.

## Conversations store (`chats.py`)

`Storage/projects/<slug>/chats.json` — `{"conversations":[{convId, sessionId, title,
createdAt}]}`, camelCase, oldest-first, written atomically. Only durable identity is
persisted — **not** live status. Transient status lives in `app.state.chat_runtime`
(`ChatRuntimeEntry(status, failure_reason?, failure_message?)`); a conversation absent from
that map reads as `ready` (decisions/00032, `chats.effective_status`). `conversation_summary(conv,
runtime, *, working=False)` → `{convId, title, createdAt, status, failureReason, failureMessage,
working}` is the one wire shape used by both the chat routes and `/api/admin/state`'s `chats`
snapshot. `update_session_id` is the handover-follow mutation (adopt the chain's leaf as the
live session).

`working` (decisions/00097, `chat_working.WorkingCache`) is computed OUTSIDE this module — it
needs a live async `client.status()` call, which `conversation_summary` (a plain sync dict-
builder) deliberately doesn't make itself. The two call sites deliberately do NOT treat this
symmetrically — see `chat_working.py`'s own docstring for the full reasoning, measured against
a real regression, not merely designed defensively:
- `routes_chat.list_conversations` (the dedicated, owner-facing chat list, polled every 2s only
  while that screen is open): loads the conversation list, filters to `effective_status(...) ==
  "ready"` (a pending/failed conversation is never polled), and calls `WorkingCache.working_for
  (client, ready)` — this DOES trigger a live, TTL-cached `client.status()` refresh for stale
  entries, bounded per-call by `chat_working._STATUS_TIMEOUT_S` (2s) regardless of how patient
  `CmdChatClient`'s own defaults are (10s × 3 retries — tuned for the open chat STREAM, not this
  courtesy check).
- `routes_admin_api._chats_snapshot` (part of `/api/admin/state`, the critical-path endpoint
  nearly every admin panel depends on for its own instant render): calls the read-only
  `WorkingCache.cached_working_for(conversations)` instead — returns whatever's ALREADY cached,
  never awaits anything, zero added latency. This endpoint's copy of `working` can be up to
  `cache_ttl_s` (5s) stale, or a default `false` if nobody has viewed the chat list recently;
  that staleness is the accepted trade-off for never letting a slow-or-dead cmd add latency to
  a page load that has nothing to do with chat.

## Chat routes (`routes_chat.py`, prefix `/api/admin/chat`)

Route table + SSE event envelopes are in [contracts.md](contracts.md) §2, §4. Key behaviours:
- **Create** builds the prompt via `preamble.compose_prompt` →
  `<preamble>\n\n---\n\n<firstMessage>` (or preamble alone), `new_chat`s, mints
  `conv_id = uuid4().hex`, persists, sets runtime `pending`, and spawns `_track_readiness` on
  the app's background task group.
- **Stream** (`_stream_events`, SSE) is a server-side poll→fan-out: wait for readiness (via
  the shared tracker, not a second poller), then every `poll_interval_s` (default 1.2s)
  `get_status` + `get_messages` and diff against `sent_messages` (cmd has no `since=` filter),
  emitting `message`/`status`/`tasks`/`error` events. **Every message passes through
  `_owner_visible` first** (decisions/00093): it strips the preamble out of the first user
  message, and drops that message entirely when it's preamble-only (a conversation opened
  with no opening message) — the owner must never see the engine's own prompt, while
  cmd/the worker keep the full text because the model needs it. **Then, for an assistant `text`
  message, `chat_tasks.extract_tasks` runs** (decisions/00097) — strips any `wixy-tasks` fenced
  block out of the text (the owner never sees raw protocol JSON either) and returns the block's
  parsed tasks, if any. Both strips run **before** the `sent_messages` diff, so the cache holds
  exactly the cleaned text that was actually sent; diffing raw while emitting cleaned would
  re-send the message every tick. The `tasks` event is gated on a SEPARATE diff (the latest
  parsed tasks vs. the last ones sent) — a re-emitted block whose only change is a task status
  can leave the cleaned surrounding text byte-identical to what was already sent, so tying
  `tasks` emission to the message-event dedup would silently swallow real progress updates.
  **Handover-follow:** on a non-null `handover_state`, fetch the chain; if the leaf ≠ current
  session, `update_session_id`, switch to the leaf, reset diffing state (incl. the last-sent
  tasks), continue seamlessly. A `CmdChatError` within `transcript_grace_s` (15s) of ready →
  quiet retry (brand-new-session transcript lag); past that → `error` event + back off at
  `offline_retry_s` (10s). Timing is overridable via `app.state.chat_stream_timing` so tests
  don't wait real seconds.
- **Send** carries an `idempotencyKey` (the UI generates it once per compose attempt and
  reuses it on retry, for server-side dedupe).

## Attachments (decisions/00103, extended 00110)

The composer lets the owner attach images to a message (paste, drag-drop, or the 📎
button) — e.g. "what do you see in this photo?" against a real treatment picture. **cmd
does the compression, wixy does not**: cmd's own `POST :9320/api/uploads` resizes to a
1568px longest edge (LANCZOS, aspect-preserved) and re-encodes as WEBP q85 server-side —
the same pipeline cmd's own web chat UI relies on. Wixy's job is a thin pre-flight guard
(`chat_attachments.validate_attachment`: 5MB cap, `image/{png,jpeg,gif,webp}` only,
Pillow-readable — all matching cmd's own accepted set exactly) plus wiring the two-step
reference flow through:

1. `CmdChatClient.upload_attachment(data, filename, media_type, session_id=...)` →
   `POST :9320/api/uploads` `{kind:"image", name, media_type, bytes_b64, session_id}` → cmd's
   201 `{id, converted:{width,height,...}}` → `UploadResult(upload_id, width, height)`.
   `width`/`height` are the CONVERTED dims (what the model will actually see), the right
   numbers for a composer preview caption — not the original upload's. `session_id` is an
   optional janitor hint: the "New conversation" compose stages session-lessly through
   `POST /api/admin/chat/uploads` (decisions/00110), exactly like cmd's own new-chat
   compose.
2. `CmdChatClient.send_message(..., attachment_ids=[...])` adds `attachments:
   [{kind:"image", upload_id}]` to the existing `/send` body, **only when non-empty** — an
   ordinary text-only send has byte-identical wire shape to before this feature. `text` may
   be blank when at least one attachment is staged (image-only sends are allowed).
3. `CmdChatClient.new_chat(..., attachment_ids=[...])` (decisions/00110) adds the SAME
   `{kind:"image", upload_id}` entries to the new-chat body — cmd's route docstring says
   "attachments[] mirrors the per-session send route's shape: each entry is {upload_id}"
   and its `_stage_new_chat_attachments` reads only `upload_id` (the extra `kind` key is
   tolerated), and the workspace provisioner drains them into real stream-json image
   blocks on the first turn. This is the confirmation 00103 lacked when it scoped
   attachments to `/send` only.

**Capability-gated, not universal**: `AIBackend.supports_attachments` (mirrors the existing
`supports_handover_chains` flag) — `True` for `CmdAIBackend`, `False` for
`AnthropicAIBackend` (the standalone/milestone-6 backend has no attachment mechanism of its
own, and milestone 6 is security-gated per this repo's CLAUDE.md — deliberately not built
here). `routes_chat.py` 422s rather than silently dropping an attachment against an
unsupporting backend, for `send_message`, `create_conversation`, and both upload routes.
The frontend reads `StateResponse.chatAttachmentsSupported` once at composer mount to
decide whether to show the 📎 button at all — never lets the owner attach something that
can't be sent.

**Thumbnails in the transcript (decisions/00110)** — cmd's read side has no structured
attachment field, and production sends with attachments resolve to cmd's DRIVER methods
(wixy passes no explicit `method`; cmd's auto-resolver picks), which embed a raw
`Attachments:\n@<abspath> (WxH)` footer IN the message text. That footer used to render
verbatim as bubble prose (the 2026-08-02 operator report). Two redundant, fully
wixy-side recovery mechanisms now cover both routings:

- **Footer parse** — `chat_attachments.extract_attachment_footer` mirrors cmd's OWN
  `src/ts/render/attachment-mentions.ts` contract exactly (same footer regex, same
  cmd-uploads path-sentinel strictness, same whole-footer strip, dims from the `(WxH)`
  suffix). It runs INSIDE `CmdChatClient.get_messages` so the cmd-ism stays contained:
  `ChatMessage.text` arrives pre-stripped, `ChatMessage.attachments` carries the refs.
  Covers driver-path sends INCLUDING pre-feature history.
- **Send log** — `chat_sends.py` (`Storage/projects/<slug>/chat-sends.json`, capped at
  200): every attachment-carrying create and `/send` is recorded (text stored
  decoder-stripped). A stream-json-routed send leaves NO trace in cmd's read-back (the
  decoder drops image blocks), so `_stream_events` re-decorates matching user messages
  via `decorate_messages` — exact-text matching, duplicates paired by ordinal FROM THE
  END (stable across re-polls/reconnects/restarts), already-decorated messages never
  stomped. Decoration runs BEFORE `_owner_visible`, and the create-time record matches
  on the FULL composed prompt — so an image-only first message (preamble-only text +
  image blocks) gains attachments first and then SURVIVES the preamble strip
  (`_owner_visible` keeps it, emitted as `text: null`, thumbnails-only).

The bytes themselves come from cmd's own `GET :9320/api/uploads/{id}/bytes` (serves the
converted WEBP inline — the same endpoint cmd's chat UI previews with), proxied through
`GET /api/admin/chat/uploads/{upload_id}/bytes` (`UploadNotFoundError` → 404, mirror of
cmd's 404/410; `Cache-Control: immutable`) so the browser never sees cmd's localhost
surface. `AIBackend.fetch_upload_bytes` is the gated capability behind it.

**The one assumption settled only by live verification, not by tests**: cmd's docs state an
attachment only becomes a real vision content block when the send resolves to
`method=="stream-json"`; other routing methods downgrade to a text-footer path mention the
model may only weakly engage with (its Read tool ingests the path). Wixy's conversations
(subscription bucket, `model: "claude-sonnet-5"`, never dispatched to a visible window)
were verified live (00103) to produce exact image understanding; the footer-path nuance is
why BOTH thumbnail-recovery mechanisms above exist, and if a transcript ever stops showing
thumbnails, the thing to check is which of the two mechanisms stopped matching — not
whether the feature works at all.

## Preamble (`preamble.py` + `templates/chat_preamble.md`)

`wixy_server/preamble.py` owns the whole contract — `PREAMBLE_TEXT`, the `SEPARATOR`,
`compose_prompt` (used by **both** backends) and `strip_preamble` (used by the stream). Compose
and strip must stay exact inverses, so they live in one dependency-free module rather than
having the separator duplicated at three call sites; `test_preamble.py` pins the round trip and
asserts the template has no `---` line of its own (which is what makes the separator a safe
split token). **The preamble is never rendered to the owner** — see the Stream bullet above and
decisions/00093.

Prepended once at creation (<1.5 KB). Sets: identity (the site assistant for Cottage
Aesthetics, working in a worktree of the *site* repo); audience (the **owner**, not a
developer → plain language, restate vague asks then act); **"showing your progress"**
(decisions/00097, see below); "read the repo's `CLAUDE.md` first"; a routing map (copy/images →
`content/`+`images/`; layout/pages → `pages/`+`partials/`; look-and-feel → `theme/theme.json`);
the quality gate (`python -m builder validate` + tests before shipping); ship discipline
(branch → PR → merge; **never publish** — merging only updates the draft; tell the owner to
press Publish); and a scope fence (requests about the wixy *engine itself* are out of scope —
note them for the operator).

## Task-list protocol (`chat_tasks.py` + the preamble's "Showing your progress" section)

decisions/00097: the owner's only signal that the assistant was doing anything used to be a
small "Assistant is working…" strip driven by cmd's raw `activity` field — no sense of WHAT
it was doing or how far along. The preamble now instructs the model: on any request that
involves real work, reply with one short plain sentence of intent, then a fenced code block
whose info string is exactly `wixy-tasks` containing ONLY JSON
`{"tasks":[{"label":str,"status":"pending"|"doing"|"done"}]}` (2–7 tasks, stable labels across
re-emissions, the WHOLE block re-sent with updated statuses every time progress changes,
final reply's block has every task `"done"`). The instruction text itself contains a literal
example of the fence — deliberately safe, since `strip_preamble` removes the ENTIRE preamble
as one byte-exact prefix (decisions/00093), so an example fence embedded inside it can never
leak as if it were the model's own live block.

`wixy_server/chat_tasks.py:extract_tasks(text) -> (cleaned_text, tasks | None)` finds every
` ```wixy-tasks ` fenced block (tolerant of leading indentation and CRLF), strips all of them
from the text regardless of validity (a malformed block is still internal protocol noise), and
returns the LAST block's tasks if at least one parsed cleanly (non-empty, well-formed labels,
a valid status literal) — a multi-block message (the model narrating between two updates in
one reply) resolves to whichever block came last. Only ever run against `role == "assistant"`,
`kind == "text"` messages in `_stream_events` — a literal ` ```wixy-tasks ` fence the OWNER
happens to type (quoting the docs, say) is never touched, since extraction never runs on a
user message.

## Chat panel UI (`admin-ui/src/chatPanel.ts` + `chatComposer.ts`)

`mountChatPanel(conversation, deps)` → list view (`#/chat`, polls `getConversations` every 2s,
status dot per `ConversationSummary.status`, PLUS a `wx-chat-dot-working` pulse + a muted "—
working…" title note when `ConversationSummary.working` is true — decisions/00097, so the
owner can tell a conversation is busy without opening it) or detail view (`#/chat/<conv>`).
Detail opens a browser `EventSource` on the stream route (`api.ts:openConversationStream`);
`message` events render markdown bubbles (`markdown.ts`, `createElement`/`textContent` only —
never `innerHTML`), collapse contiguous tool runs into a "⚙ n actions" group, and filter
`thinking` unless the reasoning toggle is on (which reconnects the stream with
`?includeThinking=true`). An `error` event shows the offline banner (the server already
auto-retries). Non-user messages trigger a throttled upstream check that toggles the "Preview
updated — review changes" chip. Send generates the idempotency key once per attempt (reused on
a failed retry). **Handover is fully server-side** — the UI just surfaces `handoverState`.

**The layout (decisions/00110)** — the conversation view is a full-height flex column inside
`.wx-main`: header (which also carries the reasoning toggle) and the dynamic banners/task
card are `flex:none`, ONLY the thread scrolls (`flex:1; min-height:0`), and the composer is
the pinned last child — no `60vh` thread cap, no `.wx-main` scrolling, no
double-scroll, and `env(safe-area-inset-bottom)` keeps the composer clear of the phone's
system bar. The thread STICKS to the bottom only while the owner is at the bottom (48px
hysteresis) — scrolled up reading history + new arrivals = a "↓ New messages" jump pill;
late-loading attachment images re-stick on their `load` event.

**The shared composer (`chatComposer.ts`)** backs BOTH the list view's "New conversation"
box and the open conversation's composer (a `mode` switch keeps every legacy class hook the
tests/e2e select): auto-growing textarea (native `field-sizing: content` with a 44–180px
scrollHeight fallback; 16px on ≤720px so focusing never read-zooms), 📎/paste/drag-drop
image staging with spinner chips, submit gated on no-upload-in-flight, Enter/Shift+Enter,
and `allowEmptySubmit` for the list view's "start with nothing" case. The list view stages
uploads session-lessly (`api.stageChatUpload`) and passes the ids to `createConversation`.

**The optimistic echo (decisions/00110)** — a send paints instantly as a dimmed
`wx-chat-echo` bubble ("sending…", thumbnails from the same bytes-proxy URLs the server
copy will use), reconciled FIFO by exact text as server copies stream in, removed on send
failure (composer keeps text + chips for the same-idempotency-key retry), expired after 30s
unmatched so nothing duplicates forever.

**Transcript attachments (decisions/00110)** — a message event's `attachments` (see the
Attachments section above for how the server recovers them) renders as a 120px thumbnail
grid inside the bubble, sourced from wixy's bytes-proxy route; tapping one opens a lightbox
(backdrop/✕/Esc close, focus restored). The raw `Attachments: @C:\...` footer text never
reaches the screen (stripped server-side).

**The work banner + task card** (decisions/00097) replace the old small status-strip text.
`isWorking()` is true on any of three independent signals, each covering a gap the others
miss: cmd's own `activity` field being exactly `"active"` (`activityState`), a local
`awaitingReply` flag (set the instant `send()` succeeds, cleared the moment any non-user
message arrives — covers the gap right after Send, before cmd's own activity or a task block
shows anything), or the latest `tasks` event having anything not yet `done`. While working:
`.wx-chat-work-banner-working`, a spinner, "Working on your tasks…" (once a task block has
ever arrived) or "Thinking…" (before one has). Once NOT working and the latest tasks are all
`done`: `.wx-chat-work-banner-done`, a checkmark, "All tasks completed — review the changes in
Edit, then press Publish." — this state (and the stale task card) is explicitly cleared the
moment the owner sends a NEW message (a fresh round of work invalidates the old, fully-done
list). The task card (`.wx-chat-tasks`, sits directly above the internally-scrolling thread so
it stays visible without needing its own sticky positioning) renders "Tasks · N of M done" plus
one row per task — a spinner icon for `doing`, `✓` for `done` (label struck through, muted),
a hollow circle for `pending`.

**`activityState`'s `activity` check** reads cmd's own ENUM string — `"active" | "idle" |
"done" | "unknown"` (`engine/chats/session_introspect.py:_activity`, a session-store
mtime-age threshold: `<=8s` active, `<=600s` idle, else done), NOT a timestamp. Two
corrections shipped here, in sequence. Decisions/00099 fixed an earlier version of this
function that wrongly parsed `activity` as a `Date` and compared elapsed time against a
freshness window — always evaluated false against real cmd, since none of the real enum
strings parse as a date. Decisions/00100 then fixed 00099 itself: that fix compared
`activity` against the literal `"working"`, a guess taken from spec prose ("working / idle
/ dead") and a single live sample that happened to read `"idle"`, never confirmed against a
genuinely active moment — cmd's `activity` field never actually sends `"working"`; that
literal belongs to the separate `process.liveness` field this check deliberately doesn't
read. Only a second round of live verification — polling cmd's real `/status` endpoint
directly and time-correlating it against wixy's own response across a real ~30s active
window — caught the second bug.

## Config & test doubles

`create_app(..., cmdchat_client=None, chat_stream_timing=None)` defaults `cmdchat_client` to a
real `CmdChatClient()`; the E2E fixture (`e2e/fixture_server.py`) points both base URLs at one
fake-cmd port. `wixy_server/tests/fake_cmd.py` implements both surfaces as one FastAPI double
(`create_fake_cmd_app` via ASGITransport for HTTP; `FakeCmdServer` real ephemeral-port uvicorn
for the websocket), making the chat suite hermetic. One `@pytest.mark.live_cmd` smoke test
does a real "reply with the word pong" round-trip against local cmd (excluded from CI by the
default `addopts`).
