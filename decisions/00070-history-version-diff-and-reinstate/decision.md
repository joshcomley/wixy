## Symptom

Operator feedback on the mobile history screen (round 3 of the admin-mobile work):
the View/Restore buttons are "a bit jumbo", and — the bigger gap — "there's no way to
see the edits, either, or edit the edits". A ledger row told you `index (2)` changed
but not WHAT changed, and the only action available on a historical version was a
whole-site restore.

## Root cause

Two separate gaps:

1. The ≤720px history actions rule gave each button `flex: 1 1 auto`, stretching
   View/Restore to half the screen width each on top of the shared 44px touch-target
   min-height — half-screen pills.
2. There was no per-version diff anywhere. The ledger's own `changed` summary
   (`publisher._changed_summary`) records only the editor-lane overlay ops — never
   upstream/AI-lane merges — and only key NAMES, not values. spec/05 §5's history
   panel spec only ever called for View (archived build) + Restore.

## What was decided

1. **New endpoint `GET /api/admin/publishes/{version}/diff`** (`wixy_server/
   version_diff.py`): diffs the version's own SHA against the PREVIOUS LEDGER
   ENTRY's SHA — the ledger's append order IS the "what was live when" order
   (a restore appends a new highest-version entry carrying the restored-to SHA),
   so the SHA-to-SHA diff is exactly "what changed on the live site when this
   version went live", covering editor-lane ops, upstream merges, and restore
   entries (which record no `changed` at all) with one uniform mechanism.
   Response reuses the publish preview's exact `changes` shape
   (`{file_key: [{key, kind, old, new}]}`) so the admin UI renders both with
   one component. Reads go through `restore.worktree_at_sha` (promoted from
   `_worktree_at_sha` — its docstring's sanctioned mechanism, decisions/00024);
   binding kinds come from the NEWER version's own templates, computed INSIDE
   the worktree block (templates are read lazily by `extract_bindings_map`;
   content JSONs are read eagerly — computing kinds after the block dies with
   "no template for page"). Diff granularity = `restore._diff_content`'s:
   dicts recurse, everything else compares atomically (lists = one whole-array
   entry); a dict on only one side recurses against `{}` so added/removed
   subtrees report per-leaf with `None` on the missing side.
2. **History panel gets a per-row Changes expander** (same lazy detail-row
   pattern the restore confirm-row already used) rendering the shared
   `diffView.ts` component (extracted from `publishDrawer.ts` — the review
   drawer's DOM/classes preserved exactly).
3. **Per-diff-row Reinstate button** = "edit the edits": PATCHes the row's OLD
   value into the CURRENT draft (`PATCH /api/admin/draft`, fresh
   `state.draft.rev` per click + one 409 refetch-retry — the op queue's own
   posture). Nothing publishes until the owner reviews the draft as normal.
   Hidden when: the row's `old` is null (the key was ADDED by that version —
   there is no earlier value to reinstate, and the overlay has no
   delete-a-live-key op), or the row's page no longer exists in the current
   draft (the op would sit inert — `merge_overlay` skips unknown pages).
   Theme/`_global` rows are always reinstatable.
4. **Mobile buttons compact**: the actions rule becomes `flex: 0 0 auto`
   (content-width pills; the 44px touch min-height stays).
5. The panel's `onRestored` dep is renamed `onDraftChanged` — it now fires
   after both a restore AND a reinstate.

## Why

- Previous-ledger-entry as the diff baseline (not the git parent commit): the
  product question is "what changed on the site when version N went live",
  which is ledger-ordered, not commit-ordered — a publish can merge several
  upstream commits, and a restore's SHA predates its predecessor's.
- Reusing restore's worktree mechanism (rather than per-file `git show`):
  builder's loading is Path-based, so a worktree is the already-approved way
  to read historical content, and it makes the version's own binding-kind map
  available for free.
- Reinstate writes into the DRAFT (never straight to live): every content
  change in this engine funnels through draft → review drawer → publish; a
  one-click live mutation would bypass the owner's review step.

## What to watch for

- A Reinstate op whose old image `src` points at a since-deleted media file
  will surface as a validate error in the review drawer at publish time —
  honest, not silent.
- The diff endpoint materializes up to two scratch worktrees per call (fast
  for a small site repo, but it's an on-demand click, not a hot path — don't
  call it in a loop over the whole ledger).
- The first-ever ledger entry diffs against an empty baseline (every key
  "added"); the auto-bootstrap version 0 is normally that entry.
- Kind lookup for a key that changed TYPE between versions falls back to
  "text" — values still render, just without image/theme chrome.
