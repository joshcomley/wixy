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
- Slice 2 [DONE]: `wixy_server/chats.py` (new) — durable `chats.json` identity
  store (conv_id/session_id/title/created_at, spec/04 §2), atomic tmp+rename
  writes via a new shared `builder.content.atomic_write_json` helper (factored
  out of `overlay.save_overlay`, which now uses it too — behavior-preserving).
  `ChatRuntimeEntry` (pending/ready/failed) lives in-memory on `app.state`, NOT
  persisted — deliberate, see decisions/00032 decision 1 for the full tradeoff
  reasoning (self-heals on next real interaction; not worth eager re-verification
  at every startup). `wixy_server/routes_chat.py` (new): `POST`/`GET
  /api/admin/chat/conversations` — create spawns a background readiness-tracking
  task into the app's own long-lived task group (extends the existing watcher's
  pattern, `app.state.background_tasks`, decisions/00032 decision 2); title
  derivation (60-char word-truncate) + prompt construction (preamble alone, or
  preamble + `\n\n---\n\n` + first message) per spec/06 §1's exact template.
  `create_app` gained an injectable `cmdchat_client` param (mirrors
  `watcher_interval_s`'s existing convention) — flagged for slice 5's E2E fixture.
  `_build_state`'s `chats` field now wired to real conversation summaries
  (was a hardcoded `[]`). 24 new tests (`test_chats.py`, `test_routes_chat.py`)
  incl. a real bug found in the FIRST draft of one of THIS slice's own tests
  (a vacuous assertion that didn't actually prove what its name claimed — see
  decisions/00032's closing note). Full reasoning: decisions/00032.
- Slice 3 [DONE]: `send_message`/`rename_conversation`/`conversation_stream` in
  `routes_chat.py`. The stream (`_stream_events`) fetches the latest 80 messages
  every tick and diffs by CONTENT not just index (a `truncated:true` preview
  later updated in place at the same index must still be re-sent — decisions/
  00033 decision 1), fans out `{type: "message"|"status"|"error", ...}` plain
  `data:` SSE events (matching `publish_stream`'s existing convention, not
  named SSE event types — avoids the `EventSource` "error" name collision).
  Handover-follow: explicit `handover_state` check only (spec's secondary
  "transcript stall" fallback deliberately not built — no evidence it's
  needed yet, decisions/00033 decision 5). A `StreamTiming` bundle (poll
  interval/offline-retry/transcript-lag-grace, injectable via `create_app`)
  absorbs Cmd-Chats' transcript store occasionally lagging just behind cmd's
  own readiness signal for a new session (spec/06 §3's own flagged case).
  `chats.py` gained `find_chat`/`update_session_id`. Added the
  `@pytest.mark.live_cmd` smoke test (spec/06 §4) — written, NOT yet run
  against real cmd; deliberately deferred to milestone 13 per spec's own
  "run during 07 verification" scoping (a real throwaway workspace + chat
  otherwise). **Real, load-bearing finding**: `TestClient.stream()` cannot
  observe an infinite SSE generator at all — hangs forever with zero output,
  confirmed via an isolated probe script — so the stream tests drive
  `_stream_events` directly as a plain async generator instead (faster, and
  the only thing that actually works; flagged for slice 5's E2E work, which
  won't hit this since a real browser's EventSource is unaffected). Full
  reasoning: decisions/00033.
- Slice 4 [DONE]: chat panel UI. `admin-ui/src/markdown.ts` (new) — hand-rolled
  markdown-to-DOM renderer (no innerHTML ever, no new npm dependency — admin-ui
  had zero runtime deps before this and still does; decisions/00034 decision 1).
  `admin-ui/src/chatPanel.ts` (new) — `#/chat` list (status dot from provisioning
  state only, not live working/idle — decisions/00034 decision 2) + `#/chat/<conv>`
  detail view (markdown bubbles, collapsed "⚙ n actions" tool-run rows, live
  status strip, offline banner, preview-updated chip linking to `#/pages` —
  decisions/00034 decision 4, show-reasoning toggle). `api.ts` gained the chat
  types/methods + `openConversationStream`. `shell.ts` wires it in for real,
  `mountChatPanel` now injectable via `ShellDeps` (mirrors `mountEditView` —
  jsdom can't do real `EventSource` either, decisions/00034 decision 5);
  `comingSoon` removed (dead — every route kind now handled). One small backend
  addition: `includeThinking` query param threaded through `_stream_events`
  (decisions/00034 decision 3 — no dedicated endpoint exists, so the toggle
  reconnects the same stream). 44 new frontend tests + 1 backend test. **Also
  driven through a real headed browser** (temp site repo + real FakeCmdServer,
  full create→ready→scripted-reply-with-tool-row→send→offline-banner flow, all
  verified incl. screenshots) — found and fixed a bug in the VERIFICATION
  SCRIPT itself (forgot to mark the fake session ready), and traced 2 console
  503s to a pre-existing, already-understood, unrelated-to-chat cause (the
  browser's implicit favicon request hitting routes_public.py's spec'd
  "not yet published" 503 — e2e/fixture_server.py already documents publishing
  an initial build specifically to avoid this). Full reasoning: decisions/00034.
- Slice 5 [DONE]: E2E 7 (`e2e/tests/chat-ux.spec.ts`, new). `fixture_server.py`
  now starts a real `FakeCmdServer` (the SAME double the Python unit suite
  uses, not a second hand-rolled TS fake) and injects it via `create_app
  (cmdchat_client=...)`; `FakeCmdState` gained `default_ready_after_polls` so
  E2E-created conversations become ready near-instantly with zero
  per-conversation wiring. Three new fixture-only `/test/chat/*` endpoints
  (set-messages, set-send-status, stop-fake-cmd) mirror E2E 6's own
  `/test/simulate-upstream-commit` pattern. The spec covers every E2E 7 leg:
  new conversation, status dot pending->ready (asserted via the create
  RESPONSE body for "pending" + a separate later list-view wait for "ready" —
  NOT by racing a UI round-trip against the fixture's own fast readiness,
  which the first draft tried and found genuinely flaky, decisions/00035
  decision 3), a scripted reply with a collapsed/expandable tool-action row,
  send-retry on an injected 502 with an EXACT idempotency-key-reuse assertion
  (the same key on both the failed and retried send — this is the assertion
  that would have caught slice 4's idempotency-key bug had it existed first,
  decisions/00035 decision 4), and the offline banner on fake-cmd stop. Full
  local run: all 9 E2E specs green (E2E 1-8 + this new E2E 7), confirming the
  shared `workers:1` fixture server's one-way fake-cmd-stop doesn't disturb
  any other flow regardless of run order. Full reasoning: decisions/00035.

**MILESTONE 10 IS CLOSED.** All 5 slices merged (PRs #40-44).

Never call the Anthropic API directly — all inference via cmd's new-chat/send/messages
endpoints per spec 06 (enforced in `cmdchat.py`: it only ever talks to localhost
9320/9321, never api.anthropic.com).

## Relevant files
- spec/06-ai-chat.md (full — exact endpoints, lifecycle, preamble, failure table)
- spec/08-testing-acceptance.md §1 (fake cmd server test list), §2 E2E 7, §4 (@live_cmd
  smoke, run during M13 verification not CI)

## How to continue + acceptance
Every acceptance point spec/09's own M10 line named is DONE: cmdchat.py client +
fake-cmd double (slice 1), conversations store + create/pending/ready (slice 2),
send w/ idempotency + poll->SSE fan-out (slice 3), chat panel UI incl. markdown/
tool rows/status dot/preview-updated chip/offline banner (slice 4), handover-follow
(slice 3), E2E 7 (slice 5), preamble template (slice 1). The only intentionally
deferred item is the `@pytest.mark.live_cmd` smoke test's actual EXECUTION against
real cmd — written (slice 3), correctly scoped to milestone 13's live verification
per spec's own wording, not run here (decisions/00033) — don't run it speculatively
before then.

**Milestone 10 is fully closed.** Next: milestone 11 (Install & deploy) per spec/09's
own table — read spec/07-hosting-deploy.md in full before starting (not yet read
fresh by this chain, same discipline milestone 10 itself started with).

## Links
PR (slice 1): https://github.com/joshcomley/wixy/pull/40 (merged 19a6839)
PR (slice 2): https://github.com/joshcomley/wixy/pull/41 (merged 62d8633)
PR (slice 3): https://github.com/joshcomley/wixy/pull/42 (merged fa3dd0a)
PR (slice 4): https://github.com/joshcomley/wixy/pull/43 (merged 48bda80, incl. a
follow-up idempotency-key-reuse fix commit before merge)
PR (slice 5): https://github.com/joshcomley/wixy/pull/44 (merged 156fc66)
