# Milestone 10 slice 3: send, stream, rename, handover-follow

Completes the conversation-lifecycle surface spec/06 §1 describes: sending
subsequent messages, the server-polls/browser-streams live-update mechanism,
renaming, and following a cmd session through a handover. Builds on slice 1
(`cmdchat.py`, decisions/00031) and slice 2 (the conversations store + create/
list, decisions/00032).

## Decision 1: message diffing is by CONTENT, not just by index

spec/06 §1 says the server "polls /messages (new-since-index)," but cmd's own
`/messages` endpoint has no `since=`/`after=` filter — only `limit` and
`before=<index>` (older-history pagination). So `_stream_events` fetches the
latest `limit=80` messages every tick and diffs them itself: it keeps
`sent_messages: dict[int, ChatMessage]` and re-sends an index whenever its
CONTENT differs from what was last sent for that index, not just when the
index is newly seen. This matters concretely: a message can arrive as
`{truncated: true}` (a streaming preview) and later be updated in place with
the same index and `{truncated: false}` (the full text) — a bare "index >
last-seen-index" filter would permanently miss that update once the index had
already been seen once. Verified by a real test
(`test_resends_a_message_whose_content_later_changes`) that seeds a truncated
message, lets one tick observe it, then mutates it in place and confirms the
NEXT tick re-sends it.

## Decision 2: the SSE event envelope is `{type, ...}`, not named SSE event
types

spec/06 §1 says "server-sent message, status, error events," which could read
as literal named SSE event types (`event: message\ndata: ...`). Implemented
instead as the plain default `data: {...}` event carrying a `type` field
discriminator (`"message" | "status" | "error"`), matching the ALREADY
established convention in this codebase's one other SSE endpoint
(`routes_admin_api.publish_stream`, which also carries multiple conceptual
kinds of information through plain `data:` events with no named types). Two
reasons beyond "match existing precedent": (1) `EventSource`'s special-cased
`error` NAME collides with the browser's own connection-level `onerror`
callback — a genuinely confusing footgun to avoid; (2) spec gives no exact
wire shape for these events, unlike the concrete provisioning-state strings
elsewhere in the same document, so this is implementation latitude, not a
deviation from a hard requirement.

## Decision 3: `_wait_until_conversation_ready` re-uses slice 2's own tracker
instead of polling cmd a second time

When a conversation panel opens on a still-pending conversation, the stream
does NOT independently poll `GET /api/session/<id>` — it just watches the
SAME in-memory `ChatRuntimeEntry` slice 2's `_track_readiness` background task
is already updating. Two readiness pollers hitting cmd for the same
conversation would be redundant load for no benefit; the tracker's result is
already the single source of truth `GET .../conversations` reads too.

## Decision 4: a bounded "transcript-lag grace period" absorbs 9321 catching
up just behind 9320

spec/06 §3's own failure table: "Transcript store temporarily missing
(brand-new session) — Treat as 'starting…' until first messages appear
(bounded by the 120s readiness timeout)." Cmd's session registry (9320,
what `wait_until_ready` confirms) and Cmd-Chats' transcript store (9321, what
`get_status`/`get_messages` read) are separate services — a session confirmed
ready on 9320 can still 404/error on 9321 for a brief window right after.
`StreamTiming.transcript_grace_s` (default 15s, well inside spec's 120s
bound) makes a `CmdChatError` from `get_status`/`get_messages` retry quietly
at the normal poll cadence during that window, escalating to the "cmd is
down" treatment (an `error` event + the slower 10s offline-retry cadence)
only once the grace period has elapsed. All three timing constants
(`poll_interval_s`/`offline_retry_s`/`transcript_grace_s`) are bundled into
one `StreamTiming` dataclass, injectable via `create_app` (mirrors
`watcher_interval_s`'s established convention) — production defaults match
spec's own numbers (1.2s / 10s / 15s) exactly; tests shrink all three by
several orders of magnitude.

## Decision 5: handover-follow is the explicit `handover_state` signal only,
not the "transcript stall" fallback heuristic

spec/06 §1: "Detect + follow: watch `GET 9321 /status` for `handover_state`
(also suspect a handover when the transcript stalls after an accepted send)."
Implemented only the first (explicit, reliable) signal: every poll tick
checks `status.handover_state`, and if set, calls `GET .../chain`, adopts the
LAST element as the new session id (if different from the current one),
persists it to `chats.json` via a new `chats.update_session_id`, resets the
per-stream `sent_messages`/`last_status` tracking (a fresh transcript under
the new session id), and continues polling seamlessly. The SECOND signal
("transcript stalls after an accepted send" — a fuzzy, timing-based fallback
for when `handover_state` itself might not be reliably set) was deliberately
NOT built: it's explicitly framed by spec as a fallback for a scenario the
primary signal already reliably covers, and adding a timing heuristic on
uncertain benefit is exactly the kind of speculative complexity this project
avoids building without real evidence. If M13's live verification ever shows
`handover_state` missing/unreliable in practice, that's the moment to build
the fallback — backed by an observed failure, not a guess.

## Decision 6: `chats.rename_chat` and the new `update_session_id` share one
`_update_conversation` helper

Both are a single-field read-modify-write over the same stored-conversation
list; factored into one internal helper (`title` XOR `session_id` overridden,
everything else preserved) rather than two near-identical ~15-line blocks.

## Decision 7 (a real, load-bearing testing-infrastructure finding): FastAPI's
synchronous `TestClient` cannot observe an infinite SSE stream at all

The first implementation of every stream test used `TestClient.stream(...)`
(the pattern the ALREADY-existing `publish_stream` tests use) with a
generous read timeout, assuming a slow-but-eventually-successful incremental
read. Running the suite for real caused a genuine multi-minute hang with ZERO
output — not even the response's status code was ever printed. An isolated
probe (`sse_probe.py`, a bare FastAPI app with a trivial `while True: yield;
sleep(0.05)` endpoint, run as a standalone script) proved this conclusively:
entering `with client.stream(...) as response:` never returns AT ALL for an
endpoint whose generator doesn't terminate on its own, regardless of any
client-side `timeout=` value — `TestClient`'s portal-thread transport
appears to fully drain the async generator into a buffer before handing
ANYTHING back to the synchronous httpx side, so an infinite generator hangs
the test process, full stop. (`publish_stream`'s existing tests never hit
this because that generator's own no-active-job case terminates after
exactly one event — they were never actually testing a non-terminating
stream.)

**The fix, and the more general lesson for slices 4-5**: `_stream_events` is
a plain, HTTP-agnostic async generator function (`client, chats_path,
runtime, conv_id, session_id, timing -> AsyncGenerator[str, None]`) — nothing
about its own logic needs FastAPI/Starlette/ASGI machinery. `test_routes_chat
.py`'s `TestConversationStream` now drives it DIRECTLY (`anext()` /
`async for` inside `@pytest.mark.asyncio` tests, bounded by `anyio.fail_after`
and always closed via `gen.aclose()`) instead of going through
`TestClient.stream(...)` — faster, deterministic, and actually able to
express "read exactly N events then stop" for a generator that otherwise
never ends on its own. `_stream_events`'s return type was tightened from
`AsyncIterator[str]` to the more accurate `AsyncGenerator[str, None]`
specifically so `.aclose()` type-checks at the call site. The ONE thing still
worth testing over real HTTP is the thin route wrapper's own 404 lookup
(`test_unknown_conversation_404s`), which returns before any streaming
begins — genuinely fine for `TestClient`. **Any future slice 5 E2E work
touching this same stream must NOT assume `page.request`/synchronous fetch
patterns work here either** — a real browser's `EventSource`/`fetch` reading
an actual live HTTP response over a real socket is unaffected by this
(the limitation is specific to `TestClient`'s synchronous-wrapper-over-async
portal implementation, not to infinite streams in general) — flagged here so
whoever builds E2E 7 doesn't have to rediscover it.

## Decision 8: the `@pytest.mark.live_cmd` smoke test is written now, deferred
to run later

spec/06 §4's smoke test ("creates a real conversation against local cmd,
sends 'reply with the word pong', and asserts a transcript reply arrives")
needs send+messages+status, which this slice completes — so it's written
here (`test_cmdchat.py::test_live_cmd_round_trip`). It reads the cmd project
slug from THIS checkout's own `projects/*.json` registry rather than
hardcoding one (decisions/00013's "don't hardcode a slug" precedent).
Registered as `pytest.mark.live_cmd`; `pyproject.toml`'s `addopts` now
includes `-m "not live_cmd"` so it's excluded from the default suite (and
therefore CI) without needing a CI workflow change — confirmed via
`--collect-only` ("18/19 tests collected (1 deselected)"). Deliberately NOT
run against the real local cmd instance THIS session runs inside, even
though that's technically possible right now: spec explicitly scopes it to
"run during 07 verification" (milestone 13), the test spawns a real
throwaway workspace + subscription-bucket chat (a genuine side effect, not
free), and jumping the gun here would mean picking a cmd project to target
without the fuller context M13's own live-verification pass will have. Left
for that milestone's session to actually run.

## Files changed

- `wixy_server/routes_chat.py` — `send_message`, `rename_conversation`,
  `conversation_stream` + `_stream_events` (the core poll->diff->fan-out
  loop), `StreamTiming`.
- `wixy_server/chats.py` — `find_chat`, `update_session_id`, the shared
  `_update_conversation` helper `rename_chat` now also uses.
- `wixy_server/app.py` — `chat_stream_timing` param + `app.state` wiring.
- `wixy_server/tests/fake_cmd.py` — no changes needed this slice (slice 1's
  `/send`/`/messages`/`/status`/`/chain` routes already covered everything).
- `wixy_server/tests/test_chats.py` — 5 new tests (`find_chat`,
  `update_session_id`).
- `wixy_server/tests/test_routes_chat.py` — 14 new tests (send, rename,
  stream — the stream ones rewritten mid-slice per decision 7 above).
- `wixy_server/tests/test_cmdchat.py` — the `live_cmd` smoke test.
- `pyproject.toml` — `-m "not live_cmd"` in `addopts`, the `live_cmd` marker
  registered.
- `C:\...\scratchpad\sse_probe.py` — the isolated diagnostic probe that
  proved decision 7 (session-scratchpad only, not part of this repo).

**Verification**: mypy strict clean (91 source files), ruff check + format
clean, full suite green (534 passed, up from 515 at slice 2's close — 19
new; the live_cmd test correctly deselected by default, confirmed via
`--collect-only`).
