# test_worker_app.py's TestTranscriptPersistence tests polled the API then slept a fixed 0.1s instead of polling the actual transcript file — failed for real on CI's shared runner

## What happened

PR7's own CI run (chat image attachments — unrelated feature, this file untouched by
that PR) failed the `python` job:

```
FAILED wixy_server/tests/test_worker_app.py::TestTranscriptPersistence::
  test_second_turn_rewrites_the_transcript_with_both_turns
AssertionError: assert ['first message', 'first reply'] == ['first message', 'first reply',
  'second message', 'second reply']
```

All 1001 tests, including this one, passed locally (both before pushing and in a dedicated
re-run) — the failure only reproduced on GitHub's shared `ubuntu-latest` runner. Not
dismissed as "just CI flake": confirmed this test file and `wixy_server/worker/` were
untouched by PR7's diff (`git diff origin/main..HEAD --stat` — empty), then root-caused the
actual mechanism rather than blaming the environment and moving on.

## Root cause

A genuine, pre-existing race the test's own code already half-acknowledged in a comment
(`test_transcript_file_exists_after_a_turn`, before this fix: `time.sleep(0.1)  # the
finally-block write races the poll by a beat`) — mitigated with a fixed sleep that usually
happened to be long enough locally, but not reliably on a slower/shared CI runner.

`wixy_server/worker/app.py`'s `_run_and_track`: a turn's messages are appended to
`WorkerConversation.messages` (in-memory, immediately visible via `GET
/conversations/{id}/messages`) DEEP INSIDE `run_turn(...)`. The transcript FILE is written
separately and LATER, in `_run_and_track`'s own `finally` block, via `await
anyio.to_thread.run_sync(lambda: write_transcript(...))` — dispatched to a worker thread,
after `run_turn` has already returned. So there is a real window, of genuinely
unbounded-in-the-worst-case duration (thread-pool scheduling delay, disk I/O, runner load),
between "the API already reflects the new message" and "the transcript file on disk
contains it."

All three `TestTranscriptPersistence` tests polled the API (`_poll_until`) for the
in-memory signal, then did a flat `time.sleep(0.1)` before reading the transcript file
directly — a guessed wait for an unbounded race, not a real synchronization. On a
loaded/shared GitHub Actions runner (pytest-xdist running 4 workers, plus whatever else
is contending for that runner's CPU), 100ms was not always enough for the background
thread to complete the write.

## Fix

Added `_poll_transcript_texts(tmp_path, conv_id, expected_count, timeout_s=3.0)` —
polls the transcript FILE directly (not the API) until it holds exactly the expected
number of lines, with a real bounded timeout, instead of sleeping a fixed guess. Safe
against reading a torn/partial write regardless of timing: `write_transcript`
(`wixy_server/worker/transcript.py`) replaces the file atomically (tmp file + `os.replace`,
per its own docstring), so a reader only ever observes the OLD complete content or the NEW
complete content, never a partial line — polling the line count can never produce a false
positive from a half-written file.

All three tests in `TestTranscriptPersistence` (`test_transcript_file_exists_after_a_turn`,
`test_transcript_survives_an_agent_run_failure`, `test_second_turn_rewrites_the_transcript_
with_both_turns`) now use this helper — the first two had the identical `time.sleep(0.1)`
pattern (not yet observed failing, but the same real race), fixed for consistency rather
than leaving two siblings with the same latent bug next to the one just proven to fail.

Confirmed via a dedicated run of the three tests directly (3 passed) and the full local
gate re-run (pytest, ruff, mypy) after the fix.

## What to watch for

- **Same lesson as decisions/00104** (found in the same PR's own gate, same session): a
  test polling one signal (an API/DOM/state read) and then sleeping a FIXED guess before
  asserting on a DIFFERENT, separately-timed signal is a real race, not a formality — it
  will eventually lose on a slower or more loaded environment than whatever machine wrote
  it. Poll the actual observable being asserted; don't bridge two independently-timed
  events with a guessed sleep.
- Any FUTURE code path that writes `wixy_server/worker/`'s transcript (or anything else
  persisted asynchronously after an API-visible state change) should assume the same gap
  exists — a caller needing "has this turn's transcript actually landed on disk yet" has
  no synchronous signal for that today; polling the file (as this fix now does in tests) or
  adding a real completion signal is the only correct way to observe it.
