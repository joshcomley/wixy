## Symptom

`test_worker_app.py::TestTranscriptPersistence::test_second_turn_rewrites_the_transcript_with_both_turns`
failed on `main`'s CI twice in one day ("transcript for anthropic-1 never reached 4 lines within 3.0s"),
then passed on every later run. Its own comment recorded an earlier "non-deterministic" hit too. It was
being treated as a flaky test.

## Root cause (reproduced, and it is a product bug, not a test flake)

`wixy_server/worker/app.py` writes the transcript in a `finally` after EVERY turn, from a worker thread
(`anyio.to_thread.run_sync(write_transcript, ...)`). A turn can end while the previous turn's write is
still queued or stalled. `write_transcript` built its text from the messages when it was called and
then replaced the file, with nothing ordering two writers for one conversation. So a delayed EARLIER
writer could replace the file AFTER a newer one, and the transcript then stayed permanently at the older
content: the latest turn missing from the durable record.

Measured, not assumed: running that test 60 times on an idle box passed 60/60 (~80 ms each, so the 3.0 s
wait is enormous and a plain slowdown cannot explain a failure); the same loop under 28 CPU-burning
processes failed 12/120, and in every failure the file on disk was left with 2 (or 3) lines, never
"late but eventually complete".

## What was decided

`write_transcript` takes a per-file lock (`_write_lock_for`) and takes its snapshot INSIDE it. Writers for
one conversation are therefore strictly ordered, and whichever runs last writes the messages as they
are at that moment, however the threads were scheduled. A deterministic regression test stalls the first
writer just before its replace, lets two more messages arrive, runs a second writer, and asserts all four
lines survive (red on the old code with the file stuck at two lines, green now). After the fix the same
load stress ran 400/400.

## What to watch for

- The lock registry is never pruned: entries are one small lock per conversation, and pruning could hand
  two concurrent writers different locks for the same file. If worker processes ever hold very large
  numbers of conversations, bound it with an LRU that only evicts unlocked entries.
- The lock only orders writers inside one process. The worker is one process per deployment; a second
  process writing the same transcripts root would need a different mechanism.
- A second, different failure on the same main runs is NOT fixed by this:
  `test_routes_livechat_transcription.py::TestErasure::test_wiping_the_chat_erases_the_transcript_bytes`
  (voice-note processing raising `FileNotFoundError` on an upload's `assembled` file while a wipe runs).
  It failed once, in a different subsystem (livechat media queue vs the wipe), and is recorded in the
  todo journal for its own investigation.
