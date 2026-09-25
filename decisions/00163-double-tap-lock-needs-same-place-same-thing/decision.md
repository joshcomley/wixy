# Decision

**Status:** accepted

**Scope:** `admin-ui/src/server/gestures.ts` (rewritten), `constants.ts` (three new
constants), `panel.ts` (call-site update for the API change). Test files updated to
match. Spec: `spec/server-chat/00-brief.md` §6 R3, amended to v1.7 by the Architect
(PR #256, `docs(spec): a double-tap lock needs two real taps in the same place`).

## Symptom

Operator report, round 2: "when I do a bit of rapid scrolling... or I tap one thing and
then tap another thing on a menu item... quickly... it locks the screen."

## Root cause

`createMultiTapDetector` fired `onMultiTap` (the panic-lock trigger) the moment two
primary-button `pointerdown` events landed within `MULTI_TAP_INTERVAL_MS` (400ms) of
each other, *anywhere* in the panel — no check on position, and no check on what was
tapped. Two touch points from one scroll gesture, or two taps on two different menu
rows, both satisfy that.

## What was decided (R3 v1.7, Architect ruling)

A double-tap now needs three things, the first shared with R2's single-tap-decoy-reveal
detector:

1. **A genuine TAP** (`attachTapRecognizer`, new): a primary-button `pointerdown`
   followed by its own `pointerup` (same `pointerId`), moved ≤ `TAP_SLOP_PX` (10, matching
   `messageActions.ts`'s existing long-press slop), held ≤ `TAP_MAX_MS` (300ms, well
   under the 500ms long-press threshold), never interrupted by `pointercancel` — what
   the browser fires when it takes a touch over for scrolling. A tap is recognized on
   `pointerup`, carrying the down position/target/time.
2. **SAME PLACE** (multi-tap only): each later tap in a run must land within
   `MULTI_TAP_RADIUS_PX` (32, ~5mm on a phone) of the run's *first* tap — anchored
   there, not the previous tap, so a run cannot walk across the screen.
3. **SAME THING** (multi-tap only, via `tapZoneOf`): both taps of a pair must resolve
   to the same "tap zone" — the nearest ancestor matching
   `button, a[href], [role="button"], [role="menuitem"], label, .wx-srv-bubble`, or a
   shared `null` zone for plain unmarked panel space (so two ordinary taps in open
   space still pair, unchanged from before).

The existing v1.5 gesture-boundary rules (a boundary control "may close a run, never
open one"; a chain of consecutive boundary taps needs a third to lock) are **exempt**
from parts 2/3: a boundary chain is inherently a sequence of different controls at
different positions (open a lightbox here, confirm there), so it stays gated by tap
*count* alone, exactly as before. Concretely: if either tap in a pair is a boundary
target, the pair completes unconditionally (subject to the existing chain-count logic);
only an *ordinary* pair (neither tap a boundary target) is gated by place+thing.

## Why

The operator's own framing — "very much in the same place, quite quick" — is the
correct bar for a deliberate panic gesture; timing alone conflates it with a normal
scroll's touch points. Exempting boundary-involving pairs from the new gates preserves
the pre-existing, deliberately-designed "a close action can complete a run started
elsewhere" behaviour, which two of the existing unit tests pin exactly — see "What to
watch for" for how that was caught.

## What to watch for

- Building the recognizer's radius/zone gates without exempting boundary-involving
  pairs broke two long-standing tests: "a boundary tap can complete a run that started
  on an unrelated control" and "does not lock on two taps starting at a boundary, but
  locks on the third". The fix is `gestures.ts`'s explicit `isBoundary` short-circuit
  before the place/thing check — see its own comments.
- A second bug caught the same way: the boundary-chain-continuing branch must **not**
  reuse the generic `startRun()` helper (which resets `boundaryTapCount`), or a
  three-boundary-tap chain never reaches its raised bar. Fixed by inlining the narrower
  field update that branch actually needs.
- `createMultiTapDetector`'s public API changed: `handlePointerDown(event)` →
  `handleTap(tap: RecognizedTap)`, and it no longer takes its own clock (a
  `RecognizedTap.at` already carries a timestamp from the recognizer). `TapDetector`
  changed the same way. `attachMultiTapListener`/`attachTapListener` gained an optional
  `now` parameter so `panel.ts` can still inject `win.performance.now()` for its own
  tests.
- e2e coverage lives in `e2e/tests/server-tap-precision.spec.ts` (mobile 390×844,
  `hasTouch`): a synthetic-but-real-browser scroll-shaped touch sequence never locks;
  a genuine same-spot double-tap on a message bubble still does. Verified both
  directions live against the deployed bundle before writing the final assertions —
  an early draft asserted `.wx-srv-decoy` visibility, which is meaningless (the decoy
  is always present in the DOM, merely covered by the chat overlay); the correct
  signal is `.wx-srv-thread`'s presence/count, matching the existing
  `server-chat.spec.ts` convention.
