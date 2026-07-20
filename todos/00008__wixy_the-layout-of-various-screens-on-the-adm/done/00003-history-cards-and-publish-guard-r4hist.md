# 00003 — Round 4: History cards, lighter buttons, nothing-to-publish guard

**Status (2026-07-21):** SHIPPED — PR #94 merged (155c6dd), live on ca.cinnamons.uk (slot blue). Gates: vitest 416/416, tsc clean, pytest 806, e2e 9/9, ad-hoc 20/20 at 390+320px.

## Operator feedback that started it (phone screenshot)

1. Buttons "still very tall" → 34px min-height at ≤720px (out of the 44px group).
2. "Light background colour" → new `--wx-btn-bg` token (light #fff / dark #2e3446)
   on history row actions + Reinstate + confirm buttons.
3. "Small gap between each item, each its own card" → ≤720px history table dissolves
   into a flex-column card stack (gap 12px); confirm/diff detail rows fuse onto the
   parent card (`margin-top: -13px` + `:has(+…)` radius).
4. "Why are there no changes on the last two?" → versions 9/10 were EMPTY-draft
   publishes (prod ledger confirmed `changed: {}`, same SHA as v8). Root fix
   (decisions/00071): `start_publish` preflights and 422s nothing-to-publish
   (rev check first, upstream fetch, page-ops count too); preview gains `opCount`;
   drawer disables Publish with a hint; api.publish maps 422 → failed.

## Verify / ship state

- vitest 416/416, tsc clean, bundles rebuilt; server guard tests green (13 passed
  incl. 422 + upstream-allowed + opCount).
- Remaining: full pytest, e2e, 390/320 ad-hoc visual verify
  (e2e/test-results/verify-history-round4.mjs), then PR → merge → poll → report.
