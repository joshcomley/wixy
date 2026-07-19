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
`--project` (**required**, path to a `projects/*.json`).

| Command | Does | Exit |
|---|---|---|
| `validate` | `validate_site`; `--json` prints `result.to_json_dict()`, else `[code] file:key: message` per error | `0` if `result.ok` else `1` |
| `build` | `build_site` into `--out` (default `_build`) | `0` |
| `serve` | build once, serve `--out` on `127.0.0.1:--port` (dev; no rebuild-on-change) | — |
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
4. `bindings.apply_bindings(body, ctx, mode, sink)` → recursive `_walk`, per element in a
   **fixed order**: (a) `data-wx-if` (`_evaluate_if`) — publish extracts a false branch and
   stops walking it; preview keeps it, marks `data-wx-hidden="1"`, still walks it; (b)
   `data-wx-list` (`_expand_list`) — extract the `data-wx-list-item` template, deep-copy per
   array element with `item` bound, append clones; (c) `_apply_scalar` runs text/img/href/bg/
   attr; (d) recurse into direct children.
5. `_mark_nav_active(body, page_url(slug))` marks the active link in **every**
   `data-wx-list="@nav"` container (desktop + mobile — decisions/00007).
6. `templates.apply_head`: `<title>`/OG/description/fonts-link/`robots` from `meta` + domain
   + `indexable`; `fonts_url = theme.generate_fonts_url(theme)` if a theme exists else `None`.

**The `sink` parameter is the single mode switch for error handling.** `sink=None` → strict
build: the first unresolvable binding raises `BuildError` (`bindings._fail`). `sink=
ValidationResult()` → collect-and-continue: every problem is recorded and the walk proceeds.
Same code path; only the sink differs. This is why `validate` reports all errors at once.

## Full build (`builder/build.py:build_site`)

rmtree+mkdir out; render each slug in **publish** mode (`index`→`index.html`, else
`<slug>.html`, UTF-8, `\n`); write `theme.css` (if theme); copy `site.css`, `site.js`,
`images/`; write `robots.txt`; write `sitemap.xml` **only if `indexable`**; write the
generated `404.html`; then `_self_check` (every expected file exists + parses under
`html5lib`; every content-referenced image (`content.scan_image_refs`) exists — else
`BuildError`). `hash_output_tree` = sha256 over sorted `(relpath, bytes)` (the determinism
test, Inv 4).

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
- **Sanitize** (`sanitize.py`): `sanitize_rich_lite` over `nh3` — tags `a/em/strong/br/span`,
  `class` only `js-book`, schemes http(s)/mailto/tel; idempotent; applied on every draft
  write and every text render; `is_already_clean` backs the `not-clean` validate code.
- **Sitemap** (`sitemap.py`): `generate_robots_txt` (Disallow-all when not indexable) +
  `generate_sitemap_xml` (sorted slugs). Indexability gates whether `sitemap.xml` is written.

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
