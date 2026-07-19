# 00004 [ojrybv] M4 — Fork sync workflow + Engine card + rollback + site CI re-point

## What
- `.github/workflows/sync-upstream.yml` (lives in engine repo): workflow_dispatch (the
  button); weekly schedule Mon 06:00 UTC is NOTIFY-ONLY (refreshes commits-behind, opens/
  updates an issue, never merges/deploys). On dispatch: fetch upstream -> merge to work
  branch -> push with dedicated SYNC_PUSH_TOKEN PAT (contents:write), NEVER GITHUB_TOKEN
  (its events don't trigger downstream workflows). Clean merge -> push main -> image build
  fires -> Watchtower deploys. Unconditional conflict-PR path for textual conflicts AND any
  diff touching `.github/workflows/**`. vars.UPSTREAM_REPO parameterized; no-ops in upstream
  repo itself.
- Admin Settings -> Engine card (standalone only): version, commits behind, plain-English
  changelog, "Get engine updates" button -> triggers workflow via org PAT
  (actions:write+contents:read) -> progress polling -> done. Server: `github.py` client,
  routes `/api/admin/engine/{status,update,rollback}` — POST-only, CSRF-safe, behind
  Access+JWT gate.
- Rollback: sync workflow re-tags currently-deployed image `:rollback` before flipping
  `:latest`; "Undo last update" + `update.sh --rollback` pin compose to `:rollback`, hold
  Watchtower via label.
- Site-repo CI re-point (C6, required): site repo's CI currently pins joshcomley/wixy +
  WIXY_DEPLOY_KEY secret — a PR re-points it at her fork (tokenless once public) and
  neutralizes site CLAUDE.md's fleet/Josh-private-repo wording.

## Why
This is the mechanism that makes "updates land only when SHE chooses" real, and the
asymmetry (she can stop syncing, revoke access; he can't take anything from her).

## Context / current state
Depends on M2 (engine public) conceptually but can be built/tested against a fake/local
git remote before the real publish. `/api/admin/engine/*` is new surface alongside the
existing `/api/admin/*` routes (see wixy_server/routes_admin_api.py from M1 exploration).

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
**SECURITY-GATED**: PR -> peer author with checklist 04 §2 (PAT scope minimality, PAT
never logged, no trigger without explicit user action, deploy-trigger routes properly
gated, rollback path proven) -> ScheduleWakeup -> merge only on explicit approval.

## Links
spec/independence/04 (full); spec/independence/01 §3/C6; spec/independence/09 row 4.
