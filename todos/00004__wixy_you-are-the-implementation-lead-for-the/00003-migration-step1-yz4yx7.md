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
PR: (fill in when opened)
