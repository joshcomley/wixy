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
(fill in as PR lands)

## How to continue + acceptance
**SECURITY-GATED**: open PR -> peer session c42ea1cb-a9d6-413d-bdcb-fc77fc49abba with PR
number + checklist (02 §2) -> ScheduleWakeup -> merge ONLY on explicit "APPROVED — merge".
After merge: Josh's publish click (Track J, human step, NOT this agent) flips visibility.

## Links
spec/independence/02 (full); spec/independence/09 row 2.
