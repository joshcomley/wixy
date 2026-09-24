## Symptom

Follow-up to `decisions/00151`. A fresh Sol review of round 6 (candidate `94fc6479`)
found two further gaps in the same area, both proven by targeted pytest probes:

1. `media_queue.py`'s `failed_dir.mkdir(parents=True, exist_ok=True)` ran **before** the
   `try:` block guarding `os.replace`. A concurrent wipe racing the `mkdir` call itself
   (Windows: `PermissionError`) escaped uncaught even though the exact same row-gone
   recheck that guards `os.replace` would have treated it as benign.
2. `uploads.py`'s `write_chunk()` had no guard at all around its own `os.replace`.
   `routes_livechat_media.py`'s `put_chunk` route already has a "write, then check if the
   upload row still exists" pattern (the same rows-are-authority discipline used
   elsewhere in this delivery) — but if the write itself raised, that check never ran,
   so the raw `PermissionError` escaped the route's shielded block as an unhandled
   exception instead of the intended clean 404.

Fixed both (moved the `mkdir` inside the `try`; wrapped the route's `_write()` call and
folded its outcome into the existing row-check instead of skipping it), added regression
tests for each, verified locally.

## A third finding, discovered independently while re-verifying

Running the **full** pytest suite (not just the two new regression tests) against the
combined fix surfaced a further failure in the SAME pre-existing test
(`test_delete_requires_token_and_removes_message_files_without_push`,
`decisions/00151`'s original trigger) — this time `os.replace` raised `FileNotFoundError`
(not `PermissionError`) while `store.get_attachment(att_id) is not None` still evaluated
`True` at the re-check, so `_archive_failed_original`'s `except OSError: ... if
store.get_attachment(att_id) is not None: raise` correctly-by-its-own-logic re-raised —
and crashed the worker's shared task group again.

Root cause: the "recheck the row after catching the exception" pattern from
`decisions/00151` has its own TOCTOU gap. `delete_message`'s route does the DB delete
(one atomic transaction) and the actual file cleanup (`cleanup_deleted_storage_once`,
which does the `os.replace`-racing `rmtree`) as **two separate steps**. A worker's
`_archive_failed_original` can start, pass its *own* initial "does the row exist" check
(finding it present) before the delete's DB transaction commits, then have its
`os.replace` fail because the delete's *file* cleanup already ran — while the delete's DB
commit and the worker's *post-exception* recheck haven't necessarily resolved in the
order the single recheck assumes. The recheck is therefore not a reliable enough signal
to gate a crash-worthy decision: "row still exists" can be a stale read relative to the
exact race that caused the failure, not proof of a genuine unrelated error.

## What was decided

`_archive_failed_original`'s file operations (`mkdir` + `os.replace`) now **never**
re-raise on `OSError`, regardless of what the row-existence recheck shows. Instead:

- Any `OSError` is logged (`logger.warning(..., exc_info=True)`) so a genuine,
  non-race problem (disk full, misconfigured permissions) is still visible in logs —
  not silently swallowed.
- The row-existence check still gates whether to run the deleted-storage cleanup
  side-effect (mark pending + `_cleanup_deleted_storage`), since that part is safe to run
  either way and only makes sense when the row is genuinely gone.
- The function never lets the exception escape and crash the worker's task group.

This matches `janitor.py`'s own already-established pattern for the identical class of
problem (log a warning, keep the tombstone pending for the next sweep, never crash) —
`_archive_failed_original` is now consistent with the rest of this subsystem rather than
being the one call site that tried to be "smart" about distinguishing race-loss from
genuine error via a re-check that can't actually make that distinction reliably.

This is a deliberate, narrow exception to the general "genuine errors should surface"
principle used elsewhere in this same file (`assemble()` in `uploads.py`, and the
`put_chunk` route fix above, both still re-raise for a request-scoped genuine error) —
justified specifically because (a) `_archive_failed_original`'s own docstring already
calls this archive "diagnostic-only... never load-bearing data", and (b) it runs inside
the app's *shared* background task group alongside the janitor, so its failure mode is
uniquely severe: crashing the *whole* background subsystem for the rest of the process's
life, not just one request or one item.

## What to watch for

- Any future "catch an OSError, recheck a DB row to decide whether to re-raise" pattern
  in a background worker that shares a task group with other long-lived work should ask
  whether a genuinely racy recheck is safe to gate a crash on. If the operation being
  guarded is diagnostic/best-effort (not correctness-critical), prefer log-and-continue
  over a recheck-then-raise that can itself lose the race it's trying to detect.
- This is now the third distinct fix in the same `_archive_failed_original` /
  `delete_message` concurrency surface across `decisions/00151` and this entry — all
  found by independent DM verification + Sol review rounds, not by the original Builder
  rounds or the Architect's holistic review. The area has proven unusually good at hiding
  races behind a re-check that looks sufficient until tested under real load.
