# Pixel art for agents — the craft guide

You are an AI agent asked to make pixel art. Read this whole guide before drawing.
It tells you **how to work** (a fixed loop with tools) and **what good looks like**
(the rules pixel artists use). The file format is in [FORMAT.md](FORMAT.md); the
tool is `python -m pixelart`.

---

## 0. The one rule that matters most

**Never ask an image model for the final pixel art, and never "describe" pixels
in prose. You author the grid yourself, in a `.pxl` file, one character per pixel.**
Image generators paint *pictures of* pixel art: uneven pixel sizes, off-grid edges,
blurry anti-aliasing, dozens of stray colours, and a different character in every
frame. A `.pxl` grid cannot be off-grid or off-palette. The tools then render it,
check it, and show it back to you so you can fix it.

An image model may be used only as a **concept sketch** (§7), never as output.

---

## 1. The loop (do this every time)

```
1. BRIEF     write down: subject, canvas size, palette, light direction, animations, where it's used
2. PALETTE   pick or build a palette with ramps (§3) — before any pixels
3. SILHOUETTE block the shape in ONE flat colour; render at 1x and 2x; is it readable?
4. LINES     outline + cleanup (§4); `check` → fix jaggies / doubles / orphans
5. SHADE     apply ramps with ONE light direction (§5); `check` → fix pillow / banding
6. DETAIL    eyes, highlights, texture — sparingly
7. ANIMATE   key poses first, then in-betweens (§6); `check` → fix drift / flicker
8. REVIEW    `preview` → LOOK at the board; critique against §9; go back to the
             earliest step that's wrong. Repeat until the critique finds nothing.
```

Commands:

```
python -m pixelart new owl --size 32x32 --palette night-owl   # skeleton file
python -m pixelart check owl.pxl                              # lint; fix every warning or justify it in a comment
python -m pixelart preview owl.pxl -o owl.board.png           # then READ the PNG (you have vision)
python -m pixelart render owl.pxl --anim idle --scale 8 -o owl-idle.gif
python -m pixelart sheet owl.pxl -o owl.sheet.png             # + owl.sheet.json for the app
python -m pixelart ramp "#3f6e74" -n 5 --shift 25             # generate a hue-shifted ramp
```

Rules of the loop:

- **Render and look after every step.** Do not write 8 frames blind. Your text view
  of the grid lies to you about proportions (characters are taller than wide);
  only the rendered board shows the true shape.
- **Critique in writing** before editing: list what is wrong, with coordinates,
  then fix. "Looks good" is not a critique.
- **Work at the final size from the start.** Never draw big and shrink — pixel art
  does not survive downscaling. Never draw small and upscale.
- **Edit with override rows.** Change a frame by rewriting whole rows (`NN| ...`),
  then re-check. Count characters: every row is exactly W keys.

---

## 2. Canvas size and proportions

| Use | Size | Notes |
|---|---|---|
| UI icon | 16×16 (or 12×12) | 1-px outline, 3–5 colours, no texture |
| Small character / mascot in chat | 32×32 | head ≈ 40–50% of height for a cute style |
| Scene hero / close-up | 48×48 – 64×64 | more shading steps, still one light |
| Full scene | e.g. 160×90, 128×224 (portrait phone) | composed from sprites (§8) |

- **Leave 1–2 px of empty margin** around a sprite so outlines and animation
  (squash, bob) never touch the canvas edge.
- **Big readable features beat accurate ones.** At 32×32 an eye is 2×2 or 3×3
  pixels. A beak is 2–3 pixels. Exaggerate the thing that identifies the subject
  (an owl = big round eyes, ear tufts, round body).
- **Even vs odd widths:** a symmetric face on an even-width body has a 2-px centre;
  decide this first and keep it for every frame and every pose.

---

## 3. Palette

- **Small and deliberate:** 4–6 colours for an icon, 8–16 for a character,
  ≤32 for a whole scene. Every colour must earn its place; `check` flags unused
  and near-duplicate colours.
- **Organise colours into ramps** (dark → light lists, 3–5 steps) and declare them
  (`ramp body = 1 2 3 4`). Shade only by moving along a ramp.
- **Hue-shift the ramps.** Darker steps move toward blue/purple (cool), lighter
  steps toward yellow (warm), and saturation peaks in the middle. A ramp that only
  changes brightness looks muddy and grey. `ramp` generates this for you.
- **Shared darks:** let several ramps share the same darkest colour (often the
  outline colour) — it ties the image together and saves colours.
- **Outline colour is not pure black.** Use a very dark, slightly saturated colour
  from the scene's mood (deep navy for night, dark brown for warm scenes).
- **Contrast for the job:** UI/game icons need strong value contrast between
  neighbouring areas so they read at 1×. Mood pieces (night) can be low-contrast
  overall but must keep a value gap between subject and background.

**Night scene note (the owl):** muted teal/slate/navy ramps, very dark navy
outline, and ONE warm accent (amber/yellow) reserved for eyes and starlight. The
warm accent is the focal point; don't spend it anywhere else.

---

## 4. Lines and clusters

Pixel art is made of **clusters** (groups of same-colour pixels). Clean art has
few, purposeful clusters.

- **1-px lines, no doubles.** A line steps diagonally by touching corners, never
  with an extra pixel filling the elbow (an "L"). `check: doubles`.
- **Consistent slopes (no jaggies).** A line's horizontal runs must change length
  smoothly: `3,3,3`, `2,2,2`, `1,2,3,4` are fine; `3,1,3,1` or `1,2,1,2` read as
  broken. For curves, run lengths shrink then grow (`4,2,1,1,2,4`) — symmetrically.
  `check: jaggies`.
- **No orphan pixels.** A lone pixel that touches nothing of its colour is noise,
  unless it is a deliberate highlight/sparkle/eye-shine (give it a role named
  `highlight`, `eye-*` or `sparkle` and lint will accept it). `check: orphan`.
- **Selective outline (sel-out):** on lit edges, replace the outline with a darker
  step of the *fill's* ramp instead of the outline colour; keep the dark outline on
  the shadow side and where the sprite meets the background. This softens the
  sprite without anti-aliasing blur.
- **Outline gaps:** the outer silhouette must be closed (except where sel-out is
  deliberate). `check: outline-gap`.
- **Anti-aliasing is manual and rare.** Only on long gentle curves, one
  intermediate pixel at a step, never on the outside of a sprite that sits on
  varying backgrounds.

---

## 5. Shading

- **Pick one light direction and write it in the brief** (e.g. top-left, moonlight
  from upper right). Every frame and every sprite in a scene obeys it.
- **Shade by form, not by outline.** Light falls on surfaces facing the light;
  shadow sits on the far side and under overhangs (under the head, under wings).
- **Pillow shading is the classic beginner mistake:** dark at every edge, light in
  the centre, regardless of light direction. `check: pillow` flags it. Fix: move
  the light side's dark band to the shadow side.
- **Banding:** two shades stacked in parallel lines the same length as the outline
  look like stripes. Vary run lengths, break bands with the form. `check: banding`.
- **Few steps:** 3 shades per material at 32×32 (shadow / base / light) plus an
  optional highlight pixel or two. Dithering only for large flat areas (skies,
  backgrounds), in ordered patterns, never on small sprites.
- **Texture (feathers, fur):** suggest with a few clusters on the mid-tone along the
  form (e.g. chevrons or scallops on an owl's chest), not noise.

---

## 6. Animation

Pixel animation is **few frames, good timing, and big clear changes.**

- **Key poses first** (the extremes), then add in-betweens only if needed. Many
  great loops are 2–4 frames.
- **Timing is per frame** (`ms=`). Holds make it feel alive: a blink is
  `open 2000ms → half 60ms → closed 90ms → half 60ms`, not four equal frames.
- **Keep volume.** The sprite's pixel count may not jump between frames unless it's
  squashing/stretching on purpose (lint `volume` warns at ±15%).
- **Anchor everything.** Declare anchors (eyes, feet, perch point). Feet stay on
  the ground line unless jumping; lint reports drift. When the head turns, the
  body's outline stays still.
- **Move whole clusters, not single pixels.** One pixel toggling every frame is
  flicker (lint `flicker`). Breathing = the top 1–3 rows rise by 1 px, not a
  scattering of changes.
- **Secondary motion lags.** Ear tufts, tails and feathers follow the main motion
  one frame later.
- **Looking left/right:** shift the pupils/eye highlights and the beak by 1 px,
  and redraw the face outline 1 px toward the look direction. Hold each look
  (400–900ms), with a short in-between centre frame.
- **Sub-pixel motion:** for movement smaller than a pixel, shift colours (an edge
  pixel moves to the next ramp step) instead of moving the pixel.
- **Reuse frames.** Use `like=` with `shift=` and a few override rows, so frames
  stay identical where they should be identical.

Standard loops and frame counts:

| Loop | Frames | Timing |
|---|---|---|
| Idle breathe | 2–4 | 300–500ms each |
| Blink | 3–4 (open/half/closed/half) | long hold on open, 50–90ms others |
| Walk | 6–8 | 80–120ms |
| Hop / happy | 4–6 | anticipation squash 80, air 120, land squash 80 |
| Sparkle / twinkle | 3–5 (dot → cross → star → cross) | 80–150ms, random offsets per star |

---

## 7. Concept sketches (optional, for hard subjects)

For an unfamiliar subject or pose, you may make a reference sketch:

1. Generate a concept with an image model (`op call image-gen.generate_image`)
   asking for a flat, front-lit, simple-shape illustration on a plain background.
2. `python -m pixelart pixelize concept.png --size 32x32 --palette night-owl -o draft.pxl`
3. Treat the result as **a sketch only.** Rebuild it through the loop (§1): the
   silhouette, lines, shading and palette almost always need redrawing. Never
   ship a pixelized image unedited.

---

## 8. Characters across many sprites (the mascot)

A recurring character needs a **model sheet** (`<name>.model.pxl`), made first:

- front, side and back views (or the angles you'll actually use), same palette,
  same proportions;
- `require` rules: height/width range, required anchors (eyes, feet);
- the palette with roles (`outline`, `body-1..3`, `eye`, `beak`, `highlight`).

Every animation file then says `uses model=<name>.model.pxl` and lint checks it
against the sheet. Before a new pose, open the model board and copy proportions
from it — never redraw the character from memory.

Personality lives in **eyes, silhouette and timing**, not detail. Decide the
character's three key traits (e.g. owl: sleepy, gentle, curious) and express them
in poses and timings (slow blinks, a head tilt hold).

---

## 9. Review checklist (the critique)

Look at the preview board and answer every question in writing:

1. **Silhouette:** fill it black in your head — is the subject still recognisable at 1×?
2. **Focal point:** does the eye go to the right place first (usually the face/eyes)?
3. **Light:** is there one light direction, applied to every frame? Any pillow shading?
4. **Lines:** any jaggies, doubles, gaps, orphans? (Should match a clean `check`.)
5. **Palette:** any colour used for only one or two pixels by accident? Ramps hue-shifted?
6. **Animation:** play the GIF. Does anything jitter, flicker or slide? Are holds long
   enough to read? Does volume stay constant?
7. **Consistency:** compare with the model sheet: size, eye position, colours.
8. **In context:** render it on its real background at its real scale. Does it read?

The art is done when `check` is clean (or every remaining warning is justified in a
`#` comment next to the pixels) **and** the written critique finds nothing to fix.

---

## 10. Game and interface art

- **Icons (16×16):** one idea per icon, centred, 1-px outline, 3–5 colours, the
  same light direction and outline colour across the whole set. Draw the set
  side by side (one `.pxl` with a frame per icon) so they match in weight.
- **Panels / cards:** draw as a **9-slice**: corners fixed, edges tileable,
  centre a flat fill or a subtle ordered dither. Make corners 4–8 px.
- **Tiles / backgrounds:** must tile seamlessly — check by rendering a 3×3 repeat.
  Keep them lower in contrast and saturation than the sprites in front of them.
- **Text:** never put words inside the pixel art; the app draws text.

---

## 11. Scenes and effects in the app

When pixel art moves on screen (the good-night owl scene, game effects):

- **Render the whole scene on one low-resolution canvas** (e.g. 128 px wide) and
  scale it up by a whole number with nearest-neighbour (`image-rendering: pixelated`,
  `ctx.imageSmoothingEnabled = false`). Every sprite position is rounded to a whole
  scene-pixel each tick, so motion steps in pixels like real pixel art.
- **Never mix resolutions:** don't scale one sprite ×3 and another ×4 in the same
  scene, and don't rotate sprites at arbitrary angles (rotated pixel art turns to
  mush). Hand-draw rotated frames if needed.
- **Fades and transparency:** use stepped palette swaps or an ordered (Bayer) dither
  fade, not smooth alpha blending, inside the pixel scene. The page around it (e.g.
  the chat UI fading out) may use normal CSS fades.
- **Bubbles, glows, magic:** draw them as sprites with a highlight and rim from the
  palette (a bubble = a thin light rim, one or two specular highlight clusters, a
  faint tint, mostly transparent), animate with a 2–3 frame wobble.
- `python -m pixelart compose scene.json` previews a multi-sprite timeline as a GIF
  with exactly these rules, before you wire it into the app.

---

## 12. Worked example: the good-night owl

`examples/goodnight/` is a complete piece made by following this guide, kept as a
reference for how the loop goes in practice:

- `owl.pxl` — 32×32 mascot-style owl, 14 colours, moonlight from the upper left, blue
  eyes. Written by `make_owl.py`: every frame except `front` rewrites only the face band,
  so the body can never drift. Animations: `intro` (eyes left/right, then the head turns
  through three-quarters, profile and the back of the head to the far side and back),
  `watch`, `bubble-happy` (glances, then a gentle smile with blushing cheeks), `blink`,
  `turn`, `smile`.
- `bubble.pxl`, `star.pxl` (tagged `effect`), `moon.pxl`, `branch.pxl`.
- `make_scene.py` → `scene.json` → `previews/goodnight-scene.gif`: the whole timeline
  (`python -m pixelart.examples.goodnight.make_scene`, then `compose`).

`examples/ui/` is the interface-art counterpart: `icons.pxl` (eight 16×16 icons —
heart, star, moon, chat, lock, camera, microphone, dice — drawn as one file so they share
outline, light and weight), `panel.pxl` (a 9-slice card with 4 px corners), and
`night-tile.pxl` (a seamless background tile). `python -m pixelart.examples.ui.make_previews`
renders the icon board, the card stretched to three sizes and the tile repeated 3×3.
Geometric shapes (the star's five points, the moon's crescent) were laid out from a true
polygon / two circles first, then outlined and shaded by hand — a fine use of code, as long
as a person-style pass fixes the result.

What the review loop caught on the owl, in order — expect the same kinds of mistakes in your own
first drafts:

1. Symmetric shading (pillow-like, no light direction) — fixed by darkening the side
   away from the moon.
2. Mirrored eye highlights made the owl look cross-eyed — highlights must sit on the
   same side in both eyes.
3. Chest marks drawn as dots read as buttons — replaced with short vertical feather
   streaks.
4. Closed eyes drawn inside the eye ring read as goggles — removed the ring and used a
   gentle downward curve.
5. A first procedural branch was too dark to read against the night sky and too blocky —
   redrawn by hand with lighter bark and smooth edge run lengths.
6. `check` then found a gap in the outline under the body, a lopsided bottom curve, an
   L-corner on each ear tuft, a stray outline pixel and parallel shading bands on the belly.
7. Mirroring the right-profile head to make the left one also mirrored the lighting and
   flung the beak to the wrong edge — a mirrored frame must keep the light where it was.
8. A new pupil colour was a near-duplicate of a body shade (`near-duplicate-colours`).
