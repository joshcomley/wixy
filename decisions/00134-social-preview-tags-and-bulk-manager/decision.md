## Symptom

Two operator asks about the WhatsApp/Facebook/X link preview for `ca.cinnamons.uk`:

1. `builder/templates.py:apply_head` emitted `og:title`/`og:description`/`og:type`/
   `og:url`/canonical/`og:image` but never `twitter:card` (X shows a small or no card),
   `og:image:width`/`og:image:height` (Facebook/LinkedIn's *first* fetch of a fresh URL
   renders less reliably before their crawler re-checks the image), `og:image:alt`
   (already stored in content JSON, never emitted), or `og:site_name` (the registry
   already has `name: "Cottage Aesthetics"`).
2. The only way to see/change a page's social image was `pageSettingsDrawer.ts`'s
   per-page "Social image" field — one page at a time, seven page-visits to audit the
   whole site.

## What was decided

**Workstream A (builder):**

- New `builder/imagesize.py` — a **stdlib-only** (`struct` + byte parsing, zero new
  dependencies), **never-raising** `probe_image_size(path) -> (w, h) | None` covering
  JPEG (SOF0-SOF15 excluding DHT/JPG/DAC), PNG (IHDR), GIF, and WebP (VP8/VP8L/VP8X).
  `builder/` stays Pillow-free on its actual build/render path by policy — the site
  repo's CI installs just this package, and that lightness is load-bearing — even
  though Pillow is already a *core* dependency for the parity harness's screenshot
  diff (`config.py`'s docstring). Verified byte-for-byte against Pillow-produced
  ground truth for real JPEG (baseline + progressive) and all three WebP subtypes
  during development (not part of the shipped test suite — Pillow-authored fixtures
  would reintroduce exactly the dependency this module exists to avoid; the shipped
  `test_imagesize.py` uses hand-crafted byte strings instead, each documented with
  the exact header layout it targets).
- **Accepted limitation:** dims are the file's *stored* pixel dimensions — EXIF
  orientation is never applied. Every image the upload pipeline produces is
  re-encoded by Pillow anyway (orientation already baked in); a hand-placed legacy
  image carrying rotation metadata could at worst get width/height swapped in the
  hint tags, which crawlers tolerate. Documented in the module docstring.
- `SiteSource` gained a `root: Path` field (the on-disk site checkout — `render_page`
  already had this via `load_site_source`'s own `root` parameter, just never stored
  it) so `apply_head` can resolve a relative `ogImage.src` for the dimension sniff.
- `apply_head` gained required `site_name: str` + `site_root: Path | None` params.
  New emissions: `og:site_name` (`property=`, whenever `site_name` is non-empty,
  independent of `ogImage`); and, **only when `meta.ogImage` is present**:
  `twitter:card` (`name="twitter:card"` — X/Twitter reads `name=`, not `property=`,
  the one tag in this set that isn't an `og:*`/`property=` tag — content
  `summary_large_image`), `og:image:alt` (from `ogImage.alt`, whenever non-empty),
  and `og:image:width`/`og:image:height` (sniffed via `site_root / ogImage.src`).
  The width/height sniff is **skipped** (but `og:image` itself is always emitted,
  verbatim-joined, unchanged) when `site_root` is `None`, `ogImage.src` starts with
  `/`, or any path segment is `..` — `_is_safe_relative_src` in `templates.py` gates
  the filesystem join specifically, not the tag itself; the preview server's draft
  build (`site_root` = the git checkout) simply gets `None` back from the sniff for
  an image staged in `draft/media/` but not yet published, which is correct (no
  crawler ever sees a CF-Access-gated preview) rather than a bug.

**Workstream B (admin-ui):** a new `/admin/social` route + `socialImagesPanel.ts` —
every page in one table (thumbnail, page label, "Choose image"), plus a "Use one
image for all pages" bulk action. Entirely frontend: no new server routes, no schema
change. Each row independently fetches `api.getContent(slug)` and reads it via the
**exact same exported `readMeta`** `pageSettingsDrawer.ts` already uses (one parsing
implementation, not two) rather than trusting `state.pages[].meta` — which today
*does* already carry the full `meta` object including `ogImage`
(`routes_admin_api.py`: `"meta": content.get("meta", {})`) and would have avoided the
N parallel fetches, but relying on that would couple this panel to an incidental
shape of `PageSummary` rather than the same explicit, already-established read path
every other admin surface that touches `meta.ogImage` uses; a state snapshot can also
be a moment stale relative to a concurrent AI-chat edit. Both pick paths enqueue
`{file: slug, path: "meta.ogImage", value: {src, alt}}` on the shell's single
`OpQueue`, storing `src` exactly as the media dialog returns it — repo-relative, no
leading slash added. Entry point is a "Social images" button in the Pages panel's
header row, not a new top-level nav item (nav space is deliberately tight, per
`shell.ts`'s own `NAV_ROUTES` comment).

## Why

- Root-causing the preview issue means emitting the complete, correct tag set once
  in the single place (`apply_head`) that already owns every other `<head>` tag —
  not a one-off script or a template hand-edit.
- No new dependency for a feature this narrow (reading two integers out of an image
  header) — matches this module's existing `jsonschema_lite.py` precedent
  (decisions/00002) for "implement the actual subset needed, skip the library."
- A frontend-only bulk screen needs no server changes because `meta.ogImage`'s shape
  and the draft-op write path were already generic; the gap was purely "no UI
  surfaced every page's value in one place."

## What to watch for

- **`builder/tests/fixtures/mini-site/images/{hero,icon}.jpg` are NOT real images.**
  They are 11-byte ASCII placeholders (the literal text `"placeholder"`), unchanged
  since the very first builder commit (`2df9bab`) — confirmed via `git show`. Nothing
  else in the suite decodes their bytes (the parity harness screenshots the
  *rendered page*, never opens these files), so this was always harmless — until this
  change, which needed a *real* image to test the width/height sniff's success path.
  **Do not "fix" these fixtures into real image bytes** — the mini-site's `index`/
  `about` pages render `hero.jpg`/`icon.jpg` as a CSS background and an `<img>`
  (`hero.bg`, `showcase.items[].img`), and both are captured by
  `builder/tests/parity/test_parity.py`'s screenshot pixel-diff against committed
  baselines; swapping in real image bytes would change rendered pixels and could
  force a baseline regeneration for reasons unrelated to whatever future change
  prompted it. The width/height-sniff-succeeds test path
  (`test_og_image_dims_present_for_real_image_on_disk` in `test_render.py`) instead
  writes a real Pillow-generated JPEG to a `tmp_path` and calls `apply_head`
  directly — the same "minimal soup, direct call" shape
  `test_canonical_link_overwrites_hand_authored_href` already used, now factored
  into the `_rendered_head` helper both share. The fixture's placeholder-ness is
  itself now a locked-in regression test
  (`test_og_image_dims_absent_for_non_image_fixture_file` /
  `test_real_fixture_images_are_placeholders_not_real_images`).
- `apply_head`'s `site_name`/`site_root` params are **required**, not optional —
  every direct caller (there are exactly two: `render_page`, and one test in
  `test_render.py` that builds its own soup) must pass both explicitly.
- If a future page ever needs `og:image` without triggering the width/height sniff
  (e.g. a deliberately external/CDN image URL that never lived under `site_root`),
  `_is_safe_relative_src`'s absolute-path branch already covers a `/`-prefixed or
  full URL-shaped `src` — no new gate needed, just confirm the src truly can't
  resolve under `site_root` by accident.
