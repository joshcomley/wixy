"""Unit tests for the `data-wx-*` binding engine (spec/02-content-model.md §2)."""

from __future__ import annotations

import pytest
from bs4 import BeautifulSoup, Tag

from builder.bindings import ResolveContext, apply_bindings, is_wx_falsy, resolve_key
from builder.errors import BuildError, ValidationResult
from builder.jsontypes import JsonValue


def _body(html: str) -> Tag:
    soup = BeautifulSoup(html, "html5lib")
    assert isinstance(soup.body, Tag)
    return soup.body


def _find(root: Tag, name: str) -> Tag:
    el = root.find(name)
    assert isinstance(el, Tag)
    return el


class TestResolveKey:
    def test_plain_key_resolves_in_page(self) -> None:
        ctx = ResolveContext(page={"hero": {"title": "X"}}, glob={})
        assert resolve_key(ctx, "hero.title") == (True, "X")

    def test_at_prefixed_key_resolves_in_global(self) -> None:
        ctx = ResolveContext(page={}, glob={"phone": "123"})
        assert resolve_key(ctx, "@phone") == (True, "123")

    def test_at_prefixed_key_supports_dotted_path(self) -> None:
        ctx = ResolveContext(page={}, glob={"brand": {"line1": "Cottage"}})
        assert resolve_key(ctx, "@brand.line1") == (True, "Cottage")

    def test_dot_prefixed_key_resolves_in_item(self) -> None:
        ctx = ResolveContext(page={}, glob={}, item={"title": "Item"})
        assert resolve_key(ctx, ".title") == (True, "Item")

    def test_dot_prefixed_key_without_item_not_found(self) -> None:
        ctx = ResolveContext(page={}, glob={})
        found, _ = resolve_key(ctx, ".title")
        assert found is False

    def test_missing_key_not_found(self) -> None:
        ctx = ResolveContext(page={"a": 1}, glob={})
        found, _ = resolve_key(ctx, "b")
        assert found is False

    def test_dotted_path_through_list_is_not_found(self) -> None:
        ctx = ResolveContext(page={"items": [1, 2]}, glob={})
        found, _ = resolve_key(ctx, "items.0")
        assert found is False


class TestIsWxFalsy:
    @pytest.mark.parametrize("value", [False, None, "", []])
    def test_falsy_values(self, value: JsonValue) -> None:
        assert is_wx_falsy(value) is True

    @pytest.mark.parametrize("value", [True, "x", [1], 0, 0.0, {}, {"a": 1}])
    def test_truthy_values(self, value: JsonValue) -> None:
        # 0 is deliberately NOT falsy here — the spec enumerates exactly
        # false/null/""/[] as falsy (02 §2), unlike real JS `Boolean()` coercion.
        assert is_wx_falsy(value) is False


class TestTextBinding:
    def test_sets_sanitized_innerhtml(self) -> None:
        body = _body('<h1 data-wx="title">placeholder</h1>')
        ctx = ResolveContext(
            page={"title": "Hi <script>bad()</script><strong>world</strong>"}, glob={}
        )
        apply_bindings(body, ctx, mode="publish", file_label="test")
        h1 = _find(body, "h1")
        assert "<strong>world</strong>" in str(h1)
        assert "script" not in str(h1)
        assert "Hi" in str(h1)

    def test_missing_key_raises_in_build_mode(self) -> None:
        body = _body('<h1 data-wx="title">placeholder</h1>')
        ctx = ResolveContext(page={}, glob={})
        with pytest.raises(BuildError):
            apply_bindings(body, ctx, mode="publish", file_label="test")

    def test_missing_key_collects_in_validate_mode(self) -> None:
        body = _body('<h1 data-wx="title">placeholder</h1>')
        ctx = ResolveContext(page={}, glob={})
        result = ValidationResult()
        apply_bindings(body, ctx, mode="preview", file_label="test", sink=result)
        assert not result.ok
        assert result.errors[0].key == "title"

    def test_not_already_clean_reported_in_validate_mode(self) -> None:
        body = _body('<p data-wx="body">placeholder</p>')
        ctx = ResolveContext(page={"body": "<div>nope</div>"}, glob={})
        result = ValidationResult()
        apply_bindings(body, ctx, mode="preview", file_label="test", sink=result)
        assert any(e.code == "not-clean" for e in result.errors)


class TestImgBinding:
    def test_sets_src_and_alt(self) -> None:
        body = _body('<img data-wx-img="hero.bg" src="" alt="">')
        ctx = ResolveContext(page={"hero": {"bg": {"src": "images/x.jpg", "alt": "X"}}}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        img = _find(body, "img")
        assert img["src"] == "images/x.jpg"
        assert img["alt"] == "X"

    def test_wrong_shape_raises(self) -> None:
        body = _body('<img data-wx-img="hero.bg" src="" alt="">')
        ctx = ResolveContext(page={"hero": {"bg": "not-an-object"}}, glob={})
        with pytest.raises(BuildError):
            apply_bindings(body, ctx, mode="publish", file_label="test")


class TestHrefBinding:
    def test_sets_href(self) -> None:
        body = _body('<a data-wx-href="cta">x</a>')
        ctx = ResolveContext(page={"cta": "/about.html"}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        assert _find(body, "a")["href"] == "/about.html"


class TestBgBinding:
    def test_writes_inline_style(self) -> None:
        body = _body('<section data-wx-bg="hero.bg"></section>')
        ctx = ResolveContext(page={"hero": {"bg": {"src": "images/x.jpg", "alt": ""}}}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        style = _find(body, "section")["style"]
        assert style == "background-image:url(images/x.jpg)"

    def test_preserves_other_style_declarations(self) -> None:
        body = _body(
            '<section data-wx-bg="hero.bg" style="background-position:center;'
            'background-image:url(old.jpg)"></section>'
        )
        ctx = ResolveContext(page={"hero": {"bg": {"src": "images/new.jpg", "alt": ""}}}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        style = _find(body, "section")["style"]
        assert isinstance(style, str)
        assert "background-position:center" in style
        assert "url(images/new.jpg)" in style
        assert "old.jpg" not in style


class TestAttrBinding:
    def test_sets_single_attribute(self) -> None:
        body = _body('<body data-wx-attr="data-booking-url:@bookingUrl"></body>')
        ctx = ResolveContext(page={}, glob={"bookingUrl": "https://example.com/book"})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        assert body["data-booking-url"] == "https://example.com/book"

    def test_sets_multiple_attributes(self) -> None:
        body = _body('<div data-wx-attr="data-a:one,data-b:two"></div>')
        ctx = ResolveContext(page={"one": "1", "two": "2"}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        div = _find(body, "div")
        assert div["data-a"] == "1"
        assert div["data-b"] == "2"


class TestIfBinding:
    def test_publish_mode_removes_falsy(self) -> None:
        body = _body('<div><p data-wx-if="flag">x</p></div>')
        ctx = ResolveContext(page={"flag": False}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        assert body.find("p") is None

    def test_publish_mode_keeps_truthy(self) -> None:
        body = _body('<div><p data-wx-if="flag" data-wx="flag2">x</p></div>')
        ctx = ResolveContext(page={"flag": True, "flag2": "shown"}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        p = _find(body, "p")
        assert "shown" in str(p)

    def test_preview_mode_hides_instead_of_removing(self) -> None:
        body = _body('<div><p data-wx-if="flag">x</p></div>')
        ctx = ResolveContext(page={"flag": False}, glob={})
        apply_bindings(body, ctx, mode="preview", file_label="test")
        p = _find(body, "p")
        assert p["data-wx-hidden"] == "1"

    def test_negation_flips_condition(self) -> None:
        body = _body('<div><p data-wx-if="!flag">x</p></div>')
        ctx = ResolveContext(page={"flag": True}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        assert body.find("p") is None

        body2 = _body('<div><p data-wx-if="!flag">x</p></div>')
        ctx2 = ResolveContext(page={"flag": False}, glob={})
        apply_bindings(body2, ctx2, mode="publish", file_label="test")
        assert body2.find("p") is not None

    def test_book_enquire_cta_pattern(self) -> None:
        html = (
            '<div><a data-wx-if=".book" data-wx-href=".bookHref">Book</a>'
            '<a data-wx-if="!.book" data-wx-href=".enquireHref">Enquire</a></div>'
        )
        body = _body(html)
        ctx = ResolveContext(
            page={},
            glob={},
            item={"book": True, "bookHref": "/book", "enquireHref": "/enquire"},
        )
        apply_bindings(body, ctx, mode="publish", file_label="test")
        links = body.find_all("a")
        assert len(links) == 1
        assert links[0]["href"] == "/book"


class TestListBinding:
    def test_expands_items_and_removes_template(self) -> None:
        html = (
            '<ul data-wx-list="items"><li data-wx-list-item data-wx=".label">placeholder</li></ul>'
        )
        body = _body(html)
        ctx = ResolveContext(page={"items": [{"label": "A"}, {"label": "B"}]}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        items = _find(body, "ul").find_all("li")
        assert [str(i.string) for i in items] == ["A", "B"]
        for item in items:
            assert item.has_attr("data-wx-list-item")

    def test_empty_array_leaves_no_items(self) -> None:
        html = '<ul data-wx-list="items"><li data-wx-list-item>x</li></ul>'
        body = _body(html)
        ctx = ResolveContext(page={"items": []}, glob={})
        apply_bindings(body, ctx, mode="publish", file_label="test")
        assert _find(body, "ul").find_all("li") == []

    def test_nested_lists_resolve_against_innermost_item(self) -> None:
        # The title binding lives on its OWN element (data-wx replaces an element's
        # entire innerHTML, so it can never share an element with a nested list).
        html = (
            '<ul data-wx-list="items">'
            "<li data-wx-list-item>"
            '<h3 data-wx=".title">placeholder</h3>'
            '<ul data-wx-list=".tags"><li data-wx-list-item data-wx=".label">t</li></ul>'
            "</li>"
            "</ul>"
        )
        body = _body(html)
        ctx = ResolveContext(
            page={"items": [{"title": "Parent", "tags": [{"label": "x"}, {"label": "y"}]}]},
            glob={},
        )
        apply_bindings(body, ctx, mode="publish", file_label="test")
        outer_li = _find(body, "li")
        assert _find(outer_li, "h3").string == "Parent"
        inner_labels = [li.string for li in outer_li.find_all("li")]
        assert inner_labels == ["x", "y"]

    def test_missing_list_item_template_collects_error(self) -> None:
        body = _body('<ul data-wx-list="items"></ul>')
        ctx = ResolveContext(page={"items": [{"a": 1}]}, glob={})
        result = ValidationResult()
        apply_bindings(body, ctx, mode="preview", file_label="test", sink=result)
        assert not result.ok

    def test_non_array_value_raises_in_build_mode(self) -> None:
        body = _body('<ul data-wx-list="items"><li data-wx-list-item>x</li></ul>')
        ctx = ResolveContext(page={"items": "not-a-list"}, glob={})
        with pytest.raises(BuildError):
            apply_bindings(body, ctx, mode="publish", file_label="test")
