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

Site-repo CI re-point (C6): **code DONE, PR #17 opened, BLOCKED on an unrelated
pre-existing issue** against `joshcomley/cottage-aesthetics-preview` (new worktree
`cottage-aesthetics-preview__worktrees/00003__site-ci-repoint-claude-md-neutralize`,
branch `indep/site-ci-repoint-and-claude-md-neutralize` off a freshly-fetched
`origin/main` — the old clone at the repo root was confirmed stale, primary-checkout
guarded, so a proper worktree was created rather than editing it in place).
`ci.yml`'s wixy-engine checkout now reads `${{ vars.WIXY_ENGINE_REPO ||
'joshcomley/wixy' }}`. First attempt dropped the deploy key outright and broke CI —
self-caught: `joshcomley/wixy` is still PRIVATE (the M2 LICENSE/audit work landed, but
the actual GitHub visibility flip is Josh's own separate manual click, not yet done).
Fixed properly: `ssh-key` is now supplied only when `WIXY_ENGINE_REPO` is unset (the
upstream case) — a deploy key is scoped to the one repo it was issued against, so
unconditionally keeping it would have ALSO broken the fork-pointing case once someone
sets `WIXY_ENGINE_REPO` to their own (public) fork. `CLAUDE.md`/`README.md`'s "private
repo"/fleet-auto-merge wording removed (this part is accurate regardless of visibility
— it's a licensing fact, not a visibility claim).

**Found separately, NOT caused by this PR**: the site repo's `main` CI (rendered-parity
check) has been red since 2026-07-19 15:53 — confirmed via `gh run list --branch main`
history, predates any of today's work. The About page's "Meet Purdi" bio was shortened
via a real Wixy CMS publish (`wixy: publish v7`) but the parity baseline (lives in the
wixy ENGINE repo at `wixy/builder/tests/parity/baseline`, checked out fresh into
site-repo CI) was never re-captured to match. This is a live-site CONTENT question
(intentional edit vs. needs reverting) outside my delegated scope (kickoff prompt:
never touch her real content) — raised as operator decision #19, delayed mode.
**Operator answered: "the new short bio is correct"** — triggered
`capture-baseline.yml` (workflow_dispatch, `ca_ref=402e8eb209ff9cce10a3ea89a1a7b5e39ae13be9`
= cottage-aesthetics-preview's current main HEAD) to recapture against it; run
https://github.com/joshcomley/wixy/actions/runs/29703707753, watching for completion.
Once it lands (a direct commit+push to wixy's own `main`, per that workflow's own
established design — no PR, it's the accepted mechanism for baseline recapture
specifically), PR #17's CI should go green on its next run.

**PR #74 (engine repo, this milestone's main deliverable): all CI green** (python/
frontend/image-boot-proof/e2e), also added `docs/ai/contracts.md`'s `/api/admin/
engine/*` route table entry + fixed the documented router-include order (anti-drift
rule in that file's own header — a new public surface updates it in the same PR).
**Fable review request sent** — verdict: **CHANGES REQUIRED, 2 items** (both small,
rest of the PR explicitly praised — injection-safe changelog construction, retag-
before-push ordering, PAT-authenticated conflict-PRs so CI runs on them, notify job
correctly on GITHUB_TOKEN, edition-404, shared-client DI, hermetic tests all called
out as right):
- **R1 (CSRF)**: `update`/`rollback` took no body, making them the only admin
  mutations a cross-site form POST could fire (forms can't send
  `application/json`). Fixed: `_require_json_content_type()` guard, 415 otherwise,
  both routes + both success-path tests updated + 2 new 415 tests + frontend
  `api.ts` now sends the header + `docs/ai/contracts.md` updated.
- **R2 (PAT scope)**: `SYNC_PUSH_TOKEN` needs `contents:write` + `pull_requests:write`
  — `gh pr create` in the conflict-PR step needs the latter or it 403s exactly
  when the review-PR mechanism matters most. This was spec/independence/04 §1's
  OWN under-specification ("(contents:write on the fork)"), not a misreading —
  Fable is amending the spec line; `sync-upstream.yml`'s comment + decisions/00057
  corrected here.

R1+R2 pushed (commit 247ea70), CI green again, delta-only re-review requested per
Fable's own preference.

**APPROVED — merge.** Fable verified the deltas directly (guard present in both
handlers with 415 semantics, tests assert both the 415 AND the GitHub client is
never reached, api.ts sends the header on both triggers, bundles rebuilt,
contracts.md carries the 415, workflow header + decisions/00057 state the corrected
PAT scope) — scope was exactly the delta files, no creep. Spec correction merged
upstream too (spec/independence/04 §1 now reads `contents:write +
pull_requests:write`, PR #75, Fable's own action).

## DONE — merged PR #74 (2026-07-19, commit 625c3e7).

## How to continue + acceptance
**SECURITY-GATED. PR #74 opened** (engine repo, `indep/m4-fork-sync-engine-card` ->
`main`) — full ruff/mypy/pytest (606 passed) + tsc/vitest (381 passed) green locally,
CI running. Site-repo PR #17 CI running too, not itself gated on #74's review
— not a blocker on #74's own review since it's a different repository. Next: PR ->
peer author with checklist 04 §2 (PAT scope minimality, PAT never
logged, no trigger without explicit user action, deploy-trigger routes properly
gated, rollback path proven) -> ScheduleWakeup -> merge only on explicit approval.

## Links
spec/independence/04 (full); spec/independence/01 §3/C6; spec/independence/09 row 4.
