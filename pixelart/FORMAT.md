# The `.pxl` format (normative)

A `.pxl` file is UTF-8 text, one directive per line. Blank lines are ignored.
`#` starts a comment **only at the start of a line** (after optional spaces) —
`#` inside a palette hex value is not a comment.

## Header

```
pxl 1                      # required first directive: format version
name mascot-idle           # required: [a-z0-9-]+
size 32x32                 # required: WxH, each 1..256
maxcolors 16               # optional: lint error if palette (excl. transparent) exceeds it
uses model=wixie.model.pxl # optional: path relative to this file; see "Models"
```

## Palette

```
palette
  .  transparent                 # '.' is ALWAYS transparent; may be listed for clarity
  k  #1a1c2c  outline
  s  #f4b41b  skin-light
  S  #c27a12  skin-mid
end
```

- Key: exactly one printable non-space ASCII char other than `|`.
- Value: `#rrggbb` (opaque) or `transparent`. Only `.` may be transparent.
- Optional third token: role name `[a-z0-9-]+` (`outline`, `skin-1`, `eye`, …).
  Roles are how model sheets and lint talk about colours.
- Optional `ramp <name> = k1 k2 k3 …` lines inside the palette block declare a
  dark→light shading ramp (used by lint's hue-shift and banding checks).

## Frames

Full frame — header line then exactly H rows of exactly W keys:

```
frame idle-0 ms=150
................................
...
```

Derived frame — copies another frame, optionally shifts it, then overrides rows:

```
frame idle-1 ms=150 like=idle-0 shift=0,1
 12| ......kkkkk.....................
 13| .....ksssssk....................
```

- `ms=` duration in milliseconds (default 100, range 10..10000).
- `like=` must name an EARLIER frame. `shift=dx,dy` moves the copied pixels
  (vacated cells become `.`; pixels shifted off-canvas are dropped) BEFORE overrides.
- Override row: optional spaces, zero-based row number, `|`, one space, W keys.
- A frame with `like=` may have zero overrides (pure shift / timing variant).

## Anchors

```
anchor eye-l 12,10            # default for every frame (after header, before frames)
frame walk-2 ms=100 like=walk-1
anchor foot-l 11,30           # inside a frame block: per-frame value
```

Anchors are named points (x,y, zero-based, top-left origin). Lint reports
anchors that move unexpectedly between frames of one animation, and model
conformance requires the model's required anchors.

## Animations

```
anim idle = idle-0 idle-1 idle-2 idle-1 loop
anim jump = jump-0 jump-1 jump-2 once
```

Modes: `loop` (default), `once`, `pingpong`. Frames may repeat.

## Models (character consistency)

A model sheet is an ordinary `.pxl` whose `name` ends in `.model` by convention,
plus `require` directives:

```
require anchors eye-l eye-r foot-l foot-r
require height 26..28          # opaque bbox height range, every frame
require width 14..20
```

A sprite with `uses model=…` inherits the model's palette (it may not add
colours unless it also declares `palette extend`), and lint checks every frame
against the model's `require` rules.

## Tags

`tag <word>` lines (header) are free metadata for search (`tag ui`, `tag icon`).

## Rendering contract

- Every output scale is an integer; scaling is nearest-neighbour only.
- GIF output preserves per-frame `ms` (GIF stores centiseconds: rounded,
  minimum 2) and binary transparency.
- Sprite sheet: frames left→right in file order, with a JSON sidecar
  `{name, w, h, frames:[{name, x, y, ms}], anims:{name:{frames:[…], mode}}}`.

## Parsing details (resolved ambiguities)

- A `name` is `[a-z0-9-]+`, optionally followed by `.model` (so `wixie.model` is valid).
- Inline comments: whitespace, `#`, whitespace, text (`tag icon   # note`). A `#` directly
  followed by a non-space (a hex colour) or ending the line (the `#` key in a `ramp` list) is
  never a comment. In a `palette` block a line whose first token is `#` followed by a colour
  is the entry for the key `#`.
- Rows of a full frame are consumed raw (the next H non-blank lines), so a row may begin with
  `#`. Rows have no spaces.
- A derived frame inherits its parent's *per-frame* anchors, moved by its `shift=`; default
  anchors are never shifted. Anchor coordinates must lie inside the canvas.
- Default `anchor` lines must precede the first `frame`; an `anchor` after an `anim` line, or
  after any frame, belongs to the most recent frame until the next `anim`.
- `uses` must precede the `palette` block. With `uses`, a plain `palette` block may only
  repeat model entries unchanged; new colours need `palette extend`; redefining a model key to
  another colour is always an error. Ramps are inherited.
- `require` directives are checked by lint as **errors** (`model-anchor-missing`,
  `model-height`, `model-width`) for every frame, both the used model's and the sprite's own.
- A `pingpong` anim plays `a b c b` (end frames are not repeated).

## Lint conventions

- Role names with special meaning: `outline*` (outline checks), `highlight*`, `eye*`,
  `glint*`, `spark*`, `star*` (exempt from the orphan check).
- Animation drift is declared with tags: `tag drift-ok` (any), `tag drift-<anim>` (one anim),
  `tag drift-<anchor>` (one anchor). Anchors starting `foot`, `hand`, `arm`, `leg`, `tail`,
  `tip`, `wing`, `paw`, `tool`, `weapon` are treated as limbs and may move; other anchors may
  move at most 1 px, and the lowest opaque row ("baseline") may not move.

## Scenes

`python -m pixelart compose scene.json [-o out.gif]` renders several sprites on a timeline to
an animated GIF. A scene is a JSON object:

```jsonc
{
  "width": 64, "height": 48,          // canvas, 1..1024 (required)
  "background": "#101020",            // "#rrggbb" or "transparent" (default)
  "tick_ms": 100,                     // duration of one tick, 10..10000 (default 100)
  "ticks": 20,                        // number of ticks rendered (required, 1..2000)
  "loop": true,                       // GIF loops forever (default true)
  "scale": 4,                         // integer nearest-neighbour output scale (default 1)
  "layers": [                         // drawn first-to-last, later layers on top
    {
      "sprite": "mascot.pxl",         // path relative to the scene file
      "anim": "walk",                 // exactly one of "anim" (plays by elapsed time) ...
      "frame": "idle-0",              // ... or "frame" (a fixed frame)
      "x": 0, "y": 10,                // base position (default 0,0)
      "opacity": 1.0,                 // base opacity 0..1 (default 1)
      "start_tick": 0,                // anim phase offset (default 0)
      "keyframes": [                  // optional; t in ticks, x/y/opacity default to the base
        { "t": 0,  "x": 0,  "y": 10, "opacity": 0.0 },
        { "t": 10, "x": 40, "y": 10, "opacity": 1.0 }
      ]
    }
  ]
}
```

- Keyframe values are interpolated linearly per tick (the first/last key is held outside the
  range), then `x` and `y` are **rounded half up to whole pixels** for that tick.
- Opacity is never alpha blending. A sprite pixel at canvas position `(x, y)` is drawn only if
  `BAYER4[y % 4][x % 4] < round_half_up(opacity * 16)`, with the ordered 4x4 Bayer matrix
  `[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]`. Opacity 0 draws nothing, 1 draws
  everything, and each step of 1/16 adds one cell of every 4x4 block (sets are nested, so a
  fade-in only ever adds pixels). The pattern is anchored to the canvas, not the sprite, so it
  does not swim as a layer moves.
- An `anim` layer shows the frame whose cumulative `ms` interval contains
  `(tick - start_tick) * tick_ms` (looping, `once` holding the last frame, `pingpong` expanded).
- Every output pixel is an exact palette or background colour, so the GIF keeps the palette lock.
