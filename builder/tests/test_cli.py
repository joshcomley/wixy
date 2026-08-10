"""CLI tests: `python -m builder build|validate` (spec/09-work-plan.md milestone 2).

`serve` (a thin stdlib-`http.server` wrapper around the already-well-tested `build_site`)
is verified manually rather than with a networked test here, to avoid port-collision
flakiness for negligible extra coverage.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from bs4 import BeautifulSoup, Tag

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

    def test_build_omitted_overrides_preserve_registry_defaults(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """The fixture registry is domain=fixture.example.com, indexable=false — with no
        --domain/--indexable flags, build must behave exactly as before this feature."""
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            ["build", "--root", str(mini_site_root), "--project", project, "--out", str(out)]
        )
        assert code == 0
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nDisallow: /\n"
        assert not (out / "sitemap.xml").exists()
        soup = BeautifulSoup((out / "index.html").read_text(encoding="utf-8"), "html5lib")
        robots_meta = soup.find("meta", attrs={"name": "robots"})
        assert isinstance(robots_meta, Tag)
        assert robots_meta["content"] == "noindex"

    def test_build_domain_and_indexable_overrides_applied(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            [
                "build",
                "--root",
                str(mini_site_root),
                "--project",
                project,
                "--out",
                str(out),
                "--domain",
                "example.org",
                "--indexable",
                "true",
            ]
        )
        assert code == 0

        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nAllow: /\nSitemap: https://example.org/sitemap.xml\n"

        sitemap = (out / "sitemap.xml").read_text(encoding="utf-8")
        assert "https://example.org/" in sitemap

        soup = BeautifulSoup((out / "index.html").read_text(encoding="utf-8"), "html5lib")
        assert soup.find("meta", attrs={"name": "robots"}) is None
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://example.org/"

    def test_build_indexable_false_override_still_writes_disallow(
        self, mini_site_root: Path, tmp_path: Path
    ) -> None:
        """Exercises the explicit-false override path (not just the omitted-flag default),
        alongside a --domain override, to prove the two flags are independent."""
        project = str(mini_site_root.parent / "project.json")
        out = tmp_path / "out"
        code = main(
            [
                "build",
                "--root",
                str(mini_site_root),
                "--project",
                project,
                "--out",
                str(out),
                "--domain",
                "example.org",
                "--indexable",
                "false",
            ]
        )
        assert code == 0
        robots = (out / "robots.txt").read_text(encoding="utf-8")
        assert robots == "User-agent: *\nDisallow: /\n"
        assert not (out / "sitemap.xml").exists()

        soup = BeautifulSoup((out / "index.html").read_text(encoding="utf-8"), "html5lib")
        canonical = soup.find("link", attrs={"rel": "canonical"})
        assert isinstance(canonical, Tag)
        assert canonical["href"] == "https://example.org/"
