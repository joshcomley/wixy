# Decision: fingerprint the public site's shared static assets, same pattern as decisions/00069

## Symptom

A production incident on `ca.cinnamons.uk` (Cottage Aesthetics): a CSS-only fix
(cottage-aesthetics-preview#37) was merged and the owner pressed Publish in the Wixy admin.
`live.json` correctly advanced to the new commit, the built `site.css` on disk at
`D:\Servers\Wixy\Storage\projects\ca\builds\<sha>\site.css` correctly contained the fix — and
the live site still looked unchanged. "I have published, it hasn't changed anything."

## Root cause

`site.css` / `site.js` / `theme.css` are referenced by every page under a bare, stable
filename (`href="site.css"`, never `href="site.<hash>.css"` or similar) and served by
`wixy_server/routes_public.py` with `Cache-Control: public, max-age=86400` (24h) — the same
header for every publish, forever, regardless of whether the bytes behind that exact URL
just changed.

Confirmed directly against production, not inferred: `curl -sD - https://ca.cinnamons.uk/
site.css` returned `cf-cache-status: HIT`, `Age: 5207` (~87 minutes), `last-modified:` matching
a publish from **two publishes and roughly two hours earlier** — Cloudflare's edge cache was
still serving those exact pre-fix bytes, and would keep doing so for up to 24h from when it
first cached them, regardless of how many more times the site got published in between.

This is the **exact same failure class** decisions/00069 already diagnosed and fixed for the
admin UI's own bundles (`/admin/static/*`): a deployed change invisible on a phone browser
until a manual hard refresh, root-caused to unfingerprinted URLs + a cache header with no way
to bust. 00069's fix (`wixy_server/staticcache.py`'s `FingerprintedStaticFiles` +
`fingerprinted_url`) only ever covered the admin shell's own asset references — the public
site's serving path (`routes_public.py`) is a completely separate code path that was never
brought under the same contract. Not a deliberate scope decision recorded anywhere; just a
gap — 00069's own "what to watch for" section doesn't mention the public site at all.

## What was decided

Extend the same contract to the public site's three shared assets:

1. **`builder/assetcache.py`** (new, `builder/` — no server imports, matching this repo's
   layering rule): `content_fingerprint(path)` — the same `sha256(bytes)[:10]` scheme
   `staticcache.py` already uses (deliberately identical, not reinvented) — and
   `fingerprint_asset_references(out_dir)`, which, once `site.css`/`site.js`/`theme.css`'s
   final bytes are known, rewrites every `*.html` file's `href="site.css"` / `src="site.js"`
   / `href="theme.css"` **in place** to `...?v=<hash>`, attribute-anchored (a regex on
   `(?:href|src)="<name>"` exactly) so it can never touch an unrelated bare occurrence of the
   same string (an absolute external stylesheet URL, page copy, etc.). A name with no file in
   `out_dir` (a themeless project) is left bare — nothing references it either, since the
   builder only emits that `<link>` when it actually generated the file.
2. **`builder/build.py`**: calls `fingerprint_asset_references(out_dir)` once, after every
   page + `theme.css`/`site.css`/`site.js`/`404.html` are written, before `_self_check` (so
   the check validates the true final output).
3. **`wixy_server/routes_public.py`**: `_cache_control_for` gained a `fingerprinted: bool`
   parameter. **Updated by the audit-round-2 fix below** — `fingerprinted` is only `True`
   when the request's `?v=` value is VERIFIED to equal `content_fingerprint(resolved)` (the
   resolved file's actual current hash), computed per request via `_query_fingerprint_
   matches`; presence of `?v=` alone is not sufficient (see "Audit round 2" §F1 — the
   original version of this paragraph described presence-only, which was the bug). HTML is
   unaffected either way (a stray `?v=` on an HTML request must never change ITS cache
   behavior — it's the document that *carries* the fingerprinted references, not one
   itself; the hash check is skipped entirely for `.html` paths). A verified-fingerprinted
   asset request gets `public, max-age=31536000, immutable` (safe — a match can only mean
   these exact bytes are what this URL will always mean, mirroring `staticcache.py`'s
   admin-side contract). A **bare** or **mismatched** asset request keeps the existing 24h
   default,
   unchanged — deliberately not shortened. Once fingerprinting ships, the bare URL is only
   ever hit transitionally, by an HTML page that was itself cached in the ≤300s window before
   its own cache lifetime forces a revalidation and it picks up the new fingerprinted
   references; the 24h number stops mattering in practice once that window passes, and
   shortening it would needlessly cost cache-hit-rate on images/robots.txt/sitemap.xml, which
   share the same constant and were never part of this bug.

Deliberately scoped to exactly the three shared, stable-filename assets that are genuinely at
risk (referenced under a name that doesn't change when their content does). **Not** extended
to images: gallery/before-after uploads already carry effectively-unique filenames by
convention (observed: `80b37b94-img-0636-aligned.jpg`-style names), so a same-filename
content replacement is a materially rarer event there than "the CSS changed" — a real gap in
principle, but a different-shaped problem (upload-time naming, not build-time asset
generation) and not what this production incident was about. Flagged under "what to watch
for" below rather than solved here.

## Verification

- `builder/tests/test_assetcache.py` (new): content-fingerprint determinism, attribute-
  anchored rewriting, the core regression guard (`test_content_change_changes_the_url` —
  different bytes must produce a different URL, or the whole fix is moot), absolute/unrelated
  URLs left untouched, missing-asset and no-fingerprintable-assets no-ops.
- `builder/tests/test_build.py`: `TestAssetFingerprinting` — `build_site` end-to-end on the
  real `mini-site` fixture produces a fingerprinted `site.css` reference on a real rendered
  page, an external Google-Fonts stylesheet link is never touched (exactly one `?v=` on the
  whole page), and editing `site.css` between two builds changes the URL on every page that
  references it. `test_writes_a_styled_404_page` updated to assert the fingerprinted form
  (computed via `content_fingerprint`, not a hardcoded hash) instead of the old bare one.
- `wixy_server/tests/test_routes_public.py`: a `?v=`-carrying asset request gets the
  immutable header; the pre-existing bare-request test (`max-age=86400`) is untouched and
  still passes; a `?v=` on an HTML request is confirmed **not** to change its cache-control.
- Full suite (`ruff check`, `ruff format --check`, `mypy --strict`, `pytest`, fixed `-n4`):
  green.

## What to watch for

- Images are **not** covered by this fix (see above) — a project that ever replaces an
  image's bytes while keeping its exact filename is exposed to the same 24h staleness window.
  If that pattern shows up in practice (not just theoretically), extend
  `FINGERPRINTED_ASSET_NAMES`-style handling there, or fingerprint the `images/` tree the
  same way at build time.
- The fingerprint is computed from the **built** file's bytes, at build time — correct by
  construction for `theme.css` (generated fresh every build) and for `site.css`/`site.js`
  (copied fresh every build), but it means two builds of *identical* source content always
  produce the *identical* fingerprint (good — that's what `TestDeterminism` already expects
  and continues to hold).
- This mirrors 00069 closely enough that a future third asset-serving path (there are now
  two: `/admin/static/*` and the public site) should default to the same contract from the
  start, not organically reinvent or accidentally skip it a third time.

## Audit round 2 (opus tier) — 3 findings, all fixed

Submitted for the mandatory audit this class of change requires (public HTTP contract
change, per the fleet's own driver doctrine). Cleared `sonnet-senior` (0 findings — it
independently re-ran the full verification from a clean environment rather than trusting
this doc). `opus` found three real issues, all fixed in the same PR before merge:

- **F1 (HIGH).** `_cache_control_for` originally granted `immutable` on the mere PRESENCE of
  a `?v=` query param — never checking its VALUE matched the resolved file's actual current
  hash. Consequence: a stale `?v=<old-hash>` replayed from an HTML page cached during a
  publish's ≤300s propagation window would get the file's CURRENT bytes served back
  immutably under that OLD, now-mismatched URL — poisoning it for a year against any future
  publish that legitimately reverts to the old content (an admin Restore, a theme colour
  changed back, a reverted CSS commit), with no purge mechanism anywhere to undo it. Fixed:
  `routes_public.py` now computes `content_fingerprint(resolved)` per request and compares it
  to the query value before granting `immutable`; anything else (missing, wrong, or an
  arbitrary/attacker-supplied value) falls through to the unchanged `86400s` default. This
  also generalizes the grant correctly to any file, not just the three named assets — a match
  can only ever mean "these exact bytes are what this URL will always mean," which is true
  regardless of which asset it is. **Reverted by audit round 3, F4 below** — correct in
  principle, but the generalization itself became the problem: verifying costs a
  `content_fingerprint` call, and this route is the app's one unauthenticated, catch-all
  surface, so "any file" meant an unauthenticated request could force a full read + hash of
  an arbitrary asset.
- **F2 (MEDIUM).** The rewrite silently no-ops on `href="/site.css"` or `href="./site.css"`
  — a leading-path-segment form the exact bare-string match deliberately doesn't recognise —
  with no build-time signal. Since this engine doesn't own or validate the site repo's own
  template markup, a routine template edit there could silently reinstate the original
  incident. Fixed: `fingerprint_asset_references` now returns the `{name: hash}` map it used,
  and a new `find_unfingerprinted_asset_references` (real HTML parsing via BeautifulSoup, not
  another regex) scans every page for a recognisable-but-unrewritten reference;
  `build_site` raises `BuildError` if it finds one, turning the original bug's silent,
  hours-to-notice failure mode into an immediate, loud build failure.
- **F3 (LOW).** The rewrite regex matched `href=`/`src=` as a bare substring, so it also
  silently rewrote `data-href="site.css"` (matching the tail of a longer attribute name),
  despite the docstring's claim of being attribute-anchored — harmless today only because
  this codebase's `data-wx-href` values are always content key paths, never literally one of
  these filenames, but the code's actual guarantee was weaker than its stated one. Fixed with
  a fixed-width negative lookbehind (`(?<![\w-])`) requiring a genuine attribute start.

New/updated tests for all three: `builder/tests/test_assetcache.py` (the mismatch case,
`data-href` non-touch, `find_unfingerprinted_asset_references`'s own coverage),
`builder/tests/test_build.py` (a leading-slash template reference fails the build — caught a
real test-authoring bug of my own along the way: `SiteSource.pages_dir` is fixed at
`load_site_source` time, so reusing a fixture `SiteSource` after editing files in a
*different* directory silently tests against the ORIGINAL, unedited template; the test needed
a fresh `load_site_source(edited_root, ...)` call, not just an edited `root` argument to
`build_site`), and `wixy_server/tests/test_routes_public.py` (the exact F1 replay scenario:
`?v=` present but wrong still gets the 24h default, not immutable). Full suite green: 1165
passed.

## Audit round 3 (opus tier) — 3 findings, all fixed

Cleared `sonnet-senior` again (0 findings, independently re-verified: `ruff check`, `ruff
format --check`, `mypy --strict`, full `pytest` — 1165 passed). `opus` found three more real
issues, all fixed in the same PR before merge:

- **F4 (MEDIUM).** Round 2's F1 fix was correct in what it verified, but too broad in where
  it applied: `fingerprinted` in `_serve` was computed for ANY resolved file carrying ANY
  `?v=`, with no restriction to `FINGERPRINTED_ASSET_NAMES` and no memoization. Consequence:
  an unauthenticated `HEAD`/`GET` request for an arbitrary (potentially large) public asset —
  an image, for instance — with any `?v=` value forced a full `path.read_bytes()` + sha256
  over the whole file, on the shared anyio worker threadpool, on every single request.
  Starlette sends no body for `HEAD`, so the caller pays ~0 bytes while the server pays a
  full read+hash — a real cost-amplification on the app's one unauthenticated, catch-all
  surface, and a guaranteed Cloudflare cache miss besides (a unique `?v=` per request never
  hits the edge). This is new: before decisions/00130, `HEAD` on a public asset was stat-only.
  Fixed two ways, both needed: (1) `_serve` now also requires `resolved.name in
  FINGERPRINTED_ASSET_NAMES` before calling `_query_fingerprint_matches` at all — an arbitrary
  asset never reaches the hash check regardless of its `?v=`; (2)
  `builder/assetcache.content_fingerprint` is now memoized by `(mtime_ns, size)`, so even
  repeated legitimate verification requests for an unchanged fingerprinted asset cost one
  `stat()`, not a full read+hash, after the first. The cache is keyed by server-resolved path,
  never by anything in the request, so it can't itself be grown by an attacker.
- **F5 (MEDIUM).** `docs/ai/builder.md` still described the PRE-F1 presence-only mechanism
  ("`routes_public.py` serves any `?v=`-carrying request `immutable`") and omitted the F2
  `BuildError` guard from `build_site`'s described sequence — the exact class of doc-drift
  decision #5 (below the "What was decided" section, at commit `0aa0911`) already caught and
  fixed in three OTHER docs files; this one was missed. Fixed: the paragraph now describes the
  verified-match mechanism (and its F4 name restriction), and explicitly lists the
  `find_unfingerprinted_asset_references` → `BuildError` step.
- **F6 (LOW).** `docs/ai/contracts.md`'s `/{path}` row already documented the grant as scoped
  to the three named assets — which was correct all along; F1's own write-up (above) is what
  overclaimed "any file." F4's fix makes the code match what contracts.md already said, so no
  contracts.md change was needed — recorded here only so a future reader doesn't go looking
  for one.

**F4/F5/F6 fixed in commit `bc04ad2`; re-submitted as a fresh relation (68504b38, linked to
this one) since the original had already resolved.** `sonnet-senior` found one more real
issue of its own on that commit, reading the F4 fix directly rather than trusting the diff:

- **F7 (LOW).** F4's own fix comment claimed the new cache stayed bounded to "a handful of
  `FINGERPRINTED_ASSET_NAMES` files per project" — wrong: each publish resolves those three
  names against a NEW per-publish build directory, so the cache key (a full resolved `Path`)
  differs every time, and the old build dir's entries are never looked up again once the live
  pointer moves on but were never evicted either — unbounded growth over a long-running
  server's lifetime (practically negligible in absolute terms, but the comment's claim was
  simply false, and "never evicted" is the kind of gap that's cheap to fix now and expensive
  to rediscover later). Fixed: `_fingerprint_cache` is now a real bounded LRU
  (`_FingerprintCache`, `_FINGERPRINT_CACHE_MAX_ENTRIES = 64`) — a hit moves an entry to the
  back of the eviction queue, an insert past the cap evicts the least-recently-touched entry,
  so the bound holds regardless of how many publishes accumulate.

New/updated tests: `builder/tests/test_assetcache.py` (memoization hits/misses, verified via a
`Path.read_bytes` call-counting monkeypatch — a repeat call on an unchanged file reads once, a
genuine content change reads again; F7's bound — inserting 3x the cap's worth of distinct
paths never lets the cache exceed it; and LRU-not-FIFO — a stale entry touched again survives
eviction pressure that would otherwise have dropped it), `wixy_server/tests/test_routes_public.py`
(a non-fingerprinted-name asset, e.g. `photo.jpg`, never gets `immutable` even when `?v=` is set to
its own real content hash). Full suite green.

## Addendum: the same F1 gap exists, unfixed, in the admin-side sibling

While fixing F1 in `routes_public.py`, checked `wixy_server/staticcache.py`'s
`FingerprintedStaticFiles.get_response` (decisions/00069, Inv 22 — the pattern this whole
decision mirrors) for the same class of bug. It has it: `if response.status_code == 200
and b"v=" in scope["query_string"]:` grants `immutable` on PRESENCE alone, never comparing
the value against the served file's actual current hash. The admin surface is CF-Access-
gated (Inv 12), which narrows who can exploit a deliberately-crafted mismatched `?v=`, but
the accidental-replay scenario F1 was written for (a stale fingerprint served back during a
bundle's own propagation window, later poisoned against a reverted deploy) applies exactly
the same way there.

**Not fixed in this PR** — out of scope for a public-site caching incident, and fixing it
means editing `staticcache.py` + its own test suite (`test_staticcache.py`) under a host
currently too CPU-saturated (measured 99.9%, `read-cpu` skill) to run tests reliably.
Recorded here so it isn't lost: a follow-up should add the same `content_fingerprint(path)
== requested_v` check to `FingerprintedStaticFiles.get_response`, mirroring this PR's fix
exactly. `docs/ai/invariants.md` Inv 22 and Inv 34 both now cross-reference this as a known,
outstanding gap.
