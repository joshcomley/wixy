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
