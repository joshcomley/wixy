"""The worker's internal HTTP API (spec/independence/05 §2) —
`wixy_server.ai.anthropic_backend.AnthropicAIBackend`'s counterpart, run as the
`worker` compose service (docker-compose.yml, same image as `wixy`, different
`command:`). No published port; reachable from the `wixy` service alone, over
the compose network, matching `wixy`'s own "no published ports, cloudflared is
the only ingress" convention extended to this internal-only surface.

Route shapes mirror cmd's own conventions closely (POST .../conversations 202
queued, GET .../status polled for readiness, POST .../messages 202 accepted) —
not because this repo talks to cmd here, but because `AnthropicAIBackend` is
deliberately shaped like `CmdChatClient` (see that module's own docstring), so
matching the wire shape keeps both backend implementations equally simple.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import anyio
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from builder.jsontypes import JsonObject
from wixy_server.worker.agent_client import AgentSDKClientFactory
from wixy_server.worker.runner import run_turn
from wixy_server.worker.settings import WorkerSettings, load_worker_settings
from wixy_server.worker.state import WorkerConversation, WorkerMessage, WorkerState


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _compose_prompt(preamble: str, first_message: str | None) -> str:
    # Matches CmdAIBackend.create_conversation's own composition exactly (see
    # wixy_server/ai/backend.py) — kept identical across both backends so a
    # conversation looks the same to the model regardless of which one is
    # driving it.
    return preamble if not first_message else f"{preamble}\n\n---\n\n{first_message}"


async def _run_and_track(
    conv: WorkerConversation,
    prompt: str,
    state: WorkerState,
    cwd: str,
    settings: WorkerSettings,
    client_factory: AgentSDKClientFactory | None,
) -> None:
    """Fire-and-forget background task (spawned per create/send via `TaskGroup.
    start_soon`, which only ever forwards POSITIONAL args — no keyword-only
    parameters here, unlike this codebase's usual convention, specifically
    because of that constraint). Errors are captured onto the conversation
    itself (never raised into the task group, which would crash the whole
    worker process over one bad agent run)."""
    try:
        await run_turn(
            conv,
            prompt,
            cwd=cwd,
            max_budget_usd=settings.monthly_budget_usd,
            client_factory=client_factory,
        )
        state.month_to_date_usd += conv.total_cost_usd
    except Exception as exc:  # noqa: BLE001 - genuinely any SDK/transport failure lands here
        conv.failure_reason = "agent_run_failed"
        conv.failure_message = str(exc)


def create_worker_app(
    *,
    settings: WorkerSettings | None = None,
    client_factory: AgentSDKClientFactory | None = None,
) -> FastAPI:
    """`client_factory` overridable so tests inject `fake_agent_sdk.py`'s
    scripted double instead of the real SDK. `settings` overridable so tests
    don't need real env vars or a real scratch-root filesystem layout.

    `router` is constructed FRESH here, not at module scope — every route
    handler below closes over this call's own `state`/`resolved_settings`/
    `client_factory` directly (unlike `wixy_server/routes_engine.py`'s own
    module-level router, whose handlers read everything from
    `request.app.state` instead and so have no such closure to worry about).
    A shared module-level router would accumulate handlers across every call
    to this factory, with FastAPI matching routes in registration order —
    the first test to build a worker app would silently keep intercepting
    every later test's requests with ITS OWN stale `state` and (empty, by
    default) `client_factory`. Caught by two tests in the same file
    interfering with each other under pytest despite passing individually —
    see decisions/00059 for the full diagnosis.
    """
    resolved_settings = settings if settings is not None else load_worker_settings()
    state = WorkerState()
    router = APIRouter(prefix="/conversations")

    @router.post("", response_model=None)
    async def create_conversation(request: Request) -> JSONResponse:
        if state.month_to_date_usd >= resolved_settings.monthly_budget_usd:
            # spec §2: "refuses new conversations past the cap with a friendly
            # message" — 402 Payment Required is the literal HTTP status for
            # exactly this ("the request can't be fulfilled without payment"),
            # closest fit in the spec without inventing a bespoke code.
            raise HTTPException(
                status_code=402,
                detail=(
                    "This month's AI budget has been used up. It resets on the 1st, "
                    "or you can raise the limit in your Anthropic console."
                ),
            )
        body = await request.json()
        preamble = body.get("preamble", "") if isinstance(body, dict) else ""
        first_message = body.get("firstMessage") if isinstance(body, dict) else None
        conv = state.new_conversation(preamble)
        conv.ready = True  # no workspace-provisioning delay yet (a later slice)
        if isinstance(first_message, str) and first_message:
            conv.append(
                WorkerMessage(
                    index=conv.next_index(),
                    role="user",
                    kind="text",
                    text=first_message,
                    timestamp=_now_iso(),
                )
            )
            scratch_dir = resolved_settings.scratch_root / conv.conv_id
            await anyio.to_thread.run_sync(lambda: scratch_dir.mkdir(parents=True, exist_ok=True))
            prompt = _compose_prompt(conv.preamble, first_message)
            request.app.state.background_tasks.start_soon(
                _run_and_track,
                conv,
                prompt,
                state,
                str(scratch_dir),
                resolved_settings,
                client_factory,
            )
        return JSONResponse(
            status_code=202, content={"convId": conv.conv_id, "pendingState": "queued"}
        )

    @router.get("/{conv_id}/status", response_model=None)
    async def get_status(conv_id: str) -> JsonObject:
        conv = state.conversations.get(conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="unknown conversation")
        return {
            "activity": conv.activity,
            "ready": conv.ready,
            "failureReason": conv.failure_reason,
            "failureMessage": conv.failure_message,
        }

    @router.post("/{conv_id}/messages", response_model=None, status_code=202)
    async def send_message(conv_id: str, request: Request) -> JsonObject:
        conv = state.conversations.get(conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="unknown conversation")
        body = await request.json()
        text = body.get("text", "") if isinstance(body, dict) else ""
        idem_key = body.get("idempotencyKey") if isinstance(body, dict) else None
        if isinstance(idem_key, str):
            seen_count = conv.idempotency_seen.get(idem_key, 0)
            conv.idempotency_seen[idem_key] = seen_count + 1
            if seen_count > 0:
                # Same idempotency key seen before — the send already
                # happened; report accepted without re-running the agent
                # (spec/06 §1's own "a UI retry can't double-send" contract,
                # extended to this backend).
                return {"accepted": True, "buffered": False}
        conv.append(
            WorkerMessage(
                index=conv.next_index(), role="user", kind="text", text=text, timestamp=_now_iso()
            )
        )
        scratch_dir = resolved_settings.scratch_root / conv.conv_id
        request.app.state.background_tasks.start_soon(
            _run_and_track,
            conv,
            text,
            state,
            str(scratch_dir),
            resolved_settings,
            client_factory,
        )
        return {"accepted": True, "buffered": False}

    @router.get("/{conv_id}/messages", response_model=None)
    async def get_messages(
        conv_id: str, limit: int = 80, after: int | None = None, includeThinking: bool = False
    ) -> JsonObject:
        conv = state.conversations.get(conv_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="unknown conversation")
        items = conv.messages
        if not includeThinking:
            items = [m for m in items if m.kind != "thinking"]
        if after is not None:
            items = [m for m in items if m.index > after]
        if limit > 0:
            items = items[-limit:]
        return {"messages": [m.to_json() for m in items]}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with anyio.create_task_group() as tg:
            _app.state.background_tasks = tg
            yield
            tg.cancel_scope.cancel()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.worker_state = state
    app.include_router(router)
    return app
