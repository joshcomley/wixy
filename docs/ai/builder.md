# Subsystem: `builder/`

The pure Python library that turns templates + content JSON + theme into a static site. **No
server imports** — importable standalone (the site repo's CI installs just this package). The
same code runs for `builder build` (publish) and for the server's live preview. Normative
contract: [`spec/02-content-model.md`](../../spec/02-content-model.md).

## Public API (`builder/__init__.py`)

`import builder` re-exports: `BuildError`, `ValidationError`, `ValidationResult`;
`ProjectConfig`, `load_project_config`; `SiteSource`, `load_site_source`, `render_page`;
`Theme`, `load_theme`; `validate_site`; `build_site`, `hash_output_tree`. Ships
`builder/py.typed` (PEP 561). `mypy --strict`.

The CLI is reachable only via `python -m builder` (no console-script). The `parity`
subcommand imports from `builder.tests.parity` — that's why `playwright` and `pillow` are
**core** deps, not test-only.

## CLI (`builder/cli.py`)

Common flags (`validate`/`build`/`serve`): `--root` (site checkout, default `.`),
`--project` (**required**, path to a `projects/*.json`), `--domain` (optional, overrides the
registry's `domain` for this invocation only) and `--indexable {true,false}` (optional,
overrides the registry's `indexable` flag). Both default to `None` — omitted, the registry's
own values apply unchanged. `_load_source` applies an override via
`dataclasses.replace(project, ...)` on the loaded `ProjectConfig`; this is deliberately a
CLI-only mechanism, not an env var — see `wixy_server/registry.py`'s own
`_apply_env_overrides` docstring, which records that env-var resolution stays server-side,
keeping `builder/` env-blind (decisions/00126). Used by the site repo's GitHub Pages deploy
workflow to build with the operator's public domain + `indexable=true` while
`projects/ca.json` itself stays `ca.cinnamons.uk` / `indexable=false`.

`build` alone also accepts `--static-redirects-file <path>` (optional, default `None` —
omitted, no alias pages, unchanged from before this flag existed): a site-owned JSON map of
legacy source paths to current page paths, generating one minimal HTML redirect-alias page
per entry for hosts (GitHub Pages) that cannot serve a real HTTP redirect. See
`builder/staticredirects.py` and decisions/00136.

| Command | Does | Exit |
|---|---|---|
| `validate` | `validate_site`; `--json` prints `result.to_json_dict()`, else `[code] file:key: message` per error | `0` if `result.ok` else `1` |
| `build` | `build_site` into `--out` (default `_build`); optionally `--static-redirects-file` | `0` |
| `serve` | build once, serve `--out` on `127.0.0.1:--port` (dev; no rebuild-on-change); its handler (`_CleanUrlHandler`, decisions/00128) mirrors the production/Pages clean-URL resolution via the shared `builder.serving.resolve_site_path` | — |
| `parity` | rendered-parity check; `--serve-root` + `--slugs` required; `--rebaseline`, `--strict-screenshots` | `1` on any hard issue |

## Render data flow (`builder/render.py:render_page`)

**Page discovery** = `load_site_source` globs `pages/*.html`; each stem is a page and its
`content/<slug>.json` loads (or defaults to `{}` if absent). So a template alone registers a
page; a present-but-`meta`-less content file fails validate rather than being skipped (Inv 5).
Then per page:

`render_page(source, slug, *, mode, sink)`:
1. `page_content = source.page_contents[slug]` (missing → `BuildError`).
2. `prepare_page_body`: `templates.load_template` (parser `html5lib`) →
   `require_partial_markers` → `load_partials` → `inject_partials` at the
   `<!-- wx:partial … -->` markers.
3. `ctx = ResolveContext(page, glob=resolved_global_content(source))` —
   `resolved_global_content` copies `_global` and injects the computed `nav` (`nav.build_nav`).
4. `bindings.apply_bindings(body, ctx, mode, sink, site_root)` → recursive `_walk`, per
   element in a **fixed order**: (a) `data-wx-if` (`_evaluate_if`) — publish extracts a false
   branch and stops walking it; preview keeps it, marks `data-wx-hidden="1"`, still walks it;
   (b) `data-wx-list` (`_expand_list`) — extract the `data-wx-list-item` template, deep-copy
   per array element with `item` bound, append clones (each clone's own bindings, including
   `data-wx-img`, are re-walked independently — never shared/cached across clones); (c)
   `_apply_scalar` runs text/**attr**/img/href/bg — `data-wx-attr` deliberately runs *before*
   `data-wx-img` (decisions/00140) so an attr-authored `width`/`height` on the same tag is
   visible to `_apply_img`'s "already has width/height, don't sniff" guard, not overwritten by
   it afterward; this is a considered, one-directional trade-off — an element combining
   `data-wx-attr` and `data-wx-img`/`href`/`bg` targeting the *same* attribute for a different
   reason would now have `_apply_attrs` lose instead of win (no current template does this);
   (d) recurse into direct children. `_apply_img` additionally sniffs intrinsic `width`/
   `height` for a bound `<img>` via `builder.imagesize.probe_image_size`, using the exact same
   `is_safe_relative_src` gate and `site_root`-is-`None`/missing-file/malformed-header skip
   behavior as the `og:image` sniff below — except it never overwrites a `width`/`height`
   already present on that specific template tag (an intentional, per-slot override always
   wins, whether template-hardcoded or `data-wx-attr`-authored). `templates.apply_head` (next
   step) unconditionally injects a paired `:where(img[width][height]){height:auto}` `<style>`
   into every page's `<head>` — a zero-specificity CSS reset so a sniffed `height` can never
   distort a site's own width-only image CSS, without ever overriding a real site-authored
   height rule.
5. `_mark_nav_active(body, page_url(slug))` marks the active link in **every**
   `data-wx-list="@nav"` container (desktop + mobile — decisions/00007).
6. `templates.apply_head`: `<title>`/OG/description/fonts-link/`robots`/canonical `<link>`
   from `meta` + domain + `indexable`; `fonts_url = theme.generate_fonts_url(theme)` if a
   theme exists else `None`. The canonical link (`_find_or_create_link_rel(soup, head,
   "canonical")`) always wins over any hand-authored value in the template — single source
   of truth, same find-or-create idiom as the `og:*`/`description` meta tags. Also emits
   `og:site_name` (from `site_name` — `ProjectConfig.name`, whenever non-empty) and, only
   when `meta.ogImage` is present: `twitter:card` (`name="twitter:card"`,
   `summary_large_image` — X/Twitter reads `name=`, not `property=`), `og:image:alt` (from
   `ogImage.alt`, whenever non-empty), and `og:image:width`/`og:image:height` sniffed from
   the actual file via `builder.imagesize.probe_image_size` (decisions/00134) — resolved as
   `site_name`/`site_root` (= `SiteSource.root`, `render_page`'s new keyword args to
   `apply_head`). The width/height sniff is skipped (but `og:image` itself is unaffected)
   when `site_root` is `None`, `ogImage.src` is absolute (`/`-prefixed), contains a `..`
   segment, or the sniff itself returns `None` (missing file, unrecognized format, malformed
   header) — `probe_image_size` is a stdlib-only, Pillow-free, **never-raising** JPEG/PNG/
   GIF/WebP(VP8/VP8L/VP8X) header sniffer (builder's own `build`/`validate` path stays
   Pillow-free even though Pillow is a core dependency for the parity harness); it reads
   *stored* pixel dimensions only — EXIF orientation is never applied (decisions/00134's
   accepted limitation, since every upload-pipeline image is re-encoded by Pillow anyway).

**The `sink` parameter is the single mode switch for error handling.** `sink=None` → strict
build: the first unresolvable binding raises `BuildError` (`bindings._fail`). `sink=
ValidationResult()` → collect-and-continue: every problem is recorded and the walk proceeds.
Same code path; only the sink differs. This is why `validate` reports all errors at once.

## Full build (`builder/build.py:build_site`)

rmtree+mkdir out; render each slug in **publish** mode (`index`→`index.html`, else
`<slug>.html`, UTF-8, `\n`); write `theme.css` (if theme); copy `site.css`, `site.js`,
`images/`; write `robots.txt`; write `sitemap.xml` **only if `indexable`**; write the
generated `404.html`; then `assetcache.fingerprint_asset_references` rewrites every page's
bare `href="site.css"` / `src="site.js"` / `href="theme.css"` to `...?v=<content hash>`
in place, then `assetcache.find_unfingerprinted_asset_references` scans every page for a
recognisable-but-unrewritten reference (e.g. a leading `/` or `./` prefix the exact-match
rewrite above deliberately doesn't touch) and `build_site` raises `BuildError` if it finds
one — a publish must never silently ship an asset reference the fingerprinting missed
(decisions/00130 audit round 2, F2); then `_self_check` (every expected file exists +
parses under `html5lib`; every content-referenced image (`content.scan_image_refs`)
exists — else `BuildError`). `hash_output_tree` = sha256 over sorted `(relpath, bytes)`
(the determinism test, Inv 4).

`wixy_server/routes_public.py` serves one of these three names `public, max-age=31536000,
immutable` only once its `?v=` is VERIFIED against `content_fingerprint(resolved)` — not
merely present (decisions/00130 audit round 2, F1) — so a rebuilt asset is a new, verified
URL no cache layer can be stale for; every other asset (and a bare/mismatched request for
one of the three) keeps the unchanged `public, max-age=86400` default (decisions/00130
audit round 3, F4: the verified-match check itself is restricted to
`FINGERPRINTED_ASSET_NAMES`, so an arbitrary asset never pays the cost of a hash check
regardless of what `?v=` it's requested with).

## Validation (`builder/validate.py:validate_site`)

Runs `_validate_pages` (bindings walked in **preview** mode with a sink), `_validate_theme`
(if theme), `_validate_collections`, `_validate_images`; returns a `ValidationResult`
(never raises for content problems). Error codes: `binding-error`, `not-clean`,
`missing-template`, `no-body`, `missing-meta`, `build-error`, `bad-color`, `bad-weight`,
`missing-font-role`, `bad-collection`, `schema`, `missing-image`. `ValidationError.to_dict()`
= `{code, message, file?, key?}` — surfaced verbatim by the admin UI (see
[contracts.md](contracts.md)).

## Collections & schemas

`builder/collections.py:COLLECTION_RULES` is the fixed (not per-project-configurable v1)
table mapping `(page, dotted-path) → schema`: `_global.hours→hours`,
`_global.navExtra→nav-extra`, `index.treatments.cards→treatment-card`,
`treatments.rx.items→rx-item`, `gallery.gallery.sliders→gallery-slider`,
`gallery.gallery.tiles→gallery-tile`, `reviews.reviews.items→reviews-item`. Two shapes are
special-cased in `_validate_collections`: `treatments.json`'s `sections[].cards` (each
section's `cards` → `treatment-card`) and `_global.json`'s `footer.*` (every list under
`footer` → `footer-link`). Schemas are draft-07, `additionalProperties:false`, in
`builder/schemas/*.json`, validated by `jsonschema_lite` (a deliberate subset supporting only
`type/required/properties/additionalProperties/items/enum/pattern`, with an explicit
bool≠number/integer guard — decisions/00002; stay within the subset or checks silently
no-op).

Any collection item schema may declare an OPTIONAL `"visible": {"type": "boolean"}` property
(never `required`) — the item-level show/hide convention `_expand_list` (`bindings.py`)
implements: absent/`true` = shown, `false` = hides the item from a publish build while keeping
it reachable, marked, in preview (Inv 28). This is engine-generic — any project may opt a
collection's admin fields into a `"kind": "toggle"` field bound to `visible` (`ca.json`'s
`gallery.sliders`/`gallery.tiles` do, decisions/00117) without any change to this module.

## Admin sections (`builder/config.py`, decisions/00098)

`ProjectConfig.admin_sections: tuple[AdminSection, ...]` — a SEPARATE, per-project-configurable
registry from `COLLECTION_RULES` above, easy to conflate since both ultimately point at the same
`builder/schemas/*.schema.json` files. `COLLECTION_RULES` says "this content path must satisfy
this schema" (the write gate, decisions/00095 — applies to every write to that path, regardless
of which UI made it); `admin_sections` says "this content path also gets a DEDICATED admin nav
entry + management screen" (`admin-ui/src/sectionPanel.ts`) — a strict subset: `gallery.sliders`/
`gallery.tiles` have both (`ca.json`'s one `adminSections` entry); `_global.hours`,
`index.treatments.cards`, `treatments.rx.items`, `reviews.reviews.items` have a `COLLECTION_RULES`
entry (write-gate enforced) but no dedicated screen — still editable via the INLINE overlay's own
item toolbar only.

`AdminSection {id, nav_label, title, description, page, collections}` → `AdminCollection {path,
label, item_noun, schema, fields}` → `AdminField {key, kind: AdminFieldKind, label, options}`
(`AdminFieldKind = Literal["image", "text", "choice", "toggle"]` — `toggle` renders an on/off
switch, decisions/00117; `options` stays empty for every kind but `choice`) → `AdminFieldOption
{value, label}` — all frozen dataclasses, all optional-collection defaults `()`. `load_project_config` parses
`adminSections` LENIENTLY, mirroring the rest of this loader's defensive style: a section/
collection/field/option missing a required key, or a field with an unrecognized `kind`, is
individually skipped (`logger.warning`) rather than failing the whole project config load — one
malformed registry entry can never take down the site. Serialized camelCase into `GET
/api/admin/state`'s `adminSections` field by `routes_admin_api.py:_admin_sections_snapshot` — see
[contracts.md](contracts.md) §2 and [editor-and-admin-ui.md](editor-and-admin-ui.md)'s
`sectionPanel.ts` entry for the client side.

## Bindings map (`builder/bindings_map.py`)

`extract_bindings_map(source, slug) → PageBindings` walks the **raw template, structure only,
never values**, producing the field inventory (`key`, `kind`, nested `items`) the server
sends to the editor (as the `wx-bindings` blob) so the overlay never re-derives the contract.
Dedupe = first-DOM-occurrence-wins by `(key, kind)`; `@nav` is excluded
(`_COMPUTED_GLOBAL_KEYS`) so "is key in the map" stays a safe proxy for "is generically
editable". Shares `prepare_page_body` and `parse_attr_spec` with the real applier so the two
cannot drift. Format is **PROVISIONAL** — read decisions/00012 before changing it.

## Theme, nav, sanitize, sitemap

- **Theme** (`theme.py`): `theme_from_dict` is structurally strict (wrong shapes →
  `BuildError`) but lexically lenient (unknown color keys / font roles build fine — the exact
  vocabulary is `validate`'s job). `generate_theme_css` → `:root{ --<color>; --shadow;
  --font-<role> }`. `theme_to_dict` is the round-trip inverse the server's overlay uses.
- **Nav** (`nav.py`): `build_nav` selects `meta.inNav` pages, sorts by `(navOrder, slug)`,
  emits `{label, href}`, appends `_global.navExtra`. `@nav` is never stored (Inv, glossary).
  `href` comes from `page_url(slug)`: `"/"` for `index`, else `"/<slug>"` — extensionless
  (decisions/00128 supersedes spec/02 §3's original `/<slug>.html`). The on-disk build output
  filename is unchanged (`build.py` still writes `<slug>.html`); `page_url` only controls what
  the engine *emits* (this nav href, `apply_head`'s canonical/og:url, `sitemap.py`'s `<loc>`) —
  both URL shapes keep *resolving* on the server side, see
  [serving-and-overlay.md](serving-and-overlay.md).
- **Sanitize** (`sanitize.py`): `sanitize_rich_lite` over `nh3` — tags `a/em/strong/br/span`,
  `class` only `js-book`, schemes http(s)/mailto/tel; idempotent; applied on every draft
  write and every text render; `is_already_clean` backs the `not-clean` validate code.
  `is_safe_href` reuses the same `nh3`/scheme-allowlist machinery as a standalone check —
  `bindings.py:_apply_href` calls it on every `data-wx-href` value (Inv 29, decisions/00123).
- **Sitemap** (`sitemap.py`): `generate_robots_txt` (`Allow: /`, no `Sitemap:` directive when
  not indexable — crawl access must stay open for the per-page `noindex` meta to be
  observable at all, decisions/00135) + `generate_sitemap_xml` (sorted slugs). Indexability
  gates whether `sitemap.xml` is written.
- **Static redirects** (`staticredirects.py`, decisions/00136): opt-in only
  (`build_site`'s `static_redirects_file` keyword / CLI's `--static-redirects-file`) —
  `load_static_redirects` (flat JSON `{"/old": "/new"}` map, `BuildError` fail-fast on
  anything else, including a **duplicate JSON key** — plain `json.loads` would otherwise
  silently keep only the last value) → `validate_static_redirects` (source/target both a
  single `[a-z0-9-]+` segment or exactly `/` — `re.fullmatch`, never `match`+`^...$`, which
  would let a trailing-`\n` value slip past; source may not be `/`, may not collide with a
  real page's own output filename, and may not be the reserved `404` name or a lowercase
  Windows reserved device stem (`con`/`prn`/`aux`/`nul`/`com1-9`/`lpt1-9` — this repo's own
  dev/test environment is Windows even though the real deployment targets are Linux);
  target may not be the literal string `/index` (the homepage's real `page_contents` slug
  IS `"index"`, but its canonical URL is `"/"` — accepting `/index` would generate a page
  whose canonical conflicts with the homepage's own) and must otherwise resolve to a real
  page, which also rules out chains/loops since an alias source can never itself be a valid
  target) →
  `generate_redirect_pages` (one `<slug>.html` per entry: zero-delay `meta http-equiv=
  refresh`, `link rel=canonical` to the absolute target, a plain-language fallback
  `<a href>`, `noindex` when the build is non-indexable — no query string/fragment from the
  original request reaches the target; this is deliberately deterministic, script-free HTML
  for retired-path equivalence, not a redirect proxy). Alias pages are never added to
  `page_contents`, so they're automatically excluded from `sitemap.xml`/nav and resolve
  through the exact same `builder.serving.resolve_site_path` path a real page does — no
  special-casing anywhere else in the pipeline. Never call this an HTTP "301" or "redirect"
  in isolation — GitHub Pages cannot serve one; see `wixy_server/redirects.py`'s own
  docstring for the real, server-side 301 facility this is deliberately NOT reusing.

## Errors (`builder/errors.py`)

- **`BuildError(Exception)`** — fatal, carries `.location` (`file:key`). Raised by the
  build/render pipeline (missing template/body/content/head, bad partial markers, the first
  unresolvable binding when `sink is None`, malformed theme, self-check failures).
- **`ValidationError`** (frozen) + **`ValidationResult`** — non-fatal, collected. `.add(...)`
  accumulates; `.ok` = no errors; `.to_json_dict()` = `{ok, errors:[…]}`.

## Gotchas (see [invariants.md](invariants.md) for the numbered set)

- `dotted_get`/`dotted_set` descend dicts only — a collection resolves the *whole* array at
  its key; paths never index into arrays.
- `data-wx` text binding **replaces children with a parsed HTML fragment** (sanitized first),
  not plain-text assignment. `_apply_bg` preserves other inline styles, stripping only a
  prior `background-image`.
- Frozen slotted dataclasses (`SiteSource`, `Theme`, `ResolveContext`, `BindingField`) are
  immutable — the code copies (`dict(...)`, `deepcopy`, `dataclasses.replace`) rather than
  mutating shared state.
- Parity screenshot pixel-diff (`PIXEL_DIFF_BUDGET = 0.01`) is **advisory** unless
  `--strict-screenshots` (pinned CI platform only — font rasterization differs across OSes).
  Capture forces `.reveal` sections visible + `reduced_motion="reduce"` and strips the
  ephemeral local-server origin from resolved URLs (decisions/00005, 00006, 00008).
