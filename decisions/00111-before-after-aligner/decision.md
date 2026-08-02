# Decision: the before/after aligner — owner-driven pair alignment, baked to a new upload

## Symptom

2026-08-02, Purdi (the site owner), of a before/after pair she had just added:

> "So the one I just added, the lips are in different positions and I can't see how I can
> move the image so they match up like the others? Do I just ask the chat?"

Two handheld photos of the same face are never framed identically. The gallery slider
renders both with `object-fit: cover` in a fixed 640:360 frame, so a pair taken minutes
apart shows the features in different positions — the one class of polish she could not
apply herself. Every other pair on the page had been aligned by hand (by an agent with an
image editor) before upload.

## What was decided

A full-screen **aligner** in the Before & After editor (the registry-configured section
panel, decisions/00098), opened from a **"Line up photos"** button on each photo-pair
card AND from the add flow's final step (the exact moment she hit the wall):

- **Drag with a finger** to move the photo (pointer events, `touch-action: none`),
  **pinch** (or the zoom slider) to resize, **tilt buttons** to straighten (±0.25°,
  clamped ±10°), and a **micro pad of arrows** for the final ≈1-display-pixel nudges
  (with long-press repeat) — the operator's explicit ask: "use the fingers … and then
  with a micro movement button to just do the micro adjustments at the end".
- **Blend view** (the moving photo see-through over the reference — onion-skin) for
  aligning features, **Split view** (the live widget's own wipe) for checking the result.
  A **Move** toggle picks which of the two photos the controls drive; either or both can
  be adjusted in one save.
- On save, each adjusted photo is **baked on an offscreen canvas at 1920×1080** (the
  frame's exact aspect) and uploaded through the **ordinary media pipeline**
  (`api.uploadMedia` — draft-staged, content-hash-named, q85 re-encode, EXIF-stripped),
  and the item's `{src, alt}` is swapped for the new upload in the standard whole-array
  draft op. The **original photo stays in the media library** untouched (the dialog says
  so, in plain English, because she was nervous to try).

## Why baking, not stored CSS offsets

The alternative considered was storing per-image `{x, y, zoom, rotate}` in content JSON
and rendering via `object-position`/transform: that needs a content-schema change
(`gallery-slider.schema.json` is `additionalProperties: false`), a builder binding to emit
it, a site-template restructure (a scale transform on the clipped before-image would move
the clip edge — zoom would have to move to a new wrapper layer), site CSS/JS changes, and
parity-fixture churn — a cross-repo change for the same visible result.

Baking needs **none of that**: the aligner canvas at the registry's frame aspect is
pixel-identical to what the live frame's `object-fit: cover` shows, so what she aligns is
exactly what publishes (WYSIWYG by construction), the site stays plain static files, and
the whole feature lands in the engine repo in one PR. The costs are accepted knowingly:
JPEG generational loss on repeated re-bakes (mild at q92→q85, and the original is always
still in the library to start over from), and a baked crop can't be "zoomed back out"
past what was kept (same recovery path — the original).

## Key mechanics (engine-generic, Inv 1)

- The frame aspect is **registry config, not a site literal**:
  `projects/ca.json`'s `gallery.sliders` collection declares `"alignAspect": "640:360"`;
  `builder/config.py` parses it (`AdminCollection.align_aspect`), `/api/admin/state`
  mirrors it, and the panel offers the aligner only for collections with `alignAspect`
  set AND ≥2 `image` fields.
- All geometry lives in `admin-ui/src/alignerModel.ts` (pure, unit-tested): cover-fit,
  and the one rule everything hangs on — **the drawn image must always cover the whole
  canvas**, or a gap would bake into the photo as a border. Identity (no adjustment) is
  exactly the site's own rendering and always covers; every gesture is clamped back into
  coverage by bisection.
- Two deliberate **auto-compensations** so no button ever feels dead: a nudge that would
  gap an edge is paid for with a tiny auto-zoom (`withPanCompensated` — otherwise ←/→ do
  literally nothing at zoom 1 on a width-limited photo), and a tilt is paid for the same
  way (`withRotationCompensated` — a plain clamp would bisect the tilt itself back to
  ≈0°). A tilt that no zoom can hold (deep pan + max zoom) is refused, never baked.
- The bake keeps the side's **alt text** (same photo, re-framed) and names the upload
  `<original-stem>-aligned.jpg`; the pipeline's content-hash naming dedupes identical
  re-bakes for free.

## Also in this change

`e2e/fixture_server.py` + `e2e/playwright.config.ts` read `WIXY_E2E_PORT` (default
8799): two agent sessions on one box kept colliding on the fixed port mid-suite (found
live while verifying this feature) — parallel runs now pick distinct ports. CI is
unchanged (no env var → 8799).

## What to watch for

- If a site's frame aspect ever stops being a single fixed ratio (e.g. responsive
  aspect changes per breakpoint), one `alignAspect` no longer describes it — the baked
  photo matches the DECLARED aspect and the frame re-crops the difference. Keep the
  registry value in sync with the site template's CSS.
- jsdom has no canvas: the dialog guards painting on `getContext` returning null and
  image loading is an injectable dep — unit tests cover the model + wiring only; the
  real drag/bake/publish path is e2e (`section-panel.spec.ts`'s align journey).
- The aligner currently exists only on the section panel (the "Before & After editor"
  the operator named), not the inline overlay on the gallery page — a deliberate scope
  call; the overlay path would need a new `alignRequest` protocol message mirroring
  `mediaRequest`.
