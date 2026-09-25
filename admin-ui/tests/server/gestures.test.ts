// R3 v1.7 (Architect ruling, operator report round 2): a double-tap is two real TAPS, in the
// SAME PLACE, on the SAME THING, quickly. Pointer Events only, the exact exclusion list,
// interval/radius/zone-based debouncing on an injectable clock, capture-phase attachment.

import { describe, expect, it, vi } from "vitest";
import {
  MULTI_TAP_COUNT,
  MULTI_TAP_INTERVAL_MS,
  MULTI_TAP_RADIUS_PX,
  TAP_MAX_MS,
  TAP_SLOP_PX,
} from "../../src/server/constants";
import {
  attachMultiTapListener,
  attachTapListener,
  createMultiTapDetector,
  createTapDetector,
  isExcludedTapTarget,
  isGestureBoundaryTarget,
  tapZoneOf,
  type RecognizedTap,
} from "../../src/server/gestures";

/** A recognized tap at the origin unless overridden — matches what a bare `pointerdown`/
 * `pointerup` pair at default (0,0) coordinates produces. */
function fakeTap(target: EventTarget, overrides: Partial<RecognizedTap> = {}): RecognizedTap {
  return { target, x: 0, y: 0, at: 0, ...overrides };
}

function gestureBoundary(): HTMLButtonElement {
  const button = document.createElement("button");
  button.setAttribute("data-srv-gesture-boundary", "");
  return button;
}

describe("isExcludedTapTarget", () => {
  it("excludes textarea, input, [contenteditable], audio and video", () => {
    const textarea = document.createElement("textarea");
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const audio = document.createElement("audio");
    const video = document.createElement("video");
    for (const el of [textarea, input, editable, audio, video]) {
      expect(isExcludedTapTarget(el)).toBe(true);
    }
  });

  it("excludes a descendant of an excluded element too (e.g. native media controls)", () => {
    const video = document.createElement("video");
    const child = document.createElement("span");
    video.appendChild(child);
    expect(isExcludedTapTarget(child)).toBe(true);
  });

  it("does not exclude an ordinary element", () => {
    expect(isExcludedTapTarget(document.createElement("div"))).toBe(false);
    expect(isExcludedTapTarget(document.createElement("button"))).toBe(false);
  });

  it("treats a non-Element target as not excluded", () => {
    expect(isExcludedTapTarget(null)).toBe(false);
    expect(isExcludedTapTarget(document)).toBe(false);
  });
});

describe("isGestureBoundaryTarget", () => {
  it("recognizes a marked control and its descendants", () => {
    const button = gestureBoundary();
    const icon = document.createElement("span");
    button.appendChild(icon);
    expect(isGestureBoundaryTarget(button)).toBe(true);
    expect(isGestureBoundaryTarget(icon)).toBe(true);
    expect(isGestureBoundaryTarget(document.createElement("button"))).toBe(false);
  });
});

describe("tapZoneOf (R3 v1.7 'SAME THING')", () => {
  it("resolves a message bubble, a button, a link, a menuitem role and a label as their own zone", () => {
    const bubble = document.createElement("div");
    bubble.className = "wx-srv-bubble wx-srv-bubble-mine";
    const button = document.createElement("button");
    const link = document.createElement("a");
    link.href = "#";
    const menuitem = document.createElement("div");
    menuitem.setAttribute("role", "menuitem");
    const label = document.createElement("label");
    for (const el of [bubble, button, link, menuitem, label]) {
      expect(tapZoneOf(el)).toBe(el);
    }
  });

  it("resolves the nearest zone ancestor, not the tap's exact child target", () => {
    const bubble = document.createElement("div");
    bubble.className = "wx-srv-bubble";
    const text = document.createElement("span");
    bubble.appendChild(text);
    expect(tapZoneOf(text)).toBe(bubble);
  });

  it("falls back to null (the shared panel-background zone) for plain, unmarked space", () => {
    expect(tapZoneOf(document.createElement("div"))).toBeNull();
    expect(tapZoneOf(null)).toBeNull();
  });

  it("two different unmarked elements are still the SAME zone (null), so open-space pairing is unaffected", () => {
    const a = document.createElement("div");
    const b = document.createElement("span");
    expect(tapZoneOf(a)).toBe(tapZoneOf(b));
  });
});

describe("createMultiTapDetector", () => {
  it("fires onMultiTap once MULTI_TAP_COUNT taps land within the interval, radius and zone", () => {
    expect(MULTI_TAP_COUNT).toBe(2);
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0 }));
    expect(onMultiTap).not.toHaveBeenCalled();
    detector.handleTap(fakeTap(target, { at: MULTI_TAP_INTERVAL_MS - 1 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the gap between taps exceeds the interval, but the second tap starts a fresh run", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0 }));
    detector.handleTap(fakeTap(target, { at: MULTI_TAP_INTERVAL_MS + 1 }));
    expect(onMultiTap).not.toHaveBeenCalled();
    detector.handleTap(fakeTap(target, { at: MULTI_TAP_INTERVAL_MS + 2 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("fires exactly at the interval boundary (<=, not <)", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0 }));
    detector.handleTap(fakeTap(target, { at: MULTI_TAP_INTERVAL_MS }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("resets the count after firing — a lone third tap doesn't immediately refire", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0 }));
    detector.handleTap(fakeTap(target, { at: 1 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
    detector.handleTap(fakeTap(target, { at: 2 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
    detector.handleTap(fakeTap(target, { at: 3 }));
    expect(onMultiTap).toHaveBeenCalledTimes(2);
  });

  it("ignores a tap whose target is inside an excluded element — text editing/seeking never locks", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const textarea = document.createElement("textarea");

    detector.handleTap(fakeTap(textarea, { at: 0 }));
    detector.handleTap(fakeTap(textarea, { at: 1 }));
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("an excluded tap neither counts nor breaks a real run already in progress", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");
    const textarea = document.createElement("textarea");

    detector.handleTap(fakeTap(target, { at: 0 })); // tap 1 of a real run
    detector.handleTap(fakeTap(textarea, { at: 1 })); // stray excluded tap in between
    detector.handleTap(fakeTap(target, { at: 2 })); // tap 2 — still completes the run
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("ignores non-primary buttons without counting or breaking a run", () => {
    // The recognizer already filters non-primary buttons before a tap is ever recognized
    // (button !== 0 on pointerdown); this pins the detector's own contract regardless.
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0 }));
    detector.handleTap(fakeTap(target, { at: 100 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("reset() clears an in-progress run without firing", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0 }));
    detector.reset();
    detector.handleTap(fakeTap(target, { at: 1 }));
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  // -- R3 v1.7 part 2: SAME PLACE ---------------------------------------------

  it("SAME PLACE: a second tap within MULTI_TAP_RADIUS_PX of the first pairs and locks", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0, x: 100, y: 100 }));
    detector.handleTap(fakeTap(target, { at: 1, x: 100 + MULTI_TAP_RADIUS_PX, y: 100 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("SAME PLACE: a second tap outside the radius does not pair, and starts a fresh run", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(target, { at: 1, x: MULTI_TAP_RADIUS_PX + 1, y: 0 }));
    expect(onMultiTap).not.toHaveBeenCalled();
    // The fresh run's first tap is the second one, at (33, 0) — a third tap back at (33, 0) pairs.
    detector.handleTap(fakeTap(target, { at: 2, x: MULTI_TAP_RADIUS_PX + 1, y: 0 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("SAME PLACE: two rapid taps 50px apart (a scroll flick's own two touch points) never lock", () => {
    // The operator's own report: rapid scrolling registered as a double-tap lock.
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handleTap(fakeTap(target, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(target, { at: 50, x: 0, y: 50 }));
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  // -- R3 v1.7 part 3: SAME THING ---------------------------------------------

  it("SAME THING: two adjacent menu rows a few px apart never lock — different zones", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const rowA = document.createElement("div");
    rowA.setAttribute("role", "menuitem");
    const rowB = document.createElement("div");
    rowB.setAttribute("role", "menuitem");

    detector.handleTap(fakeTap(rowA, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(rowB, { at: 1, x: 10, y: 0 })); // well within the radius
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("SAME THING: a bubble and the gap next to it never pair even a few px apart", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const bubble = document.createElement("div");
    bubble.className = "wx-srv-bubble";
    const gap = document.createElement("div"); // plain, unmarked space

    detector.handleTap(fakeTap(bubble, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(gap, { at: 1, x: 5, y: 0 }));
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("SAME THING: two taps on the SAME bubble, same place, still lock (baseline unaffected)", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const bubble = document.createElement("div");
    bubble.className = "wx-srv-bubble";

    detector.handleTap(fakeTap(bubble, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(bubble, { at: 1, x: 0, y: 0 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("SAME THING: two taps in open panel space (both null zone) still pair — today's baseline", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const a = document.createElement("div");
    const b = document.createElement("div");

    detector.handleTap(fakeTap(a, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(b, { at: 1, x: 0, y: 0 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  // -- v1.5 gesture boundaries (unchanged in meaning, exempt from place/zone) -----

  it("a boundary tap clears its unmatched run so the next choice tap starts fresh", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const boundary = document.createElement("button");
    boundary.setAttribute("data-srv-gesture-boundary", "");
    const boundaryChild = document.createElement("span");
    boundary.appendChild(boundaryChild);
    const choice = document.createElement("button");

    detector.handleTap(fakeTap(boundaryChild, { at: 0 }));
    detector.handleTap(fakeTap(choice, { at: 100 }));
    expect(onMultiTap).not.toHaveBeenCalled();

    detector.handleTap(fakeTap(choice, { at: 200 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("a boundary tap can complete a run that started on an unrelated control, anywhere", () => {
    // Boundary chains are exempt from SAME PLACE/SAME THING — an "open here, confirm there"
    // flow is legitimately spread across different controls at different positions.
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const unrelated = document.createElement("div");
    const boundary = document.createElement("button");
    boundary.setAttribute("data-srv-gesture-boundary", "");

    detector.handleTap(fakeTap(unrelated, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(boundary, { at: 100, x: 900, y: 900 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("runs a boundary open-pick-confirm chain at any speed and any position without locking", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const trigger = gestureBoundary();
    const menuItem = gestureBoundary();
    const confirm = document.createElement("button");

    detector.handleTap(fakeTap(trigger, { at: 0, x: 0, y: 0 }));
    detector.handleTap(fakeTap(menuItem, { at: 1, x: 500, y: 500 }));
    detector.handleTap(fakeTap(confirm, { at: 2, x: 900, y: 900 }));

    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("does not lock on two taps starting at a boundary, but locks on the third", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const trigger = gestureBoundary();

    detector.handleTap(fakeTap(trigger, { at: 0 }));
    detector.handleTap(fakeTap(trigger, { at: 1 }));
    expect(onMultiTap).not.toHaveBeenCalled();
    detector.handleTap(fakeTap(trigger, { at: 2 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });
});

describe("attachTapRecognizer (via attachMultiTapListener) — R3 v1.7 part 1: what counts as a TAP", () => {
  it("attaches to the document in the CAPTURE phase, for every Pointer Event kind it needs", () => {
    const detector = createMultiTapDetector(vi.fn());
    const addSpy = vi.spyOn(document, "addEventListener");
    const detach = attachMultiTapListener(document, detector);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      expect(addSpy).toHaveBeenCalledWith(type, expect.any(Function), { capture: true });
    }
    addSpy.mockRestore();
    detach();
  });

  it("a down+up pair in the same spot, quickly, is recognized as one tap and can pair with a second", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 10, clientY: 10 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);

    detach();
    target.remove();
  });

  it("a lone pointerdown with no matching pointerup is never a tap", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onMultiTap).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("moving more than TAP_SLOP_PX before pointerup is a drag/flick, not a tap", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    target.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: TAP_SLOP_PX + 1, clientY: 0 }),
    );
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    expect(onMultiTap).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("a pointermove past the slop before pointerup also disqualifies the tap (not just the final position)", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    // Wanders far away, then comes back close to the start before releasing.
    target.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: TAP_SLOP_PX + 50, clientY: 0 }),
    );
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 1, clientY: 0 }));
    expect(onMultiTap).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("holding past TAP_MAX_MS before releasing is a long-press, not a tap", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector, () => now);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    now = TAP_MAX_MS + 1;
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    now += 1;
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    now += 1;
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(onMultiTap).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("releasing exactly at TAP_MAX_MS still counts (<=, not <)", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector, () => now);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    now = TAP_MAX_MS;
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    now += 1;
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    now += 1;
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);

    detach();
    target.remove();
  });

  it("a pointercancel — what the browser fires when it takes a touch over for scrolling — is never a tap", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })); // stray, no candidate left
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(onMultiTap).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("tracks independent candidates per pointerId — an unrelated second pointer can't corrupt the first's tap", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    // A second finger touches down far away and drags off — must not affect pointer 1's candidate.
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 500, clientY: 500 }));
    target.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 2 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);

    detach();
    target.remove();
  });

  it("ignores non-primary buttons — a right-click pointerdown starts no candidate", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 2 }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onMultiTap).not.toHaveBeenCalled();
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);

    detach();
    target.remove();
  });

  it("a mouse double-click (two ordinary pointerdown/pointerup pairs in the same spot) still locks", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 40 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 40 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);

    detach();
    target.remove();
  });

  it("ignores a non-PointerEvent dispatch of the same type — never mixes touch/mouse in", () => {
    const handleTap = vi.fn();
    const detector = { handleTap, reset: vi.fn() };
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    // A plain Event named "pointerdown"/"pointerup" is not a PointerEvent instance — the shape a
    // touch/mouse compatibility shim's own synthetic dispatch would take if one were ever
    // (wrongly) wired in alongside this listener.
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    target.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(handleTap).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("stops forwarding once detached", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const detach = attachMultiTapListener(document, detector);
    detach();

    const target = document.createElement("div");
    document.body.appendChild(target);
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onMultiTap).not.toHaveBeenCalled();
    target.remove();
  });
});

// -- R2 v1.3 (operator decision #974): single-tap-on-the-decoy-reveals -------

describe("createTapDetector", () => {
  it("fires onTap for a single recognized tap — no counting, no interval", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    detector.handleTap(fakeTap(document.createElement("div")));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("fires onTap again for every subsequent tap, independently", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const target = document.createElement("div");
    detector.handleTap(fakeTap(target));
    detector.handleTap(fakeTap(target));
    detector.handleTap(fakeTap(target));
    expect(onTap).toHaveBeenCalledTimes(3);
  });

  it("ignores a tap whose target is inside an excluded element", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    detector.handleTap(fakeTap(document.createElement("textarea")));
    expect(onTap).not.toHaveBeenCalled();
  });
});

describe("attachTapListener", () => {
  it("attaches to the given target (the panel's own root) in the CAPTURE phase", () => {
    const root = document.createElement("div");
    const detector = createTapDetector(vi.fn());
    const addSpy = vi.spyOn(root, "addEventListener");
    const detach = attachTapListener(root, detector);
    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), { capture: true });
    addSpy.mockRestore();
    detach();
  });

  it("fires for a tap on the target itself or any descendant", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const root = document.createElement("div");
    const child = document.createElement("span");
    root.appendChild(child);
    document.body.appendChild(root);
    const detach = attachTapListener(root, detector);

    child.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    child.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onTap).toHaveBeenCalledTimes(1);

    detach();
    root.remove();
  });

  it("a flick (moved past the slop) does not reveal — real tap recognition applies here too", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const detach = attachTapListener(root, detector);

    root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    root.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: TAP_SLOP_PX + 20, clientY: 0 }));
    expect(onTap).not.toHaveBeenCalled();

    detach();
    root.remove();
  });

  it("R2 v1.3: 'not nav/topbar' is free — a tap OUTSIDE the target's subtree never reaches it", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const root = document.createElement("div");
    const outside = document.createElement("button"); // e.g. a nav item, a sibling of root
    document.body.append(root, outside);
    const detach = attachTapListener(root, detector);

    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onTap).not.toHaveBeenCalled();

    detach();
    root.remove();
    outside.remove();
  });

  it("ignores a non-PointerEvent dispatch of the same type", () => {
    const handleTap = vi.fn();
    const detector = { handleTap };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const detach = attachTapListener(root, detector);

    root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    root.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(handleTap).not.toHaveBeenCalled();

    detach();
    root.remove();
  });

  it("stops forwarding once detached", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const detach = attachTapListener(root, detector);
    detach();

    root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    root.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(onTap).not.toHaveBeenCalled();
    root.remove();
  });
});

describe("[data-srv-gesture-exempt] (the inline PIN pad inside the unlocked chat)", () => {
  function exemptGroup(): { readonly group: HTMLDivElement; readonly key: HTMLButtonElement } {
    const group = document.createElement("div");
    group.setAttribute("data-srv-gesture-exempt", "");
    const key = document.createElement("button");
    group.appendChild(key);
    return { group, key };
  }

  it("excludes the marked element and every descendant from tap detection", () => {
    const { group, key } = exemptGroup();
    expect(isExcludedTapTarget(group)).toBe(true);
    expect(isExcludedTapTarget(key)).toBe(true);
    expect(isExcludedTapTarget(document.createElement("button"))).toBe(false);
  });

  it("taps inside the group never count toward a multi-tap, however fast", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const { key } = exemptGroup();
    for (let i = 0; i < MULTI_TAP_COUNT * 4; i++) {
      detector.handleTap(fakeTap(key, { at: i * 10 }));
    }
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("an exempt tap neither completes a pair with an ordinary tap nor breaks the run", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const { key } = exemptGroup();
    const other = document.createElement("button");
    detector.handleTap(fakeTap(other, { at: 0 }));
    detector.handleTap(fakeTap(key, { at: 10 }));
    expect(onMultiTap).not.toHaveBeenCalled();
    detector.handleTap(fakeTap(other, { at: 20 }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("the single-tap detector ignores the group too", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const { key } = exemptGroup();
    detector.handleTap(fakeTap(key));
    expect(onTap).not.toHaveBeenCalled();
  });

  it("taps outside the group still count", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("button");
    for (let i = 0; i < MULTI_TAP_COUNT; i++) {
      detector.handleTap(fakeTap(target, { at: i * (MULTI_TAP_INTERVAL_MS - 1) }));
    }
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });
});
