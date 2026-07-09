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
  for FastAPI `UploadFile`). PR #(fill in when opened).
- Slice 2 [not started]: theme panel (`admin-ui/`) — `#/theme` route: colors
  (swatch grid + native color input + hex + site-palette presets), fonts
  (Headings/Body/Script = theme.json's serif/sans/script roles — confirmed by
  reading the real CA site.css's own usage, not assumed — curated ~24-family
  dropdown + custom input + weights multi-select), effects (shadow raw
  string), per-token + per-panel "reset to published" (via the EXISTING
  DiscardOp overlay mechanism, no new backend needed). Live-apply: colors via
  `themeVars` (already wired end-to-end since M7 slice 2 — overlay.ts already
  handles this message), fonts via swapping the preview iframe's Google Fonts
  `<link>`. OPEN DESIGN QUESTION to resolve when starting this slice: spec/05
  §3 says theme changes "live-apply to THE edit iframe," but the shell's
  router only ever mounts ONE main panel at a time (`#/theme` XOR
  `#/edit/<page>`) — current lean is the theme panel embeds its OWN preview
  iframe (reusing editView.ts's core), defaulting to the "index" page: log
  this as a decision once actually built, don't guess further here.
- Slice 3 [not started]: media panel + dialog — `#/media` route (grid: repo +
  draft images, dimensions/size/references from slice 1's extended list
  endpoint, upload button + drag-drop, delete for unreferenced draft items).
  Shared `mediaDialog.ts` component (spec/05 §4: "the SAME component renders
  as a modal dialog when invoked from the editor") used BOTH for `#/media`
  AND replacing `pageSettingsDrawer.ts`'s current minimal inline ogImage
  picker (decisions/00018 decision 9 flagged this stand-in as real-but-
  minimal, meant to be extended here, not rebuilt from scratch). Wires the
  editor's `mediaRequest` message (currently a no-op in editView.ts's core,
  flagged "milestone 8's media dialog" since M7 slice 3) — needs
  `editor/src/overlay.ts`'s `applyOps` handler to actually DO something for
  the first time (currently a documented no-op, decisions/00017): track a
  `pendingMediaTarget` when `mediaRequest` fires, and on the next `applyOps`,
  route the matching op's value through the SAME `commitEdit` path a typed
  edit uses — this is what correctly handles an item-scoped image (inside a
  list) too, since only the overlay (not the shell) can read the live DOM to
  compute the outermost-list whole-array re-emission (opTargeting.ts).
- Slice 4 (or folded into 3, decide when there): E2E 2 (image replace,
  oversized + EXIF-rotated fixture) and E2E 3 (theme change, live vars/fonts
  reflect) as real Playwright tests, matching M7 slice 4's pattern
  (`e2e/fixture_server.py` already exists and is reusable) — E2E 2/3 don't
  need milestone 9's publisher for their EDITING-side behavior (only their
  publish-tail would, matching decisions/00015 decision 4's reasoning for
  E2E 1/4), CI green, closing decision.

## Relevant files
- spec/05-editor.md §3-4 (theme panel, media panel & dialog)
- spec/02-content-model.md §4 (theme.json shape), §9 (media processing rules:
  EXIF strip, resize <=2000px, reject >15MB/non-image/SVG)
- spec/08-testing-acceptance.md §2 E2E flows 2, 3

## How to continue + acceptance
Pillow-verified EXIF strip + auto-orient + resize + re-encode; SVG reject; reference
scan before delete — ALL DONE (slice 1). Theme live-applies via CSS custom properties
+ font link swap, no rebuild — slice 2. E2E 2 (image replace incl. oversized
EXIF-rotated fixture) and 3 (theme change -> publish -> theme.css/fonts reflect)
passing — slice 4 (E2E 2/4's publish-tail won't fully pass until M9, matching M7's own
E2E 1/4 caveat).

## Links
PR (slice 1): (fill in when opened)
