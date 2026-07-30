"""Diagnostic report bundle (decisions/00095) — wixy_server/reports.py."""

from __future__ import annotations

import json
import smtplib
import subprocess
from email.message import EmailMessage
from pathlib import Path
from typing import Any

import pytest

from builder.config import MediaConfig, ProjectConfig
from wixy_server.publisher import PublishJob
from wixy_server.reports import build_report_bundle, save_report, send_report_email, submit_report
from wixy_server.settings import load_settings
from wixy_server.storage import ProjectPaths, ensure_project_dirs, project_paths

_TS = "2026-07-30T21:00:00+00:00"

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


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-c", "credential.helper=", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


@pytest.fixture
def project() -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo="unused",
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    """No checkout at all — exercises reports' graceful "not ready yet" path."""
    p = project_paths(tmp_path / "storage", "test")
    ensure_project_dirs(p)
    return p


@pytest.fixture
def engine_root(tmp_path: Path) -> Path:
    """A real (if not git-initialized) directory — `wixy_repo_root` always
    exists in production (it's where the running engine code lives);
    `current_sha`'s git subprocess needs a real `cwd` to fail as a clean
    `CheckoutError` rather than a raw OS-level spawn error."""
    root = tmp_path / "engine"
    root.mkdir()
    return root


@pytest.fixture
def paths_with_repo(paths: ProjectPaths) -> ProjectPaths:
    root = paths.repo
    (root / "pages").mkdir(parents=True)
    (root / "partials").mkdir(parents=True)
    (root / "content").mkdir(parents=True)
    (root / "images").mkdir(parents=True)
    (root / "pages" / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    for name in ("header", "footer", "booking-modal"):
        (root / "partials" / f"{name}.html").write_text(_PARTIAL_HTML, encoding="utf-8")
    (root / "content" / "index.json").write_text(
        json.dumps(
            {
                "meta": {"title": "Home", "navLabel": "Home", "inNav": True, "navOrder": 10},
                "hero": {"title": "Original Title"},
            }
        ),
        encoding="utf-8",
    )
    (root / "content" / "_global.json").write_text("{}", encoding="utf-8")
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "initial"], root)
    return paths


def _settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **env: str) -> Any:
    for key in (
        "WIXY_REPORT_SMTP_HOST",
        "WIXY_REPORT_SMTP_PORT",
        "WIXY_REPORT_SMTP_USER",
        "WIXY_REPORT_SMTP_PASSWORD",
        "WIXY_REPORT_EMAIL_TO",
        "WIXY_REPORT_EMAIL_FROM",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return load_settings(tmp_path / "storage-settings")


class TestBuildReportBundle:
    def test_shape_with_no_checkout_yet(
        self,
        project: ProjectConfig,
        paths: ProjectPaths,
        engine_root: Path,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        settings = _settings(tmp_path, monkeypatch)
        bundle = build_report_bundle(
            project, paths, engine_root, settings, None, context="ctx", note=None, now=_TS
        )
        assert bundle["timestamp"] == _TS
        assert bundle["context"] == "ctx"
        assert bundle["note"] is None
        assert bundle["project"] == {"slug": "test", "name": "Test"}
        assert bundle["overlay"] == {}
        assert bundle["publishJob"] is None
        assert bundle["live"] is None
        assert bundle["recentPublishes"] == []
        assert bundle["upstream"] == {"aheadOfPublished": []}
        settings_summary = bundle["settings"]
        assert isinstance(settings_summary, dict)
        assert settings_summary["env"]  # a non-secret settings summary is present
        assert "engine_pat" not in json.dumps(bundle)  # never leaks a secret field name

    def test_includes_the_current_validate_result(
        self,
        project: ProjectConfig,
        paths_with_repo: ProjectPaths,
        engine_root: Path,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        settings = _settings(tmp_path, monkeypatch)
        bundle = build_report_bundle(
            project,
            paths_with_repo,
            engine_root,
            settings,
            None,
            context="ctx",
            note="a note",
            now=_TS,
        )
        assert bundle["validate"] == {"ok": True, "errors": []}
        assert bundle["note"] == "a note"

    def test_includes_a_running_publish_job_snapshot(
        self,
        project: ProjectConfig,
        paths: ProjectPaths,
        engine_root: Path,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        settings = _settings(tmp_path, monkeypatch)
        job = PublishJob(id="job-1", stage="building", log=["step one"])
        bundle = build_report_bundle(
            project, paths, engine_root, settings, job, context="ctx", note=None, now=_TS
        )
        assert bundle["publishJob"] == {
            "id": "job-1",
            "stage": "building",
            "log": ["step one"],
            "version": None,
            "error": None,
            "isRunning": True,
        }


class TestSaveReport:
    def test_writes_a_utc_timestamped_json_file(
        self,
        project: ProjectConfig,
        paths: ProjectPaths,
        engine_root: Path,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        settings = _settings(tmp_path, monkeypatch)
        bundle = build_report_bundle(
            project, paths, engine_root, settings, None, context="ctx", note=None, now=_TS
        )
        target = save_report(bundle, paths)
        assert target.parent == paths.reports_dir
        assert target.name == "20260730T210000Z.json"
        assert json.loads(target.read_text(encoding="utf-8")) == bundle


class TestSendReportEmail:
    def test_unconfigured_returns_false_without_attempting_to_send(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings = _settings(tmp_path, monkeypatch)  # no SMTP_HOST/EMAIL_TO set

        def _boom(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("must not attempt to connect when unconfigured")

        monkeypatch.setattr(smtplib, "SMTP", _boom)
        assert send_report_email(settings, {"project": {"slug": "test"}}, "ctx") is False

    def test_configured_sends_via_starttls_and_login(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sent: dict[str, object] = {}

        class FakeSmtp:
            def __init__(self, host: str, port: int, timeout: float) -> None:
                sent["host"] = host
                sent["port"] = port

            def __enter__(self) -> FakeSmtp:
                return self

            def __exit__(self, *exc_info: object) -> None:
                return None

            def starttls(self) -> None:
                sent["starttls"] = True

            def login(self, user: str, password: str) -> None:
                sent["login"] = (user, password)

            def send_message(self, message: object) -> None:
                sent["message"] = message

        monkeypatch.setattr(smtplib, "SMTP", FakeSmtp)
        settings = _settings(
            tmp_path,
            monkeypatch,
            WIXY_REPORT_SMTP_HOST="smtp.example.com",
            WIXY_REPORT_SMTP_PORT="587",
            WIXY_REPORT_SMTP_USER="bot@example.com",
            WIXY_REPORT_SMTP_PASSWORD="app-password",
            WIXY_REPORT_EMAIL_TO="operator@example.com",
            WIXY_REPORT_EMAIL_FROM="bot@example.com",
        )

        result = send_report_email(settings, {"project": {"slug": "test"}}, "publish-failed")

        assert result is True
        assert sent["host"] == "smtp.example.com"
        assert sent["starttls"] is True
        assert sent["login"] == ("bot@example.com", "app-password")
        message = sent["message"]
        assert isinstance(message, EmailMessage)
        assert message["Subject"] == "[wixy/test] Report from the site editor — publish-failed"
        assert message["To"] == "operator@example.com"

    def test_a_send_failure_is_caught_and_reported_as_not_emailed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class ExplodingSmtp:
            def __init__(self, *args: object, **kwargs: object) -> None:
                raise OSError("connection refused")

        monkeypatch.setattr(smtplib, "SMTP", ExplodingSmtp)
        settings = _settings(
            tmp_path,
            monkeypatch,
            WIXY_REPORT_SMTP_HOST="smtp.example.com",
            WIXY_REPORT_EMAIL_TO="operator@example.com",
        )

        assert send_report_email(settings, {"project": {"slug": "test"}}, "ctx") is False


class TestSubmitReport:
    def test_always_saves_even_when_email_is_unconfigured(
        self,
        project: ProjectConfig,
        paths: ProjectPaths,
        engine_root: Path,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        settings = _settings(tmp_path, monkeypatch)

        result = submit_report(
            project,
            paths,
            engine_root,
            settings,
            None,
            context="publish-blocked",
            note=None,
            now=_TS,
        )

        assert result.saved is True
        assert result.emailed is False
        assert len(list(paths.reports_dir.iterdir())) == 1
