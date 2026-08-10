# 00021 [lhv5wm] wixy: fix existing tests asserting old `.html` URL shape

Full context: sidecar 00017.

## What (verified list from the brief — triage each deliberately)

- `builder/tests/test_nav.py`: `page_url("about") == "/about.html"` → `"/about"`
- `builder/tests/test_cli.py`: canonical assertions `https://example.org/...`
- `builder/tests/test_render.py`: canonical `/about.html` → `/about`; the overwrite test's
  `page_url_path` input
- sitemap tests wherever `<loc>` shapes are asserted

## How to continue

`grep -rn '\.html' builder/tests wixy_server/tests e2e/tests` and triage each hit
deliberately: public-URL shapes change; `/admin/preview/*.html` and template filenames
(`pages/*.html`) do NOT change — don't touch those.
