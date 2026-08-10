# 00013 [4ivrzc] site-repo: decisions/ entry — Pages deploy design

## What
Follow the site repo's OWN existing `decisions/` naming convention (it's date-ordered, NOT
the wixy-repo's NNNNN-slug convention per brief §2 — verify by reading existing entries
before naming this one). Cover: the Pages deploy design, `wixy-live` ref semantics, variable
gating + fork behavior (no-op when `WIXY_PUBLIC_DOMAIN` unset), the pre-workflow-sha
resolution edge.

## Why
Same decision-log doctrine as the wixy-repo entry ([[00008]]), scoped to the site repo's own
log since this PR lands there.

## Context / current state
Not started.

## Files
- (site repo) `decisions/<per that repo's convention>`

## How to continue + acceptance
Read 2-3 existing site-repo decisions entries first to match naming/structure exactly (do not
assume it mirrors the wixy repo's NNNNN-slug/title+decision.md shape).

## Links
Brief §5 item M. Sibling: [[00008]] (wixy repo's entry for the same overall design).
