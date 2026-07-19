# M6 AI budget card: get_budget_status lives on AnthropicAIBackend, not the shared AIBackend protocol

## Context

spec/independence/05 §2: "the Settings → AI card shows month-to-date spend."
The handover's own open item framed this as needing "a new main-server route
proxying a new worker budget-status endpoint" — this entry records the
specific shape that took.

## Where "get budget" lives: a method on the concrete class, not the protocol

`wixy_server.ai.backend.AIBackend` (the shared protocol both `CmdAIBackend`
and `AnthropicAIBackend` implement) already has ONE precedent for
"capability some backends don't support" — `supports_handover_chains`, a
boolean flag `routes_chat.py` checks before ever calling `get_chain`. Budget
status doesn't fit that same shape: the cmd backend has NO monthly-budget
concept at all (Josh's fleet subscription, not a per-project budgeted
resource) — there's no meaningful "false" value to report, unlike handover
chains where "this backend has none" is itself a real, expressible fact.
Forcing a `get_budget_status` method onto the shared protocol would mean
`CmdAIBackend` either raises unconditionally (dead code no caller should ever
reach, same as `AnthropicAIBackend.get_chain`'s own existing precedent — a
reasonable shape, but for a genuinely absent CAPABILITY, not an absent
CONCEPT) or returns some fabricated zero/null value that misrepresents "not
applicable" as "nothing spent."

**Decision**: `get_budget_status` (returning a new `BudgetStatus` dataclass)
is a method on `AnthropicAIBackend` ITSELF, not the shared protocol. The new
route (`wixy_server/routes_ai.py`, `GET /api/admin/ai/budget`) narrows
`request.app.state.ai_backend` (typed as the generic `AIBackend` everywhere
else in this codebase, deliberately) back to the concrete `AnthropicAIBackend`
via `assert isinstance(...)` — safe because the route's own guard
(`settings.ai_backend != "anthropic"` → 404) checks the EXACT condition
`wixy_server.app.create_app` already used to construct that concrete type as
`app.state.ai_backend` in the first place. `routes_ai.py` is this
codebase's ONE place that ever narrows the backend type — everywhere else
(`routes_chat.py`) stays fully backend-agnostic, as intended.

## Route shape mirrors routes_engine.py's own established pattern

`_require_standalone`'s "this feature doesn't exist here, not a permission
problem" 404 (rather than 403) is reused verbatim in spirit for
`_require_anthropic_backend`'s equivalent check — the same "the fleet
edition simply has no engine-update surface" reasoning applies to "a
cmd-backend deployment simply has no monthly-budget concept." A worker
connection failure maps to 502 (`couldn't reach the worker`), matching
`routes_engine.py`'s own `GitHubApiError` → 502 mapping for a GitHub API
failure — "the feature exists but the backend is unreachable right now" is a
different, distinct failure mode from "the feature doesn't exist on this
deployment," and the two need different status codes for the frontend to
tell apart (the AI card's own `renderNotAvailable` vs `renderLoadError`,
mirroring the Engine card's identical two-path handling).

## Worker's own `/budget` route: top-level, not nested under /conversations

`wixy_server/worker/app.py`'s existing `router` is `APIRouter(prefix=
"/conversations")` — every route on it inherits that prefix. Budget is a
property of the WORKER PROCESS (`WorkerState.month_to_date_usd`), not of any
one conversation, so `GET /budget` is registered directly on `app` instead,
outside that router — nesting it under `/conversations/budget` would have
been structurally misleading (implying a conversation-scoped resource that
doesn't exist).

## Frontend: simple periodic poll, no in-flight-run tracking

The Engine card's poll loop distinguishes "an update/rollback is in flight"
(5s cadence) from idle (60s) because there's a real, trackable server-side
operation (the sync workflow run) to watch finish. The AI budget number has
no analogous in-flight operation — it just changes as conversations happen,
possibly in an entirely different browser tab — so the AI card uses one flat
60s poll interval, no in-flight/idle distinction, matching the actual
simplicity of what it's tracking rather than copying the Engine card's extra
state machine for a case that doesn't need it.
