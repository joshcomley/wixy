# 00007 — Editor text box → bottom-anchored growing composer (CMD-chat style)

**Status: design decided, not started. PR-B (with 00008 markdown — same code paths).**

Operator ask (2026-07-21): the inline popover is too small for long text. Make a
chat-style box ANCHORED TO THE BOTTOM of the screen, grows as you type to max
~5 lines / ~20% viewport, with a functions row and a MAXIMIZE mode for detailed
editing. Replaces both text popovers (plain + rich-lite — one unified UX; the ca
content corpus is plain text + 2 legacy `<strong>` + `<br>` uses, no rich authoring
in production).

## Design (decided)

- Lives INSIDE the overlay iframe document (editor/src), like today's popovers —
  no protocol change for basic operation. `position: fixed; left/right/bottom: 0`.
- Textarea auto-grows to max(5 lines, 20vh); functions row: B / I / Link (insert
  markdown syntax around selection — pairs with 00008), maximize/restore toggle,
  ✓ commit, ✕ cancel. Enter = newline (long text is the norm), Ctrl+Enter or ✓
  commits, Esc cancels (record in decisions entry).
- LIVE preview while typing: input event → applyValueToElement with markdown
  render (00008's renderer); cancel restores the original rendered HTML.
- Seed = demote HTML→markdown of chrome-free innerHTML (strong→**, em→*,
  a→[label](href), br→\n; span/other allowlist tags pass through verbatim).
- Counter-scale under PR-C's viewport scaling: shell sends scale in setDevice
  (protocol extension, optional field, both protocol.ts copies + parsers); composer
  renders `transform: scale(1/s)`, width `100*s%`, origin bottom-left, so it stays
  readable in squished desktop/tablet simulation on a phone.
- Rich-lite popover + wrapSelection helpers DELETED (superseded). Update
  popovers.ts/tests accordingly; keep buildLinkPopover/buildImagePopover as-is.
- RED vitest first (composer module pure logic: grow cap math, demote/promote
  round-trips, commit/cancel), then ad-hoc Playwright verify at 390+320 dark mode.

## Files

editor/src/composer.ts (new), overlay.ts (openTextPopover → composer), popovers.ts
(delete rich-lite), editor/src/markdownText.ts (new, from 00008), editor/css (bundle
styles for the sheet), protocol.ts ×2 (setDevice scale), editor/tests/*.
