# 00005 — Overlay chrome leak (eye toggle → draft values) + prod draft remediation

**Status: fix implemented + gates running; prod draft already remediated. PR-A.**

## What happened (2026-07-21)

Prod ca draft rev 59 had eye-toggle button markup + 👁️ text staged inside
`_global:hours` (all rows) and `index:treatments.cards` (course fields). Boot-time
`ensureIfToggle` injects the toggle INTO if-bound content elements (incl. elements
that are ALSO text-bound, e.g. ca's `<span data-wx-if=".closed" data-wx=".value">`),
and raw `innerHTML`/`textContent` reads then swept chrome into committed values:
item-scoped whole-array re-emits, `isRichLiteContent` misclassification, popover seeds.

## Done so far

- **Remediation (live)**: PATCHed prod draft via admin API rev 59→60 with
  chrome-stripped values. All 6 ops kept; genuine edits preserved (Wednesday
  "Closed", 3 treatment-card body rewrites). Draft is publish-safe NOW.
- **Engine fix** (this worktree, uncommitted at write time):
  `dom.ts` OVERLAY_CHROME_SELECTOR + isRichLiteContent ignores chrome;
  `contentModel.ts` chromeFreeClone/chromeFreeInnerHtml/chromeFreeTextContent,
  readScalarValue uses them; `overlay.ts` seeds + link label via chrome-free
  readers, re-attach toggle after innerHTML overwrites (applyValueToElement,
  blankTextLikeFields). decisions/00073 written. Inv 23 added to docs/ai/invariants.md.
- **Tests**: 5 RED-first vitest (dom/contentModel/overlay) — 114/114 editor green,
  typecheck clean, bundle rebuilt (wixy_server/static/editor/editor.js).

## Remaining

- Gates: full pytest (running) → e2e (sequential after!) → commit → PR → merge →
  verify live (/api/version sha + slot grep for chromeFree in editor.js) → mark DONE.

## Blocked on #96 earlier (now unblocked)

Service-token admin API was 401ing ("token not yet valid (iat)") — hub clock ~3s
behind CF edge + fresh per-request JWTs. Fixed by leeway PR #96 (decisions/00072).
