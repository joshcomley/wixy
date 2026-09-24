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

## A third failure variant, discovered while re-verifying

The full pytest suite failed again in the existing delete/processing race test
(`test_delete_requires_token_and_removes_message_files_without_push`). This run reported
`FileNotFoundError` from `os.replace` while a subsequent attachment-row read still
returned a row. The evidence establishes those observations, but does not establish the
precise ordering that caused them. Sol later confirmed the proposed timing explanation
was unproven; it is intentionally not stated as a root cause here.

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

This avoids allowing an observed filesystem error in a diagnostic-only background task
to cancel the shared task group. The later Architect ruling adds system-wide task
containment as the backstop, while preserving this point fix.

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
