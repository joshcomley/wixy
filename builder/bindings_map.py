"""The bindings-map extractor (spec/04-server.md §4; format PROVISIONAL —
decisions/00012 has the full design rationale, read it before changing this module).

Walks a page's **raw, pre-render template** (after partial injection, before any
`apply_bindings` call) to describe every `data-wx-*` binding it declares: key, kind,
and — for `data-wx-list` containers — the item template's own nested shape. This is a
purely structural read, never a value resolution: no `ResolveContext`, nothing can
fail. Walking the unrendered template (rather than a rendered/value-resolved one)
means a currently-empty list still yields its item shape, and a currently-false
`data-wx-if` branch's bindings are still found — see decisions/00012 decision 3.
"""

from __future__ import annotations

from dataclasses import dataclass

from bs4 import Tag

from builder.bindings import (
    ATTR_ATTR,
    ATTR_BG,
    ATTR_HREF,
    ATTR_IF,
    ATTR_IMG,
    ATTR_LIST,
    ATTR_LIST_ITEM,
    ATTR_TEXT,
    parse_attr_spec,
)
from builder.jsontypes import JsonObject
from builder.render import SiteSource, prepare_page_body

# spec/02 §3: "`@nav` does not exist in `_global.json`"; the builder computes it and
# the editor "must not offer `@nav` item editing" — excluded here so that "is this key
# in the bindings map" stays a safe proxy for "is this a generically list-editable
# field" everywhere the map is consulted (decisions/00012 decision 8).
_COMPUTED_GLOBAL_KEYS = frozenset({"@nav"})

BindingKind = str  # one of "text" | "img" | "href" | "bg" | "attr" | "list" | "if"


@dataclass(frozen=True, slots=True)
class BindingField:
    """One bindable key on a page: its `data-wx-*` kind, plus kind-specific extras.

    `attr_name` is set only for `kind == "attr"` (the HTML attribute it sets).
    `items` is set only for `kind == "list"` (the item template's own nested fields,
    keys still `.`-prefixed as written — spec/02 §2's relative-key convention).
    """

    key: str
    kind: BindingKind
    attr_name: str | None = None
    items: tuple[BindingField, ...] | None = None


@dataclass(frozen=True, slots=True)
class PageBindings:
    page: str
    fields: tuple[BindingField, ...]


def _record(entries: dict[tuple[str, str], BindingField], field: BindingField) -> None:
    """First-DOM-occurrence wins — dedupe by `(key, kind)` (decisions/00012 decision 5:
    the map is an inventory of keys, not a per-occurrence DOM log)."""
    entries.setdefault((field.key, field.kind), field)


def _walk_static(el: Tag, entries: dict[tuple[str, str], BindingField]) -> None:
    if_spec = el.get(ATTR_IF)
    if isinstance(if_spec, str):
        key = if_spec[1:] if if_spec.startswith("!") else if_spec
        _record(entries, BindingField(key=key, kind="if"))

    list_key = el.get(ATTR_LIST)
    if isinstance(list_key, str):
        item_entries: dict[tuple[str, str], BindingField] = {}
        item_template = el.find(attrs={ATTR_LIST_ITEM: True})
        if isinstance(item_template, Tag):
            _walk_static(item_template, item_entries)
        if list_key not in _COMPUTED_GLOBAL_KEYS:
            _record(
                entries,
                BindingField(key=list_key, kind="list", items=tuple(item_entries.values())),
            )
        return  # mirrors bindings.py's _walk: a list container's own children are
        # only ever reached through its item template, never walked directly.

    _record_scalars(el, entries)

    for child in el.find_all(recursive=False):
        if isinstance(child, Tag):
            _walk_static(child, entries)


def _record_scalars(el: Tag, entries: dict[tuple[str, str], BindingField]) -> None:
    text_key = el.get(ATTR_TEXT)
    if isinstance(text_key, str):
        _record(entries, BindingField(key=text_key, kind="text"))

    img_key = el.get(ATTR_IMG)
    if isinstance(img_key, str):
        _record(entries, BindingField(key=img_key, kind="img"))

    href_key = el.get(ATTR_HREF)
    if isinstance(href_key, str):
        _record(entries, BindingField(key=href_key, kind="href"))

    bg_key = el.get(ATTR_BG)
    if isinstance(bg_key, str):
        _record(entries, BindingField(key=bg_key, kind="bg"))

    attr_spec = el.get(ATTR_ATTR)
    if isinstance(attr_spec, str):
        for parsed in parse_attr_spec(attr_spec):
            if parsed is None:
                continue  # a malformed data-wx-attr entry — apply_bindings's real
                # pass reports this at build/validate time; extraction just skips it.
            attr_name, key = parsed
            _record(entries, BindingField(key=key, kind="attr", attr_name=attr_name))


def extract_bindings_map(source: SiteSource, slug: str) -> PageBindings:
    """The full binding contract for one page — everything `GET /admin/preview/{page}.html`
    (spec/04 §4) and `GET /api/admin/content/{page}` (spec/04 §8) need to describe a
    page's editable fields without re-deriving them from the DOM at consume time."""
    _soup, body, _file_label = prepare_page_body(source, slug)
    entries: dict[tuple[str, str], BindingField] = {}
    _walk_static(body, entries)
    return PageBindings(page=slug, fields=tuple(entries.values()))


def _field_to_dict(field: BindingField) -> JsonObject:
    out: JsonObject = {"key": field.key, "kind": field.kind}
    if field.attr_name is not None:
        out["attr"] = field.attr_name
    if field.items is not None:
        out["items"] = [_field_to_dict(item) for item in field.items]
    return out


def bindings_map_to_dict(mapping: PageBindings) -> JsonObject:
    """The JSON shape embedded as `<script type="application/json" id="wx-bindings">`."""
    return {
        "page": mapping.page,
        "fields": [_field_to_dict(field) for field in mapping.fields],
    }
