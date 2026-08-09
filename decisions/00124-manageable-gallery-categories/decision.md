# Decision: `optionsFrom` — a generic dynamic-options capability for `choice` fields

## Symptom

The operator, mid-conversation, right after two production bug fixes: "AND WORKED THANK
YOU NOW WE HAVE ANOTHER ISSUE SHE NEEDS TO BE ABLE TO MANAGE THE CATEGORY NAMES ON THE
BEFORE AND AFTER EDIT THEM ADD NEW ONES THAT SORT OF THING." Purdi needs to rename and add
Before & After gallery categories (`Lips`/`Cheeks`/`Chin & Jaw`/`Eyes & Brows`) herself, via
the admin UI. The category list was a hardcoded `choice` field's `options` array in
`projects/ca.json` — changing it meant a developer editing the registry and shipping a PR.

## What was decided — a new field capability, not a one-off collection

`AdminField` gains two properties (`builder/config.py`): `options_source: str | None`
(registry key `"optionsFrom"`) and `required: bool` (registry key `"required"`, default
`False`). A `choice` field's dropdown now resolves options from EITHER the existing static
`options` array OR, when `optionsFrom` names another collection's dotted path,
LIVE from that collection's own current (staged, possibly-unsaved) items — each item's
`value`/`label` text fields become one option. `optionsFrom` wins when both are present.

`gallery.categories` is registered as an ORDINARY admin-managed collection
(`builder/collections.py`'s `COLLECTION_RULES`) — 100% reuse of the existing generic staged-
save collection-editor UI, two plain required text fields (`value` internal key, `label`
display name). **Rejected: an auto-generated hidden id.** That would need a brand-new
`AdminFieldKind` plus a special-cased write path for exactly one collection — an Inv 1
violation (decisions/00120 already made the same call for the `url` kind: extend the generic
mechanism, never hardcode a site's specific collection into engine code). Two visible fields
is standard CMS UX (WordPress slugs, Shopify handles), not a corner cut.

## What was decided — two real generic gaps this surfaced, both fixed properly

1. **`isNewItemComplete` had a hardcoded check for a field literally named `"title"`** (the
   add-wizard's Save-button gate) — an Inv 1 violation predating this session. Replaced with
   `required: boolean` on `AdminField` (defaults `false`, zero behavior change unless a
   registry opts in). The registry now explicitly marks the two previously-hardcoded fields
   (`gallery.sliders.title` "Treatment name", `gallery.tiles.title` "Caption") plus the new
   `gallery.categories` `value`/`label` fields as `required: true`.
2. **`blankItem()` defaulted a new item's choice field from `field.options[0]?.value`** —
   for an `optionsFrom` field `field.options` is always empty, so a brand-new gallery item's
   category would silently default to blank. Fixed with an optional second parameter,
   `resolveOptions: (field) => readonly AdminFieldOption[]` (defaults to `field =>
   field.options`, unchanged for every pre-existing caller); `sectionPanel.ts`'s one real call
   site now passes the same `resolveChoiceOptions` helper used for rendering. Verified with a
   direct `sectionPanelModel.test.ts` unit test rather than a DOM-level wizard test —
   `gallery.sliders` has 2 image-picking steps before its form step, which would need mocking
   the media-picker dialog; the pure-function test is simpler and sufficient.

## What was decided — dependent-collection re-rendering (Inv 30)

Editing `gallery.categories` (rename a label, add a category) did NOT re-render
`gallery.sliders`/`gallery.tiles`'s `cat` dropdown — `stageLocal()` only re-renders the ONE
collection it's called for, so a renamed label kept showing the stale value in every OTHER
collection's dropdown until an unrelated re-render happened to occur. Fixed with a new
`dependentCollectionsOf(collection)` helper (scans `section.collections` for any OTHER
collection whose fields declare `optionsFrom === collection.path`), wired into both
`stageLocal` and `undoLast` so they also re-render every dependent. `discardUnsaved` already
looped over every collection unconditionally and needed no change. Caught by a new
`sectionPanel.test.ts` test (an unsaved category-label edit must immediately update the
slider's dropdown) that was red before this fix and green after — see Inv 30
(`docs/ai/invariants.md`) for the durable rule this establishes.

## What was decided — public template + content migration

`#gfilter`'s 5 hardcoded `<button>`s (site repo `pages/gallery.html`) become ONE hardcoded
"All" button (kept — it has no corresponding data item) plus a `data-wx-list=
"gallery.categories"` templated block for the rest. Verified `_expand_list`
(`builder/bindings.py`) only extracts+replaces the ONE `data-wx-list-item` element, leaving
siblings (the "All" button) untouched, then appends real items after — confirmed via a
BeautifulSoup parse of a real build AND a real headed-browser screenshot + click-through
(clicking "Cheeks" correctly filtered to only cheeks items): output is functionally
identical to the original hardcoded markup. `content/gallery.json` (site repo) gained
`gallery.categories` seeded EXACTLY from the 4 pre-existing hardcoded values, so nothing
currently tagged breaks — verified via `builder validate` plus a full build and structural
check.

## What to watch for

- Any FUTURE write path that stages a collection must go through `stageLocal`/`undoLast`/
  `discardUnsaved` (or be audited against Inv 30 directly) — a new bypass would silently
  desync an `optionsFrom`-dependent dropdown with no test catching it, since the invariant
  is enforced at these three specific call sites, not structurally.
- Any FUTURE new `AdminField` capability that changes how a new item is born (like
  `optionsFrom` changing where a blank item's default value comes from) should be checked
  against `blankItem()`'s defaulting logic specifically — this is the second time a new-item
  default has needed a fix (`url`'s empty-string default, decisions/00120, was the first).
- `optionsFrom`/`required` are additive, opt-in registry keys — every existing field/
  collection in every project's registry is unaffected unless it explicitly sets them.
