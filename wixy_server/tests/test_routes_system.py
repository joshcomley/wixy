"""`/api/admin/system/status` tests (spec/independence/06 §3) — the backend
half of the System card: backup age/staleness, disk usage, last publish,
engine version/edition, all in one response."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.backup.status import BackupStatus, write_status
from wixy_server.ledger import LedgerEntry, append_ledger
from wixy_server.storage import project_paths


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def wixy_repo_root(tmp_path: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": "https://example.invalid/x.git",
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


@pytest.fixture(autouse=True)
def _isolated_backup_status_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`_BACKUP_STATUS_PATH` is a fixed container path in production
    (`/backup-status/status.json`) — redirected to a per-test tmp_path here
    so tests never touch (or race on) a real filesystem location."""
    path = tmp_path / "backup-status" / "status.json"
    monkeypatch.setattr("wixy_server.routes_system._BACKUP_STATUS_PATH", path)
    return path


class TestBackupField:
    def test_no_status_file_reports_stale_with_nulls(
        self, tmp_path: Path, wixy_repo_root: Path
    ) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.status_code == 200
        backup = response.json()["backup"]
        assert backup == {
            "lastAttemptAt": None,
            "ok": None,
            "verified": None,
            "error": None,
            "stale": True,
        }

    def test_recent_successful_run_is_not_stale(
        self, tmp_path: Path, wixy_repo_root: Path, _isolated_backup_status_path: Path
    ) -> None:
        now = datetime.now(UTC)
        write_status(
            _isolated_backup_status_path,
            BackupStatus(
                ok=True,
                attempted_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                commit_sha="abc123",
                verified=True,
                monthly_tag_pushed=None,
                error=None,
            ),
        )
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        backup = response.json()["backup"]
        assert backup["ok"] is True
        assert backup["verified"] is True
        assert backup["stale"] is False

    def test_run_older_than_48h_is_stale(
        self, tmp_path: Path, wixy_repo_root: Path, _isolated_backup_status_path: Path
    ) -> None:
        old = datetime.now(UTC) - timedelta(hours=49)
        write_status(
            _isolated_backup_status_path,
            BackupStatus(
                ok=True,
                attempted_at=old.strftime("%Y-%m-%dT%H:%M:%SZ"),
                commit_sha="abc123",
                verified=True,
                monthly_tag_pushed=None,
                error=None,
            ),
        )
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.json()["backup"]["stale"] is True

    def test_failed_run_is_stale_even_if_recent(
        self, tmp_path: Path, wixy_repo_root: Path, _isolated_backup_status_path: Path
    ) -> None:
        now = datetime.now(UTC)
        write_status(
            _isolated_backup_status_path,
            BackupStatus(
                ok=False,
                attempted_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                commit_sha=None,
                verified=False,
                monthly_tag_pushed=None,
                error="git clone of the backup repo failed: ...",
            ),
        )
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        backup = response.json()["backup"]
        assert backup["ok"] is False
        assert backup["stale"] is True
        assert backup["error"] == "git clone of the backup repo failed: ..."


class TestDiskUsageField:
    def test_reports_positive_byte_counts(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        disk = response.json()["diskUsage"]
        assert disk["totalBytes"] > 0
        assert disk["freeBytes"] >= 0
        assert disk["usedBytes"] >= 0


class TestLastPublishField:
    def test_null_when_never_published(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.json()["lastPublish"] is None

    def test_reports_the_latest_ledger_entry(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        storage_root = tmp_path / "storage"
        paths = project_paths(storage_root, "test")
        append_ledger(
            paths,
            LedgerEntry(
                version=1,
                sha="a" * 40,
                when="2026-07-01T00:00:00Z",
                message="first",
                source="editor",
            ),
        )
        append_ledger(
            paths,
            LedgerEntry(
                version=2,
                sha="b" * 40,
                when="2026-07-20T00:00:00Z",
                message="second",
                source="editor",
            ),
        )
        app = create_app(storage_root=storage_root, wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.json()["lastPublish"] == {"version": 2, "when": "2026-07-20T00:00:00Z"}


class TestEngineField:
    def test_reports_edition(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.json()["engine"]["edition"] == "fleet"

    def test_prefers_the_baked_sha_env_var(
        self, tmp_path: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_ENGINE_SHA", "deadbeef")
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.json()["engine"]["currentSha"] == "deadbeef"


class TestAvailableOnBothEditions:
    def test_200s_on_the_fleet_edition_too(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        # Unlike the Engine/AI cards, the System card is NOT
        # `_require_standalone`-gated — see module docstring.
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/system/status")

        assert response.status_code == 200
