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
Branch: `indep/m4-fork-sync-engine-card` (stacked on M1, now synced through M2/M3/M5
having landed on main). Backend: `wixy_server/github.py` (new — `GitHubClient`,
retry-on-TransportError-only matching `cmdchat.py`'s own convention),
`wixy_server/routes_engine.py` (new — `/api/admin/engine/{status,update,rollback}`,
`EngineStatusCache`, 15min TTL), `wixy_server/app.py` (`github_client` DI param,
shared `app.state.github_client` — same shape as `cmdchat_client`, NOT constructed
per-request; see decisions/00057 decision 2), `wixy_server/settings.py`
(`WIXY_ENGINE_REPO`/`WIXY_ENGINE_UPSTREAM`/`WIXY_ENGINE_PAT`), `wixy_server/
routes_version.py` (`resolve_engine_sha` made public, reused by the Engine card's
`currentSha`). Tests: `wixy_server/tests/{fake_github.py,test_github.py,
test_routes_engine.py}` (21 tests, hermetic `httpx.ASGITransport`). Workflow:
`.github/workflows/sync-upstream.yml` (new — guard/notify/sync/rollback jobs; see
decisions/00057 decisions 1/3/4 for the rollback mechanism, the conflict-PR design,
and a YAML-authoring bug caught by validating before pushing). Frontend: `admin-ui/
src/{router.ts,api.ts,settingsPanel.ts,shell.ts}` (Engine settings tab — always
visible, degrades gracefully on a 404/fleet edition rather than being conditionally
hidden; see decisions/00057 decision 5), `admin-ui/tests/settingsPanel.test.ts`
(+13 tests incl. fake-timer poll-loop coverage), rebuilt `wixy_server/static/admin/
admin.js`. decisions/00057 (this milestone's implementation calls), decisions/00058
(a separate, cross-cutting incident hit while merging M3/M5's PRs — GitHub
auto-closes a PR when its base branch is deleted rather than retargeting it; not
M4-specific but discovered during this milestone's work).

Site-repo CI re-point (C6) is a genuinely SEPARATE PR against a DIFFERENT repo
(the site checkout, not this engine) — not started yet. The local clone at
`D:\Servers\Cmd\Storage\clones\cottage-aesthetics-preview` was confirmed stale
earlier this session (pre-migration working tree); needs a fresh `git fetch origin`
+ checkout of `origin/main` before touching its `.github/workflows/ci.yml` (currently
pins `joshcomley/wixy` + `secrets.WIXY_DEPLOY_KEY`) or its `CLAUDE.md` (currently says
"private repo `joshcomley/wixy`" + cites fleet auto-merge rules that don't apply to
her independent deployment).

## How to continue + acceptance
**SECURITY-GATED**: full ruff/mypy/pytest (backend) + tsc/vitest (frontend) green.
Still needed before opening the PR: the site-repo CI re-point (separate PR, above).
Then: PR -> peer author with checklist 04 §2 (PAT scope minimality, PAT never
logged, no trigger without explicit user action, deploy-trigger routes properly
gated, rollback path proven) -> ScheduleWakeup -> merge only on explicit approval.

## Links
spec/independence/04 (full); spec/independence/01 §3/C6; spec/independence/09 row 4.
