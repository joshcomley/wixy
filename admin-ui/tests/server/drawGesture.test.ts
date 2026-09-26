// The pen tool's gesture state machine (spec/server-chat/07-live-drawing.md §5): one finger, pen
// or mouse draws; a second TOUCH finger landing inside the window/slop cancels the stroke and
// starts a two-finger pan; every other extra pointer is inert. Pure arithmetic driven entirely by
// the input's own `t` — no clock to fake, unlike `gestures.test.ts`'s tap recognizer.

import { describe, expect, it } from "vitest";
import { SECOND_FINGER_SLOP_PX, SECOND_FINGER_WINDOW_MS } from "../../src/server/drawings";
import { createDrawGesture, type DrawGestureInput } from "../../src/server/drawGesture";

function down(pointerId: number, x: number, y: number, t: number, pointerType = "mouse", button = 0): DrawGestureInput {
  return { type: "down", pointerId, pointerType, button, x, y, t };
}
function move(pointerId: number, x: number, y: number, t: number): DrawGestureInput {
  return { type: "move", pointerId, x, y, t };
}
function up(pointerId: number, x: number, y: number, t: number): DrawGestureInput {
  return { type: "up", pointerId, x, y, t };
}
function cancelInput(pointerId: number, t: number): DrawGestureInput {
  return { type: "cancel", pointerId, t };
}

describe("createDrawGesture — single-pointer drawing", () => {
  it("a mouse draws: down starts a stroke, moves emit points, up ends back to idle", () => {
    const g = createDrawGesture();
    expect(g.phase).toBe("idle");
    expect(g.strokePointerId).toBeNull();

    expect(g.handle(down(1, 10, 10, 0))).toEqual([{ type: "strokeStart", pointerId: 1, x: 10, y: 10 }]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);

    expect(g.handle(move(1, 20, 15, 10))).toEqual([{ type: "strokePoint", x: 20, y: 15 }]);
    expect(g.handle(move(1, 30, 25, 20))).toEqual([{ type: "strokePoint", x: 30, y: 25 }]);

    expect(g.handle(up(1, 40, 35, 30))).toEqual([
      { type: "strokePoint", x: 40, y: 35 },
      { type: "strokeEnd" },
    ]);
    expect(g.phase).toBe("idle");
    expect(g.strokePointerId).toBeNull();
  });

  it("a down with button !== 0 is ignored entirely — no stroke, and its later events are no-ops", () => {
    const g = createDrawGesture();
    expect(g.handle(down(1, 0, 0, 0, "mouse", 2))).toEqual([]);
    expect(g.phase).toBe("idle");
    expect(g.handle(move(1, 50, 50, 1))).toEqual([]);
    expect(g.handle(up(1, 50, 50, 2))).toEqual([]);
    expect(g.phase).toBe("idle");
  });

  it("identical consecutive points are not re-emitted", () => {
    const g = createDrawGesture();
    g.handle(down(1, 5, 5, 0));
    expect(g.handle(move(1, 5, 5, 10))).toEqual([]);
    expect(g.handle(move(1, 5, 5, 20))).toEqual([]);
  });

  it("up at a new position emits a final strokePoint before strokeEnd", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0));
    g.handle(move(1, 5, 5, 1));
    expect(g.handle(up(1, 9, 9, 2))).toEqual([
      { type: "strokePoint", x: 9, y: 9 },
      { type: "strokeEnd" },
    ]);
  });

  it("up at the same position as the last emitted point emits only strokeEnd", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0));
    g.handle(move(1, 5, 5, 1));
    expect(g.handle(up(1, 5, 5, 2))).toEqual([{ type: "strokeEnd" }]);
  });

  it("a stroke pointer cancel emits strokeCancel and returns to idle", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0));
    expect(g.handle(cancelInput(1, 5))).toEqual([{ type: "strokeCancel" }]);
    expect(g.phase).toBe("idle");
    expect(g.strokePointerId).toBeNull();
  });

  it("pointerType '' behaves as mouse — a same-instant same-spot touch pointer never triggers the pan rule", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, ""));
    // If pointer 1 were itself normalised to "touch" this would cancel into a pan (zero elapsed
    // time, zero movement); it must not, because pointerType "" normalises to mouse.
    expect(g.handle(down(2, 0, 0, 0, "touch"))).toEqual([]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
  });

  it("duplicate down for the already-tracked stroke pointer is ignored and does not reset its down point/time", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    expect(g.handle(down(1, 999, 999, 500, "touch"))).toEqual([]); // duplicate: must be a total no-op
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
    // If the duplicate had wrongly overwritten the down time to 500, a second finger at t=550
    // (50ms later) would fall inside SECOND_FINGER_WINDOW_MS and trigger a pan. Since the true
    // down time is still 0, 550ms later is well outside the window, so it must be ignored.
    expect(g.handle(down(2, 1, 1, 550, "touch"))).toEqual([]);
    expect(g.phase).toBe("stroke");
  });
});

describe("createDrawGesture — pointer kinds that never trigger the second-finger pan rule", () => {
  it("a pen stroke + a touch finger: the touch finger is ignored, the pen keeps drawing", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "pen"));
    expect(g.handle(down(2, 1, 0, 1, "touch"))).toEqual([]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
    expect(g.handle(move(1, 5, 5, 2))).toEqual([{ type: "strokePoint", x: 5, y: 5 }]);
  });

  it("a touch stroke + a pen pointer: the pen is ignored, the touch keeps drawing", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    expect(g.handle(down(2, 1, 0, 1, "pen"))).toEqual([]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
  });

  it("a mouse stroke + a touch finger: the touch finger is ignored, the mouse keeps drawing", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "mouse"));
    expect(g.handle(down(2, 1, 0, 1, "touch"))).toEqual([]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
  });
});

describe("createDrawGesture — the second-finger cancel-into-pan rule", () => {
  it("a second touch finger inside the window and slop cancels the stroke and starts a pan with both ids", () => {
    const g = createDrawGesture();
    g.handle(down(1, 100, 100, 0, "touch"));
    const effects = g.handle(down(2, 200, 100, SECOND_FINGER_WINDOW_MS, "touch"));
    expect(effects).toEqual([{ type: "strokeCancel" }, { type: "panStart", pointerIds: [1, 2] }]);
    expect(g.phase).toBe("pan");
    expect(g.strokePointerId).toBeNull();
  });

  it("both fingers moving up 10px gives dy = +10 in total (scroll the content down)", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch")); // pan starts; centroid = (100 + 100) / 2 = 100

    const first = g.handle(move(1, 0, 90, 1)); // finger A up 10px -> centroid 95, dy = 100 - 95 = 5
    expect(first).toEqual([{ type: "panBy", dy: 5 }]);
    const second = g.handle(move(2, 50, 90, 2)); // finger B up 10px -> centroid 90, dy = 95 - 90 = 5
    expect(second).toEqual([{ type: "panBy", dy: 5 }]);
    // Each finger moved up 10px in turn; the two panBy amounts (5 + 5) sum to the documented +10.
  });

  it("one finger moving up 10px alone gives dy = +5 (half the centroid movement)", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch"));
    expect(g.handle(move(1, 0, 90, 1))).toEqual([{ type: "panBy", dy: 5 }]);
  });

  it("horizontal-only movement of a pan pointer emits nothing", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch"));
    expect(g.handle(move(1, 30, 100, 1))).toEqual([]);
  });

  it("boundary: exactly SECOND_FINGER_WINDOW_MS after the first down still pans", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    const effects = g.handle(down(2, 1, 1, SECOND_FINGER_WINDOW_MS, "touch"));
    expect(effects).toEqual([{ type: "strokeCancel" }, { type: "panStart", pointerIds: [1, 2] }]);
    expect(g.phase).toBe("pan");
  });

  it("boundary: 1ms after the window, the second finger is ignored and the stroke continues", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    expect(g.handle(down(2, 1, 1, SECOND_FINGER_WINDOW_MS + 1, "touch"))).toEqual([]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
    expect(g.handle(move(1, 10, 10, SECOND_FINGER_WINDOW_MS + 2))).toEqual([{ type: "strokePoint", x: 10, y: 10 }]);
  });

  it("boundary: the first finger moved exactly SECOND_FINGER_SLOP_PX before the second lands — ignored", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    g.handle(move(1, SECOND_FINGER_SLOP_PX, 0, 1)); // moved == slop, not < slop
    expect(g.handle(down(2, 1, 1, 2, "touch"))).toEqual([]);
    expect(g.phase).toBe("stroke");
  });

  it("boundary: the first finger moved slightly under SECOND_FINGER_SLOP_PX before the second lands — pans", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    g.handle(move(1, SECOND_FINGER_SLOP_PX - 0.01, 0, 1));
    const effects = g.handle(down(2, 1, 1, 2, "touch"));
    expect(effects).toEqual([{ type: "strokeCancel" }, { type: "panStart", pointerIds: [1, 2] }]);
    expect(g.phase).toBe("pan");
  });

  it("moved is the MAX distance from the down point: straying out then back to the start still blocks the pan", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "touch"));
    g.handle(move(1, SECOND_FINGER_SLOP_PX + 3, 0, 1)); // strays out past the slop
    g.handle(move(1, 0, 0, 2)); // back to the exact start
    expect(g.handle(down(2, 1, 1, 3, "touch"))).toEqual([]); // still blocked — moved stays at its max
    expect(g.phase).toBe("stroke");
  });

  it("a third finger during a pan is ignored and does not end the pan", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch"));
    expect(g.phase).toBe("pan");
    expect(g.handle(down(3, 500, 500, 1))).toEqual([]);
    expect(g.phase).toBe("pan");
    expect(g.handle(move(1, 0, 90, 2))).toEqual([{ type: "panBy", dy: 5 }]);
  });

  it("lifting one pan finger ends the pan; the other's moves do nothing until it also lifts, then idle, then a fresh down draws again", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch"));

    expect(g.handle(up(1, 0, 100, 1))).toEqual([{ type: "panEnd" }]);
    expect(g.phase).toBe("draining");
    expect(g.strokePointerId).toBeNull();

    expect(g.handle(move(2, 60, 60, 2))).toEqual([]); // the surviving finger no longer pans
    expect(g.phase).toBe("draining");

    expect(g.handle(up(2, 60, 60, 3))).toEqual([]);
    expect(g.phase).toBe("idle");

    expect(g.handle(down(9, 1, 1, 4))).toEqual([{ type: "strokeStart", pointerId: 9, x: 1, y: 1 }]);
    expect(g.phase).toBe("stroke");
  });

  it("cancelling one pan finger ends the pan the same way as lifting it", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch"));
    expect(g.handle(cancelInput(2, 1))).toEqual([{ type: "panEnd" }]);
    expect(g.phase).toBe("draining");
  });
});

describe("createDrawGesture — ignored/draining pointers", () => {
  it("an ignored pointer lifting mid-stroke does not affect the stroke", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "mouse"));
    expect(g.handle(down(2, 1, 0, 1, "touch"))).toEqual([]); // a mouse stroke can never pan
    expect(g.handle(up(2, 1, 0, 2))).toEqual([]);
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);
    expect(g.handle(move(1, 5, 5, 3))).toEqual([{ type: "strokePoint", x: 5, y: 5 }]);
  });

  it("stroke up while an ignored pointer is still down -> draining; a down while draining never draws; idle once all lift", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "mouse"));
    g.handle(down(2, 1, 0, 1, "touch")); // ignored

    expect(g.handle(up(1, 0, 0, 2))).toEqual([{ type: "strokeEnd" }]);
    expect(g.phase).toBe("draining");
    expect(g.strokePointerId).toBeNull();

    expect(g.handle(down(3, 9, 9, 3))).toEqual([]); // joins the draining set, never draws
    expect(g.phase).toBe("draining");

    expect(g.handle(up(2, 1, 0, 4))).toEqual([]);
    expect(g.phase).toBe("draining"); // pointer 3 still down

    expect(g.handle(up(3, 9, 9, 5))).toEqual([]);
    expect(g.phase).toBe("idle");
  });

  it("a duplicate down for a pointer already in the ignored/draining set is ignored", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "mouse"));
    g.handle(down(2, 1, 0, 1, "touch"));
    expect(g.handle(down(2, 50, 50, 2, "touch"))).toEqual([]);
    expect(g.handle(up(2, 1, 0, 3))).toEqual([]);
    expect(g.phase).toBe("stroke");
  });
});

describe("createDrawGesture — reset()", () => {
  it("reset in idle returns [] and stays idle", () => {
    const g = createDrawGesture();
    expect(g.reset()).toEqual([]);
    expect(g.phase).toBe("idle");
  });

  it("reset mid-stroke returns [strokeCancel], returns to idle, and forgets the pointer", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0));
    expect(g.reset()).toEqual([{ type: "strokeCancel" }]);
    expect(g.phase).toBe("idle");
    expect(g.strokePointerId).toBeNull();

    // The same, still-physically-down pointer's later events are ignored until a fresh down.
    expect(g.handle(move(1, 50, 50, 1))).toEqual([]);
    expect(g.handle(up(1, 50, 50, 2))).toEqual([]);
    expect(g.phase).toBe("idle");

    expect(g.handle(down(1, 5, 5, 3))).toEqual([{ type: "strokeStart", pointerId: 1, x: 5, y: 5 }]);
  });

  it("reset mid-pan returns [panEnd], returns to idle, and forgets both pointers", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 100, 0, "touch"));
    g.handle(down(2, 50, 100, 0, "touch"));
    expect(g.reset()).toEqual([{ type: "panEnd" }]);
    expect(g.phase).toBe("idle");
    expect(g.handle(move(1, 0, 0, 1))).toEqual([]);
    expect(g.handle(move(2, 0, 0, 1))).toEqual([]);
  });

  it("reset while draining returns [] and clears the draining set", () => {
    const g = createDrawGesture();
    g.handle(down(1, 0, 0, 0, "mouse"));
    g.handle(down(2, 1, 0, 1, "touch"));
    g.handle(up(1, 0, 0, 2)); // -> draining, pointer 2 still down
    expect(g.phase).toBe("draining");

    expect(g.reset()).toEqual([]);
    expect(g.phase).toBe("idle");
    expect(g.handle(up(2, 1, 0, 3))).toEqual([]); // forgotten
  });
});

describe("createDrawGesture — phase and strokePointerId reporting", () => {
  it("reports idle -> stroke -> pan -> draining -> idle accurately at every step", () => {
    const g = createDrawGesture();
    expect(g.phase).toBe("idle");
    expect(g.strokePointerId).toBeNull();

    g.handle(down(1, 0, 100, 0, "touch"));
    expect(g.phase).toBe("stroke");
    expect(g.strokePointerId).toBe(1);

    g.handle(down(2, 50, 100, 0, "touch")); // cancels into a pan
    expect(g.phase).toBe("pan");
    expect(g.strokePointerId).toBeNull();

    g.handle(down(3, 500, 500, 1)); // ignored third finger
    expect(g.phase).toBe("pan");

    g.handle(up(1, 0, 100, 2)); // ends the pan; pointer 2 and 3 are now draining
    expect(g.phase).toBe("draining");

    g.handle(up(2, 50, 100, 3)); // pointer 3 still down
    expect(g.phase).toBe("draining");

    g.handle(up(3, 500, 500, 4));
    expect(g.phase).toBe("idle");
    expect(g.strokePointerId).toBeNull();
  });
});
