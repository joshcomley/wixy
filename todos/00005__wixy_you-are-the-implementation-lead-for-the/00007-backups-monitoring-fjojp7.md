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
Branch `indep/m7-backups-monitoring` (off main, after M6 merged). decisions/00066.

## How to continue + acceptance
**FABLE-LIGHT**: PR -> peer author, but checklist scope is narrow (key-scope + force-push-
target verification only, per 09 row 7) -> ScheduleWakeup -> merge only on explicit approval.

## Links
spec/independence/06 (full); spec/independence/09 row 7.
