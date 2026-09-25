// Two independent tap detectors, both Pointer-Events-only and both excluding
// the same set of targets (`isExcludedTapTarget`):
//
// - R3's multi-tap-inside-the-chat-view-locks detector (`createMultiTapDetector`
//   / `attachMultiTapListener`) — UNCHANGED by R2 v1.3 (operator decision
//   #974, spec/server-chat/00-brief.md §6). Two Pointer Events at most
//   `MULTI_TAP_INTERVAL_MS` apart count as one "multi-tap". `panel.ts`
//   attaches this to `document` in the capture phase for the lifetime of the
//   mounted panel, and only its "chat"/"fading" states give the resulting
//   event any meaning (lockModel.ts) — it has NO meaning on the decoy.
// - R2 v1.3's single-tap-on-the-decoy-reveals detector (`createTapDetector` /
//   `attachTapListener`) — a plain single qualifying tap, no counting. A tap
//   on the affordance itself within `MULTI_TAP_INTERVAL_MS` of the reveal is
//   a SEPARATE debounce `panel.ts` owns directly (see its own note), not
//   part of this detector.
//
// R3's precision requirements (both detectors), all load-bearing:
// - Pointer Events ONLY, never mixed with touch/mouse listeners on the same
//   root (a synthetic touch + its compatibility mouse events + a real
//   pointer event for one physical tap would triple-count).
// - `performance.now()` for timing, not `Date.now()` — Playwright's
//   `page.clock` intercepts `performance.now()`, so e2e specs get
//   deterministic control over the interval boundary.
// - Attached in the CAPTURE phase, so a tap inside a `stopPropagation()`'d
//   child (a dialog, a drawer) is still counted — every tap while the panel
//   is mounted must be seen, not just ones that bubble.

import { MULTI_TAP_COUNT, MULTI_TAP_INTERVAL_MS } from "./constants";

/** `[data-srv-gesture-exempt]` marks a control group whose taps must never count as a
 * multi-tap: the inline "Keep this device unlocked" PIN pad, whose digit keys are tapped in
 * quick succession by design. */
export const GESTURE_EXEMPT_SELECTOR = "[data-srv-gesture-exempt]";
const EXCLUDED_SELECTOR = `textarea, input, [contenteditable], audio, video, ${GESTURE_EXEMPT_SELECTOR}`;
export const GESTURE_BOUNDARY_SELECTOR = "[data-srv-gesture-boundary]";

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

/** Attaches `handlePointerDown` to `target` in the capture phase, Pointer
 * Events only — the shared plumbing behind both `attachMultiTapListener` and
 * `attachTapListener`. Returns a teardown. */
function attachPointerDownListener(
  target: EventTarget,
  handlePointerDown: (event: PointerEvent) => void,
): () => void {
  const listener = (event: Event): void => {
    if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent) {
      handlePointerDown(event);
    }
  };
  target.addEventListener("pointerdown", listener, { capture: true });
  return () => target.removeEventListener("pointerdown", listener, { capture: true });
}

export interface MultiTapDetector {
  /** Feed one qualifying pointerdown. Fires `onMultiTap` (and resets the
   * count) the moment `MULTI_TAP_COUNT` taps have landed within
   * `MULTI_TAP_INTERVAL_MS` of each other. Only primary-button taps count.
   * Excluded targets (see `isExcludedTapTarget`) are ignored. A gesture-boundary
   * target may complete a run started elsewhere, but cannot start one; repeated
   * boundary taps still lock on the third tap (spec v1.5.2). */
  handlePointerDown(event: PointerEvent): void;
  /** Clears any in-progress tap run without firing — used when the panel's
   * own state changes in a way that should invalidate a partial sequence
   * (e.g. the panel just locked for an unrelated reason). */
  reset(): void;
}

/** `now` defaults to the real `performance.now()` (what R3 mandates in the
 * browser, and what Playwright's `page.clock` intercepts); unit tests inject
 * a fake clock instead of relying on faked global timers. */
export function createMultiTapDetector(
  onMultiTap: () => void,
  now: () => number = () => performance.now(),
): MultiTapDetector {
  let tapCount = 0;
  let lastTapAt = 0;
  let lastTapWasBoundary = false;
  let boundaryTapCount = 0;

  function reset(): void {
    tapCount = 0;
    lastTapAt = 0;
    lastTapWasBoundary = false;
    boundaryTapCount = 0;
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (isExcludedTapTarget(event.target)) return;
    const at = now();
    if (tapCount > 0 && at - lastTapAt > MULTI_TAP_INTERVAL_MS) {
      reset();
    }

    const isBoundary = isGestureBoundaryTarget(event.target);

    // A pair that begins on a boundary opens a causal surface; it must not
    // lock. Keep the newest boundary as the start so the third rapid boundary
    // tap still locks (the second and third taps form the pair).
    if (tapCount > 0 && lastTapWasBoundary && isBoundary) {
      boundaryTapCount += 1;
      if (boundaryTapCount >= MULTI_TAP_COUNT + 1) {
        onMultiTap();
        reset();
        return;
      }
      tapCount = 1;
      lastTapAt = at;
      lastTapWasBoundary = true;
      return;
    }

    // A boundary tap cannot start a pair with a later unrelated control.
    // That next primary tap begins a fresh run instead.
    if (tapCount > 0 && lastTapWasBoundary && !isBoundary) {
      tapCount = 1;
      lastTapAt = at;
      lastTapWasBoundary = false;
      boundaryTapCount = 0;
      return;
    }

    tapCount += 1;
    lastTapAt = at;
    if (tapCount >= MULTI_TAP_COUNT) {
      onMultiTap();
      reset();
      return;
    }
    lastTapWasBoundary = isBoundary;
    boundaryTapCount = isBoundary ? 1 : 0;
  }

  return { handlePointerDown, reset };
}

/** Attaches `detector` to `doc` in the capture phase, Pointer Events only.
 * Returns a teardown that detaches it — call while (and only while) the
 * server panel is mounted. */
export function attachMultiTapListener(doc: Document, detector: MultiTapDetector): () => void {
  return attachPointerDownListener(doc, (event) => detector.handlePointerDown(event));
}

// -- R2 v1.3: single-tap-on-the-decoy-reveals (operator decision #974) --------

export interface TapDetector {
  /** Feed one qualifying pointerdown. Fires `onTap` immediately unless the
   * target is excluded (see `isExcludedTapTarget`) — no counting, no
   * interval, no state: every qualifying tap fires it. */
  handlePointerDown(event: PointerEvent): void;
}

export function createTapDetector(onTap: () => void): TapDetector {
  return {
    handlePointerDown(event: PointerEvent): void {
      if (isExcludedTapTarget(event.target)) return;
      onTap();
    },
  };
}

/** Attaches `detector` to `target` (the server panel's own root element — R2
 * v1.3: "inside the Server panel element, not nav/topbar", a scope this
 * satisfies for free since events outside `target`'s subtree never reach a
 * listener attached to it) in the capture phase, Pointer Events only.
 * Returns a teardown. */
export function attachTapListener(target: EventTarget, detector: TapDetector): () => void {
  return attachPointerDownListener(target, (event) => detector.handlePointerDown(event));
}
