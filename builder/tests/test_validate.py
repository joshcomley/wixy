"""`validate_site` tests (spec/02-content-model.md §10) — happy path + every failure kind,
via mutated copies of the fixture SiteSource (dataclasses.replace, since SiteSource is
frozen) so each test stays isolated without touching the committed fixture files.

Nested mutations go through `dotted_set` (the library's own utility) rather than chained
`dict.__setitem__` — `JsonValue` is a big recursive union, so mypy can't narrow through
chained indexing on it, whereas `dotted_set` is already properly typed for exactly this.
"""

from __future__ import annotations

import copy
import dataclasses
from pathlib import Path

from builder.content import dotted_set
from builder.jsontypes import JsonObject
from builder.render import SiteSource
from builder.theme import FontSpec
from builder.validate import validate_site


def _with_page_content(source: SiteSource, slug: str, content: JsonObject) -> SiteSource:
    pages = dict(source.page_contents)
    pages[slug] = content
    return dataclasses.replace(source, page_contents=pages)


def _with_global_content(source: SiteSource, content: JsonObject) -> SiteSource:
    return dataclasses.replace(source, global_content=content)


class TestHappyPath:
    def test_fixture_validates_clean(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        result = validate_site(mini_site_source, mini_site_root)
        assert result.ok
        assert result.errors == []


class TestBindingFailures:
    def test_missing_binding_key_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        index: JsonObject = copy.deepcopy(mini_site_source.page_contents["index"])
        del index["hero"]
        source = _with_page_content(mini_site_source, "index", index)
        result = validate_site(source, mini_site_root)
        assert not result.ok
        assert any(e.file == "pages/index.html" for e in result.errors)

    def test_missing_meta_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        index: JsonObject = copy.deepcopy(mini_site_source.page_contents["index"])
        del index["meta"]
        source = _with_page_content(mini_site_source, "index", index)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "missing-meta" for e in result.errors)


class TestImageFailures:
    def test_missing_image_file_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        index: JsonObject = copy.deepcopy(mini_site_source.page_contents["index"])
        dotted_set(index, "hero.bg.src", "images/does-not-exist.jpg")
        source = _with_page_content(mini_site_source, "index", index)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "missing-image" for e in result.errors)


class TestThemeFailures:
    def test_bad_hex_color_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        theme = dataclasses.replace(mini_site_source.theme, colors={"cream": "not-a-color"})
        source = dataclasses.replace(mini_site_source, theme=theme)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "bad-color" for e in result.errors)

    def test_bad_font_weight_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        fonts = dict(mini_site_source.theme.fonts)
        fonts["serif"] = FontSpec(family="X", weights=["abc"], italics=False)
        theme = dataclasses.replace(mini_site_source.theme, fonts=fonts)
        source = dataclasses.replace(mini_site_source, theme=theme)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "bad-weight" for e in result.errors)

    def test_missing_font_role_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        fonts = dict(mini_site_source.theme.fonts)
        del fonts["script"]
        theme = dataclasses.replace(mini_site_source.theme, fonts=fonts)
        source = dataclasses.replace(mini_site_source, theme=theme)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "missing-font-role" and e.key == "fonts.script" for e in result.errors)


class TestCollectionSchemaFailures:
    """These keys aren't referenced by the fixture templates — `_validate_collections`
    checks the fixed v1 collection keys (02 §6) directly against content, independent
    of whether any template binding currently points at them.
    """

    def test_treatment_cards_schema_violation(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        index: JsonObject = copy.deepcopy(mini_site_source.page_contents["index"])
        dotted_set(index, "treatments.cards", [{"title": "Missing other required fields"}])
        source = _with_page_content(mini_site_source, "index", index)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "schema" and e.key == "treatments.cards" for e in result.errors)

    def test_hours_schema_violation(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        glob: JsonObject = copy.deepcopy(mini_site_source.global_content)
        dotted_set(glob, "hours", [{"day": "Monday"}])  # missing value/closed
        source = _with_global_content(mini_site_source, glob)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "schema" and e.key == "hours" for e in result.errors)

    def test_sections_cards_special_case(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        treatments: JsonObject = {
            "meta": {"title": "T", "description": "D", "inNav": False, "navOrder": 0},
            "sections": [{"cards": [{"title": "bad"}]}],
        }
        source = dataclasses.replace(
            mini_site_source,
            page_contents={**mini_site_source.page_contents, "treatments": treatments},
        )
        result = validate_site(source, mini_site_root)
        assert any(e.code == "schema" and e.key == "sections[0].cards" for e in result.errors)

    def test_sections_not_a_list_of_objects_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        treatments: JsonObject = {
            "meta": {"title": "T", "description": "D"},
            "sections": ["not-an-object"],
        }
        source = dataclasses.replace(
            mini_site_source,
            page_contents={**mini_site_source.page_contents, "treatments": treatments},
        )
        result = validate_site(source, mini_site_root)
        assert any(e.code == "bad-collection" and e.key == "sections[0]" for e in result.errors)

    def test_footer_link_schema_violation(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        glob: JsonObject = copy.deepcopy(mini_site_source.global_content)
        dotted_set(glob, "footer.legal", [{"label": "No href"}])
        source = _with_global_content(mini_site_source, glob)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "schema" and e.key == "footer.legal" for e in result.errors)

    def test_collection_not_an_array_reported(
        self, mini_site_source: SiteSource, mini_site_root: Path
    ) -> None:
        glob: JsonObject = copy.deepcopy(mini_site_source.global_content)
        dotted_set(glob, "hours", "not-an-array")
        source = _with_global_content(mini_site_source, glob)
        result = validate_site(source, mini_site_root)
        assert any(e.code == "bad-collection" and e.key == "hours" for e in result.errors)
