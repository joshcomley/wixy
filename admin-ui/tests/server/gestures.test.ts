// R3's multi-tap detector: Pointer Events only, the exact exclusion list,
// interval-based debouncing on an injectable clock, capture-phase attachment.

import { describe, expect, it, vi } from "vitest";
import { MULTI_TAP_COUNT, MULTI_TAP_INTERVAL_MS } from "../../src/server/constants";
import {
  attachMultiTapListener,
  attachTapListener,
  createMultiTapDetector,
  createTapDetector,
  isExcludedTapTarget,
  isGestureBoundaryTarget,
} from "../../src/server/gestures";

function fakeEvent(target: EventTarget, button = 0): PointerEvent {
  return { target, button } as unknown as PointerEvent;
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

describe("createMultiTapDetector", () => {
  it("fires onMultiTap once MULTI_TAP_COUNT taps land within the interval", () => {
    expect(MULTI_TAP_COUNT).toBe(2);
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).not.toHaveBeenCalled();
    now += MULTI_TAP_INTERVAL_MS - 1;
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the gap between taps exceeds the interval, but the second tap starts a fresh run", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target));
    now += MULTI_TAP_INTERVAL_MS + 1;
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).not.toHaveBeenCalled();
    now += 1;
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("fires exactly at the interval boundary (<=, not <)", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target));
    now += MULTI_TAP_INTERVAL_MS;
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("resets the count after firing — a lone third tap doesn't immediately refire", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target));
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(2);
  });

  it("ignores a tap whose target is inside an excluded element — text editing/seeking never locks", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap, () => 0);
    const textarea = document.createElement("textarea");

    detector.handlePointerDown(fakeEvent(textarea));
    detector.handlePointerDown(fakeEvent(textarea));
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("an excluded tap neither counts nor breaks a real run already in progress", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap, () => 0);
    const target = document.createElement("div");
    const textarea = document.createElement("textarea");

    detector.handlePointerDown(fakeEvent(target)); // tap 1 of a real run
    detector.handlePointerDown(fakeEvent(textarea)); // stray excluded tap in between
    detector.handlePointerDown(fakeEvent(target)); // tap 2 — still completes the run
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("a boundary tap clears its unmatched run so the next choice tap starts fresh", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const boundary = document.createElement("button");
    boundary.setAttribute("data-srv-gesture-boundary", "");
    const boundaryChild = document.createElement("span");
    boundary.appendChild(boundaryChild);
    const choice = document.createElement("button");

    detector.handlePointerDown(fakeEvent(boundaryChild));
    now += 100;
    detector.handlePointerDown(fakeEvent(choice));
    expect(onMultiTap).not.toHaveBeenCalled();

    now += 100;
    detector.handlePointerDown(fakeEvent(choice));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("a boundary tap can complete a run that started on an unrelated control", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const unrelated = document.createElement("div");
    const boundary = document.createElement("button");
    boundary.setAttribute("data-srv-gesture-boundary", "");

    detector.handlePointerDown(fakeEvent(unrelated));
    now += 100;
    detector.handlePointerDown(fakeEvent(boundary));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("ignores non-primary buttons without counting or breaking a run", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target, 2)); // right-click
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).not.toHaveBeenCalled();
    now += 100;
    detector.handlePointerDown(fakeEvent(target, 1)); // middle-click
    now += 100;
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("reset() clears an in-progress run without firing", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap, () => 0);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target));
    detector.reset();
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("defaults its clock to performance.now() when none is injected", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target));
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledTimes(1);
  });

  it("runs a boundary open-pick-confirm chain at any speed without locking", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const trigger = gestureBoundary();
    const menuItem = gestureBoundary();
    const confirm = document.createElement("button");

    detector.handlePointerDown(fakeEvent(trigger));
    now += 1;
    detector.handlePointerDown(fakeEvent(menuItem));
    now += 1;
    detector.handlePointerDown(fakeEvent(confirm));

    expect(onMultiTap).not.toHaveBeenCalled();
  });

  it("lets a boundary close a run started by an unrelated tap", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    detector.handlePointerDown(fakeEvent(document.createElement("div")));
    now += 1;
    detector.handlePointerDown(fakeEvent(gestureBoundary()));
    expect(onMultiTap).toHaveBeenCalledOnce();
  });

  it("does not lock on two taps starting at a boundary, but locks on the third", () => {
    const onMultiTap = vi.fn();
    let now = 0;
    const detector = createMultiTapDetector(onMultiTap, () => now);
    const trigger = gestureBoundary();

    detector.handlePointerDown(fakeEvent(trigger));
    now += 1;
    detector.handlePointerDown(fakeEvent(trigger));
    expect(onMultiTap).not.toHaveBeenCalled();
    now += 1;
    detector.handlePointerDown(fakeEvent(trigger));
    expect(onMultiTap).toHaveBeenCalledOnce();
  });

  it("ignores non-primary pointerdowns", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap, () => 0);
    const target = document.createElement("div");

    detector.handlePointerDown(fakeEvent(target, 2));
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).not.toHaveBeenCalled();
    detector.handlePointerDown(fakeEvent(target));
    expect(onMultiTap).toHaveBeenCalledOnce();
  });
});

describe("attachMultiTapListener", () => {
  it("attaches to the document in the CAPTURE phase", () => {
    const detector = createMultiTapDetector(vi.fn(), () => 0);
    const addSpy = vi.spyOn(document, "addEventListener");
    const detach = attachMultiTapListener(document, detector);
    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), { capture: true });
    addSpy.mockRestore();
    detach();
  });

  it("forwards real PointerEvents bubbling from anywhere in the document", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap, () => 0);
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onMultiTap).toHaveBeenCalledTimes(1);

    detach();
    target.remove();
  });

  it("ignores a non-PointerEvent dispatch of the same type — never mixes touch/mouse in", () => {
    const handlePointerDown = vi.fn();
    const detector = { handlePointerDown, reset: vi.fn() };
    const detach = attachMultiTapListener(document, detector);
    const target = document.createElement("div");
    document.body.appendChild(target);

    // A plain Event named "pointerdown" is not a PointerEvent instance — the
    // shape a touch/mouse compatibility shim's own synthetic dispatch would
    // take if one were ever (wrongly) wired in alongside this listener.
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(handlePointerDown).not.toHaveBeenCalled();

    detach();
    target.remove();
  });

  it("stops forwarding once detached", () => {
    const onMultiTap = vi.fn();
    const detector = createMultiTapDetector(onMultiTap, () => 0);
    const detach = attachMultiTapListener(document, detector);
    detach();

    const target = document.createElement("div");
    document.body.appendChild(target);
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onMultiTap).not.toHaveBeenCalled();
    target.remove();
  });
});

// -- R2 v1.3 (operator decision #974): single-tap-on-the-decoy-reveals -------

describe("createTapDetector", () => {
  it("fires onTap immediately for a single qualifying tap — no counting, no interval", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    detector.handlePointerDown(fakeEvent(document.createElement("div")));
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("fires onTap again for every subsequent tap, independently", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    const target = document.createElement("div");
    detector.handlePointerDown(fakeEvent(target));
    detector.handlePointerDown(fakeEvent(target));
    detector.handlePointerDown(fakeEvent(target));
    expect(onTap).toHaveBeenCalledTimes(3);
  });

  it("ignores a tap whose target is inside an excluded element", () => {
    const onTap = vi.fn();
    const detector = createTapDetector(onTap);
    detector.handlePointerDown(fakeEvent(document.createElement("textarea")));
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
    expect(onTap).toHaveBeenCalledTimes(1);

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
    expect(onTap).not.toHaveBeenCalled();

    detach();
    root.remove();
    outside.remove();
  });

  it("ignores a non-PointerEvent dispatch of the same type", () => {
    const handlePointerDown = vi.fn();
    const detector = { handlePointerDown };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const detach = attachTapListener(root, detector);

    root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(handlePointerDown).not.toHaveBeenCalled();

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
    expect(onTap).not.toHaveBeenCalled();
    root.remove();
  });
});
