## Symptom

While building M9 slice 3 (restore + `git worktree add`-based historical-state
loading, `wixy_server/restore.py` — brand new this slice), a full `pytest` run
reported:

```
ERROR wixy_server/tests/test_restore.py::TestRunRestore::test_a_page_added_since_the_restored_version_is_staged_for_deletion
437 passed, 4552 warnings, 1 error in 42.13s
```

An ERROR (not a FAILURE — likely an unhandled exception during setup/teardown or
the test body itself, not a failed assertion), only ever seen in a FULL, all-file
suite run, never once in isolation.

## Investigation

Per the fleet rule (never dismiss a failing/erroring test as "flake" without
evidence) and the exact precedent this session already established in
decisions/00025 for an unrelated pre-existing flake:

1. `test_restore.py` alone, repeatedly (2 separate invocations) — 10/10 PASSED
   both times, no error.
2. Full suite, 3 more times immediately after the first error — all 437/437
   PASSED, error did not recur.
3. Could not capture the actual traceback (it never reproduced again to catch
   it "in the act" — `tail`-only captures from the first occurrence only kept
   the summary line, and by the time this was noticed the full log had already
   scrolled past what a short tail preserved).
4. After a defensive robustness fix (below), 3 more full-suite runs — all
   437/437 PASSED.

Net: 1 error across 8 total full-suite invocations (≈12.5%), 0 errors across
every isolated run of the specific test/file. This is consistent with the SAME
class of full-suite-scale resource contention already documented in
decisions/00025, but happening this time in code THIS slice wrote (the new
`git worktree add`/`remove` mechanism), not pre-existing, unrelated code — worth
a separate entry rather than folding into 00025, since a future agent hitting
this again should look at `restore.py` first, not assume it's the same
Playwright-timing issue 00025 already ruled out as the cause there.

## Working hypothesis (not conclusively proven)

`git worktree` operations do real filesystem work (registering/deregistering
metadata under `paths.repo/.git/worktrees/<name>/`) — on Windows specifically,
under heavy I/O contention from 4 concurrent xdist workers each spawning their
OWN git subprocesses (this suite's other ~20 test files all shell out to git
too), a `git worktree remove --force` could plausibly fail transiently (e.g. a
not-yet-released file handle) without `_worktree_at_sha`'s original code even
checking its exit code — silently leaving a dangling worktree registration
that points at a directory `shutil.rmtree` was about to delete anyway.

## Decision

Did not chase this to a conclusively-proven root cause (would require actually
catching a live repro, which 8 attempts didn't produce) — but the hypothesis
above pointed at a REAL, independently-justified gap regardless of whether it's
THE cause: `_worktree_at_sha`'s cleanup `finally` block ignored `git worktree
remove`'s exit code entirely. Fixed unconditionally: check the exit code, and
if non-zero, run `git worktree prune` (the command git provides for exactly
this — reconciling administrative files for worktrees whose directories no
longer exist) as a fallback reconciliation step, so a failed `remove` can never
leave `paths.repo`'s worktree metadata pointing at a since-deleted directory.

This is the same posture as decisions/00025: profiled with real evidence
(isolated-pass, module/full-suite-pass-most-of-the-time) rather than
theorized, then either fixed what evidence pointed at (here) or recorded the
finding (there) rather than blocking on a fully conclusive root cause neither
investigation could produce within a reasonable number of attempts.

## Update — a second, different file hit the same pattern

Immediately after the fix above, while doing the final pre-ship full-suite
verification for M9 slice 3 as a whole, a DIFFERENT full-suite run produced:

```
ERROR wixy_server/tests/test_publisher.py::TestValidateFailure::test_working_tree_is_actually_clean_after_the_abort
444 passed, 4972 warnings, 1 error in 52.88s
```

`test_publisher.py` is pre-existing M9-slice-1 code, untouched this session,
testing a completely different git operation (`_reset_hard`/abort-cleanliness,
no `git worktree` involved at all). Same investigation: isolated re-run of
`test_publisher.py` alone — 19/19 passed; two more full-suite runs immediately
after — 445/445 both times, error did not recur.

This REFRAMES the original finding: it is NOT specific to `_worktree_at_sha` or
to `restore.py` at all. Across this session's investigations (decisions/00025's
Playwright-timing parity test, this entry's original `test_restore.py` worktree
error, and now `test_publisher.py`'s hard-reset error), the common thread is
purely "runs a real git/browser subprocess" + "only ever seen at full ~445-test
suite scale, never in isolation or a single file" — a BOX-LEVEL resource-
contention characteristic under this specific fleet node's peak combined
parallel test load, not a defect isolated to any one file or mechanism.

## What to watch for

- Three independent files now (`test_parity.py`, `test_restore.py`,
  `test_publisher.py`), three different underlying subprocess types
  (Playwright browser automation, `git worktree`, `git reset --hard`/commit) —
  each reproduced ONLY as a rare (~1-in-8 to 1-in-10) full-suite-scale blip,
  NEVER in isolation. Treat a FOURTH such occurrence, in yet another
  git/subprocess-heavy test, as confirming this general pattern rather than a
  new, independent mystery each time — don't re-derive this from scratch.
- Escalate from "known rare full-suite flakiness" to "investigate for real" if:
  (a) the SAME specific test errors twice in a row, (b) any error reproduces
  in isolation even once, or (c) the rate climbs noticeably above what's
  documented here (roughly 1 error per ~8-10 full-suite runs across this
  session's observations).
- The `_worktree_at_sha` cleanup fix (`git worktree prune` on a failed
  `remove`) remains unconditionally correct regardless of whether it was ever
  THE cause of anything — it closes a real "ignored exit code could leave
  dangling metadata" gap on its own merits and should not be reverted.
- If this becomes disruptive (e.g. CI starts flaking), the right fix is
  investigating this Windows box's git-subprocess/Playwright resource
  contention under the project's fixed `-n 4` xdist cap directly (e.g.
  whether antivirus scanning or disk I/O is the bottleneck) — NOT lowering the
  worker cap (global fleet rule) and NOT adding retries/skips to individual
  tests, which would hide the signal rather than address the shared cause.
