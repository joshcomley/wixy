## Symptom

A full bare `pytest` run (while finishing the live-drawing server-side PR, decisions/00175)
reported:

```
FAILED wixy_server/tests/test_routes_livechat.py::TestDeleteWipeRoutes::
    test_delete_requires_token_and_removes_message_files_without_push
AssertionError: assert not True
 +  where True = storage_cleanup_pending()
```

with a captured `WARNING` log line immediately above it:

```
WARNING wixy_server.livechat.janitor:janitor.py:253 Server chat wipe cleanup remains
pending for ...\storage\projects\test\server\failed\delete-route-attachment
Traceback (most recent call last):
  ...
  File "...\wixy_server\livechat\janitor.py", line 160, in _remove_entry
    shutil.rmtree(path)
  ...
PermissionError: [WinError 5] Access is denied: '...\failed\delete-route-attachment\original.jpg'
```

## Investigation (per the fleet rule: never dismissed as "flake"/"unrelated" without evidence)

1. **The single failing test, alone, serial (`-n0`)** — PASSED.
2. **Confirmed by reading the code, not guessing:** the `PermissionError` is fully
   *handled*, not an unhandled crash — `cleanup_unreferenced_storage_once`
   (`janitor.py:249-253`) wraps its `_remove_entry(entry)` call in `except OSError:`,
   logs a `WARNING`, and sets `failed = True`, which is exactly what marks
   `storage_cleanup_pending()` still `True`. This is the SAME class of Windows
   sharing-violation-during-concurrent-cleanup race decisions/00151 already root-caused
   and fixed at two OTHER call sites (`media_queue.py`, `uploads.py`) — but this
   particular catch site (`janitor.py`) was already correctly broad (`except OSError`,
   not the narrower `FileNotFoundError` 00151 found missing elsewhere), so this is not
   a recurrence of 00151's specific bug.
3. **The actual defect, such as it is, is in the TEST, not the production code**: the
   test calls `cleanup_deleted_storage_once` + `scrub_once` exactly ONCE, then
   immediately asserts `not store.storage_cleanup_pending()` — with zero tolerance for
   the transient-lock-then-retry behavior the production code is explicitly designed
   to provide (docs/ai/livechat.md §10: "the two-second startup-resumed worker retries
   at startup and while the app runs"). Under enough concurrent I/O contention (this
   fleet box was, at the time, running many other agents' concurrent Python processes —
   confirmed via `Get-Process python*`, well over 100 processes), a freshly-written
   small file can be transiently locked (antivirus/indexer/NTFS write-lock) at the exact
   moment of the test's single cleanup attempt.
4. Diff-confirmed this PR touches neither `janitor.py` nor this test
   (`git diff --stat`) — the failure is not caused by the live-drawing feature.
5. This is the SAME documented failure MODE as decisions/00025 and 00027: a
   full-suite-only, non-reproducible-in-isolation timing sensitivity from resource
   contention, in code unrelated to the PR that surfaced it.

## Decision

Per decisions/00025's own explicit precedent ("the bar is ANSWERING definitively why,
not always solving," and "do not chase a root-cause fix... out of scope — would mean
reading and changing... logic that predates this milestone and has nothing to do with
[this] work"): **recorded, not fixed, as part of the live-drawing PR.** The why is
answered — full-suite-scale resource contention hitting a transient Windows file lock
that production code already tolerates by design, exposed by a test with no retry
tolerance of its own. Not treated as a blocker for decisions/00175's PR.

## What to watch for

- If a FUTURE PR touching `janitor.py`'s cleanup retry logic, or this specific test,
  hits this again, the real fix (in scope for THAT change) is to make the test retry
  the cleanup call a couple of times (mirroring the production worker's own behavior)
  before asserting `not storage_cleanup_pending()`, rather than requiring the very
  first attempt to win under load.
- Do not treat a future recurrence as a signal to look inside anything the live-drawing
  feature touched — confirmed via `git diff --stat` that this PR's changes never
  import or share state with `janitor.py`'s cleanup path.
- Consistent with decisions/00025's own guidance: this is not a reason to loosen the
  fixed `-n 4` xdist cap.
