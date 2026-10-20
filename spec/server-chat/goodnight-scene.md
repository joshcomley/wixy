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
  `scale = max(2, floor(min(innerWidth / 120, innerHeight / 200)))` (the height bounds it on wide screens), scene W×H = `ceil(innerWidth/scale)` ×
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

The numbers are owned by `pixelart/examples/goodnight/make_scene.py` (constants
`APPEAR`, `SETTLED`, `INTRO_END`, `BUBBLE_IN`, `CAPTURE`, `LIFT`, `GONE`, `CHAT_BACK`;
`INTRO_END` is derived from the owl's `intro` animation length). The app mirrors them in
one constants table. Operator revision 1 (2026-10-20): much slower bubble; the owl turns
its eyes, then its head nearly all the way round and back, before the bubble appears; a
gentle smile in the bubble; blue eyes.

| t (ms) | Event |
|---|---|
| 0–900 | `.wx-srv-message-list` (and composer) fade to opacity 0 (CSS); sky dithers in to `#05060d` |
| 400–2400 | stars appear one by one (random positions, none under the moon), each then twinkles on its own cycle |
| 800–1800 | moon dithers in, upper-left |
| 1500–2300 | branch + owl dither in (`APPEAR`→`SETTLED`), lower-middle, feet on the branch top |
| 2300–10680 | owl `intro` (once): eyes look left, then right; blink; head turns three-quarters → profile → back → far profile (held) → back → profile → front; blink; hold |
| 9480–18480 | bubble (`wobble`) rises from off-screen bottom-left on a slow eased path with a fading sideways sway (amplitude 8 px, period 3.4 s), ending centred on the owl (`BUBBLE_IN`→`CAPTURE`); the owl plays `watch` (looking left toward it, blinking) from `INTRO_END` |
| 18480 | capture: the bubble's centre locks to the owl; the owl plays `bubble-happy` (quick glances, then `smile-open`, then holds `smile-closed`) |
| 20680–31680 | bubble + owl float up and off to the top-right on a slow eased path with a growing sway (`LIFT`→`GONE`) |
| 30680–31680 | branch and moon dither out |
| 31680–32680 | message list fades back in; the canvas moves to **background mode** |

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
