# Common rules for every Cookout module (read with your module brief)

- Authority: `spec/server-chat/09-cookout.md` (frozen; on the feature branch `cmd/workspace-00058`).
  Where it contradicts the code, prefer the code and tell me (the orchestrator) — do not improvise.
  `triad/cookout/ruling.md` explains why. Parcel names: the spec's Appendix A calls the parcels
  P1–P5; the workspace task list calls them P2–P6 (bank, server, AI+pictures, UI, docs/e2e). Your brief
  names both.
- Repo rules: `CLAUDE.md`. Strict mypy on `builder/` + `wixy_server/`, ruff check + `ruff format --check .`
  (it also formats Python blocks inside .md files), bare `pytest` (the `-n 4` cap is in addopts — never
  `-n auto`), strict TS. Frontend bundles are committed — run `npm run build` in `admin-ui/` after any
  `admin-ui/src` change and commit the output; make files LF first.
- **Every commit message ends with exactly `Release-note: General bug fixes and improvements.`**
  (Server-chat discretion rule R14a: never name the chat or the game in a trailer).
- Never call the Anthropic API; all AI goes through `wixy_server/cmdchat.py`.
- Stay inside your module's file ownership (spec Appendix A). Need a file you do not own: ask me.
- Your build space is a worktree on a build branch cut from `cmd/workspace-00058`. First:
  `git fetch origin && git merge origin/cmd/workspace-00058 --no-edit`. Your PR targets
  `cmd/workspace-00058`, never `main`.
- Gate: when done and locally green, send me `FINAL HANDOFF` (≤600 chars: session id, build branch,
  base SHA, exact candidate SHA, files changed, verification summary, deviations). Open + merge your PR
  only after I reply `FINAL HANDOFF CLEARED` for that exact SHA. If CI fails only because the feature
  branch moved, merge `origin/cmd/workspace-00058` (no other change) — that keeps the clearance.
- Report progress with the `lane-monitor` check-in calls. Stuck, or the brief does not hold: send me a
  `BLOCKER` (what, what you tried, what you need) and wait.
- Design questions → the Architect (`ask-architect` skill); scope questions → me.
- **Never edit `.git/info/exclude`.** `git rev-parse --git-path info/exclude` resolves to the ONE file
  shared by every worktree of this clone, so an entry there hides that file from every other builder
  (measured 2026-10-28/29: twice it hid a real module another parcel had to commit). Keep any test
  stand-in under `wixy_server/tests/` (never at the real module's path) and check before each handoff
  that `git ls-tree -r HEAD --name-only` lists every file you created.
