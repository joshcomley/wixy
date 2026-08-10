# 00004 [y4uqll] wixy: publisher.py mirror push at end of swap stage

## What
In `wixy_server/publisher.py`, at the END of the swapping stage — after `save_live_pointer` →
`append_ledger` → overlay clear → `_prune_builds`, BEFORE `job.stage = "done"` — call
`push_live_mirror(paths.repo, sha)`. On `False`, append a WARNING line to the publish job log
(same idiom as the existing smoke-check warning). Must NEVER change the job's success/failure
— mirror-push failure is advisory only, self-heals on the next publish/restore.

## Why
Materializes "what's live" into the site repo so the Pages workflow can deploy exactly that,
without depending on the server being reachable at deploy time.

## Context / current state
Not started. Swap stage is around line ~192-206 in `publisher.py` per the brief's verified
line references (re-check exact lines when editing — file may have shifted).

## Files
- `wixy_server/publisher.py`

## How to continue + acceptance
Depends on [[00003]] existing. Verify via [[00006]]'s bare-origin tests: after a successful
publish, `refs/heads/wixy-live` on the bare origin equals the new live sha, for both a normal
publish and a pure-upstream (no new commit) publish.

## Links
Brief §4D. Sibling: [[00005]] (restore side).
