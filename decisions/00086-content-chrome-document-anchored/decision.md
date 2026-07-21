# 00086 — Content-anchored overlay chrome (hover chip, item toolbar) positioned in document coordinates, not the viewport

## Symptom

Operator, 2026-07-21 (third report, with screenshots): "when I select some text, and then
scroll, the outline stays in the right place but the 'text' tag isn't anchored properly to
it." The blue TEXT chip stayed frozen at the element's pre-scroll screen position while the
selection outline tracked the element perfectly.

## Root cause

The outline and the chip were anchored by two different mechanisms: the outline is a CSS
class ON the element (`.wx-hover-outline`) so it moves with the element by construction,
but the chip (`.wx-hover-chip`) and the list item toolbar (`.wx-item-toolbar`) were
`position: fixed` and pinned ONCE at hover time via `positionNear`'s viewport coordinates
(`getBoundingClientRect`). Any scroll of the preview moved the element and left the
fixed-position chrome behind — no listener ever re-anchored it (and visualViewport events,
00084's mechanism, don't fire on plain document scroll anyway).

## What was decided

Content-anchored chrome is now positioned in DOCUMENT coordinates — new
`positionInDocument(el, anchor)` in `editor/src/popovers.ts` (absolute; `rect + window.
scrollX/scrollY` at mount time), used by both the hover chip and the item toolbar
(`overlay.ts`), with the stylesheet fallback flipped to `position: absolute`. Document
coordinates make the chrome ride the page under EVERY scroll mechanism (touch, wheel,
keyboard, programmatic) with zero listeners — the same structural guarantee the outline
already had, rather than another event-wiring patch of the class that already failed once.

The flip guard moved from the viewport edge to the DOCUMENT bottom edge
(`documentElement.scrollHeight`): below-anchoring an element at the page's very bottom
would otherwise EXTEND the scroll height, and overlay chrome must never mutate layout
metrics (this file's own header rule, spec/05 §2).

**Deliberately NOT changed:** the link/image editing popovers keep `positionNear`'s
viewport anchoring. They are editor SURFACES (like the composer, decisions/00075/00084),
not labels — after a scroll they must stay reachable on screen, not ride the content out
of view. The chip/toolbar are labels/affordances: their whole meaning is "attached to
this element", so attachment wins over reachability.

## Why

Two anchoring classes exist and they must not be mixed: EDITOR surfaces (composer,
control sheets, popovers) pin to the viewport (visualPin/positionNear — reachable,
immovable); CONTENT labels (chip, item toolbar) pin to the document (positionInDocument —
attached, riding). The operator's bar is that chrome never lies about what it belongs to.

## What to watch for

- `position: absolute` resolves against the nearest positioned ancestor; the chip/toolbar
  mount on `document.body`. A site template that POSITIONS its body (or a transformed
  ancestor) would offset the pair by that ancestor's origin — both shipped sites
  (mini-site fixture, Cottage Aesthetics) have unpositioned, margin-0 bodies, and the
  fixed approach was equally broken there. If a future template positions body, compute
  the offset against `el.offsetParent` in `positionInDocument`.
- jsdom has no layout: `scrollHeight` is 0, so the doc-bottom flip is skipped in unit
  tests (`|| Infinity`) — the below-anchor path is what vitest asserts, matching
  `positionNear`'s own jsdom convention.
- The e2e (`hover-chrome.spec.ts`) must run in TOUCH contexts: a desktop mouse re-hovers
  the instant a programmatic scroll settles (the stationary pointer lands on new content),
  re-creating the chrome and poisoning any glued-to-anchor comparison. Touch tap has
  sticky-hover, so no re-hover fires. Also: the Mobile device simulation's page is short
  (~190px max scroll) — scroll by "as far as possible" and assert the MEASURED delta, not
  a fixed pixel target.
