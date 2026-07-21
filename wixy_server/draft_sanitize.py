"""Kind-aware sanitize of draft PATCH values (spec/04 §9, decisions/00074).

Every render lane already sanitizes text values at INSERT time
(`builder.bindings._apply_text` → `sanitize_rich_lite`), so markup smuggled into
the overlay could never reach public HTML. But the overlay STORE is itself
contracted to hold only already-clean values — `sanitize.py`'s docstring has
always claimed draft writes are sanitized ("04 §9"); they were not, until this
module. Enforcing at write time means every consumer of the store (publish
diffs, version diffs, the AI lane, future tooling) can trust it without
re-deriving the allowlist.

Sanitizing is KIND-AWARE: only text-kind string leaves pass through
`sanitize_rich_lite`. href/img/bg/meta values are plain strings that an HTML
sanitizer would corrupt (`&` in a query string becomes `&amp;`, etc.), and ops
whose path resolves to no binding (`meta.*`, theme, unknown pages) pass through
verbatim — the draft store is a general key/value overlay, not exclusively
rich-text.
"""

from __future__ import annotations

from builder.bindings_map import BindingField, extract_bindings_map
from builder.errors import BuildError
from builder.jsontypes import JsonValue
from builder.render import SiteSource
from builder.sanitize import sanitize_rich_lite
from wixy_server.overlay import SetOp


def _sanitize_item_value(value: JsonValue, field: BindingField | None) -> JsonValue:
    if field is None:
        return value
    if field.kind == "text" and isinstance(value, str):
        return sanitize_rich_lite(value)
    if field.kind == "list" and isinstance(value, list):
        item_fields = {item.key.lstrip("."): item for item in (field.items or ())}
        return [_sanitize_list_item(item, item_fields) for item in value]
    return value


def _sanitize_list_item(item: JsonValue, item_fields: dict[str, BindingField]) -> JsonValue:
    if not isinstance(item, dict):
        return item
    return {key: _sanitize_item_value(leaf, item_fields.get(key)) for key, leaf in item.items()}


class KindResolver:
    """`{file, path}` → bindings-map field, with per-page maps extracted lazily
    and cached across a PATCH's ops (extraction walks the raw template; a batch
    of ops against one page pays it once)."""

    def __init__(self, source: SiteSource) -> None:
        self._source = source
        self._cache: dict[str, dict[str, BindingField]] = {}

    def _fields_for_page(self, slug: str) -> dict[str, BindingField]:
        if slug not in self._cache:
            try:
                mapping = extract_bindings_map(self._source, slug)
                self._cache[slug] = {field.key: field for field in mapping.fields}
            except BuildError, OSError:
                # An unextractable page (e.g. staged-for-add — its template file
                # only materializes at publish) yields no kinds; its ops pass
                # through verbatim rather than failing the whole PATCH.
                self._cache[slug] = {}
        return self._cache[slug]

    def resolve(self, file: str, path: str) -> BindingField | None:
        if file == "_global":
            key = f"@{path}"
            # Global keys are bound FROM pages (`data-wx="@hours"` lives on the
            # contact/index templates) — first page that declares it wins.
            for slug in self._source.page_contents:
                field = self._fields_for_page(slug).get(key)
                if field is not None:
                    return field
            return None
        return self._fields_for_page(file).get(path)


def sanitize_set_ops(source: SiteSource, ops: list[SetOp]) -> list[SetOp]:
    """Return `ops` with every text-kind string leaf passed through
    `sanitize_rich_lite`; all other values byte-identical."""
    resolver = KindResolver(source)
    return [
        SetOp(
            file=op.file,
            path=op.path,
            value=_sanitize_item_value(op.value, resolver.resolve(op.file, op.path)),
        )
        for op in ops
    ]
