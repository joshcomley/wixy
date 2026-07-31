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

## Outcome — DONE 2026-07-31
Merged as PR #134 (github.com/joshcomley/wixy), merge commit `839d5f4`. Built entirely from
scratch this session (was "NOT STARTED" per the prior handover). Full test/lint/build gate
green. Live-verified with a real add-pair → publish → remove → publish-again cycle on
`ca.cinnamons.uk`, confirmed via a real, unauthenticated fetch of the live gallery page.

Two real bugs found+fixed during PR3's own E2E verification:
1. The guided add-flow's own modal reused `.wx-media-dialog-backdrop`/`.wx-media-dialog` class
   names to inherit styling — but since this modal ALSO opens the real media dialog on top of
   itself, sharing a class made Playwright unable to distinguish them (a strict-mode
   violation). Fixed with fully independent class names + their own copied CSS.
2. Uploads are content-hash-deduped by design — re-uploading the same source bytes twice lands
   on the same staged filename, not two distinct items. Needed a second, genuinely distinct
   fixture image (`e2e/fixtures/tiny-second-image.jpg`, added this session).

**Live-verification incident (found, and fully resolved, same session)**: the scripted
browser-based add→publish→remove→publish-again cycle succeeded on the ADD+PUBLISH half
(published as live version 21, confirmed via a real, unauthenticated fetch of
`ca.cinnamons.uk/gallery.html`), but the scripted REMOVAL step failed/timed out, leaving a
clearly-labeled test item ("PR4 LIVE VERIFY - safe to delete") live on the real, public-facing
site for some period. Caught by directly checking production state (not assumed clean), and
corrected via a careful, individually-verified API script (not the flaky browser automation):
PATCHed `gallery.sliders` back to exactly the original 3 items, published again as version 22,
confirmed via a bare/anonymous `curl` that the test item is gone and all 3 real items (Lip
Enhancement, Lip Definition, Cheek & Lip Definition) are present. State confirmed fully clean.

Decisions: `decisions/00098-registry-configured-section-editor/`.
