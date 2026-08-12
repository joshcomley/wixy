## Symptom

A 2026-08-12 search-indexing audit (workspace 00027, handed off in
`docs/search-indexing-implementation-brief.md`) found that `ca.cinnamons.uk` emits three
signals at once for a non-indexable build:

1. `robots.txt`: `Disallow: /` (the original `builder/sitemap.py:generate_robots_txt`
   behavior, matching the original spec/02 §7 decision).
2. Per-page `<meta name="robots" content="noindex">` (`templates.apply_head`).
3. No `sitemap.xml`.

Google's current documentation
(<https://developers.google.com/search/docs/crawling-indexing/block-indexing>) is explicit
that a crawler can only act on a page's `noindex` directive by fetching the page — if
`robots.txt` blocks the fetch, Google never sees the `noindex` tag at all, and the URL can
still appear in results (typically with no description, since the content itself was never
crawled) if it's linked from elsewhere. Combining `Disallow` + `noindex` therefore doesn't
add caution; it can produce exactly the "still shows up in search" outcome `noindex` exists
to prevent, while giving up the one channel (`noindex`) that actually controls it.

This was a decided-spec-vs-reality conflict, not a drive-by bug: spec/02-content-model.md §7
explicitly specified `Disallow`-all for a non-indexable build, so correcting it needed a
decision entry + spec/doc update in the same change, not a silent one-line fix.

## What was decided

- `builder/sitemap.py:generate_robots_txt(indexable=False)` now returns
  `"User-agent: *\nAllow: /\n"` — crawling is allowed, with no `Sitemap:` directive.
- The per-page `noindex` meta tag is **unchanged** — it is now the sole mechanism actually
  keeping a non-indexable build out of the index, and it works correctly because the crawler
  can now reach it.
- `sitemap.xml` remains omitted for a non-indexable build (no `Sitemap:` directive to point
  at it, and nothing to gain from advertising it).
- `builder/build.py`'s generated `404.html` was already unconditionally `noindex` regardless
  of the project's `indexable` flag — confirmed correct as-is, no change needed.
- New `docs/ai/invariants.md` Inv 35 formalizes "a non-indexable build allows crawling; it
  never disallows it" so this doesn't silently regress back to `Disallow`-all later.
- Explicitly out of scope: staging *confidentiality*. `robots.txt` was never a privacy
  mechanism in either direction — `ca.cinnamons.uk` was reachable with no authentication on
  `/` before this change and still is after it (CF Access already gates only `/admin*` +
  `/api/admin*`, spec/04 §9). If genuine confidentiality is ever wanted for a non-indexable
  build, that is a future authentication decision covering the *entire* public surface, not
  a robots.txt tweak — the brief that prompted this change says so explicitly, and this
  change does not attempt it.

## Why

- Matches Google's own documented crawler behavior exactly: `noindex` requires crawl access
  to be observed; `Disallow` denies crawl access. The two were fighting each other.
- `ca.cinnamons.uk` was never secret (a known, publicly-reachable hostname with an open `/`)
  — `Disallow`-all bought no real confidentiality it could lose by switching to `Allow`.
- Keeps the fix scoped to the actual defect (crawl-vs-index signal conflict) rather than
  bundling in an unrelated, larger authentication project.

## What to watch for

- Do not reintroduce `Disallow: /` "to be extra safe" for a non-indexable build — per the
  Symptom above, that is *less* effective at keeping the build out of search results, not
  more, because it blinds the crawler to the `noindex` tag that's doing the real work.
- This is engine-generic (`builder/sitemap.py` takes no project-specific input beyond
  `indexable`/`domain`), so it applies to every project this registry pattern serves, not
  only `ca` — Inv 35 states it without naming a project.
- `spec/07-hosting-deploy.md`'s old "Future real-domain cutover" section described a
  different, since-superseded mechanism (fleet tunnel ingress + flipping this same
  `indexable` field + 301s from `ca.cinnamons.uk`) for reaching a public canonical domain.
  The public canonical (`cottageaesthetics.co.uk`) went live 2026-08-10/11 instead via the
  independence-phase GitHub Pages build (CLI `--domain`/`--indexable` overrides,
  `projects/ca.json` itself untouched) — corrected in the same PR as this decision. Legacy
  Wix URL preservation (that same stale section's 301 map) is being handled separately by
  `docs/search-indexing-implementation-brief.md`'s Work package 2, on GitHub Pages, not by
  reviving the tunnel-ingress plan.
