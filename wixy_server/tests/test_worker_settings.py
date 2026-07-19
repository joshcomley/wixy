from __future__ import annotations

import os
from pathlib import Path

import pytest

from wixy_server.worker.settings import load_worker_settings


class TestBotPatEnvironScrub:
    """Fable M6 gate review, R1: `WIXY_AI_BOT_PAT` must not survive in this
    process's own `os.environ` past `load_worker_settings` — see that
    function's own comment for why (the Agent SDK's spawned CLI child
    inherits the full process environment by default)."""

    def test_pops_bot_pat_from_process_environ(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_AI_BOT_PAT", "secret-bot-pat-value")
        settings = load_worker_settings(
            scratch_root=tmp_path / "scratch", transcripts_root=tmp_path / "transcripts"
        )
        assert settings.bot_pat == "secret-bot-pat-value"
        assert "WIXY_AI_BOT_PAT" not in os.environ

    def test_still_reports_missing_when_never_set(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WIXY_AI_BOT_PAT", raising=False)
        settings = load_worker_settings(
            scratch_root=tmp_path / "scratch", transcripts_root=tmp_path / "transcripts"
        )
        assert settings.bot_pat == ""
        assert "WIXY_AI_BOT_PAT" not in os.environ

    def test_second_call_in_same_process_sees_it_already_gone(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # `wixy_server.worker.app.create_worker_app`'s own settings=None
        # fallback calls `load_worker_settings` a second time in some tests —
        # the second call must not error, it should just correctly observe
        # the credential is genuinely gone from this process, not silently
        # re-read a cached value.
        monkeypatch.setenv("WIXY_AI_BOT_PAT", "secret-bot-pat-value")
        first = load_worker_settings(
            scratch_root=tmp_path / "scratch", transcripts_root=tmp_path / "transcripts"
        )
        second = load_worker_settings(
            scratch_root=tmp_path / "scratch", transcripts_root=tmp_path / "transcripts"
        )
        assert first.bot_pat == "secret-bot-pat-value"
        assert second.bot_pat == ""

    def test_does_not_scrub_anthropic_api_key(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # ANTHROPIC_API_KEY is read directly by the Agent SDK from os.environ
        # by its own documented contract — the SDK child is SUPPOSED to
        # inherit it, unlike WIXY_AI_BOT_PAT. Not modeled in WorkerSettings at
        # all (see module docstring), so the only thing to prove here is that
        # loading settings leaves it untouched in the process environment.
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-fake-value")
        load_worker_settings(
            scratch_root=tmp_path / "scratch", transcripts_root=tmp_path / "transcripts"
        )
        assert os.environ.get("ANTHROPIC_API_KEY") == "sk-ant-fake-value"
