# Milestone 6 slice 4 (final): public serving, CF Access JWT, admin API subset

## Context

Fourth and final slice of the M6 PR train (decisions/00010). Builds: public serving
(spec/04 §3), the CF Access JWT middleware (§9), `/api/admin/state|content|draft|
media(list)` (§8's table, M6's subset only — publish/restore/pages-ops/chat are
M9/M7/M10), `/internal/ready|warmup` + `/healthz` (§9-10), `/api/version` (§9, spec/07
§1), and a minimal instant-render admin shell (spec/05 §1). `app.py` was split into
one router module per route group (`routes_preview`, `routes_admin_api`,
`routes_internal`, `routes_version`, `routes_public`) plus `auth.py` (JWT) and
`site_source.py` (shared SiteSource-building), since it was about to grow far beyond
slice 3's single preview route.

## Decisions

**1. Two real spec-vs-implementation gaps found and fixed while building this slice's
consumers, not deferred:**
   - `builder/build.py` never emitted a `404.html`, despite spec/04 §3 saying "styled
     404.html (builder emits one; migration adds a simple template)" — public serving
     needs a real 404 response NOW, so `build_site` gained `_generate_404_html`: a
     small, theme-aware (links `theme.css` if a theme exists), hardcoded page — not
     content-file-driven (no `content/404.json` to author; there's nothing
     per-project to say here), the same "builder-generated, not templated" shape as
     `robots.txt`/`sitemap.xml`. Wixy-repo-only change, no CA-repo touch needed.
   - `wixy_server/settings.py` read `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` (slice 1),
     but spec/07-hosting-deploy.md §5's secrets inventory gives the LITERAL names as
     `WIXY_CF_TEAM_DOMAIN`/`WIXY_CF_ACCESS_AUD` (note also the `_ACCESS_` segment
     moves between the two names — not just a missing prefix). Fixed now, while
     actually building the JWT middleware that's the one real consumer of these two
     settings — the natural, only-sensible place to catch and correct it.

**2. `wixy_server/auth.py`'s `JwksCache` is a small hand-rolled fetch-then-cache
wrapper, not `jwt.PyJWKClient`.** `PyJWKClient` bundles fetching + caching +
key-selection behind its own internal HTTP client, with no seam to inject a
hand-crafted JWKS for tests — using it would mean either mocking PyJWT's internal HTTP
calls or standing up a real local HTTP server just to serve a JWKS document. Splitting
"fetch a JWKS dict" (injectable, production wires it to a real `httpx.get`) from
"verify a token against an already-resolved key" (`verify_access_jwt`) means
`test_auth.py`'s 22 tests — including 6 genuine attack-shaped cases (wrong aud/iss,
expired, signed by an unrelated key under the same `kid`, unknown `kid`, malformed
token) — run with a real RSA keypair and zero network calls, matching this repo's
established zero-network-dependency test convention (`wixy_server.checkout`'s real
local git repo instead of a live remote).

**3. The admin-auth middleware is one `@app.middleware("http")` function wrapping the
WHOLE ASGI app — not per-router `Depends()`.** It has to cover the `/admin/static`
`StaticFiles` mount too (the injected `editor.js`/`admin.js` bundles), which isn't a
normal FastAPI route with a dependency graph at all; only outer ASGI-level middleware
reaches a mounted sub-app. Tested directly (`test_auth_gate_integration.py`, real
signed JWTs + a monkeypatched fetch): `/admin/preview/*`, `/api/admin/*`, and
`/admin/static/*` are all gated; `/api/version`, `/healthz`, `/internal/*`, and public
serving are not, even with CF Access fully configured.

**4. On successful verification, the middleware stashes `claims["email"]` (falling
back to `sub`) on `request.state.access_email`, and the draft-PATCH route uses it as
the overlay op's `by` field** (falling back to a fixed `"editor"` placeholder only
when `WIXY_DEV_NO_AUTH` bypassed verification and there's no real identity to report).
`wixy_server.overlay`'s own convention (decisions/00011) is that `by`/`now` are always
caller-supplied, never hardcoded internally — this is that convention's ROUTE-LAYER
half: the HTTP boundary is exactly where the real authenticated identity and the real
wall clock belong, not `overlay.py`'s pure business logic.

**5. `live_pointer.load_live_pointer` is read FRESH on every public request — no
in-process cache.** There's no publisher yet (M9) to raise an in-process invalidation
event, and a small JSON file read is cheap enough that caching would only add a
staleness class of bug (a just-published site not appearing until some cache expiry)
for no measured benefit. `build_dir` is computed from `live.json`'s `sha` field via
`ProjectPaths.build_dir()`, never trusted from the file's own `buildDir` string —
tested explicitly (`test_ignores_a_hand_edited_build_dir_field`) since the two are
equivalent by construction and computing removes one thing to validate against path
traversal.

**6. Public serving's path-traversal guard (`_resolve_within_build_dir`) is tested
DIRECTLY, not only through HTTP.** A raw `..` in a request URL is often normalized away
by the HTTP client itself before the request is even sent (confirmed while writing
`test_path_traversal_via_http_never_serves_the_escaped_file` — kept as a best-effort
integration check, but NOT the test that proves the guard works). The authoritative
tests (`TestResolveWithinBuildDir`) call the resolver function directly with `..`-laden
path strings, which is unaffected by any client-side URL normalization and actually
exercises the `.resolve()` + `.relative_to()` boundary check.

**7. `GET /` and `GET /{path:path}` are registered via `@router.api_route(path,
methods=["GET", "HEAD"])`, not `@router.get(...)`.** Found by testing, not assumed:
`@router.get` does NOT implicitly add HEAD support in FastAPI/Starlette (a bare `HEAD
/` returned 405 until fixed) — spec/04 §3 explicitly requires "HEAD supported."

**8. Every route in `routes_admin_api.py` returning `JsonObject` needs
`response_model=None`.** FastAPI infers a Pydantic response model from a route's
return-type annotation by default; `JsonObject = dict[str, JsonValue]` is a
recursively-self-referencing alias (`JsonValue` includes `list[JsonValue]` /
`dict[str, JsonValue]`) defined under `from __future__ import annotations`, which
Pydantic's `TypeAdapter` cannot fully resolve at response-serialization time
(`PydanticUserError: ... is not fully defined`). `response_model=None` disables
automatic inference entirely, falling back to plain JSON encoding of whatever's
returned — exactly what these routes need since they already return
already-JSON-shaped dicts. `dict[str, int]` (the draft PATCH/DELETE routes) and
`dict[str, object]`/`dict[str, bool]` (version/internal routes) aren't recursive
aliases and don't hit this.

**9. `/internal/warmup` calls `ensure_checkout` directly, not the background
watcher's `fetch_once`.** `fetch_once` deliberately swallows `CheckoutError` (so a
transient failure never crashes the watcher's loop, spec/04 §7's "degrade
gracefully") — reusing it for warmup would make warmup unable to ever report failure,
defeating its whole purpose (Slots' pre-swap smoke check needs to know if the pre-load
actually worked). `_warm` calls `ensure_checkout` directly and lets a genuine failure
propagate as `CheckoutError` → 503, while still updating the shared `WatcherStatus` on
success so a successful warmup also counts as a "fetch" for `/api/admin/state`'s
`fetchedAt`.

**10. `/api/admin/state`'s `upstream.aheadOfPublished`/`fetchedAt` are wired for
real**, closing decisions/00013's own "watch for" item: `wixy_server/checkout.py`
gained `commits_ahead(checkout_dir, since_sha)` (a `git log since_sha..HEAD` wrapper),
and `wixy_server/watcher.py` gained a `WatcherStatus` dataclass (`fetched_at`,
`last_error`) threaded through `fetch_once`/`watch_upstream` and shared via
`app.state.watcher_status`. When there's no live pointer yet, `aheadOfPublished` is
an empty list — "ahead of published" is undefined before anything's been published,
not an error.

**11. `/api/admin/media` (list only) enumerates repo `images/` + staged
`draft/media/`, tagged by `source`.** Upload/delete and reference-scanning
(`GET .../media` per spec/05 §4's "references (which binding keys use it)") are
milestone 8's "media panel" scope — the handover's own "(list)" qualifier on this
milestone's work. No dimensions/file-size read yet either (Pillow-based, also M8).

**12. The admin shell (`GET /admin`, `GET /admin/`) is one static HTML file
(`wixy_server/static/admin_shell.html`, NOT inside the esbuild-output `static/admin/`
dir, to stay clear of CI's bundle-drift check) serving BOTH routes identically** —
spec/05's routing is entirely client-side hash fragments (`#/pages`, `#/edit/<page>`,
…), so there is no server-side sub-route to distinguish; the real panels are
milestone 7's TypeScript, this just proves the shell-paints-instantly / data-loads-via-
fetch plumbing spec/05 §1 requires.

**13. A resource-contention investigation, not a code bug (recorded per the "profile,
don't theorize" rule):** mid-slice, the full test suite appeared to hang (3-minute
timeout) and a background run showed `MemoryError`/`VirtualAlloc failed` crashes in
unrelated Playwright parity tests. Isolating each new module (34s), then the app
tests alone (11s) showed no hang; only the FULL suite was affected. Root cause,
confirmed by direct process inspection: earlier Bash-tool-timeout-killed pytest
invocations left ORPHANED xdist worker process trees running (Windows doesn't
propagate a foreground timeout's kill through execnet's worker processes) — two
`pytest -q` trees, each with 7+ live child workers, had been running for 17-23 minutes
before being found and killed, consuming ~6 GB of RAM the whole time (confirmed:
free memory went from ~19.5 GB to ~25.8 GB immediately after killing them). A clean
run afterward completed in 41s for 282 tests — in line with the slice 3 baseline
scaled for the added tests, and every subsequent clean run has stayed there. No code
change resulted from this — the fix was process hygiene (kill orphans before
re-running; avoid overlapping multiple pytest invocations against the same shared,
already-busy machine), not anything in `wixy_server`/`builder`.

## Verification

`python -m pytest` — 331 tests (up from 247 after slice 3), all new: `test_build.py`
(404 page), `test_settings.py` (renamed env vars), `test_checkout.py`
(`commits_ahead`), `test_watcher.py` (`WatcherStatus`), `test_live_pointer.py`,
`test_auth.py` (22 tests, offline JWT verification incl. 6 attack-shaped cases),
`test_routes_public.py` (public serving + the direct path-traversal-guard tests),
`test_routes_internal.py`, `test_routes_version.py`, `test_routes_admin_api.py`,
`test_auth_gate_integration.py` (the middleware wired into a real app with real
signed JWTs). `mypy --strict` clean (74 source files). `ruff check`/`format --check`
clean.

## What to watch for

- `/admin/preview/*`'s error responses still use FastAPI's default `HTTPException`
  JSON body (`{"detail": ...}`), not yet the RFC7807-ish `{error, detail, field?}`
  shape spec/04 §8 mandates for `/api/admin/*` — `/api/admin/*` routes in THIS slice
  also don't use that shape yet either (plain `HTTPException`). Design the real
  convention once, in whichever slice needs it most (M7's editor, consuming these
  errors for real, is a natural forcing function), and reconcile every route then.
- Rotating file logging to `Storage/logs/wixy.log` (spec/04 §10) is still open —
  `logging.getLogger(__name__)` call sites exist and log correctly, but nothing
  configures the destination handler yet. Natural home: milestone 11's launcher,
  which knows the real Storage path and process lifetime.
- `/api/admin/state`'s per-page entries have no "last-modified" field (spec/05 §2's
  pages panel wants one) — deliberately omitted: computing it meaningfully (file
  mtime? last git commit touching that content file? last overlay op timestamp if
  drafted?) is a real design question with more than one defensible answer, better
  made when M7 actually builds the panel consuming it than guessed at here.
- decisions/00012 (bindings-map format) is still PROVISIONAL — nothing in M6 changed
  that; M7 remains the first real consumer that can validate or revise it.
- Milestone 6 is now fully merged (all 4 slices). Continuing into milestone 7
  (spec/05-editor.md) picks up the decisions/00012 provisional format as its first
  real test.
