## Symptom

Operator round-4 feedback (phone screenshot of the live History screen):

1. The action buttons were "still very tall" even after round 3's width fix —
   the shared 44px touch-target min-height made every row action a ~48px pill.
2. The buttons blended into their card (same `--wx-surface` fill) — "could
   probably use a light background colour."
3. Rows ran into each other — "put a small gap between each item, so each is
   its own card. With all the detail it becomes difficult to discern end and
   start."
4. "Why are there no changes on the last two?" — versions 9 and 10 on the
   production ledger had `changed: {}` and the SAME SHA as version 8.

## Root cause

1-2. Round 3 fixed width (`flex: 0 0 auto`) but left the 44px min-height and
   the card-coloured fill.
3. The ≤720px restack kept the single-table frame: rows separated only by a
   hairline border, invisible once a Changes detail row added a second visual
   block.
4. `POST /api/admin/publish` accepted an EMPTY draft with nothing upstream
   pending. The pipeline's `_stage_commit_push` deliberately skips the commit
   when nothing changed (designed for "pure upstream commits riding through"),
   so the publish recorded a new ledger version pointing at the SAME SHA —
   legitimate plumbing, meaningless product event. The review drawer even
   rendered "No draft changes." and still offered an enabled Publish button.

## What was decided

1. **History row actions drop to 34px min-height at ≤720px** (out of the
   shared 44px group). The operator asked twice; their phone, their call —
   34px is clearly compact and still comfortably tappable for secondary row
   actions. Primary form buttons (publish confirm, restore confirm) keep 44px.
2. **New `--wx-btn-bg` token** (light: `#ffffff`, dark: `#2e3446`) — a fill
   one step LIGHTER than the surface, applied to the history row actions, the
   Reinstate chip, and the restore-confirm buttons. Scoped to history (the
   only screen the operator flagged); other screens can adopt it later.
3. **Each history entry is its own card at ≤720px**: the table frame
   dissolves (`background: transparent; border: none`), `tbody` becomes a
   flex column with `gap: 12px`, every row gets surface + border + radius.
   Restore-confirm and Changes detail rows fuse onto their parent card
   (`margin-top: -13px` eats the gap + border tuck; `:has(+ …)` drops the
   parent's bottom radius). Desktop table untouched.
4. **Nothing-to-publish is refused, end to end**:
   - Server: `start_publish` preflights before a job exists — rev check FIRST
     (a stale rev keeps its 409 contract even on an empty draft), then, only
     when nothing is staged (ops + page adds + page deletes all empty) and a
     checkout exists, fetch+ff (the same call the pipeline's pulling stage
     would make) and 422 when no upstream commits are pending either. An
     empty draft WITH upstream pending still publishes — the designed
     "upstream riding through" case. No checkout (never-published/broken
     install) → guard steps aside; the pipeline owns that 502.
   - Contract: `GET /api/admin/publish/preview` gains `opCount` = content ops
     + staged page adds + staged page deletes (a staged page deletion makes
     NO `changes` entries, so counting groups would undercount).
   - Drawer: `opCount === 0 && upstream.length === 0` → Publish disabled with
     a "Nothing to publish — make an edit first." hint; `api.publish` maps
     the 422 to `{kind:"failed"}` verbatim.

## Why

- Refusing at the ROUTE (not inside `run_publish`) keeps the pipeline
  library permissive for its other callers (bootstrap, restore-follow-up
  publishes) and preserves the exact 409/502 semantics around it.
- Preflight fetches because the local checkout's refs can lag origin; a
  guard that answers from stale refs would refuse a publish that actually had
  upstream work to merge.
- Card-gap is mobile-only, like every other restack: the desktop table's
  column separation already reads clearly.

## What to watch for

- The two no-op versions already on the production ledger (9, 10) stay —
  they're real history; only NEW ones are prevented.
- A PATCH landing between preflight and `run_publish` can still produce an
  empty publish in theory (guard passed, then ops discarded) — same race any
  preflight has; harmless and not worth locking.
- `:has()` fuses the detail card to its parent on modern mobile browsers;
  without it the detail row renders as its own adjacent card — still
  readable, just less fused.
