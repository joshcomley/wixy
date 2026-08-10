# Admin section tabs: group Before & After's collections into Categories/Photos — DONE

Operator, right after category management shipped: "Can we put the category management and
the picture management on tabs within the before and after admin page?"

## What shipped

A new generic `AdminCollection.tab: string | null` — collections sharing the same tab text
render together under a switchable strip (full ARIA `role="tablist"` pattern: roving
`tabindex`, Left/Right/Home/End keyboard nav, automatic activation) once a section has more
than one distinct group; a section where every collection shares one group (nobody sets
`tab` — the default, and every other section) renders byte-for-byte unchanged, no tab UI at
all. `gallery.categories` → "Categories" tab; `gallery.sliders`/`gallery.tiles` → "Photos"
tab (the operator's own two-group framing). Purely additive on top of the existing
staged-save model — tabs only toggle a wrapper's `hidden` attribute, so `stageLocal`/
`undoLast`/`dependentCollectionsOf` (Inv 30) and Save all work unchanged, including updating
a collection on a currently-hidden tab (new Inv 31, red/green cross-tab test). Full design
rationale: decisions/00125-admin-section-tabs.

- wixy engine PR #174 (merge `22a57b683a83b1186f7b927803c1a8d6bd7d74aa`)
- Planner ran a FINAL HANDOFF review (0 critical/0 high), pre-scoped a conditional clearance
  for the one fix needed, and confirmed both conditions before I merged.

## A real process gap caught by CI, not by me

Pushed the first commit having only run `ruff check .` (lint) all session, never
`ruff format --check .` (formatting) — a separate command this repo's own dev-commands list
names explicitly. CI's `python` job failed fast on one line needing a rewrap in
`builder/tests/test_config.py`; pytest itself never even ran that round (gated behind the
format check), which the planner's log-reading caught and explained precisely. Fixed with
`ruff format .`, verified the resulting diff was EXACTLY that one mechanical rewrap (nothing
else), re-pushed, all 6 CI checks green including pytest. `ruff format --check .` is now part
of my own pre-push checklist, not just `ruff check .` — named explicitly so this doesn't
recur.

## Live verification (real production, headed Playwright, mobile width matching Purdi's phone)

390×844 with touch emulation: tab strip renders cleanly, no clipping; tapping "Photos"
correctly hides Categories/shows Photos; the Photos tab's category dropdown correctly lists
all 4 real categories, decoded (confirms the earlier #172 entity-decode fix is holding in
production too). Screenshots reviewed directly, not just DOM assertions.

## What to watch for

- **Open UX question, deliberately NOT decided unilaterally** (per the planner's explicit
  note): the default (first-shown) tab is "Categories" only because that collection is
  declared first in `ca.json` — if Purdi spends most of her time in Photos, making Photos the
  default is a one-line registry reorder (`gallery.sliders`/`gallery.tiles` before
  `gallery.categories`). Ask the operator which he wants; ship-as-is is fine until then.
- Same 3 LOW follow-ups from the category-management round (decisions/00124) still apply and
  are still not started: dangling-category display, duplicate-value prevention, no Playwright
  e2e for the categories/tabs flow specifically.
