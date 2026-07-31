# TestWorkspaceIntegration's real git-subprocess tests used the same 3s poll timeout as fast in-memory checks — too tight under pytest-xdist contention

## What happened

A local re-run of the full Python gate (done to confirm decisions/00105's transcript-race
fix), still as part of PR7's own pre-ship verification, hit a SECOND, DIFFERENT failure in
the same file:

```
FAILED wixy_server/tests/test_worker_app.py::
  TestWorkspaceIntegration::test_second_turn_pushes_more_commits_without_a_second_pr
AssertionError: condition not met within 3.0s
```

(`_poll_until(lambda: len(github_state.pull_request_calls) > 0)`, waiting on the second
turn's real git push to complete.) Not conflated with decisions/00105's transcript-write
race — a different test class, a different mechanism, and worth telling apart precisely so
neither fix gets credited for something it didn't actually address.

## Investigation (measured, not assumed)

`TestWorkspaceIntegration`'s own docstring: "a REAL local bare repo standing in for
github.com... nothing else in the real code path is faked" — every test in this class
drives an actual `git clone`/`commit`/`push` subprocess sequence, unlike the rest of
`test_worker_app.py`'s classes (which use the `has_repo=False` degrade path, pure
in-memory). Ran `TestWorkspaceIntegration` alone, serially (`-n0`, `--durations=20`), to
measure real timing with zero xdist contention: the same test that failed took **2.02s**,
the heaviest one in the class — already two-thirds of the 3.0s budget with NOTHING else
competing for CPU. All 4 tests in the class passed cleanly in that run.

This is the real mechanism: `_poll_until`'s 3.0s default is well-suited to the FAST
in-memory-state checks the vast majority of this file's tests use (append a message,
read it back — sub-millisecond), but `TestWorkspaceIntegration`'s tests wait on real git
subprocess spawns (process-creation overhead, filesystem I/O) running on a background
thread. Under `pytest-xdist -n 4` (this repo's own fixed, load-bearing cap — never `-n
auto`), 4 workers compete for the same CPU/process-spawn/disk bandwidth; a sequence that
takes 2s uncontended can plausibly tip past 3s when three siblings are doing the same kind
of work concurrently. This is not a fabricated theory — it is the direct, measured
explanation for a real, reproduced-on-CI failure that a quiet serial run could not
reproduce.

## Fix

Added a `_GIT_TIMEOUT_S = 15.0` module constant (mirrors this codebase's own existing
convention elsewhere — e.g. `test_cmdchat.py`'s `readiness_timeout_s=10.0`/`30.0` overrides
for genuinely slow real operations, distinct from the fast-check default) and applied it as
an explicit `timeout_s=` override to all 7 `_poll_until` call sites inside
`TestWorkspaceIntegration` (every one of them is gated behind a real git subprocess
operation, or — for the bad-repo-url test — a real network clone attempt against
github.com). Left the shared `_poll_until` default (3.0s) untouched, since it's correctly
tuned for the many OTHER, genuinely-fast in-memory checks elsewhere in this file and in
sibling test files — this is a targeted override for the one class that does real,
measurably-slower work, not a blanket loosening.

## What to watch for

- **Third finding of the same underlying lesson in one PR's own gate** (alongside
  decisions/00104, 00105): a fixed timeout/sleep tuned against a quiet, uncontended local
  run is not automatically valid under CI's shared, parallel-worker conditions. When a
  test's own predicate depends on a REAL subprocess or network operation (not an in-memory
  state read), give it deliberately generous headroom from the start, matching this
  codebase's own existing `readiness_timeout_s`-style convention, rather than inheriting a
  fast-check default tuned for a different class of test.
- If `TestWorkspaceIntegration` grows a new test with its own `_poll_until` call, use
  `_GIT_TIMEOUT_S` there too rather than the bare 3.0s default — anything in this class is,
  by its own docstring's design, doing real subprocess work.
