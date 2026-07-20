"""Integration tests: the CF Access JWT middleware wired into a REAL app (spec/04 §9),
not just `verify_access_jwt` in isolation (that's `test_auth.py`'s job). A real RSA
keypair signs test JWTs; the JWKS "fetch" is monkeypatched to return that key's JWK —
zero network calls, matching this repo's zero-network-dependency test convention.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

import wixy_server.app as wixy_app_module
from wixy_server.app import create_app

_TEAM_DOMAIN = "example.cloudflareaccess.com"
_AUD = "the-configured-aud"
_KID = "integration-test-key"


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
    # `/api/version` reads THIS repo's own git HEAD (the engine's, not the site's) —
    # make it a real (if minimal) git repo, same as test_routes_version.py's fixture.
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "engine commit"], root)
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture
def configured_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WIXY_DEV_NO_AUTH", raising=False)
    monkeypatch.setenv("WIXY_CF_TEAM_DOMAIN", _TEAM_DOMAIN)
    monkeypatch.setenv("WIXY_CF_ACCESS_AUD", _AUD)


@pytest.fixture
def keypair() -> tuple[Any, Any]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture
def patched_jwks_fetch(monkeypatch: pytest.MonkeyPatch, keypair: tuple[Any, Any]) -> None:
    """Replace the real network fetch with one returning our test key's JWK — the
    same "supply a hand-crafted JWKS, zero network mocking needed at the crypto layer"
    approach as `test_auth.py`, applied one level up at the app-wiring boundary."""
    _private, public = keypair

    def _fake_fetch(_team_domain: str) -> dict[str, Any]:
        jwk = json.loads(RSAAlgorithm(RSAAlgorithm.SHA256).to_jwk(public))
        jwk["kid"] = _KID
        return {"keys": [jwk]}

    monkeypatch.setattr(wixy_app_module, "_fetch_jwks", _fake_fetch)


def _sign(private_key: Any, *, email: str = "owner@example.com", **overrides: Any) -> str:
    now = int(time.time())
    claims = {
        "aud": _AUD,
        "iss": f"https://{_TEAM_DOMAIN}",
        "exp": now + 3600,
        "iat": now,
        "email": email,
        **overrides,
    }
    return pyjwt.encode(claims, private_key, algorithm="RS256", headers={"kid": _KID})


@pytest.mark.usefixtures("configured_env", "patched_jwks_fetch")
class TestAdminGateRejectsUnauthenticated:
    def test_admin_preview_without_token_redirects_to_root(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app, follow_redirects=False) as client:
            response = client.get("/admin/preview/index.html")
        assert response.status_code == 302
        assert response.headers["location"] == "/"

    def test_api_admin_state_without_token_is_401_json(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/state")
        assert response.status_code == 401
        assert response.json()["error"] == "unauthorized"

    def test_admin_static_asset_without_token_is_redirected(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """The static mount is covered too — middleware wraps the whole ASGI app,
        not just FastAPI's own route dependency graph (decisions/00014)."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app, follow_redirects=False) as client:
            response = client.get("/admin/static/admin/admin.js")
        assert response.status_code == 302

    def test_admin_guide_asset_without_token_is_redirected(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """The guide's own mount (milestone 8, spec/independence/07) is a
        SEPARATE `StaticFiles` mount from `/admin/static` — same middleware
        coverage needs proving independently, not assumed from the other
        mount's own test above."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app, follow_redirects=False) as client:
            response = client.get("/admin/guide/start-here.html")
        assert response.status_code == 302

    def test_garbage_token_is_401(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get(
                "/api/admin/state",
                headers={"CF-Access-Jwt-Assertion": "not-a-real-jwt"},
            )
        assert response.status_code == 401


@pytest.mark.usefixtures("configured_env", "patched_jwks_fetch")
class TestAdminGateAcceptsValidToken:
    def test_valid_token_reaches_the_real_route(
        self, storage_root: Path, wixy_repo_root: Path, keypair: tuple[Any, Any]
    ) -> None:
        private, _public = keypair
        token = _sign(private)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/state", headers={"CF-Access-Jwt-Assertion": token})
        assert response.status_code == 200

    def test_wrong_audience_still_rejected_through_the_full_app(
        self, storage_root: Path, wixy_repo_root: Path, keypair: tuple[Any, Any]
    ) -> None:
        private, _public = keypair
        token = _sign(private, aud="someone-elses-aud")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/state", headers={"CF-Access-Jwt-Assertion": token})
        assert response.status_code == 401


class TestNonAdminPathsNeverGated:
    def test_api_version_reachable_without_any_token_even_when_auth_configured(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        configured_env: None,
        patched_jwks_fetch: None,
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.status_code == 200

    def test_public_root_reachable_without_any_token(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        configured_env: None,
        patched_jwks_fetch: None,
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/")
        # 503 (no live.json yet) is the CORRECT unauthenticated answer here — the
        # point is it's not 401/302, i.e. the auth gate never touched this path.
        assert response.status_code == 503
