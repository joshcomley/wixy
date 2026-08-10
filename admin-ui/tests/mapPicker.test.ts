import { describe, expect, it, vi } from "vitest";
import { mountMapPicker } from "../src/mapPicker";

function fakeWindow(): Window {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    // Fires synchronously — jsdom has no real layout/paint loop to wait on,
    // and every consumer here (`renderTiles`) already tolerates being called
    // before `clientWidth` reflects a real size (the 320px fallback).
    requestAnimationFrame: (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    },
  } as unknown as Window;
}

function pointerEvent(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId, bubbles: true });
}

// jsdom implements neither `setPointerCapture` nor `getBoundingClientRect`
// meaningfully — both are called by `mapPicker.ts` but their return values
// (an empty rect, capture as a no-op) are exactly what the fallback-width
// code path already tolerates, so no shim is needed beyond this stub.
function stubPointerCapture(el: HTMLElement): void {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
}

describe("mountMapPicker", () => {
  it("renders a viewport, attribution link, and zoom controls", () => {
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin: vi.fn(), onClear: vi.fn() });
    expect(element.querySelector(".wx-map-viewport")).not.toBeNull();
    const attribution = element.querySelector<HTMLAnchorElement>(".wx-map-attribution");
    expect(attribution?.textContent).toBe("© OpenStreetMap contributors");
    expect(attribution?.href).toBe("https://www.openstreetmap.org/copyright");
    expect(element.querySelectorAll(".wx-map-zoom-button")).toHaveLength(2);
  });

  it("paints tiles on mount (via the injected requestAnimationFrame)", () => {
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin: vi.fn(), onClear: vi.fn() });
    expect(element.querySelectorAll(".wx-map-tile").length).toBeGreaterThan(0);
  });

  it("shows no marker and a disabled Clear button when no pin is set", () => {
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin: vi.fn(), onClear: vi.fn() });
    expect(element.querySelector<HTMLElement>(".wx-map-marker")?.hidden).toBe(true);
    expect(element.querySelector<HTMLButtonElement>(".wx-map-clear-button")?.disabled).toBe(true);
  });

  it("shows a marker and an enabled Clear button when a pin is already set", () => {
    const { element } = mountMapPicker({
      win: fakeWindow(),
      initialCoords: "52.379464,-2.222315",
      onPin: vi.fn(),
      onClear: vi.fn(),
    });
    expect(element.querySelector<HTMLElement>(".wx-map-marker")?.hidden).toBe(false);
    expect(element.querySelector<HTMLButtonElement>(".wx-map-clear-button")?.disabled).toBe(false);
    expect(element.querySelector<HTMLInputElement>(".wx-map-coords-input")?.value).toBe("52.379464,-2.222315");
  });

  it("arms and disarms via the toggle button", () => {
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin: vi.fn(), onClear: vi.fn() });
    const armButton = element.querySelector<HTMLButtonElement>(".wx-map-arm-button");
    if (armButton === null) throw new Error("no arm button");
    expect(armButton.textContent).toBe("Click to pin coordinates");
    armButton.click();
    expect(armButton.textContent).toContain("Click the map");
    armButton.click();
    expect(armButton.textContent).toBe("Click to pin coordinates");
  });

  it("Escape disarms", () => {
    const win = fakeWindow();
    const { element } = mountMapPicker({ win, initialCoords: "", onPin: vi.fn(), onClear: vi.fn() });
    const armButton = element.querySelector<HTMLButtonElement>(".wx-map-arm-button");
    armButton?.click();
    expect(armButton?.textContent).toContain("Click the map");
    win.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(armButton?.textContent).toBe("Click to pin coordinates");
  });

  it("a click on the map while UNARMED does nothing", () => {
    const onPin = vi.fn();
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin, onClear: vi.fn() });
    const viewport = element.querySelector<HTMLElement>(".wx-map-viewport");
    if (viewport === null) throw new Error("no viewport");
    stubPointerCapture(viewport);
    viewport.dispatchEvent(pointerEvent("pointerdown", 160, 140));
    viewport.dispatchEvent(pointerEvent("pointerup", 160, 140));
    expect(onPin).not.toHaveBeenCalled();
  });

  it("an armed click at the viewport's visual center places a pin at the current center coordinates", () => {
    const onPin = vi.fn();
    const { element } = mountMapPicker({
      win: fakeWindow(),
      initialCoords: "52.379464,-2.222315",
      onPin,
      onClear: vi.fn(),
    });
    const viewport = element.querySelector<HTMLElement>(".wx-map-viewport");
    const armButton = element.querySelector<HTMLButtonElement>(".wx-map-arm-button");
    if (viewport === null || armButton === null) throw new Error("missing elements");
    stubPointerCapture(viewport);
    armButton.click();
    // (160, 140) is the center of the 320(fallback)×280 viewport this
    // component assumes pre-layout — a click there should reproduce the
    // current center (== the seeded pin, since the map opens centered on it).
    viewport.dispatchEvent(pointerEvent("pointerdown", 160, 140));
    viewport.dispatchEvent(pointerEvent("pointerup", 160, 140));
    expect(onPin).toHaveBeenCalledTimes(1);
    const [coords] = onPin.mock.calls[0] as [string];
    const [lat, lng] = coords.split(",").map(Number);
    expect(lat).toBeCloseTo(52.379464, 3);
    expect(lng).toBeCloseTo(-2.222315, 3);
    // Armed mode clears itself after a successful placement.
    expect(armButton.textContent).toBe("Click to pin coordinates");
  });

  it("a drag (movement past the click/drag threshold) never calls onPin even while armed", () => {
    const onPin = vi.fn();
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin, onClear: vi.fn() });
    const viewport = element.querySelector<HTMLElement>(".wx-map-viewport");
    const armButton = element.querySelector<HTMLButtonElement>(".wx-map-arm-button");
    if (viewport === null || armButton === null) throw new Error("missing elements");
    stubPointerCapture(viewport);
    armButton.click();
    viewport.dispatchEvent(pointerEvent("pointerdown", 100, 100));
    viewport.dispatchEvent(pointerEvent("pointermove", 140, 100));
    viewport.dispatchEvent(pointerEvent("pointerup", 140, 100));
    expect(onPin).not.toHaveBeenCalled();
  });

  it("typing a valid \"lat, lng\" and blurring commits via onPin", () => {
    const onPin = vi.fn();
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin, onClear: vi.fn() });
    const input = element.querySelector<HTMLInputElement>(".wx-map-coords-input");
    if (input === null) throw new Error("no coords input");
    input.value = "52.379464, -2.222315";
    input.dispatchEvent(new Event("change"));
    expect(onPin).toHaveBeenCalledWith("52.379464,-2.222315");
    // Reformatted to the canonical no-space form for display too.
    expect(input.value).toBe("52.379464,-2.222315");
  });

  it("typing invalid coordinates shows an inline hint and never commits", () => {
    const onPin = vi.fn();
    const { element } = mountMapPicker({ win: fakeWindow(), initialCoords: "", onPin, onClear: vi.fn() });
    const input = element.querySelector<HTMLInputElement>(".wx-map-coords-input");
    const hint = element.querySelector<HTMLElement>(".wx-map-coords-hint");
    if (input === null || hint === null) throw new Error("missing elements");
    input.value = "not coordinates";
    input.dispatchEvent(new Event("change"));
    expect(onPin).not.toHaveBeenCalled();
    expect(hint.textContent).toContain("doesn't look like");
  });

  it("Clear pin calls onClear and disables itself", () => {
    const onClear = vi.fn();
    const { element } = mountMapPicker({
      win: fakeWindow(),
      initialCoords: "52.379464,-2.222315",
      onPin: vi.fn(),
      onClear,
    });
    const clearButton = element.querySelector<HTMLButtonElement>(".wx-map-clear-button");
    clearButton?.click();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(clearButton?.disabled).toBe(true);
    expect(element.querySelector<HTMLInputElement>(".wx-map-coords-input")?.value).toBe("");
  });

  it("teardown removes the window keydown listener", () => {
    const win = fakeWindow();
    const removeSpy = vi.spyOn(win, "removeEventListener");
    const { teardown } = mountMapPicker({ win, initialCoords: "", onPin: vi.fn(), onClear: vi.fn() });
    teardown();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
