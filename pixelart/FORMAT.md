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
