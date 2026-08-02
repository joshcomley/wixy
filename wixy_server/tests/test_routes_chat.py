"""`/api/admin/chat/conversations` (spec/06-ai-chat.md §1) — milestone 10 slices
2-3. `cmdchat.py`'s own transport/protocol behavior is covered by
`test_cmdchat.py`; this file tests the ROUTE layer (title derivation, prompt
construction, background readiness tracking, error mapping, `/state` wiring,
send, rename, and the SSE stream's poll->fan-out + handover-follow).
"""

from __future__ import annotations

import base64
import io
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
from PIL import Image

from builder.jsontypes import JsonObject
from wixy_server.ai.backend import AIBackend, CmdAIBackend
from wixy_server.app import create_app
from wixy_server.chat_working import WorkingCache
from wixy_server.chats import ChatConversation, ChatRuntimeEntry, add_chat, find_chat
from wixy_server.cmdchat import CmdChatClient
from wixy_server.preamble import PREAMBLE_TEXT, compose_prompt
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

    def test_create_succeeds_against_cmds_real_contract_on_sonnet_5(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        """The owner-visible regression this route once had: clicking Start in the
        Chat panel returned "request failed with status 502"
        (decisions/00092-chat-create-lineage-and-model). The 502 was this route
        faithfully reporting a 400 from cmd — cmd requires
        `spawned_by_session_id` on new-chat, and the create call wasn't sending
        it. Driven end-to-end through the route (not the client) because the 502
        is what the owner actually saw, and asserted alongside the pinned model
        so the same request proves both halves of the create contract."""
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations", json={"firstMessage": "add an FAQ link"}
            )

        assert response.status_code == 200
        session = next(iter(fake_cmd_state.sessions.values()))
        assert session.spawned_by_session_id == ""
        assert session.model == "claude-sonnet-5"

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

    def test_working_reflects_fresh_cmd_activity(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        """decisions/00097: the list row pulses from the SAME `activity`
        freshness signal the open conversation's own status strip uses —
        proven here at the route layer (not chat_working's own unit tests)
        so the whole app.state wiring (WorkingCache instantiated, ai_backend
        threaded through) is what's actually exercised."""
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        # TTL 0: this test's whole point is observing a change immediately
        # after mutating the fake's activity, not waiting out (or racing) the
        # real 5s cache.
        app.state.chat_working_cache = WorkingCache(cache_ttl_s=0.0)
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={"firstMessage": "hi"})
            session = next(iter(fake_cmd_state.sessions.values()))
            session.ready_after_polls = 1

            def _is_ready() -> bool:
                listed = client.get("/api/admin/chat/conversations").json()["conversations"]
                return bool(listed) and listed[0]["status"] == "ready"

            _poll_until(_is_ready)
            not_working_yet = client.get("/api/admin/chat/conversations").json()["conversations"]
            assert not_working_yet[0]["working"] is False

            session.status["activity"] = "active"
            now_working = client.get("/api/admin/chat/conversations").json()["conversations"]
            assert now_working[0]["working"] is True


class TestStateChatsField:
    def test_state_reflects_created_conversations(
        self, storage_root: Path, wixy_repo_root: Path, fake_cmd_state: FakeCmdState
    ) -> None:
        # A test-local client with a generous readiness_timeout_s, NOT the
        # shared `cmdchat_client` fixture's deliberately tight 0.3s (chosen so
        # OTHER tests can observe the timeout firing quickly, TestReadinessTimeout
        # above) -- this test wants to observe "pending", which raced the same
        # 0.3s background deadline under heavy parallel test-suite load (a real,
        # reproducible flake: passes standalone, intermittently observed "failed"
        # under `-n 4` when co-running tests starve this process's event loop for
        # a stretch longer than 300ms). 30s makes the assumption true by
        # construction instead of true by lucky scheduling.
        cmdchat_client = CmdChatClient(
            transport=httpx.ASGITransport(app=create_fake_cmd_app(fake_cmd_state)),
            readiness_poll_interval_s=0.02,
            readiness_timeout_s=30.0,
            ws_connect=_ws_connect_always_fails,
        )
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
        assert state["chats"][0]["working"] is False

    def test_working_flows_through_the_same_shape_as_the_dedicated_list(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        """`chat_working.py`'s module docstring: `/state` never triggers its
        own live cmd check (that field comes from the read-only
        `cached_working_for`) — ONLY the dedicated `GET .../conversations`
        list ever refreshes the shared `WorkingCache` (`working_for`). Two
        things must both hold: (1) before the list has ever looked, `/state`
        conservatively reads `working: false` even though the underlying
        cmd session genuinely is active — the accepted trade-off, not a live
        check in disguise; (2) once the list HAS refreshed the cache, `/state`
        reads the exact same cached value — both call sites share the one
        `app.state.chat_working_cache` instance
        (`chats.conversation_summary`'s "never drift apart" wire-shape
        promise), so a value the list learned is never re-derived or
        second-guessed by `/state`, just relayed."""
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        app.state.chat_working_cache = WorkingCache(cache_ttl_s=0.0)
        with TestClient(app) as client:
            client.post("/api/admin/chat/conversations", json={"firstMessage": "hi"})
            session = next(iter(fake_cmd_state.sessions.values()))
            session.ready_after_polls = 1

            def _is_ready() -> bool:
                listed = client.get("/api/admin/chat/conversations").json()["conversations"]
                return bool(listed) and listed[0]["status"] == "ready"

            _poll_until(_is_ready)
            session.status["activity"] = "active"

            # `/state` alone, before the dedicated list ever polls again,
            # never performs its own cmd check — conservatively `false`.
            stale_state = client.get("/api/admin/state").json()
            assert stale_state["chats"][0]["working"] is False

            # The dedicated list's own poll is the only thing that refreshes
            # the shared cache...
            listed = client.get("/api/admin/chat/conversations").json()["conversations"]
            assert listed[0]["working"] is True

            # ...and `/state` now relays that SAME cached value without
            # re-checking — proof the two call sites share one cache rather
            # than ever drifting into disagreeing answers.
            state = client.get("/api/admin/state").json()

        assert state["chats"][0]["working"] is True


def _create(client: TestClient, first_message: str | None = None) -> dict[str, object]:
    body: dict[str, object] = {"firstMessage": first_message} if first_message else {}
    response = client.post("/api/admin/chat/conversations", json=body)
    assert response.status_code == 200
    result: dict[str, object] = response.json()
    return result


def _make_png_bytes(size: tuple[int, int] = (10, 10)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "red").save(buf, format="PNG")
    return buf.getvalue()


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

    def test_attachment_ids_are_forwarded_to_cmd_as_kind_and_upload_id(
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
            # Stage the upload first — real cmd (and now the fake, mirroring
            # its `_resolve_upload_ids_to_blocks`) 404s a send referencing an
            # id it never staged.
            upload = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/attachments",
                files={"file": ("a.png", _make_png_bytes(), "image/png")},
            )
            assert upload.status_code == 200
            upload_id = upload.json()["attachmentId"]
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/messages",
                json={
                    "text": "look at this",
                    "idempotencyKey": "conv1:msg3",
                    "attachmentIds": [upload_id],
                },
            )
            session = next(iter(fake_cmd_state.sessions.values()))

        assert response.status_code == 200
        assert session.last_send_body is not None
        assert session.last_send_body["attachments"] == [{"kind": "image", "upload_id": upload_id}]

    def test_omitting_attachment_ids_sends_no_attachments_field(
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
                json={"text": "plain text", "idempotencyKey": "conv1:msg4"},
            )
            session = next(iter(fake_cmd_state.sessions.values()))

        assert session.last_send_body is not None
        assert "attachments" not in session.last_send_body


class TestUploadAttachment:
    def test_uploads_a_real_image_and_returns_the_converted_dimensions(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        fake_cmd_state.upload_converted_dims = (200, 150)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/attachments",
                files={"file": ("photo.png", _make_png_bytes(), "image/png")},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["attachmentId"] == "upload-1"
        assert body["width"] == 200
        assert body["height"] == 150

    def test_forwards_the_bytes_and_media_type_to_cmd(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        png_bytes = _make_png_bytes()
        with TestClient(app) as client:
            conv = _create(client, "hi")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/attachments",
                files={"file": ("photo.png", png_bytes, "image/png")},
            )

        upload_id = response.json()["attachmentId"]
        staged = fake_cmd_state.uploads[upload_id]
        assert staged["kind"] == "image"
        assert staged["media_type"] == "image/png"
        assert base64.b64decode(staged["bytes_b64"]) == png_bytes  # type: ignore[arg-type]

    def test_unknown_conversation_404s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations/does-not-exist/attachments",
                files={"file": ("photo.png", _make_png_bytes(), "image/png")},
            )

        assert response.status_code == 404

    def test_oversized_file_422s_before_ever_reaching_cmd(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        oversized = b"x" * (5 * 1024 * 1024 + 1)
        with TestClient(app) as client:
            conv = _create(client, "hi")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/attachments",
                files={"file": ("big.png", oversized, "image/png")},
            )

        assert response.status_code == 422
        assert fake_cmd_state.uploads == {}  # never reached cmd at all

    def test_unsupported_content_type_422s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/attachments",
                files={"file": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
            )

        assert response.status_code == 422

    def test_cmd_error_returns_502(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        fake_cmd_state.upload_status_code = 413
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            conv = _create(client, "hi")
            response = client.post(
                f"/api/admin/chat/conversations/{conv['convId']}/attachments",
                files={"file": ("photo.png", _make_png_bytes(), "image/png")},
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
    async def test_never_streams_the_internal_preamble_to_the_owner(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """decisions/00093: the site-assistant preamble rides inside the first
        user message (spec/06 §1 composes it there), and the panel rendered it
        verbatim — a ~1.4 KB wall of internal instructions and repo paths shown to
        a non-developer, above their own words. The stream must emit only what the
        owner wrote, while cmd's transcript keeps the full text for the model."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(0, role="user", text=compose_prompt(PREAMBLE_TEXT, "Hi!")),
            _fake_message(1, role="assistant", text="Hello — what shall we change?"),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=2)

        texts = [_message_payload(e)["text"] for e in events if e["type"] == "message"]
        assert texts == ["Hi!", "Hello — what shall we change?"]
        # Not merely "shortened" — no fragment of the preamble may survive.
        assert "site assistant" not in "".join(str(t) for t in texts)
        # The upstream transcript is untouched: the model still gets the preamble.
        assert PREAMBLE_TEXT in str(session.messages[0]["text"])

    @pytest.mark.asyncio
    async def test_preamble_only_first_message_is_not_streamed_at_all(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """ "New conversation" with no opening message: the first user message is
        pure preamble, so it must be dropped entirely rather than rendered as an
        empty bubble the owner never sent. The assistant's greeting still
        arrives."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(0, role="user", text=compose_prompt(PREAMBLE_TEXT, None)),
            _fake_message(1, role="assistant", text="Hi! What would you like to change?"),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=1)

        message_events = [e for e in events if e["type"] == "message"]
        assert [_message_payload(e)["role"] for e in message_events] == ["assistant"]

    @pytest.mark.asyncio
    async def test_stripped_first_message_is_not_re_sent_on_every_poll(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """The already-sent cache must hold the STRIPPED message, not the raw one.
        Caching the raw text while emitting the stripped text would make the diff
        never match, re-sending the owner's first message on every poll tick."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(0, role="user", text=compose_prompt(PREAMBLE_TEXT, "Hi!")),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        # Two events = the one message + the one status event. A re-sending bug
        # yields a second identical message event instead of just the status.
        events = await _collect_stream_events(gen, count=2)

        message_events = [e for e in events if e["type"] == "message"]
        assert len(message_events) == 1
        assert _message_payload(message_events[0])["text"] == "Hi!"

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


class TestTaskEvents:
    """The `wixy-tasks` fenced-block protocol (decisions/00097) — extraction
    is a plain function (`chat_tasks.extract_tasks`, its own unit tests), so
    this class only proves the STREAM wiring: stripped from the visible
    text, emitted as a `tasks` event, and re-emitted independently of the
    message-event dedup when only the embedded statuses change.
    """

    @pytest.mark.asyncio
    async def test_a_valid_block_is_stripped_and_emitted_as_a_tasks_event(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(
                0,
                role="assistant",
                text=(
                    "I'll add the FAQ link now.\n\n"
                    '```wixy-tasks\n{"tasks": [{"label": "Add FAQ link", "status": "doing"}]}\n```'
                ),
            ),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=2)

        message_events = [e for e in events if e["type"] == "message"]
        assert _message_payload(message_events[0])["text"] == "I'll add the FAQ link now."
        tasks_events = [e for e in events if e["type"] == "tasks"]
        assert len(tasks_events) == 1
        assert tasks_events[0]["tasks"] == [{"label": "Add FAQ link", "status": "doing"}]
        assert tasks_events[0]["messageIndex"] == 0

    @pytest.mark.asyncio
    async def test_a_message_without_a_task_block_emits_no_tasks_event(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [_fake_message(0, role="assistant", text="Just a normal reply.")]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=1)

        assert [e["type"] for e in events] == ["message"]

    @pytest.mark.asyncio
    async def test_a_malformed_block_is_stripped_but_emits_no_tasks_event(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(
                0, role="assistant", text="Working on it.\n\n```wixy-tasks\nnot json\n```"
            ),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=1)

        assert [e["type"] for e in events] == ["message"]
        assert _message_payload(events[0])["text"] == "Working on it."

    @pytest.mark.asyncio
    async def test_a_status_only_change_still_fires_a_new_tasks_event(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """The visible prose is byte-identical across both polls (only the
        embedded status changes) — proves the tasks event is gated on the
        TASKS changing, independently of the message-event dedup, which
        would otherwise never re-fire here at all (routes_chat.py's own note
        on why this must be a separate diff)."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(
                0,
                role="assistant",
                text=(
                    "Working on it.\n\n"
                    '```wixy-tasks\n{"tasks": [{"label": "Add FAQ link", "status": "doing"}]}\n```'
                ),
            ),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        try:
            with anyio.fail_after(5.0):
                # Tick 1 yields THREE events from its one fetch: the message,
                # the tasks event, and (per test_resends_a_message_whose_
                # content_later_changes's own precedent) a trailing status
                # event too, since status also differs from the initial
                # `None`. All three must be drained before mutating, or the
                # mutation lands mid-tick and the next anext() just observes
                # tick 1's own trailing status event instead of a fresh tick.
                first_event = _decode_sse_line(await anext(gen))
                second_event = _decode_sse_line(await anext(gen))
                third_event = _decode_sse_line(await anext(gen))
                session.messages = [
                    _fake_message(
                        0,
                        role="assistant",
                        text=(
                            "Working on it.\n\n"
                            "```wixy-tasks\n"
                            '{"tasks": [{"label": "Add FAQ link", "status": "done"}]}\n'
                            "```"
                        ),
                    ),
                ]
                # Tick 2: the cleaned text is IDENTICAL to tick 1's ("Working
                # on it." either way) and the status is unchanged too, so
                # neither a message nor a status event fires this time — the
                # very next event must be the tasks event.
                fourth_event = _decode_sse_line(await anext(gen))
        finally:
            await gen.aclose()

        assert first_event["type"] == "message"
        assert second_event["type"] == "tasks"
        assert second_event["tasks"] == [{"label": "Add FAQ link", "status": "doing"}]
        assert third_event["type"] == "status"
        assert fourth_event["type"] == "tasks"
        assert fourth_event["tasks"] == [{"label": "Add FAQ link", "status": "done"}]

    @pytest.mark.asyncio
    async def test_the_task_block_is_never_visible_in_a_user_message(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """Extraction only ever runs on assistant text — a literal
        ```wixy-tasks fence the OWNER happened to type (quoting the docs,
        say) must pass through untouched, never parsed as protocol."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(
                0,
                role="user",
                text='why does the assistant show ```wixy-tasks\n{"tasks": []}\n``` blocks?',
            ),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=1)

        assert [e["type"] for e in events] == ["message"]
        assert "wixy-tasks" in str(_message_payload(events[0])["text"])


# ---------------------------------------------------------------------------
# decisions/00108 — attachments everywhere: create flow, session-less uploads,
# the bytes proxy, and stream decoration from the send log
# ---------------------------------------------------------------------------


class TestCreateConversationWithAttachments:
    def test_create_forwards_attachment_ids_and_logs_the_send(
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
            # Stage the upload session-lessly first — the "New conversation"
            # compose's flow, since no conversation exists to scope it to yet.
            upload = client.post(
                "/api/admin/chat/uploads",
                files={"file": ("photo.png", _make_png_bytes(), "image/png")},
            )
            assert upload.status_code == 200
            upload_id = upload.json()["attachmentId"]

            response = client.post(
                "/api/admin/chat/conversations",
                json={"firstMessage": "what is this?", "attachmentIds": [upload_id]},
            )
            assert response.status_code == 200
            conv = response.json()

            # cmd's new-chat received the attachments for the first turn...
            session = next(iter(fake_cmd_state.sessions.values()))
            assert session.create_attachments == [{"kind": "image", "upload_id": upload_id}]
            assert session.prompt == compose_prompt(PREAMBLE_TEXT, "what is this?")
            # ...and the title still derives from the first message.
            assert conv["title"] == "what is this?"

        # ...and wixy logged the send (full composed prompt, decoder-stripped)
        # so the stream can re-decorate cmd's block-dropping read-back.
        from wixy_server.chat_sends import load_sends

        sends_path = project_paths(storage_root, "test").chat_sends_json
        sends = load_sends(sends_path)
        assert len(sends) == 1
        assert sends[0].text == compose_prompt(PREAMBLE_TEXT, "what is this?").strip()
        assert [a.upload_id for a in sends[0].attachments] == [upload_id]

    def test_create_with_attachments_against_an_unsupporting_backend_422s(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        from wixy_server.ai.anthropic_backend import AnthropicAIBackend

        backend = AnthropicAIBackend(transport=httpx.ASGITransport(app=create_fake_cmd_app()))
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, ai_backend=backend
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/conversations",
                json={"firstMessage": "hi", "attachmentIds": ["some-id"]},
            )
        assert response.status_code == 422


class TestUnscopedUpload:
    def test_stages_an_image_without_a_conversation(
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
            response = client.post(
                "/api/admin/chat/uploads",
                files={"file": ("photo.png", _make_png_bytes(), "image/png")},
            )

        assert response.status_code == 200
        body = response.json()
        assert body["attachmentId"] in fake_cmd_state.uploads
        # No session id hint — the upload is unscoped by design (cmd treats it
        # as an optional janitor hint only).
        assert "session_id" not in fake_cmd_state.uploads[body["attachmentId"]]

    def test_invalid_image_422s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/chat/uploads",
                files={"file": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
            )
        assert response.status_code == 422


class TestUploadBytesProxy:
    def test_serves_the_converted_bytes_with_an_immutable_cache_header(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        cmdchat_client: CmdChatClient,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            upload = client.post(
                "/api/admin/chat/uploads",
                files={"file": ("photo.png", _make_png_bytes(), "image/png")},
            )
            upload_id = upload.json()["attachmentId"]
            response = client.get(f"/api/admin/chat/uploads/{upload_id}/bytes")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("image/webp")
        assert response.content.startswith(b"RIFF")
        assert "immutable" in response.headers["cache-control"]

    def test_an_unknown_id_404s(
        self, storage_root: Path, wixy_repo_root: Path, cmdchat_client: CmdChatClient
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, cmdchat_client=cmdchat_client
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/chat/uploads/no-such-id/bytes")
        assert response.status_code == 404


class TestStreamAttachmentDecoration:
    @pytest.mark.asyncio
    async def test_a_send_logged_by_send_message_decorates_its_read_back(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """The stream-json case: cmd's read-back of an image send has NO trace
        of the image (the decoder drops image blocks) — the stream must
        re-attach it from wixy's own send log."""
        from wixy_server.chat_attachments import ChatAttachmentRef
        from wixy_server.chat_sends import ChatSend, ChatSendsCache

        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(0, role="user", text="look at this"),
            _fake_message(1, role="assistant", text="a purple square"),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}
        sends = ChatSendsCache(tmp_path / "chat-sends.json")
        sends.record(
            ChatSend(
                conv_id=conv_id,
                text="look at this",
                sent_at="2026-08-02T00:00:00+00:00",
                attachments=(ChatAttachmentRef(upload_id="u1"),),
            )
        )

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing, sends
        )
        events = await _collect_stream_events(gen, count=2)

        first = _message_payload(events[0])
        assert first["text"] == "look at this"
        assert first["attachments"] == [
            {"uploadId": "u1", "name": None, "width": None, "height": None}
        ]
        # A plain text message's envelope stays attachment-free (byte-shape
        # unchanged from before this feature).
        assert "attachments" not in _message_payload(events[1])

    @pytest.mark.asyncio
    async def test_an_image_only_first_message_survives_the_preamble_strip(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """The owner started the conversation with JUST a photo: the first
        read-back message is preamble-only text + image blocks. Decorated
        from the create-time send record, `_owner_visible` must keep it (as
        text=None, thumbnails-only) rather than dropping it as preamble."""
        from wixy_server.chat_attachments import ChatAttachmentRef
        from wixy_server.chat_sends import ChatSend, ChatSendsCache

        preamble_only = compose_prompt(PREAMBLE_TEXT, None).strip()
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [_fake_message(0, role="user", text=preamble_only)]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}
        sends = ChatSendsCache(tmp_path / "chat-sends.json")
        sends.record(
            ChatSend(
                conv_id=conv_id,
                text=preamble_only,
                sent_at="2026-08-02T00:00:00+00:00",
                attachments=(ChatAttachmentRef(upload_id="u9"),),
            )
        )

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing, sends
        )
        events = await _collect_stream_events(gen, count=1)

        payload = _message_payload(events[0])
        assert payload["text"] is None
        assert payload["attachments"][0]["uploadId"] == "u9"

    @pytest.mark.asyncio
    async def test_a_footer_carrying_message_is_decorated_by_the_client_not_the_log(
        self,
        tmp_path: Path,
        ai_backend: AIBackend,
        fake_cmd_state: FakeCmdState,
        fast_stream_timing: StreamTiming,
    ) -> None:
        """The driver-path case: the footer in the text is parsed by the cmd
        CLIENT (footer strip + refs with dims), the log stays out of it — and
        the owner never sees the raw path."""
        session = fake_cmd_state.create_session("hi")
        session.ready = True
        session.messages = [
            _fake_message(
                0,
                role="user",
                text=(
                    "what do you see?\n\nAttachments:\n"
                    "@C:\\Users\\josh\\.claude\\cmd-uploads\\abc123\\converted.webp (800x600)"
                ),
            ),
        ]
        chats_path = tmp_path / "chats.json"
        conv_id = _seed_conversation(chats_path, session.session_id)
        runtime: dict[str, ChatRuntimeEntry] = {}

        gen = _stream_events(
            ai_backend, chats_path, runtime, conv_id, session.session_id, fast_stream_timing
        )
        events = await _collect_stream_events(gen, count=1)

        payload = _message_payload(events[0])
        assert payload["text"] == "what do you see?"
        assert payload["attachments"] == [
            {"uploadId": "abc123", "name": "converted.webp", "width": 800, "height": 600}
        ]
