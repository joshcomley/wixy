"""Bindings-map extraction tests (spec/04 §4; format PROVISIONAL, decisions/00012).

Two fixture sources: the shared `mini_site_source` (real templates, real partials —
`conftest.py`) proves extraction against genuine markup end-to-end; a handful of
synthetic tmp_path pages (`_write_page`) isolate edge cases the real fixture doesn't
happen to exercise (malformed specs, content-free extraction).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from builder.bindings_map import (
    BindingField,
    PageBindings,
    bindings_map_to_dict,
    extract_bindings_map,
)
from builder.config import MediaConfig, ProjectConfig
from builder.render import SiteSource


def _field(fields: tuple[BindingField, ...], key: str, kind: str) -> BindingField:
    for f in fields:
        if f.key == key and f.kind == kind:
            return f
    raise AssertionError(f"no field ({key!r}, {kind!r}) in {[(f.key, f.kind) for f in fields]}")


class TestIndexPageAgainstRealFixture:
    def test_scalar_kinds(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        assert _field(mapping.fields, "hero.bg", "bg")
        assert _field(mapping.fields, "hero.title", "text")
        assert _field(mapping.fields, "hero.tag", "text")
        assert _field(mapping.fields, "hero.ctaHref", "href")
        assert _field(mapping.fields, "hero.ctaLabel", "text")
        assert _field(mapping.fields, "hero.badge", "text")
        assert _field(mapping.fields, "hero.extra", "text")

    def test_if_kind_negation_stripped(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        # hero.hideExtra is referenced as "!hero.hideExtra" in the template — the "!"
        # must not leak into the recorded key.
        assert _field(mapping.fields, "hero.hideExtra", "if")
        assert _field(mapping.fields, "hero.showBadge", "if")
        assert not any(f.key.startswith("!") for f in mapping.fields)

    def test_global_key_from_partial(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        assert _field(mapping.fields, "@brand.line1", "text")
        assert _field(mapping.fields, "@phone", "text")  # from the footer partial

    def test_attr_kind_records_target_attribute(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        field = _field(mapping.fields, "@bookingUrl", "attr")
        assert field.attr_name == "data-booking-url"

    def test_nav_excluded_but_footer_legal_list_included(
        self, mini_site_source: SiteSource
    ) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        assert not any(f.key == "@nav" for f in mapping.fields)
        legal = _field(mapping.fields, "@footer.legal", "list")
        assert legal.items is not None
        item_keys = {(f.key, f.kind) for f in legal.items}
        assert item_keys == {(".href", "href"), (".label", "text")}

    def test_showcase_items_nested_shape(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        showcase = _field(mapping.fields, "showcase.items", "list")
        assert showcase.items is not None
        item_keys = {(f.key, f.kind) for f in showcase.items}
        assert item_keys == {
            (".img", "img"),
            (".title", "text"),
            (".body", "text"),
            (".book", "if"),
            (".bookHref", "href"),
            (".enquireHref", "href"),
            (".tags", "list"),
        }

    def test_book_key_deduped_across_negated_and_plain_if(
        self, mini_site_source: SiteSource
    ) -> None:
        """`.book` gates two sibling anchors (`.book` / `!.book`, spec/02 §3's CTA
        pattern) — one editable boolean field, not two."""
        mapping = extract_bindings_map(mini_site_source, "index")
        showcase = _field(mapping.fields, "showcase.items", "list")
        assert showcase.items is not None
        book_fields = [f for f in showcase.items if f.key == ".book"]
        assert len(book_fields) == 1
        assert book_fields[0].kind == "if"

    def test_nested_list_of_lists(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        showcase = _field(mapping.fields, "showcase.items", "list")
        assert showcase.items is not None
        tags = _field(showcase.items, ".tags", "list")
        assert tags.items is not None
        assert {(f.key, f.kind) for f in tags.items} == {(".label", "text")}


class TestAboutPageAgainstRealFixture:
    def test_if_and_text_fields(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "about")
        assert mapping.page == "about"
        assert _field(mapping.fields, "intro.title", "text")
        assert _field(mapping.fields, "intro.body", "text")
        assert _field(mapping.fields, "intro.showNotice", "if")
        assert _field(mapping.fields, "intro.notice", "text")


class TestBindingsMapToDict:
    def test_shape_omits_absent_optional_keys(self, mini_site_source: SiteSource) -> None:
        mapping = extract_bindings_map(mini_site_source, "index")
        data = bindings_map_to_dict(mapping)
        assert data["page"] == "index"
        fields_raw = data["fields"]
        assert isinstance(fields_raw, list)
        # JsonValue can't be narrowed through chained subscripting under --strict
        # (same reasoning builder/tests/test_validate.py's docstring documents) —
        # narrow explicitly instead of chaining ["key"] straight off `data`.
        fields = [f for f in fields_raw if isinstance(f, dict)]
        assert len(fields) == len(fields_raw)
        by_key = {(f["key"], f["kind"]): f for f in fields}
        text_field = by_key[("hero.title", "text")]
        assert "attr" not in text_field
        assert "items" not in text_field
        attr_field = by_key[("@bookingUrl", "attr")]
        assert attr_field["attr"] == "data-booking-url"
        list_field = by_key[("showcase.items", "list")]
        assert isinstance(list_field["items"], list)
        assert "attr" not in list_field


@pytest.fixture
def dummy_project() -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test",
        repo="https://example.invalid/test.git",
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=False,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


def _write_page(tmp_path: Path, project: ProjectConfig, body_html: str) -> SiteSource:
    """A minimal synthetic page (all 3 partial markers + trivial matching partials, no
    content files at all) — isolates edge cases the real mini-site fixture doesn't
    happen to exercise. `page_contents`/`global_content` are deliberately empty: proves
    extraction never needs any real content (decisions/00012 decision 3)."""
    pages_dir = tmp_path / "pages"
    partials_dir = tmp_path / "partials"
    pages_dir.mkdir()
    partials_dir.mkdir()
    for name in ("header", "footer", "booking-modal"):
        (partials_dir / f"{name}.html").write_text("<body></body>\n", encoding="utf-8")
    (pages_dir / "test.html").write_text(
        "<!DOCTYPE html><html><head><title>t</title></head>"
        "<body>"
        "<!-- wx:partial header -->"
        f"{body_html}"
        "<!-- wx:partial footer -->"
        "<!-- wx:partial booking-modal -->"
        "</body></html>\n",
        encoding="utf-8",
    )
    return SiteSource(
        project=project,
        pages_dir=pages_dir,
        partials_dir=partials_dir,
        theme=None,
        page_contents={},
        global_content={},
        content_dir=tmp_path / "content",
    )


class TestSyntheticEdgeCases:
    def test_extraction_needs_no_content_file_at_all(
        self, tmp_path: Path, dummy_project: ProjectConfig
    ) -> None:
        source = _write_page(tmp_path, dummy_project, '<p data-wx="greeting">Hi</p>')
        mapping = extract_bindings_map(source, "test")
        assert mapping == PageBindings(
            page="test", fields=(BindingField(key="greeting", kind="text"),)
        )

    def test_list_with_no_item_template_yields_empty_items_not_a_crash(
        self, tmp_path: Path, dummy_project: ProjectConfig
    ) -> None:
        source = _write_page(tmp_path, dummy_project, '<ul data-wx-list="things"></ul>')
        mapping = extract_bindings_map(source, "test")
        things = _field(mapping.fields, "things", "list")
        assert things.items == ()

    def test_malformed_attr_spec_entry_is_skipped_not_a_crash(
        self, tmp_path: Path, dummy_project: ProjectConfig
    ) -> None:
        source = _write_page(
            tmp_path, dummy_project, '<div data-wx-attr="no-colon-here,ok:realKey"></div>'
        )
        mapping = extract_bindings_map(source, "test")
        assert _field(mapping.fields, "realKey", "attr").attr_name == "ok"
        assert not any(f.kind == "attr" and f.key == "no-colon-here" for f in mapping.fields)

    def test_empty_page_yields_no_fields(
        self, tmp_path: Path, dummy_project: ProjectConfig
    ) -> None:
        source = _write_page(tmp_path, dummy_project, "<p>Nothing bound here.</p>")
        mapping = extract_bindings_map(source, "test")
        assert mapping.fields == ()
