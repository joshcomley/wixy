# Draft overlay.json reads/writes now share tree_lock() — closes an unlocked concurrent-access race

## Symptom

Workspace #29's Delivery Manager reported (while clearing an unrelated Builder's
work) that `e2e/tests/collection-edit.spec.ts` had a "reorder-timing assertion
in the showcase preview iframe" that failed 2 of 7 runs on unmodified `main`.

Investigation (this session, workspace #30) could not reproduce that specific
description: the "E2E 4: collection" test's reorder step passed 55/55 runs in
isolation and 40/40 in a dedicated repeat batch. Instead, the SAME FILE's
other test — `test.describe("PR 1: a hidden collection item survives an
inline structural edit …")` — reliably reproduced two distinct failure modes
when the whole file was run repeatedly (`--repeat-each=15`, both describe
blocks interleaved, matching the file's normal test order):

1. A server-side `PermissionError: [Errno 13] Permission denied:
   '…\draft\overlay.json'`, logged by uvicorn as an unhandled exception in
   `routes_preview.py:_build_preview_html` → `load_overlay` →
   `path.read_text()`.
2. `expect(hiddenItems).toHaveCount(1)` failing with `0` after
   `page.goto("/admin/preview/gallery.html")` — the DIRECT consequence of (1):
   the crash 500s the preview response, so the page has no
   `[data-wx-list-item]` elements at all, not a real data-loss bug.

## Root cause

`wixy_server/routes_preview.py`'s `_build_preview_html` already wraps its
`load_overlay` read in the process-wide `tree_lock()` (`treelock.py`) — added
originally for working-TREE read-consistency (2026-07-19 Edit-button-latch
incident). But several overlay.json READ and WRITE call sites never took any
lock at all, most importantly `routes_admin_api.py`'s `_apply_draft_patch`
(`PATCH /api/admin/draft`) and `_discard_draft` (`DELETE /api/admin/draft`) —
both do a plain read-modify-write (`load_overlay` → compute → `save_overlay`,
the latter an atomic tmp-file + `os.replace`) with no synchronization.

Every route in this file runs its blocking body via
`anyio.to_thread.run_sync`, i.e. in a real OS thread from FastAPI/Starlette's
thread pool — so two requests hitting the SAME project's overlay.json at
(almost) the same wall-clock instant genuinely execute their file I/O
concurrently. The PR-1 test's own retitle step fires
`page.waitForRequest(…PATCH…)` (resolves once the request is SENT, not once
the response lands) and immediately does `page.goto(".../preview/gallery.html")`
— a fresh preview load that can race the still-in-flight PATCH's
`os.replace()`. On Windows, a reader's plain `open()` racing a rename/replace
of the same path can throw `PermissionError` (a sharing violation); on any
OS, an unlocked read-modify-write pair is also a genuine lost-update hazard
(`apply_patch`'s own `rev` optimistic-concurrency check can't catch it,
since both writers can independently read the same still-current `rev`
before either has written).

CI (ubuntu-latest) never saw this: POSIX `rename()` is atomic against
concurrent readers with no sharing-violation failure mode, so only the
lost-update half of the bug could show there, and apparently rarely enough
not to have been caught — this is a real, if smaller, residual risk on Linux
too, closed by the same fix.

## What was decided

Extend the SAME `tree_lock()` pattern (an existing, `RLock`-based,
process-wide, already-documented convention: `treelock.py`,
`draft_repair.py`'s `run_repair` was already doing this correctly) to every
`load_overlay`/`save_overlay` call site that was missing it:

- `routes_admin_api.py`: `_apply_draft_patch` (PATCH /draft),
  `_discard_draft` (DELETE /draft), `_build_theme` (GET /theme),
  `_build_global` (GET /global), `_merged_source` (media routes' merged
  read), the publish preflight's overlay read/validate section, `GET
  /publish/preview`'s `_build`, `_apply_page_duplicate` (POST
  /pages/duplicate), `_apply_page_delete` (POST /pages/delete).
- `restore.py`: `run_restore`'s overlay read-modify-write.
- `reports.py`: `build_report_bundle`'s overlay reads.
- `publisher.py`: `run_publish`'s overlay read (rev check) and its
  end-of-pipeline `discard_all` write — each wrapped individually (not the
  whole multi-second pipeline), matching `treelock.py`'s own documented
  discipline of holding the lock "one step at a time," never across a
  multi-second build/verify phase.

No new locking primitive was introduced — this closes a gap in an existing,
already-battle-tested invariant rather than adding a second, parallel one.

## What to watch for

- Any NEW `load_overlay`/`save_overlay` call site added later must take
  `tree_lock()` around its read (and its write, if any) — there is no
  automatic enforcement of this (it lives in each call site, not inside
  `overlay.py` itself, matching the existing `_build_state`/`_build_content`
  convention this extends).
- `tree_lock()` is a re-entrant `threading.RLock` — nesting it (e.g. a
  function that already holds it calling another that also takes it) is
  safe from the same thread, but don't acquire it and then block on I/O
  that could itself need the SAME lock from a DIFFERENT thread while
  holding it across a slow operation (git fetch, build) — keep the held
  span to the overlay read/compute/write only, as done here.
- The originally-reported "reorder-timing… showcase preview iframe" flake
  was never reproduced (55+ clean isolated runs of that exact test). If it
  resurfaces, it is a DIFFERENT bug from this one — don't assume this fix
  covers it.
