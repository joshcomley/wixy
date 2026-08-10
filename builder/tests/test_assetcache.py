"""Content-fingerprinted public-asset URLs (builder/assetcache.py) — decisions/00130,
the same failure class decisions/00069 already fixed for the admin UI.
"""

from __future__ import annotations

from pathlib import Path

from builder.assetcache import content_fingerprint, fingerprint_asset_references


class TestContentFingerprint:
    def test_same_bytes_same_fingerprint(self, tmp_path: Path) -> None:
        a = tmp_path / "a.css"
        b = tmp_path / "b.css"
        a.write_text("body{color:red}", encoding="utf-8")
        b.write_text("body{color:red}", encoding="utf-8")
        assert content_fingerprint(a) == content_fingerprint(b)

    def test_different_bytes_different_fingerprint(self, tmp_path: Path) -> None:
        a = tmp_path / "a.css"
        a.write_text("body{color:red}", encoding="utf-8")
        first = content_fingerprint(a)
        a.write_text("body{color:blue}", encoding="utf-8")
        assert content_fingerprint(a) != first


class TestFingerprintAssetReferences:
    def test_rewrites_bare_href_and_src(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        (tmp_path / "site.js").write_text("console.log(1)", encoding="utf-8")
        page = tmp_path / "index.html"
        page.write_text(
            '<link rel="stylesheet" href="site.css"><script src="site.js"></script>',
            encoding="utf-8",
        )
        fingerprint_asset_references(tmp_path)
        html = page.read_text(encoding="utf-8")
        css_fp = content_fingerprint(tmp_path / "site.css")
        js_fp = content_fingerprint(tmp_path / "site.js")
        assert f'href="site.css?v={css_fp}"' in html
        assert f'src="site.js?v={js_fp}"' in html

    def test_rewrites_every_html_file_consistently(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        (tmp_path / "index.html").write_text('<link href="site.css">', encoding="utf-8")
        (tmp_path / "about.html").write_text('<link href="site.css">', encoding="utf-8")
        fingerprint_asset_references(tmp_path)
        fp = content_fingerprint(tmp_path / "site.css")
        assert f'href="site.css?v={fp}"' in (tmp_path / "index.html").read_text(encoding="utf-8")
        assert f'href="site.css?v={fp}"' in (tmp_path / "about.html").read_text(encoding="utf-8")

    def test_content_change_changes_the_url(self, tmp_path: Path) -> None:
        """The whole point: a rebuild with different bytes must produce a different
        URL, or a cache layer holding the old URL's response never sees the change."""
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        page = tmp_path / "index.html"
        page.write_text('<link href="site.css">', encoding="utf-8")
        fingerprint_asset_references(tmp_path)
        first_url = page.read_text(encoding="utf-8")

        (tmp_path / "site.css").write_text("body{color:blue}", encoding="utf-8")
        page.write_text('<link href="site.css">', encoding="utf-8")  # simulate a fresh build
        fingerprint_asset_references(tmp_path)
        second_url = page.read_text(encoding="utf-8")

        assert first_url != second_url

    def test_leaves_absolute_and_unrelated_urls_untouched(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        page = tmp_path / "index.html"
        page.write_text(
            '<link href="https://fonts.googleapis.com/css2?family=X">'
            '<a href="#">Anchor</a>'
            '<img src="images/hero.jpg" alt="">',
            encoding="utf-8",
        )
        original = page.read_text(encoding="utf-8")
        fingerprint_asset_references(tmp_path)
        assert page.read_text(encoding="utf-8") == original

    def test_missing_asset_name_is_left_bare(self, tmp_path: Path) -> None:
        """No theme.css in this build (e.g. a themeless project) -> nothing to
        fingerprint it against, and nothing references it either in practice; the
        function must not fail or invent a fingerprint for a file that doesn't exist."""
        page = tmp_path / "index.html"
        page.write_text('<link href="theme.css">', encoding="utf-8")
        fingerprint_asset_references(tmp_path)
        assert page.read_text(encoding="utf-8") == '<link href="theme.css">'

    def test_no_op_when_no_fingerprintable_assets_exist(self, tmp_path: Path) -> None:
        page = tmp_path / "index.html"
        page.write_text("<p>hello</p>", encoding="utf-8")
        fingerprint_asset_references(tmp_path)  # must not raise
        assert page.read_text(encoding="utf-8") == "<p>hello</p>"
