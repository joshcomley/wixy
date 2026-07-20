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

**FORWARD OBLIGATION (from M6's Fable gate review, PR #76 R2, 2026-07-20,
decisions/00065's "Correction (Fable review, PR #76 R1+R2)")**: Track P.2
(GitHub account + organisation chapter) MUST include an illustrated step for
turning on **branch protection on `main`** — require a pull request + a
passing required status check, no bypass actors — on BOTH her site repo and
her engine fork. `deploy/standalone/setup.sh` already pauses for this (a bare
`print_branch_protection_step` prompt, no screenshots, linking
`<repo>/settings/branches`) so the stack can't be started without it being
at least confirmed — the guide's job is the friendly, screenshotted version
of that same step, placed where she'll actually reach it BEFORE the droplet
setup chapter (P.6), matching spec/independence/07 §2's own chapter
ordering. Explain WHY in one sentence (per 07 §1's voice rules): this is what
stops even a leaked AI-assistant credential from ever being able to push
straight to her live site's source.

**Build — DONE**: `guide/` package (`manifest.py` single-source-of-truth chapter list,
`build.py` chrome-template injection + nav/prev-next generation, `linkcheck.py` live
external-link checker with retry, `__main__.py` CLI, `templates/chrome.html`,
`assets/guide.{css,js}`), all 13 chapters with real content (`start-here`, `track-j`,
`track-p-1`..`track-p-8`, `appendix-a`..`appendix-c`), `wixy_server/app.py`'s dedicated
`/admin/guide` `StaticFiles` mount (CF-Access-gated automatically), `.github/workflows/
ci.yml`'s new `guide-linkcheck` job. Both forward obligations (M2 ca-business population
in `track-j.html`; M6/R2 branch protection in `track-p-2-github.html`) verified present.
Three real cross-chapter gaps found and closed during integration (`ca-state-backup`
repo creation never had a home; Appendix C's Josh-revocation promise had nothing granting
GitHub-org/Anthropic access to revoke; chapter 7's temporary test hostname would have
left `/admin` unauthenticated) — full writeup in decisions/00068. `joshcomley/wixy`
flipped public (operator-confirmed) to satisfy the one real external link the guide's
fork step needs; re-ran a full-history + working-tree gitleaks scan first (clean) rather
than trust the M2-era scan. 24 `guide/tests` + 5 `test_guide_route.py` + 1 auth-gate
test + full existing suite: 780 passed. `ruff check`/`ruff format --check`/`mypy`/`pytest`
all clean.

## Relevant files + commits
Branch `indep/m8-html-guide` (off main, after M7 merged). decisions/00068.

## How to continue + acceptance
CI-gated (drill validates) — auto-merge on green linkcheck+build. Real acceptance test is
M9's drill following it verbatim.

## Links
spec/independence/07 (full); spec/independence/09 row 8.
