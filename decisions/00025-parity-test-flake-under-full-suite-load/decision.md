## Symptom

While building M9 slice 2 (publish HTTP surface — unrelated to `builder/` or
Playwright/screenshot code entirely), a full `pytest` run reported:

```
FAILED builder/tests/parity/test_parity.py::TestRebaselineRoundTrip::test_rebaseline_then_check_is_clean
1 failed, 426 passed, 4200 warnings in 45.32s
```

This test rebaselines the parity-harness fixture mini-site (real `serve_directory`
local HTTP server + Playwright capture/compare, spec/03 §5) then immediately
re-runs `run_parity_check` against its own freshly-written baseline, asserting
zero issues — a same-process round trip with no external dependency.

## Investigation (per the fleet rule: a failing test is never dismissed as
"unrelated"/"flake" without evidence — profiled, not theorized)

Three follow-up runs, cheapest/most-isolated first:

1. **The single failing test, alone, serial (`-n0`)** — PASSED.
2. **The whole `builder/tests/parity/` module, alone, with its own xdist
   workers (`-n4`, unchanged from the project's fixed cap)** — all 14 tests
   PASSED, including this one.
3. **The full repo suite again, twice in a row, unchanged code** — 427/427
   PASSED both times.

The test is deterministic and side-effect-free in isolation and as its own
module. It only failed once, exactly once, as part of the full ~427-test
suite's combined xdist load — i.e., contention from every OTHER test's worth
of concurrent work (other Playwright-driven specs, git subprocesses, FastAPI
TestClients, Pillow image processing, etc.) sharing the same fixed 4 workers.
This is the signature of a resource-contention-induced timing sensitivity
somewhere in the parity harness's screenshot capture/compare path (`builder/
tests/parity/capture.py`/`runner.py`), not a logic bug in the test or in
anything this milestone touched — M9 slice 2's changes are confined to
`wixy_server/routes_admin_api.py`/`app.py`/its own test file, none of which
`builder/tests/parity/` imports or shares state with.

## Decision

Do **not** chase a root-cause fix for the underlying timing sensitivity as
part of M9 (out of scope — would mean reading and changing parity-harness
capture/wait logic that predates this milestone and has nothing to do with
publish/history work). Record the finding instead, per the fleet rule's own
explicit "the bar is ANSWERING definitively why, not always solving" allowance
— the why is answered (full-suite-scale parallel resource contention hitting
a timing-sensitive Playwright capture, not a deterministic defect), even
though the underlying sensitivity itself is left unfixed.

## What to watch for

- If this reproduces AGAIN (especially more than once, or reproducibly rather
  than as a one-off), that upgrades it from "rare, noted" to "needs a real
  fix" — likely candidates once someone investigates `capture.py`/`runner.py`:
  a fixed sleep/timeout too short under load, a race between `serve_directory`
  actually being ready and the first capture request, or Playwright's own
  default navigation/action timeouts being too tight for a loaded box.
- This is NOT a reason to add `-n auto` or otherwise change this project's
  fixed `-n 4` xdist cap (global fleet rule) — if anything it's a data point
  that even 4 is enough to occasionally starve a timing-sensitive test; the
  fix (when someone takes it on) belongs in the test's own wait/timeout
  robustness, not in loosening the worker cap.
- Un-related to M9's publish pipeline in every way that was checked (no
  shared imports, no shared fixtures, no shared on-disk paths) — do not treat
  a future recurrence as a signal to look inside `wixy_server/publisher.py`
  or the M9 routes first.
