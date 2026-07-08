# 00002 [y76p6p] M2 WX — Builder v1

## What
Config/registry loader, template parse + all `data-wx-*` bindings, partials, head/meta/
theme/fonts injection, `theme.css` emission, sitemap/robots, `validate` (+`--json`),
`serve` (dev static server), `build` CLI; fixture mini-site + full unit suite;
deterministic-output test.

## Why
Second milestone — the pure library everything else (server, site CI) depends on.
Normative contract is spec/02-content-model.md.

## Context / current state
Depends on 00001 (scaffold) landing first.

## Relevant files
- spec/02-content-model.md (normative — bindings, JSON shapes, theme, validation rules)
- spec/08-testing-acceptance.md §1 (builder test list)

## How to continue + acceptance
Implement per 02 in full (all data-wx-* kinds, @global/.relative resolution, nested
lists, data-wx-if incl. preview-mode retention, nav generation, rich-lite sanitizer,
canonical JSON rewrite). Fixture mini-site + goldens committed. Two builds of same input
byte-identical. `builder validate --json` shape tested.

## Links
PR: (fill in when opened)
