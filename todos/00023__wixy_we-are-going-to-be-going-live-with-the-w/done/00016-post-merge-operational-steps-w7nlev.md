# 00016 [w7nlev] post-merge: §7 operational steps

## What
Domain resolved: **`cottageaesthetics.co.uk`** (operator answer via planner) — use this
literal value for `WIXY_PUBLIC_DOMAIN`, not the brief's `thedomain.com` placeholder.

ONLY after FINAL HANDOFF CLEARED ([[00015]]) and both PRs merged (wixy first, then site
repo): (1) set/patch repo variable `WIXY_PUBLIC_DOMAIN=cottageaesthetics.co.uk` via `gh api`
(PowerShell full path);
(2) re-read `D:\Servers\Wixy\Storage\projects\ca\live.json` for current live sha S (read-only
— never edit anything under D:\Servers\Wixy); (3) bootstrap mirror:
`git push origin S:refs/heads/wixy-live` from the site-repo clone; (4) manual dispatch
(`gh workflow run pages.yml --ref main -R joshcomley/cottage-aesthetics-preview`) since the
bootstrap sha predates the workflow file — no auto-trigger, expected; watch until green; (5)
verify deployment at the github.io URL (content matches the build dir, robots.txt, sitemap.xml,
canonical link, styled 404); (6) production health — Slots auto-deploys wixy main, then run
the `verify` skill against ca.cinnamons.uk, confirm canonical tag present there too (still
noindex); (7) do NOT trigger an owner Publish — say so explicitly in the report; (8) record
Q&A in cmd's Answers log via the `answers` skill (verbatim question, answer-first, status
ANSWERED, link the guide's raw URL); (9) mark these todos DONE.

## Why
This is the actual go-live + verification + the mandatory operator-facing answer record (the
fleet's "answer the question" doctrine — work shipping isn't the same as the answer being
written down).

## Context / current state
Not started. BLOCKED on [[00015]] clearance + both merges.

## Files
N/A (operational/verification steps).

## How to continue + acceptance
Ends with a mandatory POST-RELEASE DONE REPORT to the planner's parent endpoint (session id,
PR numbers/merge commits, verification commands/outcomes, observable release evidence,
deviations, every recorded medium/low finding) — see brief §8 "Merge, release, and DONE".
Final report to the OPERATOR must include: guide raw URL
(`https://cmd.cinnamons.uk/api/fs/raw?cwd=<encoded worktree path>&path=docs%2Fgo-live-github-pages.html`),
repo path, Pages URL, both PR URLs.

## Links
Brief §7 (full step list), §8 (post-clearance merge + DONE report contract).
