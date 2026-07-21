# Unpublished-changes status bar: always visible at the very top, Publish on the right

## The ask (operator, 2026-07-21)

"Let's move the unpublished info to its own dedicated slim bar that's visible
everywhere, right at the top, even above the main nav. It should have a
publish button on the right."

## What was decided

A new `.wx-statusbar` is the FIRST element of the shell — above the topbar,
above everything — holding exactly two controls: the draft chip (left, opens
the review drawer) and the Publish button (right). It is visible on EVERY
route, including the edit view: it is deliberately NOT part of the
`wx-shell-editing` hide/reveal chrome (decisions/00076) — it is the one
constant "you have unpublished work" surface, with the publish action always
one tap away.

This REPLACES the previous arrangement end to end:

- The topbar loses both the draft chip and the Publish button (it keeps the
  title and the secondary view controls). On a phone the topbar is now just
  title + ⋯ trigger, so the long-chip row-wrap hack is gone; the chip simply
  truncates in the bar instead.
- The chip no longer relocates into the slim edit bar while editing
  (decisions/00076's `toolbarTrailing` move, and mountPanel's "move it back"
  dance, are deleted). The slim bar keeps back / device switcher / Settings /
  reveal only.
- The ≤360px CSS rule hiding the chip inside the device toolbar is gone —
  at 320px the status bar shrinks (chip truncates) and Publish stays put.
- The `.wx-publish-button` class still exists (same styling, now only in the
  status bar); both triggers remain disabled while a publish runs
  (spec/05 §5), unchanged.

E2E `publishAndWait` now clicks `.wx-statusbar .wx-publish-button` — the one
trigger that is always visible on every route (previously the chip, because
the topbar button was hidden in edit view).

## Why

Two separate workarounds existed only because the publish surface could
disappear: hiding the topbar in edit view (00076) forced the chip to shuttle
into the slim bar and back, and at ≤360px the chip vanished entirely. A
dedicated always-visible bar makes the unpublished state glanceable
everywhere — which is the point of a draft workflow — and deletes the
relocation machinery rather than adding a third special case.

## What to watch for

- Any future "hide the chrome" mode (focus modes, kiosk-style preview) must
  decide explicitly whether the status bar participates — it is NOT swept up
  by `wx-shell-editing` today.
- The chip remains the review-drawer trigger (not just a label); don't
  downgrade it to static text — keyboard/screen-reader access to the review
  flow rides on it being a button.
