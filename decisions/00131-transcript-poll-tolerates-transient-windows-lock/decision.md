# Decision: `_poll_transcript_texts` tolerates a transient `PermissionError`, mirroring the writer's own retry

## Symptom

A full local suite run (`pytest`, fixed `-n4`, unrelated PR — `fix/public-asset-cache-
fingerprinting`, which never touches `wixy_server/worker/`) hit one real failure:

```
FAILED wixy_server/tests/test_worker_app.py::TestTranscriptPersistence::
  test_second_turn_rewrites_the_transcript_with_both_turns
PermissionError: [Errno 13] Permission denied: '...\transcripts\anthropic-1\transcript.jsonl'
```

Raised from `_poll_transcript_texts`'s `path.read_text(encoding="utf-8")` call. Confirmed
this PR's diff (`builder/assetcache.py`, `wixy_server/routes_public.py` + their tests) has
no code path anywhere near `wixy_server/worker/` before treating this as unrelated — same
discipline as decisions/00105, not just an assumption.

## Root cause

Decisions/00105 already root-caused and fixed the underlying RACE (`_poll_transcript_texts`
polls the transcript file's actual line count with a bounded timeout, instead of a
poll-the-API-then-sleep-and-hope pattern) — but it fixed the race in *content*, not in
*I/O errors during the read itself*.

`wixy_server/worker/transcript.py:write_transcript` rewrites the whole transcript via a
tmp-file + `os.replace` swap, and its own `_replace_riding_out_scanners` helper already
documents and retries around exactly this class of problem on the WRITE side:

> "On Windows an external reader — Defender real-time scan, the Search indexer — can
> briefly hold the freshly written tmp file (or the replace target), failing the rename
> with WinError 5 even though nothing is actually wrong and the lock clears within
> milliseconds." (dated 2026-07-20, a prior incident)

`_poll_transcript_texts` (the test helper, added by decisions/00105) polls that same target
path from the READ side, and never got the equivalent tolerance — it called
`path.exists()` then unconditionally `path.read_text(...)`, with no handling for the exact
same external lock (or the brief window `os.replace` itself can make the destination
transiently unopenable on Windows) hitting the read instead of the write. decisions/00105
closed the race it was written for; this is a different gap in the same helper, only
reachable on Windows, not previously hit hard enough to notice.

## What was decided

`_poll_transcript_texts` now catches `PermissionError` around the `read_text` call and
treats it exactly like "the expected line count isn't there yet" — i.e. keep polling within
the existing bounded timeout, not a hard failure. This is the direct read-side mirror of
`_replace_riding_out_scanners`'s own write-side retry, not a new pattern: the same external
lock class, tolerated on both sides of the same file now instead of just one.

Deliberately narrow (`PermissionError` only, not a bare `except OSError` or `except
Exception`) — a genuinely different I/O error (disk full, a real permissions
misconfiguration) should still surface as a test failure rather than silently retry until
the timeout and produce a less specific `AssertionError` in its place.

## Verification

Re-ran the full local suite (`ruff check`, `ruff format --check`, `mypy --strict`, `pytest`
fixed `-n4`) after the fix: all green, including this test, alongside the unrelated
asset-fingerprinting changes this PR actually set out to make (decisions/00130).

## What to watch for

- If this specific `PermissionError` recurs frequently enough to be a real pattern rather
  than a rare environmental hit, the next escalation (matching `_replace_riding_out_scanners`'s
  own shape) would be a short bounded retry-with-backoff on the read side too, rather than
  just "poll again on the next 0.02s tick" — not done here since a single tolerant catch
  inside an already-running poll loop achieves the same effect for free (the very next
  iteration retries), without inventing a second retry mechanism next to the loop that
  already exists.
- Cross-reference from decisions/00105 (the original race this helper was written to fix)
  isn't added there — that decision is closed and accurately describes what it fixed; this
  file is the place a future reader lands if they hit this exact `PermissionError` and go
  looking.
