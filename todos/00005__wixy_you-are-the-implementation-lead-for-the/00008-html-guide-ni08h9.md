# 00008 [ni08h9] M8 — The HTML guide (flagship deliverable)

## What
Self-contained static HTML site, `guide/` in the engine repo, served at `/admin/guide/`
(Access-gated) AND buildable standalone (plain HTML/CSS, zero JS frameworks, images
inlined/local, printable). Structure: Start here, Track J (Josh's ~1h: publish engine,
provision drill kit, pre-cutover backup, site-repo transfer + ca-business creation, DNS
TTL lower, final DNS flip), Track P (Purdi's 8 chapters: password manager, GitHub org+fork,
DigitalOcean droplet, Cloudflare+Zero Trust+tunnel+Access, Anthropic key+budget, droplet
setup via curl|bash one-liner, the drill, go-live), Appendix A (if Josh disappears),
Appendix B (costs), Appendix C (revoking access). Voice: smart/busy/non-technical reader,
one action per step, copy-paste blocks with copy buttons, "you know it worked when..."
lines, British English. `guide-linkcheck` CI job verifies every external URL live at build
time. Screenshots captured via headed browser during real (or drill-kit) account-creation
dry-runs.

## Why
THE flagship deliverable per spec/independence/README — the guide IS the drill script;
"the guide worked as written" is an acceptance criterion, not an aspiration.

## Context / current state
Depends on M1-M7 all existing (the guide documents real buttons/scripts/cards). Screenshots
iterate with M9 (drill) — expected loop per 09 notes, not a blocker to landing M8's CI-gated
skeleton+content first.

**FORWARD OBLIGATION (from M2's Fable review, PR #68, 2026-07-19)**: the Track J
`ca-business` creation step MUST include the actual population procedure —
`git checkout 7c4fa3c02957599bfed994ddb37a93ed293e685f -- photos/ advertising/
brief.md docs/DESIGN-AND-CONTENT.md docs/google-reviews.json docs/booking-platform-
comparison.md reviews-demo.html tooling/downscale_photos.py` (or equivalent per-path
`git show`/`git checkout`) — as an EXECUTED guide step with its own "you know it
worked when…" line, not just a footnote referencing the SHA. This is how the owner
material actually gets INTO the new private `ca-business` repo once she creates it;
without this step the guide would tell her to create an empty repo and never explain
how the moved content gets there.

## Relevant files + commits
(fill in as PR lands)

## How to continue + acceptance
CI-gated (drill validates) — auto-merge on green linkcheck+build. Real acceptance test is
M9's drill following it verbatim.

## Links
spec/independence/07 (full); spec/independence/09 row 8.
