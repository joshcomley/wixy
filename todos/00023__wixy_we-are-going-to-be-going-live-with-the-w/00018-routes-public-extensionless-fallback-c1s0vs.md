# 00018 [c1s0vs] wixy: routes_public.py extensionless resolution fallback + tests

Full context: sidecar 00017.

## What

In `wixy_server/routes_public.py:_resolve_within_build_dir`: when literal resolution misses,
AND the request path doesn't end with `/`, AND its final segment has no `.`, retry with
`request_path + ".html"` through the SAME traversal guard. Keep returning `None` on miss.

## Acceptance (6 behavioral assertions, from the brief)

- `/about` → 200
- `/about.html` → 200 (unchanged)
- `/about/` → 404 (Pages parity — no directory-redirect magic)
- `/index` → 200
- `/images/...`, `/site.css` unaffected
- unknown paths → styled 404

## How to continue

Find existing public-serving tests: `grep -rn "_resolve_within_build_dir\|robots.txt"
wixy_server/tests/` (likely `test_app.py`). Add/extend tests for all 6 assertions.
