"""`/api/admin/ai/budget` (spec/independence/05 §2) — the Settings → AI card's
month-to-date spend display. `anthropic`-backend only: a `cmd`-backend
deployment (the fleet default) has no monthly-budget concept at all (Josh's
fleet subscription, not a per-project budgeted resource), so this route 404s
there exactly the way `wixy_server.routes_engine`'s standalone-only routes
404 on the fleet edition — same "this feature doesn't exist here, not a
permission problem" reasoning (`_require_standalone`'s own docstring).

`app.state.ai_backend` is typed as the backend-agnostic `AIBackend` protocol
(`wixy_server.ai.backend`) everywhere else in this codebase on purpose — this
route is the ONE place that narrows it back to the concrete
`AnthropicAIBackend` to call its budget-specific method, safe to do because
`settings.ai_backend == "anthropic"` is the EXACT condition
`wixy_server.app.create_app` already used to construct that concrete type in
the first place (see that function's own docstring).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from builder.jsontypes import JsonObject
from wixy_server.ai.anthropic_backend import AnthropicAIBackend
from wixy_server.ai.backend import AIBackendError
from wixy_server.settings import Settings

router = APIRouter(prefix="/api/admin/ai")


@router.get("/budget", response_model=None)
async def get_ai_budget(request: Request) -> JsonObject:
    settings: Settings = request.app.state.settings
    if settings.ai_backend != "anthropic":
        raise HTTPException(
            status_code=404, detail="the AI budget surface is anthropic-backend-only"
        )

    ai_backend = request.app.state.ai_backend
    assert isinstance(ai_backend, AnthropicAIBackend)  # see module docstring
    try:
        status = await ai_backend.get_budget_status()
    except AIBackendError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach the worker: {exc}") from exc

    return {
        "monthToDateUsd": status.month_to_date_usd,
        "monthlyBudgetUsd": status.monthly_budget_usd,
    }
