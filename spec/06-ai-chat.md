# 06 — AI chat facility (cmd-powered)

The admin's Chat panel is a **real cmd chat** per conversation — same agents, same
subscription bucket, same transcripts (each conversation is simultaneously visible in the
cmd cockpit). Wixy adds only: creation with a site-scoped preamble, a clean embedded UI,
and the draft/publish integration. **Never** call the Anthropic API directly (fleet rule);
all inference is cmd-spawned chats.

All cmd endpoints below are **localhost HTTP, unauthenticated** (cmd binds 127.0.0.1; Wixy
runs on the same hub VM). Ports: cmd portal **9320**, Cmd-Chats introspection **9321**.
These calls MUST go through one `wixy_server/cmdchat.py` client module (timeouts 10 s,
retries ×2 on connect errors, structured errors surfaced to the UI — never a silent hang).

## 1. Conversation lifecycle

### Create (user clicks "New conversation", optionally with a first message)

```
POST http://127.0.0.1:9320/api/project/cottage-aesthetics-preview/new-chat
{"prompt": "<PREAMBLE>\n\n---\n\n<user's first message>"}
```

- The project name is the **site repo clone's directory name** under cmd's
  `Storage/clones/` — cmd derives projects from cwd paths and auto-clones by name; the
  `cottage-aesthetics-preview` clone already exists, so no registration step is needed.
  The project name comes from the wixy project registry (`cmdProject` field, 01 §5), never
  hardcoded.
- Response is **202** `{"session_id", "pending_state": "queued", "workspace_id", …}` — the
  workspace (a fresh git worktree of the site repo) is provisioned in the background:
  `queued → workspace_creating → spawning_cli → ready`. Wixy stores
  `{conv_id, session_id, title, created_at}` in `Storage/projects/<slug>/chats.json` and
  shows the conversation immediately in "starting…" state.
- Readiness: poll `GET http://127.0.0.1:9320/api/session/<session_id>` every 2 s (max
  120 s) until the pending state clears; `workspace_failed` / `cli_failed` are terminal —
  surface the reason in the panel with a Retry (= create a fresh conversation).
- Do NOT pass `model`/`effort` — omit for the cmd account defaults, so conversations
  behave exactly like a hand-started cmd chat. Do not pass `workspace_anchor`/
  `workspace_id`: every conversation gets its own worktree (cmd's native model; parallel
  conversations can't trample each other's checkouts).

### The preamble (first message prefix, maintained as `server/templates/chat_preamble.md`)

Concise (< 1.5 KB), prepended once at creation, covering:

- You are the site assistant for **Cottage Aesthetics** (ca.cinnamons.uk), working in a
  worktree of the site repo. The person chatting is the **site owner** using the Wixy
  admin panel — not a developer. Explain in plain, brief language; no jargon; confirm
  understanding of vague asks by restating, then do the work.
- Read the repo `CLAUDE.md` first — it binds you to the content contract (03 §6).
- Content/copy/image changes → edit `content/*.json` / `images/`; layout/structure/new
  sections/new pages → edit `pages/` + `partials/`; look/feel → `theme/theme.json`.
  Run `python -m builder validate` + tests before shipping.
- Ship via branch → PR → merge to main (fleet auto-merge rules). **Never publish/deploy**;
  merging updates the owner's draft preview only — tell them to review in the Edit tab and
  press Publish when happy. End your final reply with a one-line summary of what changed
  and where to look.
- Requests about the Wixy admin/editor itself are out of scope for this chat — note them
  for the operator instead of editing the wixy engine.

### Send (subsequent user messages)

```
POST http://127.0.0.1:9320/api/session/<session_id>/send
{"text": "<message>", "idempotency_key": "<conv_id>:<client-msg-uuid>"}
```

This is the exact route the cmd web UI uses (202-accepted; the reply lands in the
transcript asynchronously). Include the idempotency key so a UI retry can't double-send.
A send while the agent is mid-turn is fine (cmd serializes on the per-session registry).
On 5xx: surface "couldn't deliver — retry" on the message bubble (the composer keeps the
text); do not blind-retry non-connect errors.

### Read (transcript + live updates)

Initial load + pagination:

```
GET http://127.0.0.1:9321/sessions/<session_id>/messages?limit=80&include_tools=true
GET …?before=<index>            # older history
GET http://127.0.0.1:9321/sessions/<session_id>/status
```

`/messages` returns **decoded conversation-level messages**
`{index, role, kind: text|tool_use|tool_result|thinking|error, text, timestamp,
tool_name, truncated}` — exactly the shape a chat UI wants; no raw-JSONL parsing in Wixy.

Live updates: while a conversation panel is open, the Wixy **server** polls `/messages`
(new-since-index) + `/status` every **1.2 s** and fans out to the browser over
**SSE** `GET /api/admin/chat/conversations/<conv>/stream` (server-sent `message`,
`status`, `error` events). The browser never talks to 9320/9321 (they're loopback-only;
the admin origin is ca.cinnamons.uk). Poll only while ≥1 SSE subscriber is connected;
idle conversations cost nothing. (cmd also has a richer per-session WebSocket on 9320;
deliberately not used in v1 — the decoded-poll contract is documented-stable,
provider-agnostic, and 1.2 s is imperceptible for chat turnarounds. Revisit only if a
real UX gap shows.)

UI mapping (05 §6): `text` → markdown bubbles; contiguous `tool_use`/`tool_result` runs →
one collapsed "⚙ n actions" row (expandable, monospace); `thinking` hidden behind a
"show reasoning" toggle default-off; `error` → red system row. Status dot from `/status`
(`activity`/process liveness): working / idle / dead.

### Titles, list, resume

`chats.json` conversations get their title from the first user message (≤ 60 chars,
word-truncated; editable via rename in the list). The panel list shows status + last
message time (from the poll cache). Conversations persist indefinitely; "resume" is just
opening the panel again — the cmd session keeps its full context. If a conversation's
session has **handed over** (long chats do), the send response / status exposes the
successor chain tip: Wixy MUST follow `resolved_session_id` when present, update
`chats.json`, and keep the conversation seamless (this is cmd's documented lineage
behavior on both 9320 sends and 9321 introspection).

## 2. Draft/publish integration (closing the loop)

The agent ships to the site repo `main`; the owner's draft preview renders
`origin/main ⊕ overlay` (02 §8), so merged work appears on the next preview load:

- Wixy's existing upstream watcher (04 §7: `git fetch` on the site checkout every 60 s +
  before every preview/publish) notices new main commits. The admin surfaces them in the
  draft-status chip and in the chat panel as a "Preview updated — review changes" chip
  (05 §6) once the fetch after an agent's turn shows new commits.
- Publish-time: upstream commit subjects appear in the publish review drawer, so
  AI-shipped changes are always reviewed by a human eye before going live.
- No auto-publish, ever, including "and publish it please" in chat: the agent must reply
  that publishing is the owner's button. (Rationale: one human gate between AI edits and
  the public site; it's one click, decision-logged.)

## 3. Failure modes (must be handled, not hoped away)

| Failure | Behavior |
|---|---|
| cmd down (connect refused on 9320/9321) | Chat panel shows a single offline banner ("assistant offline — cmd isn't running") + auto-retry every 10 s; the rest of the admin is unaffected. |
| new-chat 202 but provisioning fails (`workspace_failed`/`cli_failed`) | Conversation row shows the failure reason + Retry (new create). Log full response server-side. |
| Send 502 / non-delivery | Bubble-level error + manual retry with the same idempotency key. |
| Session handed over | Transparent: follow `resolved_session_id` (see above). |
| Agent merged a broken change (can't happen via PR checks, but belt-and-braces) | Publish's `builder validate` + build gate fails → publish aborts, draft intact, error shown; fix via chat or revert PR. |
| Transcript store temporarily missing (brand-new session) | Treat as "starting…" until first messages appear (bounded by the 120 s readiness timeout). |

## 4. Testing hooks

`cmdchat.py` is written against an interface so tests run against a **fake cmd server**
(FastAPI test app implementing new-chat/send/messages/status with canned scripts —
including the handover-resolution and mid-provisioning states). One optional
`@pytest.mark.live_cmd` smoke test (skipped in CI, run during 07 verification) creates a
real conversation against local cmd, sends "reply with the word pong", and asserts a
transcript reply arrives — the end-to-end proof on the hub box.
