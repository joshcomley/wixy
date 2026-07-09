from __future__ import annotations

from pathlib import Path

import pytest

from wixy_server.settings import load_settings, parse_env_file, resolve_storage_root


class TestParseEnvFile:
    def test_missing_file_returns_empty(self, tmp_path: Path) -> None:
        assert parse_env_file(tmp_path / "does-not-exist.env") == {}

    def test_parses_key_value_pairs(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("WIXY_PORT=8123\nWIXY_CF_ACCESS_AUD=abc123\n", encoding="utf-8")
        assert parse_env_file(env_file) == {"WIXY_PORT": "8123", "WIXY_CF_ACCESS_AUD": "abc123"}

    def test_ignores_blank_lines_and_comments(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text(
            "# a comment\n\nWIXY_PORT=8123\n  # indented comment\n", encoding="utf-8"
        )
        assert parse_env_file(env_file) == {"WIXY_PORT": "8123"}

    def test_strips_whitespace_around_key_and_value(self, tmp_path: Path) -> None:
        env_file = tmp_path / ".env"
        env_file.write_text("WIXY_PORT = 8123 \n", encoding="utf-8")
        assert parse_env_file(env_file) == {"WIXY_PORT": "8123"}


class TestResolveStorageRoot:
    def test_uses_env_var_override(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WIXY_STORAGE_ROOT", str(tmp_path))
        assert resolve_storage_root() == tmp_path

    def test_falls_back_to_default_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("WIXY_STORAGE_ROOT", raising=False)
        assert str(resolve_storage_root()).endswith("Wixy\\Storage")


class TestLoadSettings:
    def test_defaults_when_no_env_file_and_no_process_env(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for key in (
            "WIXY_PORT",
            "WIXY_ENV",
            "WIXY_DEV_NO_AUTH",
            "WIXY_CF_TEAM_DOMAIN",
            "WIXY_CF_ACCESS_AUD",
        ):
            monkeypatch.delenv(key, raising=False)
        settings = load_settings(tmp_path)
        assert settings.port == 8000
        assert settings.env == "dev"
        assert settings.dev_no_auth is False
        assert settings.storage_root == tmp_path

    def test_reads_values_from_env_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for key in ("WIXY_PORT", "WIXY_CF_ACCESS_AUD"):
            monkeypatch.delenv(key, raising=False)
        (tmp_path / ".env").write_text(
            "WIXY_PORT=9001\nWIXY_CF_ACCESS_AUD=my-aud\n", encoding="utf-8"
        )
        settings = load_settings(tmp_path)
        assert settings.port == 9001
        assert settings.cf_access_aud == "my-aud"

    def test_process_env_overrides_env_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        (tmp_path / ".env").write_text("WIXY_PORT=9001\n", encoding="utf-8")
        monkeypatch.setenv("WIXY_PORT", "9999")
        settings = load_settings(tmp_path)
        assert settings.port == 9999

    def test_dev_no_auth_in_prod_raises(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_ENV", "prod")
        monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")
        with pytest.raises(RuntimeError, match="WIXY_DEV_NO_AUTH"):
            load_settings(tmp_path)

    def test_dev_no_auth_in_dev_is_allowed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WIXY_ENV", "dev")
        monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")
        settings = load_settings(tmp_path)
        assert settings.dev_no_auth is True
