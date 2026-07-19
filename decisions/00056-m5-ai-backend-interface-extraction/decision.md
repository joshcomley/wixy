# M5 — AI backend interface extraction

## Context

spec/independence/05 §1: extract `wixy_server.cmdchat.CmdChatClient`'s surface into a
protocol `routes_chat.py` consumes, so milestone 6's `anthropic` backend can stand
alongside the `cmd` backend without `routes_chat.py` (or its tests) knowing which one
is active. CI-gated only (no Fable review) — this milestone changes no secret
handling, no deploy surface, nothing security-sensitive.

## What was built

`wixy_server/ai/backend.py` (new package `wixy_server/ai/`):

- `AIBackendError` — the backend-agnostic replacement for `CmdChatError` at the
  `routes_chat.py` boundary.
- `ConversationRef` — an opaque `{id: str}` wrapper around what `session_id` already
  was; kept as a distinct type (not a bare `str`) so a future backend needing more
  than one field doesn't force every call site's signature to change.
- `AIBackend` (a `typing.Protocol`) — the spec's four named methods
  (`create_conversation`, `send`, `read`, `status`) plus `wait_until_ready` and
  `get_chain` (both genuinely used by `routes_chat.py` today, spec/06 §1's
  readiness-tracking and handover-follow) and `aclose`, plus the spec's own named
  example capability flag `supports_handover_chains: bool`.
- `CmdAIBackend` — the `cmd` backend: a straight passthrough wrapper over an existing
  `CmdChatClient`, translating `CmdChatError` -> `AIBackendError` at every call.
  `supports_handover_chains = True`.

`routes_chat.py` now imports `AIBackend`/`AIBackendError`/`ConversationRef` instead of
`CmdChatClient`/`CmdChatError`, and reads `request.app.state.ai_backend` instead of
`request.app.state.cmdchat_client`. `wixy_server/app.py`'s `create_app` constructs
`CmdAIBackend(chat_client, cmd_project=project.cmd_project)` internally and stores it
as `app.state.ai_backend` — `app.state.cmdchat_client` and the `cmdchat_client`
constructor parameter are UNCHANGED, deliberately (see below).

## Decisions

**1. `create_app`'s `cmdchat_client` parameter kept exactly as-is; wrapping happens
internally.** 21 call sites in `test_routes_chat.py` alone construct
`create_app(..., cmdchat_client=CmdChatClient(transport=fake_transport))` — changing
that parameter's name or type would have forced 21+ test-file edits for zero
behavioral gain. Instead `create_app` builds the `CmdAIBackend` wrapper internally and
exposes it as a NEW `app.state.ai_backend`; every existing test fixture continues
constructing a fake-cmd-pointed `CmdChatClient` exactly as before and needs no change
at all for this reason. This is the same "extend, don't rename the existing extension
point" pattern spec/independence/05 §1 implies with "existing tests keep passing
against the fake cmd server" — read as a requirement on test SEMANTICS, not on every
line of test wiring code staying byte-identical.

**2. Preamble+first-message combination logic moved from the route into
`CmdAIBackend.create_conversation`.** The OLD route built
`f"{preamble}\n\n---\n\n{first_message}"` itself, then called `client.new_chat(cmd_project,
prompt)` with the pre-built string. The spec's `create_conversation(preamble,
first_message)` signature takes them SEPARATELY — meaning the BACKEND decides how to
combine them, not the route. This is the right layering: a future `anthropic` backend
built on the Agent SDK might use them as genuinely separate system-prompt vs.
user-message fields rather than concatenating into one string, and the route
shouldn't need to know or care. `CmdAIBackend.create_conversation` reproduces the
OLD route's exact concatenation logic (verified byte-identical via
`test_prompt_sent_to_cmd_includes_preamble_and_first_message`/
`test_prompt_without_first_message_is_preamble_alone`, both passing unmodified) — the
route-level `_prompt_for` helper became dead code and was deleted, not left behind.

**3. `read()` gained a real `after: int | None = None` parameter routes_chat.py
doesn't use yet.** The spec's literal signature is `read(conv_ref, after)`; cmd's own
`get_messages` API has no server-side "after" filter (only `before`, the opposite
direction), and `routes_chat.py`'s existing stream does its own client-side diffing
every tick regardless (spec/06 §1) — changing THAT call pattern is out of scope for a
"behavior-identical" extraction. Decided: `CmdAIBackend.read` implements `after` for
real (filters the fetched batch client-side: `[m for m in messages if m.index >
after]`), so the parameter is genuine working capability rather than a decorative
no-op, ready for milestone 6's worker (which has a real transcript store that could
serve it cheaply server-side) — but `_stream_events` itself was NOT changed to start
passing it, preserving exact existing behavior.

**4. `client.supports_handover_chains` guards the handover-follow block in
`_stream_events`**, even though `CmdAIBackend` always sets it `True` today (zero
behavioral difference for M5). This is the spec's own named example of the capability-
flag mechanism, and the natural place to add the guard is exactly where the
handover-chain-specific call (`get_chain`) happens — retrofitting this guard later,
once M6's `anthropic` backend (which sets the flag `False`) actually exists, would
mean re-touching `_stream_events` a second time for something foreseeable now.

**5. `WIXY_AI_BACKEND` was deliberately NOT added to `settings.py` this milestone.**
The spec's own section header says the env var selects between backends "chosen by
`WIXY_AI_BACKEND`" — but with only ONE real implementation existing until milestone 6,
adding a switch with a single working branch would be exactly the kind of
premature/half-finished plumbing the fleet's own "no code for hypothetical future
requirements" rule warns against. `create_app` unconditionally builds `CmdAIBackend`
for now; milestone 6 adds both the setting and the real branch when there is a second
implementation to branch to.

## Verification

- `ruff check` / `ruff format --check` / `mypy --strict` clean.
- Full pytest suite: 578 passed (matches M1's own baseline count exactly — this
  milestone modifies existing tests' internal wiring, adds none, removes none).
- Zero test ASSERTIONS changed — every `test_routes_chat.py` test's expected behavior
  is byte-for-byte what it was before this extraction; only 17 fixture-parameter
  declarations + call sites were mechanically updated to route through
  `AIBackend`/`ai_backend` instead of `CmdChatClient`/`cmdchat_client` (see "What to
  watch for" below for a self-review note on how that mechanical pass went).
- **One flaky failure observed and investigated, not chased further**:
  `TestStateChatsField::test_state_reflects_created_conversations` failed once under
  full-suite `-n 4` load (`assert 'failed' == 'pending'` — the background readiness
  tracker resolved before the test's own synchronous check landed). Passed cleanly in
  isolation AND on a second full-file run immediately after. This is the SAME class of
  full-suite-parallel-contention timing sensitivity already diagnosed and documented
  twice in this repo (decisions/00025 for the parity harness, decisions/00053 for
  `test_kill_during_publish.py`) — a third occurrence, in a different test, joining an
  already-established, already-answered pattern. Not this milestone's code touching
  timing behavior at all (the `readiness_timeout_s=0.3`/`readiness_poll_interval_s=0.02`
  fixture constants are unchanged); not chased into a fix here, consistent with
  00025's own precedent that the "why" being answered is the bar, not eliminating
  every instance of a known, load-only flake class.

## What to watch for

- **Self-review note on the mechanical test-wiring pass**: an earlier attempt at this
  used a single broad `replace_all` on the parameter pattern `cmdchat_client:
  CmdChatClient,\n        fake_cmd_state: FakeCmdState,`, which turned out to match 17
  functions, not just the 7 that actually call `_stream_events` — wrongly renaming 10
  functions whose bodies still referenced `cmdchat_client` for `create_app(...)`,
  which would have been a `NameError` at test-collection/run time. Caught by running
  `mypy`/the actual test suite immediately after (not by inspection alone) and fixed
  with 10 individually-anchored edits. Recorded here as a reminder: a parameter-name
  pattern shared across unrelated call sites is not a safe `replace_all` target
  without also checking every match's actual BODY usage, not just its signature.
- If milestone 6 needs `AIBackend.read`'s `after` parameter for real, wire it into
  `_stream_events`'s own call at that point — this milestone deliberately left that
  call site unchanged.
- `app.state.cmdchat_client` still exists alongside the new `app.state.ai_backend` —
  intentional (see decision 1), not a leftover to clean up. Both point at the same
  underlying `CmdChatClient` instance; `ai_backend` is what every route now actually
  reads.
