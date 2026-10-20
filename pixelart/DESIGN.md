# pixelart — design brief (workspace #53)

Goal: a guidance package that lets an LLM agent (Claude, Codex, …) produce
grid-aligned, palette-locked pixel art — **a recurring mascot/character** and
**game + interface art** for Wixie Chat — at a quality approaching PixelLab.

## Why naive attempts fail

Diffusion image models paint *pictures of* pixel art: non-uniform "pixel" sizes,
off-grid edges, anti-aliased blur, palette drift, and every animation frame is a
fresh painting so the character wobbles. An LLM asked to "draw pixel art" has the
same problem through an image tool, and no feedback when it hand-writes art.

## Core decision: the art is authored as DATA, not as a picture

The agent writes a palette-indexed text grid. One character = one pixel = one
palette entry. It is impossible to be off-grid, blurry or off-palette by
construction. Everything else is deterministic tooling around that format, plus a
craft guide and a render → look → critique → redraw loop (agents with vision read
the upscaled preview).

## Package layout

```
pixelart/
  DESIGN.md          this brief
  GUIDE.md           the craft guide + workflow the agent follows (the "package")
  FORMAT.md          the .pxl file format reference
  __main__.py, cli.py   python -m pixelart <render|preview|check|pixelize|ramp|sheet|new>
  model.py           parse/serialise .pxl → Sprite (palette, frames, anchors, tags)
  render.py          PNG / animated GIF / sprite sheet + JSON / preview board
  lint.py            mechanical quality checks (errors + advisory warnings)
  pixelize.py        image-gen concept → grid (detect pixel scale, downsample, quantise)
  palette.py         OKLab/OKLCH colour maths, hue-shifted ramp generator, built-in palettes
  palettes/*.pal     curated palettes (hex lists)
  examples/          the proof pieces (mascot model sheet + animations, UI icons, card)
  tests/             pytest, part of the repo suite (mypy --strict, ruff)
.claude/skills/pixel-art/SKILL.md   agent entry point: when to use, workflow, commands
```

## .pxl format (summary; FORMAT.md is normative)

Line-based, LLM-friendly, diff-friendly. Sections: header (`name`, `size WxH`),
`palette` (one char → `#rrggbb` + optional role name; `.` = transparent),
`anchor` defaults, then `frame <name> [ms=<duration>] [like=<frame>] [shift=dx,dy]`
followed by either a full grid of H rows × W chars, or (with `like=`) only
override rows written `NN| <row>`. `anim <name> = f1 f2 f3 … [loop|once|pingpong]`.
Per-frame `anchor <name> x,y` (eye, foot, hand, …) enable consistency checks.
Model sheets reuse the same format; a sprite may `uses model=<file>` to inherit
and be checked against its palette and proportions.

## Lint (the quality gate)

Errors (must be zero): wrong row length / count, unknown palette char, frame refs
to missing frames, palette over the declared limit.
Warnings (each with coordinates and a fix hint, the agent must address or justify):
- orphan pixels (isolated, no same-colour 8-neighbour, low contrast to surroundings)
- outline doubles / L-corners in 1-px lines; outline gaps on the silhouette
- jaggies: staircase runs whose lengths are non-monotonic along a curve/line
- pillow shading: shade correlates with distance-to-edge, not with a light direction
- banding: parallel same-length steps of adjacent ramp shades
- unused palette entries, near-duplicate palette colours (ΔE OKLab), ramps without hue shift
- animation: baseline/anchor drift between frames, silhouette volume jumps,
  single-pixel flicker (pixel toggling every frame), frame-count/timing sanity
- model-sheet conformance: palette subset, height/width within tolerance, anchors present

## Pixelize (concept route for hard subjects)

Input: any PNG (e.g. from `op call image-gen.generate_image`). Detect the implied
pixel grid (gradient-period analysis) or take `--size`; downsample per cell by
dominant colour (mode, not mean — means invent colours); quantise to a given
palette or k-means in OKLab to N colours; key out background; emit a .pxl that the
agent then cleans by hand per GUIDE.md. It is a sketch generator, never the final art.

## Proof (acceptance)

Authored BY an agent following GUIDE.md alone, rendered and linted clean:
1. A mascot model sheet (front/side/back, 32×32) + idle (4f), walk (6–8f),
   happy/react (4–6f) animations, consistent across all.
2. Interface/game art: 16×16 icon set (≥6), a 9-slice card/panel frame, a small
   tileable background.
3. A side-by-side "before" (raw image-gen output) vs "after" (this pipeline).
The operator judges style against his reference (to be supplied in chat); the
guide is then tuned to that reference.
