# 00003 [yz4yx7] M3 CA — Migration step 1

## What
Move pages under `pages/`, add partial markers, empty-shim partials; capture parity
baseline via the pinned-platform CI job; site CI (`ci.yml` calling WX builder@main —
wixy is PRIVATE: provision read-only deploy key + `WIXY_DEPLOY_KEY` secret); rewrite
`deploy.yml` to publish the BUILT output (root-relative Pages deploy would 404 all
through migration otherwise).

## Why
First site-repo PR — establishes the parity harness as safety net for all later CA
migration work. Must never leave the site repo in a state the builder can't build.

## Context / current state
Happens in a worktree of `cottage-aesthetics-preview`, NOT this repo, NOT the canonical
CA clone. Create under
`D:\Servers\Cmd\Storage\clones\cottage-aesthetics-preview__worktrees\<NNNNN>__<slug>`.
Depends on 00002 (builder v1) being usable (editable install / PYTHONPATH per work-plan
note).

## Relevant files
- spec/03-site-migration.md §1-3 (current state, target layout, step 1 detail), §5
  (parity harness spec), §7 (CI + deploy key)

## How to continue + acceptance
Deploy key: `gh api repos/joshcomley/wixy/keys -f title=ca-ci -f key=… -F
read_only=true`, private half as CA secret `WIXY_DEPLOY_KEY`. Parity baseline captured
on ubuntu-latest pinned Playwright, committed to builder/tests/parity/baseline/ (in WX
repo per spec, captured against CA fixtures). Parity green + validate green.

## Links
- wixy PR #13 (parity harness, milestone-3a) — merged
- wixy PR #14 (capture-baseline.yml workflow, milestone-3c) — merged
- wixy PR #15 (fetch-depth:0 checkout fix, milestone-3d) — merged
- wixy PR #16 (short-SHA checkout fix, milestone-3e) — merged
- wixy PR #17 (reduced-motion parity fix, milestone-3f) — merged; superseded as primary
  cause by #18 (decisions/00005, decisions/00006)
- wixy PR #18 (force-reveal parity fix, milestone-3g — the actual root cause of the
  gallery screenshot flake) — merged
- CA repo PR #1 (`milestone-3-migration-step1`) — merged

## Outcome
All 9 pages moved under `pages/` with partial markers; empty partial shims; parity
harness landed with a baseline correctly captured on ubuntu-latest (after two real
bugs found and fixed: `actions/checkout` can't resolve an abbreviated SHA, and the
capture harness wasn't forcing `.reveal` sections visible, causing a large
non-deterministic-looking screenshot diff on the gallery page specifically —
decisions/00002 through 00006 record the full trail). `deploy.yml` rewritten to
publish the wixy-built output; `ci.yml` added with the required `validate-build-parity`
check; branch protection configured. CA PR #1 fully green (text/link/image/style/
screenshots) and merged.
