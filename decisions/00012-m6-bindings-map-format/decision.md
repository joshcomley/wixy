# Bindings-map v1 format (PROVISIONAL)

## Status

**PROVISIONAL.** Spec/04 §4 mandates the concept ("a binding map: key → kind, list
shapes, global keys... so the overlay never re-derives the contract") but does not
define its exact shape, and spec/05-editor.md (read in full before writing this) does
not define a consumer format either, since the editor TypeScript doesn't exist until
M7. This is a reasonable v1 design, not a locked contract — M7 may need to revise it
once real consuming code is written against it. Revise this entry (or add a successor)
rather than silently drifting the shape if that happens.

## Context

`GET /admin/preview/{page}.html` (spec/04 §4) must inject a
`<script type="application/json" id="wx-bindings">` blob alongside the rendered page,
and `GET /api/admin/content/{page}` (spec/04 §8) returns "merged content + binding map
(editor fields)" — the same per-page shape, reused by both surfaces. Spec/05 §2's
overlay↔shell protocol confirms real consumers: `init {page, bindings, draftRev}` hands
the map to the editor overlay at load, and `selected {key, kind, rect}` /
`mediaRequest {key}` are overlay→shell messages keyed by binding key.

Read in full before designing: `builder/bindings.py` (the `ATTR_*` constants + the
`_walk`/`_expand_list`/`_apply_*` control flow), `builder/render.py` (`SiteSource`,
`render_page`), `builder/templates.py` (`load_template`/`inject_partials`), spec/02 §2-3
(the binding-attribute table + key-resolution prefix rules + the `@nav`
never-stored rule), spec/05 §2-4 (hover/selection chrome, list item-shape cloning,
attribute-binding-via-drawer, theme panel scope).

## Decisions

**1. One binding kind per `data-wx-*` attribute, seven kinds total: `text`, `img`,
`href`, `bg`, `attr`, `list`, `if`.** Directly mirrors `ATTR_TEXT`/`ATTR_IMG`/
`ATTR_HREF`/`ATTR_BG`/`ATTR_ATTR`/`ATTR_LIST`/`ATTR_IF` in `builder/bindings.py`.
`ATTR_LIST_ITEM` and `ATTR_HIDDEN` are structural/output-only markers, not independently
keyed bindings, so they don't get their own kind — `data-wx-list-item` is consumed
while walking a `list` kind's item template (decision 3); `data-wx-hidden` is an
output attribute the renderer writes, never an input binding to describe.

**2. Scope (page / global / item) is carried entirely by the key string's own prefix —
no separate scope field.** Spec/02 §2's own resolution rule is: no prefix = page's own
content file; `@` prefix = `_global.json`; `.` prefix = relative to the enclosing list
item (only meaningful nested inside a `list` kind's `items`). The bindings map keeps
keys **verbatim** as written in the template (`@brand.line1`, `.title`, `hero.title`)
instead of stripping prefixes into a separate `scope` enum — one string is the single
source of truth for "where does this resolve," matching `resolve_key`'s own convention
exactly, so a future PATCH-op-building consumer applies the identical prefix logic it
would need anyway rather than reading a redundant field that could drift out of sync
with the key.

**3. Extraction walks the raw, pre-render template DOM (after partial injection, before
any `apply_bindings` call) — never a rendered/value-resolved tree.** This is the load-
bearing choice. Two real cases would silently lose bindings otherwise:
   - A `data-wx-if` branch that's currently falsy: in **publish** mode the element is
     extracted from the tree entirely (`_walk`'s `el.extract()`); even in **preview**
     mode nothing is lost, but resolving a false condition at all requires real content,
     which extraction shouldn't need. Walking the unrendered template means every
     branch's bindings are always discoverable regardless of any runtime value —
     the identical reasoning `validate.py`'s own docstring already gives for why *it*
     walks in preview mode ("a hidden branch's dead binding should still be caught").
   - A `data-wx-list` whose array is currently empty: `_expand_list` clones the item
     template once per array element, so a rendered-output walk would see **zero**
     item-shape occurrences for an empty list — exactly the case spec/05 §2 says the
     shell needs a shape for ("✚ appends a blank-ish item cloned from the **first
     item's shape**" — that only works when an item already exists; the bindings map
     is what backstops the empty-array bootstrap case where there is no first item to
     clone).

   Extraction therefore uses its own static walker (`builder/bindings_map.py`,
   `_walk_static`), structurally parallel to `bindings.py`'s `_walk`/`_expand_list` but
   never constructing a `ResolveContext` or resolving a value — it only reads which
   `data-wx-*` attributes are present. `builder/render.py` gained a small extraction —
   `prepare_page_body(source, slug) -> (Tag, file_label)` — pulled out of `render_page`'s
   existing preamble (template load + partial marker check + partial injection + body
   lookup) with **no behavior change** (`render_page` now calls it too; existing render
   tests re-verify this), so both `render_page` and `extract_bindings_map` share the
   exact same "load this page's template + inject its partials" logic instead of two
   copies that could drift.

**4. List containers recurse into the item template exactly once, via the same
`container.find(attrs={ATTR_LIST_ITEM: True})` lookup `_expand_list` already uses —
never per-runtime-array-element.** Preserves the nested-list disambiguation the real
expansion code already depends on (an outer `<li data-wx-list-item>` precedes a nested
list's own inner `<li data-wx-list-item>` in document order, so `.find()`'s first-match
semantics resolve to the right template at each level — verified against the
`showcase.items[].tags[]` nesting in `builder/tests/fixtures/mini-site/pages/index.html`).
Arbitrarily deep list-of-lists nests correctly for free since the walker recurses on
whatever it finds. A list container with no item template present (a malformed/mid-edit
draft) yields an empty `items` tuple rather than raising — extraction is a descriptive
read, not a validity check (that's `validate.py`'s job, via the real `apply_bindings`
pass); crashing the preview endpoint over a template mistake `validate`/`build` already
catch through their own channel would be strictly worse than showing an empty item shape.

**5. Fields dedupe by `(key, kind)`, first-DOM-occurrence order, within each scope
level (top-level, or independently within each list's own item scope).** Two real
per-fixture cases motivate this: (a) the Book/Enquire CTA pattern (spec/02 §3: "two
sibling anchors... gated `data-wx-if=".book"` / `data-wx-if="!.book"`") references the
same key `book` from two elements — one editable boolean field, not two; (b) a
`data-wx-if`'s leading `!` is stripped before recording, for the same reason (the
negated and non-negated occurrences gate different subtrees but are edits to the same
underlying key). The map's job is "what keys exist and what kind are they," not a 1:1
log of every DOM occurrence — an occurrence-level view is always still available by
querying the live rendered DOM directly (§2's own header line: bindings "are kept in
published HTML... let the editor overlay target the live DOM without a parallel map"
— the map is a *summary* the DOM itself doesn't lose).

**6. `attr` kind fields also carry the target HTML attribute name.** Spec/05 §2 confirms
this is load-bearing, not cosmetic: `data-wx-attr` bindings are the **one** kind
explicitly excluded from the iframe hover-target selector list (05 §2: "Hover on any
bound element (`[data-wx], [data-wx-img], [data-wx-bg], [data-wx-href], [data-wx-list]`)"
— `data-wx-attr` is absent) because they can sit on non-hoverable elements (`<body>`'s
booking-url attribute, surfaced instead via a "Site links" row in the page-settings
drawer, per 05 §2). A drawer row that isn't discovered by hovering the DOM has no other
way to learn "attribute X is bound to key Y" — it must come from the map. The
`attr_name`/`key` pair-parsing (`"attr:key[,attr2:key2]"`) is factored out of
`bindings.py`'s existing `_apply_attrs` into a small shared `parse_attr_spec(spec)`
helper both the real applier and the static extractor call, so the two can't drift on
what counts as a malformed pair.

**7. Out of scope for this map, by design: `meta.*` and `theme.*` keys.** `meta` fields
(title/description/ogImage/navLabel/inNav/navOrder) are applied by `apply_head` reading
`page_content["meta"]` directly — there is no `data-wx-*` DOM attribute for them at all,
so a DOM-derived map has nothing to extract; spec/05 §2's own per-page settings drawer
edits them from the content file's fixed `meta` shape directly, not via this map. Theme
values aren't bound via `data-wx-*` on any page template either (theme.css is a static
link tag) — theme editing is spec/05 §3's entirely separate token-mirroring panel.
Both are real, editable content, just not what *this* map describes: it is specifically
the page-DOM binding contract, not "every editable key site-wide."

**8. `@nav` is deliberately excluded from the emitted map even though it is a real,
physically-present `data-wx-list="@nav"` binding in the header/footer partials.**
Spec/02 §3 is explicit: "`@nav` does not exist in `_global.json`... Nav editing
therefore happens through the page-settings panel (`meta.*`) and the `navExtra` list,
**never as a direct list binding** (the editor must not offer `@nav` item editing)."
If the map listed `@nav` as an ordinary `list`-kind field, the natural (and wrong)
reading for any future consumer would be "this is generically add/edit/delete-able like
any other list" — exactly what the spec forbids. Suppressing it at the source (a small
`_COMPUTED_GLOBAL_KEYS = frozenset({"@nav"})` skip-list in the extractor, with this
paragraph's citation as its comment) means "is this key in the bindings map" stays a
safe proxy for "is this a real, generically-editable field" everywhere it's consulted,
rather than requiring every future consumer to independently remember the one
exception. (M7's editor overlay may separately need to suppress `@nav` from its own
live-DOM hover-query selector too, since the raw attribute is still physically present
in rendered HTML regardless of this map — that's the editor's own concern to solve
when it's built, flagged here so it isn't rediscovered from scratch.)

**9. Output shape** — a small dataclass pair (`BindingField`, `PageBindings` in
`builder/bindings_map.py`), serialized by `bindings_map_to_dict()` following this
repo's established typed-dataclass-plus-explicit-dict-conversion convention
(`Theme`/`theme_to_dict`, `Overlay`/`_overlay_to_dict`, `ProjectConfig` etc.):

```json
{
  "page": "index",
  "fields": [
    {"key": "hero.bg", "kind": "bg"},
    {"key": "hero.title", "kind": "text"},
    {"key": "hero.ctaHref", "kind": "href"},
    {"key": "hero.ctaLabel", "kind": "text"},
    {"key": "hero.showBadge", "kind": "if"},
    {
      "key": "showcase.items",
      "kind": "list",
      "items": [
        {"key": ".img", "kind": "img"},
        {"key": ".title", "kind": "text"},
        {"key": ".book", "kind": "if"},
        {"key": ".bookHref", "kind": "href"},
        {"key": ".enquireHref", "kind": "href"},
        {"key": ".tags", "kind": "list", "items": [{"key": ".label", "kind": "text"}]}
      ]
    },
    {"key": "@brand.line1", "kind": "text"},
    {"key": "@bookingUrl", "kind": "attr", "attr": "data-booking-url"}
  ]
}
```
`attr` (attribute name) and `items` (nested fields) keys are omitted from the dict
entirely when not applicable, rather than emitted as `null` — keeps the per-request
blob lean.

## What to watch for (given PROVISIONAL status)

- This is derived from `builder/tests/fixtures/mini-site/` and the spec text alone —
  no real editor code consumes it yet. The very first thing M7 should do with it is
  attempt the `selected {key, kind, rect}` / `mediaRequest {key}` / attribute-drawer /
  empty-list-bootstrap flows spec/05 describes end-to-end; if any of them need a shape
  this entry doesn't provide (a stable DOM path/selector per field was considered and
  deliberately left out for v1 — see below), extend this format then, don't route
  around it with parallel ad hoc data.
- Deliberately **not included in v1**: a DOM path/CSS-selector per field. Spec/05's
  overlay is expected to discover bound elements by querying the live iframe DOM
  directly via the `data-wx-*` attributes themselves (which remain in rendered output
  per spec/02 §2's own "kept in published HTML... target the live DOM without a
  parallel map") — a selector field would be speculative until M7 proves that
  insufficient.
- Extraction re-parses the page template independently of `render_page`'s own parse
  (a second `html5lib` parse per preview request) rather than threading a shared
  pre-parsed body across the `builder.render`/`builder.bindings_map` module boundary.
  Accepted for v1 given spec/04 §4's <150ms render budget is generous relative to one
  extra small-page parse — measured, not assumed, in slice 3's own tests (see slice 3's
  own decisions entry for the actual number). If a real CA page ever approaches the
  budget, the fix is sharing the already-parsed body between the two calls, not
  skipping the measurement.
