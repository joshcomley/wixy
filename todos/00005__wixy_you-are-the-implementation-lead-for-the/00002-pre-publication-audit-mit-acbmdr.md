# 00002 [acbmdr] M2 — Pre-publication audit + MIT + owner-material move

## What
- `LICENSE` (MIT, Copyright 2026 Josh Comley) + README rewrite (what Wixy is, CA story
  paragraph, quickstart pointer to deploy/standalone/, badge).
- Secrets scan over FULL git history (gitleaks-style). Real secret found -> STOP, consult
  Fable before any history rewrite (architectural call).
- Internal-infra hostnames/ports in docs: accepted, no scrub. Scrub only: full un-truncated
  Access AUD values. Exemption: author-session id in spec/independence/README.md +
  KICKOFF-PROMPT.md stays until M10.
- Owner-material move to NEW private `<org>/ca-business`: `photos/`, `brief.md`,
  `docs/DESIGN-AND-CONTENT.md`, `docs/google-reviews.json`, `docs/booking-platform-comparison.md`,
  `reviews-demo.html`, `advertising/`. `spec/`, `todos/`, `decisions/`, `handover/` STAY.
- Dependency license check (MIT/BSD/Apache-compatible only), listed in the PR.

## Why
Going public is practically irreversible — this is the audit gate before the MIT flip.
Operator confirmed MIT 2026-07-19 (spec/independence/02 §1).

## Context / current state
`ca-business` repo does not exist yet (that's a human/guide step, Track J — the ENGINE-side
work here is just relocating the files out of this repo so they're ready to move). Since
`ca-business` creation is a human GitHub step, the M2 PR's job is: delete/move these paths
out of the wixy repo (to wherever they belong — likely into a sibling location this repo
doesn't publish, or staged for the guide step to paste into the new private repo once she
creates it) — resolve the exact mechanics against reality when coding this milestone.

## Relevant files + commits
`LICENSE` (new), `README.md` (rewrite), `pyproject.toml` (license/authors/readme
fields), `admin-ui/editor/e2e` `package.json` (license field), `spec/README.md` +
`spec/00-mission.md` + `spec/03-site-migration.md` + `spec/KICKOFF-PROMPT.md` +
`tooling/README.md` (dangling-reference fixes from the move), `decisions/00054`
(full audit writeup). Removed: `photos/`, `advertising/`, `brief.md`, `docs/DESIGN-
AND-CONTENT.md`, `docs/google-reviews.json`, `docs/booking-platform-comparison.md`,
`reviews-demo.html`, `tooling/downscale_photos.py` (one addition beyond the spec's
literal list — coupled dead code, reasoning in decisions/00054). Pre-removal
reference SHA: `7c4fa3c02957599bfed994ddb37a93ed293e685f`. gitleaks 8.30.1
(winget-installed) full-history scan: clean, 123 commits. PR: branch
`indep/m2-prepublication-audit` (opened against origin/main directly, NOT stacked
on the still-unmerged M1 branch — disjoint files, no conflict risk).

Blocked on: GitHub Actions CI outage on joshcomley/wixy (every run fails instantly,
0 runner assigned, since 2026-07-19 — looks like a private-repo Actions spend/quota
block). Raised to the operator as decision #12; operator asked for a separate
Fable 5 "plan and delegate" session to investigate+fix, spawned at session
5759e89d-2f58-4bdd-89c9-d0922dfaae9a (workspace 00006). Both this PR and #66/#67
wait on that before CI can even run, let alone go green.

## How to continue + acceptance
**SECURITY-GATED**: open PR -> peer session c42ea1cb-a9d6-413d-bdcb-fc77fc49abba with PR
number + checklist (02 §2) -> ScheduleWakeup -> merge ONLY on explicit "APPROVED — merge".
After merge: Josh's publish click (Track J, human step, NOT this agent) flips visibility.
Acceptance so far: ruff/mypy clean, full pytest suite green (543 passed), frontend
typecheck+test+build green with zero bundle drift — CI itself can't confirm this
independently until the Actions outage above resolves.

## Links
spec/independence/02 (full); spec/independence/09 row 2.
