# 00001 [drawer] Publish drawer "6 changes" fixes — DONE 2026-07-21

Operator report: the "6 changes" drawer's layout was a mess on desktop + mobile, the view
closed when switching Chrome tabs and back, and the wording ("upstream") wasn't layman-readable.

Three independent root causes, all fixed + regression-tested; full story in
`decisions/00079-publish-drawer-overlay-and-wording/`:

1. **CSS parse bug** — an orphaned `border: none; display: block; }` (leftover selector-less
   tail from 35aab64) made CSS error recovery swallow the entire `.wx-drawer` rule → drawer
   lost position:fixed/background/z-index. Removed; guarded by `tests/styleCss.test.ts`.
2. **List diffs dumped raw JSON** — `binding_kind_lookup` missed global list bindings
   (`@hours` vs op path `hours`; `_global` bucket copied first page only). Fixed in
   `wixy_server/version_diff.py` (strip `@`, union across pages); `diffView.ts` now renders
   per-item human lines ("Wednesday: value: Closed → By phone enquiry", Added/Removed).
3. **Tab-switch eviction** — `closeDrawer()` lived in `mountPanel`, which the 60s/visibility
   revalidation also calls. Hoisted to `handleRoute` (genuine navigations only).

Wording: chip → "N unpublished changes · M site updates"; upstream section → "M updates made
outside the editor" + plain-English explainer; empty diff → "No content edits to review."

Verified: vitest 448/448, pytest 845/845, mypy/ruff green, live Playwright repro on the e2e
fixture (desktop 1280 + mobile 390): overlay computed styles correct, list lines render,
drawer survives a synthetic visibilitychange, screenshots eyeballed.
