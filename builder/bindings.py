"""The `data-wx-*` binding resolution engine (spec/02-content-model.md §2, normative).

One recursive DOM walk applies every binding kind to a parsed page (after partial
markers have already been substituted, so partials are covered by the same pass).
Two error-handling modes, chosen by whether a `ValidationResult` sink is supplied:

- `sink=None` (real build): the first unresolvable binding raises `BuildError` —
  "the builder fails the build on a missing key... strict, no silent fallback" (02 §2).
- `sink=ValidationResult()` (validate): problems are collected and traversal continues
  with a safe fallback, so `validate()` can report every problem in one pass (02 §10).
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, replace
from typing import Literal

from bs4 import BeautifulSoup, Tag

from builder.content import dotted_get
from builder.errors import BuildError, ValidationResult
from builder.jsontypes import JsonObject, JsonValue
from builder.sanitize import sanitize_rich_lite

ATTR_TEXT = "data-wx"
ATTR_IMG = "data-wx-img"
ATTR_HREF = "data-wx-href"
ATTR_BG = "data-wx-bg"
ATTR_ATTR = "data-wx-attr"
ATTR_LIST = "data-wx-list"
ATTR_LIST_ITEM = "data-wx-list-item"
ATTR_IF = "data-wx-if"
ATTR_HIDDEN = "data-wx-hidden"

Mode = Literal["publish", "preview"]

_BG_PROP_RE = re.compile(r"background-image\s*:[^;]*;?\s*")


@dataclass(frozen=True, slots=True)
class ResolveContext:
    """The three binding scopes in play at any point in the tree (02 §2)."""

    page: JsonObject
    glob: JsonObject
    item: JsonObject | None = None


def resolve_key(ctx: ResolveContext, key: str) -> tuple[bool, JsonValue]:
    """Resolve a binding key against the right scope per its prefix (02 §2)."""
    if key.startswith("@"):
        return dotted_get(ctx.glob, key[1:])
    if key.startswith("."):
        if ctx.item is None:
            return False, None
        return dotted_get(ctx.item, key[1:])
    return dotted_get(ctx.page, key)


def is_wx_falsy(value: JsonValue) -> bool:
    """`data-wx-if` truthiness: JS-falsy rules, exactly `false`/`null`/`""`/`[]` (02 §2)."""
    if value is False or value is None:
        return True
    if isinstance(value, str) and value == "":
        return True
    if isinstance(value, list) and len(value) == 0:
        return True
    return False


def _fail(sink: ValidationResult | None, file_label: str, key: str, message: str) -> None:
    if sink is None:
        raise BuildError(message, location=f"{file_label}:{key}")
    sink.add("binding-error", message, file=file_label, key=key)


def apply_bindings(
    root: Tag,
    ctx: ResolveContext,
    *,
    mode: Mode,
    file_label: str,
    sink: ValidationResult | None = None,
) -> None:
    """Apply every `data-wx-*` binding within `root` (typically a page's `<body>`)."""
    _walk(root, ctx, mode=mode, file_label=file_label, sink=sink)


def _walk(
    el: Tag, ctx: ResolveContext, *, mode: Mode, file_label: str, sink: ValidationResult | None
) -> None:
    if_expr = el.get(ATTR_IF)
    if isinstance(if_expr, str):
        keep = _evaluate_if(ctx, if_expr, file_label=file_label, sink=sink)
        if not keep:
            if mode == "publish":
                el.extract()
                return
            el[ATTR_HIDDEN] = "1"
        elif el.has_attr(ATTR_HIDDEN):
            del el[ATTR_HIDDEN]

    list_key = el.get(ATTR_LIST)
    if isinstance(list_key, str):
        _expand_list(el, list_key, ctx, mode=mode, file_label=file_label, sink=sink)
        return

    _apply_scalar(el, ctx, file_label=file_label, sink=sink)

    for child in list(el.find_all(recursive=False)):
        _walk(child, ctx, mode=mode, file_label=file_label, sink=sink)


def _evaluate_if(
    ctx: ResolveContext, expr: str, *, file_label: str, sink: ValidationResult | None
) -> bool:
    negate = expr.startswith("!")
    real_key = expr[1:] if negate else expr
    found, value = resolve_key(ctx, real_key)
    if not found:
        _fail(sink, file_label, real_key, f"data-wx-if key '{real_key}' does not resolve")
        value = None
    truthy = not is_wx_falsy(value)
    return (not truthy) if negate else truthy


def _expand_list(
    container: Tag,
    list_key: str,
    ctx: ResolveContext,
    *,
    mode: Mode,
    file_label: str,
    sink: ValidationResult | None,
) -> None:
    found, value = resolve_key(ctx, list_key)
    if not found or not isinstance(value, list):
        _fail(sink, file_label, list_key, f"list binding '{list_key}' does not resolve to an array")
        return
    item_template = container.find(attrs={ATTR_LIST_ITEM: True})
    if item_template is None or not isinstance(item_template, Tag):
        _fail(
            sink,
            file_label,
            list_key,
            f"list container '{list_key}' has no data-wx-list-item template",
        )
        return
    template_source = item_template.extract()
    for index, item_value in enumerate(value):
        if not isinstance(item_value, dict):
            _fail(
                sink,
                file_label,
                f"{list_key}[{index}]",
                f"list item {index} of '{list_key}' is not an object",
            )
            continue
        clone = copy.deepcopy(template_source)
        item_ctx = replace(ctx, item=item_value)
        _walk(clone, item_ctx, mode=mode, file_label=file_label, sink=sink)
        container.append(clone)


def _apply_scalar(
    el: Tag, ctx: ResolveContext, *, file_label: str, sink: ValidationResult | None
) -> None:
    text_key = el.get(ATTR_TEXT)
    if isinstance(text_key, str):
        _apply_text(el, ctx, text_key, file_label=file_label, sink=sink)

    img_key = el.get(ATTR_IMG)
    if isinstance(img_key, str):
        _apply_img(el, ctx, img_key, file_label=file_label, sink=sink)

    href_key = el.get(ATTR_HREF)
    if isinstance(href_key, str):
        _apply_href(el, ctx, href_key, file_label=file_label, sink=sink)

    bg_key = el.get(ATTR_BG)
    if isinstance(bg_key, str):
        _apply_bg(el, ctx, bg_key, file_label=file_label, sink=sink)

    attr_spec = el.get(ATTR_ATTR)
    if isinstance(attr_spec, str):
        _apply_attrs(el, ctx, attr_spec, file_label=file_label, sink=sink)


def _apply_text(
    el: Tag, ctx: ResolveContext, key: str, *, file_label: str, sink: ValidationResult | None
) -> None:
    found, value = resolve_key(ctx, key)
    if not found or not isinstance(value, str):
        _fail(sink, file_label, key, f"text binding '{key}' does not resolve to a string")
        return
    clean = sanitize_rich_lite(value)
    if sink is not None and clean != value:
        sink.add(
            "not-clean",
            f"value for '{key}' is not already clean (sanitizes to a different string)",
            file=file_label,
            key=key,
        )
    el.clear()
    fragment = BeautifulSoup(clean, "html5lib")
    body = fragment.body
    if body is not None:
        for node in list(body.contents):
            el.append(node.extract())


def _apply_img(
    el: Tag, ctx: ResolveContext, key: str, *, file_label: str, sink: ValidationResult | None
) -> None:
    found, value = resolve_key(ctx, key)
    if not found or not isinstance(value, dict) or "src" not in value:
        _fail(sink, file_label, key, f"image binding '{key}' does not resolve to {{src, alt}}")
        return
    src = value.get("src")
    alt = value.get("alt", "")
    if not isinstance(src, str) or not isinstance(alt, str):
        _fail(sink, file_label, key, f"image binding '{key}' has non-string src/alt")
        return
    el["src"] = src
    el["alt"] = alt


def _apply_href(
    el: Tag, ctx: ResolveContext, key: str, *, file_label: str, sink: ValidationResult | None
) -> None:
    found, value = resolve_key(ctx, key)
    if not found or not isinstance(value, str):
        _fail(sink, file_label, key, f"href binding '{key}' does not resolve to a string")
        return
    el["href"] = value


def _apply_bg(
    el: Tag, ctx: ResolveContext, key: str, *, file_label: str, sink: ValidationResult | None
) -> None:
    found, value = resolve_key(ctx, key)
    if not found or not isinstance(value, dict) or "src" not in value:
        _fail(
            sink,
            file_label,
            key,
            f"background-image binding '{key}' does not resolve to {{src, alt}}",
        )
        return
    src = value.get("src")
    if not isinstance(src, str):
        _fail(sink, file_label, key, f"background-image binding '{key}' has a non-string src")
        return
    existing = el.get("style")
    existing_str = existing if isinstance(existing, str) else ""
    existing_str = _BG_PROP_RE.sub("", existing_str).strip().rstrip(";")
    decl = f"background-image:url({src})"
    el["style"] = f"{existing_str};{decl}" if existing_str else decl


def parse_attr_spec(spec: str) -> list[tuple[str, str] | None]:
    """Parse a `data-wx-attr` spec (`"attr:key[,attr2:key2]"`) into `(attr_name, key)`
    pairs, one per comma-separated entry; a malformed entry (no `:`) yields `None` in
    its slot so callers can report it against the right raw text. Shared by
    `_apply_attrs` (below) and `builder.bindings_map`'s static extractor so the two
    can't drift on what counts as a valid pair (spec/02 §2)."""
    pairs: list[tuple[str, str] | None] = []
    for raw_pair in spec.split(","):
        pair = raw_pair.strip()
        if ":" not in pair:
            pairs.append(None)
            continue
        attr_name, key = (part.strip() for part in pair.split(":", 1))
        pairs.append((attr_name, key))
    return pairs


def _apply_attrs(
    el: Tag, ctx: ResolveContext, spec: str, *, file_label: str, sink: ValidationResult | None
) -> None:
    for raw_pair, parsed in zip(spec.split(","), parse_attr_spec(spec), strict=True):
        if parsed is None:
            pair = raw_pair.strip()
            _fail(sink, file_label, spec, f"malformed data-wx-attr entry '{pair}' (want attr:key)")
            continue
        attr_name, key = parsed
        found, value = resolve_key(ctx, key)
        if not found or not isinstance(value, str):
            _fail(
                sink,
                file_label,
                key,
                f"attribute binding '{key}' (for '{attr_name}') does not resolve to a string",
            )
            continue
        el[attr_name] = value
