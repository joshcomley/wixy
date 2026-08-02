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

## Two latent bugs this exposed (fixed in the same change)

Hiding the button on `opCount === 0` made two pre-existing undercounts
FUNCTIONAL (they were cosmetic while the button was always there) — the
media-edit E2E caught the first immediately:

1. **`/api/admin/state`'s `draft.opCount` counted only `overlay.ops`.** Staged
   page adds/deletes and staged media replacements/deletions produce no ops,
   so the chip read "No unpublished changes" over genuinely publishable work —
   and with the button hidden, a staged media replacement became unpublishable
   from the bar. The publish PREVIEW's opCount already had the right formula
   (decisions/00071/00080); state now uses the same one (content ops + staged
   page adds/deletes + staged media replacements/deletions).
2. **The media panel never refreshed shell state.** Staging a replacement
   isn't a draft PATCH, so no `refreshStateInBackground` fired and the bar
   stayed stale until the 60s revalidation. `mediaDialog`'s grid deps gained
   `onChanged` (fired by the detail sheet's `act()`, grid delete, and
   uploads); `mountMediaPanel` passes it through; the shell wires it to
   `refreshStateInBackground`.

## What to watch for

- `hidden`, not removal: the element stays in the DOM (the
  chip-left/button-right structure test is unchanged), and `.wx-button-busy`'s
  `display: inline-flex` would beat the UA `[hidden]` rule — hence the explicit
  `.wx-publish-button[hidden] { display: none }`.
- **The button starts hidden at construction, not just after the first state
  load.** The initial synchronous paint must already be the quiet state:
  painting it visible and hiding it when loadState landed made the whole page
  jump down-then-up mid-layout (and raced the mobile popover geometry E2E,
  which measures the ⋯ trigger box pre-click and the popover box post-click —
  a state load landing BETWEEN the two measurements moved the page 25px and
  failed the assertion on Windows font metrics; CI's faster state load masked
  it). The quiet strip is the correct default look anyway — the button is
  useless before state loads.
- A page DUPLICATE counts as 2 by design (decisions/00024 stages a PageAdd +
  a navLabel SET op) — the state's opCount deliberately matches the preview's
  established formula rather than deduplicating.
- The e2e pin for "Publish button visible" moved to AFTER an edit lands: with a
  shared fixture server, pre-edit visibility depends on other files' leftover
  upstream commits, so it's not pinnable either way.
- Playwright `toHaveText`/`toHaveCount` still pass on the hidden button
  post-publish; only `toBeVisible` would care.
- Any FUTURE publishable mutation that isn't a draft PATCH must fire the
  shell's state refresh (via a panel `onChanged`) or the bar lies for up to
  60s — the media panel is the template.
