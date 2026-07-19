"""`/api/admin/ai/budget` tests (spec/independence/05 §2) — anthropic-backend
only. `wixy_server.ai.anthropic_backend`'s own transport/protocol behavior is
covered by `test_anthropic_backend.py`; this file tests the ROUTE layer (the
backend guard, the 502-on-unreachable-worker path)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.ai.anthropic_backend import AnthropicAIBackend
from wixy_server.app import create_app
from wixy_server.tests.fake_worker import FakeWorkerState, create_fake_worker_app


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


class TestRequireAnthropicBackend:
    def test_404s_when_ai_backend_is_cmd(self, tmp_path: Path, wixy_repo_root: Path) -> None:
        app = create_app(storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root)
        with TestClient(app) as client:
            response = client.get("/api/admin/ai/budget")
        assert response.status_code == 404


class TestGetAiBudget:
    def test_reports_worker_budget_status(
        self, tmp_path: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_AI_BACKEND", "anthropic")
        fake_worker_app = create_fake_worker_app(
            FakeWorkerState(month_to_date_usd=8.25, monthly_budget_usd=40.0)
        )
        backend = AnthropicAIBackend(transport=httpx.ASGITransport(app=fake_worker_app))
        app = create_app(
            storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root, ai_backend=backend
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/ai/budget")

        assert response.status_code == 200
        assert response.json() == {"monthToDateUsd": 8.25, "monthlyBudgetUsd": 40.0}

    def test_502s_when_the_worker_is_unreachable(
        self, tmp_path: Path, wixy_repo_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_AI_BACKEND", "anthropic")
        backend = AnthropicAIBackend(
            worker_base_url="http://127.0.0.1:1", timeout_s=1.0, max_attempts=1
        )
        app = create_app(
            storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root, ai_backend=backend
        )
        with TestClient(app) as client:
            response = client.get("/api/admin/ai/budget")

        assert response.status_code == 502
