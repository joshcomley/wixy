# The slim edit bar pins in the shell chrome, never the scrolling main

## The complaint (operator, 2026-07-22)

"When the edit box appears in edit mode, the top nav bar disappears, and
unless you know to scroll up, you don't know how to find it again — that
small top nav bar on Edit should *always* be visible."

## Root cause

PR #100 (decisions/00076) put the slim edit bar (back / device switcher /
Settings / reveal) INSIDE `.wx-main`, which scrolls (`overflow: auto`).
Any state that makes main's content exceed its height scrolls the bar out
of reach — phone keyboard opening (visual viewport shrink), admin zoom
>100%, or an over-tall iframe from `applyViewport`'s pre-layout
`win.innerHeight` fallback (measured overshooting the wrap by ~35px). The
exact trigger on the operator's phone is one of those; the bar living in a
scrolling container is the defect class, and fixing the class beats
explaining each trigger.

## Decision

The bar now pins into the shell's **non-scrolling chrome**:
- A new `.wx-edit-bar-host` row sits between the topbar and the body
  (sibling of both, visible only under `.wx-shell-editing`).
- `MountEditViewDeps.toolbarHost` — when provided, `mountEditView` mounts
  its toolbar there instead of inside the edit view's root (which then
  holds only the iframe). The leading/trailing extras (back, draft chip,
  Settings, reveal) travel with it unchanged.
- `teardown()` removes the toolbar from whatever parent hosted it, so no
  stale bar lingers on other routes.
- `applyViewport` no longer falls back to `win.innerHeight` for height —
  an unlaid-out wrap keeps the stylesheet's `height: 100%` until the
  ResizeObserver has a real measurement (kills the overshoot class).

Rejected: `position: sticky` on the bar inside main (still lets the bar be
pushed/mis-measured by layout states, and reads as the patch it is);
reverting to always-visible topbar (the operator likes the collapsed
chrome — they only want the SLIM bar anchored).

## What to watch for

- The draft chip's reparenting logic (`mountPanel` moves it back to the
  topbar on non-edit routes) keys off `chipEl.parentElement !== topbar` —
  that still works with the chip inside the hosted toolbar, but any future
  "where is the chip" assumption must not hardcode the topbar OR main.
- The fake `mountEditView` in shell tests mirrors `toolbarHost` + teardown
  removal — keep it in step if the real mount's toolbar handling changes.
