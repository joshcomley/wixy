"""Content-fingerprinted public-asset URLs (builder/assetcache.py) — decisions/00130,
the same failure class decisions/00069 already fixed for the admin UI.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from builder.assetcache import (
    content_fingerprint,
    find_unfingerprinted_asset_references,
    fingerprint_asset_references,
)


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

    def test_repeated_calls_on_an_unchanged_file_read_it_only_once(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """decisions/00130 audit round 3, F4: `routes_public.py` calls this on every
        request that carries a `?v=` for a fingerprinted asset, to verify the value —
        so an unmemoized version re-reads and re-hashes the whole file on every single
        request, forever, even though the bytes only change on a publish. Must hash
        once per distinct (mtime, size), not once per call."""
        read_count = 0
        real_read_bytes = Path.read_bytes

        def counting_read_bytes(self: Path) -> bytes:
            nonlocal read_count
            read_count += 1
            return real_read_bytes(self)

        monkeypatch.setattr(Path, "read_bytes", counting_read_bytes)

        f = tmp_path / "site.css"
        f.write_text("body{color:red}", encoding="utf-8")

        first = content_fingerprint(f)
        second = content_fingerprint(f)
        assert first == second
        assert read_count == 1

    def test_a_genuine_content_change_still_produces_a_fresh_hash(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The memoization cache must never serve a stale hash for a file that
        actually changed — the whole point of fingerprinting is that a content change
        changes the URL."""
        read_count = 0
        real_read_bytes = Path.read_bytes

        def counting_read_bytes(self: Path) -> bytes:
            nonlocal read_count
            read_count += 1
            return real_read_bytes(self)

        monkeypatch.setattr(Path, "read_bytes", counting_read_bytes)

        f = tmp_path / "site.css"
        f.write_text("body{color:red}", encoding="utf-8")
        first = content_fingerprint(f)

        f.write_text("body{color:blue}", encoding="utf-8")  # different size too
        second = content_fingerprint(f)

        assert first != second
        assert read_count == 2


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

    def test_returns_the_fingerprints_it_used(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        (tmp_path / "index.html").write_text('<link href="site.css">', encoding="utf-8")
        fingerprints = fingerprint_asset_references(tmp_path)
        assert fingerprints == {"site.css": content_fingerprint(tmp_path / "site.css")}

    def test_does_not_touch_a_data_attribute_ending_in_href_or_src(self, tmp_path: Path) -> None:
        """decisions/00130 audit round 2, F3: the rewrite must be anchored to a real
        `href=`/`src=` attribute START, not just to those characters appearing as the
        tail of a longer attribute name like `data-href=`."""
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        page = tmp_path / "index.html"
        page.write_text('<a data-href="site.css" data-src="site.css">x</a>', encoding="utf-8")
        fingerprint_asset_references(tmp_path)
        assert page.read_text(encoding="utf-8") == (
            '<a data-href="site.css" data-src="site.css">x</a>'
        )


class TestFindUnfingerprintedAssetReferences:
    def test_empty_when_everything_was_rewritten(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        (tmp_path / "index.html").write_text('<link href="site.css">', encoding="utf-8")
        fingerprints = fingerprint_asset_references(tmp_path)
        assert find_unfingerprinted_asset_references(tmp_path, fingerprints) == []

    def test_catches_a_leading_slash_reference_the_rewrite_does_not_touch(
        self, tmp_path: Path
    ) -> None:
        """decisions/00130 audit round 2, F2: `href="/site.css"` (or `href="./site.css"`)
        is a recognisable-but-unrewritten reference the exact bare-string rewrite
        deliberately does not touch — this is the safety net that must catch it instead
        of letting it ship silently unfingerprinted."""
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        (tmp_path / "index.html").write_text('<link href="/site.css">', encoding="utf-8")
        fingerprints = fingerprint_asset_references(tmp_path)
        problems = find_unfingerprinted_asset_references(tmp_path, fingerprints)
        assert problems == [("index.html", "/site.css")]

    def test_ignores_a_name_that_was_never_fingerprinted(self, tmp_path: Path) -> None:
        """No theme.css in this build -> a bare `href="theme.css"` (which nothing in
        this build actually emits, but hypothetically) is not this check's concern."""
        (tmp_path / "index.html").write_text('<link href="theme.css">', encoding="utf-8")
        assert find_unfingerprinted_asset_references(tmp_path, {}) == []

    def test_ignores_unrelated_links(self, tmp_path: Path) -> None:
        (tmp_path / "site.css").write_text("body{color:red}", encoding="utf-8")
        (tmp_path / "index.html").write_text(
            '<link href="site.css"><a href="/about">About</a><img src="/images/hero.jpg" alt="">',
            encoding="utf-8",
        )
        fingerprints = fingerprint_asset_references(tmp_path)
        assert find_unfingerprinted_asset_references(tmp_path, fingerprints) == []
