# Quiet status bar: Publish button hides, bar collapses to a narrow strip

**Date:** 2026-08-02

## Symptom

With nothing to publish, the status bar kept its full banner height and still
showed the Publish button next to a chip already reading "No unpublished
changes" — dead chrome consuming vertical space on every route, all the time
(the common state for an owner who publishes right after editing).

## What was decided

When there is nothing to publish (no draft ops AND no outside site updates,
and no publish running):

1. The status-bar Publish button gets `hidden` — not merely disabled. The chip
   already says "No unpublished changes", so the button has no job; removing it
   (rather than greying it) is what lets the bar stop reserving tap-target room.
2. The bar collapses to a narrow strip: `.wx-statusbar:not(.wx-statusbar-pending)`
   drops the vertical padding (10px → 4px). Only the vertical padding shrinks —
   horizontal padding stays in step with the pending bar (including the phone
   media-query override, which the `:not()` specificity deliberately beats) so
   the label doesn't jump sideways when state flips.

Anything publishable (draft ops, or `aheadOfPublished` site updates alone)
keeps the full banner and the button. A RUNNING publish forces the button
visible even if a state snapshot already reads clean (opCount 0 while the job
finishes) — the button is the publish's progress surface (decisions/00089) and
must not vanish mid-publish.

## Why

The quiet state is the bar's resting face, seen most of the time. Its height
existed to frame the Publish tap target; with the target gone the height is
pure cost. Keeping a disabled button instead was rejected: a permanently
greyed control reads as "broken" (the same reasoning as decisions/00089), and
it can't deliver the narrow strip.

## What to watch for

- `hidden`, not removal: the element stays in the DOM (the
  chip-left/button-right structure test is unchanged), and `.wx-button-busy`'s
  `display: inline-flex` would beat the UA `[hidden]` rule — hence the explicit
  `.wx-publish-button[hidden] { display: none }`.
- The e2e pin for "Publish button visible" moved to AFTER an edit lands: with a
  shared fixture server, pre-edit visibility depends on other files' leftover
  upstream commits, so it's not pinnable either way.
- Playwright `toHaveText`/`toHaveCount` still pass on the hidden button
  post-publish; only `toBeVisible` would care.
