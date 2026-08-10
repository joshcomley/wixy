# 00005 [4c204c] wixy: restore.py mirror push after live pointer flip

## What
In `wixy_server/restore.py:run_restore`, after `save_live_pointer` + `append_ledger` (~line
185-195 per brief's verified refs — recheck when editing): call
`push_live_mirror(paths.repo, entry.sha)`. On failure, `logger.warning(...)` (restore has no
job log, unlike publish). Restore result/success is unaffected by mirror-push failure.

## Why
A restore flips the live pointer WITHOUT any git commit — the mirror ref must still move
(force-push, since it can go backwards to an older sha) so Pages deploys the restored content.

## Context / current state
Not started. This is the path that exercises `push_live_mirror`'s `--force` requirement for
real (non-fast-forward move backwards).

## Files
- `wixy_server/restore.py`

## How to continue + acceptance
Depends on [[00003]]. Verify via [[00006]]: after a restore, `wixy-live` on the bare origin
equals the restored (older) sha.

## Links
Brief §4E. Sibling: [[00004]] (publish side). Known accepted edge (document, don't fix): a
restore to a sha predating the pages.yml workflow file moves wixy-live but triggers no Pages
run — documented in [[00007]]'s runbook update, not a bug to solve here.
