# 00001 — Before/after aligner (k7m2x9)

**Status: DONE (in this workspace's PR — see git log / decisions/00109).**

## What was asked

Operator, relaying Purdi (2026-08-02): "So the one I just added, the lips are in
different positions and I can't see how I can move the image so they match up like the
others? Do I just ask the chat?" — implement an alignment feature in the before/after
editor she can manage herself: fingers (drag) or slider or buttons, ideally fingers plus
a micro-movement button for the final adjustments.

## What shipped

- `admin-ui/src/alignerModel.ts` — pure geometry: cover-fit placement, the
  always-covers-the-canvas invariant (a gap would bake as a border), bisection clamping,
  `withPanCompensated`/`withRotationCompensated` (edge-breaking nudges/tilts are paid
  for with a tiny auto-zoom so no button ever feels dead).
- `admin-ui/src/alignerDialog.ts` — the full-screen dialog: one-finger drag, pinch zoom,
  zoom slider, tilt buttons (±0.25°, clamp ±10°), micro arrow pad (long-press repeat),
  Blend (onion-skin) / Split (live wipe) views, Move before/after toggle, keyboard
  arrows, plain-English error path. Save bakes each adjusted side at 1920×1080 on an
  offscreen canvas → `api.uploadMedia` → item's `{src, alt}` swapped (alt preserved,
  original left in the library). jsdom-safe (`getContext` null guard, injectable
  `loadImage`).
- `admin-ui/src/sectionPanel.ts` — "Line up photos" on cards (only when the collection
  has `alignAspect` + ≥2 image fields + both photos picked) and in the add-flow form
  step; result commits as the standard whole-array op. `SectionPanelDeps.openAligner`
  is the test seam.
- Registry: `AdminCollection.align_aspect` (builder/config.py, lenient "W:H" parse),
  mirrored by `/api/admin/state` as `alignAspect: {w,h}|null`; `projects/ca.json`'s
  `gallery.sliders` declares `"alignAspect": "640:360"` (the live frame's CSS).
- e2e/fixture_server.py + playwright.config.ts: `WIXY_E2E_PORT` override (default 8799)
  — two agent sessions on one box collided mid-suite on the fixed port (found live
  verifying this); parallel runs now coexist. `WIXY_E2E_PYTHON` was already required on
  Windows (python3 = Store stub).

## Verification

- 38 aligner unit tests (model geometry + dialog wiring) + 7 panel wiring tests; full
  admin-ui suite 629 green; typecheck strict green.
- Python: config parse tests + the `/api/admin/state` snapshot test updated (alignAspect
  round-trip); 17 green on the touched files; full suite run in CI.
- e2e `section-panel.spec.ts` third journey: add pair → Line up photos → real mouse-drag
  on the canvas → micro nudge → Save (real bake + real upload pipeline) → draft PATCH →
  publish → live `/gallery.html` serves the `*-aligned.jpg`. Green locally on
  WIXY_E2E_PORT=8801.
- Bundle rebuilt (`npm run build`) and committed — the e2e fixture serves the COMMITTED
  static bundle; a stale bundle was the one real red herring during verification (the
  "Line up photos" button simply didn't exist in it).

## Follow-ups (none blocking)

- The inline overlay editor on the gallery page has no aligner entry point (deliberate
  scope: the section panel IS "the before and after editor"; overlay would need a new
  `alignRequest` protocol message).
- Tile (single-image) collections get no aligner — a free-crop tool would be a
  different feature.
