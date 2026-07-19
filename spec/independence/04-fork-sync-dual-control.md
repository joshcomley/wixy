# 04 — Fork sync & dual control (SECURITY-GATED milestone)

Her fork is production's source of truth; `joshcomley/wixy` is the dev upstream.
Updates reach her ONLY when she asks (01 §5 d9).

## 1. The sync workflow (`.github/workflows/sync-upstream.yml`, lives in the engine)

- Triggers: `workflow_dispatch` (the button). The weekly schedule (Mon 06:00 UTC)
  is **notify-only**: it refreshes the commits-behind data (and opens/updates a
  "updates available" issue) — it NEVER merges or deploys.
- On dispatch: fetch upstream → merge into a work branch → **push with the dedicated
  `SYNC_PUSH_TOKEN` fine-grained PAT secret** (contents:write on the fork) — never
  `GITHUB_TOKEN`, whose events trigger no downstream workflows (the image build would
  silently never run; conflict PRs would get no CI). Clean merge → push to `main` →
  image build fires → Watchtower deploys within minutes.
- **Unconditional conflict-PR path** for: any textual conflict, AND any sync whose
  diff touches `.github/workflows/**` (workflow changes run with access to her
  secrets — a human/agent eye is mandatory even when the merge is clean). The PR gets
  a plain-English comment; production stays on current code until it's resolved
  (her AI lane can do it — 05).
- `vars.UPSTREAM_REPO` parameterizes it; in the upstream repo itself the workflow
  no-ops cleanly (guard step) so shipping it there is harmless.
- Fork housekeeping the guide covers (M5 findings): forks have **Actions disabled**
  until enabled and **schedules disabled by default** — two explicit guide steps; org
  settings must permit fine-grained PATs.

## 2. The admin surface (standalone edition only)

Settings → **Engine** card: version now (from `/api/version`'s baked SHA), commits
behind, plain-English changelog (`git log`-derived subjects, conventional-commit
prefixes translated); **"Get engine updates"** → triggers the workflow via the org PAT
(`actions:write + contents:read`) → progress (checking → merging → building →
deploying → done, polled from the run + the deployed version change) → "You're up to
date". Conflict → friendly explanation + assistant pointer. Server: `github.py`
client; routes `/api/admin/engine/{status,update,rollback}`; commits-behind cached
15 min, never blocking state. These routes DEPLOY PRODUCTION CODE — they sit behind
the same Access+JWT gate as everything `/api/admin`, are POST-only with the shell's
CSRF-safe fetch conventions, and are part of this milestone's Fable review checklist
(PAT scope minimality, PAT never logged, no trigger without explicit user action).

## 3. Engine-update ROLLBACK (hers, one tap)

Before flipping `:latest`, the sync workflow re-tags the currently-deployed image
`:rollback`. "Undo last update" (Engine card) + `update.sh --rollback` pin the compose
service to `:rollback` (and hold Watchtower via label until she updates again). The
drill exercises this (08 §1). This is the answer to "an update broke my site" without
Josh.

## 4. Her feature lane

Same shape as Josh's train, re-homed: her AI backend (05) works a clone of
`wixy-engine`, PRs into the fork, fork CI (enabled per §1) gates, her button/Watchtower
deploys. v1 surfaces it via the documented flow + the conflict assistant; the drill
proves the PR path end-to-end once (08 §1). A full in-admin engine-dev chat tab is a
noted later enhancement.

## 5. Divergence policy

Her fork may diverge indefinitely. Upstream promises (engine README): no main history
rewrites; no renames of `deploy/standalone/` contract files without a compat shim +
changelog note. Upstream CI boots the image per merge (03 §5), so container breakage
is Josh's to see before she can pull it.
