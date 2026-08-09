# Production bug: vertical swipe on before/after images hijacks page scroll — DONE

Not part of any planned task — the operator reported live, mid-session, right after the
gallery-blank incident (00010) was fixed: a vertical swipe starting on a before/after slider
image got captured by the slider instead of scrolling the page.

## Root cause (measured, not assumed)

`.bas-frame`/`.bas-range` (site repo `site.css`) were styled `touch-action:none` — this hands
EVERY touch gesture over the element to JavaScript, disabling native browser scrolling
entirely, not just the intended horizontal drag-to-compare interaction.

## Fix

Changed `touch-action:none` to `touch-action:pan-y` on both elements — lets native vertical
panning proceed while still claiming horizontal gestures for the slider's own drag handling.
cottage-aesthetics-preview PR #30 (merge commit `b2c5815`). Full rationale + verification:
site repo decisions/00011.

Verified via genuine touch-event simulation (Chrome DevTools Protocol
`Input.dispatchTouchEvent`, not synthetic DOM events): red confirmed against the unfixed code
first (a vertical swipe left `scrollY` unchanged and moved the slider value 15 points instead);
green after (page scrolls correctly at 100/300/600px swipe distances, slider value held at
exactly zero drift once a real confound — `site.js`'s own unrelated auto-nudge demo animation
overlapping the test's timing — was found and controlled for).

## What to watch for

`touch-action:none` is occasionally correct for genuinely two-axis custom gesture handling —
not a default to reach for on a single-axis control. Any future slider/drag control should
default to `pan-x`/`pan-y` (whichever axis it doesn't use) and be verified with real
touch-event simulation, not a mouse-drag test (mouse events don't exercise `touch-action` at
all).

*(This sidecar was written retroactively — the fix itself shipped, was verified, and was
operator-confirmed in the prior session; only the todos record was missing. Closed as a small
housekeeping item alongside the category-management feature, per that session's own handover.)*
