"""`/api/admin/chat/conversations` (spec/06-ai-chat.md §1) — milestone 10 slices
2-3. `cmdchat.py`'s own transport/protocol behavior is covered by
`test_cmdchat.py`; this file tests the ROUTE layer (title derivation, prompt
construction, background readiness tracking, error mapping, `/state` wiring,
send, rename, and the SSE stream's poll->fan-out + handover-follow).
"""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import NoReturn

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient

from builder.jsontypes import JsonObject
from wixy_server.ai.backend import AIBackend, CmdAIBackend
from wixy_server.app import create_app
from wixy_server.chats import ChatConversation, ChatRuntimeEntry, add_chat, find_chat
from wixy_server.cmdchat import CmdChatClient
from wixy_server.routes_chat import StreamTiming, _stream_events
from wixy_server.storage import project_paths
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

_INDEX_HTML = """<!DOCTYPE html>
<html><head><title>placeholder</title></head>
<body>
<!-- wx:partial header -->
<h1 data-wx="hero.title">placeholder</h1>
<!-- wx:partial footer -->
<!-- wx:partial booking-modal -->
</body></html>
"""
_PARTIAL_HTML = "<body></body>\n"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _write_site_repo(repo_dir: Path) -> None:
    (repo_dir / "pages").mkdir(parents=True)
    (repo_dir / "partials").mkdir()
    (repo_dir / "content").mkdir()
    (repo_dir / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (repo_dir / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (repo_dir / "content" / "index.json").write_text(
        json.dumps({"meta": {"title": "Home"}, "hero": {"title": "Original"}}), encoding="utf-8"
    )
    (repo_dir / "content" / "_global.json").write_text("{}", encoding="utf-8")


def _write_project_registry(root: Path, repo: Path) -> None:
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "Test",
                "repo": str(repo),
                "defaultBranch": "main",
                "cmdProject": "cottage-aesthetics-preview",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    _write_site_repo(origin)
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    _write_project_registry(root, origin_repo)
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@asynccontextmanager
async def _ws_connect_always_fails() -> AsyncIterator[NoReturn]:
    raise ConnectionRefusedError("fake: no websocket server listening")
    yield  # pragma: no cover -- unreachable; @asynccontextmanager requires a generator


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    return FakeCmdState()


@pytest.fixture
def cmdchat_client(fake_cmd_state: FakeCmdState) -> CmdChatClient:
    app = create_fake_cmd_app(fake_cmd_state)
    return CmdChatClient(
        transport=httpx.ASGITransport(app=app),
        readiness_poll_interval_s=0.02,
        readiness_timeout_s=0.3,
        ws_connect=_ws_connect_always_fails,
    )


@pytest.fixture
def ai_backend(cmdchat_client: CmdChatClient) -> AIBackend:
    """spec/independence/05 §1's extraction — `_stream_events` (unlike
    `create_app`, which still accepts a bare `cmdchat_client` for backward
    compatibility, see `wixy_server.app`) takes an `AIBackend` directly, since
    tests below call it as a plain function, not through the app. `cmd_project`
    is irrelevant here: only `create_conversation` (a different route entirely)
    ever reads it."""
    return CmdAIBackend(cmdchat_client, cmd_project="")


@pytest.fixture
def fast_stream_timing() -> StreamTiming:
    """Spec's own production numbers (1.2s poll / 10s offline retry / 15s
    transcript-lag grace) would make every stream test take real minutes —
    shrunk here by three orders of magnitude so the exact same code paths run
    in milliseconds."""
    return StreamTiming(poll_interval_s=0.02, offline_retry_s=0.05, transcript_grace_s=0.1)


def _poll_until(
    predicate: Callable[[], bool], *, timeout_s: float = 3.0, interval_s: float = 0.02
) -> None:
    """Polls `predicate()` until it's true or `timeout_s` elapses — used to wait
    for the fire-and-forget readiness-tracking background task to actually
    finish, via a REAL repeated HTTP round-trip (not reaching into `app.state`),
    matching this whole chain's "verify for real" discipline."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval_s)
    raise AssertionError(f"condition not met within {timeout_s}s")


def _decode_sse_line(line: str) -> JsonObject:
    data: JsonObject = json.loads(line[len("data: ") :])
    return data


def _message_payload(event: JsonObject) -> JsonObject:
    """`event["message"]` narrowed from `JsonValue` to `JsonObject` — every
    `type: "message"` event's own shape guarantees this is a dict (see
    `routes_chat._message_event`); asserted, not just cast, so a genuine shape
    regression fails loudly here rather than at some more confusing later
    indexing site."""
    message = event["message"]
    assert isinstance(message, dict)
    return message


class TestCreateConversation:
    def test_without_first_message_uses_placeholder_title(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/chat/conversations", json={})

        assert response.status_code == 200
        body = response.json()
        assert body["title"] == "New conversation"
        assert body["status"] == "pending"
        assert "convId" in body
        assert "sessionId" not in body  # browser never needs cmd's own session id

    def test_with_first_message_titles_from_it(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations",
                json={"firstMessage": "Please update the hero title to something warmer"},
            )

        assert response.json()["title"] == "Please update the hero title to something warmer"

    def test_title_word_truncates_at_60_chars(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        long_message = (
            "Please could you go through every single page on the site and rewrite "
            "all of the copy to sound much more warm and welcoming for visitors"
        )
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations", json={"firstMessage": long_message}
            )

        title = response.json()["title"]
        assert len(title) <= 61  # 60 chars + the trailing ellipsis character
        assert title.endswith("…")
        prefix = title[:-1].rstrip()
        assert len(prefix) < len(long_message)  # genuinely shorter -- real truncation happened
        assert long_message.startswith(
            prefix
        )  # never cuts mid-word: a clean prefix of the original

    def test_prompt_sent_to_cmd_includes_preamble_and_first_message(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={"firstMessage": "make the hero pop"})

        session = next(iter(fake_cmd_state.sessions.values()))
        assert "Cottage Aesthetics" in session.prompt  # from the preamble template
        assert session.prompt.endswith("---\n\nmake the hero pop")

    def test_prompt_without_first_message_is_preamble_alone(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={})

        session = next(iter(fake_cmd_state.sessions.values()))
        assert "---" not in session.prompt
        assert "Cottage Aesthetics" in session.prompt

    def test_uses_cmd_project_from_registry_not_hardcoded(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        # `_write_project_registry` above sets cmdProject to
        # "cottage-aesthetics-preview" — asserting the fake app actually received
        # that exact slug (not e.g. the wixy-side "test" slug, or a hardcoded
        # value) proves the route reads the registry's own field.
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/chat/conversations", json={})

        assert response.status_code == 200
        session = next(iter(fake_cmd_state.sessions.values()))
        assert session.cmd_project == "cottage-aesthetics-preview"

    def test_cmd_unreachable_returns_502(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        fake_cmd_state.new_chat_status_code = 500
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/chat/conversations", json={})

        assert response.status_code == 502

    def test_persists_to_chats_json(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={"firstMessage": "hi"})

        paths = project_paths(storage_root, "test")
        data = json.loads(paths.chats_json.read_text(encoding="utf-8"))
        assert len(data["conversations"]) == 1
        assert data["conversations"][0]["title"] == "hi"


class TestListConversations:
    def test_empty_by_default(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/chat/conversations")

        assert response.status_code == 200
        assert response.json() == {"conversations": []}

    def test_newest_first(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={"firstMessage": "first"})
            client.post("/api/admin/chat/conversations", json={"firstMessage": "second"})
            response = client.get("/api/admin/chat/conversations")

        titles = [c["title"] for c in response.json()["conversations"]]
        assert titles == ["second", "first"]

    def test_transitions_to_ready_once_tracker_resolves(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            create_response = client.post(
                "/api/admin/chat/conversations", json={"firstMessage": "hi"}
            )
            assert create_response.json()["status"] == "pending"

            session = next(iter(fake_cmd_state.sessions.values()))
            session.ready_after_polls = 1

            def _is_ready() -> bool:
                listed = client.get("/api/admin/chat/conversations").json()["conversations"]
                return bool(listed) and listed[0]["status"] == "ready"

            _poll_until(_is_ready)

    def test_transitions_to_failed_with_reason_on_timeout(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={"firstMessage": "hi"})
            # never marked ready -- the fixture's 0.3s readiness_timeout_s will elapse

            def _is_failed() -> bool:
                listed = client.get("/api/admin/chat/conversations").json()["conversations"]
                return bool(listed) and listed[0]["status"] == "failed"

            _poll_until(_is_failed, timeout_s=3.0)
            listed = client.get("/api/admin/chat/conversations").json()["conversations"]
            assert listed[0]["failureReason"] == "timeout"


class TestStateChatsField:
    def test_state_reflects_created_conversations(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            created = client.post(
                "/api/admin/chat/conversations", json={"firstMessage": "hi"}
            ).json()
            state = client.get("/api/admin/state").json()

        assert len(state["chats"]) == 1
        assert state["chats"][0]["convId"] == created["convId"]
        assert state["chats"][0]["title"] == "hi"
        assert state["chats"][0]["status"] == "pending"


def _create(client: TestClient, first_message: str | None = None) -> dict[str, object]:
    body: dict[str, object] = {"firstMessage": first_message} if first_message else {}
    response = client.post("/api/admin/chat/conversations", json=body)
    assert response.status_code == 200
    result: dict[str, object] = response.json()
    return result


class TestSendMessage:
    def test_accepted_returns_buffered_flag(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
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

    def test_reflects_cmd_buffered_state(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            session = next(iter(fake_cmd_state.sessions.values()))
            session.send_buffered = True
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "still starting", "idempotencyKey": "conv1:msg1"},
            )

        assert response.json()["buffered"] is True

    def test_passes_idempotency_key_through_to_cmd(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "hello", "idempotencyKey": "conv1:msg1"},
            )
            client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "hello", "idempotencyKey": "conv1:msg1"},
            )

        session = next(iter(fake_cmd_state.sessions.values()))
        assert session.idempotency_seen["conv1:msg1"] == 2  # both attempts reached cmd unchanged

    def test_unknown_conversation_404s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations/does-not-exist/messages",
                json={"text": "hi", "idempotencyKey": "x:1"},
            )

        assert response.status_code == 404

    def test_cmd_5xx_returns_502(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            session = next(iter(fake_cmd_state.sessions.values()))
            session.send_status_code = 502
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={"text": "hello", "idempotencyKey": "conv1:msg2"},
            )

        assert response.status_code == 502


class TestRenameConversation:
    def test_updates_title(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "original")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/rename",
                json={"title": "renamed by owner"},
            )
            listed = client.get("/api/admin/chat/conversations").json()["conversations"]

        assert response.status_code == 200
        assert response.json()["title"] == "renamed by owner"
        assert listed[0]["title"] == "renamed by owner"

    def test_unknown_conversation_404s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations/does-not-exist/rename", json={"title": "x"}
            )

        assert response.status_code == 404


def _fake_message(
    index: int, *, role: str = "assistant", text: str = "hello", truncated: bool = False
) -> JsonObject:
    return {
        "index": index,
        "role": role,
        "kind": "text",
        "text": text,
        "timestamp": "2026-07-10T00:00:00Z",
        "tool_name": None,
        "truncated": truncated,
    }


def _seed_conversation(chats_path: Path, session_id: str, conv_id: str = "conv-1") -> str:
    add_chat(
        chats_path,
        ChatConversation(
            conv_id=conv_id, session_id=session_id, title="hi", created_at="2026-07-10T00:00:00Z"
        ),
    )
    return conv_id


async def _collect_stream_events(
    generator: AsyncGenerator[str], *, count: int | None = None, timeout_s: float = 5.0
) -> list[JsonObject]:
    """Drives `_stream_events` directly (see the module docstring above this
    class for why: `TestClient`'s synchronous streaming can't observe an
    infinite generator — its portal-thread transport drains the whole
    response before returning control, so it hangs forever on anything that
    doesn't terminate on its own). `count=None` collects until the generator
    ends naturally (the failure/timeout case); otherwise stops after `count`
    events. Always closes the generator afterward, cancelling whatever
    `await anyio.sleep(...)` it's suspended at."""
    events: list[JsonObject] = []
    try:
        with anyio.fail_after(timeout_s):
            async for payload in generator:
                events.append(_decode_sse_line(payload))
                if count is not None and len(events) >= count:
                    break
    finally:
        await generator.aclose()
    return events


class TestConversationStream:
    """`TestClient` can't be used here (see `_collect_stream_events`'s own
    docstring) — every test below except the plain-404 one drives
    `routes_chat._stream_events` directly as an async generator, which is
    both the only thing that actually works AND a more precisely-targeted
    unit test than going through HTTP/ASGI plumbing that adds nothing to what
    this function's own logic needs verified."""

    def test_unknown_conversation_404s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/chat/conversations/does-not-exist/stream")

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delivers_pre_existing_messages(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [_fake_message(0, text="first"), _fake_message(1, text="second")]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=2)

        message_events = [e for e in events if e["type"] == "message"]
        assert [_message_payload(e)["text"] for e in message_events] == ["first", "second"]

    @pytest.mark.asyncio
    async def test_hides_thinking_messages_by_default_but_includes_when_asked(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """spec/06 §1: "thinking hidden behind a 'show reasoning' toggle
        default-off... lazily fetched with include_thinking=true only when the
        toggle opens." """
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(0, role="assistant", text="reasoning...", truncated=False)
            | {"kind": "thinking"},
            _fake_message(1, text="the actual reply"),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)

        hidden_gen = _stream_events(
            ai_backend,
            chats_path,
            {},
            conv_id,
            session.session_id,
            fast_stream_timing,
            include_thinking=False,
        )
        hidden_events = await _collect_stream_events(hidden_gen, count=1)
        hidden_messages = [e for e in hidden_events if e["type"] == "message"]
        assert [_message_payload(e)["index"] for e in hidden_messages] == [1]

        shown_gen = _stream_events(
            ai_backend,
            chats_path,
            {},
            conv_id,
            session.session_id,
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
    async def test_delivers_messages_appended_after_connecting(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        try:
            with anyio.fail_after(5.0):
                # The first tick yields only a status event (no messages exist
                # yet); consuming it positions the generator to see what's
                # appended next.
                first = _decode_sse_line(await anext(gen))
                session.messages = [_fake_message(0, text="appended live")]
                second = _decode_sse_line(await anext(gen))
        finally:
            await gen.aclose()

        assert first["type"] == "status"
        assert second["type"] == "message"
        assert _message_payload(second)["text"] == "appended live"

    @pytest.mark.asyncio
    async def test_resends_a_message_whose_content_later_changes(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """A `truncated: true` preview later arriving in full (same index, new
        content) must be re-sent — a bare "index > last seen" filter would miss
        this (decisions/00033)."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [_fake_message(0, text="partial...", truncated=True)]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        try:
            with anyio.fail_after(5.0):
                # The first tick fetches messages ONCE and can yield more than
                # one event from that single snapshot (the message, then the
                # status event, since status also differs from the initial
                # `None`) — both must be drained before mutating, or the
                # mutation lands mid-tick and the second `anext()` just
                # observes the FIRST tick's own trailing status event instead
                # of a fresh fetch.
                first_event = _decode_sse_line(await anext(gen))
                second_event = _decode_sse_line(await anext(gen))
                session.messages = [_fake_message(0, text="the full message", truncated=False)]
                third_event = _decode_sse_line(await anext(gen))
        finally:
            await gen.aclose()

        assert first_event["type"] == "message"
        assert _message_payload(first_event)["text"] == "partial..."
        assert _message_payload(first_event)["truncated"] is True
        assert second_event["type"] == "status"
        assert third_event["type"] == "message"
        assert _message_payload(third_event)["index"] == 0
        assert _message_payload(third_event)["text"] == "the full message"
        assert _message_payload(third_event)["truncated"] is False

    @pytest.mark.asyncio
    async def test_waits_out_pending_then_delivers(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {conv_id: ChatRuntimeEntry(status="pending")}

        async def _resolve_shortly() -> None:
            await anyio.sleep(0.05)
            runtime[conv_id] = ChatRuntimeEntry(status="ready")

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events: list[JsonObject] = []
        async with anyio.create_task_group() as tg:
            tg.start_soon(_resolve_shortly)
            events = await _collect_stream_events(gen, count=1, timeout_s=5.0)

        assert events[0]["type"] == "status"

    @pytest.mark.asyncio
    async def test_reports_failure_and_closes_when_provisioning_failed(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")  # never marked ready
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {
            conv_id: ChatRuntimeEntry(
                status="failed", failure_reason="timeout", failure_message="timed out"
            )
        }

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen)  # no count: collect until it naturally ends

        assert len(events) == 1
        assert events[0]["type"] == "error"

    @pytest.mark.asyncio
    async def test_follows_handover_to_the_new_session(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        old_session = fake_cmd_state.create_session("hi")
        old_session.ready = True
        old_session.status = {
            "activity": None,
            "process": {"kind": "cli"},
            "handover_state": "handed_over",
        }
        old_session.chain = [old_session.session_id, "sess-successor"]
        new_session = fake_cmd_state.create_session("(handover successor)")
        auto_assigned_id = new_session.session_id
        new_session.session_id = "sess-successor"  # force the id the chain names
        del fake_cmd_state.sessions[auto_assigned_id]
        fake_cmd_state.sessions["sess-successor"] = new_session
        new_session.ready = True
        new_session.messages = [_fake_message(0, text="continuing after handover")]

        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, old_session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        # The old session's handover-detecting tick adopts the new id and
        # `continue`s WITHOUT yielding anything that iteration (see
        # `_stream_events`); the new session's own first tick then yields
        # exactly one message event + one status event (status differs from
        # the reset `None` baseline exactly once) — 2 events total, not more,
        # since nothing else changes after that.
        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, old_session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=2)

        stored = find_chat(chats_path, conv_id)

        message_events = [e for e in events if e["type"] == "message"]
        assert any(
            _message_payload(e)["text"] == "continuing after handover" for e in message_events
        )
        assert stored is not None
        assert stored.session_id == "sess-successor"
