## Symptom

The 2026-08-12 search-indexing audit (workspace 00027,
`docs/search-indexing-implementation-brief.md`, Work package 2) found that four retired Wix
paths (`/home`, `/book-online`, `/cart-page`, `/english-privacy-policy`) 404 on the live
`cottageaesthetics.co.uk` GitHub Pages deployment. Three have a genuine equivalent on the
current site (`/home → /`, `/book-online → /treatments`, `/english-privacy-policy →
/policies`); `/cart-page` is unrelated Wix template cruft with no equivalent and stays a
real 404. `wixy_server/redirects.py`'s existing 301 facility is irrelevant here — it's a
runtime Wixy-server mechanism, and the public host is static GitHub Pages, which cannot
serve an HTTP redirect at all.

## What was decided

- New `builder/staticredirects.py`, opt-in only (`build_site`'s `static_redirects_file`
  keyword, CLI's `--static-redirects-file`) — a build given no redirects file behaves
  exactly as before this feature existed (no alias files, no new output).
- The map is a site-owned flat JSON file (`{"/old-path": "/new-path", ...}`), loaded and
  validated at build time, never at request time — there is no request time on a static
  host.
- Validation is strict-reject, never normalize (see "What to watch for"): both source and
  target must match a single shared lexical grammar — root (`/`) or exactly one path
  segment of `[a-z0-9-]+`, checked with `re.fullmatch` — plus these semantic rules: a source
  may not be `/` (the homepage already exists; it can't alias itself), a source may not
  collide with a real page's own emitted `<slug>.html` filename or the reserved `404` name,
  and a target must resolve to a real page (which, as a side effect, also rejects redirect
  chains and loops — an alias source is already proven disjoint from every real page slug,
  so it can never itself be a valid target).
- Each accepted entry generates one minimal `<slug>.html`: a zero-delay `<meta
  http-equiv="refresh">`, a `<link rel="canonical">` to the absolute target URL, and a
  plain-language fallback with a real `<a href>` — works with JavaScript disabled. Carries
  `<meta name="robots" content="noindex">` when the build is non-indexable, mirroring every
  other page (decisions/00135); omitted on an indexable build so the canonical tag can pass
  equity to the target, the entire point of this facility on the public site.
- Alias pages are never added to `SiteSource.page_contents`, so `sitemap.xml` and nav
  generation exclude them automatically — no special-casing needed anywhere else in the
  pipeline. They land in the exact same output directory as real pages, so
  `builder.serving.resolve_site_path` (the shared Pages-equivalent resolver, decisions/
  00128) resolves `/home` and `/home.html` to the alias file exactly like it would a real
  page's own `.html` output — Invariant 33 (both URL shapes resolve, trailing slash never
  does) holds for aliases with zero extra code.
- **No query string or URL fragment from the original request reaches the target.** This is
  deliberate: a static meta-refresh has no server and (by design) no script reading
  `location.search`/`location.hash` to forward. The retired Wix marketing URLs this exists
  for carry no known, mapped query/fragment semantics worth preserving — the facility emits
  deterministic, script-free HTML for path equivalence, not a general redirect proxy. This
  is a scope choice, not a security workaround: a script that appended the live location's
  search/hash onto an already-validated, fixed internal target would not itself constitute
  an open redirect (the destination's base is fixed and validated regardless), but it would
  add a script, input-propagation and encoding/testing burden, and destination-dependent
  parameter behavior for a benefit these three specific URLs don't need.
- External targets are rejected outright by the same grammar (no scheme/authority is
  representable in `/[a-z0-9-]+` or `/`) — this facility redirects to current pages on THIS
  site only, not a general-purpose redirect primitive.
- **`wixy_server`'s own publish pipeline does NOT pass `static_redirects_file`.** The brief
  explicitly left this as a separate decision ("decide separately whether the staging Wixy
  host should load the same map; public parity is useful, but do not make an unconfigured
  runtime dependency") rather than a requirement. `ca.cinnamons.uk` is the publicly
  reachable, non-indexable staging host; its admin routes are separately access-controlled
  (decisions/00135 — this is not the "private" characterization that decision corrected).
  The retired Wix paths belonged to the public-domain site, so staging parity for them isn't
  required. Wiring this in with no registry field or env var to configure it would be exactly
  the "unconfigured runtime dependency" the brief warns against. If a future need arises
  (e.g. an owner wants staging to mirror the public alias set for QA), that's a registry-field
  addition (`projects/*.json`) and its own decision, not a default behavior change here.
- `wixy_server/redirects.py` is NOT reused or extended to share code with this module,
  beyond both independently checking "is this a flat string-to-string JSON object": the two
  validate against materially different rules (this module's traversal/collision/loop/
  slug-shape checks have no server-side analogue), and `builder` takes no dependency on
  `wixy_server` (the reverse is the only allowed import direction — `builder` stays
  importable standalone, a hard constraint the site repo's CI relies on).

## Why

- GitHub Pages cannot serve an HTTP 301 — a real redirect page had to be a static file, and
  the meta-refresh + canonical pattern is Google's own documented approach for exactly this
  constraint (<https://developers.google.com/search/docs/crawling-indexing/301-redirects>).
- Strict-reject over normalize closes a real, confirmed class of bug: `re.match` combined
  with `^...$` anchors lets a value like `"/home\n"` pass in Python (`$` matches immediately
  before a trailing newline) — confirmed empirically during review. Any "clean up the input"
  behavior risks the same kind of evasion for a different malformed shape; rejecting outright
  is the only version of this check that can't be quietly wrong.
- Checking source collisions against the actual emitted filename (not just the raw
  content-model slug) makes the check correct by construction against what the build
  literally writes to disk, not an assumption about how slugs and filenames relate.
- Keeping this a pure, generic builder capability (no Cottage-Aesthetics-specific string
  anywhere in `staticredirects.py`) matches Invariant 1 — the actual three-entry map and the
  `.github/workflows/pages.yml` wiring that passes it belong entirely in the site repo.

## What to watch for

- **Live GitHub Pages behavior is not yet verified** — this decision covers the engine
  mechanism only. Proof that `/home` etc. actually resolve on the real public site requires
  the site repo's own PR (the map + workflow wiring) merged, and then an owner Publish (which
  advances `wixy-live`, triggering the Pages rebuild) — an owner-gated action this session
  does not trigger itself. Do not report this as "live-verified" until that's actually run
  and checked with real HTTP requests against `cottageaesthetics.co.uk`, not just against
  this repo's own `resolve_site_path`/dev-serve.
- Do not "fix" `re.match`+`^...$` back in anywhere in this module for convenience — always
  `re.fullmatch` (or an equivalent full-string check with no `$`-anchor exception). Inv 36
  names this explicitly.
- The grammar deliberately supports only single-segment paths (`/[a-z0-9-]+` or `/`) — no
  nested paths (`/blog/old-post`). Nothing in the current engine's page model supports nested
  page slugs either, so this isn't an artificial restriction; extending it would need its own
  design pass (output subdirectory creation, collision checking against a directory rather
  than a flat namespace) rather than a quiet grammar relaxation.
- If a future entry ever needs query/fragment forwarding, that's a new, separate design
  decision (weigh the added script/testing/maintenance surface against the actual need) —
  don't bolt it onto this module's existing "deterministic, script-free" contract without
  updating this decision and its docs.
