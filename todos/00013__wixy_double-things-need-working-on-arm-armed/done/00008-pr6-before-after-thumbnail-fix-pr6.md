# 00008 [pr6] PR 6 — Before & After thumbnails were broken images

## What
Live bug report from the site owner, with a screenshot: every photo thumbnail in the
"Before & After" section editor showed as a broken-image icon, for existing published
items (Lip Enhancement, Lip Definition, Cheek & Lip Definition), not just new ones.

Root cause: `sectionPanel.ts` (PR3, built earlier this session) set `img.src`/`preview.src`
directly from the stored content-JSON src (`images/<name>.jpg`, no leading slash —
decisions/00095's convention). Not loadable from the admin SPA's own document (no
`<base href="/">` outside the live-preview iframe) — resolves against whatever admin
route is current instead of the site root. `mediaDialog.ts` already has the exact fix,
`contentSrcToDisplayUrl()`, already used correctly by `pageSettingsDrawer.ts` —
`sectionPanel.ts` just never called it, at either of its two call sites.

## Why every test passed anyway
No existing test — vitest or Playwright — asserted a thumbnail's `src` attribute at all.
A plain coverage gap in PR3, not a subtler masked-assumption bug.

## The fix
Both call sites now call `contentSrcToDisplayUrl(picked.src)`. New coverage,
RED-confirmed against the reverted bug before GREEN-confirmed against the fix:
- `sectionPanel.test.ts`: thumbnail + add-flow-preview `src` assertions
  (`getAttribute("src")`, matching `pageSettingsDrawer.test.ts`'s established convention).
- `section-panel.spec.ts`: a real saved photo pair's thumbnails assert `naturalWidth > 0`
  in a real browser.

## Outcome — DONE 2026-07-31
Merged as PR #137 (github.com/joshcomley/wixy), merge commit `324f62f`. Full gate green:
ruff, mypy, bare pytest, admin-ui typecheck + 572 vitest + build, full e2e (40/40).
Live-verified with a real headed-browser (Playwright, chrome channel) check of
`/admin/section/before-after` on `ca.cinnamons.uk`: all 7 thumbnails across all 3
photo pairs load with real `naturalWidth` values (640/448px), confirmed by screenshot —
the exact same cards the owner's own bug-report screenshot showed broken.

Decisions: `decisions/00102-section-panel-thumbnail-content-src/`.

## Links
Reported live mid-session by the site owner via a chat message with a screenshot
attachment, not part of the original brief.
