# 00012 [mvta5o] M12 CA — Cutover

## What
Point Wixy's project checkout at CA main, first real publish from the admin, retire GH
Pages (`deploy.yml`, `.nojekyll` removed), README updated with new home; reword the
contact page's "Demo preview: live email delivery…" line to match reality.

## Why
The moment ca.cinnamons.uk becomes the real, owner-operated live site instead of a build
target no one has pressed Publish on yet.

## Context / current state
Depends on 00011 (install & deploy) being live, and 00003-00005 (CA migration) fully
merged to CA main.

## Relevant files
- spec/03-site-migration.md §3 step 5 (deploy.yml two-phase retirement)
- spec/07-hosting-deploy.md (deploy target)
- spec/09-work-plan.md row 12 (exact deliverable text incl. contact page wording note)

## How to continue + acceptance
First publish via the real admin UI (not a script) so the whole owner flow is proven.
GH Pages URL goes stale intentionally (noted in the PR). indexable stays false (07 §5 —
Wix remains canonical until a later cutover decision).

## Links
PR: (fill in when opened)
