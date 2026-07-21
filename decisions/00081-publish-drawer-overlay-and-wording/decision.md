# Publish review drawer: CSS parse bug broke the overlay; plain-English wording; drawers only close on navigation

## The ask (operator, 2026-07-21)

"When I click the '6 changes' button, on desktop and mobile, it's a mess, layout wise. Also
on desktop, when I am on the changes view, then I change Chrome tab and go back, it goes back
out of the changes view. Also, the wording isn't very easy for a total layman to understand
('upstream' etc.). Does this mean we have unpublished changes?"

## Symptom → root causes (three independent bugs, one visible mess)

**1. The layout mess was a CSS PARSE bug, not a styling mistake.** Commit 35aab64 (M7 slice
3's edit-view rework) rewrote the `.wx-preview-iframe` rule header but left the old rule's
tail behind: an orphaned `border: none; display: block; }` with no selector
(`admin-ui/src/style.css`). Per CSS error recovery, a selector-less statement followed by `}`
swallows the NEXT rule as the malformed rule's block — which was `.wx-drawer { position:
fixed; background; z-index: 500; … }`. The drawer lost every overlay property and rendered as
a transparent in-flow block over the nav + pages panel: exactly the "everything overlapping"
screenshot. No tooling caught it because browsers accept the file silently and no test read
the stylesheet structurally. Fixed by deleting the orphaned block; guarded by
`admin-ui/tests/styleCss.test.ts`, a structural scanner that fails on any top-level
non-rule statement (plus a canary asserting `.wx-drawer` still sets `position: fixed`).

**2. The tab-switch eviction was `closeDrawer()` living in the wrong function.** The 60s /
`visibilitychange` revalidation re-renders the mounted pages panel via `mountPanel(route)` —
the same function genuine route changes use — and `mountPanel` unconditionally closed the
drawer. So merely returning to the tab (and every 60s tick) yanked the review out from under
the user. Fixed by hoisting `closeDrawer()` into `handleRoute`: a genuine navigation closes
drawers; a same-route background re-render never does. Regression test: drawer survives a
synthetic `visibilitychange` on the pages route (and still closes on `#/history`).

**3. Whole-array diffs rendered as raw JSON because the kind lookup missed twice over.**
`binding_kind_lookup` keyed the bindings map verbatim (`@hours` — the `@` is the template's
global-scope marker) while ops/diffs address the field as `hours`; and the `_global` bucket
was copied from the first-alphabetical page's map, but a global binding only appears on pages
that bind it (CA binds `@hours` on index + contact, NOT about). Both misses defaulted kind to
`"text"` → `JSON.stringify` of a 7-day hours array in the review drawer. Fixed by stripping
leading `@` and building `_global` as the union of every page's `@`-prefixed fields. The
kind then arrives as `"list"` — and `diffView.ts` now renders list entries as per-item human
lines aligned by index ("Wednesday: value: Closed → By phone enquiry", "Added: Thursday,
10:00 – 19:00", "Removed: …"), items labelled by identity-ish keys (day/title/label/name,
else first string value), capped at 10 lines + "…and N more". Shared by the history panel's
Changes view, which gets the same readability for free.

## Wording decisions (the layman pass)

The drawer's audience is the site OWNER, not a developer — no git vocabulary:

- Chip: "N changes · M upstream commits" → **"N unpublished changes · M site updates"**
  ("No unpublished changes" when clean). Answers the operator's own question in place: yes,
  the count IS the unpublished work.
- Upstream section: "M upstream commits" → **"M updates made outside the editor"** + an
  explainer line ("made for you outside this editor — for example by the AI assistant or your
  developer. Publishing takes everything live in one go."). Commit subject — author lines stay
  (they're the honest detail).
- Empty diff: "No draft changes." → "No content edits to review."

Semantics preserved: upstream commits still keep Publish enabled with no staged changes
(00071) — only the labels changed.

## What to watch for

- CSS error recovery is SILENT: any future mangled rule can swallow its neighbour. The
  styleCss.test.ts scanner is the tripwire — if it fails, look for a selector deleted without
  its block (or vice versa), typically after a merge or a rule rewrite.
- `mountPanel` must NOT regain a `closeDrawer()` call — same-route re-renders (revalidation,
  pages-panel refresh) flow through it by design.
- The list-diff index alignment is a heuristic: a mid-list insertion renders as several
  changed items rather than one insert. Acceptable (truthful, readable); a proper identity-
  keyed diff would need per-list identity metadata the bindings don't carry.
