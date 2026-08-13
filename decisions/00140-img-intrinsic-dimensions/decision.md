## Symptom

`docs/search-indexing-implementation-brief.md` Work package 4B ("Add intrinsic image
dimensions"): the public site's rendered `<img>` elements carry no `width`/`height`
attributes, so the browser cannot reserve their layout space before the file loads —
the homepage's measured mobile Lighthouse baseline flagged this as a CLS/layout-shift
risk. The brief names the fix directly: "A generic Wixy solution may post-process
bound local `<img>` elements using the existing `builder.imagesize.probe_image_size`;
preserve explicitly authored dimensions and gracefully skip remote/draft/unreadable
images."

## What was decided

- `builder/bindings.py:_apply_img` (the `data-wx-img` binding handler) now sniffs the
  bound image's intrinsic pixel dimensions from the real on-disk file, via the same
  `builder.imagesize.probe_image_size` sniffer `templates.py`'s `og:image:width`/
  `height` already uses (decisions/00134) — no new sniffing logic, one reused
  never-raising, Pillow-free, stdlib-only JPEG/PNG/GIF/WebP header reader.
- `apply_bindings` (and the private `_walk`/`_expand_list`/`_apply_scalar`/`_apply_img`
  chain beneath it) gained a `site_root: Path | None = None` keyword, exactly mirroring
  `apply_head`'s existing `site_root` parameter and its "`None` skips the sniff, the
  rest of the binding is unaffected" contract. `render_page` and `validate.py`'s
  `_validate_pages` both pass `site_root=source.root` (`SiteSource.root`, the on-disk
  site checkout) — every real build and every `validate` dry-run gets the sniff;
  standalone unit tests calling `apply_bindings` directly without `site_root` keep
  their existing behavior unchanged (default `None`).
- **The safety gate that decides whether a `src` is even safe to join onto
  `site_root`** (`templates.py`'s private `_is_safe_relative_src`) moved to
  `builder/imagesize.py` as a public `is_safe_relative_src`, so `bindings.py` reuses
  the exact same check rather than a second, driftable copy of it — the same
  "one shared implementation, not a copy per caller" discipline
  `render.py:prepare_page_body`'s docstring already names for `bindings_map.py`
  (decisions/00012). `templates.py` now imports it instead of defining it locally; no
  behavior change to the existing `og:image` sniff.
- **This one gate is also what satisfies the brief's "gracefully skip remote/draft/
  unreadable images" requirement, with no separate draft-media-aware logic needed.**
  `docs/ai/media.md` fixes the shape of every draft/staged-media src as
  `/admin/draft-media/<name>` — always `/`-prefixed. `is_safe_relative_src` already
  rejects any `/`-prefixed src (it would make `site_root / src` replace `site_root`
  entirely rather than join under it — the same reasoning decisions/00134 already
  established for the drive-letter/UNC cases). So a draft-staged image simply never
  reaches the sniff, without `bindings.py` needing any awareness of `wixy_server`'s
  storage layout — "do not... couple preview-only staged media into a pure builder
  path" (the brief's own words) falls out of the existing gate for free. A remote
  `http(s):`/other-scheme URL is rejected by the same gate's `":" in src` check.
  "Unreadable" (missing file, unrecognized format, truncated/malformed header) is
  `probe_image_size`'s own existing never-raising contract — returns `None`, which
  the caller treats identically to "gate rejected the src."
- **An explicitly authored `width`/`height` on the specific template `<img>` tag is
  never overwritten.** Checked (`el.has_attr("width") or el.has_attr("height")`)
  *before* any disk access — a template author may have deliberately sized a
  fixed-aspect-ratio slot (e.g. a gallery tile) independent of whichever image
  happens to be bound there; the sniff only fills a gap, never second-guesses an
  intentional value. This is the brief's explicit "preserve explicitly authored
  dimensions."
- **Each `data-wx-list` clone is sniffed independently.** `_expand_list` already
  deep-copies the item template and re-walks each clone through the same `_walk` →
  `_apply_scalar` → `_apply_img` chain with its own `item` context — no change was
  needed here beyond threading `site_root` through, since the existing per-clone walk
  already guarantees no shared/cached state between list items with different `src`
  values. Verified explicitly by a dedicated test (two list items with different
  on-disk image dimensions, asserting neither clone reads the other's).
- Applies identically in `publish` and `preview` mode — the sniff is orthogonal to
  the `mode` parameter (unlike `data-wx-if`'s publish-extracts/preview-marks
  behavior); `validate_site`'s preview-mode walk exercises the exact same code path
  a real build would, so `validate` and `build` never disagree about whether a given
  image would get dimensions.

## Why

Reusing `imagesize.py`'s sniffer and the safety gate (rather than writing new
dimension/path logic for `data-wx-img`) keeps this a small, low-risk change built
entirely from already-shipped, already-tested primitives — the only genuinely new
code is the `site_root`-threading plumbing and the "don't overwrite an authored
value" check. Moving the safety gate to a shared, public home rather than
duplicating it is this repo's own established discipline (decisions/00012):
`bindings.py` and `templates.py` now can never drift into two different definitions
of "safe to join onto `site_root`."

## What to watch for

- A future project needing a different override rule for authored dimensions (e.g.
  always re-sniffing even over an explicit value, or a per-project config knob) needs
  its own decision — this PR's rule (authored value always wins, checked before any
  disk access) is not configurable and should not become so via a quiet edit.
- If `wixy_server`'s draft-media URL shape (`docs/ai/media.md`) ever stops being
  `/`-prefixed, `is_safe_relative_src`'s rejection of it would silently stop working
  — re-verify this invariant's "no separate draft-awareness needed" reasoning against
  the media doc before touching either.

## Addendum: graded-audit findings, fixed before merge (2026-08-13)

The genuinely fresh opus-tier graded audit (once the audit-infra fault was fixed)
found one critical and one low finding, fixed across two rounds:

- **CRITICAL — a sniffed `height` can distort a site's own width-only image CSS.**
  HTML `width`/`height` attributes are CSS *presentational hints* — a site rule that
  constrains only `width` (e.g. `img{width:100%}`, no `height` rule at all, exactly
  what the real Cottage Aesthetics `site.css` does for `.about img`/`.ba-tile img`)
  lets a newly-present `height` attribute pin a hard pixel value, stretching the
  image out of its real aspect ratio — precisely the "without distorting CSS layout"
  outcome the brief's own WP4-4B text warned against, and confirmed empirically
  against the real deployed site and images (`purdi.jpg`, 891×1280, rendering
  504×724 today vs. 504×1280 — a 1.77× stretch — once width/height attributes land
  without a guard).
  - **First fix (round 2) was itself incomplete, per the audit's own re-review:** a
    zero-specificity `:where(img[width][height]){height:auto}` CSS rule appended to
    the written `theme.css` file closed the gap for a real `build_site` output, but
    missed two real cases the audit caught: (1) `wixy_server/routes_preview.py`'s
    live admin preview calls `render_page` directly per request — the width/height
    attributes are live in that HTML the moment the engine deploys, but `theme.css`
    itself is only regenerated by the next real `build_site` (a Publish), so preview
    would keep showing the distortion until the owner's next Publish, an activation-
    timeline lag this repo's own decisions/00137 already names for a different
    mechanism; (2) a themeless project (`SiteSource.theme is None`, Inv 5's own
    supported partial-migration shape) never gets a `theme.css` written at all, so it
    got no guard whatsoever despite `_apply_img` still sniffing dimensions for it.
  - **Durable fix (round 3):** moved the guard into `templates.py:apply_head` as an
    inline `<style data-wx-guard="img-dim">` tag, injected unconditionally (theme or
    not) on every `render_page` call — the same function `render_page` calls for
    both `build_site` (publish) and `routes_preview.py` (live preview), so the guard
    is now atomic with the width/height attributes in both lanes, with no build-
    artifact lag and no theme dependency. Find-or-create by the `data-wx-guard`
    attribute, matching this file's existing idiom, so a hypothetical repeated
    `apply_head` call never duplicates the tag.
- **LOW — a `data-wx-attr`-authored `width` could pair with a sniffed `height`.**
  `_apply_scalar` ran `_apply_img` before `_apply_attrs`, so a *dynamically*
  authored width (via `data-wx-attr="width:.someKey"`, as opposed to a template-
  hardcoded one) was invisible to `_apply_img`'s "already has width/height" guard —
  `_apply_img` would sniff+set both width and height first, then `_apply_attrs`
  would overwrite only width afterward, pairing an authored width with a sniffed
  height (the same aspect-ratio-distortion class the CSS guard exists for, via a
  different binding-order path). Fixed by reordering `_apply_scalar` so
  `data-wx-attr` runs before `data-wx-img`. **Deliberate, documented trade-off:**
  this makes `data-wx-attr` win over `data-wx-img`/`href`/`bg` for the same
  attribute on the same element, the opposite of the previous (undocumented,
  accidental) precedence — no current template combines them this way, so nothing
  regresses today, but this is now the documented, load-bearing order (`docs/ai/
  builder.md`'s render-data-flow section), not something to casually re-shuffle.

**Deliberately not fixed in this PR** (flagged, not silently dropped): the admin
preview overlay's client-side image-swap interaction doesn't clear a previously-
sniffed `width`/`height` when a new image is picked (a stale aspect-ratio box until
the iframe next reloads) — that's `editor/` TypeScript code, a different module and
language, out of this engine-side PR's scope. `probe_image_size` reading whole files
once per bound `<img>` on the interactive admin preview path is a real, measured
cost (149 images / 18.4 MB on one gallery-page render) but the durable fix needs a
caching-strategy design decision (per-request memoization vs. a build-scoped cache)
bigger than this PR calls for.
