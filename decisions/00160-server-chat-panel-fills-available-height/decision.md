# Decision

**Status:** accepted

**Scope:** `admin-ui/src/server/lock.css` (`.wx-srv-panel`) only. No other file changed.

## Symptom

Operator report (round 2, 2026-09-25, screenshot): the Server chat panel didn't fill the
admin's available vertical space — a visible gap below the last message, before the
composer, and below the panel as a whole.

## Root cause

`.wx-srv-panel { min-height: 60vh }` is a floor, not a fill. `.wx-main` (`style.css`) is
`flex: 1` inside `.wx-shell`'s flex column (`height: 100dvh`), so it always has a definite
own height — but a plain block child of an `overflow: auto` container does not inherit or
stretch to that height on its own; it only gets *at least* what `min-height` says. Measured
live (Playwright, `getBoundingClientRect`) against the unmodified code:

| Viewport | `.wx-main` available height | `.wx-srv-panel` height (60vh floor) | Gap below the panel |
|---|---|---|---|
| 1280×900 desktop | ~786px (826px box − 2×20px padding) | 540px | ~246px |
| 402×870 phone | ~762px (786px box − 2×12px padding) | 522px | ~240px |

The gap reproduced on both, always around 240–250px, because 60vh of an ordinary browser
window undershoots `.wx-main`'s real content height by roughly that much — the admin's own
chrome (status bar, topbar) is a small fraction of the viewport, so `.wx-main` is close to
the full viewport height while 60vh is only 60% of it.

The AI chat already solved the identical problem: `.wx-chat-conversation-view` (`style.css`,
decisions/00110) is `height: 100%` on the same kind of direct `.wx-main` child, which
resolves against `.wx-main`'s definite flex-established height per the CSS percentage-height
rule. `.wx-srv-panel` never adopted that pattern for its own OUTER box — chat.css's `flex: 1`
chain (`.wx-srv-chat` → `.wx-srv-thread-view` → `.wx-srv-thread`) was already correct
*inside* `.wx-srv-chat-host` (`position: absolute; inset: 0`, so it fills whatever height
`.wx-srv-panel` itself ends up being); the defect was entirely at the outermost box.

## What was decided

`.wx-srv-panel` now uses `height: 100%` instead of `min-height: 60vh` — the same pattern
`.wx-chat-conversation-view` uses. Verified live at the same two viewports after the change
and a rebuild: `.wx-srv-panel`'s bottom edge now lands exactly at `.wx-main`'s padding
(20px desktop, 12px phone) with zero remaining gap, at both a desktop and phone width.

## Why

`height: 100%` is the direct fix for "fill the available height of a definite-height
ancestor", already proven correct and shipping for the AI chat panel — not a `min()`/hybrid
compromise, since `.wx-main`'s height is always definite in the real app (the shell always
establishes `height: 100dvh`) so there is no genuinely-short-viewport case that needs a
smaller floor. The decoy (also inside `.wx-srv-panel`, when the chat isn't unlocked) is
short, normal-flow content that already floats near the top of a taller box under the old
min-height rule; a full-height box under it looks exactly as plausible as a real "server
status" page and is not a behaviour change for it.

## What to watch for

If a future context ever mounts `.wx-srv-panel` somewhere other than as a direct child of
`.wx-main` (or `.wx-main` stops being a definite-height flex item), `height: 100%` would
collapse to 0 — re-verify with the same Playwright geometry check, not just visually.
