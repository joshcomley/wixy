# 00013 — Slim edit bar pinned in shell chrome (never the scrolling main)

**Status: SHIPPED — PR #111, decisions/00082.**

Operator (2026-07-22): "When the edit box appears in edit mode, the top nav
bar disappears, and unless you know to scroll up, you don't know how to find
it again - that small top nav bar on Edit should *always* be visible."

## Root cause

PR-C (00076) put the slim bar INSIDE `.wx-main` (overflow:auto) — any state
making main's content exceed its height scrolled it away (phone keyboard
viewport shrink, admin zoom >100%, over-tall iframe from applyViewport's
pre-layout win.innerHeight fallback ~35px overshoot).

## Shipped

- `.wx-edit-bar-host` row in the shell's NON-scrolling chrome (visible only
  under .wx-shell-editing); `mountEditView`'s `toolbarHost` dep mounts the
  slim bar there (back/switcher/chip/Settings/reveal travel with it).
- teardown() removes the toolbar from whatever parent hosted it.
- applyViewport drops the win.innerHeight height fallback (stylesheet
  height:100% until ResizeObserver measures).
- Verified at 390px: visible on entry, composer open, squished desktop, AND
  after forcing main.scrollTop=500.

## Incidents en route (recorded for the next agent)

- TWO decision-number collisions in one day from parallel agent sessions
  (00079 → 00080 via PR #108; 00081 → 00082 inside PR #111).
- A merge commit staged bundles + the git-mv'd decision rename but left the
  renumbered SOURCE files unstaged → CI drift (committed map had 00082 text,
  committed sources 00081). Fixed in the same PR + the peer's own 00081
  citation restored (blanket renumber had wrongly rewritten it).

## Gates

admin-ui 442→454/454, tsc strict, pytest 854, e2e 14/14, drift-reproduced-
and-fixed via LF-clone simulation.
