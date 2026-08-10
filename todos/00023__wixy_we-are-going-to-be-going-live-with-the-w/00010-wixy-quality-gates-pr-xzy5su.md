# 00010 [xzy5su] wixy: quality gates (ruff/mypy/pytest) + push + PR

## What
`ruff check .`, `ruff format .`, `mypy` (strict), bare `pytest` (full suite, `-n 4` fixed cap
— NEVER `-n auto`) all green. Do NOT touch `admin-ui/`/`editor/` (no bundle rebuild needed for
this change). Branch `feat/github-pages-go-live` off `main`. Conventional-commit messages,
EACH with a `Release-note:` trailer (plain English, e.g. "Release-note: Your website can now
go live on your own web address, updated automatically whenever you press Publish."). Push,
`gh pr create` (via PowerShell full path per the gh-stdout-swallowing gotcha), wait required
checks (`python`, `release-note`, `guide-linkcheck`, `frontend`, `image-boot-proof`).

## Why
Repo CI gates + fleet doctrine (never `-n auto`, Release-note trailer mandatory or CI's
`release-note` job fails).

## Context / current state
Not started. Depends on [[00001]] through [[00009]] all being implemented.

## Files
Whole wixy repo diff for this feature.

## How to continue + acceptance
Green CI on the PR. Do NOT merge — this PR is not one of the security-gated independence
milestones (2/3/4/6/7), but the brief's operating contract still requires planner FINAL
HANDOFF CLEARED before ANY merge in this workstream. See [[00015]].

## Links
Brief §4 intro (quality gates), §8 (operating contract — no merge without clearance).
