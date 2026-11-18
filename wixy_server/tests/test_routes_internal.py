"""`/healthz`, `/internal/ready`, `/internal/warmup` tests (spec/04 §9-10) — the
loopback-only guard is the security-relevant behavior here."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


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
    return root


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


class TestReadyAndHealthz:
    def test_ready_is_ok_even_with_no_live_pointer_yet(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """spec/04 §3 treats "no live.json yet" as a real, transient, non-crashing
        state — readiness is about the server functioning, not the site being live."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/ready")
        assert response.status_code == 200
        assert response.json() == {"ready": True}

    def test_healthz_is_an_alias_of_ready(self, storage_root: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/healthz")
        assert response.status_code == 200
        assert response.json() == {"ready": True}

    def test_ready_rejects_requests_carrying_cf_ray_header(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/ready", headers={"Cf-Ray": "abc123"})
        assert response.status_code == 404

    def test_healthz_rejects_requests_carrying_cf_connecting_ip_header(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/healthz", headers={"Cf-Connecting-Ip": "1.2.3.4"})
        assert response.status_code == 404

    def test_ready_without_edge_headers_is_not_affected(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        """A loopback probe never carries CF edge headers — confirms the guard is
        specifically about those headers, not a blanket block."""
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/ready", headers={"X-Something-Else": "1"})
        assert response.status_code == 200


class TestWarmup:
    def test_warmup_succeeds_and_fetches_the_checkout(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post("/internal/warmup")
        assert response.status_code == 200
        assert response.json() == {"warm": True}

    def test_warmup_rejects_requests_carrying_cf_ray_header(
        self, storage_root: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post("/internal/warmup", headers={"Cf-Ray": "abc123"})
        assert response.status_code == 404

    def test_warmup_returns_503_when_checkout_cannot_be_reached(
        self, tmp_path: Path, storage_root: Path
    ) -> None:
        wixy_repo_root = tmp_path / "wixy-repo-broken"
        (wixy_repo_root / "projects").mkdir(parents=True)
        (wixy_repo_root / "projects" / "test.json").write_text(
            json.dumps(
                {
                    "slug": "test",
                    "name": "test",
                    "repo": str(tmp_path / "does-not-exist"),
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
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.post("/internal/warmup")
        assert response.status_code == 503


class TestCookoutModes:
    """`GET /internal/cookout/modes`: what `tooling/cookout/activate_modes.py` reads instead of the
    token-gated options route (the in-app unlock token needs a PIN no agent can enter)."""

    def test_it_lists_classic_alone_until_a_mode_is_switched_on(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WIXY_COOKOUT_MODES", raising=False)
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/cookout/modes")
        assert response.status_code == 200
        assert response.json() == {"modes": ["classic"]}

    def test_a_switched_on_mode_is_listed_after_classic_with_no_token(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_COOKOUT_MODES", "toastie")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/cookout/modes")  # no unlock token, no Access header
        assert response.status_code == 200
        assert response.json() == {"modes": ["classic", "toastie"]}

    def test_an_unknown_id_in_the_setting_is_not_listed(
        self, storage_root: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_COOKOUT_MODES", "toastie, nonsense")
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/cookout/modes")
        assert response.json() == {"modes": ["classic", "toastie"]}

    @pytest.mark.parametrize("header", ["Cf-Ray", "Cf-Connecting-Ip"])
    def test_a_request_carrying_a_cloudflare_edge_header_gets_the_bare_404(
        self, storage_root: Path, wixy_repo_root: Path, header: str
    ) -> None:
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/internal/cookout/modes", headers={header: "x"})
        assert response.status_code == 404
        assert "modes" not in response.text
