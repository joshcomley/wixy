# Server chat — the good-night scene

Operator request (workspace #53): when the other person says good night, the chat
fades to a pixel-art night: black sky, twinkling stars, an owl on a branch that
blinks and looks left and right. A blown bubble floats in, captures the owl and
floats off with it. The chat comes back, keeping the twinkling stars as its
background.

## Trigger

- Fires on a **live arrival from the other person** only: `thread.handleStreamEvent`
  `message` case where `isArrival` is true, `sender !== ""`, and
  `!identity.isMine(sender)`. Never on history load, `message_updated`, own sends,
  or a message older than 120 s by `createdAt` (reconnect catch-up).
- Text match (`goodnight.ts`, exported `isGoodNight(text)`): case-insensitive,
  whole-word, punctuation/emoji tolerant: `good night`, `goodnight`, `good nite`,
  `g'night`, `gnight`, `night night`, `nite nite`, `nighty night`, `nighty nite`,
  `nightnight`. Repeated letters tolerated (`niiight`, `goooodnight`). Never `gn`
  alone, `tonight`, `last night`, `night out`. Any message containing one of the
  phrases fires (e.g. "ok good night x", "have a good night's sleep").
- At most once per 10 minutes per tab (a later match while the stars are already
  showing does nothing).

## Rendering rules (pixelart/GUIDE.md §11)

- One `<canvas>` covering the viewport (`position: fixed; inset: 0`, mounted on
  `document.body` like the view-once overlay), drawn at a low scene resolution:
  `scale = max(2, floor(innerWidth / 120))`, scene W×H = `ceil(innerWidth/scale)` ×
  `ceil(innerHeight/scale)`; CSS size = viewport; `image-rendering: pixelated`;
  `imageSmoothingEnabled = false`. Every sprite position is rounded to a whole scene
  pixel each frame. Re-layout on resize.
- Sprites come from a generated module `admin-ui/src/server/goodnight/sprites.gen.ts`
  produced by `python -m pixelart export-ts` from `pixelart/examples/goodnight/*.pxl`
  (palettes + index grids; no image files, no network). Each frame is pre-rendered
  once into an offscreen canvas at scale 1.
- Fades inside the scene use a 4×4 Bayer ordered-dither threshold (16 steps), never
  canvas `globalAlpha`. The chat UI behind fades with ordinary CSS opacity.

## Timeline (ms from trigger)

| t | Event |
|---|---|
| 0–900 | `.wx-srv-message-list` (and composer) fade to opacity 0 (CSS); sky dithers in to `#05060d` |
| 400–2400 | stars appear one by one (random positions, density ≈ 1 per 180 scene px², none under the moon), each then twinkles on its own random 2–6 s cycle |
| 800–1800 | moon dithers in, upper-left third |
| 1500–2300 | branch + owl dither in, lower-middle (owl's feet on the branch top) |
| 2300–7000 | owl `idle` animation: front hold, blink, look-left, front, look-right, front, blink |
| 6000–9000 | bubble enters from bottom-left off-screen, rising on a gentle sine sway (amplitude 6 px, period 2.4 s), `wobble` animation, ending centred on the owl |
| 9000–9500 | capture: bubble's centre locks to the owl; owl plays `look-left`/`look-right` quickly (surprised); branch stays |
| 9500–14000 | bubble + owl rise and drift up-right off the top with sway; owl plays `blink` then holds `blink-closed` (asleep) |
| 13000–14000 | branch and moon dither out |
| 14000–15000 | message list fades back in; the canvas moves to **background mode** |

Background mode: the canvas leaves `document.body` and becomes a non-interactive
starfield layer behind the thread (inside `.wx-srv-thread-wrap`, below messages,
`pointer-events: none`), sky colour + twinkling stars only, while the thread's own
background is made transparent so the stars show. It stays until the chat is
detached or locked, or the page reloads.

## Interaction & lifecycle

- Tap / click / Escape anywhere during the scene skips to background mode immediately.
- The scene suspends the idle-lock timer while playing (`hooks.suspend("goodnight")`)
  and releases it on finish/skip.
- Lock, detach and teardown remove both the scene and the background layer, cancel
  rAF and remove listeners (no leaks; tested).
- `prefers-reduced-motion: reduce`: no scene; go straight to a static background
  (stars drawn once, no twinkle).
- No sound. Nothing is sent to the server; the effect is purely local.

## Tests

- `isGoodNight` table: positives and negatives above.
- Trigger: fires on other-person live arrival; not on own, history, updates, old
  `createdAt`, or within the 10-minute cool-down.
- Lifecycle with fake timers + stubbed rAF/canvas: skip on tap, teardown on detach,
  reduced motion path, idle suspend/release.
- Pixel-grid invariant: the scene's drawing API is only ever called with integer
  coordinates (spy on `drawImage`).
