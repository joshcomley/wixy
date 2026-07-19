"""Unit tests for `wixy_server.ai.anthropic_backend.AnthropicAIBackend` against
the fake worker double (spec/independence/05 §2). Same `httpx.ASGITransport`
pattern as `test_cmdchat.py`/`test_github.py`."""

from __future__ import annotations

import socket

import anyio
import httpx
import pytest
from fastapi import FastAPI

from wixy_server.ai.anthropic_backend import AnthropicAIBackend
from wixy_server.ai.backend import AIBackendError, ConversationRef
from wixy_server.cmdchat import FailedOutcome, ReadyOutcome
from wixy_server.tests.fake_worker import FakeWorkerState, create_fake_worker_app


def _make_backend(
    app: FastAPI,
    *,
    readiness_timeout_s: float = 5.0,
    readiness_poll_interval_s: float = 0.02,
) -> AnthropicAIBackend:
    return AnthropicAIBackend(
        transport=httpx.ASGITransport(app=app),
        max_attempts=2,
        readiness_timeout_s=readiness_timeout_s,
        readiness_poll_interval_s=readiness_poll_interval_s,
    )


def _reserve_closed_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


def test_supports_handover_chains_is_false() -> None:
    backend = AnthropicAIBackend()
    assert backend.supports_handover_chains is False


# ---------------------------------------------------------------------------
# create_conversation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_conversation_returns_ref() -> None:
    state = FakeWorkerState()
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        ref = await backend.create_conversation("preamble text", "hello")

    assert ref.id in state.conversations
    assert state.conversations[ref.id].preamble == "preamble text"
    assert state.conversations[ref.id].first_message == "hello"


@pytest.mark.asyncio
async def test_create_conversation_unexpected_status_raises() -> None:
    state = FakeWorkerState()
    state.create_status_code = 500
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        with pytest.raises(AIBackendError):
            await backend.create_conversation("preamble", None)


# ---------------------------------------------------------------------------
# send
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_accepted() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        result = await backend.send(ConversationRef(id=conv.conv_id), "do the thing", "idem-1")

    assert result.buffered is False
    assert conv.idempotency_seen["idem-1"] == 1


@pytest.mark.asyncio
async def test_send_buffered() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.send_buffered = True
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        result = await backend.send(ConversationRef(id=conv.conv_id), "text", "idem-1")

    assert result.buffered is True


@pytest.mark.asyncio
async def test_send_unknown_conversation_raises() -> None:
    state = FakeWorkerState()
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        with pytest.raises(AIBackendError):
            await backend.send(ConversationRef(id="nope"), "text", "idem-1")


@pytest.mark.asyncio
async def test_send_5xx_raises() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.send_status_code = 502
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        with pytest.raises(AIBackendError):
            await backend.send(ConversationRef(id=conv.conv_id), "text", "idem-1")


# ---------------------------------------------------------------------------
# read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_decodes_messages() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.messages = [
        {
            "index": i,
            "role": "assistant" if i % 2 else "user",
            "kind": "text",
            "text": f"message {i}",
            "timestamp": f"2026-07-19T00:00:0{i}Z",
        }
        for i in range(5)
    ]
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        messages = await backend.read(ConversationRef(id=conv.conv_id))

    assert [m.index for m in messages] == [0, 1, 2, 3, 4]
    assert messages[0].text == "message 0"


@pytest.mark.asyncio
async def test_read_skips_malformed_entries() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.messages = [
        {"index": 0, "role": "user", "kind": "text", "text": "ok", "timestamp": "t"},
        {"index": "not-an-int", "role": "user", "kind": "text", "timestamp": "t"},
        {"role": "user"},
    ]
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        messages = await backend.read(ConversationRef(id=conv.conv_id))

    assert len(messages) == 1
    assert messages[0].index == 0


@pytest.mark.asyncio
async def test_read_unknown_conversation_raises() -> None:
    state = FakeWorkerState()
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        with pytest.raises(AIBackendError):
            await backend.read(ConversationRef(id="nope"))


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_never_reports_process_kind_or_handover_state() -> None:
    """This backend has no fleet process/handover concept (module docstring) —
    these two fields must always be None regardless of what the worker sends."""
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.activity = "2026-07-19T00:00:00Z"
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        status = await backend.status(ConversationRef(id=conv.conv_id))

    assert status.activity == "2026-07-19T00:00:00Z"
    assert status.process_kind is None
    assert status.handover_state is None


@pytest.mark.asyncio
async def test_status_unknown_conversation_raises() -> None:
    state = FakeWorkerState()
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        with pytest.raises(AIBackendError):
            await backend.status(ConversationRef(id="nope"))


# ---------------------------------------------------------------------------
# wait_until_ready
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wait_until_ready_immediate() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.ready = True
    app = create_fake_worker_app(state)
    async with _make_backend(app, readiness_poll_interval_s=0.01) as backend:
        outcome = await backend.wait_until_ready(ConversationRef(id=conv.conv_id))

    assert outcome == ReadyOutcome()


@pytest.mark.asyncio
async def test_wait_until_ready_after_several_polls() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.ready = False
    app = create_fake_worker_app(state)

    async def _flip_ready_soon() -> None:
        await anyio.sleep(0.05)
        conv.ready = True

    async with _make_backend(app, readiness_poll_interval_s=0.01) as backend:
        async with anyio.create_task_group() as tg:
            tg.start_soon(_flip_ready_soon)
            outcome = await backend.wait_until_ready(ConversationRef(id=conv.conv_id))

    assert outcome == ReadyOutcome()


@pytest.mark.asyncio
async def test_wait_until_ready_failure() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.ready = False
    conv.failure_reason = "clone_failed"
    conv.failure_message = "could not clone the repo"
    app = create_fake_worker_app(state)
    async with _make_backend(app, readiness_poll_interval_s=0.01) as backend:
        outcome = await backend.wait_until_ready(ConversationRef(id=conv.conv_id))

    assert outcome == FailedOutcome(reason="clone_failed", message="could not clone the repo")


@pytest.mark.asyncio
async def test_wait_until_ready_never_ready_times_out() -> None:
    state = FakeWorkerState()
    conv = state.create_conversation("preamble", None)
    conv.ready = False
    app = create_fake_worker_app(state)
    async with _make_backend(
        app, readiness_timeout_s=0.1, readiness_poll_interval_s=0.02
    ) as backend:
        outcome = await backend.wait_until_ready(ConversationRef(id=conv.conv_id))

    assert isinstance(outcome, FailedOutcome)
    assert outcome.reason == "timeout"


# ---------------------------------------------------------------------------
# get_chain
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_chain_raises_never_called_in_practice() -> None:
    """`routes_chat.py` only calls this when `supports_handover_chains` is
    True, which it never is for this backend — exercised directly here just
    to confirm it fails loudly rather than silently, matching the protocol's
    own documented allowance ("raising is fine")."""
    backend = AnthropicAIBackend()
    with pytest.raises(AIBackendError):
        await backend.get_chain(ConversationRef(id="whatever"))


# ---------------------------------------------------------------------------
# get_budget_status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_budget_status_parses_the_response() -> None:
    state = FakeWorkerState(month_to_date_usd=12.5, monthly_budget_usd=40.0)
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        status = await backend.get_budget_status()

    assert status.month_to_date_usd == 12.5
    assert status.monthly_budget_usd == 40.0


@pytest.mark.asyncio
async def test_get_budget_status_non_200_raises() -> None:
    state = FakeWorkerState(budget_status_code=500)
    app = create_fake_worker_app(state)
    async with _make_backend(app) as backend:
        with pytest.raises(AIBackendError):
            await backend.get_budget_status()


# ---------------------------------------------------------------------------
# Connect-error retry behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_refused_retries_then_raises_structured_error() -> None:
    closed_port = _reserve_closed_port()
    backend = AnthropicAIBackend(
        worker_base_url=f"http://127.0.0.1:{closed_port}", timeout_s=2.0, max_attempts=2
    )
    async with backend:
        with pytest.raises(AIBackendError, match="failed after 2 attempts"):
            await backend.create_conversation("preamble", None)
