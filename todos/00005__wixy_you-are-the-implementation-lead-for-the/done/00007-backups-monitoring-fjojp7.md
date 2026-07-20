# 00007 [fjojp7] M7 — Backup snapshot-branch container + monitoring

## What
- `backup` compose container: nightly, copies /data (minus builds/, minus secrets) as a
  plain file tree into a checkout of `<org>/ca-state-backup`, force-pushes a single-commit
  `snapshot` branch (no history growth); 1st-of-month also pushes `monthly/YYYY-MM` tag
  (12 kept, oldest deleted). After push: re-clone shallow + checksum verify.
  Deploy key: write-scoped to ca-state-backup ONLY.
- Hub-side equivalent scheduled job mirrors fleet Storage the same way, starting BEFORE her
  hosting does (backup custody precedes cutover).
- In-admin System card: last backup age (banner if >48h), disk usage, last publish, engine
  version/edition.
- UptimeRobot (her account, guide step, not engine work) — HTTPS + keyword check on
  /api/version.
- Publish failures: drawer (exists) + optional email if SMTP env set.

## Why
Her backup custody must start before her hosting does — this is the "she owns the disaster
recovery path too" piece of independence.

## Context / current state
Restore path (guide Appendix A, fresh droplet + setup.sh + copy snapshot tree into volume)
is a guide (M8) concern once this container exists. Depends on M3's compose skeleton.

**Build — DONE**: `wixy_server/backup/` (settings, snapshot.py's allowlist-driven
stage/orphan-commit/force-push/verify pipeline, status.py, __main__.py's nightly-loop-
or-one-shot entrypoint), `wixy_server/routes_system.py` (System card backend, NOT
edition-gated unlike Engine/AI), admin-ui System tab (api.ts/router.ts/settingsPanel.ts
+ 9 new tests, rebuilt bundle), `docker-compose.yml`'s `backup` service (least-privilege
read-only storage mounts, its own write-only backup-status volume, a dedicated
state-backup deploy key), setup.sh/verify.sh/update.sh extended for the third service,
`docs/ai/contracts.md` updated (also backfilled M6's own missed AI-budget-route entry).
`deploy/hub-mirror/` ships the pre-cutover hub-side mirror script + runbook, NOT yet
installed against real infra (ca-state-backup doesn't exist yet — forward obligation in
the M10 sidecar). Full design writeup + FABLE-light self-verification: decisions/00066.
16 new backend tests (`test_backup_snapshot.py` real-bare-repo, `test_routes_system.py`)
+ 9 new frontend tests, all passing; ruff/mypy/pytest and npm typecheck/test/build all
clean.

## Relevant files + commits
Branch `indep/m7-backups-monitoring` (off main, after M6 merged), PR #79. Two commits:
`a9c68ae` (the full build) and `a2836c4` (a CI-caught test-determinism fix — see
decisions/00066's own Correction section). decisions/00066, decisions/00067
(unrelated incidental fix bundled in the same PR).

## Fable review verdict
**APPROVED — merge**, session `c42ea1cb-a9d6-413d-bdcb-fc77fc49abba`, 2026-07-20,
reviewing commit `a2836c4`. Verified both light-gate items directly in the diff:
(1) the backup service authenticates with its own dedicated `/keys/state-backup`
identity (`IdentitiesOnly`), write-scoped to `ca-state-backup` only, every source
volume mounted `:ro`, its status volume the sole writable surface — "least-privilege
exactly as intended"; (2) `_SNAPSHOT_BRANCH` is a module constant, the module's single
forced push names fully-qualified `refs/heads/snapshot` on BOTH sides of the refspec,
and `TestForcePushTarget` proves `main` byte-identical across a real backup run
against a real seeded bare repo — "testing the property, not the mock." Called out
writing the gate item into the module docstring as "the right touch." Explicitly
noted the two bundled non-review items (decisions/00067; the CI-caught SHA-determinism
fix) as "appropriately flagged," and the honest CI-round-trip writeup as "exactly the
discipline this train has made habitual." Confirmed this closes **all five security
gates** (M2/M3/M4/M6/M7) for the independence phase.

**DONE — merged PR #79** (2026-07-20, merge commit `177430d`). Remote branch deleted
via `--delete-branch`; local worktree moved on to `indep/m8-html-guide` off the fresh
`origin/main`.

## How to continue + acceptance
**FABLE-LIGHT**: PR -> peer author, but checklist scope is narrow (key-scope + force-push-
target verification only, per 09 row 7) -> ScheduleWakeup -> merge only on explicit approval.

## Links
spec/independence/06 (full); spec/independence/09 row 7.
