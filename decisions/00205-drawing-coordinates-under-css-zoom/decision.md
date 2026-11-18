# The pen keeps client px and layout px apart (CSS zoom)

## Symptom (operator report, 2026-10-30, workspace 60)
Purdy (iPhone, chat name Bubble) opened a canvas and drew on it but never saw her ink; she also
never saw the ink Josh drew. She did see the grey canvas box. Josh saw her canvas and her drawing.

## What was measured
- Server side was healthy: every stroke stored (drawings 33-37), and the access log shows her
  phone fetching `GET /messages/{seq}/drawings` after every stroke on each canvas.
- Her strokes anchored to the canvas and lay inside it, so the canvas was laid out on her screen.
- Her declared `columnWidth` went 390 (Sept) -> 439 (mid-Oct) -> 464 (late Oct). On a 440 px
  iPhone that is the admin's own zoom control at 90% (`wx-zoom-level` = 90; `zoom.ts` puts CSS
  `zoom: 0.9` on `<html>`; `documentElement.clientWidth` reads 489).
- Measured in WebKit and Chromium under root CSS zoom 0.9: `getBoundingClientRect` and pointer
  `clientX/Y` are zoomed (client) px; `clientWidth`, `offsetTop`, `scrollTop` and `style.left/top`
  are layout px. WebKit has no `Element.currentCSSZoom`; box width / computed width is exact to
  ~1e-8 there (Chromium's computed width is rounded to 3 decimals: ~1e-6).

## Root cause
`drawingLayer.ts` measured positions with `getBoundingClientRect` (client px) and wrote them back
as `style.top/left` (layout px), and mapped pointer deltas (client px) to draw space with a scale
built from `column.clientWidth` (layout px). Under zoom z every svg was placed at z x its true
distance from the top of the whole thread content: at 90% in a long thread, thousands of px
above the canvas, off screen. Her stored points were z x too small relative to her declared
column, so other screens showed her drawings ~10% small but on the right message - which is why
Josh "could see" them.

## Decision
One factor per frame, `cssZoom` (client px per layout px of the thread content):
`currentCSSZoom` when present, else box width / unrounded computed border-box width, else 1.
Every measured distance is divided by it before being written as a style value or compared with
a layout value (`measureFrame`, `anchorTop`, Select hit test and its 12 px reach, the two-finger
pan, the toolbar's scroll compensation). `originOf` returns scale in client px per draw px, so
pointer positions map straight into honest draw space.

Rejected: using `offsetTop` chains (integer-rounded, and every other path still needs the
factor); `offsetWidth` for the ratio (integer rounding gives ~0.2% error, i.e. ~100 px at 50 000
px down a long thread); removing the admin zoom control (it is the Uxer zoom mandate and the
only zoom the shell allows, since pinch-zoom is off).

## What to watch for
- Any new code that mixes `getBoundingClientRect`/pointer coordinates with `style` px or
  `clientWidth`/`scrollTop` is wrong under the admin zoom. Other Server-chat modules measure
  with rects too (thread.ts scroll keeping, messageActions, gameFloat, viewOnceViewer): they
  were not part of this fix and should be checked with `wx-zoom-level` != 100.
- Drawings stored by a zoomed screen before this fix keep their ~10% shrink; they cannot be
  told apart afterwards and stay on the right message, so no data migration was done.
- Tests: `admin-ui/tests/server/drawingGeometry.test.ts` (cssZoom),
  `drawingLayer.test.ts` ("under the admin's 90% zoom"), e2e `server-drawing.spec.ts`
  ("at the admin's 90% zoom ..."; red before the fix: ink ~310 px above the pen with 40 messages).
