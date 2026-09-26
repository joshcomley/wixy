// Live drawing — the pen tool's gesture state machine (spec/server-chat/07-live-drawing.md §5).
//
// Pure Pointer-Event arithmetic: the DOM glue turns real PointerEvents into `DrawGestureInput`
// values and calls `handle()`; this module owns none of the DOM (no `touch-action`, no pointer
// capture, no listeners) and owns no clock — every timestamp is the caller's `t`, so tests get a
// fully deterministic clock without needing to inject one (`gestures.ts`'s tap recognizer takes
// this one step further: it still reads a real clock by default and lets tests override it).
//
// The rule being modelled, in one sentence: one finger, pen or mouse pointer draws; a SECOND
// TOUCH finger that lands within `SECOND_FINGER_WINDOW_MS` of the first finger's down, before the
// first has moved `SECOND_FINGER_SLOP_PX`, cancels the stroke and turns the gesture into a
// two-finger pan that scrolls by the two fingers' centroid movement. Every other extra pointer is
// inert: it neither draws nor pans, and is tracked only so its later lift can be told apart from
// an unknown pointer's (a no-op either way, but the phase machine still needs to know how many
// pointers are still down before it can call itself "idle" again).
//
// Phases and the pointers they track:
// - "idle": nothing tracked. The only phase a fresh `down` can start a stroke from.
// - "stroke": exactly one pointer (`stroke.pointerId`) is drawing. Any further pointer either
//   converts the gesture to "pan" (see above) or joins the INERT set.
// - "pan": exactly two pointers (`pan.aId`, `pan.bId`) drive the scroll. A third (or later)
//   pointer joins the INERT set without affecting the pan.
// - "draining": nothing is drawing or panning, but the INERT set is still non-empty (pointers
//   that were along for the ride and simply haven't lifted yet). New pointers down here join the
//   INERT set too — they never draw, even once the original stroke/pan is long gone. The phase
//   falls back to "idle" the instant the INERT set empties.
//
// The INERT set is one `Set<number>` doing the job the spec names twice ("the ignored set" while
// a stroke/pan is active, "the draining set" once nothing is): a pointer in it contributes no
// effects, ever, while it stays down; only its eventual up/cancel removes it, and removing the
// last one while draining is exactly what completes the return to "idle".

import { SECOND_FINGER_SLOP_PX, SECOND_FINGER_WINDOW_MS } from "./drawings";

export type DrawGestureInput =
  | {
      readonly type: "down";
      readonly pointerId: number;
      readonly pointerType: string;
      readonly button: number;
      readonly x: number;
      readonly y: number;
      readonly t: number;
    }
  | { readonly type: "move"; readonly pointerId: number; readonly x: number; readonly y: number; readonly t: number }
  | { readonly type: "up"; readonly pointerId: number; readonly x: number; readonly y: number; readonly t: number }
  | { readonly type: "cancel"; readonly pointerId: number; readonly t: number };

export type DrawGestureEffect =
  | { readonly type: "strokeStart"; readonly pointerId: number; readonly x: number; readonly y: number }
  | { readonly type: "strokePoint"; readonly x: number; readonly y: number }
  | { readonly type: "strokeEnd" }
  | { readonly type: "strokeCancel" }
  | { readonly type: "panStart"; readonly pointerIds: readonly [number, number] }
  | { readonly type: "panBy"; readonly dy: number }
  | { readonly type: "panEnd" };

export type DrawGesturePhase = "idle" | "stroke" | "pan" | "draining";

export interface DrawGesture {
  handle(input: DrawGestureInput): readonly DrawGestureEffect[];
  /** Ends whatever is in progress (a stroke -> [strokeCancel], a pan -> [panEnd], otherwise []),
   * returns to "idle" and forgets every tracked pointer, so a pointer still physically down is
   * ignored until it goes down afresh. */
  reset(): readonly DrawGestureEffect[];
  readonly phase: DrawGesturePhase;
  /** The pointer currently drawing a stroke, or null. */
  readonly strokePointerId: number | null;
}

/** `pointerType` normalises to exactly "touch" or "pen" for those two literal strings; every
 * other value — "mouse", "", a future/unrecognised string — is treated as "mouse" (spec 07 §5). */
type PointerKind = "touch" | "pen" | "mouse";

function normalizeKind(pointerType: string): PointerKind {
  return pointerType === "touch" || pointerType === "pen" ? pointerType : "mouse";
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** The one pointer currently drawing. `lastX`/`lastY` is the last EMITTED stroke position — the
 * down point until the first move that differs from it — which makes it, at every instant,
 * exactly "the latest move, or the down point": the value §5 wants handed to a pan on a
 * second-finger cancel, with no separate field needed to track it. `moved` is the rolling MAX
 * distance from the down point (never from the last point), because a finger that strays out
 * past the slop and back must still block the pan. */
interface StrokeState {
  readonly pointerId: number;
  readonly kind: PointerKind;
  readonly downX: number;
  readonly downY: number;
  readonly downT: number;
  lastX: number;
  lastY: number;
  moved: number;
}

/** The two pointers driving a pan. Each pointer's own last-known (x, y) is kept so the centroid
 * can be recomputed from whichever one just moved plus the other's last reported position. */
interface PanState {
  readonly aId: number;
  readonly bId: number;
  aX: number;
  aY: number;
  bX: number;
  bY: number;
  centroidY: number;
}

export function createDrawGesture(): DrawGesture {
  let phase: DrawGesturePhase = "idle";
  let stroke: StrokeState | null = null;
  let pan: PanState | null = null;
  /** Pointers that are down but neither drawing nor panning — see the module header. */
  const inert = new Set<number>();

  function isTracked(pointerId: number): boolean {
    if (stroke !== null && stroke.pointerId === pointerId) return true;
    if (pan !== null && (pan.aId === pointerId || pan.bId === pointerId)) return true;
    return inert.has(pointerId);
  }

  /** Shared by `up` and `cancel`: both end whatever `pointerId` was doing in the same way, except
   * that only `up` carries a final position (a `cancel` has none, so it can never emit a trailing
   * `strokePoint`). Returns `[]` untouched for a pointer this machine isn't tracking at all. */
  function endLift(
    pointerId: number,
    liftPoint: { readonly x: number; readonly y: number } | null,
  ): readonly DrawGestureEffect[] {
    const activeStroke = stroke;
    if (activeStroke !== null && activeStroke.pointerId === pointerId) {
      const effects: DrawGestureEffect[] = [];
      if (liftPoint !== null) {
        activeStroke.moved = Math.max(
          activeStroke.moved,
          distance(activeStroke.downX, activeStroke.downY, liftPoint.x, liftPoint.y),
        );
        if (liftPoint.x !== activeStroke.lastX || liftPoint.y !== activeStroke.lastY) {
          effects.push({ type: "strokePoint", x: liftPoint.x, y: liftPoint.y });
        }
        effects.push({ type: "strokeEnd" });
      } else {
        effects.push({ type: "strokeCancel" });
      }
      stroke = null;
      phase = inert.size > 0 ? "draining" : "idle";
      return effects;
    }

    const activePan = pan;
    if (activePan !== null && (activePan.aId === pointerId || activePan.bId === pointerId)) {
      const otherId = activePan.aId === pointerId ? activePan.bId : activePan.aId;
      pan = null;
      // The other pan pointer hasn't lifted yet (we'd have handled that up/cancel already, and
      // only two pointers ever drive a pan) — it joins whatever the inert set already held to
      // become the draining set (spec 07 §5).
      inert.add(otherId);
      phase = "draining";
      return [{ type: "panEnd" }];
    }

    if (inert.has(pointerId)) {
      inert.delete(pointerId);
      if (phase === "draining" && inert.size === 0) phase = "idle";
      return [];
    }

    return []; // an unknown pointer
  }

  function handle(input: DrawGestureInput): readonly DrawGestureEffect[] {
    switch (input.type) {
      case "down": {
        const { pointerId, pointerType, button, x, y, t } = input;
        if (isTracked(pointerId)) return []; // already tracked in ANY role — duplicate down
        if (button !== 0) return []; // not tracked at all; its later events are unknown-pointer no-ops

        if (phase === "idle") {
          stroke = { pointerId, kind: normalizeKind(pointerType), downX: x, downY: y, downT: t, lastX: x, lastY: y, moved: 0 };
          phase = "stroke";
          return [{ type: "strokeStart", pointerId, x, y }];
        }

        if (phase === "stroke" && stroke !== null) {
          const a = stroke;
          const kind = normalizeKind(pointerType);
          const secondFingerCancel =
            a.kind === "touch" &&
            kind === "touch" &&
            t - a.downT <= SECOND_FINGER_WINDOW_MS &&
            a.moved < SECOND_FINGER_SLOP_PX;
          if (secondFingerCancel) {
            const pointerIds: readonly [number, number] = [a.pointerId, pointerId];
            pan = { aId: a.pointerId, aX: a.lastX, aY: a.lastY, bId: pointerId, bX: x, bY: y, centroidY: (a.lastY + y) / 2 };
            stroke = null;
            phase = "pan";
            return [{ type: "strokeCancel" }, { type: "panStart", pointerIds }];
          }
          inert.add(pointerId);
          return [];
        }

        // phase is "pan" or "draining": every further pointer is simply along for the ride.
        inert.add(pointerId);
        return [];
      }

      case "move": {
        const { pointerId, x, y } = input;

        const activeStroke = stroke;
        if (activeStroke !== null && activeStroke.pointerId === pointerId) {
          activeStroke.moved = Math.max(activeStroke.moved, distance(activeStroke.downX, activeStroke.downY, x, y));
          if (x !== activeStroke.lastX || y !== activeStroke.lastY) {
            activeStroke.lastX = x;
            activeStroke.lastY = y;
            return [{ type: "strokePoint", x, y }];
          }
          return [];
        }

        const activePan = pan;
        if (activePan !== null && (activePan.aId === pointerId || activePan.bId === pointerId)) {
          if (activePan.aId === pointerId) {
            activePan.aX = x;
            activePan.aY = y;
          } else {
            activePan.bX = x;
            activePan.bY = y;
          }
          const centroidY = (activePan.aY + activePan.bY) / 2;
          const dy = activePan.centroidY - centroidY; // fingers moving UP (y decreasing) -> dy > 0
          activePan.centroidY = centroidY;
          return dy !== 0 ? [{ type: "panBy", dy }] : [];
        }

        return []; // idle, draining, or an inert/unknown pointer: never emits anything
      }

      case "up":
        return endLift(input.pointerId, { x: input.x, y: input.y });

      case "cancel":
        return endLift(input.pointerId, null);
    }
  }

  function reset(): readonly DrawGestureEffect[] {
    let effects: readonly DrawGestureEffect[];
    if (phase === "stroke") {
      effects = [{ type: "strokeCancel" }];
    } else if (phase === "pan") {
      effects = [{ type: "panEnd" }];
    } else {
      effects = [];
    }
    stroke = null;
    pan = null;
    inert.clear();
    phase = "idle";
    return effects;
  }

  return {
    handle,
    reset,
    get phase(): DrawGesturePhase {
      return phase;
    },
    get strokePointerId(): number | null {
      return stroke !== null ? stroke.pointerId : null;
    },
  };
}
