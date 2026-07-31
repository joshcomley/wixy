# 00004 [9i5y85] PR 3 — dedicated Before & After section editor

## What
A generic, registry-configured "section editor" (Inv 1 — no site literals in engine code);
`projects/ca.json` declares one for the gallery page's `gallery.sliders` + `gallery.tiles`
collections. See brief "WORKSTREAM 3":
- 3a. `builder/config.py` — `AdminSection`/`AdminCollection`/`AdminField` dataclasses +
  registry parsing; `projects/ca.json` addition; `/api/admin/state` gains `adminSections`.
- 3b. `admin-ui/src/router.ts` + `shell.ts` — `/admin/section/<id>` route, dynamic nav.
- 3c. New `admin-ui/src/sectionPanel.ts` (+ `sectionPanelModel.ts` for pure logic) — card list,
  before/after thumbnails, pointer drag-reorder + ↑↓ buttons, guided add-flow modal (can't save
  until schema-valid incl. non-blank images), delete with confirm. Polish pass at 390px via
  live headed Playwright CSS iteration.
- 3d. e2e: full add/retitle/reorder/publish journey + a publish-blocked→Fix-it-for-me journey.
- Docs (`editor-and-admin-ui.md`, `contracts.md`, `architecture.md`) + 1 decisions entry.

## Acceptance
Same test/build/lint gate. Live: real phone-width pass, real add-pair-then-remove-it publish
cycle (leave her content as found, minus the incident fixes).

## Links
Brief section "WORKSTREAM 3 (PR 3)". Depends on PR1 (contentSrc, write gate) being live.
