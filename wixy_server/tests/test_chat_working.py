"""`wixy_server.chat_working.WorkingCache` (decisions/00097, 00099, 00100) —
the conversation LIST's "is this actively working" signal, TTL-cached per
conversation. cmd's own `activity` field is an ENUM string ("active" | "idle"
| "done" | "unknown"), never a timestamp (decisions/00099) — every fixture
below sets it to one of those literal strings, matching what the real
`/sessions/<id>/status` endpoint actually returns (decisions/00100 corrected
an intermediate version of this module/these fixtures that used "working" as
the active-literal — a guess from spec prose, never confirmed against real
cmd; the true value is "active").
"""

from __future__ import annotations

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


def _conv(conv_id: str, session_id: str) -> ChatConversation:
    return ChatConversation(
        conv_id=conv_id, session_id=session_id, title="t", created_at="2026-07-10T00:00:00Z"
    )


class TestActivityState:
    @pytest.mark.asyncio
    async def test_a_conversation_with_activity_active_is_working(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = "active"
        conv = _conv("c1", session.session_id)

        result = await WorkingCache().working_for(ai_backend, [conv])

        assert result == {"c1": True}

    @pytest.mark.asyncio
    async def test_a_conversation_with_activity_idle_is_not_working(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = "idle"
        conv = _conv("c1", session.session_id)

        result = await WorkingCache().working_for(ai_backend, [conv])

        assert result == {"c1": False}

    @pytest.mark.asyncio
    async def test_a_conversation_with_activity_done_is_not_working(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = "done"
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
        working_session.status["activity"] = "active"
        idle_session = fake_cmd_state.create_session("hi")
        idle_session.status["activity"] = "idle"

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
        session.status["activity"] = "active"
        conv = _conv("c1", session.session_id)
        cache = WorkingCache()

        first = await cache.working_for(ai_backend, [conv])
        session.status["activity"] = "idle"
        second = await cache.working_for(ai_backend, [conv])

        assert first == {"c1": True}
        assert second == {"c1": True}  # stale cache, not re-fetched

    @pytest.mark.asyncio
    async def test_an_unseen_conversation_is_always_fetched(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        cache = WorkingCache()
        session_a = fake_cmd_state.create_session("hi")
        session_a.status["activity"] = "active"
        await cache.working_for(ai_backend, [_conv("a", session_a.session_id)])

        session_b = fake_cmd_state.create_session("hi")
        session_b.status["activity"] = "active"
        result = await cache.working_for(
            ai_backend, [_conv("a", session_a.session_id), _conv("b", session_b.session_id)]
        )

        assert result == {"a": True, "b": True}


class TestCachedWorkingFor:
    """`cached_working_for` — the read-only twin `/api/admin/state` calls
    (decisions/00097 addendum): it must never await or touch cmd, only
    relay whatever `working_for` last cached."""

    def test_a_never_checked_conversation_reads_false(self) -> None:
        """No `working_for` call has ever populated the cache for this
        conversation -- and this test passes no `AIBackend` and runs no
        event loop at all, proving `cached_working_for` really can't be
        awaiting or reaching for cmd."""
        result = WorkingCache().cached_working_for([_conv("c1", "s1")])

        assert result == {"c1": False}

    def test_multiple_never_checked_conversations_all_default_false(self) -> None:
        result = WorkingCache().cached_working_for([_conv("a", "s1"), _conv("b", "s2")])

        assert result == {"a": False, "b": False}

    @pytest.mark.asyncio
    async def test_relays_whatever_working_for_last_cached_without_rechecking(
        self, fake_cmd_state: FakeCmdState, ai_backend: AIBackend
    ) -> None:
        """Once `working_for` has populated an entry, `cached_working_for`
        relays that exact cached value even after the underlying cmd
        session's activity has since gone idle -- proving it never
        triggers a fresh check of its own (the whole reason `/api/admin/
        state` calls this one and not `working_for`, per `chat_working.py`'s
        module docstring)."""
        session = fake_cmd_state.create_session("hi")
        session.status["activity"] = "active"
        conv = _conv("c1", session.session_id)
        cache = WorkingCache()
        await cache.working_for(ai_backend, [conv])

        session.status["activity"] = "idle"

        assert cache.cached_working_for([conv]) == {"c1": True}
