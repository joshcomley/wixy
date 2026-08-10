# 00006 [3rbod2] wixy: tests — publisher/restore mirror push (bare-origin fixture)

## What
Extend `wixy_server/tests/test_publisher.py` and `test_restore.py` using the EXISTING genuine
`bare_origin` fixture (a real local bare repo pushed to) — don't invent a new harness:
1. After a successful publish, `git -C <bare> rev-parse refs/heads/wixy-live` == the new live
   sha. Cover both a normal publish and a pure-upstream (no new commit) publish.
2. Mirror-failure tolerance: force `push_live_mirror` to fail (monkeypatch it, or break the
   origin ref path) → publish still completes with `job.stage == "done"` and the warning line
   present in the job log.
3. After a restore, `wixy-live` == the restored (older) sha — exercises the force/non-
   fast-forward path for real against the bare origin.

## Why
Bug fixes/new behavior need red→green proof per fleet test doctrine; this is genuinely new
behavior (not a bug fix) but still needs the assertions to exist before calling it done.

## Context / current state
Not started. Depends on [[00003]], [[00004]], [[00005]] all being implemented first.

## Files
- `wixy_server/tests/test_publisher.py`
- `wixy_server/tests/test_restore.py`

## How to continue + acceptance
Run via bare `pytest` (never `-n auto`, Inv 15). All new + existing tests green.

## Links
Brief §4F.
