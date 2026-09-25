// Two independent tap detectors, both fed by one shared TAP RECOGNIZER and both excluding the
// same set of targets (`isExcludedTapTarget`):
//
// - R3's multi-tap-inside-the-chat-view-locks detector (`createMultiTapDetector`
//   / `attachMultiTapListener`) — R2 v1.3 (operator decision #974,
//   spec/server-chat/00-brief.md §6), precision revised by R3 v1.7 (operator report, round 2,
//   2026-09-25: rapid scrolling or tapping two different menu items in quick succession was
//   locking the chat). `panel.ts` attaches this to `document` in the capture phase for the
//   lifetime of the mounted panel, and only its "chat"/"fading" states give the resulting event
//   any meaning (lockModel.ts) — it has NO meaning on the decoy.
// - R2 v1.3's single-tap-on-the-decoy-reveals detector (`createTapDetector` /
//   `attachTapListener`) — a plain single qualifying tap, no counting. A tap
//   on the affordance itself within `MULTI_TAP_INTERVAL_MS` of the reveal is
//   a SEPARATE debounce `panel.ts` owns directly (see its own note), not
//   part of this detector.
//
// R3 v1.7 (Architect ruling): a double-tap is two real TAPS, in the SAME PLACE, on the SAME
// THING, quickly. Three parts, all below, the first shared by BOTH detectors:
//
// 1. What counts as a TAP (`attachTapRecognizer`): a primary-button `pointerdown` followed by
//    its OWN `pointerup` (same `pointerId`), moved <= `TAP_SLOP_PX`, held <= `TAP_MAX_MS`, never
//    interrupted by `pointercancel` — what the browser fires when it takes a touch over for
//    scrolling. Flicks, drags and long-presses (>= `messageActions.ts`'s 500ms action-sheet
//    delay) are therefore never taps. Recognized on `pointerup`, carrying the DOWN position/
//    target/time (a plain radius/duration check against DOWN vs UP is spec-equivalent to
//    tracking every intermediate `pointermove` and simpler, so `pointermove` is not used here).
// 2. SAME PLACE (`createMultiTapDetector` only): each later tap in a run must land within
//    `MULTI_TAP_RADIUS_PX` of the run's FIRST tap — anchored there, never "the previous tap", so
//    a run cannot walk across the screen.
// 3. SAME THING (`createMultiTapDetector` only, via `tapZoneOf`): both taps of a pair must
//    resolve to the same tap zone (the nearest interactive/message ancestor, or the shared
//    "panel background" zone). Two different menu rows, or a bubble and the gap next to it,
//    never pair even a few px apart.
//
// The v1.5 gesture-boundary rules (a boundary tap "may close a run, never open one", and a
// boundary-initiated chain needs a THIRD boundary tap to lock) are UNCHANGED in meaning and are
// deliberately exempt from parts 2/3 above: a boundary chain is inherently a sequence of
// different controls (open a lightbox here, confirm there), so it is gated by tap COUNT instead
// of position — see `createMultiTapDetector`'s own comments.
//
// R3's precision requirements, all load-bearing:
// - Pointer Events ONLY, never mixed with touch/mouse listeners on the same
//   root (a synthetic touch + its compatibility mouse events + a real
//   pointer event for one physical tap would triple-count).
// - `performance.now()` for timing, not `Date.now()` — Playwright's
//   `page.clock` intercepts `performance.now()`, so e2e specs get
//   deterministic control over the interval boundary.
// - Attached in the CAPTURE phase, so a tap inside a `stopPropagation()`'d
//   child (a dialog, a drawer) is still counted — every tap while the panel
//   is mounted must be seen, not just ones that bubble.

import { MULTI_TAP_COUNT, MULTI_TAP_INTERVAL_MS, MULTI_TAP_RADIUS_PX, TAP_MAX_MS, TAP_SLOP_PX } from "./constants";

const EXCLUDED_SELECTOR = "textarea, input, [contenteditable], audio, video";
export const GESTURE_BOUNDARY_SELECTOR = "[data-srv-gesture-boundary]";

/** R3 v1.7's "SAME THING" test: the nearest ancestor a tap is meaningfully "on". A message
 * bubble and the ordinary interactive controls a chat already has; anything else (empty thread
 * space, the panel's own background) falls back to `null` — one shared zone, so two taps in
 * open space (today's baseline behaviour) can still pair. */
const TAP_ZONE_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], label, .wx-srv-bubble';

/** Exported for direct unit testing — no DOM event plumbing needed to check
 * the exclusion rule itself. */
export function isExcludedTapTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EXCLUDED_SELECTOR) !== null;
}

export function isGestureBoundaryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(GESTURE_BOUNDARY_SELECTOR) !== null;
}

/** `null` means "the panel background" — a single shared zone, not "no zone" — so two ordinary
 * taps in empty space are still considered the SAME thing. */
export function tapZoneOf(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest(TAP_ZONE_SELECTOR);
}

/** A completed, genuine tap (R3 v1.7 part 1) — carries the `pointerdown` position/target/time,
 * the ones a pairing decision is made from. */
export interface RecognizedTap {
  readonly target: EventTarget | null;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

interface TapCandidate {
  readonly downAt: number;
  readonly downX: number;
  readonly downY: number;
  readonly target: EventTarget | null;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** The shared plumbing behind both `attachMultiTapListener` and `attachTapListener`: recognizes
 * a genuine tap (R3 v1.7 part 1) from raw Pointer Events on `target`, in the capture phase, and
 * calls `onTap` once per completed one. One in-flight candidate per `pointerId`, so an
 * unrelated second pointer (a stray second finger) can't corrupt the first's tracking. `now`
 * defaults to the real `performance.now()`; unit tests inject a fake clock. Returns a
 * teardown. */
function attachTapRecognizer(
  target: EventTarget,
  onTap: (tap: RecognizedTap) => void,
  now: () => number = () => performance.now(),
): () => void {
  const candidates = new Map<number, TapCandidate>();

  function handlePointerDown(event: Event): void {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    candidates.set(event.pointerId, {
      downAt: now(),
      downX: event.clientX,
      downY: event.clientY,
      target: event.target,
    });
  }

  function handlePointerMove(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    const candidate = candidates.get(event.pointerId);
    if (candidate === undefined) return;
    if (distance(event.clientX, event.clientY, candidate.downX, candidate.downY) > TAP_SLOP_PX) {
      candidates.delete(event.pointerId);
    }
  }

  function handlePointerUp(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    const candidate = candidates.get(event.pointerId);
    candidates.delete(event.pointerId);
    if (candidate === undefined) return;
    if (distance(event.clientX, event.clientY, candidate.downX, candidate.downY) > TAP_SLOP_PX) return;
    if (now() - candidate.downAt > TAP_MAX_MS) return;
    onTap({ target: candidate.target, x: candidate.downX, y: candidate.downY, at: candidate.downAt });
  }

  function handlePointerCancel(event: Event): void {
    if (!(event instanceof PointerEvent)) return;
    candidates.delete(event.pointerId);
  }

  const opts = { capture: true } as const;
  target.addEventListener("pointerdown", handlePointerDown, opts);
  target.addEventListener("pointermove", handlePointerMove, opts);
  target.addEventListener("pointerup", handlePointerUp, opts);
  target.addEventListener("pointercancel", handlePointerCancel, opts);
  return () => {
    target.removeEventListener("pointerdown", handlePointerDown, opts);
    target.removeEventListener("pointermove", handlePointerMove, opts);
    target.removeEventListener("pointerup", handlePointerUp, opts);
    target.removeEventListener("pointercancel", handlePointerCancel, opts);
  };
}

export interface MultiTapDetector {
  /** Feed one recognized tap. Fires `onMultiTap` (and resets) the moment `MULTI_TAP_COUNT` taps
   * have landed within `MULTI_TAP_INTERVAL_MS`, `MULTI_TAP_RADIUS_PX` and the same tap zone of
   * the run's first tap — see the module header for the v1.5 boundary exemption. Excluded
   * targets (`isExcludedTapTarget`) are ignored. */
  handleTap(tap: RecognizedTap): void;
  /** Clears any in-progress tap run without firing — used when the panel's
   * own state changes in a way that should invalidate a partial sequence
   * (e.g. the panel just locked for an unrelated reason). */
  reset(): void;
}

export function createMultiTapDetector(onMultiTap: () => void): MultiTapDetector {
  let tapCount = 0;
  let lastTapAt = 0;
  let firstTapX = 0;
  let firstTapY = 0;
  let firstTapZone: Element | null = null;
  let lastTapWasBoundary = false;
  let boundaryTapCount = 0;

  function reset(): void {
    tapCount = 0;
    lastTapAt = 0;
    firstTapX = 0;
    firstTapY = 0;
    firstTapZone = null;
    lastTapWasBoundary = false;
    boundaryTapCount = 0;
  }

  function startRun(tap: RecognizedTap, isBoundary: boolean, zone: Element | null): void {
    tapCount = 1;
    lastTapAt = tap.at;
    firstTapX = tap.x;
    firstTapY = tap.y;
    firstTapZone = zone;
    lastTapWasBoundary = isBoundary;
    boundaryTapCount = isBoundary ? 1 : 0;
  }

  function handleTap(tap: RecognizedTap): void {
    if (isExcludedTapTarget(tap.target)) return;
    if (tapCount > 0 && tap.at - lastTapAt > MULTI_TAP_INTERVAL_MS) {
      reset();
    }

    const isBoundary = isGestureBoundaryTarget(tap.target);
    const zone = tapZoneOf(tap.target);

    // A pair that begins on a boundary opens a causal surface; it must not lock. Keep the
    // newest boundary as the run's anchor so a third rapid boundary tap still locks (the second
    // and third taps form the pair). Exempt from SAME PLACE/SAME THING below — a boundary chain
    // is inherently a sequence of different controls (open here, confirm there), so its own
    // raised bar (one extra tap) is the gate, not position.
    if (tapCount > 0 && lastTapWasBoundary && isBoundary) {
      boundaryTapCount += 1;
      if (boundaryTapCount >= MULTI_TAP_COUNT + 1) {
        onMultiTap();
        reset();
        return;
      }
      // NOT `startRun()`: that would reset `boundaryTapCount` back to 1, losing the chain's own
      // running count just incremented above. Only the fields a boundary chain actually reads
      // need updating (position/zone are never consulted while `lastTapWasBoundary` stays true).
      tapCount = 1;
      lastTapAt = tap.at;
      lastTapWasBoundary = true;
      return;
    }

    // A boundary tap cannot start a pair with a later unrelated control.
    // That next primary tap begins a fresh run instead.
    if (tapCount > 0 && lastTapWasBoundary && !isBoundary) {
      startRun(tap, isBoundary, zone);
      return;
    }

    // A boundary tap MAY CLOSE a run started by an unrelated (non-boundary) control — v1.5,
    // unchanged: `lastTapWasBoundary` is already known false here (the two branches above would
    // otherwise have matched), so this is exactly "tap2 lands on a boundary, tap1 didn't".
    // Completing it is unconditional, the same as any ordinary pair, with no SAME PLACE/SAME
    // THING gate — a boundary "close" control (e.g. a lightbox's X) legitimately sits far from
    // whatever opened it.
    if (tapCount > 0 && isBoundary) {
      tapCount += 1;
      lastTapAt = tap.at;
      if (tapCount >= MULTI_TAP_COUNT) {
        onMultiTap();
        reset();
        return;
      }
      lastTapWasBoundary = isBoundary;
      boundaryTapCount = 1;
      return;
    }

    if (tapCount > 0) {
      // R3 v1.7: an ordinary tap (neither tap in the pair is a boundary target) only completes
      // the pair if it is in the SAME PLACE as the run's first tap and resolves to the SAME
      // THING. A tap that fails either check starts a FRESH run with itself as the new first
      // tap — never just dropped, so a real double-tap right after a near-miss is still caught.
      const samePlace = distance(tap.x, tap.y, firstTapX, firstTapY) <= MULTI_TAP_RADIUS_PX;
      const sameThing = zone === firstTapZone;
      if (samePlace && sameThing) {
        tapCount += 1;
        lastTapAt = tap.at;
        if (tapCount >= MULTI_TAP_COUNT) {
          onMultiTap();
          reset();
          return;
        }
        lastTapWasBoundary = isBoundary;
        boundaryTapCount = isBoundary ? 1 : 0;
        return;
      }
      startRun(tap, isBoundary, zone);
      return;
    }

    startRun(tap, isBoundary, zone);
  }

  return { handleTap, reset };
}

/** Attaches the shared tap recognizer to `doc` in the capture phase and wires its output into
 * `detector`. `now` defaults to the real `performance.now()`; `panel.ts` injects `win.performance
 * .now()` so its unit tests get a fake `win`'s clock instead. Returns a teardown that detaches
 * it — call while (and only while) the server panel is mounted. */
export function attachMultiTapListener(
  doc: Document,
  detector: MultiTapDetector,
  now?: () => number,
): () => void {
  return attachTapRecognizer(doc, (tap) => detector.handleTap(tap), now);
}

// -- R2 v1.3: single-tap-on-the-decoy-reveals (operator decision #974) --------

export interface TapDetector {
  /** Feed one recognized tap. Fires `onTap` immediately unless the target is
   * excluded (see `isExcludedTapTarget`) — no counting, no interval, no
   * state: every qualifying tap fires it. */
  handleTap(tap: RecognizedTap): void;
}

export function createTapDetector(onTap: () => void): TapDetector {
  return {
    handleTap(tap: RecognizedTap): void {
      if (isExcludedTapTarget(tap.target)) return;
      onTap();
    },
  };
}

/** Attaches the shared tap recognizer to `target` (the server panel's own root element — R2
 * v1.3: "inside the Server panel element, not nav/topbar", a scope this satisfies for free since
 * events outside `target`'s subtree never reach a listener attached to it) in the capture phase.
 * `now` defaults to the real `performance.now()`, matching `attachMultiTapListener`. Returns a
 * teardown. */
export function attachTapListener(target: EventTarget, detector: TapDetector, now?: () => number): () => void {
  return attachTapRecognizer(target, (tap) => detector.handleTap(tap), now);
}
