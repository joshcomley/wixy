# Milestone 10 slice 1: the `cmdchat.py` client

Milestone 10 (AI chat, spec/06-ai-chat.md) is the first genuinely new-territory
milestone in this chain since M6 — everything before it (M7-M9) extended an
already-established server/editor/publish foundation; M10 introduces an entirely
new external-service integration (the local cmd instance) with async polling, a
websocket, idempotent sends, and handover-follow semantics. Per every prior
handover's own flagged concern, this slice starts with a full fresh re-read of
spec/06 (not done since it was written) before any code.

This slice builds the foundation everything else in M10 depends on: the
`wixy_server/cmdchat.py` client module spec/06 §1's preamble mandates ("These
calls MUST go through one wixy_server/cmdchat.py client module"), its fake-cmd
test double (spec/06 §4), and the preamble template. No admin API routes, no
`chats.json` store, and no UI yet — those are later slices, consuming this one's
interface.

## Decision 1: `wait_until_ready` is a first-class orchestration, not just raw
endpoint wrappers

spec/06 §4 explicitly frames `cmdchat.py` as encapsulating provisioning-state
behavior for testability ("tests run against a fake cmd server... including the
handover-resolution and mid-provisioning states"), not just thin per-endpoint
wrappers. So beyond the raw `new_chat`/`get_chain`/`send_message`/`get_messages`/
`get_status` calls, `cmdchat.py` exposes `wait_until_ready(session_id) ->
ProvisioningOutcome` — the full spec/06 §1 readiness contract in one call:

- Poll `GET /api/session/<id>` every 2s (configurable, default matches spec),
  bounded at 120s (configurable), treating 404->200 as ready.
- Concurrently, best-effort subscribe to `/ws/chat-pending` for an early
  `workspace_failed`/`cli_failed` transition event naming this session — if one
  arrives, it short-circuits the wait immediately rather than waiting out the
  full 120s poll budget.
- Whichever resolves first wins; the other is cancelled.
- A websocket that never connects (old cmd, transient hiccup, whatever) is NOT
  an error — spec/06 §1 explicitly frames this as graceful degradation ("If the
  WS is unavailable, the 120s timeout is the terminal signal"), so
  `watch_pending()` swallows any connect/protocol failure and just ends the
  generator quietly; `wait_until_ready` falls back to pure polling in that case,
  exactly as spec'd.

Implemented as two anyio tasks in one task group (`_poll`, `_watch`) racing via a
shared `anyio.Event`, whichever sets the outcome first cancels the group.

## Decision 2: a genuine `CmdChatError` (cmd unreachable) must propagate as
itself, not merged into `FailedOutcome`

spec/06 §3's failure-mode table draws a real distinction: "cmd down (connect
refused)" gets an offline banner + auto-retry, which is a materially different UI
state from "provisioning failed" (`workspace_failed`/`cli_failed`, shown as a
per-conversation failure + Retry) or a plain timeout. `wait_until_ready` keeps
these separable: a `CmdChatError` (raised after `_request`'s retry budget is
exhausted — see `wixy_server/cmdchat.py`'s `_request`) propagates OUT of
`wait_until_ready` as a real exception, while `workspace_failed`/`cli_failed`/
`timeout` come back as a `FailedOutcome` return value. A future caller (the
conversation-creation route, slice 2) can `except CmdChatError` for the offline
case distinctly from inspecting a `FailedOutcome.reason` for the others.

**A real bug found by testing this, not assumed correct:** the first
implementation raised `CmdChatError` from inside the `_poll` task and let it
propagate naturally out of `async with anyio.create_task_group()`. A real test
(`test_wait_until_ready_propagates_unreachable_cmd_distinctly`, pointed at a
genuinely closed local port so the connection is really refused, not mocked)
caught that this does NOT come out as a clean `CmdChatError` — Python's
structured concurrency (native asyncio TaskGroup semantics, which anyio's
asyncio backend uses) wraps even a SINGLE child-task exception in an
`ExceptionGroup`/`BaseExceptionGroup` when it propagates out of the group. A
caller's `except CmdChatError:` would never match a `BaseExceptionGroup`
wrapping one, silently turning the intended offline-banner path into an
unhandled 500 instead. Fixed by catching `BaseExceptionGroup` around the task
group and re-raising `eg.exceptions[0]` directly when there's exactly one
(preserving the group, rather than guessing, in the — currently unreachable —
case of more than one). This is exactly the kind of thing this whole chain's
handovers keep flagging: verify behavior for real (here, a genuinely refused
TCP connection) rather than trusting that "the exception type in the `raise`
statement is the exception type the caller sees" holds through an intervening
structured-concurrency boundary — it doesn't, by default, in this Python
version's task groups.

## Decision 3: retry policy lives in exactly one place

spec/06 §1's preamble states the policy once ("timeouts 10s, retries x2 on
connect errors") for every call `cmdchat.py` makes. Implemented as a single
`_request` helper every public method funnels through — one `httpx.AsyncClient`
per `CmdChatClient` instance (connection reuse), catching `httpx.TransportError`
specifically (connect/read/timeout failures — never a 4xx/5xx HTTP response,
which is the caller's own job to interpret per-endpoint: a 404 on `GET session`
means "not ready yet," not an error; a 502 on `send` means "couldn't deliver,"
surfaced to the UI per spec/06 §3's table). `max_attempts=3` (1 initial + 2
retries), `timeout_s=10.0` — both constructor-overridable for tests.

## Decision 4: the websocket connector is injectable, and defaults are never
silently reachable from a test

`CmdChatClient` takes an optional `ws_connect: WsConnector` (a zero-arg callable
returning an async context manager over incoming frames) — production defaults
to a `websockets.connect(ws_url, open_timeout=timeout_s)` closure, tests inject
a fake. This mattered concretely: this whole test suite runs INSIDE a real cmd
session on a box where a real cmd instance is genuinely listening on 9320. Every
ASGITransport-based (hermetic, no real server) test in `test_cmdchat.py`
explicitly overrides `ws_connect` to an always-fails stub — leaving
`CmdChatClient`'s default in place would have made "hermetic" unit tests
silently reach out to the real local cmd's real websocket, which is exactly the
kind of test-pollutes-host-state (or host-state-pollutes-test) bug this project
has hit before in spirit (see decisions/00013's watcher/publish-lock race).

Added `websockets>=13.0` to `pyproject.toml`'s `server` extra — the only new
runtime dependency this slice introduces.

## Decision 5: two test transports for two different needs

`httpx.ASGITransport` dispatches directly into the fake cmd FastAPI app with no
real socket — fast and hermetic, used for every plain-HTTP-endpoint test
(new-chat, session polling, chain, send, messages, status). It cannot do a
websocket upgrade, so the `/ws/chat-pending` tests instead spin up the SAME fake
app via a real `uvicorn.Server` on an ephemeral `127.0.0.1` port, run on a
background thread (`fake_cmd.FakeCmdServer` — the same "spin up a real
process/thread for what a mock genuinely can't exercise" precedent
`test_kill_during_publish.py` set in decisions/00030).

**A second real bug found by testing, not assumed correct:** the first
`FakeCmdServer`/pending-event design let a test call `publish_pending_event`
directly, which called `asyncio.Queue.put_nowait` on a queue that belongs to the
UVICORN THREAD's own event loop — but `publish_pending_event` runs on the TEST's
thread/loop. `asyncio.Queue` is not thread-safe; calling its methods from a
different thread than the one driving its loop corrupts internal state
(non-deterministically — this could have shipped as a flaky test that appeared
to pass locally and intermittently hung or misbehaved in CI). Fixed by capturing
the server-thread's event loop the first time a websocket subscriber connects
(`_PendingBus.subscribe`, which necessarily runs ON that loop) and using
`loop.call_soon_threadsafe(queue.put_nowait, event)` for the cross-thread
handoff — the correct, standard asyncio idiom for "wake up a different thread's
event loop safely." A companion `wait_for_pending_subscriber` polls
(same-thread-safe, since it just reads a list length) until a subscriber has
actually connected, so tests don't race the publish against the connect.

## Decision 6: `GET .../chain`'s response shape is an assumption, flagged for
the live smoke test

spec/06 §1 says the chain endpoint "returns the root->leaf chat chain" but
doesn't give an exact JSON shape. Implemented as `{"chain": [...session ids...]}`
— consistent with every OTHER cmd response shape this spec documents (all
object-enveloped, e.g. `{"session_id", "pending_state", "workspace_id"}`, never a
bare top-level array) — defensively parsed (a non-list or non-all-string
`chain` raises `CmdChatError` rather than silently returning something wrong).
This is exactly the kind of assumption spec/06 §4's `@pytest.mark.live_cmd`
smoke test (skipped in CI, run against a real local cmd) exists to catch — not
yet written (comes with the send/messages slice, since a live smoke test needs a
real send round-trip to be worth anything) but flagged here for whoever writes
it: verify this shape against the real endpoint first.

## Decision 7: `activity`/`process.kind`/`handover_state` are passed through
raw, not yet turned into a working/idle/dead status

spec/06 §1 says the UI should prefer `activity` (store mtime) over process
liveness for the status dot, with the explicit warning that `process.kind:
"none"` does NOT mean dead. `cmdchat.py`'s `ChatStatus` surfaces these three
fields (plus the raw body) as-is; it does NOT compute a working/idle/dead
verdict. That derivation belongs where the SSE fan-out lives (a later slice,
consuming a live poll cadence to judge "how fresh is fresh") — computing it here
in the plain data-fetching layer would bake a UI-facing freshness threshold into
what should be a thin transport client, and there's no slice-1 caller that needs
it yet. Flagged here so whichever slice adds it doesn't have to rediscover this
reasoning.

## Files changed

- `wixy_server/cmdchat.py` (new) — the client.
- `wixy_server/templates/chat_preamble.md` (new) — spec/06 §1's preamble, 1404
  bytes (spec caps it at "< 1.5 KB").
- `wixy_server/tests/fake_cmd.py` (new) — the fake cmd double + `FakeCmdServer`.
- `wixy_server/tests/test_cmdchat.py` (new) — 18 tests.
- `pyproject.toml` — added `websockets>=13.0` to the `server` extra.

**Verification**: mypy strict clean (87 source files), ruff check + format
clean, full suite green (491 passed, up from 473 at the M9 close — 18 new).
