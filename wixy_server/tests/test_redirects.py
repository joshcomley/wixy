"""Redirects facility tests (spec/independence/01 §2.2, 03 §2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from wixy_server.redirects import RedirectConfigError, load_redirects, resolve_redirect


class TestLoadRedirects:
    def test_unset_env_returns_empty_map(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("WIXY_REDIRECTS_FILE", raising=False)
        assert load_redirects() == {}

    def test_loads_a_real_map(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        redirects_file = tmp_path / "redirects.json"
        redirects_file.write_text(
            json.dumps({"/old-page": "/new-page", "/gallery.html": "/gallery"}),
            encoding="utf-8",
        )
        monkeypatch.setenv("WIXY_REDIRECTS_FILE", str(redirects_file))
        assert load_redirects() == {"/old-page": "/new-page", "/gallery.html": "/gallery"}

    def test_missing_file_raises(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WIXY_REDIRECTS_FILE", str(tmp_path / "does-not-exist.json"))
        with pytest.raises(RedirectConfigError, match="could not be read"):
            load_redirects()

    def test_malformed_json_raises(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        redirects_file = tmp_path / "redirects.json"
        redirects_file.write_text("{not valid json", encoding="utf-8")
        monkeypatch.setenv("WIXY_REDIRECTS_FILE", str(redirects_file))
        with pytest.raises(RedirectConfigError, match="not valid JSON"):
            load_redirects()

    def test_non_object_json_raises(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        redirects_file = tmp_path / "redirects.json"
        redirects_file.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
        monkeypatch.setenv("WIXY_REDIRECTS_FILE", str(redirects_file))
        with pytest.raises(RedirectConfigError, match="flat JSON object"):
            load_redirects()

    def test_non_string_value_raises(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        redirects_file = tmp_path / "redirects.json"
        redirects_file.write_text(json.dumps({"/old": 404}), encoding="utf-8")
        monkeypatch.setenv("WIXY_REDIRECTS_FILE", str(redirects_file))
        with pytest.raises(RedirectConfigError, match="flat JSON object"):
            load_redirects()


class TestResolveRedirect:
    def test_matches_a_configured_path(self) -> None:
        assert resolve_redirect({"/old": "/new"}, "/old") == "/new"

    def test_no_match_returns_none(self) -> None:
        assert resolve_redirect({"/old": "/new"}, "/other") is None

    def test_empty_map_never_matches(self) -> None:
        assert resolve_redirect({}, "/anything") is None

    def test_normalizes_a_path_missing_its_leading_slash(self) -> None:
        assert resolve_redirect({"/old": "/new"}, "old") == "/new"

    def test_target_may_be_an_external_url(self) -> None:
        assert (
            resolve_redirect({"/old": "https://example.com/elsewhere"}, "/old")
            == "https://example.com/elsewhere"
        )
