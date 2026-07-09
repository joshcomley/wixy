# 00009 [n4yhas] M9 WX — Publish + history

## What
Publish pipeline (lock -> pull -> materialize overlay+media -> commit/push -> build ->
verify -> swap -> ledger), publish drawer (diff review + upstream commits + validate
surface), history panel, restore, prune; upstream watcher + draft-status chip; E2E 5, 6;
kill-during-publish test.

## Why
Owner-experience bullets #5 (Publish) and #6 (version history / restore) — the human
gate at the center of the whole architecture (spec 01 §2).

## Context / current state
Depends on 00006 (server core) and 00008 (media, since publish moves staged media) —
both DONE. Milestone 9 is at least as large as M6/M7/M8 (each 4 slices) — sliced the
same way, backend-first:

- Slice 1 [DONE]: publish pipeline core + ledger (`wixy_server/publisher.py`,
  `ledger.py`, new) — no HTTP surface yet, that's slice 2. Steps 1-5 (spec/04 §5):
  preflight (rev check, fetch+ff-merge), materialize (content/theme rewrite, page
  ops, media move-with-rewrite — COPY then delete-after-validate so a validate
  failure never loses a staged upload even transiently), commit+push+tag (retry
  ONCE on a rejected push, re-materializing against the new tip), build+verify
  (existing self-check + a new lightweight text-diff smoke check vs the previous
  build), swap (live pointer, ledger entry, overlay clear, prune last-20-versions'
  builds). `wixy_server/live_pointer.py` gained `save_live_pointer`;
  `wixy_server/checkout.py`'s `_run_git` renamed to public `run_git` (still only
  called from read-only functions WITHIN checkout.py itself; the publisher reuses
  it for write ops rather than re-implementing the subprocess convention).
  `wixy_server/watcher.py`'s `fetch_once` now skips entirely while
  `paths.publish_lock` exists (closes decisions/00013's flagged watcher/lock
  gap). Tested against REAL git repos with a genuine BARE origin (spec/08 §1),
  including a real push-rejection race. Full reasoning: decisions/00024.
- Slice 2 [DONE]: publish HTTP surface — `POST /api/admin/publish` (awaits the
  whole synchronous `run_publish` via `anyio.to_thread.run_sync` directly in
  the handler; no fire-and-forget task, per decisions/00026 decision 1),
  `GET /api/admin/publish/stream` (hand-rolled SSE, no new dependency, polls
  the same in-process `PublishJob` on `app.state`), `GET /api/admin/publishes`
  (ledger listing, newest-first, marks the live one), `GET /api/admin/publish/
  preview` (the review drawer's binding-map-driven diff + `validate_site`
  result against the overlay-merged in-memory content — closes a real
  staged-image false-positive gap, decisions/00026 decision 3). Admin-ui
  `publishDrawer.ts` (new) + `shell.ts`'s Publish button and draft-status chip
  both wired for real (removing the milestone-8 stub), switching drawers
  correctly if page-settings was already open. Full reasoning: decisions/00026.
- Slice 3 [DONE]: history panel + restore. `wixy_server/restore.py` (new):
  `run_restore` loads a ledger entry, ensures its build exists (rebuilding via
  a scratch `git worktree add <sha>` if pruned — the deviation from
  decisions/00010 decision 4's anticipated `git show` approach, logged in
  decisions/00027), computes the diff via a simple recursive dict-walk
  (recurse into dicts, atomic-compare everything else — satisfies "whole-array
  for lists, per-leaf otherwise" with no bindings-map lookup needed at all),
  sets the overlay, flips the live pointer instantly, appends a
  `{action:"restore", of:N}` ledger entry. A page added since the restored
  version is staged for deletion; a page deleted since is refused outright
  (no template to resurrect from). `wixy_server/routes_versions.py` (new):
  `GET /admin/versions/{n}/{path}` serves the WHOLE archived build dir
  read-only (not just the page's HTML, so CSS/images render faithfully too) —
  its own test actually FETCHES the served URL (decisions/00022's flagged bug
  class), not just string/on-disk-existence assertions. `POST /api/admin/
  restore` added to routes_admin_api.py. `admin-ui/src/historyPanel.ts` (new):
  the `#/history` panel, ledger table + View link + a real typed-confirmation
  ("type RESTORE") row for Restore. Full reasoning: decisions/00027 (a
  box-level rare full-suite-scale test flakiness pattern, investigated,
  unrelated to restore's own correctness) and decisions/00028 (the history
  panel's UI decisions).
- Slice 4 (scope decision needed when reached): page duplicate/delete routes +
  wiring the pages-panel's dead buttons — `_materialize`'s page-ops handling
  (this slice) already supports `pages_added`/`pages_deleted` generically, but
  NO route produces them yet. Decide explicitly whether M9 closes this out or
  re-defers it further (spec/09's own M9 one-liner doesn't name it).
- Slice 5 (closing): E2E 1, 4, 5, 6 (not just 5/6 — E2E 1 "text edit" and E2E 4
  "collection" were deferred THROUGH M7/M8 pending this milestone's publisher,
  decisions/00015 decision 4/00019/00023 — none of the four exist as Playwright
  specs yet) + a real kill-during-publish drill + closing decision, matching
  M6/M7/M8's own "E2E + closing decision" precedent.

## Relevant files
- spec/04-server.md §5-7 (publish pipeline steps, restore semantics, upstream watcher)
- spec/05-editor.md §5 (publish drawer / history UX)
- spec/08-testing-acceptance.md §1 (publish pipeline test list incl. every failure leg),
  §2 E2E 5, 6 (also 1, 4 — see slice 5 above)

## How to continue + acceptance
Every publish step's failure leaves live serving + draft intact (tested on temp git
repos with simulated bare-repo origin) — DONE (slice 1). Kill-during-publish drill
passes — slice 5. Restore diff granularity is binding-map-driven (whole-array for
lists, per-leaf for scalars) — DONE (slice 3). E2E 5 (two publishes -> restore #1)
and 6 (AI-lane faked commit -> preview banner -> publish drawer lists it) passing
— slice 5.

Next: slice 4 (page duplicate/delete routes — resolve the open scope question
first) or slice 5 (E2E + closing) — either order is defensible; slice 4 is smaller
and its own scope question benefits from being resolved before the closing E2E
pass locks in what milestone 9 covers.

## Links
PR (slice 1): https://github.com/joshcomley/wixy/pull/35 (merged d0e0880; required a
follow-up fix commit 1e3cbf1 — `git tag -a` needs a committer identity too, not just
`git commit`; passed locally because this machine has a global git identity, failed
on CI's clean runner, fixed by passing the same `-c user.name=/-c user.email=`
override already used for `_commit`)
PR (slice 2): https://github.com/joshcomley/wixy/pull/36 (merged b32e48d)
PR (slice 3): (fill in once opened)
