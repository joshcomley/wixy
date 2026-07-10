# Milestone 10 slice 2: conversations store + create/pending/ready flow

Builds on slice 1's `cmdchat.py` (decisions/00031). This slice adds the durable
conversation identity store, the create/list HTTP surface, and wires the
`chats` field in `GET /api/admin/state` (previously a hardcoded `[]`
placeholder). Send, the SSE message/status stream, rename, and handover-follow
remain slice 3.

## Decision 1: `chats.json` stores identity only; provisioning status lives
in-memory on `app.state`

spec/06 §1 is explicit about what's persisted: "Wixy stores `{conv_id,
session_id, title, created_at}` in chats.json." Live/pending status
(`ChatRuntimeEntry` in `wixy_server/chats.py`) is deliberately NOT part of that
file — it mirrors `wixy_server.publisher.PublishJob`'s existing precedent
(transient, process-lifetime state living on `app.state`, never serialized).
A conversation with no entry in the runtime dict is treated as `"ready"` (the
default in `conversation_summary`).

**The tradeoff this accepts, considered deliberately**: if wixy_server
restarts DURING a conversation's provisioning window (queued through ready,
realistically low-seconds-to-tens-of-seconds per spec/06 §1's own 120s upper
bound), that conversation's runtime entry is lost and it will show as "ready"
in the list/state snapshot even though cmd might still be spinning it up. No
startup-time re-verification sweep was built for this. Why this is the right
call, not a shortcut: (a) the actual window where this can happen is tiny
relative to how rarely wixy_server restarts (deploys, crashes) — this is a
rare-edge-case-times-rare-edge-case; (b) the consequence is mild and
self-healing: the very next real interaction with that specific conversation
(slice 3's stream-open or send route) necessarily talks to cmd for real and
will discover the true state then, not persist a wrong belief indefinitely;
(c) eagerly re-polling EVERY stored conversation at every startup (the
alternative) is real, ongoing complexity and I/O for a benefit that only ever
pays off in this rare window — this is not "skip the correct thing to save
time," it's "the correct amount of engineering effort for the actual risk,"
matching this codebase's general avoidance of speculative machinery (e.g. the
project registry's own "v1 runs with exactly one but nothing may assume that"
posture — build for what's real, not for a hypothetical). If the real
distribution of restarts-mid-provisioning ever turns out to be non-negligible
in production (measured, not guessed), this is the first thing to revisit —
noted here so a future session doesn't have to rediscover the reasoning from
scratch.

## Decision 2: the readiness tracker runs in the app's own long-lived task
group, not FastAPI's `BackgroundTasks`

`wait_until_ready` can legitimately run up to 120s. FastAPI's built-in
`BackgroundTasks` dependency ties execution to the responding request/response
cycle in ways not intended for genuinely independent, app-lifetime-scoped work
of that duration. Instead, `app.py`'s existing lifespan task group (already
running the upstream watcher, unchanged since M6) is exposed on
`app.state.background_tasks`, and `routes_chat.create_conversation` spawns its
tracking task into that SAME group via `start_soon` — same lifecycle as the
watcher, cancelled together at app shutdown. This is a natural extension of an
existing pattern, not a new one.

## Decision 3: a fresh `CmdChatClient` per app, owned and closed by the
lifespan; injectable for tests/E2E

`create_app` gained `cmdchat_client: CmdChatClient | None = None`, defaulting
to a real client (localhost cmd) — mirrors `watcher_interval_s`/
`preview_staleness_threshold_s`'s existing "tests/fixtures override, production
never guesses" convention. Closed in the lifespan's `finally` (after the task
group's own `async with` block exits, so any still-running tracking tasks are
cancelled first, then the underlying `httpx.AsyncClient` is cleaned up).
Flagged for milestone 10 slice 5: the E2E fixture server will need to
construct one pointed at a fake/test cmd and pass it through the same
parameter.

## Decision 4: title derivation and prompt construction

- No first message: title = `"New conversation"`. spec/06 §1 says titles come
  "from the first user message" but explicitly allows creation "optionally
  with a first message" — the spec doesn't name a title for the no-message
  case, so a plain, honest placeholder was chosen (renamable later, once
  slice 3's rename route exists).
- Word-truncation at 60 chars: truncates on the last whitespace boundary
  at-or-before the limit (never mid-word), appending `"…"` — matches how
  "truncate for display" is handled elsewhere in spirit (word-boundary, not a
  hard character cut), even though this is the first place in the codebase
  that needed it for free text rather than a filename/slug.
- Prompt sent to cmd: `f"{PREAMBLE}\n\n---\n\n{first_message}"` when a first
  message exists, the preamble ALONE (no trailing separator) otherwise —
  spec/06 §1's own literal template.

## Decision 5: list ordering is newest-first

spec doesn't explicitly state the list's sort order (unlike `GET publishes`,
which explicitly says "newest first"). Chose newest-first for the same reason
the history panel does — the most recently created conversation is normally
the one the owner just opened Wixy to look at.

## A real design flaw caught by testing this slice's own test

The first draft of `TestCreateConversation::test_uses_cmd_project_from_registry
_not_hardcoded` only asserted the create call didn't error — which proves
NOTHING about whether the correct `cmdProject` registry field was actually
used, since the fake app's `new-chat` route accepts any project slug in its
path. Fixed by giving `FakeSession` a `cmd_project` field (populated from the
fake route's own path parameter) and asserting on it directly — a concrete
example of the general trap of "the test passed" not implying "the test
verified the right thing," worth remembering for slice 3+'s own tests.

## Files changed

- `wixy_server/chats.py` (new) — the store + `ChatRuntimeEntry` + `conversation_summary`.
- `wixy_server/routes_chat.py` (new) — create + list routes, title/prompt helpers.
- `wixy_server/app.py` — `cmdchat_client` param, `chat_runtime`/`background_tasks`
  on `app.state`, chat router registration, client lifecycle.
- `wixy_server/routes_admin_api.py` — `_build_state`'s `chats` field wired to
  `chats_snapshot` instead of a hardcoded `[]`.
- `builder/content.py` — `atomic_write_json` (new, factored out of `wixy_server.
  overlay.save_overlay` so `chats.py` didn't need a third copy of the same
  tmp+rename dance).
- `wixy_server/overlay.py` — `save_overlay` refactored onto the shared helper
  (behavior-preserving; full existing overlay test suite still green).
- `wixy_server/tests/fake_cmd.py` — `FakeSession.cmd_project` (new field).
- `wixy_server/tests/test_chats.py` (new, 11 tests), `wixy_server/tests/
  test_routes_chat.py` (new, 13 tests).

**Verification**: mypy strict clean (91 source files), ruff check + format
clean, full suite green (515 passed, up from 491 at slice 1's close — 24 new).
