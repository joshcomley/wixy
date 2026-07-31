"""`wixy_server.chat_working.WorkingCache` (decisions/00097) — the conversation
LIST's "is this actively working" signal, TTL-cached per conversation.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from wixy_server.ai.backend import AIBackend, CmdAIBackend
from wixy_server.chat_working import WorkingCache
from wixy_server.chats import ChatConversation
from wixy_server.cmdchat import CmdChatClient
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    return FakeCmdState()


@pytest.fixture
def ai_backend(fake_cmd_state: FakeCmdState) -> AIBackend:
    app = create_fake_cmd_app(fake_cmd_state)
    client = CmdChatClient(transport=httpx.ASGITransport(app=app))
    return CmdAIBackend(client, cmd_project="")


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _conv(conv_id: str, session_id: str) -> ChatConversation:
    return ChatConversation(
        conv_id=conv_id, session_id=session_id, title="t", created_at="2026-07-10T00:00:00Z"
    )


class TestFreshness:
    @pytest.mark.asyncio
    async def test_a_conversation_with_fresh_activity_is_working(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = _iso(datetime.now(UTC))
        conv = _conv("c1", session.session_id)

        result = await WorkingCache().working_for(ai_backend, [conv])

        assert result == {"c1": True}

    @pytest.mark.asyncio
    async def test_a_conversation_with_stale_activity_is_not_working(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = _iso(datetime.now(UTC) - timedelta(seconds=60))
        conv = _conv("c1", session.session_id)

        result = await WorkingCache().working_for(ai_backend, [conv])

        assert result == {"c1": False}

    @pytest.mark.asyncio
    async def test_no_activity_at_all_is_not_working(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        conv = _conv("c1", session.session_id)

        result = await WorkingCache().working_for(ai_backend, [conv])

        assert result == {"c1": False}

    @pytest.mark.asyncio
    async def test_cmd_unreachable_reads_as_not_working_not_an_error(
        self, ai_backend: AIBackend
    ) -> None:
        # No session created — the fake 404s any status() call, which
        # cmdchat.py surfaces as a CmdChatError (an AIBackendError).
        conv = _conv("c1", "no-such-session")

        result = await WorkingCache().working_for(ai_backend, [conv])

        assert result == {"c1": False}

    @pytest.mark.asyncio
    async def test_multiple_conversations_are_resolved_independently(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        working_session = fake_cmd_state.create_session("hi")
        working_session.status["activity"] = _iso(datetime.now(UTC))
        idle_session = fake_cmd_state.create_session("hi")
        idle_session.status["activity"] = _iso(datetime.now(UTC) - timedelta(minutes=5))

        result = await WorkingCache().working_for(
            ai_backend,
            [_conv("working", working_session.session_id), _conv("idle", idle_session.session_id)],
        )

        assert result == {"working": True, "idle": False}


class TestCaching:
    @pytest.mark.asyncio
    async def test_a_cached_entry_is_not_refreshed_within_the_ttl(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        """The whole point of the cache: a second call within the TTL must not
        re-hit cmd, even though the underlying status has since changed —
        proving the cached value (not a fresh fetch) is what's returned."""
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = _iso(datetime.now(UTC))
        conv = _conv("c1", session.session_id)
        cache = WorkingCache()

        first = await cache.working_for(ai_backend, [conv])
        session.status["activity"] = _iso(datetime.now(UTC) - timedelta(minutes=5))
        second = await cache.working_for(ai_backend, [conv])

        assert first == {"c1": True}
        assert second == {"c1": True}  # stale cache, not re-fetched

    @pytest.mark.asyncio
    async def test_an_unseen_conversation_is_always_fetched(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        cache = WorkingCache()
        session_a = fake_cmd_state.create_session("hi")
        session_a.status["activity"] = _iso(datetime.now(UTC))
        await cache.working_for(ai_backend, [_conv("a", session_a.session_id)])

        session_b = fake_cmd_state.create_session("hi")
        session_b.status["activity"] = _iso(datetime.now(UTC))
        result = await cache.working_for(
            ai_backend, [_conv("a", session_a.session_id), _conv("b", session_b.session_id)]
        )

        assert result == {"a": True, "b": True}
