# Edit view hides both title bars behind a slim one-line bar; device switcher truly simulates via iframe scaling

## The asks (operator, 2026-07-21)

1. In edit view, hide the main title bar AND the secondary nav (they eat the
   screen on a phone); keep a slim one-line bar: icon-only back button (→ pages
   list), device switcher LEFT, page settings RIGHT — renamed to just "Settings"
   so one row fits. The hidden chrome should slide out of view, and a
   down-chevron button (right of Settings) brings it back for ~10 seconds.
2. The top bar's vertical padding should shrink generally.
3. On a phone, mobile/tablet/desktop previews were identical (the iframe just
   filled the screen). Desktop should show a SQUISHED desktop, tablet a squished
   tablet — "do some trickery".

## Decisions

**Chrome hiding.** `handleRoute` toggles `wx-shell-editing` on the shell root
for edit routes; CSS collapses `.wx-topbar` via `max-height: 0` (plus
`min-height: 0` — min-height beats max-height in CSS, and the ≤720px block sets
one) and hides `.wx-nav`. The bar slides shut rather than vanishing.
`wx-shell-chrome-revealed` (the ▾ toggle) restores it for 10s (JS timer,
re-press hides early, route change always clears). Top bar height reduced
52px → 44px globally.

**Slim bar.** The shell builds back/Settings/reveal buttons and passes them to
`mountEditView` as opaque `toolbarLeading`/`toolbarTrailing` elements (editView
stays free of shell concerns; the theme panel's reuse of mountEditView is
unaffected — extras are optional). The old separate `.wx-edit-toolbar-row` is
gone; the device switcher moved into a `.wx-device-group` inside the same flex
row, so one line holds everything at 320px.

**Viewport simulation.** The iframe ELEMENT is sized to the device CSS width
and `transform: scale(min(1, wrapW/deviceW))`'d with `transform-origin: top
left`; its height is `wrapH/scale` so the scaled result fills the wrap. At
scale 1 on a wider wrap it stays centered (the old `margin: 0 auto` look, now
computed). A ResizeObserver re-applies on wrap resizes. First device follows
the real screen: <480px opens mobile, else desktop. Hit-testing is unaffected
(the browser maps transformed element hit regions), and overlay chrome inside
the iframe lays out at the full device width.

**Scale rides the protocol.** `setDevice` carries the scale (optional field,
absent = 1 — back-compatible with pre-scaling shells). The composer
counter-scales (`scale(1/s)`, width `100s%`, origin bottom-left) so text
editing stays legible even inside a squished simulation; other overlay chrome
(hover chips, link/image popovers) scales with the page, which is correct for
WYSIWYG inspection.

**Rejected.** Counter-scaling ALL overlay chrome (only the composer is worth
legibility guarantees; the rest is inspect-the-layout chrome); animating the
nav too (it's display:none — the top bar is the visible "title bar" the
operator means); a fixed negative-margin hide (breaks on wrapped bars — row
count varies with chip length).

## What to watch for

- `min-height` beats `max-height` — if a future breakpoint adds another
  min-height to `.wx-topbar`, the hide breaks the same way it would have at
  ≤720px.
- jsdom has no layout: `viewportScaleFor` returns 1 for a zero-width wrap, and
  mountEditView falls back to `win.innerWidth/innerHeight` when the wrap
  hasn't laid out yet.
- The ≤720px topbar rules still reference 52px min-height for the VISIBLE bar;
  the global base height dropped to 44px (mobile rules unchanged in this PR).
