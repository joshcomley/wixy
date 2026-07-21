# 00009 — Edit view chrome: hidden title bars + slim one-line bar + viewport scaling

**Status: design decided, not started. PR-C.**

Operator asks (2026-07-21): (a) top title bar padding reduced; (b) in EDIT view hide
the main title bar AND the secondary nav bar (slide out of view); (c) the edit
toolbar must be ONE slim line — back button (ICON only, → pages list), viewport
switcher LEFT, "Settings" RIGHT (rename from "Page settings" so it fits; today the
two rows wrap); (d) a down-chevron icon button right of Settings slides the hidden
chrome back down for ~10s then auto-hides; (e) viewport switcher must SIMULATE on a
phone — desktop shows a squished desktop, tablet squished tablet ("do some trickery").

## Design (decided)

- shell.ts: on edit route add `wx-shell-editing` class to shell root; CSS slides
  .wx-topbar + .wx-nav out (transform/max-height transition). Reduce topbar
  vertical padding globally. Reveal: `wx-shell-chrome-revealed` class for 10s
  (JS timeout; re-press hides early; cleared on route change).
- Slim bar: merge shell's `.wx-edit-toolbar-row` into editView's device toolbar —
  pass `leadingToolbar`/`trailingToolbar` elements into MountEditViewDeps (theme
  panel's reuse of mountEditView unaffected — extras optional). Back = ← icon
  button → navigateTo pages. "Page settings" → "Settings".
- Viewport scaling (editView.ts): frameWrap 100% width + overflow hidden;
  iframe width = DEVICE_WIDTHS[device], scale = min(1, wrapW/deviceW),
  `transform: scale(s)` origin top-left; iframe height = wrapH/s so the scaled
  result fills the wrap. ResizeObserver on frameWrap. Default device: mobile
  when wrap < ~480px else desktop (today: always desktop).
- Protocol: setDevice gains optional `scale: number` (both protocol.ts copies
  hand-synced + parser validation; backward compatible). Overlay uses it to
  counter-scale the composer (00007) so it stays readable in simulation modes.
- Iframe-element scaling keeps overlay hit-testing correct (browser maps
  transformed element hit regions); overlay popovers live in iframe coordinates.
- RED vitest: scale math (extract a pure computeViewportScale), protocol parser
  round-trip with/without scale. Ad-hoc Playwright verify at 390+320: squished
  desktop visible + switcher one line + 10s reveal works, dark mode.

## Files

admin-ui/src/shell.ts, editView.ts, protocol.ts (×2 incl editor), style.css,
editor/src/overlay.ts (scale state), admin-ui/tests/*, editor/tests/protocol.test.ts.
