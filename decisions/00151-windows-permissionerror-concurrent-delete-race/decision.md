## Symptom

Independent DM verification of P8 round 5 (candidate `fa32bf3c`) hit a real, non-flaky
pytest failure under full-suite `-n 4` load (never under `-n0` or a single-file run — it
needs the CPU contention of the whole 1695-test suite to reliably surface):

```
FAILED wixy_server/tests/test_routes_livechat.py::TestDeleteWipeRoutes::
    test_delete_requires_token_and_removes_message_files_without_push
PermissionError: [WinError 5] Access is denied:
    '...\uploads\delete-route-attachment\assembled' ->
    '...\failed\delete-route-attachment\original.jpg'
```

The traceback originated inside `media_queue.py`'s `run_forever` background task (the
real app-lifespan worker `TestClient(app)` starts), not the test's own delete call. The
test creates an attachment directly via `store.create_attachment(...)`, which lands it in
`status='processing'` — exactly eligible for the live media-queue worker to independently
claim and start processing the same attachment the test is about to delete.

## Root cause

`_archive_failed_original` (`media_queue.py`) and `assemble()` (`uploads.py`) both already
anticipated this exact race — a message delete/wipe committing concurrently while a
background worker (queue processing an attachment, or an in-flight upload assembly) is
mid-file-operation on the same path — and both already re-check
`store.get_attachment`/`store.get_upload` after catching an exception to decide whether to
treat the failure as the concurrent delete winning (benign) or re-raise (genuine error).

But both only caught `FileNotFoundError`. On POSIX, a concurrent `rmtree` racing an
`os.replace` on the same path typically manifests as `FileNotFoundError`. **On Windows, it
manifests as `PermissionError` ("Access is denied") instead** — NTFS's stricter
file-locking semantics mean the sharing violation surfaces as an access error, not a
missing-file error, even though the underlying cause is identical: another thread is
mid-delete on the same directory tree. The guard clause was written for one OS's error
signature of this race and silently missed the other.

This is a genuine, load-dependent production bug: on the fleet's Windows-hosted Slots
deployment, a user deleting a message the same moment its photo/video/voice attachment is
still mid-processing (worker holds a lease, hasn't finished) can trigger this. Because
`_archive_failed_original` runs inside the app's lifespan-owned background task group
(`app.py`'s `tg.start_soon(_run_media_queue)`, same task group as the janitor), an
**unhandled** exception here would propagate up through `run_forever`'s and then `app.py`'s
own task group — crashing BOTH the media-queue worker and the janitor for the remaining
lifetime of the process, not just failing one request. This makes it an availability bug,
not merely a cosmetic test flake.

`janitor.py`'s own cleanup functions (`_remove_entry`, `cleanup_deleted_storage_once`,
`cleanup_unreferenced_storage_once`) already catch the broader `OSError` for exactly this
class of race — this was an inconsistency between two call sites solving the identical
problem, not a design gap needing new machinery.

## What was decided

Broadened both guard clauses from `except FileNotFoundError:` to `except OSError:`
(`PermissionError`/`FileNotFoundError`/etc. are all `OSError` subclasses), matching
`janitor.py`'s existing pattern exactly. The re-check-against-the-store logic underneath
is unchanged — a genuine, non-race `OSError` (e.g. disk full) still gets re-raised because
the row still exists in the DB at that point.

**Did not** use a `except (FileNotFoundError, PermissionError):` tuple form — `ruff format`
0.16.0 corrupts that exact syntax shape, dropping the parentheses and producing invalid
Python 2-style `except A, B:` (a SyntaxError), a bug already discovered and documented
elsewhere in this codebase (`wixy_server/livechat/pinclient.py`'s
`_post_with_narrow_retry`, which works around it with two separate `except` clauses). A
single `except OSError:` sidesteps the ruff bug entirely (no tuple, nothing to corrupt) and
avoids duplicating the guard body across two clauses, so it was preferred over
pinclient.py's two-clause workaround for this specific case.

Added regression tests exercising the exact Windows-signature race in both files
(`test_wipe_racing_archive_via_windows_sharing_violation_does_not_crash_worker` in
`test_livechat_media_queue.py`, `test_delete_racing_replace_via_windows_sharing_violation_
reports_unknown_upload` in `test_livechat_uploads.py`), confirmed red on the unfixed code
(monkeypatching `os.replace` to raise `PermissionError` at the exact moment a concurrent
delete/wipe would land) before applying the fix.

## What to watch for

- Any future file-operation guard clause in this codebase that only catches
  `FileNotFoundError` to detect "a concurrent delete won" should be checked against this
  same gap — the Windows/POSIX signature difference is not obvious from reading POSIX-first
  test coverage alone.
- `ruff format` (0.16.0, pinned only as `>=0.7` in `pyproject.toml`) corrupting
  `except (A, B):` into invalid syntax is a real, reproducible formatter bug, not
  environment-specific — confirmed in complete isolation on a two-line repro file. Two
  separate `except` clauses (or a single broader exception type, where semantically valid)
  is the working pattern until this ruff version issue is fixed upstream or the pin is
  tightened to exclude it.
