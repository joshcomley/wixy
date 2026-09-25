"""`/api/admin/server/{device-grants,unlock-with-grant}` (spec/server-chat/
03-permanent-unlock.md §3, Inv 48) through a real app: enrolment needs the unlock token AND a
cmd-verified PIN, redemption never contacts cmd and refuses every failure with one identical
401, revocation is idempotent and identity-scoped, the request guard covers all four routes,
and a grant is bound to its CF Access identity (real JWTs, no dev bypass)."""

from __future__ import annotations

import json
import logging
import sqlite3
import subprocess
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

import wixy_server.app as wixy_app_module
from wixy_server.app import create_app
from wixy_server.livechat.grants import (
    FAILURE_LIMIT,
    GRANT_IDLE_EXPIRY_S,
    MAX_LIVE_GRANTS_PER_IDENTITY,
    GrantFailureLimiter,
    secret_hash_from_wire,
)
from wixy_server.livechat.pinclient import CmdPinVerifier, PinVerifyResult
from wixy_server.livechat.tokens import UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"
_BASE = "/api/admin/server"
_GUARD = {UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE, "Content-Type": "application/json"}


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


class SpyVerifier:
    """Delegates to the real `CmdPinVerifier` (against the fake cmd) and counts calls, so a
    test can say "cmd was never contacted" instead of inferring it."""

    def __init__(self, inner: CmdPinVerifier) -> None:
        self._inner = inner
        self.calls = 0

    async def verify(self, *, pin: str, subject: str) -> PinVerifyResult:
        self.calls += 1
        return await self._inner.verify(pin=pin, subject=subject)

    async def aclose(self) -> None:
        await self._inner.aclose()


class StubVerifier:
    def __init__(self, result: PinVerifyResult) -> None:
        self._result = result
        self.calls = 0

    async def verify(self, *, pin: str, subject: str) -> PinVerifyResult:
        self.calls += 1
        return self._result

    async def aclose(self) -> None:
        return None


@pytest.fixture
def spy(fake_cmd_state: FakeCmdState) -> SpyVerifier:
    fake_app = create_fake_cmd_app(fake_cmd_state)
    return SpyVerifier(
        CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app))
    )


@dataclass
class Env:
    client: TestClient
    app: Any
    spy: SpyVerifier
    cmd: FakeCmdState
    token: str

    @property
    def db_path(self) -> Path:
        path: Path = self.app.state.livechat_store._db_path
        return path

    def headers(self, **extra: str) -> dict[str, str]:
        return {**_GUARD, "X-Wixy-Server-Token": self.token, **extra}


@pytest.fixture
def env(
    storage_root: Path,
    wixy_repo_root: Path,
    spy: SpyVerifier,
    fake_cmd_state: FakeCmdState,
) -> Iterator[Env]:
    app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=spy)
    with TestClient(app) as client:
        unlocked = client.post(f"{_BASE}/unlock", json={"pin": TEST_PIN}, headers=_GUARD)
        assert unlocked.status_code == 200
        spy.calls = 0
        yield Env(client, app, spy, fake_cmd_state, unlocked.json()["token"])


def _rows(env: Env) -> list[sqlite3.Row]:
    conn = sqlite3.connect(str(env.db_path))
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute("SELECT * FROM device_grants ORDER BY created_at, rowid").fetchall()
    finally:
        conn.close()


def _set_last_used(env: Env, grant_id: str, value: float) -> None:
    conn = sqlite3.connect(str(env.db_path))
    try:
        conn.execute("UPDATE device_grants SET last_used_at = ? WHERE id = ?", (value, grant_id))
        conn.commit()
    finally:
        conn.close()


def _enroll(env: Env, *, label: str | None = "Android · Chrome") -> dict[str, Any]:
    response = env.client.post(
        f"{_BASE}/device-grants", json={"pin": TEST_PIN, "label": label}, headers=env.headers()
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def _redeem(env: Env, grant: dict[str, Any], **headers: str) -> Any:
    return env.client.post(
        f"{_BASE}/unlock-with-grant",
        json={"grantId": grant["grantId"], "secret": grant["secret"]},
        headers={**_GUARD, **headers},
    )


def _refusal(response: Any) -> tuple[int, bytes]:
    return response.status_code, response.content


# ---------------------------------------------------------------------------
# POST /device-grants
# ---------------------------------------------------------------------------


class TestEnrolment:
    def test_a_token_and_the_right_pin_create_a_grant(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants",
            json={"pin": TEST_PIN, "label": "Android · Chrome"},
            headers=env.headers(),
        )
        assert response.status_code == 201
        body = response.json()
        assert set(body) == {"grantId", "secret", "token", "expiresAt"}
        assert len(body["grantId"]) == 32 and int(body["grantId"], 16) >= 0
        assert len(body["secret"]) == 43
        assert body["expiresAt"] > time.time() + 11 * 3600
        assert env.spy.calls == 1

    def test_the_response_is_not_cacheable(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants", json={"pin": TEST_PIN}, headers=env.headers()
        )
        assert response.headers["cache-control"] == "no-store"

    def test_the_token_it_returns_unlocks_the_chat(self, env: Env) -> None:
        grant = _enroll(env)
        history = env.client.get(
            f"{_BASE}/messages", headers={"X-Wixy-Server-Token": grant["token"]}
        )
        assert history.status_code == 200

    def test_the_stored_row_holds_a_hash_the_email_and_a_label_only(self, env: Env) -> None:
        grant = _enroll(env, label="  Android · Chrome  ")
        (row,) = _rows(env)
        assert row["id"] == grant["grantId"]
        assert row["secret_hash"] == secret_hash_from_wire(grant["secret"])
        assert row["email"] == ""
        assert row["label"] == "Android · Chrome"
        assert row["revoked_at"] is None
        assert row["created_at"] == row["last_used_at"]

    def test_no_label_is_fine(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants", json={"pin": TEST_PIN}, headers=env.headers()
        )
        assert response.status_code == 201
        assert _rows(env)[0]["label"] is None

    def test_no_token_is_locked_and_cmd_is_never_asked(self, env: Env) -> None:
        response = env.client.post(f"{_BASE}/device-grants", json={"pin": TEST_PIN}, headers=_GUARD)
        assert response.status_code == 401
        assert response.json() == {"error": "locked"}
        assert env.spy.calls == 0
        assert _rows(env) == []

    def test_a_garbage_token_is_locked_and_cmd_is_never_asked(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants",
            json={"pin": TEST_PIN},
            headers={**_GUARD, "X-Wixy-Server-Token": "not.a-token"},
        )
        assert response.status_code == 401
        assert env.spy.calls == 0
        assert _rows(env) == []

    def test_a_grant_secret_is_not_an_unlock_token(self, env: Env) -> None:
        grant = _enroll(env)
        response = env.client.post(
            f"{_BASE}/device-grants",
            json={"pin": TEST_PIN},
            headers={**_GUARD, "X-Wixy-Server-Token": grant["secret"]},
        )
        assert response.status_code == 401

    def test_a_wrong_pin_charges_an_attempt_and_creates_no_grant(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants", json={"pin": "000000"}, headers=env.headers()
        )
        assert response.status_code == 401
        assert response.json() == {"error": "wrong_pin", "attemptsLeft": 4}
        assert env.cmd.pin_apps[TEST_APP_KEY].attempts == {"": 1}
        assert _rows(env) == []

    def test_repeated_wrong_pins_end_in_cmds_lockout_and_never_a_grant(self, env: Env) -> None:
        statuses = [
            env.client.post(f"{_BASE}/device-grants", json={"pin": "000000"}, headers=env.headers())
            for _ in range(5)
        ]
        assert [r.status_code for r in statuses[:4]] == [401] * 4
        assert statuses[4].status_code == 429
        assert statuses[4].json()["error"] == "locked_out"
        assert int(statuses[4].headers["retry-after"]) >= 1
        # Locked: even the right PIN is refused, and still no grant.
        again = env.client.post(
            f"{_BASE}/device-grants", json={"pin": TEST_PIN}, headers=env.headers()
        )
        assert again.status_code == 429
        assert _rows(env) == []

    def test_pin_changed_is_409(self, env: Env) -> None:
        env.cmd.pin_apps[TEST_APP_KEY].simulate_pin_changed_once = True
        response = env.client.post(
            f"{_BASE}/device-grants", json={"pin": TEST_PIN}, headers=env.headers()
        )
        assert response.status_code == 409
        assert response.json() == {"error": "pin_changed"}
        assert _rows(env) == []

    @pytest.mark.parametrize(
        ("outcome", "status", "error"),
        [
            ("unavailable", 503, "pin_service_unavailable"),
            ("not_configured", 503, "not_configured"),
            ("invalid_request", 422, "invalid"),
        ],
    )
    def test_cmd_outcomes_map_exactly_like_unlock(
        self,
        outcome: Any,
        status: int,
        error: str,
        storage_root: Path,
        wixy_repo_root: Path,
    ) -> None:
        stub = StubVerifier(PinVerifyResult(outcome=outcome))
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=stub
        )
        with TestClient(app) as client:
            unlocked_stub = StubVerifier(PinVerifyResult(outcome="ok"))
            app.state.livechat_pin_verifier = unlocked_stub
            token = client.post(f"{_BASE}/unlock", json={"pin": TEST_PIN}, headers=_GUARD).json()[
                "token"
            ]
            app.state.livechat_pin_verifier = stub
            response = client.post(
                f"{_BASE}/device-grants",
                json={"pin": TEST_PIN},
                headers={**_GUARD, "X-Wixy-Server-Token": token},
            )
            unlock_response = client.post(f"{_BASE}/unlock", json={"pin": TEST_PIN}, headers=_GUARD)
        assert response.status_code == status
        assert response.json()["error"] == error
        assert (response.status_code, response.json()) == (
            unlock_response.status_code,
            unlock_response.json(),
        )
        conn = sqlite3.connect(str(app.state.livechat_store._db_path))
        try:
            assert conn.execute("SELECT COUNT(*) FROM device_grants").fetchone()[0] == 0
        finally:
            conn.close()

    def test_standalone_edition_without_a_pin_service_cannot_enrol(
        self, storage_root: Path, wixy_repo_root: Path, spy: SpyVerifier
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=spy)
        with TestClient(app) as client:
            token = client.post(f"{_BASE}/unlock", json={"pin": TEST_PIN}, headers=_GUARD).json()[
                "token"
            ]
            app.state.livechat_pin_verifier = None
            response = client.post(
                f"{_BASE}/device-grants",
                json={"pin": TEST_PIN},
                headers={**_GUARD, "X-Wixy-Server-Token": token},
            )
        assert response.status_code == 503
        assert response.json() == {"error": "not_configured"}

    @pytest.mark.parametrize(
        "pin", ["12", "1" * 17, "12ab", "１２３４", "", None, 4829, ["4829"], {"pin": "4829"}]
    )
    def test_a_malformed_pin_is_a_422_and_charges_nothing(self, env: Env, pin: object) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants", json={"pin": pin}, headers=env.headers()
        )
        assert response.status_code == 422
        assert response.json() == {"error": "invalid_pin"}
        assert env.spy.calls == 0
        assert env.cmd.pin_apps[TEST_APP_KEY].attempts == {}
        assert _rows(env) == []

    @pytest.mark.parametrize(
        "raw", [b"{nope", b"", b"\xff\xfe", b"[1]", b'"pin"', b"null"], ids=lambda r: repr(r)
    )
    def test_an_unparseable_body_is_a_422(self, env: Env, raw: bytes) -> None:
        response = env.client.post(f"{_BASE}/device-grants", content=raw, headers=env.headers())
        assert response.status_code == 422
        assert env.spy.calls == 0

    @pytest.mark.parametrize("label", [7, ["x"], {"a": 1}, "x" * 81, True])
    def test_a_bad_label_is_refused_before_cmd_is_asked(self, env: Env, label: object) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants", json={"pin": TEST_PIN, "label": label}, headers=env.headers()
        )
        assert response.status_code == 422
        assert response.json()["error"] == "invalid"
        assert env.spy.calls == 0
        assert _rows(env) == []

    def test_a_sixth_grant_revokes_the_oldest(self, env: Env) -> None:
        grants = [_enroll(env) for _ in range(MAX_LIVE_GRANTS_PER_IDENTITY)]
        assert all(_redeem(env, g).status_code == 200 for g in grants)
        newest = _enroll(env)
        assert _redeem(env, grants[0]).status_code == 401
        assert all(_redeem(env, g).status_code == 200 for g in grants[1:])
        assert _redeem(env, newest).status_code == 200
        assert sum(1 for row in _rows(env) if row["revoked_at"] is not None) == 1

    def test_neither_the_pin_nor_the_secret_reaches_a_log_or_the_database(
        self, env: Env, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        wrong = env.client.post(
            f"{_BASE}/device-grants", json={"pin": "999999"}, headers=env.headers()
        )
        grant = _enroll(env)
        _redeem(env, grant)
        _redeem(env, {**grant, "secret": "A" * 43})
        raw = env.db_path.read_bytes()
        wal = Path(f"{env.db_path}-wal")
        if wal.exists():
            raw += wal.read_bytes()
        assert TEST_PIN not in caplog.text and "999999" not in caplog.text
        assert grant["secret"] not in caplog.text
        assert grant["token"] not in caplog.text
        assert grant["secret"].encode("ascii") not in raw
        assert "999999" not in wrong.text


# ---------------------------------------------------------------------------
# POST /unlock-with-grant
# ---------------------------------------------------------------------------


class TestRedemption:
    def test_a_grant_mints_a_working_token_without_a_pin_or_cmd(self, env: Env) -> None:
        grant = _enroll(env)
        env.spy.calls = 0
        attempts_before = dict(env.cmd.pin_apps[TEST_APP_KEY].attempts)

        response = _redeem(env, grant)

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"token", "expiresAt"}
        assert body["expiresAt"] > time.time() + 11 * 3600
        assert env.spy.calls == 0
        assert env.cmd.pin_apps[TEST_APP_KEY].attempts == attempts_before
        history = env.client.get(
            f"{_BASE}/messages", headers={"X-Wixy-Server-Token": body["token"]}
        )
        assert history.status_code == 200

    def test_it_needs_no_unlock_token_because_the_device_is_locked_when_it_asks(
        self, env: Env
    ) -> None:
        grant = _enroll(env)
        response = env.client.post(
            f"{_BASE}/unlock-with-grant",
            json={"grantId": grant["grantId"], "secret": grant["secret"]},
            headers=_GUARD,
        )
        assert response.status_code == 200

    def test_the_response_is_not_cacheable(self, env: Env) -> None:
        assert _redeem(env, _enroll(env)).headers["cache-control"] == "no-store"

    def test_it_stamps_last_used_at(self, env: Env) -> None:
        grant = _enroll(env)
        an_hour_ago = time.time() - 3600
        _set_last_used(env, grant["grantId"], an_hour_ago)
        assert _redeem(env, grant).status_code == 200
        assert _rows(env)[0]["last_used_at"] > time.time() - 60

    def test_a_grant_can_be_used_again_and_again(self, env: Env) -> None:
        grant = _enroll(env)
        assert [_redeem(env, grant).status_code for _ in range(3)] == [200, 200, 200]

    def test_every_refusal_is_one_identical_401(self, env: Env) -> None:
        grant = _enroll(env)
        revoked = _enroll(env)
        env.client.delete(f"{_BASE}/device-grants/{revoked['grantId']}", headers=env.headers())
        idle = _enroll(env)
        _set_last_used(env, idle["grantId"], time.time() - GRANT_IDLE_EXPIRY_S - 60)
        good_secret = grant["secret"]
        other_secret = _enroll(env)["secret"]

        bodies: dict[str, object] = {
            "unknown id": {"grantId": "0" * 32, "secret": good_secret},
            "wrong secret": {"grantId": grant["grantId"], "secret": other_secret},
            "revoked": {"grantId": revoked["grantId"], "secret": revoked["secret"]},
            "idle over 30 days": {"grantId": idle["grantId"], "secret": idle["secret"]},
            "id not hex": {"grantId": "Z" * 32, "secret": good_secret},
            "id too short": {"grantId": "abc", "secret": good_secret},
            "id uppercase": {"grantId": grant["grantId"].upper(), "secret": good_secret},
            "id traversal": {"grantId": "../../../../etc/passwd", "secret": good_secret},
            "secret too short": {"grantId": grant["grantId"], "secret": "abc"},
            "secret standard base64": {"grantId": grant["grantId"], "secret": "+" * 43},
            "secret padded": {"grantId": grant["grantId"], "secret": good_secret + "="},
            "secret missing": {"grantId": grant["grantId"]},
            "id missing": {"secret": good_secret},
            "empty object": {},
            "numbers": {"grantId": 1, "secret": 2},
            "nulls": {"grantId": None, "secret": None},
            "lists": {"grantId": [grant["grantId"]], "secret": [good_secret]},
        }
        seen: dict[str, tuple[int, bytes]] = {}
        for name, body in bodies.items():
            # A fresh limiter per case: this test is about the response, not the rate limit.
            env.app.state.livechat_grant_limiter = GrantFailureLimiter()
            seen[name] = _refusal(
                env.client.post(f"{_BASE}/unlock-with-grant", json=body, headers=_GUARD)
            )
        assert set(seen.values()) == {(401, b'{"error":"grant_invalid"}')}, seen
        # ...and none of them broke the real grant.
        assert _redeem(env, grant).status_code == 200

    def test_a_refusal_never_touches_cmd(self, env: Env) -> None:
        env.client.post(
            f"{_BASE}/unlock-with-grant",
            json={"grantId": "0" * 32, "secret": "A" * 43},
            headers=_GUARD,
        )
        assert env.spy.calls == 0

    def test_a_grant_idle_for_exactly_thirty_days_still_works_and_a_day_more_does_not(
        self, env: Env
    ) -> None:
        grant = _enroll(env)
        _set_last_used(env, grant["grantId"], time.time() - GRANT_IDLE_EXPIRY_S + 30)
        assert _redeem(env, grant).status_code == 200
        _set_last_used(env, grant["grantId"], time.time() - GRANT_IDLE_EXPIRY_S - 86_400)
        assert _redeem(env, grant).status_code == 401

    @pytest.mark.parametrize("raw", [b"{nope", b"", b"\xff\xfe", b"[1]", b"null"])
    def test_an_unparseable_body_is_a_422_and_not_a_counted_failure(
        self, env: Env, raw: bytes
    ) -> None:
        response = env.client.post(f"{_BASE}/unlock-with-grant", content=raw, headers=_GUARD)
        assert response.status_code == 422
        grant = _enroll(env)
        for _ in range(FAILURE_LIMIT * 2):
            env.client.post(f"{_BASE}/unlock-with-grant", content=raw, headers=_GUARD)
        assert _redeem(env, grant).status_code == 200

    def test_ten_failures_a_minute_end_in_429_even_for_a_valid_grant(self, env: Env) -> None:
        grant = _enroll(env)
        bad = {"grantId": grant["grantId"], "secret": "A" * 43}
        statuses = [
            env.client.post(f"{_BASE}/unlock-with-grant", json=bad, headers=_GUARD).status_code
            for _ in range(FAILURE_LIMIT)
        ]
        assert statuses == [401] * FAILURE_LIMIT

        limited = env.client.post(f"{_BASE}/unlock-with-grant", json=bad, headers=_GUARD)
        assert limited.status_code == 429
        assert limited.json()["error"] == "rate_limited"
        assert 1 <= limited.json()["retryAfterS"] <= 60
        assert limited.headers["retry-after"] == str(limited.json()["retryAfterS"])

        valid = _redeem(env, grant)
        assert valid.status_code == 429
        assert "token" not in valid.json()

    def test_nine_failures_leave_the_valid_grant_working(self, env: Env) -> None:
        grant = _enroll(env)
        bad = {"grantId": grant["grantId"], "secret": "A" * 43}
        for _ in range(FAILURE_LIMIT - 1):
            env.client.post(f"{_BASE}/unlock-with-grant", json=bad, headers=_GUARD)
        assert _redeem(env, grant).status_code == 200

    def test_a_success_is_not_counted_as_a_failure(self, env: Env) -> None:
        grant = _enroll(env)
        for _ in range(FAILURE_LIMIT * 3):
            assert _redeem(env, grant).status_code == 200

    def test_the_limit_expires(self, env: Env) -> None:
        grant = _enroll(env)
        limiter = env.app.state.livechat_grant_limiter
        for _ in range(FAILURE_LIMIT):
            limiter.record_failure("", time.monotonic() - 61)
        assert _redeem(env, grant).status_code == 200


# ---------------------------------------------------------------------------
# DELETE /device-grants/{id} and DELETE /device-grants
# ---------------------------------------------------------------------------


class TestRevocation:
    def test_revoking_a_grant_stops_it_working(self, env: Env) -> None:
        grant = _enroll(env)
        response = env.client.delete(
            f"{_BASE}/device-grants/{grant['grantId']}", headers=env.headers()
        )
        assert response.status_code == 204
        assert response.content == b""
        assert _redeem(env, grant).status_code == 401
        assert _rows(env)[0]["revoked_at"] is not None

    def test_revoking_twice_is_still_204(self, env: Env) -> None:
        grant = _enroll(env)
        url = f"{_BASE}/device-grants/{grant['grantId']}"
        assert env.client.delete(url, headers=env.headers()).status_code == 204
        assert env.client.delete(url, headers=env.headers()).status_code == 204

    def test_a_revoked_grant_does_not_disturb_the_others(self, env: Env) -> None:
        keep, drop = _enroll(env), _enroll(env)
        env.client.delete(f"{_BASE}/device-grants/{drop['grantId']}", headers=env.headers())
        assert _redeem(env, keep).status_code == 200

    def test_the_token_that_authorised_the_revoke_keeps_working(self, env: Env) -> None:
        grant = _enroll(env)
        env.client.delete(f"{_BASE}/device-grants/{grant['grantId']}", headers=env.headers())
        history = env.client.get(f"{_BASE}/messages", headers={"X-Wixy-Server-Token": env.token})
        assert history.status_code == 200

    @pytest.mark.parametrize("bad_id", ["f" * 32, "abc", "%2e%2e", "Z" * 32, "A" * 32, "x" * 300])
    def test_an_unknown_or_malformed_id_is_404(self, env: Env, bad_id: str) -> None:
        keep = _enroll(env)
        response = env.client.delete(f"{_BASE}/device-grants/{bad_id}", headers=env.headers())
        assert response.status_code == 404
        assert response.json() == {"error": "not_found"}
        assert _redeem(env, keep).status_code == 200

    def test_revoking_needs_a_token(self, env: Env) -> None:
        grant = _enroll(env)
        response = env.client.delete(f"{_BASE}/device-grants/{grant['grantId']}", headers=_GUARD)
        assert response.status_code == 401
        assert _redeem(env, grant).status_code == 200

    def test_sign_out_everywhere_revokes_every_grant(self, env: Env) -> None:
        grants = [_enroll(env) for _ in range(3)]
        response = env.client.delete(f"{_BASE}/device-grants", headers=env.headers())
        assert response.status_code == 204
        assert all(_redeem(env, g).status_code == 401 for g in grants)
        assert all(row["revoked_at"] is not None for row in _rows(env))

    def test_sign_out_everywhere_with_nothing_to_revoke_is_still_204(self, env: Env) -> None:
        assert env.client.delete(f"{_BASE}/device-grants", headers=env.headers()).status_code == 204

    def test_sign_out_everywhere_needs_a_token(self, env: Env) -> None:
        grant = _enroll(env)
        assert env.client.delete(f"{_BASE}/device-grants", headers=_GUARD).status_code == 401
        assert _redeem(env, grant).status_code == 200


# ---------------------------------------------------------------------------
# The unlock request guard covers all four routes (§3: "Each one runs the §5.1 v1.6 unlock
# request guard first").
# ---------------------------------------------------------------------------

_VIOLATIONS: dict[str, tuple[dict[str, str], int, str]] = {
    "no guard header": ({UNLOCK_GUARD_HEADER: ""}, 403, "forbidden"),
    "wrong guard value": ({UNLOCK_GUARD_HEADER: "0"}, 403, "forbidden"),
    "cross-site": ({"Sec-Fetch-Site": "cross-site"}, 403, "forbidden"),
    "same-site": ({"Sec-Fetch-Site": "same-site"}, 403, "forbidden"),
    "text/plain": ({"Content-Type": "text/plain"}, 415, "unsupported_media_type"),
    "form-encoded": (
        {"Content-Type": "application/x-www-form-urlencoded"},
        415,
        "unsupported_media_type",
    ),
}


class TestRequestGuard:
    @pytest.mark.parametrize("violation", list(_VIOLATIONS))
    @pytest.mark.parametrize(
        "route",
        [
            "POST /device-grants",
            "POST /unlock-with-grant",
            "DELETE /device-grants/{id}",
            "DELETE /device-grants",
        ],
    )
    def test_a_request_a_cross_site_page_could_send_changes_nothing(
        self, env: Env, route: str, violation: str
    ) -> None:
        grant = _enroll(env)
        before = _rows(env)
        overrides, status, error = _VIOLATIONS[violation]
        headers = env.headers()
        headers.update(overrides)
        if overrides.get(UNLOCK_GUARD_HEADER) == "":
            headers.pop(UNLOCK_GUARD_HEADER)
        method, path = route.split(" ")
        path = path.replace("{id}", grant["grantId"])
        body = (
            {"pin": TEST_PIN}
            if route == "POST /device-grants"
            else {"grantId": grant["grantId"], "secret": grant["secret"]}
        )
        env.spy.calls = 0

        response = env.client.request(
            method,
            f"{_BASE}{path}",
            content=json.dumps(body).encode() if method == "POST" else None,
            headers=headers,
        )

        assert response.status_code == status
        assert response.json() == {"error": error}
        assert env.spy.calls == 0
        assert env.cmd.pin_apps[TEST_APP_KEY].attempts == {}
        assert [tuple(r) for r in _rows(env)] == [tuple(r) for r in before]
        # A refused request must not have been counted against the failure limiter either.
        assert env.app.state.livechat_grant_limiter._failures == {}
        assert _redeem(env, grant).status_code == 200

    def test_the_guard_runs_before_the_token_check(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants",
            json={"pin": TEST_PIN},
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 403
        assert env.spy.calls == 0

    def test_a_browser_same_origin_request_passes(self, env: Env) -> None:
        response = env.client.post(
            f"{_BASE}/device-grants",
            json={"pin": TEST_PIN},
            headers=env.headers(**{"Sec-Fetch-Site": "same-origin"}),
        )
        assert response.status_code == 201


# ---------------------------------------------------------------------------
# A grant is bound to the CF Access identity that created it — real JWTs, no dev bypass.
# ---------------------------------------------------------------------------


class TestIdentityBinding:
    _TEAM_DOMAIN = "example.cloudflareaccess.com"
    _AUD = "the-configured-aud"
    _KID = "grants-test-key"

    @pytest.fixture(autouse=True)
    def _dev_no_auth(self) -> None:
        """Shadows the module-level autouse fixture: these tests need REAL CF Access."""
        return None

    @pytest.fixture
    def keypair(self) -> Any:
        return rsa.generate_private_key(public_exponent=65537, key_size=2048)

    @pytest.fixture(autouse=True)
    def _configured(self, monkeypatch: pytest.MonkeyPatch, keypair: Any) -> None:
        monkeypatch.delenv("WIXY_DEV_NO_AUTH", raising=False)
        monkeypatch.setenv("WIXY_CF_TEAM_DOMAIN", self._TEAM_DOMAIN)
        monkeypatch.setenv("WIXY_CF_ACCESS_AUD", self._AUD)
        public = keypair.public_key()

        def _fake_fetch(_team_domain: str) -> dict[str, Any]:
            jwk = json.loads(RSAAlgorithm(RSAAlgorithm.SHA256).to_jwk(public))
            jwk["kid"] = self._KID
            return {"keys": [jwk]}

        monkeypatch.setattr(wixy_app_module, "_fetch_jwks", _fake_fetch)

    def _jwt(self, keypair: Any, email: str) -> dict[str, str]:
        now = int(time.time())
        claims = {
            "aud": self._AUD,
            "iss": f"https://{self._TEAM_DOMAIN}",
            "exp": now + 3600,
            "iat": now,
            "email": email,
        }
        token = pyjwt.encode(claims, keypair, algorithm="RS256", headers={"kid": self._KID})
        return {"CF-Access-Jwt-Assertion": token}

    @pytest.fixture
    def two_identities(
        self, storage_root: Path, wixy_repo_root: Path, spy: SpyVerifier, keypair: Any
    ) -> Iterator[tuple[TestClient, Any, dict[str, str], dict[str, str]]]:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=spy)
        with TestClient(app) as client:
            yield (
                client,
                app,
                self._jwt(keypair, "purdy@example.com"),
                self._jwt(keypair, "josh@example.com"),
            )

    def _unlock(self, client: TestClient, identity: dict[str, str]) -> str:
        response = client.post(
            f"{_BASE}/unlock", json={"pin": TEST_PIN}, headers={**_GUARD, **identity}
        )
        assert response.status_code == 200, response.text
        return str(response.json()["token"])

    def _enroll(self, client: TestClient, identity: dict[str, str], token: str) -> dict[str, Any]:
        response = client.post(
            f"{_BASE}/device-grants",
            json={"pin": TEST_PIN},
            headers={**_GUARD, **identity, "X-Wixy-Server-Token": token},
        )
        assert response.status_code == 201, response.text
        body: dict[str, Any] = response.json()
        return body

    def _redeem(self, client: TestClient, identity: dict[str, str], grant: dict[str, Any]) -> Any:
        return client.post(
            f"{_BASE}/unlock-with-grant",
            json={"grantId": grant["grantId"], "secret": grant["secret"]},
            headers={**_GUARD, **identity},
        )

    def test_the_grant_records_the_identity_that_enrolled_it(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, app, purdy, _josh = two_identities
        self._enroll(client, purdy, self._unlock(client, purdy))
        conn = sqlite3.connect(str(app.state.livechat_store._db_path))
        try:
            assert conn.execute("SELECT email FROM device_grants").fetchall() == [
                ("purdy@example.com",)
            ]
        finally:
            conn.close()

    def test_another_identity_cannot_redeem_a_grant_it_somehow_obtained(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, _app, purdy, josh = two_identities
        grant = self._enroll(client, purdy, self._unlock(client, purdy))

        stolen = self._redeem(client, josh, grant)
        own = self._redeem(client, purdy, grant)

        assert (stolen.status_code, stolen.content) == (401, b'{"error":"grant_invalid"}')
        assert own.status_code == 200

    def test_a_token_minted_from_a_grant_is_bound_to_that_identity(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, _app, purdy, josh = two_identities
        grant = self._enroll(client, purdy, self._unlock(client, purdy))
        token = self._redeem(client, purdy, grant).json()["token"]

        as_purdy = client.get(f"{_BASE}/messages", headers={**purdy, "X-Wixy-Server-Token": token})
        as_josh = client.get(f"{_BASE}/messages", headers={**josh, "X-Wixy-Server-Token": token})

        assert as_purdy.status_code == 200
        assert as_josh.status_code == 401

    def test_another_identity_cannot_revoke_someone_elses_grant(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, _app, purdy, josh = two_identities
        grant = self._enroll(client, purdy, self._unlock(client, purdy))
        josh_token = self._unlock(client, josh)

        response = client.delete(
            f"{_BASE}/device-grants/{grant['grantId']}",
            headers={**_GUARD, **josh, "X-Wixy-Server-Token": josh_token},
        )

        assert response.status_code == 404
        assert response.json() == {"error": "not_found"}
        assert self._redeem(client, purdy, grant).status_code == 200

    def test_sign_out_everywhere_only_signs_out_the_asking_identity(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, _app, purdy, josh = two_identities
        purdys = self._enroll(client, purdy, self._unlock(client, purdy))
        joshs = self._enroll(client, josh, self._unlock(client, josh))

        response = client.delete(
            f"{_BASE}/device-grants",
            headers={**_GUARD, **josh, "X-Wixy-Server-Token": self._unlock(client, josh)},
        )

        assert response.status_code == 204
        assert self._redeem(client, josh, joshs).status_code == 401
        assert self._redeem(client, purdy, purdys).status_code == 200

    def test_the_cap_of_five_is_per_identity(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, _app, purdy, josh = two_identities
        purdy_token = self._unlock(client, purdy)
        purdys = [
            self._enroll(client, purdy, purdy_token) for _ in range(MAX_LIVE_GRANTS_PER_IDENTITY)
        ]
        joshs = self._enroll(client, josh, self._unlock(client, josh))
        assert all(self._redeem(client, purdy, g).status_code == 200 for g in purdys)
        assert self._redeem(client, josh, joshs).status_code == 200

    def test_failures_are_limited_per_identity(
        self, two_identities: tuple[TestClient, Any, dict[str, str], dict[str, str]]
    ) -> None:
        client, _app, purdy, josh = two_identities
        grant = self._enroll(client, purdy, self._unlock(client, purdy))
        junk = {"grantId": "0" * 32, "secret": "A" * 43}
        for _ in range(FAILURE_LIMIT):
            client.post(f"{_BASE}/unlock-with-grant", json=junk, headers={**_GUARD, **josh})

        limited = client.post(f"{_BASE}/unlock-with-grant", json=junk, headers={**_GUARD, **josh})

        assert limited.status_code == 429
        assert self._redeem(client, purdy, grant).status_code == 200
