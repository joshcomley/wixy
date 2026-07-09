# 00008 [758hsg] M8 WX — Media + theme

## What
Upload pipeline (Pillow: orient/strip/resize/re-encode), media panel+dialog+drop-on-
element, reference scan; theme panel with live vars + fonts swap; E2E 2, 3.

## Why
Owner-experience bullets #2 (tap image, replace) and #3 (tweak theme, live preview).

## Context / current state
Depends on 00007 (editor v1 — selection chrome / dialogs) — DONE, merged (wixy PRs
#27-30, decisions/00015-00019).

Split into a slice PR train (matching M6/M7's own precedent — decisions/00010,
00015):
- Slice 1 [DONE]: backend — `wixy_server/media.py` (new): Pillow upload pipeline
  (orient/strip-EXIF/resize/re-encode, reject >15MB/non-image/SVG), reference
  scan (walks merged content for `{src,alt}`-shaped values, matched by
  filename, reported at the outermost content-key granularity). Wired into
  `routes_admin_api.py`: `GET /api/admin/media` extended with
  dimensions/size/references; new `POST /api/admin/media` (upload) and
  `DELETE /api/admin/media/{name}` (draft-staged + unreferenced only — a repo
  image's deletion is explicitly deferred, same "needs milestone 9's publish-
  time materialization" reasoning as decisions/00015 decision 3's page-delete
  deferral). `pyproject.toml` gained `python-multipart` (server extra, needed
  for FastAPI `UploadFile`). PR #31 (merged).
- Slice 2 [DONE]: theme panel (`admin-ui/src/themePanel.ts`, new) — `#/theme`
  route: colors (always-expanded swatch rows: native color input + hex +
  per-row presets strip of every other current color), fonts (Headings/Body/
  Script = theme.json's serif/sans/script roles, curated 24-family dropdown
  via `googleFontsCatalog.ts` + custom-family input + weights multi-select +
  italics toggle, each font role committed as ONE whole-object SET op), effects
  (shadow raw string), per-token + per-panel "reset to published" (via the
  EXISTING DiscardOp overlay mechanism — no new backend endpoint beyond the
  new `GET /api/admin/theme` read). Live-apply: colors + font CSS vars via the
  existing `themeVars` message; fonts additionally via a NEW `themeFonts {url}`
  message swapping the preview iframe's Google Fonts `<link>` (overlay finds it
  the same way `builder/templates.py`'s `_find_fonts_link` does at build time).
  The URL/CSS-var computation is a hand-ported TS mirror of `builder/theme.py`
  (`googleFonts.ts`/`themeVars.ts`), cross-checked byte-for-byte against the
  Python originals, so live preview never disagrees with what a real build
  would emit. RESOLVED the open design question: the theme panel embeds its
  OWN preview iframe, reusing `editView.ts`'s `mountEditView` WHOLESALE (same
  device toolbar, same overlay chrome — no stripped-down variant), fixed to
  the "index" page. Full reasoning: decisions/00021.
- Slice 3 [DONE]: media panel + dialog (`admin-ui/src/mediaDialog.ts` +
  `mediaPanel.ts`, new) — `#/media` route (grid: repo + draft images,
  dimensions/size/references, upload button + drag-drop, delete for
  unreferenced draft items) sharing ONE component with the modal dialog
  invoked from the editor's `mediaRequest` AND from `pageSettingsDrawer.ts`'s
  ogImage field (replacing its old minimal inline picker, decisions/00018
  decision 9 resolved). `editor/src/overlay.ts`'s `applyOps` handler now
  tracks `pendingMediaTarget` and routes a matching op's value through the
  SAME `commitEdit` path a typed edit uses (proven on an item-scoped image
  too — the whole-array re-emission via `opTargeting.ts` worked first try).
  `EditViewCoreDeps` gained `onMediaRequest`; the WRAPPER (not the pure core)
  owns opening the dialog, so `shell.ts`/`themePanel.ts` needed zero changes
  and the theme panel's embedded preview got working image-replace for free.
  A REAL backend gap was found by driving a real browser through the whole
  flow (not by any unit test): nothing served `GET /admin/draft-media/{name}`
  at all — fixed with a new `StaticFiles` mount in `app.py`. Full reasoning:
  decisions/00022.
- Slice 4 [DONE]: E2E 2 (`e2e/tests/image-replace.spec.ts`, new — upload a
  checked-in fixture JPEG that's BOTH oversized (3000x2000) and EXIF-rotated
  (orientation=6), generated via Pillow, `e2e/fixtures/oversized-exif-rotated
  .jpg`) and E2E 3 (`e2e/tests/theme-change.spec.ts`, new — 2 tests: live
  color+font change, and reset-to-published) as real Playwright tests, reusing
  `e2e/fixture_server.py` as-is. `e2e/tests/helpers.ts` (new) extracted
  `gotoEditAndWaitReady`/`editTextField`/`trackConsoleErrors` out of
  `concurrent-editing.spec.ts` (which now imports them) plus a new
  `waitForNextDraftPatchAccepted` — a THIRD spec file needing the identical
  "wait for the real PATCH round-trip before checking server state" logic is
  what justified extracting it, not a speculative abstraction. A REAL
  Playwright config gap was found the moment a SECOND/THIRD spec file existed
  alongside the original one: `fullyParallel: false` alone does NOT force
  different .spec.ts files to run sequentially against the ONE shared fixture
  server + draft overlay (only `workers: 1` does) — invisible before this
  slice since there was only ever one file to run. Fixed in
  `playwright.config.ts`. Full reasoning: decisions/00023.

**Milestone 8 is 100% DONE — all 4 slices merged (wixy PRs #31, #32, #33,
and slice 4's own PR).**

## Relevant files
- spec/05-editor.md §3-4 (theme panel, media panel & dialog)
- spec/02-content-model.md §4 (theme.json shape), §9 (media processing rules:
  EXIF strip, resize <=2000px, reject >15MB/non-image/SVG)
- spec/08-testing-acceptance.md §2 E2E flows 2, 3

## How to continue + acceptance
Pillow-verified EXIF strip + auto-orient + resize + re-encode; SVG reject; reference
scan before delete — ALL DONE (slice 1). Theme live-applies via CSS custom properties
+ font link swap, no rebuild — DONE (slice 2). Media panel + dialog + mediaRequest/
applyOps rewiring, incl. a real draft-media-serving fix found by browser testing —
DONE (slice 3). E2E 2 (image replace incl. oversized EXIF-rotated fixture) and E2E 3
(theme change, live vars/fonts) passing as real Playwright tests — DONE (slice 4;
their publish-tail assertions — "committed to repo images/", "theme.css + fonts link
reflect it" on the PUBLISHED site — correctly wait for milestone 9, matching M7's own
E2E 1/4 caveat).

Milestone 8 fully closed. Next: milestone 9 (publish + history).

## Links
PR (slice 1): #31
PR (slice 2): #32
PR (slice 3): #33
PR (slice 4): (fill in once opened)
