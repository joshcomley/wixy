# Pixel art authored as data (workspace #53)

## Symptom
The operator's attempts to get AI-made pixel art for Server chat "just weren't coming
out" right: image models paint *pictures of* pixel art — uneven pixel sizes, off-grid
edges, anti-aliased blur, palette drift, and every animation frame a new painting.

## Decision
- Agents author pixel art as `.pxl` text grids (`pixelart/FORMAT.md`): one character =
  one pixel = one palette entry. Off-grid / off-palette output is impossible by
  construction. Image models may only make concept sketches (`pixelize`), never output.
- Quality comes from a fixed loop in `pixelart/GUIDE.md` (silhouette → lines → shade →
  animate → review) with a mechanical gate (`python -m pixelart check`) and a visual one
  (`preview` board the agent reads back with vision). Repo skill: `.claude/skills/pixel-art`.
- Character consistency by construction: `make_owl.py` writes every frame as override
  rows of one base pose's face band, so the body cannot drift.
- In-app scenes (the good-night owl, spec/server-chat/goodnight-scene.md) draw on one
  canvas at a low scene resolution scaled by a whole number,
  `scale = max(2, floor(min(innerWidth/120, innerHeight/200)))`. The height term matters:
  a width-only rule gave 10-16x pixels on desktop and an owl filling the window.
  Fades inside the scene are 4x4 Bayer dither, never alpha.
- Sprites reach the app as a generated TS module (`pixelart export-ts` →
  `admin-ui/src/server/goodnight/sprites.gen.ts`), drift-guarded by a pytest; the
  timeline constants live in `pixelart/examples/goodnight/make_scene.py` and are mirrored
  in `timeline.ts` (a vitest compares every tick with `scene.json`).

## Watch for
- Pillow's `quantize(palette=…)` is approximate: near-identical colours swap. The GIF
  writer repairs every mismatched pixel exactly (`render._repair_exact`); don't remove it.
- The checker's warnings are advisory: fix or justify each in a `#` comment. Use
  `tag effect` for twinkles/wobbles rather than loosening lint thresholds.
- Mirroring a frame also mirrors the light direction — mirrored frames must keep the
  lit edge where it was.
