"""A fake `worker` HTTP server (spec/independence/05 §2) — stands in for the
internal API `wixy_server.ai.anthropic_backend.AnthropicAIBackend` talks to, so
that module's own tests run against a hermetic double instead of a real worker
process (which needs a real ANTHROPIC_API_KEY + the Agent SDK). Mirrors
`fake_cmd.py`'s own state-dataclass + FastAPI-app-factory convention.

Not a `test_*.py` file — a reusable fixture module, imported by test files, never
collected by pytest itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from builder.jsontypes import JsonObject


@dataclass
class FakeConversation:
    conv_id: str
    preamble: str
    first_message: str | None
    ready: bool = True
    failure_reason: str | None = None
    failure_message: str | None = None
    messages: list[JsonObject] = field(default_factory=list)
    activity: str | None = None
    send_status_code: int = 202
    send_buffered: bool = False
    idempotency_seen: dict[str, int] = field(default_factory=dict)


@dataclass
class FakeWorkerState:
    conversations: dict[str, FakeConversation] = field(default_factory=dict)
    next_id_n: int = 1
    create_status_code: int = 202
    month_to_date_usd: float = 0.0
    monthly_budget_usd: float = 40.0
    budget_status_code: int = 200

    def create_conversation(self, preamble: str, first_message: str | None) -> FakeConversation:
        n = self.next_id_n
        self.next_id_n += 1
        conv = FakeConversation(
            conv_id=f"worker-conv-{n}", preamble=preamble, first_message=first_message
        )
        self.conversations[conv.conv_id] = conv
        return conv


def create_fake_worker_app(state: FakeWorkerState | None = None) -> FastAPI:
    state = state if state is not None else FakeWorkerState()
    app = FastAPI()
    app.state.fake = state

    @app.post("/conversations")
    async def create(request: Request) -> Response:
        if state.create_status_code != 202:
            return Response(status_code=state.create_status_code)
        body = await request.json()
        preamble = body.get("preamble", "") if isinstance(body, dict) else ""
        first_message = body.get("firstMessage") if isinstance(body, dict) else None
        conv = state.create_conversation(preamble, first_message)
        return JSONResponse(
            status_code=202, content={"convId": conv.conv_id, "pendingState": "queued"}
        )

    @app.get("/conversations/{conv_id}/status")
    async def status(conv_id: str) -> Response:
        conv = state.conversations.get(conv_id)
        if conv is None:
            return Response(status_code=404)
        return JSONResponse(
            {
                "activity": conv.activity,
                "ready": conv.ready,
                "failureReason": conv.failure_reason,
                "failureMessage": conv.failure_message,
            }
        )

    @app.post("/conversations/{conv_id}/messages")
    async def send(conv_id: str, request: Request) -> Response:
        conv = state.conversations.get(conv_id)
        if conv is None:
            return Response(status_code=404)
        if conv.send_status_code != 202:
            return Response(status_code=conv.send_status_code)
        body = await request.json()
        idem_key = body.get("idempotencyKey") if isinstance(body, dict) else None
        if isinstance(idem_key, str):
            conv.idempotency_seen[idem_key] = conv.idempotency_seen.get(idem_key, 0) + 1
        return JSONResponse(
            status_code=202, content={"accepted": True, "buffered": conv.send_buffered}
        )

    @app.get("/conversations/{conv_id}/messages")
    async def messages(
        conv_id: str, limit: int = 80, after: int | None = None, includeThinking: bool = False
    ) -> Response:
        conv = state.conversations.get(conv_id)
        if conv is None:
            return Response(status_code=404)
        items = conv.messages
        # Matches wixy_server.worker.app.get_messages's own real filtering
        # exactly (spec/06 §1's "thinking hidden... default-off") -- without
        # this the fake can't stand in for a real "hides thinking by default"
        # test at all, it would just return everything regardless of the
        # query param.
        if not includeThinking:
            items = [m for m in items if m.get("kind") != "thinking"]
        if after is not None:
            filtered = []
            for m in items:
                index = m.get("index")
                if isinstance(index, int) and index > after:
                    filtered.append(m)
            items = filtered
        items = items[-limit:] if limit > 0 else items
        return JSONResponse({"messages": items})

    @app.get("/budget")
    async def budget() -> Response:
        if state.budget_status_code != 200:
            return Response(status_code=state.budget_status_code)
        return JSONResponse(
            {
                "monthToDateUsd": state.month_to_date_usd,
                "monthlyBudgetUsd": state.monthly_budget_usd,
            }
        )

    return app
