"""`/api/admin/server/*` (spec/server-chat/00-brief.md §5.1-§5.4/§5.7) — unlock
mapping against a fake cmd PIN service, the token gate on every other route, send/
history/usage, the SSE stream loop (after-cursor, coalescing, locked-on-expiry,
ping cadence, and the CRITICAL cross-process pickup), token email-binding through a
real CF Access JWT, and the "the PIN never leaks" proof.
"""

from __future__ import annotations

import json
import logging
import secrets
import sqlite3
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
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
from wixy_server.livechat.models import (
    AttachmentKind,
    AttachmentResult,
    AttachmentRow,
    PushSubscriptionRow,
    UploadRow,
)
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.reactions import REACTION_EMOJIS
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import (
    UNLOCK_GUARD_HEADER,
    UNLOCK_GUARD_VALUE,
    ServerAuth,
    mint_unlock_token,
    sign_media_url,
)
from wixy_server.routes_livechat import _stream_events
from wixy_server.storage import ProjectPaths
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

# A scrub the test expects to SUCCEED gets a generous deadline: success returns as soon as the WAL
# is truncated, so the number is only ever spent by a machine stall (decision 00159). Tests that
# expect a scrub to fail hold a blocking reader open, so they fail on state however long the
# deadline is.
_SCRUB_SUCCESS_DEADLINE_S = 30.0

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


@pytest.fixture(autouse=True)
def _live_app_seeds_must_be_recent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Refuse to seed a stale attachment/upload into a store that belongs to a live app.

    An app's janitor sweeps unreferenced attachments and unpromoted uploads older than 24 h
    when it starts and hourly after (`livechat.janitor.run_forever`), so a 1970-era stamp is
    reaped whenever that sweep lands between the seed and its use — an intermittent failure
    (decisions/00157). Stores built directly (no `create_app`) are unaffected: the store and
    janitor unit tests rely on historical stamps."""
    live_dbs: set[Path] = set()
    real_create_app = create_app
    real_create_attachment = LiveChatStore.create_attachment
    real_create_upload = LiveChatStore.create_upload

    def refuse_if_ancient(store: LiveChatStore, stamp: float, what: str, window_s: float) -> None:
        if store._db_path in live_dbs and stamp < time.time() - window_s:
            raise AssertionError(
                f"{what} seeded with the ancient stamp {stamp!r} into a live app's store; its "
                "janitor reaps rows older than 24 h — seed with time.time() (decisions/00157)"
            )

    def tracking_create_app(*args: Any, **kwargs: Any) -> Any:
        app = real_create_app(*args, **kwargs)
        live_dbs.add(app.state.livechat_store._db_path)
        return app

    def guarded_create_attachment(
        self: LiveChatStore, *, att_id: str, kind: AttachmentKind, now: float
    ) -> AttachmentRow:
        refuse_if_ancient(self, now, "attachment", livechat_janitor.ORPHAN_ATTACHMENT_AGE_S)
        return real_create_attachment(self, att_id=att_id, kind=kind, now=now)

    def guarded_create_upload(self: LiveChatStore, row: UploadRow) -> None:
        refuse_if_ancient(self, row.created_at, "upload", livechat_janitor.STALE_UPLOAD_AGE_S)
        real_create_upload(self, row)

    monkeypatch.setitem(globals(), "create_app", tracking_create_app)
    monkeypatch.setattr(LiveChatStore, "create_attachment", guarded_create_attachment)
    monkeypatch.setattr(LiveChatStore, "create_upload", guarded_create_upload)


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    return state


@pytest.fixture
def pin_verifier(fake_cmd_state: FakeCmdState) -> CmdPinVerifier:
    fake_app = create_fake_cmd_app(fake_cmd_state)
    return CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app))


UNLOCK_GUARD_HEADERS = {UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE}


def _unlock(
    client: TestClient, *, pin: str = TEST_PIN, headers: dict[str, str] | None = None
) -> Any:
    """The admin UI's own request shape: JSON body + the custom CSRF-guard header."""
    return client.post(
        "/api/admin/server/unlock",
        json={"pin": pin},
        headers={**UNLOCK_GUARD_HEADERS, **(headers or {})},
    )


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


def _raw_server_database_bytes(store: LiveChatStore) -> bytes:
    db_path = store._db_path
    wal_path = Path(f"{db_path}-wal")
    return db_path.read_bytes() + (wal_path.read_bytes() if wal_path.exists() else b"")


# ---------------------------------------------------------------------------
# POST /unlock -> fake-cmd mapping (§5.1)
# ---------------------------------------------------------------------------


class TestUnlockMapping:
    @pytest.mark.parametrize(
        "body",
        [
            {"Pin": TEST_PIN},
            {"pin": int(TEST_PIN)},
            {"pin": {"value": TEST_PIN}},
            [TEST_PIN],
        ],
    )
    def test_malformed_unlock_shapes_never_echo_pin_values(
        self,
        body: object,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        fake_cmd_state: FakeCmdState,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level(logging.DEBUG)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/unlock", json=body, headers=UNLOCK_GUARD_HEADERS
            )

        assert response.status_code == 422
        assert response.json() == {"error": "invalid_pin"}
        assert TEST_PIN not in response.text
        assert TEST_PIN not in caplog.text
        assert fake_cmd_state.pin_apps[TEST_APP_KEY].attempts == {}

    @pytest.mark.parametrize(
        "raw",
        [b"{not json", f'{{"pin": "{TEST_PIN}"'.encode(), b"\xff\xfe\x00", b""],
        ids=["not-json", "truncated-json-holding-the-pin", "not-utf8", "empty"],
    )
    def test_unparseable_unlock_bodies_are_one_redacted_422(
        self,
        raw: bytes,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        fake_cmd_state: FakeCmdState,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level(logging.DEBUG)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/unlock",
                content=raw,
                headers={"Content-Type": "application/json", **UNLOCK_GUARD_HEADERS},
            )

        assert response.status_code == 422
        assert response.json() == {"error": "invalid_pin"}
        assert TEST_PIN not in response.text
        assert TEST_PIN not in caplog.text
        assert fake_cmd_state.pin_apps[TEST_APP_KEY].attempts == {}

    @pytest.mark.parametrize("pin", ["12", "1234567890123456789012345678901234567890"])
    def test_invalid_pin_is_never_echoed_or_logged(
        self,
        pin: str,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        fake_cmd_state: FakeCmdState,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level(logging.DEBUG)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = _unlock(client, pin=pin)

        assert response.status_code == 422
        assert pin not in response.text
        assert pin not in caplog.text
        assert fake_cmd_state.pin_apps[TEST_APP_KEY].attempts == {}

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
        Provably unreachable via a real user (manual 4-16 ASCII digit
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
# POST /unlock CSRF guard (audit round 4, F14). Every other mutation needs the
# X-Wixy-Server-Token header, which forces a CORS preflight wixy never grants;
# /unlock runs before a token exists, so it has to earn the same property from
# a custom guard header + a strict JSON content type (+ Sec-Fetch-Site).
# ---------------------------------------------------------------------------

_WRONG_PIN = "000000"


class _CountingTransport(httpx.AsyncBaseTransport):
    """Wraps the fake-cmd transport so a test can prove cmd was never contacted."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self._inner = inner
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return await self._inner.handle_async_request(request)


def _form_style_json(pin: str) -> bytes:
    return json.dumps({"pin": pin}).encode("ascii")


# (id, request kwargs for a given PIN, the status the guard must answer with).
# A cross-site attacker page can only send a CORS "simple" request: a form or a
# no-cors fetch with one of the three simple content types and no custom header.
_REFUSED_SHAPES: list[Any] = [
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": {"Content-Type": "text/plain", **UNLOCK_GUARD_HEADERS},
        },
        415,
        id="text-plain-json-body",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": {"Content-Type": "text/plain"},
        },
        415,
        id="text-plain-form-style-post",
    ),
    pytest.param(
        lambda pin: {"data": {"pin": pin}, "headers": UNLOCK_GUARD_HEADERS},
        415,
        id="urlencoded-form",
    ),
    pytest.param(lambda pin: {"data": {"pin": pin}}, 415, id="urlencoded-form-post"),
    pytest.param(
        lambda pin: {"files": {"pin": (None, pin)}, "headers": UNLOCK_GUARD_HEADERS},
        415,
        id="multipart-form",
    ),
    pytest.param(lambda pin: {"files": {"pin": (None, pin)}}, 415, id="multipart-form-post"),
    pytest.param(
        lambda pin: {"content": _form_style_json(pin), "headers": UNLOCK_GUARD_HEADERS},
        415,
        id="missing-content-type",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": {"Content-Type": "text/json", **UNLOCK_GUARD_HEADERS},
        },
        415,
        id="text-json-is-not-application-json",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": {"Content-Type": "application/json-patch+json", **UNLOCK_GUARD_HEADERS},
        },
        415,
        id="json-suffix-lookalike",
    ),
    pytest.param(lambda pin: {"json": {"pin": pin}}, 403, id="json-without-guard-header"),
    pytest.param(
        lambda pin: {"json": {"pin": pin}, "headers": {UNLOCK_GUARD_HEADER: "0"}},
        403,
        id="json-with-wrong-guard-value",
    ),
    pytest.param(
        lambda pin: {"json": {"pin": pin}, "headers": {UNLOCK_GUARD_HEADER: ""}},
        403,
        id="json-with-empty-guard-value",
    ),
    *[
        pytest.param(
            lambda pin, site=site: {
                "json": {"pin": pin},
                "headers": {**UNLOCK_GUARD_HEADERS, "Sec-Fetch-Site": site},
            },
            403,
            id=f"sec-fetch-site-{site}",
        )
        for site in ("cross-site", "same-site", "none", "not-a-real-value")
    ],
    # Duplicated header lines (audit review L9). `headers.get` sees only the first value, so
    # a duplicate could be decided by whichever line comes first. A legitimate browser sends
    # each of these once, so a duplicate is refused outright.
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": [
                ("Content-Type", "application/json"),
                (UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE),
                ("Sec-Fetch-Site", "same-origin"),
                ("Sec-Fetch-Site", "cross-site"),
            ],
        },
        403,
        id="duplicate-sec-fetch-site-same-origin-first",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": [
                ("Content-Type", "application/json"),
                (UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE),
                ("Sec-Fetch-Site", "same-origin"),
                ("Sec-Fetch-Site", "same-origin"),
            ],
        },
        403,
        id="duplicate-sec-fetch-site-both-same-origin",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": [
                ("Content-Type", "application/json"),
                ("Content-Type", "text/plain"),
                (UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE),
            ],
        },
        415,
        id="duplicate-content-type-json-first",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": [
                ("Content-Type", "application/json"),
                (UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE),
                (UNLOCK_GUARD_HEADER, "0"),
            ],
        },
        403,
        id="duplicate-guard-header-valid-first",
    ),
    pytest.param(
        lambda pin: {
            "content": _form_style_json(pin),
            "headers": [
                ("Content-Type", "application/json"),
                (UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE),
                (UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE),
            ],
        },
        403,
        id="duplicate-guard-header-both-valid",
    ),
]


class TestUnlockRequestGuard:
    def _app(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        fake_cmd_state: FakeCmdState,
    ) -> tuple[Any, _CountingTransport]:
        transport = _CountingTransport(httpx.ASGITransport(app=create_fake_cmd_app(fake_cmd_state)))
        verifier = CmdPinVerifier(app_key=TEST_APP_KEY, transport=transport)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=verifier
        )
        return app, transport

    @pytest.mark.parametrize(("build", "expected_status"), _REFUSED_SHAPES)
    def test_shapes_a_cross_site_page_can_send_are_refused_before_cmd_is_contacted(
        self,
        build: Any,
        expected_status: int,
        storage_root: Path,
        wixy_repo_root: Path,
        fake_cmd_state: FakeCmdState,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # A WRONG pin makes the zero-attempts assertion meaningful: had the guard let
        # this through, cmd would have charged an attempt (a correct PIN would clear
        # the counter and hide it).
        caplog.set_level(logging.DEBUG)
        app, transport = self._app(storage_root, wixy_repo_root, fake_cmd_state)
        with TestClient(app) as client:
            response = client.post("/api/admin/server/unlock", **build(_WRONG_PIN))

        assert response.status_code == expected_status
        assert "token" not in response.text
        assert _WRONG_PIN not in response.text
        assert _WRONG_PIN not in caplog.text
        # Zero attempts charged on cmd — and cmd was never even called.
        assert transport.calls == 0
        assert fake_cmd_state.pin_apps[TEST_APP_KEY].attempts == {}

    def test_no_refused_shape_can_mint_a_token_even_with_the_correct_pin(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        fake_cmd_state: FakeCmdState,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level(logging.DEBUG)
        app, transport = self._app(storage_root, wixy_repo_root, fake_cmd_state)
        with TestClient(app) as client:
            responses = [
                (case.id, client.post("/api/admin/server/unlock", **case.values[0](TEST_PIN)))
                for case in _REFUSED_SHAPES
            ]

        for case_id, response in responses:
            assert response.status_code in (403, 415), case_id
            assert "token" not in response.text, case_id
            assert TEST_PIN not in response.text, case_id
        assert TEST_PIN not in caplog.text
        assert transport.calls == 0

    def test_a_flood_of_refused_requests_cannot_lock_the_owner_out(
        self, storage_root: Path, wixy_repo_root: Path, fake_cmd_state: FakeCmdState
    ) -> None:
        """The exploit the audit named: 5 wrong attempts lock cmd's subject out.
        Twenty cross-site-shaped attempts must leave the real owner able to unlock."""
        app, transport = self._app(storage_root, wixy_repo_root, fake_cmd_state)
        with TestClient(app) as client:
            for _ in range(20):
                refused = client.post(
                    "/api/admin/server/unlock",
                    content=_form_style_json(_WRONG_PIN),
                    headers={"Content-Type": "text/plain"},
                )
                assert refused.status_code == 415
            genuine = _unlock(client)

        assert genuine.status_code == 200
        assert transport.calls == 1

    @pytest.mark.parametrize(
        "content_type",
        ["application/json", "application/json; charset=utf-8", "Application/JSON;charset=UTF-8"],
    )
    @pytest.mark.parametrize("sec_fetch_site", [None, "same-origin"])
    def test_the_admin_uis_own_request_shape_still_unlocks(
        self,
        content_type: str,
        sec_fetch_site: str | None,
        storage_root: Path,
        wixy_repo_root: Path,
        fake_cmd_state: FakeCmdState,
    ) -> None:
        app, transport = self._app(storage_root, wixy_repo_root, fake_cmd_state)
        headers = {**UNLOCK_GUARD_HEADERS, "Content-Type": content_type}
        if sec_fetch_site is not None:
            headers["Sec-Fetch-Site"] = sec_fetch_site
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/unlock", content=_form_style_json(TEST_PIN), headers=headers
            )

        assert response.status_code == 200
        assert isinstance(response.json()["token"], str)
        assert transport.calls == 1

    def test_the_guard_also_covers_a_wrong_pin_from_the_real_ui_shape(
        self, storage_root: Path, wixy_repo_root: Path, fake_cmd_state: FakeCmdState
    ) -> None:
        """A genuine shape must still reach cmd and be charged exactly once."""
        app, transport = self._app(storage_root, wixy_repo_root, fake_cmd_state)
        with TestClient(app) as client:
            response = _unlock(client, pin=_WRONG_PIN, headers={"Sec-Fetch-Site": "same-origin"})

        assert response.status_code == 401
        assert response.json()["attemptsLeft"] == 4
        assert transport.calls == 1

    def test_the_standalone_edition_refuses_a_cross_site_shape_too(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No verifier there, but the guard is edition-independent: a cross-site simple
        request gets the guard's refusal, not a 503 that reveals the edition."""
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/unlock",
                content=_form_style_json(_WRONG_PIN),
                headers={"Content-Type": "text/plain"},
            )
        assert response.status_code == 415


# ---------------------------------------------------------------------------
# Every other route requires the header token; a query-string token is rejected.
# ---------------------------------------------------------------------------


class TestTokenRequired:
    def test_non_ascii_unlock_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = self._app(storage_root, wixy_repo_root, pin_verifier)

        async def send_latin1_header() -> httpx.Response:
            transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://testserver"
            ) as client:
                request = httpx.Request(
                    "GET",
                    "http://testserver/api/admin/server/messages",
                    headers=[(b"X-Wixy-Server-Token", b"\xe9.invalid")],
                )
                return await client.send(request)

        response = anyio.run(send_latin1_header)

        assert response.status_code == 401
        assert response.json() == {"error": "locked"}

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

    @pytest.mark.parametrize(("text_length", "expected_status"), [(4000, 201), (4001, 422)])
    def test_text_length_boundary(
        self,
        text_length: int,
        expected_status: int,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "text-boundary-client",
                    "sender": "J",
                    "deviceId": "device-aaaaaaaa",
                    "text": "x" * text_length,
                },
                headers=headers,
            )
            assert response.status_code == expected_status, response.text
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("sender", "expected_status"),
        [("J", 201), ("J" * 32, 201), ("J" * 33, 422), ("J\x01", 422)],
    )
    def test_sender_length_and_control_character_boundaries(
        self,
        sender: str,
        expected_status: int,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "sender-boundary-client",
                    "sender": sender,
                    "deviceId": "device-aaaaaaaa",
                    "text": "x",
                },
                headers=headers,
            )
            assert response.status_code == expected_status
        finally:
            client.__exit__(None, None, None)

    def test_a_sender_with_a_lone_utf16_surrogate_is_422_never_a_500(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Reviewer-reported H1 (see the matching reactions test for the full story): the same
        gap in `send_message`'s sender validation — a lone surrogate reaches `create_message`'s
        SQLite bind and crashes with an uncaught `UnicodeEncodeError`."""
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _raw_json_request(
                client,
                "POST",
                "/api/admin/server/messages",
                {
                    "clientId": "surrogate-sender-client",
                    "sender": "A\ud800B",
                    "deviceId": "device-aaaaaaaa",
                    "text": "hi",
                },
                headers,
            )
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("client_id_length", "expected_status"), [(8, 201), (64, 201), (65, 422)]
    )
    def test_client_id_length_boundaries(
        self,
        client_id_length: int,
        expected_status: int,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "c" * client_id_length,
                    "sender": "Josh",
                    "deviceId": "device-aaaaaaaa",
                    "text": "x",
                },
                headers=headers,
            )
            assert response.status_code == expected_status
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(("attachment_count", "expected_status"), [(10, 201), (11, 422)])
    def test_attachment_count_boundaries(
        self,
        attachment_count: int,
        expected_status: int,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(livechat_media_queue, "resolve_binaries", lambda *_args: None)
        client, headers = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            paths: ProjectPaths = client.app.state.paths  # type: ignore[attr-defined]
            attachment_ids = [f"{index + 1:032x}" for index in range(attachment_count)]
            # The live app's janitor sweeps unreferenced attachments older than 24 h at
            # startup and hourly (decisions/00157). Seed with the real clock, and force
            # a sweep now: an ancient stamp would be reaped here on every run instead
            # of only when the startup sweep happened to land before the POST.
            for attachment_id in attachment_ids:
                store.create_attachment(att_id=attachment_id, kind="photo", now=time.time())
            livechat_janitor.run_once(store=store, paths=paths, now=time.time())
            response = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "attachment-boundary-client",
                    "sender": "Josh",
                    "deviceId": "device-aaaaaaaa",
                    "text": "attachments",
                    "attachmentIds": attachment_ids,
                },
                headers=headers,
            )
            assert response.status_code == expected_status, response.text
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


class TestCrossOriginDenial:
    def test_server_mutation_preflights_do_not_grant_cross_origin_access(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        preflights = (
            ("POST", "/api/admin/server/unlock"),
            ("POST", "/api/admin/server/messages"),
            ("POST", "/api/admin/server/uploads"),
            ("DELETE", "/api/admin/server/messages/1"),
            ("POST", "/api/admin/server/wipe"),
        )

        with TestClient(app) as client:
            responses = [
                client.options(
                    path,
                    headers={
                        "Origin": "https://attacker.example",
                        "Access-Control-Request-Method": method,
                        "Access-Control-Request-Headers": (
                            "content-type,x-wixy-server-token,x-wixy-server-unlock"
                        ),
                    },
                )
                for method, path in preflights
            ]

        for response in responses:
            assert response.status_code == 405
            assert "access-control-allow-origin" not in response.headers
            assert "access-control-allow-headers" not in response.headers
            assert "access-control-allow-methods" not in response.headers

    def test_simple_cross_origin_form_post_cannot_create_a_message(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        store: LiveChatStore = app.state.livechat_store
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/messages",
                data={
                    "clientId": "cross-origin-client",
                    "sender": "Attacker",
                    "deviceId": "cross-origin-device",
                    "text": "must not be stored",
                },
                headers={"Origin": "https://attacker.example"},
            )

        assert response.status_code in {401, 422}
        messages, _has_more, _cursor = store.list_messages(before=None, limit=100)
        assert messages == []


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
    async def test_a_revoked_bound_grant_sends_locked_and_the_generator_ends(
        self, tmp_path: Path
    ) -> None:
        """§9 (audit F4): a stream whose token is bound to a device grant re-checks that
        grant's liveness on its own loop tick — a revocation reaches an OPEN connection,
        not just the next fresh request."""
        store = LiveChatStore(tmp_path / "server.db")
        store.create_device_grant(
            grant_id="a" * 32,
            secret_hash="h",
            email="josh@example.com",
            label=None,
            now=1000.0,
            max_live=5,
        )
        notifier = LiveChatNotifier()
        bound_auth = ServerAuth(
            email="josh@example.com", exp=int(time.time()) + 3600, grant_id="a" * 32
        )
        gen = _stream_events(store, notifier, _SECRET, bound_auth, after=0)
        try:
            # Revoked before the generator is ever pumped — the very first loop tick's
            # liveness check must catch it, with no need to wait out a notifier cycle.
            store.revoke_device_grant(grant_id="a" * 32, email="josh@example.com", now=time.time())
            frame = await _next_frame(gen)
            assert frame["event"] == "locked"
            assert frame["data"] == {}
            with pytest.raises(StopAsyncIteration):
                await gen.__anext__()
        finally:
            await gen.aclose()

    @pytest.mark.asyncio
    async def test_an_unrevoked_bound_grant_streams_normally(self, tmp_path: Path) -> None:
        """The liveness re-check must not false-positive on a live grant — a bound stream
        keeps working exactly like an unbound one until its grant is actually revoked."""
        store = LiveChatStore(tmp_path / "server.db")
        store.create_device_grant(
            grant_id="a" * 32,
            secret_hash="h",
            email="josh@example.com",
            label=None,
            now=time.time(),
            max_live=5,
        )
        store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="hi",
            attachment_ids=(),
            now=1000.0,
        )
        notifier = LiveChatNotifier()
        bound_auth = ServerAuth(
            email="josh@example.com", exp=int(time.time()) + 3600, grant_id="a" * 32
        )
        gen = _stream_events(store, notifier, _SECRET, bound_auth, after=0)
        try:
            frame = await _next_frame(gen)
            assert frame["event"] == "message"
            assert frame["data"]["text"] == "hi"
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


THUMBS_UP = REACTION_EMOJIS[0]
HEART = REACTION_EMOJIS[1]


def _raw_json_request(
    client: TestClient, method: str, path: str, body: dict[str, object], headers: dict[str, str]
) -> Any:
    """Posts a body built by hand from `json.dumps(..., ensure_ascii=True).encode("utf-8")`,
    bypassing `httpx`'s own `json=` kwarg — which, for a string containing a lone UTF-16
    surrogate, fails CLIENT-side with its own `UnicodeEncodeError` before a request is even
    built (verified directly against `httpx.Request(json=...)`). `ensure_ascii=True` escapes a
    surrogate as `\\uXXXX` text, so the ENCODED BYTES are plain ASCII and travel over the wire
    with no encoding error at all; the surrogate reappears as a real code point only once the
    SERVER'S `json.loads` decodes it back — exactly the shape a real client's own worst-case
    encoding (or a deliberately malicious request) can produce."""
    raw = json.dumps(body, ensure_ascii=True).encode("utf-8")
    return client.request(
        method, path, content=raw, headers={"Content-Type": "application/json", **headers}
    )


class TestReactionRoutes:
    """`PUT /messages/{seq}/reactions` (spec/server-chat/04-reactions.md): desired-state, one
    reactor + one emoji per call, `message_updated` on a real change only."""

    def _unlocked_client(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> tuple[TestClient, dict[str, str], int]:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        client = TestClient(app)
        client.__enter__()
        token = _unlock(client).json()["token"]
        headers = {"X-Wixy-Server-Token": token}
        sent = client.post(
            "/api/admin/server/messages",
            json={
                "clientId": "client-react-route",
                "sender": "Josh",
                "deviceId": "device-react-route",
                "text": "react to me",
            },
            headers=headers,
        )
        return client, headers, int(sent.json()["message"]["seq"])

    @staticmethod
    def _put(
        client: TestClient,
        headers: dict[str, str],
        seq: int,
        *,
        emoji: str = THUMBS_UP,
        sender: str = "Purdy",
        reacted: object = True,
    ) -> Any:
        return client.put(
            f"/api/admin/server/messages/{seq}/reactions",
            json={"emoji": emoji, "sender": sender, "reacted": reacted},
            headers=headers,
        )

    @staticmethod
    def _event_types(client: TestClient) -> list[str]:
        store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
        return [event.type for event in store.events_after(0)]

    def test_without_a_token_it_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = self._put(client, {}, seq)
            assert response.status_code == 401
            assert response.json() == {"error": "locked"}
            assert self._event_types(client) == ["message"]
        finally:
            client.__exit__(None, None, None)

    def test_react_returns_the_current_message_with_its_reactions_and_no_audit_fields(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = self._put(client, headers, seq)
            assert response.status_code == 200
            message = response.json()["message"]
            assert message["seq"] == seq
            assert message["reactions"] == [{"emoji": THUMBS_UP, "count": 1, "senders": ["Purdy"]}]
            assert "by_email" not in response.text
            assert "byEmail" not in response.text
        finally:
            client.__exit__(None, None, None)

    def test_a_repeat_is_idempotent_and_writes_no_second_event(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            first = self._put(client, headers, seq)
            second = self._put(client, headers, seq)
            assert first.status_code == second.status_code == 200
            assert first.json() == second.json()
            assert self._event_types(client) == ["message", "message_updated"]
        finally:
            client.__exit__(None, None, None)

    def test_reacted_false_removes_it_and_a_second_removal_is_a_no_op(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            self._put(client, headers, seq)
            removed = self._put(client, headers, seq, reacted=False)
            assert removed.status_code == 200
            assert removed.json()["message"]["reactions"] == []
            again = self._put(client, headers, seq, reacted=False)
            assert again.status_code == 200
            assert self._event_types(client) == ["message", "message_updated", "message_updated"]
        finally:
            client.__exit__(None, None, None)

    def test_the_sender_is_trimmed_and_matched_case_insensitively(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            self._put(client, headers, seq, sender="  Purdy ")
            same_person = self._put(client, headers, seq, sender="PURDY")
            assert same_person.json()["message"]["reactions"] == [
                {"emoji": THUMBS_UP, "count": 1, "senders": ["Purdy"]}
            ]
            removed = self._put(client, headers, seq, sender="purdy", reacted=False)
            assert removed.json()["message"]["reactions"] == []
        finally:
            client.__exit__(None, None, None)

    def test_a_sender_with_a_lone_utf16_surrogate_is_422_never_a_500(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Reviewer-reported H1: a lone surrogate reaches `set_reaction`'s SQLite bind
        (`store.py`'s `INSERT OR IGNORE INTO reactions`) and crashes with an uncaught
        `UnicodeEncodeError` — a bare 500, contradicting the ruling's "never a 500" for this
        route. It must be rejected as a plain 422 before the store is ever called."""
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _raw_json_request(
                client,
                "PUT",
                f"/api/admin/server/messages/{seq}/reactions",
                {"emoji": THUMBS_UP, "sender": "A\ud800B", "reacted": True},
                headers,
            )
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"
            # The rejection happened before the store was ever touched.
            assert self._event_types(client) == ["message"]
        finally:
            client.__exit__(None, None, None)

    def test_history_carries_the_reactions(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            self._put(client, headers, seq, emoji=HEART)
            history = client.get("/api/admin/server/messages", headers=headers).json()
            assert history["messages"][0]["reactions"] == [
                {"emoji": HEART, "count": 1, "senders": ["Purdy"]}
            ]
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        "emoji",
        [
            "",
            "\U0001f44e",  # thumbs down: not on the list
            "❤",  # the heart WITHOUT its variation selector: exact code points only
            THUMBS_UP + THUMBS_UP,
            THUMBS_UP + "️",
            "thumbs_up",
            " " + THUMBS_UP,
        ],
    )
    def test_an_emoji_off_the_allowlist_is_422_and_changes_nothing(
        self,
        emoji: str,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = self._put(client, headers, seq, emoji=emoji)
            assert response.status_code == 422
            assert response.json()["error"] == "invalid"
            assert self._event_types(client) == ["message"]
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        ("sender", "expected_status"),
        [("J", 200), ("J" * 32, 200), ("", 422), ("   ", 422), ("J" * 33, 422), ("J\x01", 422)],
    )
    def test_sender_follows_the_same_rules_as_send(
        self,
        sender: str,
        expected_status: int,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = self._put(client, headers, seq, sender=sender)
            assert response.status_code == expected_status, response.text
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize("reacted", ["true", 1, None])
    def test_reacted_must_be_a_real_boolean(
        self,
        reacted: object,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            assert self._put(client, headers, seq, reacted=reacted).status_code == 422
        finally:
            client.__exit__(None, None, None)

    def test_an_unknown_field_is_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.put(
                f"/api/admin/server/messages/{seq}/reactions",
                json={"emoji": THUMBS_UP, "sender": "Purdy", "reacted": True, "extra": 1},
                headers=headers,
            )
            assert response.status_code == 422
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize("seq", [999, 0, -1, 2**63, 2**80])
    def test_an_unknown_message_is_404_never_a_500(
        self,
        seq: int,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers, _seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            for reacted in (True, False):
                response = self._put(client, headers, seq, reacted=reacted)
                assert response.status_code == 404
                assert response.json() == {"error": "not_found"}
            assert self._event_types(client) == ["message"]
        finally:
            client.__exit__(None, None, None)

    def test_reacting_to_a_deleted_message_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            self._put(client, headers, seq)
            assert client.delete(
                f"/api/admin/server/messages/{seq}", headers=headers
            ).status_code in (
                202,
                204,
            )
            response = self._put(client, headers, seq)
            assert response.status_code == 404
            assert response.json() == {"error": "not_found"}
        finally:
            client.__exit__(None, None, None)

    def test_deleting_the_message_leaves_no_reaction_bytes_behind(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers, seq = self._unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            self._put(client, headers, seq, sender="Route-Reactor-3e9a1c40")
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            assert b"Route-Reactor-3e9a1c40" in _raw_server_database_bytes(store)
            assert client.delete(
                f"/api/admin/server/messages/{seq}", headers=headers
            ).status_code in (
                202,
                204,
            )
            assert store.scrub(deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
            raw = _raw_server_database_bytes(store)
            assert b"Route-Reactor-3e9a1c40" not in raw
            assert b"route-reactor-3e9a1c40" not in raw
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.asyncio
    async def test_a_reaction_streams_as_message_updated_carrying_the_reactions(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        message, _ = store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="hello",
            attachment_ids=(),
            now=1000.0,
        )
        store.set_reaction(
            seq=message.seq,
            sender="Purdy",
            by_email=None,
            emoji=THUMBS_UP,
            reacted=True,
            now=1001.0,
        )
        gen = _stream_events(store, LiveChatNotifier(), _SECRET, _FIXED_AUTH, after=1)
        try:
            frame = await _next_frame(gen)
        finally:
            await gen.aclose()
        assert frame["event"] == "message_updated"
        assert frame["id"] == 2
        assert frame["data"]["reactions"] == [
            {"emoji": THUMBS_UP, "count": 1, "senders": ["Purdy"]}
        ]

    @pytest.mark.asyncio
    async def test_a_new_message_and_its_reaction_coalesce_into_one_message_frame(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        message, _ = store.create_message(
            client_id="c1",
            sender="Josh",
            device_id="d" * 8,
            by_email=None,
            text="hello",
            attachment_ids=(),
            now=1000.0,
        )
        store.set_reaction(
            seq=message.seq,
            sender="Purdy",
            by_email=None,
            emoji=HEART,
            reacted=True,
            now=1001.0,
        )
        gen = _stream_events(store, LiveChatNotifier(), _SECRET, _FIXED_AUTH, after=0)
        try:
            frame = await _next_frame(gen)
            assert frame["event"] == "message"
            assert frame["data"]["reactions"] == [
                {"emoji": HEART, "count": 1, "senders": ["Purdy"]}
            ]
            with pytest.raises(TimeoutError):
                await _next_frame(gen, timeout_s=0.3)
        finally:
            await gen.aclose()


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
        seeded_at = time.time()
        attachment = store.create_attachment(att_id=attachment_id, kind="photo", now=seeded_at)
        message, _ = store.create_message(
            client_id="client-publish-before-cleanup",
            sender="Josh",
            device_id="device-publish-before-cleanup",
            by_email=None,
            text="erase this while another screen is open",
            attachment_ids=[attachment.id],
            now=seeded_at + 1,
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
        # Nothing here bounds a wall-clock duration (decision 00159). The route's own work takes
        # about 10 ms, so "answers within N ms" only measured how busy the machine was and failed
        # once at 1.77 s against a 0.5 s bound. Instead the guard is held for far longer than any
        # scheduling stall, and the two things that prove the route bounds its wait are asserted
        # directly: it answered while the guard was still held, and every wait it made for the
        # guard was capped by the deadline it had left.
        deadline_s = 0.05
        hold_s = 10.0
        monkeypatch.setattr(routes_livechat_module, "_DELETE_SCRUB_DEADLINE_S", deadline_s)
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

        real_scrub_guard = store.scrub_guard
        guard_waits: list[float | None] = []

        @contextmanager
        def recording_scrub_guard(*, timeout_s: float | None = None) -> Iterator[bool]:
            guard_waits.append(timeout_s)
            with real_scrub_guard(timeout_s=timeout_s) as acquired:
                yield acquired

        monkeypatch.setattr(store, "scrub_guard", recording_scrub_guard)

        lock_entered = threading.Event()
        release_lock = threading.Event()
        hold_expired = threading.Event()
        lock_done = threading.Event()

        def hold_scrub_guard() -> None:
            with real_scrub_guard() as acquired:
                assert acquired
                lock_entered.set()
                # Set before the guard is released: a route that waited the whole hold out can
                # only get the guard after this flag is visible.
                if not release_lock.wait(timeout=hold_s):
                    hold_expired.set()
            lock_done.set()

        try:
            async with anyio.create_task_group() as task_group:
                task_group.start_soon(anyio.to_thread.run_sync, hold_scrub_guard)
                assert await anyio.to_thread.run_sync(lock_entered.wait, hold_s)
                response = await routes_livechat_module.delete_message(message.seq, request)
                # The route answered while this test still held the guard: it stopped waiting at
                # its own deadline instead of waiting the guard out.
                assert not hold_expired.is_set()
                assert not lock_done.is_set()
                route_guard_waits = list(guard_waits)
                release_lock.set()
                assert response.status_code == 202
                assert store.scrub_pending()
                assert await anyio.to_thread.run_sync(lock_done.wait, hold_s)
                task_group.cancel_scope.cancel()
        finally:
            release_lock.set()

        # Never unbounded (None) and never a fixed timeout longer than the deadline. (No wait at
        # all is also valid: on a stalled machine the deadline can be spent before the first one.)
        assert all(wait is not None and wait <= deadline_s for wait in route_guard_waits)
        assert livechat_janitor.scrub_once(store=store, deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
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
        seeded_at = time.time()
        attachment = store.create_attachment(
            att_id="delete-route-attachment", kind="photo", now=seeded_at
        )
        store.create_upload(
            UploadRow(
                id=attachment.id,
                kind="photo",
                mime="image/jpeg",
                size_bytes=12,
                filename=None,
                by_email=None,
                created_at=seeded_at,
            )
        )
        message, _ = store.create_message(
            client_id="client-delete-route",
            sender="Josh",
            device_id="device-delete-route",
            by_email=None,
            text="delete-route-raw-marker-4f6a",
            attachment_ids=(attachment.id,),
            now=seeded_at + 1,
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
        livechat_janitor.scrub_once(store=store, deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
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
        scrub = store.scrub

        def observe_write_transaction(conn: sqlite3.Connection) -> str:
            marker_transactions.append(conn.in_transaction)
            return write_marker(conn)

        def observe_marker(*, deadline_s: float) -> bool:
            marker_states.append(store.scrub_pending())
            return scrub(deadline_s=deadline_s)

        monkeypatch.setattr(store, "_upsert_pending_scrub", observe_write_transaction)
        monkeypatch.setattr(store, "scrub", observe_marker)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            second_connection = sqlite3.connect(str(store._db_path), isolation_level=None)
            second_connection.execute("SELECT 1")
            try:
                response = client.delete(
                    f"/api/admin/server/messages/{message.seq}",
                    headers={"X-Wixy-Server-Token": token},
                )
                assert response.status_code == 204
                assert b"delete-marker-before-scrub-55f3" not in _raw_server_database_bytes(store)
            finally:
                second_connection.close()

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
        seeded_at = time.time()
        store.create_attachment(att_id=attachment_id, kind="photo", now=seeded_at)
        message, _ = store.create_message(
            client_id="client-delete-open-media",
            sender="Josh",
            device_id="device-delete-open-media",
            by_email=None,
            text="delete-open-media",
            attachment_ids=[attachment_id],
            now=seeded_at + 1,
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
        seeded_at = time.time()
        store.create_attachment(att_id=attachment_id, kind="photo", now=seeded_at)
        store.create_message(
            client_id="client-wipe-open-media",
            sender="Josh",
            device_id="device-wipe-open-media",
            by_email=None,
            text="wipe-open-media",
            attachment_ids=[attachment_id],
            now=seeded_at + 1,
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
        scrub = store.scrub

        def observe_write_transaction(conn: sqlite3.Connection) -> str:
            marker_transactions.append(conn.in_transaction)
            return write_marker(conn)

        def observe_marker(*, deadline_s: float) -> bool:
            marker_states.append(store.scrub_pending())
            return scrub(deadline_s=deadline_s)

        monkeypatch.setattr(store, "_upsert_pending_scrub", observe_write_transaction)
        monkeypatch.setattr(store, "scrub", observe_marker)
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            second_connection = sqlite3.connect(str(store._db_path), isolation_level=None)
            second_connection.execute("SELECT 1")
            try:
                response = client.post(
                    "/api/admin/server/wipe",
                    headers={"X-Wixy-Server-Token": token},
                    json={"confirm": "WIPE"},
                )
                assert response.status_code == 204
                assert b"wipe-marker-before-scrub-a197" not in _raw_server_database_bytes(store)
            finally:
                second_connection.close()

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
                livechat_janitor.scrub_once(store=store, deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
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
                livechat_janitor.scrub_once(store=store, deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
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
        # Real-clock stamps: a 1970-dated bare upload would be reaped by the app's startup
        # janitor sweep before the wipe under test ever removed it (decisions/00157).
        seeded_at = time.time()
        attachment = store.create_attachment(
            att_id="wipe-route-attachment", kind="voice", now=seeded_at
        )
        store.create_upload(
            UploadRow(
                id=attachment.id,
                kind="voice",
                mime="audio/webm",
                size_bytes=20,
                filename="note.webm",
                by_email=None,
                created_at=seeded_at,
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
                created_at=seeded_at,
            )
        )
        message, _ = store.create_message(
            client_id="client-wipe-route",
            sender="Purdy",
            device_id="device-wipe-route",
            by_email=None,
            text="wipe-route-raw-marker-2bc1",
            attachment_ids=(attachment.id,),
            now=seeded_at + 1,
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
        livechat_janitor.scrub_once(store=store, deadline_s=_SCRUB_SUCCESS_DEADLINE_S)
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

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("configured_env", "patched_jwks_fetch")
    async def test_cf_email_is_stored_but_absent_from_send_history_and_sse(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        keypair: tuple[Any, Any],
    ) -> None:
        private, _public = keypair
        email = "audit-owner-sentinel@example.com"
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            access_jwt = self._sign(private, email=email)
            unlocked = _unlock(client, headers={"CF-Access-Jwt-Assertion": access_jwt})
            token = unlocked.json()["token"]
            headers = {
                "CF-Access-Jwt-Assertion": access_jwt,
                "X-Wixy-Server-Token": token,
            }
            sent = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "audit-email-client",
                    "sender": "Josh",
                    "deviceId": "audit-email-device",
                    "text": "private audit event",
                },
                headers=headers,
            )
            history = client.get("/api/admin/server/messages", headers=headers)
            store: LiveChatStore = app.state.livechat_store
            saved = store.get_messages([sent.json()["message"]["seq"]])[0]
            stream = _stream_events(
                store,
                app.state.livechat_notifier,
                app.state.livechat_secret,
                ServerAuth(email=email, exp=int(time.time()) + 3600),
                after=0,
            )
            try:
                raw_sse = await stream.__anext__()
            finally:
                await stream.aclose()

        assert sent.status_code == 201
        assert saved.by_email == email
        for wire in (sent.text, history.text, raw_sse):
            assert "by_email" not in wire
            assert email not in wire

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("configured_env", "patched_jwks_fetch")
    async def test_unlock_token_is_absent_from_urls_api_media_stream_and_logs(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        keypair: tuple[Any, Any],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        private, _public = keypair
        email = "token-audit-owner@example.com"
        monkeypatch.setattr(secrets, "token_hex", lambda _n: "0123456789abcdef")
        monkeypatch.setattr(livechat_media_queue, "resolve_binaries", lambda *_args: None)
        caplog.set_level(logging.DEBUG)
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            access_jwt = self._sign(private, email=email)
            access_header = {"CF-Access-Jwt-Assertion": access_jwt}
            unlock = _unlock(client, headers=access_header)
            token = unlock.json()["token"]
            headers = {**access_header, "X-Wixy-Server-Token": token}

            store: LiveChatStore = app.state.livechat_store
            attachment_id = "b" * 32
            seeded_at = time.time()
            store.create_attachment(att_id=attachment_id, kind="photo", now=seeded_at)
            claimed = store.claim_processing(
                owner="token-audit-worker", now=seeded_at, lease_s=60.0
            )
            assert claimed is not None
            store.finish_attachment(
                att_id=attachment_id,
                owner="token-audit-worker",
                result=AttachmentResult(
                    status="ready",
                    mime="image/jpeg",
                    width=1,
                    height=1,
                    duration_s=None,
                    peaks=None,
                    renditions=("full",),
                    bytes_on_disk=12,
                    failure=None,
                ),
                now=seeded_at + 1,
            )
            media_file = app.state.paths.server_attachment_media_dir(attachment_id) / "full.jpg"
            media_file.parent.mkdir(parents=True)
            media_file.write_bytes(b"not-a-real-image; FileResponse does not decode it")

            sent = client.post(
                "/api/admin/server/messages",
                json={
                    "clientId": "token-audit-client",
                    "sender": "Josh",
                    "deviceId": "token-audit-device",
                    "text": "image",
                    "attachmentIds": [attachment_id],
                },
                headers=headers,
            )
            assert sent.status_code == 201, sent.text
            history = client.get("/api/admin/server/messages", headers=headers)
            media_url = sent.json()["message"]["attachments"][0]["urls"]["full"]
            media = client.get(media_url, headers=access_header)
            stream = _stream_events(
                store,
                app.state.livechat_notifier,
                app.state.livechat_secret,
                ServerAuth(email=email, exp=int(time.time()) + 3600),
                after=0,
            )
            try:
                raw_sse = await stream.__anext__()
            finally:
                await stream.aclose()

        assert unlock.status_code == 200
        assert token in unlock.text
        assert sent.status_code == 201
        assert history.status_code == 200
        assert media.status_code == 200
        assert token not in media_url
        for response in (sent, history, media):
            assert token not in str(response.request.url)
            body = response.content.decode("latin-1")
            assert token not in body
        assert token not in raw_sse
        assert token not in caplog.text

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
            assert client.get(status_url, headers=headers).json() == {
                "subscribed": False,
                "endpoint": None,
            }
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
            assert client.get(status_url, headers=headers).json() == {
                "subscribed": True,
                "endpoint": "https://fcm.googleapis.com/fcm/send/token",
            }

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
            assert client.get(status_url, headers=headers).json() == {
                "subscribed": False,
                "endpoint": None,
            }

            worker = client.get("/admin/server-sw.js")
            assert worker.status_code == 200
            assert worker.headers["content-type"].startswith("text/javascript")
            assert worker.headers["cache-control"] == "no-cache"
            assert worker.headers["service-worker-allowed"] == "/admin/"

    def test_a_sender_with_a_lone_utf16_surrogate_is_422_never_a_500(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """The third site the reviewer asked to be checked for H1's gap: `put_push_subscription`
        binds `sender` into `upsert_push_subscription`'s INSERT exactly like the other two
        routes, so the same lone-surrogate crash was reachable here too."""
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            response = _raw_json_request(
                client,
                "PUT",
                "/api/admin/server/push/subscriptions/device-123456",
                {
                    "sender": "A\ud800B",
                    "subscription": {
                        "endpoint": "https://fcm.googleapis.com/fcm/send/token",
                        "keys": {"p256dh": "public", "auth": "secret"},
                    },
                },
                headers,
            )
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"

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
            test_resp = client.post("/api/admin/server/push/subscriptions/device-123456/test")
            assert test_resp.status_code == 401
            assert test_resp.json() == {"error": "locked"}

    def test_push_test_unsubscribed_device_returns_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            response = client.post(
                "/api/admin/server/push/subscriptions/nonexistent-device/test",
                headers=headers,
            )
            assert response.status_code == 404
            assert response.json() == {"error": "not_found"}

    def test_push_test_rate_limited(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            device_id = "device-rl"
            store: LiveChatStore = app.state.livechat_store
            store.upsert_push_subscription(
                PushSubscriptionRow(
                    device_id=device_id,
                    sender="Alice",
                    endpoint="https://fcm.googleapis.com/fcm/send/token",
                    p256dh="pub",
                    auth="sec",
                    created_at=time.time(),
                    last_ok_at=None,
                    consecutive_failures=0,
                )
            )

            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(201, request=request)

            app.state.livechat_push_client = httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            )

            first = client.post(
                f"/api/admin/server/push/subscriptions/{device_id}/test", headers=headers
            )
            assert first.status_code == 200
            assert first.json() == {"ok": True, "statusCode": 201}

            second = client.post(
                f"/api/admin/server/push/subscriptions/{device_id}/test", headers=headers
            )
            assert second.status_code == 429
            assert second.json()["error"] == "rate_limited"
            assert "Retry-After" in second.headers

    def test_push_test_revalidates_endpoint(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            device_id = "device-bad-endpoint"
            store: LiveChatStore = app.state.livechat_store
            # Direct store insert bypassing route validation:
            store.upsert_push_subscription(
                PushSubscriptionRow(
                    device_id=device_id,
                    sender="Alice",
                    endpoint="http://unsafe.example.test/push",
                    p256dh="pub",
                    auth="sec",
                    created_at=time.time(),
                    last_ok_at=None,
                    consecutive_failures=0,
                )
            )
            response = client.post(
                f"/api/admin/server/push/subscriptions/{device_id}/test", headers=headers
            )
            assert response.status_code == 422
            assert response.json()["error"] == "invalid"

    def test_push_test_success_own_device_only(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            device_target = "device-target"
            device_other = "device-other"
            store: LiveChatStore = app.state.livechat_store
            store.upsert_push_subscription(
                PushSubscriptionRow(
                    device_id=device_target,
                    sender="Alice",
                    endpoint="https://fcm.googleapis.com/fcm/send/target-token",
                    p256dh="pub1",
                    auth="sec1",
                    created_at=time.time(),
                    last_ok_at=None,
                    consecutive_failures=0,
                )
            )
            store.upsert_push_subscription(
                PushSubscriptionRow(
                    device_id=device_other,
                    sender="Bob",
                    endpoint="https://fcm.googleapis.com/fcm/send/other-token",
                    p256dh="pub2",
                    auth="sec2",
                    created_at=time.time(),
                    last_ok_at=None,
                    consecutive_failures=0,
                )
            )

            seen: list[str] = []

            def handler(request: httpx.Request) -> httpx.Response:
                seen.append(str(request.url))
                return httpx.Response(201, request=request)

            app.state.livechat_push_client = httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            )

            # Test using the alias path as well
            response = client.post(f"/api/admin/server/push/test/{device_target}", headers=headers)
            assert response.status_code == 200
            assert response.json() == {"ok": True, "statusCode": 201}

            assert seen == ["https://fcm.googleapis.com/fcm/send/target-token"]
            target_sub = store.get_push_subscription(device_target)
            assert target_sub is not None
            assert target_sub.last_ok_at is not None
            other_sub = store.get_push_subscription(device_other)
            assert other_sub is not None
            assert other_sub.last_ok_at is None

    def test_push_test_rejected_deletes_gone_subscription(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            token = _unlock(client).json()["token"]
            headers = {"X-Wixy-Server-Token": token}
            device_gone = "device-gone"
            store: LiveChatStore = app.state.livechat_store
            store.upsert_push_subscription(
                PushSubscriptionRow(
                    device_id=device_gone,
                    sender="Alice",
                    endpoint="https://fcm.googleapis.com/fcm/send/gone-token",
                    p256dh="pub",
                    auth="sec",
                    created_at=time.time(),
                    last_ok_at=None,
                    consecutive_failures=0,
                )
            )

            def handler(request: httpx.Request) -> httpx.Response:
                return httpx.Response(410, request=request)

            app.state.livechat_push_client = httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            )

            response = client.post(
                f"/api/admin/server/push/subscriptions/{device_gone}/test", headers=headers
            )
            assert response.status_code == 200
            assert response.json() == {"ok": False, "statusCode": 410}
            assert store.get_push_subscription(device_gone) is None


class TestLiveAppSeedTimestampGuard:
    """decisions/00157: seeds older than the janitor's 24 h window are reaped mid-test."""

    def test_ancient_seeds_into_a_live_apps_store_are_refused(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        store: LiveChatStore = app.state.livechat_store

        with pytest.raises(AssertionError, match="janitor reaps rows older than 24 h"):
            store.create_attachment(att_id="1" * 32, kind="photo", now=1.0)
        with pytest.raises(AssertionError, match="janitor reaps rows older than 24 h"):
            store.create_upload(
                UploadRow(
                    id="2" * 32,
                    kind="photo",
                    mime="image/jpeg",
                    size_bytes=1,
                    filename=None,
                    by_email=None,
                    created_at=float(0),
                )
            )
        # Recent stamps are fine, and nothing was written by the refused calls.
        store.create_attachment(att_id="3" * 32, kind="photo", now=time.time())
        assert store.get_attachment("1" * 32) is None

    def test_a_store_built_directly_still_takes_historical_stamps(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "bare" / "server.db")
        assert store.create_attachment(att_id="4" * 32, kind="photo", now=1.0).id == "4" * 32
