# 00004 [r7x6uo] ChatPanel integration, idle watchdog (30s) & interaction dismissal

## What
Integrate the pixel animation engine into `admin-ui/src/chatPanel.ts`:
- 30-second idle timer: monitors user actions (mousemove, mousedown, keydown, touchstart, scroll/wheel, typing, sending messages).
- When 30 seconds elapse without interaction, the animation begins.
- If user activity resumes while animation is running:
  - Characters gracefully startle/scamper/fade out in ~300ms.
  - Canvas clears, state resets, idle timer restarts.
  - Zero disruption to chat responsiveness or bubble text selection.
- Lifecycle: `mountPixelChat(threadWrap, thread, win)` with clean `teardown()`.
- Keyboard / query param / programmatic trigger hook for instant testing.

## Why
Seamless, non-intrusive integration into Wixy admin chat panel.

## Relevant files
- `admin-ui/src/chatPanel.ts`
- `admin-ui/src/pixelChat/index.ts`
- `admin-ui/src/pixelChat/idleWatchdog.ts`

## How to continue & acceptance
Idle watchdog fires after 30s; user interaction cleanly dismisses the scene and resets the timer. Teardown removes all listeners.
