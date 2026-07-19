"""`/api/admin/engine/{status,update,rollback}` tests (spec/independence/04 §2) —
standalone-edition only. `wixy_server.github`'s own transport/protocol behavior is
covered by `test_github.py`; this file tests the ROUTE layer (edition/repo guard,
status caching + graceful-degradation, dispatch wiring for update/rollback)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.github import GitHubClient
from wixy_server.tests.fake_github import FakeGitHubState, create_fake_github_app


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


@pytest.fixture(autouse=True)
def _standalone_with_engine_repo(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test in this file exercises the standalone-only engine-update
    surface by default — the one test that proves the fleet-edition/no-repo 404
    guard overrides this back itself (spec/independence/04 §2: "never touch the
    fleet edition")."""
    monkeypatch.setenv("WIXY_EDITION", "standalone")
    monkeypatch.setenv("WIXY_ENGINE_REPO", "acme/wixy-engine")
    monkeypatch.setenv("WIXY_ENGINE_UPSTREAM", "joshcomley/wixy")
    monkeypatch.setenv("WIXY_ENGINE_PAT", "fake-pat")


@pytest.fixture
def fake_github_state() -> FakeGitHubState:
    return FakeGitHubState()


@pytest.fixture
def github_client(fake_github_state: FakeGitHubState) -> GitHubClient:
    app = create_fake_github_app(fake_github_state)
    return GitHubClient(pat="fake-pat", transport=httpx.ASGITransport(app=app))


class TestRequireStandalone:
    def test_404s_on_fleet_edition(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_EDITION", "fleet")
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/engine/status")
        assert response.status_code == 404

    def test_404s_on_standalone_with_no_engine_repo_configured(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("WIXY_ENGINE_REPO", raising=False)
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/engine/status")
        assert response.status_code == 404

    def test_update_and_rollback_also_404_on_fleet_edition(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_EDITION", "fleet")
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            assert client.post("/api/admin/engine/update").status_code == 404
            assert client.post("/api/admin/engine/rollback").status_code == 404


class TestGetStatus:
    def test_reports_repo_sha_and_fetched_comparison(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        engine_sha = _git(["rev-parse", "HEAD"], wixy_repo_root).stdout.strip()
        fake_github_state.compare_ahead_by = 2
        fake_github_state.compare_commits = [
            {
                "sha": "abc123",
                "commit": {
                    "message": "feat: thing",
                    "author": {"name": "Jane", "date": "2026-07-18T10:00:00Z"},
                },
            }
        ]
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/engine/status")

        assert response.status_code == 200
        body = response.json()
        assert body["engineRepo"] == "acme/wixy-engine"
        assert body["currentSha"] == engine_sha
        assert body["commitsBehind"] == 2
        assert body["changelog"] == [
            {
                "sha": "abc123",
                "subject": "feat: thing",
                "author": "Jane",
                "when": "2026-07-18T10:00:00Z",
            }
        ]
        # "stale" reflects "the cache had expired and was just live-refreshed" —
        # True here since this is the very first call (checked_at was None).
        assert body["stale"] is True
        assert body["checkError"] is None

    def test_second_call_within_ttl_serves_cached_data_without_refetching(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        fake_github_state.compare_ahead_by = 1
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            first = client.get("/api/admin/engine/status")
            assert first.json()["commitsBehind"] == 1

            # Mutate the fake's truth AFTER the first call — a second call inside
            # the 15 min TTL must still serve the cached value, proving it didn't
            # re-fetch (spec/independence/04 §2: "commits-behind cached 15 min").
            fake_github_state.compare_ahead_by = 99
            second = client.get("/api/admin/engine/status")

        assert second.json()["commitsBehind"] == 1
        assert second.json()["stale"] is False

    def test_github_error_falls_back_to_stale_data_never_500s(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        fake_github_state.compare_status_code = 500
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/engine/status")

        assert response.status_code == 200
        body = response.json()
        assert body["commitsBehind"] is None
        assert body["checkError"] is not None

    def test_reports_latest_workflow_run_when_present(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        fake_github_state.latest_run = {
            "id": 7,
            "status": "completed",
            "conclusion": "success",
            "html_url": "https://github.com/acme/wixy-engine/actions/runs/7",
            "created_at": "2026-07-19T08:00:00Z",
        }
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/engine/status")

        assert response.json()["updateRun"] == {
            "status": "completed",
            "conclusion": "success",
            "htmlUrl": "https://github.com/acme/wixy-engine/actions/runs/7",
            "createdAt": "2026-07-19T08:00:00Z",
        }


class TestPostUpdate:
    def test_dispatches_sync_mode(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/engine/update", headers={"Content-Type": "application/json"}
            )

        assert response.status_code == 200
        assert response.json() == {"triggered": True}
        assert len(fake_github_state.dispatch_calls) == 1
        assert fake_github_state.dispatch_calls[0]["inputs"] == {"mode": "sync"}

    def test_502s_on_github_error(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        fake_github_state.dispatch_status_code = 422
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/engine/update", headers={"Content-Type": "application/json"}
            )
        assert response.status_code == 502

    def test_415s_without_json_content_type(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        """CSRF guard (Fable review, PR #74 R1): a cross-site HTML form can never
        send `application/json`, so this is what stops a forged form POST from
        dispatching an update through her live CF Access session."""
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/engine/update")

        assert response.status_code == 415
        assert len(fake_github_state.dispatch_calls) == 0


class TestPostRollback:
    def test_dispatches_rollback_mode(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/engine/rollback", headers={"Content-Type": "application/json"}
            )

        assert response.status_code == 200
        assert response.json() == {"triggered": True}
        assert len(fake_github_state.dispatch_calls) == 1
        assert fake_github_state.dispatch_calls[0]["inputs"] == {"mode": "rollback"}

    def test_502s_on_github_error(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        fake_github_state.dispatch_status_code = 422
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/engine/rollback", headers={"Content-Type": "application/json"}
            )
        assert response.status_code == 502

    def test_415s_without_json_content_type(
        self,
        tmp_path: Path,
        wixy_repo_root: Path,
        github_client: GitHubClient,
        fake_github_state: FakeGitHubState,
    ) -> None:
        app = create_app(
            storage_root=tmp_path / "storage",
            wixy_repo_root=wixy_repo_root,
            github_client=github_client,
        )
        with TestClient(app) as client:
            response = client.post("/api/admin/engine/rollback")

        assert response.status_code == 415
        assert len(fake_github_state.dispatch_calls) == 0
