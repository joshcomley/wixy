# 00001 [mbto22] wixy: builder/cli.py --domain/--indexable overrides + tests

## What
Add `--domain` (str, default None) and `--indexable` (choices true|false, default None) to
`_add_common_args` in `builder/cli.py`. `_load_source(root, project_path, *, domain=None,
indexable=None)`: after `load_project_config`, apply `dataclasses.replace(project, ...)` when
either is provided (convert `--indexable` string to bool). Thread through `cmd_validate`,
`cmd_build`, `cmd_serve`. Leave `parity` untouched.

## Why
The GitHub Pages deploy workflow needs to build with the operator's real domain +
indexable=true while `projects/ca.json` (the fleet/staging registry) must stay
`ca.cinnamons.uk` / indexable=false. Deliberately NOT env-var overrides (registry.py's
`_apply_env_overrides` docstring records that decision as server-only) — CLI flags only.

## Context / current state
Not started. Verified in code already: `builder/cli.py` structure, `_load_source` signature,
`load_project_config` returns a `ProjectConfig` dataclass (frozen — use `dataclasses.replace`).

## Files
- `builder/cli.py`
- `builder/tests/test_cli.py` (add cases: build with `--domain example.org --indexable true`
  on the existing fixture site → robots.txt Allow + sitemap uses example.org, sitemap.xml
  exists, no noindex meta, canonical link present; omitted flags preserve registry defaults;
  `--indexable false` still writes Disallow + no sitemap)

## How to continue + acceptance
Implement, then `pytest builder/tests/test_cli.py` green. Depends on 00002 (canonical link)
existing for the canonical-link assertion to be meaningful — can stub/skip that one assertion
until 00002 lands, or do 00001+00002 together.

## Links
Brief §4A. Related: [[00002]] (canonical link, same apply_head/domain plumbing).
