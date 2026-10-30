# Fix canvas visibility on Purdy's phone (ucpuhy)

Operator report (2026-10-30): Purdy (chat name Cupcake, device 9b22...) cannot see what she draws on a
canvas, and cannot see canvases Josh (Bubble) starts. Josh sees her canvases and drawings fine.

## Established (2026-10-30)
- Server data is correct: canvases 11297 (hers), 11314/11315/11319 (Josh's); drawings 33-37 stored.
- Her client receives and fetches everything: access log shows her GET /messages/{seq}/drawings for
  each of Josh's canvases, after every stroke.
- Her strokes on Josh's canvas 11315 anchor to it and lie inside its area, so the canvas is LAID OUT
  on her screen; it is not being PAINTED/visible.
- Her device: push via FCM (Chrome-family on Android), column 360 px (viewport ~384).
- Not reproduced: Playwright WebKit iPhone 13; Chromium Android emulation 384x700 dsf3 touch;
  dark mode; Blink forced dark; 80-message history. Scratch spec: e2e/tests/scratch-canvas-repro.spec.ts
  (env REPRO_B=chromium|webkit, REPRO_DARK=1|force, REPRO_SEED=N, REPRO_W/H).
- Operator question raised: decision #2151 (phone, browser, dark mode, what she sees).

## Next
- On #2151's answer, reproduce on that exact browser/mode, find root cause, red/green test, fix.
