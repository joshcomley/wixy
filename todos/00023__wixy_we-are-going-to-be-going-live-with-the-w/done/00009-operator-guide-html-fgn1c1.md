# 00009 [fgn1c1] wixy: docs/go-live-github-pages.html operator guide

## What
Self-contained HTML file (inline CSS, no external assets/JS, printable, plain British
English) for Josh: exact click-path for (1) GitHub repo-variable + Pages custom-domain setup,
(2) Name.com DNS records (A/AAAA/CNAME, with explicit "delete conflicting records first"
caveat), (3) HTTPS enforcement + optional domain verification TXT record, (4) end-to-end
checks, (5) troubleshooting table, (6) "nothing to maintain afterwards" note. Full content
spec is brief §6 (7 numbered sections) — treat that as authoritative; don't improvise
structure.

**Domain resolved (operator answer, planner forwarded mid-flight):** real domain is
**`cottageaesthetics.co.uk`** — write it literally throughout the guide, NOT the brief's
`thedomain.com` placeholder. Per the planner's explicit instruction: drop the `<mark>`
placeholder-callout mechanism entirely; replace with a single one-line note near the top that
the guide is written specifically for `cottageaesthetics.co.uk`. Keep the `www` CNAME target
`joshcomley.github.io` and the TXT verification host `_github-pages-challenge-joshcomley`
unchanged (those are GitHub-side constants, not the operator's domain).

## Why
This IS deliverable 2 of the operator's original request (verbatim in brief §1): "Give me an
HTML file with the exact instructions I need to follow to get it running on a Name.com
registered domain name."

## Context / current state
Not started. MUST verify GitHub's published Pages IP addresses (four A records, four AAAA
records) via a HEADED Playwright browser load of GitHub's own docs page before writing them
into the guide — brief provides the values as "documented as of Aug 2026" but says verify
before shipping; if unverifiable, say "couldn't verify" rather than trust silently. Also
verify how `pages/*.html` reference `site.css`/`theme.css` (relative vs root-absolute) so the
troubleshooting section's github.io-subfolder caveat is accurate.

## Files
- `docs/go-live-github-pages.html` (new)
- CI job `guide-linkcheck` runs on this repo's PRs — check what it actually validates before
  finalizing (any links inside the guide must survive it).

## How to continue + acceptance
Write, then load rendered HTML in a headed browser to sanity-check layout/readability before
counting this done. Final deliverable link goes in the FINAL HANDOFF and later the operator
report (brief §7, final bullet): `https://cmd.cinnamons.uk/api/fs/raw?cwd=<encoded worktree
path>&path=docs%2Fgo-live-github-pages.html`.

## Links
Brief §6 (full content spec), §2 (verified GitHub Pages / DNS facts to cross-check against).
