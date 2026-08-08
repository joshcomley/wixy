# Decision: the `visible` item convention + "Show on site" toggle

## Symptom

Purdi asked to have all her existing before/after posts from Instagram and Facebook
imported into the Before & After editor — dozens of posts across two platforms, most
never reviewed for the site. Importing them all as ordinary, immediately-live gallery
entries was never on the table: some are duplicates of pairs she already uploaded
herself, some are the wrong shape (multi-panel composites, low-confidence splits), and
all of them are photos of real clients she hasn't explicitly chosen to publish on this
particular page, even though the wider consent question is separately covered. She
needs to see everything that was found and choose what actually goes live, at her own
pace, from her phone.

The engine had no notion of "this collection item exists in the editor but isn't on the
public site yet" — every `gallery.sliders`/`gallery.tiles` item that passed schema
validation rendered unconditionally on `gallery.html`.

## What was decided

An optional boolean `visible` on any collection list item (`builder/bindings.py:
_expand_list`): absent or `true` = shown — byte-identical to every existing item and
every site published before this change; only an explicit `false` hides it. Mirrors
Inv 10's `data-wx-if` publish/preview asymmetry: **publish** drops a hidden item
entirely (never cloned, walked, or appended — it cannot reach the built HTML no matter
what its own bindings look like); **preview** keeps it, marks the clone
`data-wx-item-hidden="1"` (`ATTR_ITEM_HIDDEN`), and still walks/validates its bindings,
so a currently-hidden item's broken binding is still caught by `validate`. Canonical
storage form: the key exists ONLY when `false` — both write paths (the admin-ui toggle
and the editor overlay's whole-array read-back) omit the key to re-show an item, never
write `true`.

A new `AdminFieldKind = "toggle"` (`builder/config.py`) renders an on/off switch in the
registry-configured section editor (decisions/00098) — `ca.json`'s `gallery.sliders`/
`gallery.tiles` both declare `{"key": "visible", "kind": "toggle", "label": "Show on
site"}`. A hidden card is dimmed (~55% opacity) with a small "Hidden" chip so which
imports are still switched off is obvious without opening each one.

This is engine-generic (Inv 1): nothing about `visible`, `ATTR_ITEM_HIDDEN`, or the
`toggle` kind mentions Cottage Aesthetics, galleries, or before/afters. Any project's
registry can opt any collection into it the same way `ca.json` does.

## Why not `data-wx-if`

The obvious-looking shortcut — bind each item's root to `data-wx-if=".visible"` and let
the existing hide/show machinery handle it — was tried first and rejected on two
independent, verified grounds:

1. **Ordering.** `_expand_list` extracts the `data-wx-list-item` template once, then for
   each array item deep-copies it, walks it (`_walk`), and only THEN appends the clone
   to the container. `data-wx-if`'s publish-mode branch (`_walk`'s own `if_expr` check)
   calls `el.extract()` to remove a falsy element from its tree — but at that point the
   clone is still a bare, unattached `Tag`, not yet a child of the list container. The
   `extract()` is a no-op on an unparented node, and the unconditional `container.append
   (clone)` a few lines later would append it right back regardless. A hidden item would
   render anyway.
2. **Strictness.** `_evaluate_if` calls `_fail` (raises `BuildError` in publish mode) the
   moment its key doesn't resolve. `visible` is meant to be ABSENT on the overwhelming
   majority of items (every item published before this feature, and every newly-added
   item that was never explicitly hidden) — building `data-wx-if=".visible"` over that
   would hard-fail every existing site's build the instant this shipped, or force every
   item to carry an explicit `"visible": true`, defeating the "absent = shown, additive,
   opt-in" property the whole design depends on.

Both were verified against the actual `_expand_list`/`_walk` control flow, not assumed.
A dedicated item-key check — `item_value.get("visible") is False`, evaluated inside
`_expand_list` itself, before the deepcopy — sidesteps both: it runs once per item
before any walk/append happens, and a missing key reads as `None is False → False`
(shown), never a validation failure.

## Key mechanics

- `builder/schemas/gallery-slider.schema.json` / `gallery-tile.schema.json` gain
  `"visible": {"type": "boolean"}` in `properties` (not `required`) — the one edit that
  unblocks the draft-write gate (`draft_validate.check_structural`), publish preflight,
  and `draft/repair`, since all three already delegate to the same schema-driven
  structural check and previously rejected `visible` as an unknown property
  (`additionalProperties: false`).
- Hidden items' images must still exist in `images/` — `validate._validate_images` and
  `build._self_check` walk raw content refs, not rendered HTML, so a hidden item's
  photos are never candidates for cleanup just because they're currently off.
- The editor overlay's whole-array DOM read-back (`editor/src/contentModel.ts:
  readListValue`) is the other half of "preview renders it, marked" — without teaching
  it about `ATTR_ITEM_HIDDEN`, ANY structural or text edit to ANY OTHER item in the same
  list would silently drop the hidden item's `visible: false` on its next whole-array
  re-emission, the exact incident class decisions/00095 already fixed once for
  attr-kind fields (`.cat`). `readListValue` now sets `value["visible"] = false` when
  the item's DOM root carries the marker; an unmarked item gets no key at all. This is
  now a fourth hand-synced pair under Inv 20:
  `builder/bindings.py:ATTR_ITEM_HIDDEN` ≡ `editor/src/contentModel.ts:ATTR_ITEM_HIDDEN`.
- Structural list ops (`editor/src/listOps.ts`): "add" clones item[0] and blanks its
  strings, but a boolean `visible: false` on that source item would otherwise survive
  `blankStrings` verbatim (it only blanks string leaves) — stripped explicitly, so a
  new item is always **born shown**, even when added while item 0 happens to be
  hidden. "duplicate" deliberately keeps `visible: false` — duplicating a hidden item
  should produce another hidden item, not silently publish a copy. `overlay.ts`'s
  DOM-side "add" clone strips the same attribute from the live element (not just the
  array value), so the just-added card doesn't render dimmed in the same session while
  the value already sent to the server has no such key.
- Admin-ui: `sectionPanelModel.ts` gains `removeItemField` (the toggle's "on" write path
  — drops the key rather than setting `true`); the guided add-flow's per-field-kind
  dispatch in `sectionPanel.ts` was a two-way ternary (`text`/`choice`) that a `toggle`
  field would have silently fallen through into an empty `<select>` — converted to an
  explicit three-way switch before it ever shipped.
- Ghost styling in the editor iframe (`editor/src/style.css`) is a CSS-only `::after`
  badge, not an injected DOM node — an injected node would have to join
  `OVERLAY_CHROME_SELECTOR` (Inv 23) to stay out of read-back values; a pseudo-element
  is never part of the DOM tree, so it sidesteps that requirement entirely.

## What to watch for

- The read-back rule lives in exactly one place (`readListValue`); a future list-value
  reader that bypasses it (a new bulk-edit path, a different reconstruction helper) would
  reintroduce the silent-un-hide bug. Route any new whole-array DOM read through
  `readListValue`, don't hand-roll another one.
- `blankItem` (`sectionPanelModel.ts`) already seeds no key for a `kind` it doesn't
  recognize — a `toggle` field's blank state is correctly "no key" (shown) with zero
  code change there. Don't add a `toggle` case to it; that would need an explicit
  "start unchecked" concept the feature doesn't have.
- `visible` is a fixed, non-configurable key name (mirrors `src`/`alt` being fixed
  conventions elsewhere in this codebase) — the registry's `"kind": "toggle"` field can
  be bound to any `key`, but only a field literally named `visible` participates in the
  hide/show convention itself (`_expand_list`, `readListValue`, the card-dimming check
  all hardcode the string). A project wanting a differently-named per-item flag would
  need a new convention, not a parameter on this one.
