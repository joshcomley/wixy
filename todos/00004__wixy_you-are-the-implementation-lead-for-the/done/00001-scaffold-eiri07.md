# 00001 [eiri07] M1 WX — Scaffold

## What
Create the wixy repo skeleton: `pyproject.toml` (py3.14; fastapi/uvicorn/httpx/pillow/
bs4+html5lib/nh3/PyJWT+cryptography/pytest+xdist/mypy/ruff), `builder/` + `wixy_server/`
package skeletons, `admin-ui/` + `editor/` TS workspaces (strict tsconfig, esbuild scripts,
vitest), CI (`ci.yml`: ruff+mypy+pytest with fixed `-n` cap+tsc+esbuild+bundle-drift
check+vitest+playwright), repo `CLAUDE.md`, `decisions/00001` (architecture, from spec
01 §3).

## Why
First milestone of spec/09-work-plan.md. Nothing else can build until the package
skeletons + CI exist. This repo currently has zero engine code (only spec/docs).

## Context / current state
Not started. Repo has spec/, docs/, brief.md, tooling/ (bookings scripts, unrelated to
engine), todos/, photos/ — no builder/wixy_server/admin-ui/editor code yet.

## Relevant files
- spec/01-architecture.md (component inventory §4, decisions §3)
- spec/04-server.md (repo layout)
- spec/08-testing-acceptance.md (quality bars: mypy --strict, ruff, xdist -n 4 never auto)

## How to continue + acceptance
Branch off main, scaffold per spec, CI green, PR merged. Acceptance: `pytest`/`mypy`/
`ruff`/`tsc`/`esbuild` all runnable and green (even if trivial/empty test suites at this
stage), decisions/00001 committed.

## Links
PR: https://github.com/joshcomley/wixy/pull/8 (merged 2026-07-08) — all CI green
(ruff, ruff format, mypy --strict, pytest -n4, tsc, vitest, esbuild, bundle-drift,
playwright).
