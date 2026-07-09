"""Theme loading + theme.css / fonts URL generation tests (spec/02-content-model.md §4)."""

from __future__ import annotations

from pathlib import Path

import pytest

from builder.errors import BuildError
from builder.theme import FontSpec, Theme, generate_fonts_url, generate_theme_css, load_theme


class TestLoadTheme:
    def test_loads_mini_site_theme(self, mini_site_root: Path) -> None:
        theme = load_theme(mini_site_root / "theme" / "theme.json")
        assert theme.colors["cream"] == "#F1E8D9"
        assert theme.shadow.startswith("0 18px")
        assert theme.fonts["serif"].family == "Cormorant Garamond"
        assert theme.fonts["serif"].italics is True
        assert theme.fonts["sans"].weights == ["300", "400"]

    def test_missing_colors_object_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "theme.json"
        path.write_text('{"colors": "nope", "shadow": "x", "fonts": {}}', encoding="utf-8")
        with pytest.raises(BuildError):
            load_theme(path)

    def test_bad_font_spec_shape_raises(self, tmp_path: Path) -> None:
        path = tmp_path / "theme.json"
        path.write_text(
            '{"colors": {}, "shadow": "x", "fonts": {"serif": {"family": 1}}}', encoding="utf-8"
        )
        with pytest.raises(BuildError):
            load_theme(path)


class TestThemeCss:
    def test_emits_color_vars_shadow_and_fonts(self) -> None:
        theme = Theme(
            colors={"cream": "#F1E8D9", "coffee": "#3E312A"},
            shadow="0 1px 2px black",
            fonts={
                "serif": FontSpec(family="Cormorant Garamond", weights=["400"], italics=False),
                "sans": FontSpec(family="Jost", weights=["400"], italics=False),
            },
        )
        css = generate_theme_css(theme)
        assert ":root{" in css
        assert "--cream:#F1E8D9;" in css
        assert "--coffee:#3E312A;" in css
        assert "--shadow:0 1px 2px black;" in css
        assert "--font-serif:'Cormorant Garamond',serif;" in css
        assert "--font-sans:'Jost',system-ui,sans-serif;" in css

    def test_unknown_role_has_no_fallback(self) -> None:
        theme = Theme(
            colors={},
            shadow="",
            fonts={"mono": FontSpec(family="Mono Font", weights=["400"], italics=False)},
        )
        css = generate_theme_css(theme)
        assert "--font-mono:'Mono Font';" in css


class TestFontsUrl:
    def test_no_italics_uses_plain_weight_axis(self) -> None:
        theme = Theme(
            colors={},
            shadow="",
            fonts={"sans": FontSpec(family="Jost", weights=["400", "300"], italics=False)},
        )
        url = generate_fonts_url(theme)
        assert url.startswith("https://fonts.googleapis.com/css2?")
        assert "family=Jost:wght@300;400" in url

    def test_italics_uses_ital_wght_axis_pairs(self) -> None:
        theme = Theme(
            colors={},
            shadow="",
            fonts={
                "serif": FontSpec(family="Cormorant Garamond", weights=["400", "600"], italics=True)
            },
        )
        url = generate_fonts_url(theme)
        assert "family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400;1,600" in url

    def test_multiple_families_joined(self) -> None:
        theme = Theme(
            colors={},
            shadow="",
            fonts={
                "serif": FontSpec(family="A Font", weights=["400"], italics=False),
                "sans": FontSpec(family="B Font", weights=["400"], italics=False),
            },
        )
        url = generate_fonts_url(theme)
        assert url.count("family=") == 2
        assert "&display=swap" in url
