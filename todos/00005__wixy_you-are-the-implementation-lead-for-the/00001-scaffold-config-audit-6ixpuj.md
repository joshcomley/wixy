# 00001 [6ixpuj] M1 — Scaffold + config-generalization audit

## What
- `deploy/standalone/` and `guide/` directory skeletons (empty-ish, real work lands in M3/M8).
- All nine `decisions/` entries from spec/independence/01 §5 (fork-sync dual control,
  Cloudflare Tunnel container, Watchtower deploys, transfer/fork/new-repo split, MIT,
  same image both editions, GHCR public, SYNC_PUSH_TOKEN never GITHUB_TOKEN, notify-only
  schedule).
- Config-generalization audit: env overrides `WIXY_SITE_REPO` (SSH URL), `WIXY_DOMAIN`,
  `WIXY_INDEXABLE`, `WIXY_EDITION` (`fleet|standalone`) layered over `projects/ca.json`.
- `/api/version` gains `edition` + baked `WIXY_ENGINE_SHA`/`WIXY_SYNC_BASE` build-arg envs
  with git fallback (fixes the current 500-on-no-`.git` bug — confirmed real, see below).
- Redirects facility (new) in `routes_public` — file/env-driven 301 map.
- `WIXY_CONTAINERIZED` bind gate: server binds `0.0.0.0` only when set, else stays
  loopback-hardcoded.

## Why
Independence spec 09 milestone 1. Everything downstream (Docker image, standalone edition,
fork sync) needs these config seams to exist first; today `builder/config.py` has zero
env-var override path and `/api/version` (`wixy_server/routes_version.py` ->
`checkout.current_sha`) unconditionally shells `git rev-parse HEAD`, which raises
`CheckoutError` (uncaught -> 500) with no `.git` dir, i.e. inside a pip-installed image.

## Context / current state (ground truth verified 2026-07-19 via Explore agent)
- `builder/config.py:18-71` — `ProjectConfig`/`load_project_config`, JSON-only, no env.
- `wixy_server/settings.py:28-30` — `WIXY_STORAGE_ROOT` is the real existing pattern to
  mirror for the new env vars.
- `wixy_server/__main__.py:27` — `uvicorn.run(app, host="127.0.0.1", ...)` hardcoded.
- `wixy_server/routes_version.py` + `wixy_server/checkout.py:82-87` — the git-shell bug.
- `wixy_server/routes_public.py` (82 lines) — catch-all registered last in `app.py:215`;
  redirects must be inserted before the catch-all, after `/admin`/`/api`/`/internal`.
- `decisions/` next free number: `00051`.

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
CI-gated only (no Fable review) — auto-merge on green. Acceptance: existing test suite
still green; new env overrides covered by unit tests; `/api/version` has a test for the
no-`.git` fallback path; redirects facility has a unit test with a sample map.

## Links
spec/independence/01 §2, §5; spec/independence/09 row 1.
