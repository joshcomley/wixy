---
name: pixel-art
description: Make grid-aligned, palette-locked pixel art and pixel animations (sprites, a recurring mascot/character, game and interface icons, panels, tiles, animated scenes) as .pxl text grids rendered and checked by `python -m pixelart`. TRIGGER whenever asked to draw, animate, fix or review pixel art, sprites, a pixel mascot, pixel icons or a pixel-art scene/effect — instead of asking an image model for "pixel art" (which produces off-grid, blurry, off-palette fakes).
---

# pixel-art

1. Read `pixelart/GUIDE.md` in full (the craft rules and the working loop), then
   `pixelart/FORMAT.md` (the `.pxl` file format) before drawing anything.
2. Study the worked example `pixelart/examples/goodnight/` (owl with blink/look/doze
   animations, bubble, stars, moon, branch, and the composed scene timeline).
3. Work the loop for every piece: brief → palette → silhouette → lines → shade →
   detail → animate → review, rendering and LOOKING after every step:

```
python -m pixelart new <name> --size 32x32 --palette night-owl
python -m pixelart check <file>.pxl                 # fix or justify every warning
python -m pixelart preview <file>.pxl -o board.png  # then Read the PNG and critique it in writing
python -m pixelart render <file>.pxl --anim idle --scale 8 -o idle.gif
python -m pixelart sheet <file>.pxl -o sheet.png    # + sheet.json for an app
python -m pixelart compose scene.json -o scene.gif  # multi-sprite timeline preview
python -m pixelart ramp "#3f6e74" -n 5 --shift 25   # hue-shifted shading ramp
python -m pixelart pixelize concept.png --size 32x32 --palette night-owl -o draft.pxl
```

Gotchas:
- Never ship image-model output or a `pixelize` draft unedited; it is a sketch only.
- Images over 2000 px on a side can't be Read alongside others: `preview` keeps its board
  ≤1800 px; keep your own contact sheets under that too.
- Count characters: every grid row is exactly the sprite width.
- Frames built with `like=` only report problems they introduce; fix a warning in the
  frame it is reported on.
