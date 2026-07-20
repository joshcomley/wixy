# 00002 — Round 3: History compact buttons + Changes diff + Reinstate

**Status (2026-07-20):** SHIPPED — PR #92 merged (a22ca53), live on ca.cinnamons.uk
(slot blue), all gates green: vitest 413/413, tsc clean, pytest 803, e2e 9/9,
ad-hoc Playwright 16/16 at 390+320px.

## Operator feedback that started it

> The "View" and "Restore" buttons are a bit jumbo on the history page, and there's
> no way to see the edits, either, or edit the edits

## What was built (decisions/00070)

1. **Compact buttons**: ≤720px history actions `flex: 1 1 auto` → `flex: 0 0 auto`
   (content-width pills; 44px touch min-height stays).
2. **See the edits**: new `GET /api/admin/publishes/{version}/diff`
   (`wixy_server/version_diff.py`) — SHA-to-SHA content diff vs the previous ledger
   entry (covers editor + upstream lanes AND restore entries; the ledger's own
   `changed` summary is editor-lane key-names only). Same `changes` shape as the
   publish preview. History rows get a **Changes** expander (lazy detail row) using
   the new shared `admin-ui/src/diffView.ts` (extracted from publishDrawer.ts).
3. **Edit the edits**: per-diff-row **Reinstate** button PATCHes the row's old value
   into the current draft (fresh rev per click + one 409 retry; hidden when old is
   null or the page no longer exists). Panel dep renamed `onRestored` →
   `onDraftChanged`.

## Verify / ship state

- vitest 413/413, tsc clean, pytest 803 passed, bundles rebuilt.
- e2e + 390/320 ad-hoc visual verify: see session task list; then PR → merge →
  poll /api/version → report.
