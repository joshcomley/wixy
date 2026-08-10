# 00002 [ev22x1] wixy: templates.py canonical <link> in apply_head + tests

## What
`apply_head` (`builder/templates.py`) gains a find-or-create `<link rel="canonical"
href="https://{domain}{page_url_path}">` in `<head>` (index page → `https://<domain>/`).
Follow the existing `_find_or_create_meta_*` helper idiom; add an equivalent link-by-rel
helper. If a template hand-authored a canonical, overwrite its href (single source of truth).

## Why
First-time-indexable go-live needs canonicals; also defuses the github.io-vs-custom-domain
duplicate-content window during the transition.

## Context / current state
Not started. Verified: `apply_head` currently sets title/description/og:type/og:url/og:image/
fonts link + robots meta; no canonical today. No fixture pins `og:url` currently, so this is
additive, not a golden-file rewrite.

## Files
- `builder/templates.py`
- `builder/tests/test_render.py` (extend `apply_head` coverage — add canonical assertions,
  don't rewrite existing goldens)

## How to continue + acceptance
Implement, run full `pytest` (not just test_render.py) to catch any other fixture asserting on
exact `<head>` contents. Pair with [[00001]] for the `--domain` CLI-flag test to assert on.

## Links
Brief §4B.
