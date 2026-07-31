# The standalone/anthropic backend's `activity` is a timestamp, not cmd's enum — the working indicator is broken there too, NOT fixed by this session

## Status: discovered, deliberately NOT fixed here — flagging for the operator / a milestone-6-scoped session

## What was found

While fixing decisions/00100 (cmd's `activity` enum-literal mismatch), a second, INDEPENDENT
instance of the same class of bug turned up in the OTHER `AIBackend` implementation.
`chat_working.WorkingCache`/`admin-ui/src/chatPanel.ts:activityState` are edition-agnostic —
`wixy_server/app.py:create_app` picks `AnthropicAIBackend` or `CmdAIBackend` for
`app.state.ai_backend` based on `settings.ai_backend` (`WIXY_AI_BACKEND`), and BOTH backends
feed the exact same `ChatStatus.activity` field through the exact same `_is_working`/
`activityState` equality check (by explicit design — `create_app`'s own docstring: "no
per-edition branching needed").

For `CmdAIBackend` (the fleet edition, the one actually live at `ca.cinnamons.uk`), `activity`
is cmd's own enum (decisions/00099, 00100). For `AnthropicAIBackend` (the standalone edition,
`spec/independence/05` §2, milestone 6 — `WIXY_EDITION=standalone`), `activity` is a **real ISO
timestamp string**:

- `wixy_server/worker/state.py`: `ConversationState.append(message)` sets
  `self.activity = message.timestamp`, and `WorkerMessage.timestamp: str` is a genuine
  timestamp (not an enum member).
- `wixy_server/worker/app.py:get_status` serializes it verbatim: `{"activity": conv.activity,
  ...}` — the wire value for this backend really is a timestamp string, unlike cmd's.

So `_is_working(activity) -> activity == "active"` (this session's fix, correct for cmd) can
**never** be true for the standalone backend's real timestamp value, any more than the
previous `"working"` literal could, any more than the ORIGINAL pre-decisions/00099
`datetime.fromisoformat`-parsing approach could ever be true for cmd's enum. Each of the three
implementations this field has had so far (timestamp-parse → cmd-enum-wrong-literal →
cmd-enum-correct-literal) has been right for exactly one backend and wrong for the other,
because **`ChatStatus.activity`'s wire format is backend-dependent, and no single fixed
comparison against one shared field can be correct for both simultaneously.**

There is currently **zero test coverage** exercising `WorkingCache`/`activityState` against
`AnthropicAIBackend` specifically (confirmed: no hit for `WorkingCache`/`working_for`/
`chat_working` anywhere in `wixy_server/tests/test_anthropic_backend.py`) — so this has never
been a red CI signal, on any version of this code, and isn't one now either.

## Why this is NOT being fixed in this session

1. **Not in scope.** This session's mission was verifying/fixing the fleet-edition chat
   activity signal (decisions/00099, 00100) for the LIVE, production `ca.cinnamons.uk` site,
   which runs `WIXY_EDITION=fleet` exclusively (confirmed via `/api/version`:
   `"edition":"fleet"`). The standalone edition isn't deployed there and was never part of the
   original brief.
2. **A real fix here is a design task, not a one-line literal swap.** Unlike decisions/00100
   (same field, same backend, wrong string), correctly supporting BOTH backends needs an actual
   decision about the right shape — e.g. each backend normalizing its own "is working right
   now" boolean/enum before it reaches the shared `ChatStatus`, rather than both leaking a raw,
   backend-specific string through one field that downstream code interprets with a single
   hardcoded semantic (arguably the real root cause common to all three historical bugs here).
   That's a protocol-shape change touching `wixy_server/ai/backend.py`'s `ChatStatus`/
   `AIBackend`, both concrete backends, and needs its own new test coverage for the anthropic
   side (none exists today) — not something to bolt onto an unrelated, already-in-flight PR.
3. **This repo's own CLAUDE.md gates it.** `WIXY_EDITION=standalone`/milestone 6 is one of the
   independence-phase milestones (2, 3, 4, 6, 7) explicitly marked **SECURITY-GATED**: "open
   the PR, peer-message the spec author session with the PR number + that milestone's review
   checklist, and merge only after an explicit approval reply — never auto-merge those on green
   CI alone." This session's whole PR1-5 pipeline has been fast, autonomous, auto-merge-on-green
   — the correct process for milestone-6-touching code is a materially different, heavier one
   this session isn't set up to run (no "spec author session" identified for this purpose, no
   review checklist gathered). Fixing this properly means engaging that process, not
   sidestepping it inside an unrelated fast-moving fix.

## What to watch for / how to actually fix this

- **Confirm the real behavior live** before designing a fix — this decision's evidence is from
  reading `worker/state.py`/`worker/app.py`'s source directly, not from a live standalone
  deployment (none was available to query the way `ca.cinnamons.uk` was for decisions/00099/
  00100). Read the source, but also spin up a real standalone instance and observe the wire
  value end to end before trusting any fix, per this whole session's own hard-won lesson: a
  test double (or a source read) is a good hypothesis, not a substitute for live confirmation.
- **The likely right fix**: give `ChatStatus` a backend-normalized field (e.g. a plain
  `is_working: bool` each backend's own `.status()` computes from whatever its native signal
  actually is — cmd's enum equality, or the worker's timestamp freshness), and have
  `_is_working`/`activityState` read THAT instead of interpreting a raw, backend-specific
  string themselves. This removes the entire class of "which format is `activity` in this
  time" bug permanently, rather than fixing it once per backend as each gets independently
  discovered broken (which is what happened three times over across decisions/00034, 00099,
  and 00100).
- **Add anthropic-backend test coverage for this** as part of that fix — its current total
  absence is exactly why this specific gap could exist for as long as it has without any CI
  signal.
- **Route the actual fix through the milestone-6 security gate** (peer-message the spec author
  session with the PR + that milestone's review checklist, per this repo's CLAUDE.md) —
  do not auto-merge it on green CI alone the way PR1-5 this session were.
