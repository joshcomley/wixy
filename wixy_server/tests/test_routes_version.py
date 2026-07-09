"""`GET /api/version` tests (spec/04 §9, spec/07 §1) — public, never CF-Access-gated,
reports the ENGINE (wixy) repo's own HEAD sha, not the site checkout's."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


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
    """A real git repo standing in for the wixy engine checkout itself — `_build_version`
    reads ITS OWN HEAD sha directly (via `current_sha`), independent of the project
    registry's site-repo `repo` field."""
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


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


class TestApiVersion:
    def test_reports_the_engine_repos_own_head_sha(
        self, tmp_path: Path, wixy_repo_root: Path
    ) -> None:
        engine_sha = _git(["rev-parse", "HEAD"], wixy_repo_root).stdout.strip()
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.status_code == 200
        body = response.json()
        assert body["commit"]["sha_full"] == engine_sha
        assert len(body["commit"]["sha_full"]) == 40

    def test_slot_is_null_pre_slots_deployment(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.json()["slot"] is None

    def test_version_is_null_before_any_publish(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.json()["version"] is None

    def test_is_not_gated_by_cf_access_even_without_dev_bypass(
        self, tmp_path: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """spec/04 §9: `/api/version` stays public by design. Override the autouse
        dev-bypass fixture to prove this isn't just passing because auth is off."""
        monkeypatch.setenv("WIXY_DEV_NO_AUTH", "0")
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version")
        assert response.status_code == 200

    def test_carrying_cf_edge_headers_does_not_affect_it(
        self, tmp_path: Path, wixy_repo_root: Path
    ) -> None:
        """Unlike `/internal/*`/`/healthz`, `/api/version` has no loopback-only
        guard — it's meant to answer from outside the tunnel too (spec/07 §4 checklist
        item 5b: "`.../api/version` → 200 (public by design)")."""
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/version", headers={"Cf-Ray": "abc123"})
        assert response.status_code == 200
