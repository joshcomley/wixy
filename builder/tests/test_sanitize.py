"""Rich-lite sanitizer tests (spec/02-content-model.md §5)."""

from __future__ import annotations

import pytest

from builder.sanitize import is_already_clean, sanitize_rich_lite


class TestAllowlist:
    def test_allowed_tags_pass_through(self) -> None:
        html = "plain <strong>bold</strong> <em>italic</em><br><a href='/x'>link</a>"
        out = sanitize_rich_lite(html)
        assert "<strong>bold</strong>" in out
        assert "<em>italic</em>" in out
        assert "<br" in out
        assert 'href="/x"' in out

    def test_disallowed_tag_is_stripped_but_keeps_text(self) -> None:
        out = sanitize_rich_lite("<p>para</p><div>div text</div>")
        assert "<p>" not in out
        assert "<div>" not in out
        assert "para" in out
        assert "div text" in out

    def test_script_tag_and_content_removed(self) -> None:
        out = sanitize_rich_lite("safe<script>alert(1)</script>")
        assert "safe" in out
        assert "alert" not in out
        assert "script" not in out

    def test_span_class_allowlist(self) -> None:
        out = sanitize_rich_lite('<span class="js-book other">x</span>')
        assert 'class="js-book"' in out

    def test_a_class_allowlist(self) -> None:
        out = sanitize_rich_lite('<a class="js-book random">x</a>')
        assert 'class="js-book"' in out

    def test_disallowed_class_value_stripped(self) -> None:
        out = sanitize_rich_lite('<span class="not-allowed">x</span>')
        assert "not-allowed" not in out


class TestHrefSchemes:
    @pytest.mark.parametrize(
        "href",
        [
            "https://example.com",
            "http://example.com",
            "mailto:a@b.com",
            "tel:0123",
            "relative/page.html",
            "#anchor",
        ],
    )
    def test_allowed_schemes_kept(self, href: str) -> None:
        out = sanitize_rich_lite(f'<a href="{href}">x</a>')
        assert href in out

    def test_javascript_scheme_stripped(self) -> None:
        out = sanitize_rich_lite('<a href="javascript:alert(1)">x</a>')
        assert "javascript" not in out
        assert "href" not in out

    def test_data_scheme_stripped(self) -> None:
        out = sanitize_rich_lite('<a href="data:text/html,evil">x</a>')
        assert "data:" not in out


class TestIdempotence:
    @pytest.mark.parametrize(
        "html",
        [
            "plain text",
            "<strong>bold</strong> and <em>italic</em>",
            '<a href="https://example.com" target="_blank" class="js-book">Book</a>',
            "<span>no class</span>",
        ],
    )
    def test_sanitizing_twice_is_stable(self, html: str) -> None:
        once = sanitize_rich_lite(html)
        twice = sanitize_rich_lite(once)
        assert once == twice

    def test_is_already_clean_true_for_clean_input(self) -> None:
        assert is_already_clean("plain <strong>bold</strong> text") is True

    def test_is_already_clean_false_for_dirty_input(self) -> None:
        assert is_already_clean("<div>dirty</div>") is False
