"""`/api/admin/chat/conversations` create + list (spec/06-ai-chat.md §1) — milestone
10 slice 2. `cmdchat.py`'s own transport/protocol behavior is covered by
`test_cmdchat.py`; this file tests the ROUTE layer (title derivation, prompt
construction, background readiness tracking, error mapping, `/state` wiring).
"""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import NoReturn

import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.cmdchat import CmdChatClient
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
