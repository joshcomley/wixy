# 00004 [ehwhi1] M4 CA — Migration steps 2-3

## What
Partials extracted from `site.js` (slimmed to behavior only), `_global.json`, then
page-by-page annotation + content extraction (order: index, about, treatments, gallery,
faq, reviews, contact, aftercare, policies) incl. the six/seven collections + gallery
JS-array->DOM conversion + reviews JS-array->DOM conversion (script deleted). Parity
green after every page.

## Why
The bulk of the migration — every page's text/images/collections become editable
content. Most sensitive content class (client reviews, gallery consent) lives here.

## Context / current state
Depends on 00003 (migration step 1 + parity harness) landing.

## Relevant files
- spec/03-site-migration.md §2-3 (target layout, steps 2-3 detail), §4 (site.js behavior
  inventory to preserve)
- spec/02-content-model.md §6 (the 7 load-bearing collections), §3 (card CTA pattern)
- spec/00-mission.md (sensitivities: consent on photos/reviews)

## How to continue + acceptance
One PR per step per work-plan (may combine page annotations if parity stays green after
each). Preserve exact copy/behavior; alternating section backgrounds -> class+nth-of-type;
FAQ inline underline -> CSS rule. Parity harness green throughout.

## Links
PR: (fill in when opened)
