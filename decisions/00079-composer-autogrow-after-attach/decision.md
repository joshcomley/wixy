# Composer auto-grow must run AFTER attach — scrollHeight is 0 while detached

## Symptom (operator report, 2026-07-21)

"The text box at the bottom when editing doesn't auto grow with the text to a
maximum height." Every composer opened as a ~16px sliver (measured:
`clientHeight` 16 for a one-line seed, still 16 for a seed wrapping to five
lines) and only grew on the first keystroke.

## Root cause (measured in Chromium against the e2e stack, not theorised)

`openComposer()` called its auto-grow `fit()` at the END of construction, while
the element was still DETACHED from the document. An element with no layout
box reports `scrollHeight === 0` (verified: detached 0, attached 319 for the
same 20-line value), so `fit()` wrote `height: 0px`; border-box flooring left
padding+border ≈ 16–18px visible with the text clipped. Only the `input`
handler re-ran `fit()`, so the box stayed a sliver until the user typed.

jsdom could never catch this: its `scrollHeight` is ALWAYS 0, attached or not,
so the unit suite's stubbed-`scrollHeight` test passed while the real browser
was broken. The regression test for this class of bug had to be a real-browser
e2e (`e2e/tests/composer-autogrow.spec.ts`).

Two further, smaller defects of the same family surfaced while fixing it:

- **border-box off-by-border**: `fit()` assigned `scrollHeight` (content +
  padding) straight to `style.height`, which under `box-sizing: border-box`
  sets the BORDER box — the last line sat permanently ~2px clipped. Fixed by
  sizing to `scrollHeight + (offsetHeight - clientHeight)` and making the
  overflow decision use that same `needed` figure (they previously disagreed
  within 2px of the cap).
- **stale fit on width change**: `setScale` changed the counter-scale width
  (rewrapping the text) without re-fitting.

## What was decided

- `fit()` no-ops when `!root.isConnected` — a detached composer keeps its
  natural `rows=1` height instead of being collapsed to 0px.
- The constructor no longer calls `fit()` at all; the `Composer` interface
  gains `refit()` (MUST be called by the caller once attached — `overlay.ts`
  does so immediately after `appendChild`) and `destroy()` (removes the window
  `resize` listener; called from the overlay's teardown path).
- `fit()` also re-runs on `setScale` (width change rewraps) and on window
  `resize` (the 20vh cap and the wrap width both move, e.g. browser-window
  resize mid-edit).

## What to watch for

- ANY sizing code that reads `scrollHeight`/`offsetHeight` on a freshly built,
  not-yet-attached element is wrong by construction — attach first, measure
  second. New overlay surfaces should follow the composer's
  refit-on-attach/destroy-on-teardown contract.
- The `~5 lines` cap constant (`MAX_LINES * LINE_HEIGHT_PX` = 100px) is a
  design approximation of 15px/1.45 text (a real 5 lines is ~125px); touching
  the input's font/padding means re-tuning it.
