"""`/api/admin/server/*` (spec/server-chat/00-brief.md §5.1-§5.4/§5.7) — unlock
mapping against a fake cmd PIN service, the token gate on every other route, send/
history/usage, the SSE stream loop (after-cursor, coalescing, locked-on-expiry,
ping cadence, and the CRITICAL cross-process pickup), token email-binding through a
real CF Access JWT, and the "the PIN never leaks" proof.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import anyio
import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from starlette.requests import Request

import wixy_server.app as wixy_app_module
import wixy_server.routes_livechat as routes_livechat_module
from wixy_server.app import create_app
from wixy_server.livechat import janitor as livechat_janitor
from wixy_server.livechat import media_queue as livechat_media_queue
from wixy_server.livechat.models import AttachmentResult, PushSubscriptionRow, UploadRow
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import ServerAuth, mint_unlock_token, sign_media_url
from wixy_server.routes_livechat import _stream_events
from wixy_server.storage import ProjectPaths
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": str(origin_repo),
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
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "engine commit"], root)
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    return state


@pytest.fixture
def pin_verifier(fake_cmd_state: FakeCmdState) -> CmdPinVerifier:
    fake_app = create_fake_cmd_app(fake_cmd_state)
    return CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app))


def _unlock(
    client: TestClient, *, pin: str = TEST_PIN, headers: dict[str, str] | None = None
) -> Any:
    return client.post("/api/admin/server/unlock", json={"pin": pin}, headers=headers or {})


def _server_request(app: Any, token: str, *, method: str, path: str) -> Request:
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [(b"x-wixy-server-token", token.encode("ascii"))],
            "client": ("127.0.0.1", 12345),
            "server": ("127.0.0.1", 80),
            "app": app,
            "state": {"access_email": ""},
        }
    )


# ---------------------------------------------------------------------------
# POST /unlock -> fake-cmd mapping (§5.1)
# ---------------------------------------------------------------------------


class TestUnlockMapping:
    def test_correct_pin_returns_a_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = _unlock(client)
        assert response.status_code == 200
        body = response.json()
        assert isinstance(body["token"], str) and "." in body["token"]
        assert body["expiresAt"] > time.time()

    def test_wrong_pin_is_401(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = _unlock(client, pin="000000")
        assert response.status_code == 401
        assert response.json()["error"] == "wrong_pin"
        assert response.json()["attemptsLeft"] == 4

    def test_five_wrong_attempts_locks_out_with_retry_after(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            for _ in range(4):
                assert _unlock(client, pin="000000").status_code == 401
            response = _unlock(client, pin="000000")
        assert response.status_code == 429
        assert response.json()["error"] == "locked_out"
        assert int(response.headers["Retry-After"]) > 0
        assert response.json()["retryAfterS"] == int(response.headers["Retry-After"])

    def test_malformed_pin_body_is_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = _unlock(client, pin="not-digits")
        assert response.status_code == 422

    def test_pin_under_four_digits_is_rejected_locally_and_never_reaches_cmd(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        """§5.1 v1.4: "wixy validates 4-16 digits locally and does not call cmd
        below that" — cmd charges an attempt before checking, so a stray
        keypress must never burn one. Proven here by asserting the fake's own
        attempt counter never moved."""
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = _unlock(client, pin="12")
        assert response.status_code == 422
        assert fake_cmd_state.pin_apps[TEST_APP_KEY].attempts == {}

    def test_pin_changed_mid_check_is_409(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        fake_cmd_state.pin_apps[TEST_APP_KEY].simulate_pin_changed_once = True
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = _unlock(client)
        assert response.status_code == 409
        assert response.json() == {"error": "pin_changed"}

    def test_unknown_app_key_is_503_not_configured(
        self, storage_root: Path, wixy_repo_root: Path, fake_cmd_state: FakeCmdState
    ) -> None:
        fake_app = create_fake_cmd_app(fake_cmd_state)
        verifier = CmdPinVerifier(
            app_key="an-app-key-nobody-registered", transport=httpx.ASGITransport(app=fake_app)
        )
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=verifier
        )
        with TestClient(app) as client:
            response = _unlock(client)
        assert response.status_code == 503
        assert response.json() == {"error": "not_configured"}

    def test_cmd_unreachable_is_503_pin_service_unavailable(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        verifier = CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.MockTransport(handler))
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=verifier
        )
        with TestClient(app) as client:
            response = _unlock(client)
        assert response.status_code == 503
        assert response.json() == {"error": "pin_service_unavailable"}

    def test_cmd_400_invalid_request_maps_to_422_not_503(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """§5.1's mapping table: 400 `invalid_request` -> wixy **422**, distinct
        from every other unexpected-failure case (which closed-fails 503).
        Provably unreachable via a real user (UnlockIn's local 4-16-digit
        validation), but the frozen contract still specifies this exact
        mapping — end-to-end through the real app, not just pinclient's unit
        test."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400, json={"ok": False, "error": "invalid_request", "message": "bad shape"}
            )

        verifier = CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.MockTransport(handler))
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=verifier
        )
        with TestClient(app) as client:
            response = _unlock(client)
        assert response.status_code == 422
        assert response.json()["error"] == "invalid"

    def test_standalone_edition_has_no_verifier_and_is_not_configured(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = _unlock(client)
        assert response.status_code == 503
        assert response.json() == {"error": "not_configured"}


# ---------------------------------------------------------------------------
# Every other route requires the header token; a query-string token is rejected.
# ---------------------------------------------------------------------------


class TestTokenRequired:
    def _app(self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier) -> Any:
        return create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )

    def test_get_history_without_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = self._app(storage_root, wixy_repo_root, pin_verifier)
        with TestClient(app) as client:
            response = client.get("/api/admin/server/messages")
        assert response.status_code == 401
        assert response.json() == {"error": "locked"}

    def test_post_message_without_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = self._app(storage_root, wixy_repo_root, pin_verifier)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/messages",
                json={"clientId": "c" * 8, "sender": "Josh", "deviceId": "d" * 8, "text": "hi"},
            )
        assert response.status_code == 401
        assert response.json() == {"error": "locked"}

    def test_get_stream_without_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = self._app(storage_root, wixy_repo_root, pin_verifier)
        with TestClient(app) as client:
            response = client.get("/api/admin/server/stream")
        assert response.status_code == 401
        assert response.json() == {"error": "locked"}

    def test_get_usage_without_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = self._app(storage_root, wixy_repo_root, pin_verifier)
        with TestClient(app) as client:
            response = client.get("/api/admin/server/usage")
        assert response.status_code == 401
        assert response.json() == {"error": "locked"}

    def test_a_valid_token_as_a_query_param_is_rejected(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = self._app(storage_root, wixy_repo_root, pin_verifier)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            response = client.get(f"/api/admin/server/messages?token={token}")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# Send / history / usage, through a real unlocked session.
# ---------------------------------------------------------------------------


class TestSendHistoryUsage:
    def _unlocked_client(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> tuple[TestClient, dict[str, str]]:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        client = TestClient(app)
        client.__enter__()
        token = _unlock(client).json()["token"]
        return client, {"X-Wixy-Server-Token": token}

    def test_send_returns_201_and_the_message(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "client-aaaaaaaa",
                    "sender": "Josh",
                    "deviceId": "device-aaaaaaaa",
                    "text": "hello there",
                },
                headers=headers,
            )
            assert response.status_code == 201
            assert response.json()["message"]["text"] == "hello there"
            assert response.json()["message"]["sender"] == "Josh"
        finally:
            client.__exit__(None, None, None)

    def test_replaying_the_same_client_id_is_idempotent(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            body = {
                "clientId": "client-aaaaaaaa",
                "sender": "Josh",
                "deviceId": "device-aaaaaaaa",
                "text": "hello there",
            }
            first = client.post("/api/admin/server/messages", json=body, headers=headers)
            second = client.post("/api/admin/server/messages", json=body, headers=headers)
            assert first.status_code == 201
            assert second.status_code == 200
            assert first.json()["message"]["seq"] == second.json()["message"]["seq"]
        finally:
            client.__exit__(None, None, None)

    def test_empty_message_is_422_invalid(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages",
                json={"clientId": "c" * 8, "sender": "Josh", "deviceId": "d" * 8},
                headers=headers,
            )
            assert response.status_code == 422
            assert response.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    def test_unknown_attachment_is_422_invalid(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "c" * 8,
                    "sender": "Josh",
                    "deviceId": "d" * 8,
                    "attachmentIds": ["does-not-exist"],
                },
                headers=headers,
            )
            assert response.status_code == 422
            assert response.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    def test_history_returns_messages_ascending_with_cursor(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            for i in range(3):
                client.post(
                    "/api/admin/server/messages",
                    json={
                        "clientId": f"client-{i:08d}",
                        "sender": "Josh",
                        "deviceId": "device-aaaaaaaa",
                        "text": f"message {i}",
                    },
                    headers=headers,
                )
            response = client.get("/api/admin/server/messages", headers=headers)
            body = response.json()
            assert [m["text"] for m in body["messages"]] == ["message 0", "message 1", "message 2"]
            assert body["hasMore"] is False
            assert body["cursor"] == 3
        finally:
            client.__exit__(None, None, None)

    def test_history_limit_out_of_range_is_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.get("/api/admin/server/messages?limit=0", headers=headers)
            assert response.status_code == 422
        finally:
            client.__exit__(None, None, None)

    def test_usage_reports_zero_before_any_media(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.get("/api/admin/server/usage", headers=headers)
            body = response.json()
            assert body["usedBytes"] == 0
            assert body["freeBytes"] == body["quotaBytes"]
            assert body["mediaAvailable"] is True
            assert body["erasurePending"] is False
        finally:
            client.__exit__(None, None, None)


# ---------------------------------------------------------------------------
# The SSE stream loop (§3, §5.4) — driven directly (TestClient can't observe an
# infinite generator), same pattern as `test_routes_chat.py`.
# ---------------------------------------------------------------------------


def _decode_sse_frame(raw: str) -> dict[str, Any]:
    frame: dict[str, Any] = {"id": None, "event": None, "data": None}
    for line in raw.rstrip("\n").split("\n"):
        if line.startswith("id: "):
            frame["id"] = int(line[len("id: ") :])
        elif line.startswith("event: "):
            frame["event"] = line[len("event: ") :]
        elif line.startswith("data: "):
            frame["data"] = json.loads(line[len("data: ") :])
    return frame


async def _next_frame(generator: Any, *, timeout_s: float = 2.0) -> dict[str, Any]:
    with anyio.fail_after(timeout_s):
        raw = await generator.__anext__()
    return _decode_sse_frame(raw)


_FIXED_AUTH = ServerAuth(email="", exp=int(time.time()) + 3600)
_SECRET = b"x" * 32


class TestStreamEvents:
    @pytest.mark.asyncio
    async def test_after_cursor_returns_only_newer_events(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="one",
            attachment_ids=(),
            now=1000.0,
        )
        store.create_message(
            client_id="c2",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="two",
            attachment_ids=(),
            now=1001.0,
        )
        notifier = LiveChatNotifier()
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=1)
        try:
            frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert frame["event"] == "message"
        assert frame["id"] == 2
        assert frame["data"]["text"] == "two"

    @pytest.mark.asyncio
    async def test_coalesces_message_and_message_updated_into_one_frame(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        att = store.create_attachment(att_id="att-1", kind="photo", now=1000.0)
        store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text=None,
            attachment_ids=(att.id,),
            now=1000.0,
        )
        store.claim_processing(owner="w", now=1000.0, lease_s=60.0)
        store.finish_attachment(
            att_id="att-1",
            owner="w",
            result=AttachmentResult(
                status="ready",
                mime="image/jpeg",
                width=1,
                height=1,
                duration_s=None,
                peaks=None,
                renditions=("full",),
                bytes_on_disk=1,
                failure=None,
            ),
            now=1000.0,
        )
        notifier = LiveChatNotifier()
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0)
        try:
            frame = await _next_frame(gen)
            assert frame["event"] == "message"
            assert frame["data"]["attachments"][0]["status"] == "ready"
            with pytest.raises(TimeoutError):
                await _next_frame(gen, timeout_s=0.3)
        finally:
            await gen.aclose()

    @pytest.mark.asyncio
    async def test_expired_token_sends_locked_and_the_generator_ends(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        notifier = LiveChatNotifier()
        expired_auth = ServerAuth(email="", exp=int(time.time()) - 1)
        gen = _stream_events(store, notifier, _SECRET, expired_auth, after=0)
        try:
            frame = await _next_frame(gen)
            assert frame["event"] == "locked"
            assert frame["data"] == {}
            with pytest.raises(StopAsyncIteration):
                await gen.__anext__()
        finally:
            await gen.aclose()

    @pytest.mark.asyncio
    async def test_sends_a_ping_comment_periodically(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(routes_livechat_module, "_PING_INTERVAL_S", 0.05)
        monkeypatch.setattr(routes_livechat_module, "_NOTIFIER_WAIT_S", 0.02)
        store = LiveChatStore(tmp_path / "server.db")
        notifier = LiveChatNotifier()
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0)
        saw_ping = False
        try:
            with anyio.fail_after(3.0):
                async for raw in gen:
                    if raw == ": ping\n\n":
                        saw_ping = True
                        break
        finally:
            await gen.aclose()
        assert saw_ping is True

    @pytest.mark.asyncio
    async def test_cross_process_write_is_picked_up_by_the_2s_recheck(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """THE critical case (§3): a sibling blue/green process writes via its
        OWN `LiveChatStore` instance, and the stream loop must still see it —
        via the periodic DB re-check, NOT this process's in-process notifier
        (`notifier1` below is never `.publish()`d)."""
        monkeypatch.setattr(routes_livechat_module, "_NOTIFIER_WAIT_S", 0.05)
        monkeypatch.setattr(routes_livechat_module, "_PING_INTERVAL_S", 999.0)
        db_path = tmp_path / "server.db"
        store1 = LiveChatStore(db_path)
        store2 = LiveChatStore(db_path)  # the "sibling process"
        notifier1 = LiveChatNotifier()  # deliberately never told about store2's write

        gen = _stream_events(store1, notifier1, _SECRET, _FIXED_AUTH, after=0)

        async def _write_via_the_other_instance() -> None:
            await anyio.sleep(0.15)
            store2.create_message(
                client_id="c1",
                sender="Josh",
                device_id="d" * 8,
                by_email=None,
                text="from the sibling process",
                attachment_ids=(),
                now=time.time(),
            )

        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(_write_via_the_other_instance)
                frame = await _next_frame(gen, timeout_s=3.0)
        finally:
            await gen.aclose()

        assert frame["event"] == "message"
        assert frame["data"]["text"] == "from the sibling process"


class TestStreamEventsAmendmentA1:
    """§17.2 amendment A1 — schema/stream headroom for P8's future delete-a-
    message/wipe-the-chat routes. Nothing in P1 ever INSERTS a
    `message_deleted`/`wiped` event yet, so these tests insert one directly via
    raw SQL (exactly the shape P8's future store methods will produce) to prove
    the stream loop already renders them correctly."""

    def _insert_event(
        self, db_path: Path, *, event_type: str, message_seq: int | None, now: float
    ) -> None:
        import sqlite3

        store = LiveChatStore(db_path)
        store.events_after(0)  # forces the schema to exist first
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES (?, ?, ?)",
                (event_type, message_seq, now),
            )
            conn.commit()
        finally:
            conn.close()

    @pytest.mark.asyncio
    async def test_message_deleted_event_renders_as_seq_only(self, tmp_path: Path) -> None:
        db_path = tmp_path / "server.db"
        store = LiveChatStore(db_path)
        message, _created = store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="soon to be deleted",
            attachment_ids=(),
            now=1000.0,
        )
        # Simulates P8's future `delete_message`: the row is gone, only the
        # 'message_deleted' event remains.
        import sqlite3

        conn = sqlite3.connect(str(db_path))
        conn.execute("DELETE FROM messages WHERE seq = ?", (message.seq,))
        conn.commit()
        conn.close()
        self._insert_event(
            db_path, event_type="message_deleted", message_seq=message.seq, now=1001.0
        )

        notifier = LiveChatNotifier()
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0)
        try:
            frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert frame["event"] == "message_deleted"
        assert frame["data"] == {"seq": message.seq}

    @pytest.mark.asyncio
    async def test_wiped_event_renders_with_empty_data(self, tmp_path: Path) -> None:
        db_path = tmp_path / "server.db"
        store = LiveChatStore(db_path)
        self._insert_event(db_path, event_type="wiped", message_seq=None, now=1000.0)

        notifier = LiveChatNotifier()
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0)
        try:
            frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert frame["event"] == "wiped"
        assert frame["data"] == {}

    @pytest.mark.asyncio
    async def test_wipe_precedes_later_message_in_same_batch(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        store.create_message(
            client_id="before-wipe",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="old",
            attachment_ids=(),
            now=1000.0,
        )
        store.wipe(now=1001.0)
        store.create_message(
            client_id="after-wipe",
            sender="Purdy",
            device_id="d" * 8,
            by_email=None,
            text="new",
            attachment_ids=(),
            now=1002.0,
        )

        gen = _stream_events(store, LiveChatNotifier(), _SECRET, _FIXED_AUTH, after=0)
        try:
            frames = [await _next_frame(gen), await _next_frame(gen)]
        finally:
            await gen.aclose()

        assert [(frame["id"], frame["event"]) for frame in frames] == [
            (2, "wiped"),
            (3, "message"),
        ]
        assert frames[1]["data"]["text"] == "new"


class TestDeleteWipeRoutes:
    def _new_app(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> Any:
        return create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            pin_verifier=pin_verifier,
        )

    def test_post_commit_cleanup_exception_returns_pending_not_error(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)

        async def paused_scrubber(**_kwargs: object) -> None:
            await anyio.sleep_forever()

        monkeypatch.setattr(livechat_janitor, "run_scrubber_forever", paused_scrubber)
        store: LiveChatStore = app.state.livechat_store
        message, _ = store.create_message(
            client_id="client-postcommit-cleanup-failure",
            sender="Josh",
            device_id="device-postcommit-cleanup-failure",
            by_email=None,
            text="committed before cleanup error",
            attachment_ids=(),
            now=1.0,
        )
        real_cleanup = livechat_janitor.cleanup_deleted_storage_once

        def fail_route_cleanup(
            *,
            store: LiveChatStore,
            paths: ProjectPaths,
            only_items: set[tuple[str, str]] | None = None,
        ) -> bool:
            if only_items is not None:
                raise OSError("simulated post-commit filesystem failure")
            return real_cleanup(store=store, paths=paths, only_items=only_items)

        monkeypatch.setattr(livechat_janitor, "cleanup_deleted_storage_once", fail_route_cleanup)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            response = client.delete(
                f"/api/admin/server/messages/{message.seq}",
                headers={"X-Wixy-Server-Token": token},
            )

        assert response.status_code == 202
        assert response.json() == {"erasurePending": True}
        assert store.get_messages([message.seq]) == []
        assert store.scrub_pending()

    @pytest.mark.parametrize(
        ("wipe", "expected_event"),
        [(False, "message_deleted"), (True, "wiped")],
    )
    @pytest.mark.asyncio
    async def test_other_stream_receives_erasure_before_file_cleanup(
        self,
        wipe: bool,
        expected_event: str,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        paths: ProjectPaths = app.state.paths
        notifier: LiveChatNotifier = app.state.livechat_notifier
        attachment_id = "9" * 32
        attachment = store.create_attachment(att_id=attachment_id, kind="photo", now=1.0)
        message, _ = store.create_message(
            client_id="client-publish-before-cleanup",
            sender="Josh",
            device_id="device-publish-before-cleanup",
            by_email=None,
            text="erase this while another screen is open",
            attachment_ids=[attachment.id],
            now=2.0,
        )
        media_dir = paths.server_attachment_media_dir(attachment_id)
        media_dir.mkdir(parents=True)
        (media_dir / "full.jpg").write_bytes(b"private")
        cursor = store.events_after(0)[-1].event_seq
        token, _ = mint_unlock_token(app.state.livechat_secret, email="", now=time.time())
        request = _server_request(
            app,
            token,
            method="POST" if wipe else "DELETE",
            path=(
                "/api/admin/server/wipe" if wipe else f"/api/admin/server/messages/{message.seq}"
            ),
        )

        cleanup_started = threading.Event()
        release_cleanup = threading.Event()
        original_cleanup = livechat_janitor.cleanup_deleted_storage_once

        def slow_cleanup(**kwargs: Any) -> bool:
            cleanup_started.set()
            if not release_cleanup.wait(timeout=5.0):
                raise TimeoutError("test did not release the simulated slow cleanup")
            return original_cleanup(**kwargs)

        monkeypatch.setattr(livechat_janitor, "cleanup_deleted_storage_once", slow_cleanup)
        stream_waiting = anyio.Event()
        original_wait = notifier.wait

        async def observe_wait(*, timeout_s: float) -> None:
            stream_waiting.set()
            await original_wait(timeout_s=timeout_s)

        monkeypatch.setattr(notifier, "wait", observe_wait)
        stream = _stream_events(store, notifier, app.state.livechat_secret, _FIXED_AUTH, cursor)
        frames: list[dict[str, Any]] = []
        frame_ready = anyio.Event()
        route_done = anyio.Event()
        responses: list[Any] = []

        async def read_next_frame() -> None:
            frames.append(await _next_frame(stream, timeout_s=4.0))
            frame_ready.set()

        async def run_erasure() -> None:
            response = (
                await routes_livechat_module.wipe_chat(
                    routes_livechat_module.WipeChatIn(confirm="WIPE"), request
                )
                if wipe
                else await routes_livechat_module.delete_message(message.seq, request)
            )
            responses.append(response)
            route_done.set()

        try:
            async with anyio.create_task_group() as task_group:
                task_group.start_soon(read_next_frame)
                await stream_waiting.wait()
                task_group.start_soon(run_erasure)
                cleanup_entered = await anyio.to_thread.run_sync(cleanup_started.wait, 4.0)
                assert cleanup_entered
                await frame_ready.wait()
                assert frames[0]["event"] == expected_event
                assert not release_cleanup.is_set()
                release_cleanup.set()
                await route_done.wait()
                task_group.cancel_scope.cancel()
        finally:
            release_cleanup.set()
            await stream.aclose()

        assert responses[0].status_code in {204, 202}

    @pytest.mark.asyncio
    async def test_stale_reader_does_not_block_a_concurrent_message_send(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        app.state.livechat_message_hooks = []
        app.state.background_tasks = None
        message, _ = store.create_message(
            client_id="client-stale-reader-delete",
            sender="Josh",
            device_id="device-stale-reader-delete",
            by_email=None,
            text="hold this stale row while deleting",
            attachment_ids=(),
            now=1.0,
        )
        reader = sqlite3.connect(str(store._db_path), isolation_level=None)
        reader.execute("BEGIN")
        assert reader.execute("SELECT text FROM messages WHERE seq = ?", (message.seq,)).fetchone()

        connect = store._connect

        def connect_with_one_second_busy_timeout() -> sqlite3.Connection:
            conn = connect()
            conn.execute("PRAGMA busy_timeout = 1000")
            return conn

        monkeypatch.setattr(store, "_connect", connect_with_one_second_busy_timeout)
        original_scrub = store.scrub
        scrub_started = threading.Event()

        def observe_scrub(*, deadline_s: float) -> bool:
            scrub_started.set()
            return original_scrub(deadline_s=deadline_s)

        monkeypatch.setattr(store, "scrub", observe_scrub)
        token, _ = mint_unlock_token(app.state.livechat_secret, email="", now=time.time())
        delete_request = _server_request(
            app, token, method="DELETE", path=f"/api/admin/server/messages/{message.seq}"
        )
        send_request = _server_request(app, token, method="POST", path="/api/admin/server/messages")
        delete_done = anyio.Event()
        delete_responses: list[Any] = []

        async def delete_route() -> None:
            delete_responses.append(
                await routes_livechat_module.delete_message(message.seq, delete_request)
            )
            delete_done.set()

        try:
            async with anyio.create_task_group() as task_group:
                task_group.start_soon(delete_route)
                assert await anyio.to_thread.run_sync(scrub_started.wait, 3.0)
                await anyio.sleep(0.05)
                send_response = await routes_livechat_module.send_message(
                    routes_livechat_module.SendMessageIn(
                        clientId="client-concurrent-send",
                        sender="Josh",
                        deviceId="device-concurrent-send",
                        text="must stay available during scrub",
                        attachmentIds=[],
                    ),
                    send_request,
                )
                assert send_response.status_code == 201
                reader.execute("COMMIT")
                await delete_done.wait()
                task_group.cancel_scope.cancel()
        finally:
            reader.close()

        assert delete_responses[0].status_code == 204

    @pytest.mark.asyncio
    async def test_scrub_guard_wait_counts_against_request_deadline(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(routes_livechat_module, "_DELETE_SCRUB_DEADLINE_S", 0.05)
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        message, _ = store.create_message(
            client_id="client-scrub-lock-deadline",
            sender="Josh",
            device_id="device-scrub-lock-deadline",
            by_email=None,
            text="scrub lock deadline",
            attachment_ids=(),
            now=1.0,
        )
        token, _ = mint_unlock_token(app.state.livechat_secret, email="", now=time.time())
        request = _server_request(
            app, token, method="DELETE", path=f"/api/admin/server/messages/{message.seq}"
        )
        lock_entered = threading.Event()
        release_lock = threading.Event()
        lock_done = threading.Event()

        def hold_scrub_guard() -> None:
            with store.scrub_guard() as acquired:
                assert acquired
                lock_entered.set()
                release_lock.wait(timeout=3.0)
            lock_done.set()

        started_at = time.monotonic()
        try:
            async with anyio.create_task_group() as task_group:
                task_group.start_soon(anyio.to_thread.run_sync, hold_scrub_guard)
                assert await anyio.to_thread.run_sync(lock_entered.wait, 2.0)
                response = await routes_livechat_module.delete_message(message.seq, request)
                assert response.status_code == 202
                assert store.scrub_pending()
                assert time.monotonic() - started_at < 0.5
                release_lock.set()
                assert await anyio.to_thread.run_sync(lock_done.wait, 2.0)
                task_group.cancel_scope.cancel()
        finally:
            release_lock.set()

        assert livechat_janitor.scrub_once(store=store, deadline_s=1.0)
        assert not store.scrub_pending()

    def test_delete_requires_token_and_removes_message_files_without_push(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # This test deliberately seeds a processing attachment; hold the media
        # queue off so it cannot race its filesystem fixture with the route.
        monkeypatch.setattr(livechat_media_queue, "resolve_binaries", lambda *_: None)
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        push_calls: list[str] = []

        async def _push(_message: object) -> None:
            push_calls.append("called")

        app.state.livechat_message_hooks.append(_push)
        store: LiveChatStore = app.state.livechat_store
        paths = app.state.paths
        attachment = store.create_attachment(
            att_id="delete-route-attachment", kind="photo", now=1.0
        )
        store.create_upload(
            UploadRow(
                id=attachment.id,
                kind="photo",
                mime="image/jpeg",
                size_bytes=12,
                filename=None,
                by_email=None,
                created_at=1.0,
            )
        )
        message, _ = store.create_message(
            client_id="client-delete-route",
            sender="Josh",
            device_id="device-delete-route",
            by_email=None,
            text="route delete marker",
            attachment_ids=(attachment.id,),
            now=2.0,
        )
        media_dir = paths.server_attachment_media_dir(attachment.id)
        media_dir.mkdir(parents=True)
        (media_dir / "full.jpg").write_bytes(b"private media")
        upload_dir = paths.server_upload_dir(attachment.id)
        upload_dir.mkdir(parents=True)
        (upload_dir / "assembled").write_bytes(b"source upload")
        failed_dir = paths.server_failed_dir(attachment.id)
        failed_dir.mkdir(parents=True)
        (failed_dir / "original.jpg").write_bytes(b"failed original")

        with TestClient(app) as client:
            locked = client.delete(f"/api/admin/server/messages/{message.seq}")
            assert locked.status_code == 401
            token = _unlock(client).json()["token"]
            response = client.delete(
                f"/api/admin/server/messages/{message.seq}",
                headers={"X-Wixy-Server-Token": token},
            )
            repeat = client.delete(
                f"/api/admin/server/messages/{message.seq}",
                headers={"X-Wixy-Server-Token": token},
            )

        assert response.status_code in {204, 202}
        assert repeat.status_code in {204, 202}
        if response.status_code == 202:
            assert any(response.json().values())
        if repeat.status_code == 202:
            assert any(repeat.json().values())
        livechat_janitor.cleanup_deleted_storage_once(store=store, paths=paths)
        livechat_janitor.scrub_once(store=store, deadline_s=1.0)
        assert store.get_messages([message.seq]) == []
        assert store.events_after(0)[-1].type == "message_deleted"
        assert not store.storage_cleanup_pending()
        assert not media_dir.exists()
        assert not upload_dir.exists()
        assert not failed_dir.exists()
        assert push_calls == []

    def test_delete_persists_scrub_marker_before_starting_checkpoint(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        message, _ = store.create_message(
            client_id="client-delete-marker-before-scrub",
            sender="Josh",
            device_id="device-delete-marker-before-scrub",
            by_email=None,
            text="delete-marker-before-scrub-55f3",
            attachment_ids=(),
            now=1.0,
        )
        marker_states: list[bool] = []
        marker_transactions: list[bool] = []
        write_marker = store._upsert_pending_scrub

        def observe_write_transaction(conn: sqlite3.Connection) -> str:
            marker_transactions.append(conn.in_transaction)
            return write_marker(conn)

        def observe_marker(*, deadline_s: float) -> bool:
            marker_states.append(store.scrub_pending())
            return True

        monkeypatch.setattr(store, "_upsert_pending_scrub", observe_write_transaction)
        monkeypatch.setattr(store, "scrub", observe_marker)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            response = client.delete(
                f"/api/admin/server/messages/{message.seq}",
                headers={"X-Wixy-Server-Token": token},
            )

        assert response.status_code == 204
        assert marker_states and marker_states[0] is True
        assert not store.scrub_pending()
        assert marker_transactions == [True]
        assert not store.scrub_pending()

    def test_delete_cannot_serve_a_locked_file_after_message_row_is_removed(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        paths: ProjectPaths = app.state.paths
        attachment_id = "a" * 32
        store.create_attachment(att_id=attachment_id, kind="photo", now=1.0)
        message, _ = store.create_message(
            client_id="client-delete-open-media",
            sender="Josh",
            device_id="device-delete-open-media",
            by_email=None,
            text="delete-open-media",
            attachment_ids=[attachment_id],
            now=2.0,
        )
        media_dir = paths.server_attachment_media_dir(attachment_id)
        media_dir.mkdir(parents=True)
        media_file = media_dir / "full.jpg"
        media_file.write_bytes(b"still-present-media")
        exp = int(time.time()) + 3600
        signature = sign_media_url(
            app.state.livechat_secret,
            attachment_id=attachment_id,
            rendition="full",
            exp=exp,
            email="",
        )
        original_remove = livechat_janitor._remove_entry

        def fail_locked_directory(path: Path) -> None:
            if path == media_dir:
                raise PermissionError("simulated Windows sharing violation")
            original_remove(path)

        monkeypatch.setattr(livechat_janitor, "_remove_entry", fail_locked_directory)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            with media_file.open("rb"):
                response = client.delete(
                    f"/api/admin/server/messages/{message.seq}",
                    headers={"X-Wixy-Server-Token": token},
                )
                assert response.status_code == 202
                assert response.json() == {"erasurePending": True}
                assert media_file.exists()
                stale_url = (
                    f"/api/admin/server/media/{attachment_id}/full?exp={exp}&sig={signature}"
                )
                assert client.get(stale_url).status_code == 404

        monkeypatch.undo()
        reopened = LiveChatStore(store._db_path)
        assert any(
            kind == "attachment" and storage_id == attachment_id
            for kind, storage_id, _generation in reopened.pending_deleted_storage_items()
        )
        assert not livechat_janitor.cleanup_deleted_storage_once(store=reopened, paths=paths)
        assert not media_dir.exists()

    def test_wipe_cannot_serve_a_locked_file_after_attachment_rows_are_removed(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        paths: ProjectPaths = app.state.paths
        attachment_id = "b" * 32
        store.create_attachment(att_id=attachment_id, kind="photo", now=1.0)
        store.create_message(
            client_id="client-wipe-open-media",
            sender="Josh",
            device_id="device-wipe-open-media",
            by_email=None,
            text="wipe-open-media",
            attachment_ids=[attachment_id],
            now=2.0,
        )
        media_dir = paths.server_attachment_media_dir(attachment_id)
        media_dir.mkdir(parents=True)
        media_file = media_dir / "full.jpg"
        media_file.write_bytes(b"still-present-media")
        exp = int(time.time()) + 3600
        signature = sign_media_url(
            app.state.livechat_secret,
            attachment_id=attachment_id,
            rendition="full",
            exp=exp,
            email="",
        )
        original_remove = livechat_janitor._remove_entry

        def fail_locked_directory(path: Path) -> None:
            if path == media_dir:
                raise PermissionError("simulated Windows sharing violation")
            original_remove(path)

        monkeypatch.setattr(livechat_janitor, "_remove_entry", fail_locked_directory)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            with media_file.open("rb"):
                response = client.post(
                    "/api/admin/server/wipe",
                    headers={"X-Wixy-Server-Token": token},
                    json={"confirm": "WIPE"},
                )
                assert response.status_code == 202
                assert response.json() == {"erasurePending": True}
                assert media_file.exists()
                stale_url = (
                    f"/api/admin/server/media/{attachment_id}/full?exp={exp}&sig={signature}"
                )
                assert client.get(stale_url).status_code == 404

        monkeypatch.undo()
        reopened = LiveChatStore(store._db_path)
        livechat_janitor.cleanup_deleted_storage_once(store=reopened, paths=paths)
        assert not livechat_janitor.cleanup_unreferenced_storage_once(store=reopened, paths=paths)
        assert not reopened.storage_cleanup_pending()
        assert not media_dir.exists()

    def test_wipe_persists_scrub_marker_before_starting_checkpoint(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        store.create_message(
            client_id="client-wipe-marker-before-scrub",
            sender="Josh",
            device_id="device-wipe-marker-before-scrub",
            by_email=None,
            text="wipe-marker-before-scrub-a197",
            attachment_ids=(),
            now=1.0,
        )
        marker_states: list[bool] = []
        marker_transactions: list[bool] = []
        write_marker = store._upsert_pending_scrub

        def observe_write_transaction(conn: sqlite3.Connection) -> str:
            marker_transactions.append(conn.in_transaction)
            return write_marker(conn)

        def observe_marker(*, deadline_s: float) -> bool:
            marker_states.append(store.scrub_pending())
            return True

        monkeypatch.setattr(store, "_upsert_pending_scrub", observe_write_transaction)
        monkeypatch.setattr(store, "scrub", observe_marker)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            response = client.post(
                "/api/admin/server/wipe",
                headers={"X-Wixy-Server-Token": token},
                json={"confirm": "WIPE"},
            )

        assert response.status_code == 204
        # The first checkpoint runs with the marker present; clearing it is
        # followed by one best-effort checkpoint that sees it absent.
        assert marker_states == [True, False]
        assert marker_transactions == [True]
        assert not store.scrub_pending()

    def test_delete_returns_202_until_reader_releases_old_wal_snapshot(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(routes_livechat_module, "_DELETE_SCRUB_DEADLINE_S", 0.1)
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        message, _ = store.create_message(
            client_id="client-delete-active-reader",
            sender="Josh",
            device_id="device-delete-active-reader",
            by_email=None,
            text="delete-route-reader-marker-4f6a",
            attachment_ids=(),
            now=1.0,
        )
        reader = sqlite3.connect(str(store._db_path), isolation_level=None)
        reader.execute("BEGIN")
        assert (
            reader.execute("SELECT text FROM messages").fetchone()[0]
            == "delete-route-reader-marker-4f6a"
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            try:
                blocked = client.delete(
                    f"/api/admin/server/messages/{message.seq}", headers=headers
                )
                assert blocked.status_code == 202
                assert blocked.json() == {"erasurePending": True}
                assert store.scrub_pending()
                usage = client.get("/api/admin/server/usage", headers=headers)
                assert usage.json()["erasurePending"] is True
                assert store.get_messages([message.seq]) == []
            finally:
                reader.close()
            if store.scrub_pending():
                livechat_janitor.scrub_once(store=store, deadline_s=1.0)
            assert not store.scrub_pending()
            completed = client.delete(
                f"/api/admin/server/messages/{message.seq}",
                headers=headers,
            )
        assert completed.status_code == 204
        raw = store._db_path.read_bytes()
        wal_path = Path(f"{store._db_path}-wal")
        if wal_path.exists():
            raw += wal_path.read_bytes()
        assert b"delete-route-reader-marker-4f6a" not in raw

    def test_wipe_returns_202_and_scrubber_clears_marker_after_reader_releases(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(routes_livechat_module, "_DELETE_SCRUB_DEADLINE_S", 0.1)
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        message, _ = store.create_message(
            client_id="client-wipe-active-reader",
            sender="Josh",
            device_id="device-wipe-active-reader",
            by_email=None,
            text="wipe-route-reader-marker-2bc1",
            attachment_ids=(),
            now=1.0,
        )
        reader = sqlite3.connect(str(store._db_path), isolation_level=None)
        reader.execute("BEGIN")
        assert (
            reader.execute("SELECT text FROM messages").fetchone()[0]
            == "wipe-route-reader-marker-2bc1"
        )

        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            try:
                response = client.post(
                    "/api/admin/server/wipe", headers=headers, json={"confirm": "WIPE"}
                )
                assert response.status_code == 202
                assert response.json() == {"erasurePending": True}
                assert store.scrub_pending()
                assert store.get_messages([message.seq]) == []
            finally:
                reader.close()

            if store.scrub_pending():
                livechat_janitor.scrub_once(store=store, deadline_s=1.0)
            usage = client.get("/api/admin/server/usage", headers=headers)
            assert usage.status_code == 200
            assert usage.json()["erasurePending"] is False

        raw = store._db_path.read_bytes()
        wal_path = Path(f"{store._db_path}-wal")
        if wal_path.exists():
            raw += wal_path.read_bytes()
        assert b"wipe-route-reader-marker-2bc1" not in raw

    def test_wipe_cleanup_preserves_upload_created_after_its_commit(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        store: LiveChatStore = app.state.livechat_store
        paths = app.state.paths
        old_orphan = paths.server_upload_dir("old-orphan-before-wipe")
        old_orphan.mkdir(parents=True)
        (old_orphan / "chunk-000000").write_bytes(b"old")
        original_cleanup = livechat_janitor.cleanup_deleted_storage_once
        post_wipe_id = "f" * 32

        def _create_after_commit(
            *,
            store: LiveChatStore,
            paths: ProjectPaths,
            only_items: set[tuple[str, str]] | None = None,
        ) -> bool:
            if only_items is None:
                return original_cleanup(store=store, paths=paths)
            store.create_upload(
                UploadRow(
                    id=post_wipe_id,
                    kind="photo",
                    mime="image/jpeg",
                    size_bytes=3,
                    filename=None,
                    by_email=None,
                    created_at=time.time(),
                )
            )
            new_upload = paths.server_upload_dir(post_wipe_id)
            new_upload.mkdir(parents=True)
            (new_upload / "chunk-000000").write_bytes(b"new")
            original_cleanup(
                store=store,
                paths=paths,
                only_items=only_items,
            )
            return store.storage_cleanup_pending()

        monkeypatch.setattr(
            livechat_janitor,
            "cleanup_deleted_storage_once",
            _create_after_commit,
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            response = client.post(
                "/api/admin/server/wipe",
                headers={"X-Wixy-Server-Token": token},
                json={"confirm": "WIPE"},
            )

        assert response.status_code == 204
        assert store.get_upload(post_wipe_id) is not None
        assert (paths.server_upload_dir(post_wipe_id) / "chunk-000000").read_bytes() == b"new"
        assert not old_orphan.exists()

    def test_wipe_requires_exact_confirmation_and_clears_private_content_only(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        app = self._new_app(storage_root, wixy_repo_root, pin_verifier)
        push_calls: list[str] = []

        async def _push(_message: object) -> None:
            push_calls.append("called")

        app.state.livechat_message_hooks.append(_push)
        store: LiveChatStore = app.state.livechat_store
        paths = app.state.paths
        attachment = store.create_attachment(att_id="wipe-route-attachment", kind="voice", now=1.0)
        store.create_upload(
            UploadRow(
                id=attachment.id,
                kind="voice",
                mime="audio/webm",
                size_bytes=20,
                filename="note.webm",
                by_email=None,
                created_at=1.0,
            )
        )
        store.create_upload(
            UploadRow(
                id="pending-wipe-upload",
                kind="video",
                mime="video/mp4",
                size_bytes=30,
                filename="clip.mp4",
                by_email=None,
                created_at=1.0,
            )
        )
        message, _ = store.create_message(
            client_id="client-wipe-route",
            sender="Purdy",
            device_id="device-wipe-route",
            by_email=None,
            text="wipe route marker",
            attachment_ids=(attachment.id,),
            now=2.0,
        )
        store.upsert_push_subscription(
            PushSubscriptionRow(
                device_id="keep-push-device",
                sender="Purdy",
                endpoint="https://push.example/keep",
                p256dh="public-key",
                auth="auth-secret",
                created_at=1.0,
                last_ok_at=None,
                consecutive_failures=0,
            )
        )
        old_cursor = store.list_messages(before=None, limit=10)[2]
        for directory, name in (
            (paths.server_attachment_media_dir(attachment.id), "full.m4a"),
            (paths.server_upload_dir(attachment.id), "assembled"),
            (paths.server_failed_dir(attachment.id), "original.webm"),
        ):
            directory.mkdir(parents=True)
            (directory / name).write_bytes(b"private data")
        # A remnant with no surviving DB row must be removed by the wipe too.
        orphan_failed = paths.server_failed_dir("orphan-id")
        orphan_failed.mkdir(parents=True)
        (orphan_failed / "original.jpg").write_bytes(b"orphan")
        pending_upload_dir = paths.server_upload_dir("pending-wipe-upload")
        pending_upload_dir.mkdir(parents=True)
        (pending_upload_dir / "chunk-000000").write_bytes(b"partial")

        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            assert (
                client.post("/api/admin/server/wipe", headers=headers, json={}).status_code == 422
            )
            assert (
                client.post(
                    "/api/admin/server/wipe",
                    headers=headers,
                    json={"confirm": "WIPE", "extra": True},
                ).status_code
                == 422
            )
            wrong_case = client.post(
                "/api/admin/server/wipe", headers=headers, json={"confirm": "wipe"}
            )
            assert wrong_case.status_code == 422
            response = client.post(
                "/api/admin/server/wipe", headers=headers, json={"confirm": "WIPE"}
            )
            next_chunk = client.put(
                "/api/admin/server/uploads/pending-wipe-upload/chunks/0",
                headers=headers,
                content=b"remaining bytes",
            )
            complete = client.post(
                "/api/admin/server/uploads/pending-wipe-upload/complete",
                headers=headers,
            )

        assert response.status_code in {204, 202}
        if response.status_code == 202:
            assert any(response.json().values())
        assert next_chunk.status_code == 404
        assert complete.status_code == 404
        livechat_janitor.cleanup_deleted_storage_once(store=store, paths=paths)
        livechat_janitor.cleanup_unreferenced_storage_once(store=store, paths=paths)
        livechat_janitor.scrub_once(store=store, deadline_s=1.0)
        assert not store.storage_cleanup_pending()
        assert store.list_messages(before=None, limit=10)[0] == []
        assert store.events_after(old_cursor)[0].type == "wiped"
        assert store.list_push_subscriptions()[0].device_id == "keep-push-device"
        assert not paths.server_media.exists() or not list(paths.server_media.iterdir())
        assert not paths.server_uploads.exists() or not list(paths.server_uploads.iterdir())
        assert not paths.server_failed.exists() or not list(paths.server_failed.iterdir())
        assert push_calls == []


class TestStreamEventsA1VanishedMessage:
    def _insert_event(
        self, db_path: Path, *, event_type: str, message_seq: int | None, now: float
    ) -> None:
        store = LiveChatStore(db_path)
        store.events_after(0)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES (?, ?, ?)",
                (event_type, message_seq, now),
            )
            conn.commit()
        finally:
            conn.close()

    @pytest.mark.asyncio
    async def test_a_message_event_for_an_already_vanished_row_is_skipped(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 'message'/'message_updated' event whose row is gone (deleted
        concurrently, no accompanying 'message_deleted' event in this batch) is
        SKIPPED entirely — never sent with nothing to show."""
        monkeypatch.setattr(routes_livechat_module, "_NOTIFIER_WAIT_S", 0.05)
        db_path = tmp_path / "server.db"
        store = LiveChatStore(db_path)
        message, _created = store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="will vanish without a delete event",
            attachment_ids=(),
            now=1000.0,
        )
        import sqlite3

        conn = sqlite3.connect(str(db_path))
        conn.execute("DELETE FROM messages WHERE seq = ?", (message.seq,))
        conn.commit()
        conn.close()

        notifier = LiveChatNotifier()
        gen = _stream_events(store, notifier, _SECRET, _FIXED_AUTH, after=0)
        try:
            with pytest.raises(TimeoutError):
                await _next_frame(gen, timeout_s=0.3)
        finally:
            await gen.aclose()


# ---------------------------------------------------------------------------
# Settings carry no PIN-shaped field (only the app-key IDENTIFIER).
# ---------------------------------------------------------------------------


class TestSettingsHaveNoPinField:
    def test_only_the_app_key_identifier_exists(self) -> None:
        from dataclasses import fields

        from wixy_server.settings import Settings

        names = {f.name for f in fields(Settings)}
        assert "server_pin_app_key" in names
        pin_shaped = {n for n in names if "pin" in n.lower() and n != "server_pin_app_key"}
        assert pin_shaped == set()


# ---------------------------------------------------------------------------
# The PIN literal never reaches a log record or a response body.
# ---------------------------------------------------------------------------


class TestPinNeverLeaks:
    def test_pin_absent_from_every_response_and_from_logs(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level(logging.DEBUG)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            wrong = _unlock(client, pin="000000")
            right = _unlock(client, pin=TEST_PIN)
            token = right.json()["token"]
            history = client.get(
                "/api/admin/server/messages", headers={"X-Wixy-Server-Token": token}
            )
        assert TEST_PIN not in wrong.text
        assert TEST_PIN not in right.text
        assert TEST_PIN not in history.text
        assert TEST_PIN not in caplog.text


# ---------------------------------------------------------------------------
# Token email binding, through a REAL CF Access JWT (test_auth_gate_integration's
# own pattern — no WIXY_DEV_NO_AUTH bypass here).
# ---------------------------------------------------------------------------


class TestTokenBoundToRequestingEmail:
    _TEAM_DOMAIN = "example.cloudflareaccess.com"
    _AUD = "the-configured-aud"
    _KID = "livechat-test-key"

    @pytest.fixture
    def _dev_no_auth(self) -> None:
        """Shadows the module-level autouse fixture — this class needs REAL CF
        Access auth, so `WIXY_DEV_NO_AUTH` must stay unset."""
        return None

    @pytest.fixture
    def keypair(self) -> tuple[Any, Any]:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        return private_key, private_key.public_key()

    @pytest.fixture
    def configured_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("WIXY_DEV_NO_AUTH", raising=False)
        monkeypatch.setenv("WIXY_CF_TEAM_DOMAIN", self._TEAM_DOMAIN)
        monkeypatch.setenv("WIXY_CF_ACCESS_AUD", self._AUD)

    @pytest.fixture
    def patched_jwks_fetch(self, monkeypatch: pytest.MonkeyPatch, keypair: tuple[Any, Any]) -> None:
        _private, public = keypair

        def _fake_fetch(_team_domain: str) -> dict[str, Any]:
            jwk = json.loads(RSAAlgorithm(RSAAlgorithm.SHA256).to_jwk(public))
            jwk["kid"] = self._KID
            return {"keys": [jwk]}

        monkeypatch.setattr(wixy_app_module, "_fetch_jwks", _fake_fetch)

    def _sign(self, private_key: Any, *, email: str) -> str:
        now = int(time.time())
        claims = {
            "aud": self._AUD,
            "iss": f"https://{self._TEAM_DOMAIN}",
            "exp": now + 3600,
            "iat": now,
            "email": email,
        }
        return pyjwt.encode(claims, private_key, algorithm="RS256", headers={"kid": self._KID})

    @pytest.mark.usefixtures("configured_env", "patched_jwks_fetch")
    def test_token_minted_for_one_email_is_rejected_under_another(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        keypair: tuple[Any, Any],
    ) -> None:
        private, _public = keypair
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            josh_jwt = self._sign(private, email="josh@example.com")
            unlock = _unlock(client, headers={"CF-Access-Jwt-Assertion": josh_jwt})
            assert unlock.status_code == 200
            token = unlock.json()["token"]

            purdy_jwt = self._sign(private, email="purdy@example.com")
            response = client.get(
                "/api/admin/server/messages",
                headers={"CF-Access-Jwt-Assertion": purdy_jwt, "X-Wixy-Server-Token": token},
            )
        assert response.status_code == 401
        assert response.json() == {"error": "locked"}

    @pytest.mark.usefixtures("configured_env", "patched_jwks_fetch")
    def test_token_works_under_the_same_email(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        keypair: tuple[Any, Any],
    ) -> None:
        private, _public = keypair
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            josh_jwt = self._sign(private, email="josh@example.com")
            token = _unlock(client, headers={"CF-Access-Jwt-Assertion": josh_jwt}).json()["token"]
            response = client.get(
                "/api/admin/server/messages",
                headers={"CF-Access-Jwt-Assertion": josh_jwt, "X-Wixy-Server-Token": token},
            )
        assert response.status_code == 200


class TestPushRoutes:
    def test_push_config_subscription_lifecycle_and_service_worker_route(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            config = client.get("/api/admin/server/push/config", headers=headers)
            assert config.status_code == 200
            assert isinstance(config.json()["publicKey"], str)

            device_id = "device-123456"
            status_url = f"/api/admin/server/push/subscriptions/{device_id}"
            assert client.get(status_url, headers=headers).json() == {"subscribed": False}
            subscribed = client.put(
                status_url,
                headers=headers,
                json={
                    "sender": "Alice",
                    "subscription": {
                        "endpoint": "https://fcm.googleapis.com/fcm/send/token",
                        "keys": {"p256dh": "public", "auth": "secret"},
                    },
                },
            )
            assert subscribed.status_code == 204
            assert client.get(status_url, headers=headers).json() == {"subscribed": True}

            bad_endpoint = client.put(
                status_url,
                headers=headers,
                json={
                    "sender": "Alice",
                    "subscription": {
                        "endpoint": "http://foreign.example/push",
                        "keys": {"p256dh": "public", "auth": "secret"},
                    },
                },
            )
            assert bad_endpoint.status_code == 422
            assert client.delete(status_url, headers=headers).status_code == 204
            assert client.get(status_url, headers=headers).json() == {"subscribed": False}

            worker = client.get("/admin/server-sw.js")
            assert worker.status_code == 200
            assert worker.headers["content-type"].startswith("text/javascript")
            assert worker.headers["cache-control"] == "no-cache"
            assert worker.headers["service-worker-allowed"] == "/admin/"

    def test_push_routes_require_unlock_token(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            assert client.get("/api/admin/server/push/config").json() == {"error": "locked"}
            response = client.get("/api/admin/server/push/subscriptions/device-123456")
            assert response.status_code == 401
