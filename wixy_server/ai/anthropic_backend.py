"""The `anthropic` backend (spec/independence/05 §2, standalone edition only) —
an `AIBackend` implementation that talks to the `worker` compose service over its
internal HTTP API, instead of cmd. `WixyAIBackend` construction (`wixy_server.app`)
picks this when `WIXY_AI_BACKEND=anthropic`; `routes_chat.py` only ever sees the
`AIBackend` protocol either way.

The worker (`wixy_server.worker`) is a SEPARATE process/container running the same
image with a different `command:` (docker-compose.yml) — this module is the CLIENT
half of that split, structurally mirroring `wixy_server.cmdchat.CmdChatClient`
(bounded timeouts, retry on transport errors only, structured errors) since that's
this repo's own established shape for talking to an external-ish HTTP service, even
though the worker is "external" only in the sense of being a different container on
the same compose network — never reachable from outside it (no published port,
matching `wixy`'s own convention).

`supports_handover_chains = False`: the anthropic backend has no fleet handover
concept at all (05 §1) — `status()` always reports `handover_state=None`, and
`get_chain` is never called by `routes_chat.py` as a result (see `AIBackend`'s own
docstring: "may leave this unimplemented").
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import anyio
import httpx

from builder.jsontypes import JsonObject
from wixy_server.ai.backend import AIBackendError, ConversationRef
from wixy_server.cmdchat import (
    ChatMessage,
    ChatStatus,
    FailedOutcome,
    ProvisioningOutcome,
    ReadyOutcome,
    SendResult,
)

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class BudgetStatus:
    """`GET /budget`'s shape (spec/independence/05 §2: "the Settings -> AI
    card shows month-to-date spend") — deliberately a method on THIS class,
    not the shared `AIBackend` protocol: the cmd backend has no monthly-
    budget concept at all (Josh's fleet subscription, not a per-project
    budgeted resource), so there's no meaningful "unsupported" value worth
    forcing into the generic interface the way `supports_handover_chains`
    reasonably can. `wixy_server.routes_ai`'s route confirms
    `settings.ai_backend == "anthropic"` (the same condition that made
    `wixy_server.app.create_app` construct an `AnthropicAIBackend` as
    `app.state.ai_backend` in the first place) before ever calling this."""

    month_to_date_usd: float
    monthly_budget_usd: float


DEFAULT_TIMEOUT_S = 10.0
# The worker's own conversation-create step may involve cloning a repo (05 §2) —
# generous relative to a plain API call, matching cmdchat.py's own precedent of a
# longer readiness-wait distinct from the per-request transport timeout.
DEFAULT_READINESS_TIMEOUT_S = 120.0
DEFAULT_READINESS_POLL_INTERVAL_S = 1.0
DEFAULT_MAX_ATTEMPTS = 3


class AnthropicAIBackend:
    supports_handover_chains = False

    def __init__(
        self,
        *,
        worker_base_url: str = "http://worker:8100",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        readiness_timeout_s: float = DEFAULT_READINESS_TIMEOUT_S,
        readiness_poll_interval_s: float = DEFAULT_READINESS_POLL_INTERVAL_S,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = worker_base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        self._readiness_timeout_s = readiness_timeout_s
        self._readiness_poll_interval_s = readiness_poll_interval_s
        self._client = httpx.AsyncClient(transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AnthropicAIBackend:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def _request(
        self, method: str, path: str, *, json_body: JsonObject | None = None
    ) -> httpx.Response:
        url = f"{self._base_url}{path}"
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                return await self._client.request(
                    method, url, json=json_body, timeout=self._timeout_s
                )
            except httpx.TransportError as exc:
                last_error = exc
                logger.warning(
                    "worker: %s %s attempt %d/%d failed: %s",
                    method,
                    path,
                    attempt,
                    self._max_attempts,
                    exc,
                )
        raise AIBackendError(
            f"{method} {path} failed after {self._max_attempts} attempts: {last_error}"
        ) from last_error

    async def create_conversation(
        self, preamble: str, first_message: str | None
    ) -> ConversationRef:
        response = await self._request(
            "POST",
            "/conversations",
            json_body={"preamble": preamble, "firstMessage": first_message},
        )
        if response.status_code != 202:
            raise AIBackendError(
                f"create_conversation returned {response.status_code}: {response.text[:500]}"
            )
        body = response.json()
        conv_id = body.get("convId")
        if not isinstance(conv_id, str):
            raise AIBackendError(f"create_conversation response malformed: {body!r}")
        return ConversationRef(id=conv_id)

    async def send(self, conv_ref: ConversationRef, text: str, idempotency_key: str) -> SendResult:
        response = await self._request(
            "POST",
            f"/conversations/{conv_ref.id}/messages",
            json_body={"text": text, "idempotencyKey": idempotency_key},
        )
        if response.status_code == 404:
            raise AIBackendError(f"unknown conversation {conv_ref.id!r}")
        if response.status_code != 202:
            raise AIBackendError(f"send returned {response.status_code}: {response.text[:500]}")
        body = response.json()
        return SendResult(
            buffered=bool(body.get("buffered", False)),
            pending_state=body.get("pendingState"),
        )

    async def read(
        self,
        conv_ref: ConversationRef,
        *,
        after: int | None = None,
        limit: int = 80,
        include_thinking: bool = False,
    ) -> list[ChatMessage]:
        query = f"?limit={limit}"
        if after is not None:
            query += f"&after={after}"
        if include_thinking:
            query += "&includeThinking=true"
        response = await self._request("GET", f"/conversations/{conv_ref.id}/messages{query}")
        if response.status_code == 404:
            raise AIBackendError(f"unknown conversation {conv_ref.id!r}")
        if response.status_code != 200:
            raise AIBackendError(f"read returned {response.status_code}: {response.text[:500]}")
        body = response.json()
        raw_messages = body.get("messages")
        if not isinstance(raw_messages, list):
            raise AIBackendError(f"read response malformed: {body!r}")
        return [m for m in (_message_from_dict(item) for item in raw_messages) if m is not None]

    async def status(self, conv_ref: ConversationRef) -> ChatStatus:
        response = await self._request("GET", f"/conversations/{conv_ref.id}/status")
        if response.status_code == 404:
            raise AIBackendError(f"unknown conversation {conv_ref.id!r}")
        if response.status_code != 200:
            raise AIBackendError(f"status returned {response.status_code}: {response.text[:500]}")
        body = response.json()
        if not isinstance(body, dict):
            raise AIBackendError(f"status response malformed: {body!r}")
        # No fleet process/handover concept for this backend (see module
        # docstring) — always None regardless of what the worker reports.
        return ChatStatus(
            activity=body.get("activity") if isinstance(body.get("activity"), str) else None,
            process_kind=None,
            handover_state=None,
            raw=body,
        )

    async def wait_until_ready(self, conv_ref: ConversationRef) -> ProvisioningOutcome:
        deadline = anyio.current_time() + self._readiness_timeout_s
        while anyio.current_time() < deadline:
            response = await self._request("GET", f"/conversations/{conv_ref.id}/status")
            if response.status_code == 404:
                raise AIBackendError(f"unknown conversation {conv_ref.id!r}")
            if response.status_code != 200:
                raise AIBackendError(
                    f"status returned {response.status_code}: {response.text[:500]}"
                )
            body = response.json()
            if not isinstance(body, dict):
                raise AIBackendError(f"status response malformed: {body!r}")
            if body.get("ready") is True:
                return ReadyOutcome()
            if body.get("failureReason") is not None:
                reason = body["failureReason"]
                message = body.get("failureMessage")
                return FailedOutcome(
                    reason=reason if isinstance(reason, str) else "unknown",
                    message=message if isinstance(message, str) else None,
                )
            await anyio.sleep(self._readiness_poll_interval_s)
        return FailedOutcome(reason="timeout", message=None)

    async def get_chain(self, conv_ref: ConversationRef) -> list[str]:
        # Never called: supports_handover_chains is False (see module docstring).
        raise AIBackendError("the anthropic backend has no handover-chain concept")

    async def get_budget_status(self) -> BudgetStatus:
        response = await self._request("GET", "/budget")
        if response.status_code != 200:
            raise AIBackendError(
                f"get_budget_status returned {response.status_code}: {response.text[:500]}"
            )
        body = response.json()
        if not isinstance(body, dict):
            raise AIBackendError(f"budget response malformed: {body!r}")
        month_to_date = body.get("monthToDateUsd")
        monthly_budget = body.get("monthlyBudgetUsd")
        if not isinstance(month_to_date, (int, float)) or not isinstance(
            monthly_budget, (int, float)
        ):
            raise AIBackendError(f"budget response malformed: {body!r}")
        return BudgetStatus(
            month_to_date_usd=float(month_to_date), monthly_budget_usd=float(monthly_budget)
        )


def _message_from_dict(data: object) -> ChatMessage | None:
    """Defensive parse — matches `wixy_server.cmdchat._message_from_dict`'s own
    "an unrecognized/malformed entry is skipped, not fatal" convention."""
    if not isinstance(data, dict):
        return None
    index = data.get("index")
    role = data.get("role")
    kind = data.get("kind")
    timestamp = data.get("timestamp")
    if (
        not isinstance(index, int)
        or not isinstance(role, str)
        or not isinstance(kind, str)
        or not isinstance(timestamp, str)
    ):
        return None
    text = data.get("text")
    tool_name = data.get("toolName")
    return ChatMessage(
        index=index,
        role=role,
        kind=kind,
        text=text if isinstance(text, str) else None,
        timestamp=timestamp,
        tool_name=tool_name if isinstance(tool_name, str) else None,
        truncated=bool(data.get("truncated", False)),
    )
