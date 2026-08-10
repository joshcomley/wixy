# 00008 [rdfls7] wixy: decisions/ entry — GitHub Pages interim architecture

## What
Next NNNNN under `decisions/` (scan all entries incl. any `decisions/done/` archive, max+1),
two files (`title.md` one-liner + `decision.md`): the interim GitHub-Pages architecture —
mirror ref (`wixy-live`) instead of deploying `main` HEAD (preserves the Publish gate),
canonical tag, `WIXY_PUBLIC_DOMAIN` variable gating (fork-friendly no-op when unset), the
restore/bootstrap workflow-resolution edge (push-event workflows resolve from the pushed
commit's tree — a restore predating the workflow file moves the ref but triggers no run), and
that this is ADDITIVE to (not a replacement for) the independence-phase droplet plan.

## Why
Fleet-wide + repo doctrine: log any significant non-obvious design decision future agents
must know, in the numbered decisions/ log, not buried in a PR description.

## Context / current state
Not started. Check current max NNNNN before allocating (was in the 00100s range per docs/ai
cross-refs like "decisions/00123", "decisions/00125" seen while reading invariants.md).

## Files
- `decisions/<NNNNN>-slug/title.md`
- `decisions/<NNNNN>-slug/decision.md`

## How to continue + acceptance
Follow the exact two-file convention used by existing entries (spot-check one, e.g. the
00125 or 00117 entry referenced in invariants.md, for tone/structure).

## Links
Brief §4H. Sibling entry in the site repo: [[00013]].
