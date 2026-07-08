"""CLI tests: `python -m builder build|validate` (spec/09-work-plan.md milestone 2).

`serve` (a thin stdlib-`http.server` wrapper around the already-well-tested `build_site`)
is verified manually rather than with a networked test here, to avoid port-collision
flakiness for negligible extra coverage.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from builder.cli import main


class TestValidateCommand:
    def test_validate_ok_exit_code(
        self, mini_site_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        code = main(["validate", "--root", str(mini_site_root), "--project", project])
        assert code == 0
        assert "validate: OK" in capsys.readouterr().out

    def test_validate_json_output(
        self, mini_site_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        code = main(["validate", "--root", str(mini_site_root), "--project", project, "--json"])
        assert code == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload == {"ok": True, "errors": []}

    def test_validate_reports_error_and_nonzero_exit(
        self, tmp_path: Path, mini_site_root: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        root = tmp_path / "broken-site"
        (root / "pages").mkdir(parents=True)
        (root / "content").mkdir()
        (root / "partials").mkdir()
        (root / "theme").mkdir()
        (root / "pages" / "index.html").write_text(
            "<!DOCTYPE html><html><head><title>x</title></head>"
            "<body><!-- wx:partial header -->"
            '<h1 data-wx="hero.title">x</h1>'
            "<!-- wx:partial footer --><!-- wx:partial booking-modal --></body></html>",
            encoding="utf-8",
        )
        (root / "content" / "index.json").write_text('{"meta": {"title": "T"}}', encoding="utf-8")
        (root / "content" / "_global.json").write_text("{}", encoding="utf-8")
        (root / "theme" / "theme.json").write_text(
            '{"colors": {}, "shadow": "", "fonts": {'
            '"serif": {"family": "X", "weights": [], "italics": false}, '
            '"sans": {"family": "Y", "weights": [], "italics": false}, '
            '"script": {"family": "Z", "weights": [], "italics": false}}}',
            encoding="utf-8",
        )
        for name in ("header", "footer", "booking-modal"):
            (root / "partials" / f"{name}.html").write_text("<div></div>", encoding="utf-8")

        project = str(mini_site_root.parent / "project.json")
        code = main(["validate", "--root", str(root), "--project", project, "--json"])
        assert code == 1
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is False
        assert any(e["key"] == "hero.title" for e in payload["errors"])


class TestBuildCommand:
    def test_build_writes_output(self, mini_site_root: Path, tmp_path: Path) -> None:
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            ["build", "--root", str(mini_site_root), "--project", project, "--out", str(out)]
        )
        assert code == 0
        assert (out / "index.html").exists()
        assert (out / "about.html").exists()
        assert (out / "theme.css").exists()
