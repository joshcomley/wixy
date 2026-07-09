# Milestone 7 slice 2: the editor overlay

## Context

Second slice of the M7 PR train (decisions/00015). Builds `editor/src/`'s full
selection-and-editing chrome (spec/05 §2): hover outline+chip, per-binding-kind
popovers (text plain/rich-lite, link, image), `data-wx-if` eye toggle, the list item
structural toolbar, and the `op`-emission logic — including the one genuinely
non-obvious piece of this whole milestone, the outermost-list targeting rule (decision
2). Wired into `editor/src/index.ts` so the bundled IIFE self-starts when injected.

## Decisions

**1. Content reconstruction (`contentModel.ts`) mirrors `builder.bindings._walk`'s own
control flow exactly, including the case that initially broke it: a list item's ROOT
element can itself carry a scalar binding** (`<li data-wx-list-item data-wx=".label">`
— the mini-site fixture's own nav/tag pattern). `Element.querySelector` only searches
descendants, so the first version silently returned nothing for every such field.
Fixed with a small `queryOwn` helper that checks the root itself before descending —
found by testing against markup shaped exactly like the real fixture, not synthetic
markup that happened to avoid the case. This is why decisions/00012 and this repo's
own testing culture insist on real-shaped fixtures: a plausible-looking but
non-representative test fixture would have hidden this.

**2. The single most load-bearing design fact of this slice: an item-scope
(`.`-prefixed) binding, however deeply nested, can ONLY ever be expressed as the
OUTERMOST enclosing list's whole-array value — never its own path, and never an
intermediate nested list's path either.** Root cause: the server's own path resolver
(`builder.content.dotted_get`) never indexes into a list ("hitting a list before the
path is exhausted is not found," per its own docstring, re-confirmed by reading it
again for this slice). Concretely: editing `.tags[].label` — itself nested inside
`showcase.items[]` — must re-emit the ENTIRE `showcase.items` array; `.tags` alone is
not a valid overlay path at any depth. `opTargeting.ts`'s `findOutermostList` walks
outward through every ancestor `[data-wx-list]`, continuing past the first one found,
specifically to get this right — tested explicitly
(`test finds the OUTER list, not the nested one, for a field inside a nested list
item`). Getting this wrong would have silently corrupted nested-collection edits in
exactly the shape the real fixture (and spec/02 §6's gallery/treatments collections)
actually uses.

**3. The DOM is the only content model the overlay has — `init` carries the
bindings-map SHAPE only, never actual values (spec/05 §2's message list is
exhaustive)** — so every "read the current value" function reads it back out of the
live-rendered iframe DOM, not from any cached copy. This is explicitly sanctioned by
spec/05 §2's own words ("a hard iframe reload always reconverges — server render is
the same merge"): an imperfect in-memory reconstruction self-heals on reload, so a
best-effort DOM read is an acceptable design, not a corner cut. The one real fidelity
gap this creates — `data-wx-if`'s reconstructed value is always a plain boolean,
never the exact original JS-falsy-rule value (`""`/`[]`/etc.) — is called out in
`contentModel.ts`'s own doc comment rather than silently accepted.

**4. List structural edits (add/duplicate/move/delete) manipulate the EXISTING
rendered DOM nodes directly — clone, remove, reorder — rather than re-rendering from
the bindings-map shape.** Cloning/reordering already-rendered nodes trivially
preserves whatever the real template put there (nested lists, images, styling) with
zero risk of the overlay's reconstruction drifting from the server's actual template.
The one case this can't cover: **adding a first item to a currently-EMPTY list has no
existing DOM node to clone**, and the bindings-map's key/kind shape alone (no HTML
structure, classes, or styling) isn't enough to synthesize a properly-styled item from
scratch. `applyStructuralDomChange`'s `"add"` case a no-ops (button present but
inert) when the list starts empty — a real, documented v1 gap, not silently swallowed;
solving it properly needs either a server-side "give me a rendered blank item" endpoint
or accepting an unstyled synthesized fallback, both real design questions deferred
rather than guessed at here.

**5. Reordering is two buttons (↑/↓), not pointer-drag** — spec/05 §2 lists a drag
handle (`⠿`) alongside them. Implementing real drag-and-drop (pointer capture, drop-
target detection, drag-image rendering) is meaningfully more UI code for the identical
end result (the same whole-array reordering op), and the buttons are fully keyboard-
and-mouse operable today. Flagged as a deliberate v1 simplification, not a silent
scope cut — a future slice can add drag as an alternative INPUT to the same
`applyListStructuralOp`/DOM-reorder path this slice already built, changing nothing
about the underlying mechanism.

**6. Rich-lite's mini-toolbar (B/I/link) is hand-rolled over the Selection/Range API,
not `document.execCommand`.** Two independent reasons: `execCommand` is deprecated
with no real replacement and inconsistent across browsers even where it still works;
concretely for THIS repo, jsdom (this package's own vitest environment) does not
implement it at all, so using it would have made the toolbar buttons untestable
outright. `wrapSelection`/`wrapSelectionAsLink` extract the current `Range` and wrap it
in a real `strong`/`em`/`a` element — deterministic, and exercised directly in
`popovers.test.ts`.

**7. The link popover's page-picker (spec/05 §2: "href field with page-picker
(internal pages listed) / raw URL / tel: / mailto:") ships as the raw-URL input only
— the picker dropdown is deferred.** The overlay has no source for "the list of
internal pages" — `init {page, bindings, draftRev}` is the only shell→overlay message
carrying page-related data, and it's scoped to the CURRENT page only (spec/05 §2's
five message types are exhaustive, no page-list message exists). Raw URL entry already
covers URL/tel:/mailto: fully; the picker is a UX convenience layered on top of the
same `onCommitHref` path, addable without changing anything built here.

**8. Manual/visual verification in a real browser was NOT performed for this slice**
— flagged explicitly rather than silently omitted. This repo's own cross-cutting rule
is "for UI or frontend changes, start the dev server and use the feature in a browser
before reporting complete"; the admin shell (slice 3) and the wiring that actually
serves a real page through this overlay end-to-end don't exist until slice 3, so
there is no complete, real page to load and click through yet. `overlay.test.ts`'s 22
tests exercise the full logic (hover, every popover kind, op emission incl. the
outermost-list rule, structural ops, if-toggle, shell messages) against jsdom-rendered
markup shaped like the real fixture — real coverage of the LOGIC, not a substitute for
seeing it rendered. Slice 3/4's integration work is where an actual browser check
becomes possible and is owed.

## Verification

`editor`: `tsc --noEmit` clean. `vitest run` — 85 tests across 8 files (dom, content
model, list ops, op targeting, popovers, overlay integration, protocol, smoke).
`admin-ui`: unaffected this slice (no source changes), `tsc --noEmit` + `vitest run`
still clean from slice 1. Bundle rebuilt twice to confirm stability;
`git diff --exit-code -- wixy_server/static` shows exactly the expected
`editor.js`/`editor.js.map` content change (empty stub -> real bundle) and no
unexpected `admin.js` diff.

## What to watch for

- Slice 3 (admin shell) is where a real end-to-end browser check against this overlay
  becomes possible — do it, per decision 8.
- The empty-list "add" gap (decision 4) needs a real design call once it's blocking
  something concrete — likely when M8's media panel or a future collection-heavy page
  makes an empty starting collection a real scenario, not before.
- Drag-reorder (decision 5) and the page-picker (decision 7) are both additive —
  neither requires touching what this slice already built, just extending it.
