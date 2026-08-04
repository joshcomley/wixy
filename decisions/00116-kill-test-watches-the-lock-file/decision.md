# The kill-during-publish test watches the lock file, not the state endpoint

## Symptom

`test_kill_during_publish.py::test_a_real_process_kill_mid_publish_leaves_live_
ledger_and_draft_untouched` failed in a full `pytest` run (2026-08-04,
1 failed / 1054 passed):

```
AssertionError: never observed the publish job actually running — the kill
couldn't have interrupted anything, this run proves nothing
assert None is not None
```

It passes every time in isolation (`-n 0`, measured). Only the full `-n 4` suite
reproduces it, which is exactly the shape that gets written off as "a flake".

## Root cause

The test detected "the publish is running" by polling `GET /api/admin/state` in a
tight loop and reading `publishJob.isRunning`. That is a **sampling race against
a window the endpoint itself is blocked for**:

- `/api/admin/state` reads the checkout under `tree_lock()` — deliberately, so an
  admin read never observes a half-materialized working tree (the Edit-button
  latch incident, 2026-07-19).
- `publisher._materialize` holds that same `tree_lock()` for the whole of step 2.
- So every poll issued while materialize runs BLOCKS, and returns only once the
  lock is released — by which time the publish (against a one-page fixture repo
  and a local bare origin) can already be terminal. `isRunning` is then false on
  every sample the loop ever gets, the 10s deadline expires, `observed_stage`
  stays `None`.

Extending the deadline cannot fix this: once the publish has finished, no later
poll can ever observe it running. The loop also had no sleep, so it hammered the
very server it was racing — adding load under an already-contended `-n 4` run.

## Decision

Watch the filesystem instead. `run_publish` writes `locks/publish.lock`
immediately before `job.stage = "pulling"` and removes it in its `finally`, so
that file exists for the **entire** pipeline — a non-sampling signal that is
visible to another process, costs the server nothing, and is not gated by
`tree_lock()`. The test waits for the lock to appear (2 ms poll, 30 s budget),
kills at once, and asserts the lock was actually seen.

The `observed_stage not in ("swapping", "done")` assertion is dropped: the lock
appears within milliseconds of the publish starting, and "swapping" is the far
side of a real fetch/commit/push/build, so a late kill is no longer a realistic
outcome — and if it ever happened, the three pre/post equality assertions
(live.json, ledger, overlay) fail loudly rather than passing silently. That
assertion's own message told the reader to "rerun", which is the tell that it was
never a real check.

## Why not something simpler

- *Rerun / mark it flaky.* Forbidden here, and it would leave a real gap: the
  test could pass by never testing anything.
- *Raise the deadline.* Provably useless — the miss happens because the publish
  has already ENDED, not because there wasn't enough time.
- *Use the SSE stream (`GET publish/stream`).* It is itself a poll loop
  (`_PUBLISH_STREAM_POLL_S`) over the same in-memory job, so it carries the same
  sampling gap.
- *Slow the pipeline down for the test.* Would mean test-only hooks in the
  publish path, or a fixture tuned to be slow — fragile, and it makes the
  production code carry the test's problem.

## What to watch for

- This makes the test depend on `locks/publish.lock` existing for the whole
  publish. If a future change moves the lock write later, narrows it to one step,
  or drops it in favour of an in-memory guard, this test silently loses its
  trigger — it would then fail on `publish_in_flight`, which is at least loud.
- The same "sampled a lock-gated endpoint" trap applies to any future test that
  tries to catch a publish mid-flight through the admin API. Watch the lock file.
