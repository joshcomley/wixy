"""Unit tests for `wixy_server.cmdchat` against the fake cmd double (spec/06 §4).

Plain-HTTP behavior is tested via `httpx.ASGITransport` (fast, hermetic, no real
socket). The `/ws/chat-pending` websocket needs a genuine socket (ASGI transports
can't do the upgrade), so those tests use `fake_cmd.FakeCmdServer` — a real uvicorn
instance on an ephemeral port, torn down at the end of each such test.

Every ASGITransport-based test injects `ws_connect=_ws_connect_always_fails` rather
than leaving `CmdChatClient`'s default websocket connector in place — the default
points at a real `ws://127.0.0.1:9320/...` URL, and this box may have a REAL cmd
instance listening there (this test suite runs inside one), so leaving it
unpatched would make these "hermetic" tests silently depend on host state.
"""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import NoReturn

import anyio
import httpx
import pytest
from fastapi import FastAPI

from wixy_server.cmdchat import (
    CmdChatClient,
    CmdChatError,
    FailedOutcome,
    ReadyOutcome,
    WsConnector,
)
from wixy_server.tests.fake_cmd import FakeCmdServer, FakeCmdState, create_fake_cmd_app


@asynccontextmanager
async def _ws_connect_always_fails() -> AsyncIterator[NoReturn]:
    raise ConnectionRefusedError("fake: no websocket server listening")
    yield  # pragma: no cover -- unreachable; @asynccontextmanager requires a generator


def _make_client(
    app: FastAPI,
    *,
    readiness_timeout_s: float = 5.0,
    readiness_poll_interval_s: float = 0.02,
    ws_connect: WsConnector | None = None,
    max_attempts: int = 3,
    timeout_s: float = 10.0,
) -> CmdChatClient:
    return CmdChatClient(
        transport=httpx.ASGITransport(app=app),
        readiness_timeout_s=readiness_timeout_s,
        readiness_poll_interval_s=readiness_poll_interval_s,
        ws_connect=ws_connect if ws_connect is not None else _ws_connect_always_fails,
        max_attempts=max_attempts,
        timeout_s=timeout_s,
    )


def _reserve_closed_port() -> int:
    """A port number that's free right now (nothing listens there) — binding then
    immediately closing is the standard trick; the caller then targets this port
    to deterministically trigger a connection-refused error."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


# ---------------------------------------------------------------------------
# Lifecycle: new-chat, session readiness (polling only), chain
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_chat_returns_session() -> None:
    state = FakeCmdState()
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        result = await client.new_chat("cottage-aesthetics-preview", "hello there")

    assert result.session_id in state.sessions
    assert state.sessions[result.session_id].prompt == "hello there"
    assert result.pending_state == "queued"
    assert result.workspace_id is not None


@pytest.mark.asyncio
async def test_new_chat_unexpected_status_raises() -> None:
    state = FakeCmdState()
    state.new_chat_status_code = 500
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        with pytest.raises(CmdChatError):
            await client.new_chat("cottage-aesthetics-preview", "hello")


@pytest.mark.asyncio
async def test_wait_until_ready_immediate() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.ready = True
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        outcome = await client.wait_until_ready(session.session_id)

    assert outcome == ReadyOutcome()


@pytest.mark.asyncio
async def test_wait_until_ready_after_several_polls() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.ready_after_polls = 4
    app = create_fake_cmd_app(state)
    async with _make_client(app, readiness_poll_interval_s=0.01) as client:
        outcome = await client.wait_until_ready(session.session_id)

    assert outcome == ReadyOutcome()
    assert session.poll_count >= 4


@pytest.mark.asyncio
async def test_wait_until_ready_never_ready_times_out() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")  # never marked ready
    app = create_fake_cmd_app(state)
    async with _make_client(
        app, readiness_timeout_s=0.1, readiness_poll_interval_s=0.02
    ) as client:
        outcome = await client.wait_until_ready(session.session_id)

    assert isinstance(outcome, FailedOutcome)
    assert outcome.reason == "timeout"


@pytest.mark.asyncio
async def test_get_chain_defaults_to_single_element() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        chain = await client.get_chain(session.session_id)

    assert chain == [session.session_id]


@pytest.mark.asyncio
async def test_get_chain_follows_handover() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.chain = [session.session_id, "sess-successor"]
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        chain = await client.get_chain(session.session_id)

    assert chain[-1] == "sess-successor"


# ---------------------------------------------------------------------------
# Send
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_message_accepted() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        result = await client.send_message(session.session_id, "do the thing", "conv1:msg1")

    assert result.buffered is False
    assert session.idempotency_seen["conv1:msg1"] == 1


@pytest.mark.asyncio
async def test_send_message_buffered_while_provisioning() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.send_buffered = True
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        result = await client.send_message(session.session_id, "do the thing", "conv1:msg1")

    assert result.buffered is True


@pytest.mark.asyncio
async def test_send_message_5xx_raises_structured_error() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.send_status_code = 502
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        with pytest.raises(CmdChatError):
            await client.send_message(session.session_id, "do the thing", "conv1:msg1")


# ---------------------------------------------------------------------------
# Messages + status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_messages_decodes_and_paginates() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.messages = [
        {
            "index": i,
            "role": "assistant" if i % 2 else "user",
            "kind": "text",
            "text": f"message {i}",
            "timestamp": f"2026-07-10T00:00:0{i}Z",
            "tool_name": None,
            "truncated": False,
        }
        for i in range(5)
    ]
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        all_messages = await client.get_messages(session.session_id)
        older = await client.get_messages(session.session_id, before=3)

    assert [m.index for m in all_messages] == [0, 1, 2, 3, 4]
    assert [m.index for m in older] == [0, 1, 2]
    assert all_messages[0].text == "message 0"


@pytest.mark.asyncio
async def test_get_messages_skips_malformed_entries() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.messages = [
        {"index": 0, "role": "user", "kind": "text", "text": "ok", "timestamp": "t"},
        {"index": "not-an-int", "role": "user", "kind": "text", "timestamp": "t"},  # malformed
        {"role": "user"},  # missing required fields
    ]
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        messages = await client.get_messages(session.session_id)

    assert len(messages) == 1
    assert messages[0].index == 0


@pytest.mark.asyncio
async def test_get_status_prefers_activity_and_defaults_missing_fields() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.status = {"activity": "2026-07-10T00:00:00Z", "process": {"kind": "none"}}
    app = create_fake_cmd_app(state)
    async with _make_client(app) as client:
        status = await client.get_status(session.session_id)

    assert status.activity == "2026-07-10T00:00:00Z"
    assert status.process_kind == "none"
    assert status.handover_state is None


# ---------------------------------------------------------------------------
# Connect-error retry behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_refused_retries_then_raises_structured_error() -> None:
    closed_port = _reserve_closed_port()
    client = CmdChatClient(
        portal_base_url=f"http://127.0.0.1:{closed_port}",
        timeout_s=2.0,
        max_attempts=2,
        ws_connect=_ws_connect_always_fails,
    )
    async with client:
        with pytest.raises(CmdChatError, match="failed after 2 attempts"):
            await client.new_chat("cottage-aesthetics-preview", "hi")


@pytest.mark.asyncio
async def test_wait_until_ready_propagates_unreachable_cmd_distinctly() -> None:
    """A `CmdChatError` (cmd itself unreachable) must propagate out of
    `wait_until_ready` rather than being folded into a `FailedOutcome` — spec/06
    §3's offline banner ("cmd down") is a materially different UI state from a
    genuine `workspace_failed`/`cli_failed`/timeout."""
    closed_port = _reserve_closed_port()
    client = CmdChatClient(
        portal_base_url=f"http://127.0.0.1:{closed_port}",
        # A closed loopback port doesn't always get an instant RST on this host
        # (observed ~1-2s before httpx reports ConnectTimeout rather than a fast
        # ConnectError) -- generous enough to not be timing-flaky, still fast
        # enough for a unit test.
        timeout_s=3.0,
        max_attempts=1,
        readiness_timeout_s=10.0,
        readiness_poll_interval_s=0.05,
        ws_connect=_ws_connect_always_fails,
    )
    async with client:
        with pytest.raises(CmdChatError):
            await client.wait_until_ready("sess-1")


# ---------------------------------------------------------------------------
# Websocket (`/ws/chat-pending`) — needs a real socket, hence the real server
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_watch_pending_yields_transition_events() -> None:
    server = FakeCmdServer()
    port = server.start()
    try:
        client = CmdChatClient(portal_base_url=f"http://127.0.0.1:{port}", timeout_s=2.0)
        async with client:
            events = []

            async def _collect() -> None:
                async for event in client.watch_pending():
                    events.append(event)
                    return

            async with anyio.create_task_group() as tg:
                tg.start_soon(_collect)
                await anyio.to_thread.run_sync(server.wait_for_pending_subscriber)
                server.publish_pending_event(
                    {"session_id": "sess-1", "state": "workspace_failed", "message": "disk full"}
                )

            assert len(events) == 1
            assert events[0].session_id == "sess-1"
            assert events[0].state == "workspace_failed"
            assert events[0].message == "disk full"
    finally:
        server.stop()


@pytest.mark.asyncio
async def test_wait_until_ready_short_circuits_on_ws_failure_signal() -> None:
    """The websocket failure signal should win the race even though the session
    never becomes ready via polling — the whole point of subscribing at all
    (spec/06 §1: "For failure detail before the timeout...")."""
    state = FakeCmdState()
    session = state.create_session("hi")  # never marked ready
    server = FakeCmdServer(state)
    port = server.start()
    try:
        client = CmdChatClient(
            portal_base_url=f"http://127.0.0.1:{port}",
            timeout_s=2.0,
            readiness_timeout_s=30.0,  # would time out long before this if the WS didn't win
            readiness_poll_interval_s=0.05,
        )
        async with client:
            result_box: list[FailedOutcome] = []

            async def _run() -> None:
                outcome = await client.wait_until_ready(session.session_id)
                assert isinstance(outcome, FailedOutcome)
                result_box.append(outcome)

            async with anyio.create_task_group() as tg:
                tg.start_soon(_run)
                await anyio.to_thread.run_sync(server.wait_for_pending_subscriber)
                server.publish_pending_event(
                    {"session_id": session.session_id, "state": "cli_failed", "message": "boom"}
                )

            assert len(result_box) == 1
            assert result_box[0].reason == "cli_failed"
            assert result_box[0].message == "boom"
    finally:
        server.stop()


@pytest.mark.asyncio
async def test_wait_until_ready_ignores_ws_events_for_other_sessions() -> None:
    state = FakeCmdState()
    session = state.create_session("hi")
    session.ready_after_polls = 3
    server = FakeCmdServer(state)
    port = server.start()
    try:
        client = CmdChatClient(
            portal_base_url=f"http://127.0.0.1:{port}",
            timeout_s=2.0,
            readiness_timeout_s=5.0,
            readiness_poll_interval_s=0.02,
        )
        async with client:

            async def _run() -> None:
                await anyio.to_thread.run_sync(server.wait_for_pending_subscriber)
                server.publish_pending_event(
                    {"session_id": "some-other-session", "state": "workspace_failed"}
                )

            async with anyio.create_task_group() as tg:
                tg.start_soon(_run)
                outcome = await client.wait_until_ready(session.session_id)

            assert outcome == ReadyOutcome()
    finally:
        server.stop()
