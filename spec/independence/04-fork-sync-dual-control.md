# 04 — Fork sync & dual control

Her org's `wixy-engine` fork is production's source of truth; `joshcomley/wixy` is the
dev upstream. Two flows connect them; both are hers to run or refuse.

## 1. The sync workflow (in the fork: `.github/workflows/sync-upstream.yml`)

- Triggers: `workflow_dispatch` (the button) + weekly schedule (Mon 06:00 UTC — a
  gentle default she can disable; NOT daily: updates arrive when chosen, and the
  weekly tick just keeps drift small).
- Steps: fetch upstream → `git merge upstream/main` into fork `main`.
  - **Clean merge** → push → her image rebuilds → Watchtower deploys within minutes.
  - **Conflict** → the workflow opens a PR (`sync/upstream-<date>`) with the conflict
    markers + a plain-English comment ("Josh's version changed the same files as
    yours") — resolvable by her AI lane (05 §3) or left parked; production simply stays
    on her current code. Never force, never auto-resolve.
- The workflow is part of the ENGINE repo (so upstream improvements to the sync flow
  itself reach her the same way), parameterized by `vars.UPSTREAM_REPO`.

## 2. The admin surface (standalone edition only)

Settings → **Engine** card:
- Version now (sha + date), upstream commits-behind count, and the plain-English
  changelog: upstream's `git log fork-main..upstream/main --format=%s` rendered as
  bullets (conventional-commit prefixes translated: `fix:` → "Fixed…", `feat:` →
  "New…" — a tiny formatter, not AI).
- **"Get engine updates"** → triggers `sync-upstream.yml` via the org PAT → progress
  states (checking → merging → building → deploying → done, polled from the workflow
  run + Watchtower's restart) → "You're up to date". Conflict → friendly explanation +
  "ask your assistant to sort it out" pointer.
- Server side: a `github.py` client (fine-grained PAT, workflows + commits read) — new
  admin routes `/api/admin/engine/{status,update}`; the commits-behind check is cached
  (15 min) and NEVER blocks state (separate endpoint, skeleton-loaded card).

## 3. Her feature lane

Same shape as Josh's train, re-homed: her AI backend (05) can be pointed at the ENGINE
fork as well as the site repo — "ask for an editor feature" spawns an agent working in a
clone of `wixy-engine`, PR into the fork, fork CI (inherited: pytest/tsc/vitest — the
same workflows travel with the fork) gates merge, Watchtower deploys. v1 surfaces this
NOT as a chat tab but as the guide's documented flow + the conflict-resolution assistant
(§1) — a full in-admin engine-dev chat rides the existing chat panel with a repo
selector as a later enhancement (noted, not built now: the drill only requires the
PR-path to work end-to-end once, driven by the implementer).

## 4. Divergence policy

Her fork may carry local commits indefinitely (that's the point). To keep merges sane:
upstream promises (documented in the engine README): no history rewrites on main, no
renames of `deploy/standalone/` contract files without a compat shim + changelog note.
Fleet staging runs upstream main, so Josh sees breakage before she can pull it.
