# 00012 [c2tcwd] site-repo: CLAUDE.md "never publish, never deploy" truthful update

## What
Update the site repo's own CLAUDE.md "Never publish, never deploy" section: merging to `main`
still never changes the live site; the public domain now serves the `wixy-live` ref, which
ONLY the wixy server moves (owner Publish/Restore in the admin). Agents must never push
`wixy-live` by hand and never trigger the Pages workflow to "ship" content. Mention the
workflow + `WIXY_PUBLIC_DOMAIN` variable briefly.

## Why
This section is a load-bearing consent guardrail (agents merging content PRs routinely without
going live) — it must stay TRUE after this change, since the old wording predates any Pages
deploy mechanism existing at all.

## Context / current state
Not started. Read the section as it currently stands before editing (don't guess its wording).

## Files
- (site repo) `CLAUDE.md`

## How to continue + acceptance
The updated section must not contradict [[00011]]'s workflow trigger (push to `wixy-live` +
manual dispatch) — an agent reading only this file should correctly predict what does and
doesn't go live.

## Links
Brief §5 item L.
