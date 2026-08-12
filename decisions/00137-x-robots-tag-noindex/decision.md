## Symptom

The fable architecture consult on PR #199 (relation `b2834443-ae8d-499a-b928-484787450369`,
decisions/00135) flagged a gap it deliberately scoped out of that PR: switching non-indexable
`robots.txt` from `Disallow: /` to `Allow: /` (so a page's HTML `<meta name="robots"
content="noindex">` is actually observable, per Google's documented crawler behaviour) also
opens crawling to every OTHER path on a non-indexable host. Under the old `Disallow`-all regime
this was moot — nothing could be crawled at all. Under the new `Allow` regime it's a real, if
minor, gap for anything indexable that isn't an HTML page: published media (`images/*`) and
public JSON (`/api/version`, `/api/version/notes` — both public by design, Inv 12) had no
`noindex` signal whatsoever on a non-indexable project, because neither can carry an HTML
`<meta>` tag.

## What was decided

- New `wixy_server/robots_header.py` — a small ASGI middleware, same shape as `auth.py`'s
  `is_admin_path`/`build_admin_auth_middleware`, registered unconditionally in `create_app`
  (constructed always, branches on `indexable` — same posture every other per-project piece of
  `app.py` takes).
- **Exact allowlist, not a prefix match:** `path.startswith("/images/")` OR `path in
  {"/api/version", "/api/version/notes"}` (a `frozenset` membership check, never
  `startswith("/api/version")`) — confirmed with the spec-author session that both literal
  version-JSON paths belong in scope: `routes_version.py` exposes exactly these two
  unauthenticated public JSON routes and nothing else (verified by auditing every `@router.get/
  post/...` decorator across every `wixy_server/routes_*.py` file — there is no third public
  JSON route this could apply to), so "`/api/version`, etc." (the originating todo's own
  wording) has nothing else it could mean. Never `/api/*` — a genuinely new API category would
  need its own decision, not a silent widening of this allowlist.
- **Never `/admin*`, `/api/admin*` (already CF-Access-gated), `/internal/*`, `/healthz`**
  (already 404 to any externally-headered request, Inv 12) — excluded inside
  `_should_tag_noindex` itself, unconditionally, so a future addition to the JSON allowlist
  can't accidentally widen past that boundary.
- **Never applied when `indexable: true`** — the public `cottageaesthetics.co.uk` build is
  completely untouched by this middleware.
- **No per-project robots-policy config knob** — same guardrail the WP1 consult already gave
  for PR #199; this is `indexable`-driven only, exactly like every other indexing signal in the
  codebase.
- **Classification is by request path alone, deliberately** — never the response's actual
  status or content-type. A documented, tested consequence: a 404 for a path inside `/images/`
  still gets tagged (nothing at that URL should be indexed regardless of whether a file exists
  there), and a `?v=<fingerprint>` cache-busting query string never perturbs the match
  (`request.url.path` excludes the query string by construction).
- **Reused the existing consult ruling rather than spending a fresh one.** Per consult doctrine
  and explicit spec-author direction: relation `b2834443` is the authoritative architecture
  precedent for this exact follow-up (its own refined scope is recorded in
  `todos/00028/.../00003-x-robots-tag-non-html-noindex-7pxrv9.md`); this PR still gets its own
  linked Opus graded audit before merge (a public response-header contract change), but did not
  re-spend a fresh architecture consult since implementation surfaced no genuinely new design
  choice beyond what that ruling already covered.

## Why

- Google's robots-meta-tag mechanism (the same one WP1/decisions/00135 relies on for HTML
  pages) only reads an HTML `<meta>` tag or an HTTP response header — it can never observe a
  `<meta>` tag inside a non-HTML response body, so an image or a JSON endpoint has no HTML
  document to carry one. A response header is the only mechanism that reaches those paths.
- **Activation-timeline asymmetry, worth recording explicitly:** `robots.txt`/`sitemap.xml`/
  the per-page HTML `noindex` meta are all baked into a static build at publish/restore time
  (`Storage/projects/ca/builds/<sha>/`) — an engine deploy alone does not change what's served
  until the next owner Publish/Restore (decisions/00135's own live-verification note). This
  header, by contrast, is set by a live Wixy route at REQUEST time, so it takes effect as soon
  as the engine itself deploys (Slots, ~30s after merge) — no static-build lag, no owner action
  needed. Do not conflate the two activation timelines when reporting this as live/verified.
- Keeping the allowlist an exact, closed set (rather than a blanket "every non-HTML route"
  middleware) means a future route addition is safe-by-default — it gets no `noindex` header
  until someone deliberately adds it here, rather than silently inheriting one.

## What to watch for

- This still needs its linked Opus graded audit (public behaviour-contract change) before
  merge, per this repo's own gate for a wixy-engine PR touching public behaviour — architecture
  is already ruled via `b2834443`, reused per doctrine, not re-litigated.
- Don't widen `_NOINDEX_JSON_PATHS` to a prefix match, and don't fold `/admin*`/`/api/admin*`/
  `/internal/*`/`/healthz` handling into the JSON allowlist itself — they're excluded
  unconditionally in `_should_tag_noindex` on purpose, so the two concerns can't accidentally
  merge.
- If a genuinely new public JSON route is ever added and it should carry this header too, that
  is itself a small, deliberate addition to `_NOINDEX_JSON_PATHS` (and this decision), not an
  automatic consequence of "it's public JSON" — keep the allowlist closed and explicit.
- The path-only classification (tagging even a 404) is intentional, not an oversight — see
  `build_robots_header_middleware`'s own docstring and `test_missing_image_still_gets_the_
  header_on_its_404`. Don't "fix" this into a status-code-aware check without a real reason.
