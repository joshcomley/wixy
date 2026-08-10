# 00017 [ag72z1] wixy: builder/nav.py page_url → extensionless

## What

Change `builder/nav.py:page_url` from `"/"` for index / `f"/{slug}.html"` otherwise, to `"/"`
for index / `f"/{slug}"` otherwise. This is the single URL-shape authority; every caller
(nav hrefs, canonical/og:url, sitemap `<loc>`, active-nav marking) follows automatically.

## Why

Operator: "Can we - with Github Pages - get rid of the .html suffixes everywhere?" Verified
live against GitHub Pages: `/about` → 200 (serves `about.html` natively, zero config),
`/about.html` → 200 (unchanged), `/about/` → 404 (no directory-redirect magic). So
extensionless URLs work on Pages for free; the engine + server just need to emit and resolve
them.

## Context — full brief summary (durable copy)

This is round 2 of workspace 00023, following the GitHub Pages go-live (wixy PR #178/#179,
site PR #32, decisions/00126 wixy, decisions/00013 site repo — read those first). Planner
session `74703766-f2a8-4255-aafd-430ff10ba9a4` verified all facts below on 2026-08-10.

**Decided design (7 points):**
1. `page_url` emits extensionless (this task).
2. `wixy_server/routes_public.py:_resolve_within_build_dir` gets an extensionless fallback:
   literal miss + path doesn't end `/` + final segment has no `.` → retry with `+ ".html"`
   through the same traversal guard. `/about`→200, `/about.html`→200, `/about/`→404 (Pages
   parity, no directory redirect), `/index`→200, assets unaffected, unknown→styled 404.
3. `builder/cli.py:cmd_serve`'s bare `SimpleHTTPRequestHandler` gets the same rule (small
   subclass) so `python -m builder serve` matches prod/Pages.
4. `editor/src/navigation.ts:resolveInternalPageSlug` accepts BOTH `/slug` and `/slug.html`
   patterns (keep the old one — legacy links still interceptable in preview). Update its
   header comment (currently documents `.html` as "the ONLY shape the builder ever emits").
5. NO redirects anywhere — legacy `.html` stays 200 forever (Pages can't redirect; canonical
   link, shipped in round 1, already disambiguates for SEO).
6. Site content migrates to root-absolute clean hrefs (`about.html` → `/about` etc.) — a
   migration, not a new validation rule (old-style links still resolve via the fallback).
7. Ship order: wixy PR merges first (Slots auto-deploys), THEN site-repo PR (its CI builds
   against engine main; needs the deployed resolver).

**Verified facts (planner-measured, trust these):**
- `page_url` callers: `nav.build_nav`, `render.py:150` `_mark_nav_active`, `render.py:160`
  → `apply_head` (canonical + og:url), `sitemap.py:23` (`<loc>`).
- `_resolve_within_build_dir` (routes_public.py ~line 32): request path → literal file under
  live build dir (`""`→`index.html`), path-traversal guarded, miss→styled 404.html.
  `_cache_control_for` keys off the RESOLVED path's `.html` suffix — stays correct
  automatically once resolver returns `about.html` for `/about`.
- `/admin/preview/<page>.html` is an INTERNAL admin contract (admin-ui, editor overlay.ts:623,
  e2e, preview.py) — NOT public URL surface, do NOT change it.
- Parity harness (`builder/tests/parity/runner.py`) keys by slug, captures text+screenshots
  only (no hrefs) — unaffected.
- Site repo `.html` hrefs (grep-verified at main): `content/_global.json` (8 footer links),
  `pages/about|aftercare|faq|policies.html` (`contact.html` CTA), `pages/index.html`
  (`treatments.html` ×2, `reviews.html`), `pages/treatments.html` (`index.html#contact` ×2).
  Re-grep for exhaustiveness.
- e2e `section-panel.spec.ts` requests `/gallery.html` in several places — legacy coverage,
  leave as-is (add new extensionless coverage alongside).
- spec/02 §3 documents the old shape — spec is historical record, do NOT edit spec/; record
  the deviation as decisions/ entries in both repos instead.

## Relevant files

`builder/nav.py`, `wixy_server/routes_public.py`, `builder/cli.py`, `editor/src/navigation.ts`,
`builder/tests/test_nav.py`, `builder/tests/test_cli.py`, `builder/tests/test_render.py`,
sitemap tests, `wixy_server/tests/test_app.py` (or wherever `_resolve_within_build_dir` is
tested), `docs/ai/{builder,serving-and-overlay,contracts,invariants,editor-and-admin-ui}.md`.

## How to continue

See tasks 00018–00031 for the full breakdown. This sidecar is the durable reference for the
whole brief — later sidecars point back here rather than repeating context.

## Links

Planner endpoint: `POST http://127.0.0.1:9321/sessions/74703766-f2a8-4255-aafd-430ff10ba9a4/send`.
Prior round: decisions/00126 (wixy), decisions/00013 (site repo), sidecars 00001-00016 in this
same todos folder.
