# 00003 [7pxrv9] X-Robots-Tag: noindex for non-HTML staging responses

## What

Add an `X-Robots-Tag: noindex` response header (per Google's documented mechanism for
non-HTML resources: <https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag>)
to `wixy_server` responses for non-indexable projects, covering paths an HTML `<meta
name="robots">` tag can't reach: media files served under `images/`, and any public JSON
(`/api/version`, etc. — public by design per Inv 12).

## Why

Flagged by the fable architecture consult (relation `b2834443-ae8d-499a-b928-484787450369`)
that reviewed PR #199 (decisions/00135): PR #199 switches non-indexable `robots.txt` from
`Disallow: /` to `Allow: /` so the per-page HTML `noindex` meta tag is actually observable —
correct for HTML pages. But it also means crawling is now open to every OTHER path on a
non-indexable host, and none of those can carry the HTML-only `noindex` meta mechanism. Under
the old `Disallow`-all regime this was moot (nothing could be crawled at all); under the new
`Allow` regime it's a real, if minor, gap for anything indexable that isn't an HTML page
(images turning up in image search, say).

## Context

Deliberately scoped OUT of PR #199 by the consult ruling ("goes to the immediate next small
PR rather than this one") — PR #199 is the narrow, already-implemented, already-audited fix
for the HTML-page signal conflict; this is a genuinely separate concern (a new middleware
surface, not a one-line generator change) and shouldn't dilute that PR's review.

## Relevant files

- `wixy_server/routes_public.py` — public serving; likely where response headers get set
  (see `_cache_control_for` for the existing per-response-header pattern to follow).
- `wixy_server/app.py` — if a project-wide middleware (rather than a per-route header) is the
  better shape, given this needs to apply project-wide whenever `indexable=False`, not per
  individual route.
- `builder/templates.py:apply_head` — the existing per-page noindex mechanism this is the
  non-HTML sibling of.
- Inv 12 (docs/ai/invariants.md) — `/api/version` is public by design; confirm this new header
  doesn't need to (and shouldn't) touch the `/healthz`/`/internal/*` edge-header-guarded
  routes, which already 404 to any external request.

## How to continue and acceptance criteria

1. Add the header for every response on a non-indexable project's public surface (images,
   any public JSON) — confirm with a live check against `ca.cinnamons.uk` (currently
   non-indexable) once implemented.
2. Must NOT apply when `indexable=true` (the public `cottageaesthetics.co.uk` build must be
   unaffected).
3. Tests proving the header is present/absent in each case.
4. Follows the same doc/decision/spec update discipline as PR #199 if it touches a documented
   contract or invariant.
5. Small, standalone PR — do not bundle with any other work package.

## Links

- Consult ruling: cmd relations `b2834443-ae8d-499a-b928-484787450369`.
- Originating PR: `joshcomley/wixy` #199, `decisions/00135-staging-noindex-observable-robots`.
