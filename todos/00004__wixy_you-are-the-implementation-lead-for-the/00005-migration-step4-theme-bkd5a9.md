# 00005 [bkd5a9] M5 CA+WX — Migration step 4 (theme)

## What
Theme extraction: move `:root` block into `theme/theme.json`; replace hardcoded
`font-family` literals in `site.css` with the three font vars; pages get `theme.css`
link before `site.css`; Google Fonts link becomes builder-generated. Site `CLAUDE.md`
written (the AI-lane contract).

## Why
Completes the CA migration — after this the site repo is fully in the target content
model shape (spec/02) and safe for the AI chat lane (M10) to edit.

## Context / current state
Depends on 00004 (page annotations) landing. Touches both CA (site.css/theme.json) and
potentially WX (builder theme.css emission, if not already complete from M2).

## Relevant files
- spec/02-content-model.md §4 (theme.json shape, theme.css emission, font var mapping)
- spec/03-site-migration.md §3 step 4, §6 (site CLAUDE.md required contents)

## How to continue + acceptance
Parity green (computed styles must not change — color/font-family/font-size/weight
assertions in the parity harness are the gate). Site CLAUDE.md covers: what/served-by-
Wixy, data-wx-* rules, content/pages/theme split, never-publish rule, validate-before-
ship, brand/voice guardrails, image conventions.

## Links
PR: (fill in when opened)
