# Decision: `tab` — a generic grouping capability for admin section collections

## Symptom

The operator, right after the category-management feature shipped: "Can we put the category
management and the picture management on tabs within the before and after admin page?" The
Before & After section had grown to 3 stacked collections (`gallery.categories`,
`gallery.sliders`, `gallery.tiles`) rendered sequentially on one long-scrolling page —
workable, but the operator's own framing ("category management" vs "picture management")
maps cleanly onto two groups worth switching between instead of scrolling past.

## What was decided — a per-collection `tab`, not a section-level tab list

`AdminCollection` gains one new optional property: `tab: str | None` (registry key `"tab"`).
Collections sharing the same `tab` text render together, switchable via a tab strip, when a
section has more than one distinct group present; a collection with no `tab` set joins an
implicit `"General"` group. **Rejected: a separate `section.tabs: [{id, label,
collections: [path, ...]}]` array.** That would need the registry author to keep a list of
collection PATHS in sync with a separate grouping construct — a real source of drift (a typo
or a forgotten path silently drops a collection from every tab, or duplicates it into two).
A plain per-collection string is simpler to author (one field, right next to the collection
it describes, matching how `alignAspect`/`required`/`optionsFrom` are already declared), and
structurally cannot reference a collection that doesn't exist.

**Grouping-by-string rather than grouping-by-id+label**: nothing else in this codebase needs
to reference a tab by a STABLE identity distinct from what it displays (unlike
`AdminSection.id`, used for routing, or `AdminFieldOption.value`, bound to stored content) —
a plain string used as both the grouping key and the display text is the right amount of
structure, not a corner cut.

**Zero distinct groups falls back to zero tab UI.** `groupCollectionsByTab`
(`sectionPanelModel.ts`) buckets collections by `tab ?? "General"` — when every collection in
a section shares one effective group (the default: nobody has set `tab` at all), rendering is
BYTE-FOR-BYTE unchanged from before this capability existed: no tab strip, collections render
sequentially exactly as today. This is what makes the capability safe to ship without auditing
every OTHER section in every OTHER project using this engine — an untouched registry produces
an untouched UI. A tab strip only appears once a registry actually declares ≥2 distinct
values, which is also why a collection accidentally left without a `tab` amid tabbed siblings
degrades to a reasonable `"General"` tab rather than a broken/unlabeled one — no registry-
authoring discipline ("declare `tab` on ALL of a section's collections or none") needs
enforcing; the fallback is correct by construction for the partial case too.

## What was decided — tabs are a pure visibility layer on top of the existing save model

`renderBody()` (`sectionPanel.ts`, replacing `load()`'s old inline render loop) is the only
new rendering logic. It still calls the SAME `renderCollectionSection`/`renderCollectionBody`
per collection as before — tabs only decide which wrapper (`.wx-section-tab-panel`) a
collection's markup lands in, and toggle that wrapper's `hidden` attribute. `collectionState`,
`savedState`, `collectionBodies`, `stageLocal`, `undoLast`, `discardUnsaved`, `saveNow`, and
`dependentCollectionsOf` (decisions/00124, Inv 30) are ALL untouched — `collectionBodies` maps
a collection's path to its inner body element regardless of which tab panel contains it, so a
staged edit to a collection on a HIDDEN tab still re-renders correctly, including any
dependent collection that happens to live on a DIFFERENT tab (now Inv 31 — this is the
realistic shape here: `gallery.categories` lives on the "Categories" tab, but
`gallery.sliders`/`gallery.tiles`'s `cat` dropdowns, which depend on it via `optionsFrom`,
live on "Photos"). The save bar, undo stack, and discard controls stay section-wide as they
already were (decisions/00118's "one panel-wide stack, not per collection") — switching tabs
never affects what Save/Undo/Discard operate on, so unsaved work made on one tab is still
visible/saveable/discardable after switching away from it.

## What was decided — full ARIA tabs pattern, automatic activation

The tab strip is a real `role="tablist"`/`role="tab"`/`role="tabpanel"` implementation, not a
styled `<div>` with click handlers only: `aria-selected`, `aria-controls`/`aria-labelledby`
linking, and roving `tabindex` (only the active tab is in the tab order; Left/Right/Home/End
move focus AND switch the active panel — "automatic activation," the common pattern for a
small in-page tab switcher, matching how a native browser tab strip behaves). Enter/Space
activation is free from the underlying `<button>` element. Chosen over a lighter click-only
implementation because this codebase already invests in native/full a11y elsewhere (the
`visible` toggle's real `<input type="checkbox">` behind a styled track, decisions/00119) —
a small tab strip is exactly the kind of control keyboard/screen-reader users hit constantly,
and the full pattern costs little extra code once written once, generically, in the engine.

## What was decided — `projects/ca.json`

`gallery.categories` gets `"tab": "Categories"`; `gallery.sliders` and `gallery.tiles` both
get `"tab": "Photos"` — the operator's own two-group framing, applied directly. No other
registry, project, or section is touched; every one of them still has zero collections
declaring `tab`, so every one of them renders exactly as before.

## What to watch for

- A future collection added to the Before & After section (or any tabbed section) needs an
  explicit `"tab"` value to land in the intended group — omitting it silently lands the
  collection in `"General"`, which becomes its OWN visible tab (not a broken state, just
  probably not the intended one) the moment any other collection also has a distinct tab.
- Any future write path that stages a collection must go through `stageLocal`/`undoLast`/
  `discardUnsaved` (already the rule for Inv 30) — Inv 31 rides on the same three chokepoints,
  so a bypass would silently break BOTH invariants at once, not just one.
- `renderBody`'s "≤1 distinct group -> no tab UI" fallback is what keeps this capability safe
  to ship globally; if a future change ever makes tab rendering conditional on anything OTHER
  than the actual number of distinct `tab` values present (e.g. a registry flag instead of
  inferring from the data), re-verify every existing section's screenshot/rendering is
  unaffected before shipping.
