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

## Scope (refined by the spec-author session after reviewing the split, 2026-08-12)

**Target only externally reachable, non-HTML PUBLIC responses** on a non-indexable host:
published media (`images/*`) and genuinely public JSON (`/api/version`). **Explicitly NOT**
blanket middleware — must not touch `/admin*`, any authenticated `/api/admin*` route,
`/internal/*`, or `/healthz` (the latter two already 404 to any externally-headered request
per Inv 12; adding a noindex header there would be meaningless and risks accidentally
widening what this middleware touches later). Do not make robots policy per-project-
configurable as part of this either — same guardrail the WP1 consult already gave for #199.

**Important asymmetry vs. PR #199, worth its own line in the eventual decision entry:**
`robots.txt`/`sitemap.xml`/per-page `noindex` meta are all baked into a STATIC build at
publish/restore time (`Storage/projects/ca/builds/<sha>/`) — an engine deploy alone doesn't
change what's served until the next Publish/Restore (see decisions/00135's live-verification
note). A response HEADER set by a live Wixy route, by contrast, takes effect as soon as the
ENGINE itself deploys (Slots, ~30s after merge) — there's no static-build lag, because the
header is added at request time, not baked into a pre-rendered file. Don't conflate the two
activation timelines when writing the PR/decision for this.

## Relevant files

- `wixy_server/routes_public.py` — public serving; likely where response headers get set
  (see `_cache_control_for` for the existing per-response-header pattern to follow).
- `wixy_server/app.py` — if a project-wide middleware (rather than a per-route header) is the
  better shape, given this needs to apply project-wide whenever `indexable=False`, not per
  individual route — but scoped to only the public/media/version surface per the guardrail
  above, not every route the app serves.
- `builder/templates.py:apply_head` — the existing per-page noindex mechanism this is the
  non-HTML sibling of.
- Inv 12 (docs/ai/invariants.md) — `/api/version` is public by design; `/healthz`/`/internal/*`
  are edge-header-guarded and must NOT gain this header (out of scope, not just unnecessary).

## How to continue and acceptance criteria

1. Add the header on a non-indexable project's PUBLIC media + `/api/version` responses only —
   confirm with a live check against `ca.cinnamons.uk` (currently non-indexable) once
   implemented; live check can run right after the engine deploy (no publish/restore needed
   for this one, per the asymmetry note above).
2. Must NOT apply when `indexable=true` (the public `cottageaesthetics.co.uk` build must be
   unaffected) and must NOT apply to `/admin*`, `/api/admin*`, `/internal/*`, or `/healthz`.
3. Tests proving the header is present on the intended public paths and absent everywhere else
   (indexable build; admin/internal/health routes even when non-indexable).
4. Follows the same doc/decision/spec update discipline as PR #199 if it touches a documented
   contract or invariant.
5. Small, standalone PR — do not bundle with any other work package.

## Links

- Consult ruling: cmd relations `b2834443-ae8d-499a-b928-484787450369`.
- Originating PR: `joshcomley/wixy` #199, `decisions/00135-staging-noindex-observable-robots`.
