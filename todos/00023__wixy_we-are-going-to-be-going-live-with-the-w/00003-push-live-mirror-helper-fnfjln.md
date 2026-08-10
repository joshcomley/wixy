# 00003 [fnfjln] wixy: checkout.py push_live_mirror() helper (wixy-live ref)

## What
In `wixy_server/checkout.py`: `LIVE_MIRROR_REF = "wixy-live"` and
`push_live_mirror(repo: Path, sha: str) -> bool`, implemented as
`run_git(["push", "--force", "origin", f"{sha}:refs/heads/{LIVE_MIRROR_REF}"], cwd=repo)`,
retry once on failure, return success bool. **Never raises.** Force is required — restores
move the ref backwards (non-fast-forward).

## Why
This ref is how the GitHub Pages workflow knows "what is actually live" without deploying
site-repo `main` HEAD directly (which would ship agent-merged, un-published content — breaks
the owner's Publish gate). Only the wixy server ever writes this ref.

## Context / current state
Not started. `run_git` already exists in `checkout.py` — reuse it, don't reinvent.

## Files
- `wixy_server/checkout.py`

## How to continue + acceptance
Implement as a pure helper first (no caller yet) — [[00004]] and [[00005]] wire it in. Unit-
testable in isolation against a bare-origin fixture (see [[00006]]).

## Links
Brief §4C. Consumed by [[00004]] (publisher) and [[00005]] (restore).
