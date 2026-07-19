"""Backend-contract coverage (spec/independence/05 §4: "Backend-contract test
suite runs against BOTH: the fake cmd server AND a fake Agent-SDK harness").

`test_routes_chat.py`'s own suite exercises `wixy_server.routes_chat`
exclusively against `CmdAIBackend` + the fake cmd server. Reading
`routes_chat.py` itself shows it has NO backend-specific branching anywhere
except one spot (`client.supports_handover_chains`, gating the
handover-chain-follow logic) — every other route just calls the shared
`AIBackend` protocol generically. So this file's job isn't to duplicate
`test_routes_chat.py` wholesale; it's to prove the CORE route-layer contract
— create → pending/ready → send → stream reflects messages → unknown
conversation 404s → a backend error 502s — ALSO holds when
`AnthropicAIBackend` + the fake worker double is plugged in instead, plus
one test proving `supports_handover_chains=False` is handled safely (not
duplicating the SAME behavior, but the CORRECT divergent one). Cmd-specific
edge cases with no anthropic analog (title-truncation string logic, the
cmd-project-registry lookup, handover-chain FOLLOWING itself) stay only in
`test_routes_chat.py` — they either don't touch backend selection at all or
genuinely don't apply here.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator, Callable
from pathlib import Path

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient

from builder.jsontypes import JsonObject
from wixy_server.ai.anthropic_backend import AnthropicAIBackend
from wixy_server.app import create_app
from wixy_server.chats import ChatConversation, add_chat
from wixy_server.routes_chat import StreamTiming, _stream_events
from wixy_server.tests.fake_worker import FakeWorkerState, create_fake_worker_app


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def wixy_repo_root(tmp_path: Path) -> Path:
    # These tests never touch the site checkout at all (routes_chat.py's
    # chat routes don't read it) — a minimal registry is enough for
    # create_app's own "exactly one project" assertion to pass.
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "Test",
                "repo": "https://example.invalid/x.git",
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def fake_worker_state() -> FakeWorkerState:
    return FakeWorkerState()


@pytest.fixture
def anthropic_backend(fake_worker_state: FakeWorkerState) -> AnthropicAIBackend:
    app = create_fake_worker_app(fake_worker_state)
    return AnthropicAIBackend(
        transport=httpx.ASGITransport(app=app),
        readiness_poll_interval_s=0.02,
        readiness_timeout_s=0.3,
    )


@pytest.fixture
def fast_stream_timing() -> StreamTiming:
    return StreamTiming(poll_interval_s=0.02, offline_retry_s=0.05, transcript_grace_s=0.1)


def _poll_until(
    predicate: Callable[[], bool], *, timeout_s: float = 3.0, interval_s: float = 0.02
) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval_s)
    raise AssertionError(f"condition not met within {timeout_s}s")


def _create(client: TestClient, first_message: str | None = None) -> dict[str, object]:
    body: dict[str, object] = {"firstMessage": first_message} if first_message else {}
    response = client.post("/api/admin/chat/conversations", json=body)
    assert response.status_code == 200
    result: dict[str, object] = response.json()
    return result


def _worker_message(
    index: int, *, role: str = "assistant", text: str = "hello", kind: str = "text"
) -> JsonObject:
    """`WorkerMessage.to_json()`'s own wire shape — camelCase `toolName`,
    distinct from cmd's `_fake_message` (`test_routes_chat.py`), which uses
    cmd's own snake_case `tool_name`."""
    return {
        "index": index,
        "role": role,
        "kind": kind,
        "text": text,
        "timestamp": "2026-07-10T00:00:00Z",
        "toolName": None,
        "truncated": False,
    }


def _seed_conversation(chats_path: Path, session_id: str, conv_id: str = "conv-1") -> str:
    add_chat(
        chats_path,
        ChatConversation(
            conv_id=conv_id, session_id=session_id, title="hi", created_at="2026-07-10T00:00:00Z"
        ),
    )
    return conv_id


def _decode_sse_line(line: str) -> JsonObject:
    data: JsonObject = json.loads(line[len("data: ") :])
    return data


def _message_payload(event: JsonObject) -> JsonObject:
    message = event["message"]
    assert isinstance(message, dict)
    return message


async def _collect_stream_events(
    generator: AsyncGenerator[str], *, count: int, timeout_s: float = 5.0
) -> list[JsonObject]:
    events: list[JsonObject] = []
    try:
        with anyio.fail_after(timeout_s):
            async for payload in generator:
                events.append(_decode_sse_line(payload))
                if len(events) >= count:
                    break
    finally:
        await generator.aclose()
    return events


class TestCreateConversation:
    def test_without_first_message_uses_placeholder_title(
        self, storage_root: Path, wixy_repo_root: Path, anthropic_backend: AnthropicAIBackend
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/chat/conversations", json={})

        assert response.status_code == 200
        body = response.json()
        assert body["title"] == "New conversation"
        assert body["status"] == "pending"
        assert "convId" in body

    def test_with_first_message_titles_from_it(
        self, storage_root: Path, wixy_repo_root: Path, anthropic_backend: AnthropicAIBackend
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations",
                json={"firstMessage": "Please update the hero title to something warmer"},
            )

        assert response.json()["title"] == "Please update the hero title to something warmer"

    def test_becomes_ready_once_the_worker_reports_it(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            worker_conv = next(iter(fake_worker_state.conversations.values()))
            worker_conv.ready = True

            def _is_ready() -> bool:
                # /api/admin/chat/conversations, not /api/admin/state -- the
                # latter also needs a real, successfully-cloned site checkout
                # (this fixture's repo URL is deliberately unreachable, these
                # tests never touch the site checkout at all otherwise).
                listed = client.get("/api/admin/chat/conversations").json()["conversations"]
                return (
                    bool(listed)
                    and listed[0]["convId"] == conv["convId"]
                    and (listed[0]["status"] == "ready")
                )

            _poll_until(_is_ready)

    def test_worker_unreachable_returns_502(self, storage_root: Path, wixy_repo_root: Path) -> None:
        unreachable = AnthropicAIBackend(
            worker_base_url="http://127.0.0.1:1", timeout_s=0.5, max_attempts=1
        )
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=unreachable
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/chat/conversations", json={})

        assert response.status_code == 502


class TestSendMessage:
    def test_accepted_returns_buffered_flag(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "do the thing", "idempotencyKey": "conv1:msg1"},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["accepted"] is True
        assert body["buffered"] is False

    def test_reflects_worker_buffered_state(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            worker_conv = next(iter(fake_worker_state.conversations.values()))
            worker_conv.send_buffered = True
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "still starting", "idempotencyKey": "conv1:msg1"},
            )

        assert response.json()["buffered"] is True

    def test_passes_idempotency_key_through_to_the_worker(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            for _ in range(2):
                client.post(
                    f"/api/admin/chat/conversations/{conv['convId']}/messages",
                    json={"text": "hello", "idempotencyKey": "conv1:msg1"},
                )

        worker_conv = next(iter(fake_worker_state.conversations.values()))
        assert worker_conv.idempotency_seen["conv1:msg1"] == 2

    def test_unknown_conversation_404s(
        self, storage_root: Path, wixy_repo_root: Path, anthropic_backend: AnthropicAIBackend
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations/does-not-exist/messages",
                json={"text": "hi", "idempotencyKey": "x:1"},
            )

        assert response.status_code == 404

    def test_worker_5xx_returns_502(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            worker_conv = next(iter(fake_worker_state.conversations.values()))
            worker_conv.send_status_code = 500
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "hello", "idempotencyKey": "conv1:msg2"},
            )

        assert response.status_code == 502


class TestConversationStream:
    def test_unknown_conversation_404s(
        self, storage_root: Path, wixy_repo_root: Path, anthropic_backend: AnthropicAIBackend
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=anthropic_backend
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/chat/conversations/does-not-exist/stream")

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delivers_pre_existing_messages(
        self,
        tmp_path: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        conv = fake_worker_state.create_conversation("hi", None)
        conv.ready = True
        conv.messages = [_worker_message(0, text="first"), _worker_message(1, text="second")]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, conv.conv_id)

        gen = _stream_events(
            anthropic_backend, chats_path, {}, conv_id, conv.conv_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=2)

        message_events = [e for e in events if e["type"] == "message"]
        assert [_message_payload(e)["text"] for e in message_events] == ["first", "second"]

    @pytest.mark.asyncio
    async def test_hides_thinking_messages_by_default_but_includes_when_asked(
        self,
        tmp_path: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        conv = fake_worker_state.create_conversation("hi", None)
        conv.ready = True
        conv.messages = [
            _worker_message(0, text="reasoning...", kind="thinking"),
            _worker_message(1, text="the actual reply"),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, conv.conv_id)

        hidden_gen = _stream_events(
            anthropic_backend,
            chats_path,
            {},
            conv_id,
            conv.conv_id,
            fast_stream_timing,
            include_thinking=False,
        )
        hidden_events = await _collect_stream_events(hidden_gen, count=1)
        hidden_messages = [e for e in hidden_events if e["type"] == "message"]
        assert [_message_payload(e)["index"] for e in hidden_messages] == [1]

        shown_gen = _stream_events(
            anthropic_backend,
            chats_path,
            {},
            conv_id,
            conv.conv_id,
            fast_stream_timing,
            include_thinking=True,
        )
        shown_events = await _collect_stream_events(shown_gen, count=2)
        shown_messages = [e for e in shown_events if e["type"] == "message"]
        shown_indices: list[int] = []
        for shown_event in shown_messages:
            index = _message_payload(shown_event)["index"]
            assert isinstance(index, int)
            shown_indices.append(index)
        assert sorted(shown_indices) == [0, 1]

    @pytest.mark.asyncio
    async def test_supports_handover_chains_false_never_follows_a_chain(
        self,
        tmp_path: Path,
        anthropic_backend: AnthropicAIBackend,
        fake_worker_state: FakeWorkerState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """The one spot `routes_chat.py` DOES branch on backend type
        (`client.supports_handover_chains`) — proving the anthropic backend's
        divergent (not identical) contract: no handover-chain concept at all
        (`AnthropicAIBackend.get_chain` would raise if ever called), so the
        stream must never attempt to call it, and `handoverState` must stay
        `None` regardless of what the worker's own status reports."""
        conv = fake_worker_state.create_conversation("hi", None)
        conv.ready = True
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, conv.conv_id)

        gen = _stream_events(
            anthropic_backend, chats_path, {}, conv_id, conv.conv_id, fast_stream_timing
        )
        try:
            with anyio.fail_after(5.0):
                first = _decode_sse_line(await anext(gen))
                while first["type"] != "status":
                    first = _decode_sse_line(await anext(gen))
        finally:
            await gen.aclose()

        status_payload = first["status"]
        assert isinstance(status_payload, dict)
        assert status_payload["handoverState"] is None
