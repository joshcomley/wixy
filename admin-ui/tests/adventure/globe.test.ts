import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraFromRotation, type Camera } from "../../src/server/adventure/camera";
import { createGlobeRenderer, type GlobeFrame } from "../../src/server/adventure/globe";
import { Trail } from "../../src/server/adventure/trail";
import { fixtureWorld } from "../fixtures/adventureWorld";
import { canvasWith, recordingContext } from "../fixtures/stubContext";

beforeEach(() => {
  // jsdom has no canvas: any canvas the renderer makes for itself (the still-map cache, the imagery layer)
  // gets a quiet null context instead of a "not implemented" error. `canvasWith` overrides single canvases.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as never);
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const world = fixtureWorld();
const WHOLE: GlobeFrame = { view: { rotation: [-5, -5], viewRadiusDeg: 90 }, pin: { kind: "centre" } };

function renderer(rec = recordingContext(), size: [number, number, number] = [300, 500, 2]) {
  const canvas = canvasWith(rec);
  const globe = createGlobeRenderer(canvas, world, { imagery: false });
  globe.resize(...size);
  rec.clear();
  return { canvas, globe, rec };
}

describe("without a 2D context", () => {
  it("never throws and draws nothing", () => {
    const canvas = canvasWith(null);
    const globe = createGlobeRenderer(canvas, world, { imagery: false });
    globe.resize(300, 500, 2);
    expect(() => globe.draw(WHOLE, 0)).not.toThrow();
    expect(globe.project(0, 0)).toBeNull();
    expect(globe.invert(10, 10)).toBeNull();
    expect(() => globe.destroy()).not.toThrow();
  });

  it("is a no-op before the first resize", () => {
    const rec = recordingContext();
    const globe = createGlobeRenderer(canvasWith(rec), world, { imagery: false });
    globe.draw(WHOLE, 0);
    expect(rec.calls).toEqual([]);
  });
});

describe("resize", () => {
  it("sizes the canvas in device pixels (dpr clamped at 2) and its box in CSS pixels", () => {
    const { canvas } = renderer(recordingContext(), [300, 500, 3]);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(1000);
    expect(canvas.style.width).toBe("300px");
    expect(canvas.style.height).toBe("500px");
  });

  it("copes with silly sizes and ratios", () => {
    const { canvas, globe } = renderer(recordingContext(), [0, 0, Number.NaN]);
    expect(canvas.width).toBe(0);
    expect(() => globe.draw(WHOLE, 0)).not.toThrow();
  });
});

describe("draw", () => {
  it("paints the whole-globe frame without throwing: ocean, land, borders, pin", () => {
    const { globe, rec } = renderer();
    globe.draw(WHOLE, 0);
    expect(rec.count("clearRect")).toBe(1);
    expect(rec.count("createRadialGradient")).toBeGreaterThanOrEqual(2); // halo + sea (+ shading, pin body)
    expect(rec.count("fill")).toBeGreaterThanOrEqual(3);
    expect(rec.count("stroke")).toBeGreaterThanOrEqual(2);
    expect(rec.count("bezierCurveTo")).toBe(2); // the pin
    expect(rec.count("save")).toBe(rec.count("restore"));
  });

  it("picks the geometry level from the view radius, and `moving` forces the cheap one", () => {
    const { globe } = renderer();
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 90 } }, 0);
    expect(globe.lastLevel).toBe("coarse");
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 59 } }, 0);
    expect(globe.lastLevel).toBe("detail");
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 59 }, moving: true }, 0);
    expect(globe.lastLevel).toBe("coarse");
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 90 }, level: "detail" }, 0);
    expect(globe.lastLevel).toBe("detail");
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 10 }, level: "coarse" }, 0);
    expect(globe.lastLevel).toBe("coarse");
  });

  it("accepts a camera, a raw rotation, a tumbled rotation and a roll", () => {
    const { globe } = renderer();
    const cameras: Array<GlobeFrame["view"]> = [
      { centre: [5, 5], viewRadiusDeg: 20 },
      { centre: [5, 5], viewRadiusDeg: 20, roll: 180 },
      { rotation: [20, 120] },
      { rotation: [20, -200, 15], viewRadiusDeg: 40 },
      cameraFromRotation([-75, 450], 60) satisfies Camera,
      { centre: [179.9, 89.9], viewRadiusDeg: 0.3 },
    ];
    for (const view of cameras) expect(() => globe.draw({ view }, 0)).not.toThrow();
  });

  it("outlines the candidates, tints the lit and chosen units and mutes the rest", () => {
    const { globe, rec } = renderer();
    globe.draw({ view: { centre: [10, 5], viewRadiusDeg: 25 }, emphasis: { candidateUnits: ["AAA", "BBB"], litUnit: "AAA" } }, 0);
    const calls = rec.calls.length;
    expect(calls).toBeGreaterThan(40);
    expect(rec.props["strokeStyle"]).toBeDefined();
    rec.clear();
    globe.draw({ view: { centre: [10, 5], viewRadiusDeg: 25 }, emphasis: { chosenUnit: "BBB" } }, 0);
    expect(rec.count("fill")).toBeGreaterThanOrEqual(2); // land + the chosen unit's accent
  });

  it("paints unknown units in the emphasis as nothing (no throw)", () => {
    const { globe } = renderer();
    expect(() =>
      globe.draw({ view: { centre: [10, 5], viewRadiusDeg: 25 }, emphasis: { candidateUnits: ["NOPE"], litUnit: "NOPE", chosenUnit: "NOPE" } }, 0),
    ).not.toThrow();
  });

  it("draws dots with halos and labels, and drops a label that would fall under an overlay", () => {
    const frame = (avoid: GlobeFrame["avoid"]): GlobeFrame => ({
      view: { centre: [5, 5], viewRadiusDeg: 15 },
      dots: [{ id: "a", lng: 5, lat: 5, label: "Alpha place" }],
      ...(avoid === undefined ? {} : { avoid }),
    });
    const free = renderer();
    free.globe.draw(frame(undefined), 0);
    expect(free.rec.calls.some((c) => c[0] === "fillText" && c[1] === "Alpha place")).toBe(true);
    // The dot sits at the centre of a 300 x 500 canvas: cover every spot a label could take.
    const covered = renderer();
    covered.globe.draw(frame([{ x: 0, y: 0, w: 300, h: 500 }]), 0);
    expect(covered.rec.calls.some((c) => c[0] === "fillText")).toBe(false);
    expect(covered.rec.count("arc")).toBeGreaterThan(0); // the dot itself is still there
  });

  it("moves a label off a smaller overlay instead of dropping it", () => {
    const { globe, rec } = renderer();
    // A banner right of the dot: the label goes left (or above/below).
    globe.draw(
      { view: { centre: [5, 5], viewRadiusDeg: 15 }, dots: [{ id: "a", lng: 5, lat: 5, label: "Spot" }], avoid: [{ x: 160, y: 230, w: 120, h: 40 }] },
      0,
    );
    const text = rec.calls.find((c) => c[0] === "fillText");
    expect(text).toBeDefined();
    expect((text as [string, string, number, number])[2]).toBeLessThan(160);
  });

  it("does not draw dots on the far side of the globe", () => {
    const { globe, rec } = renderer();
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 90 }, dots: [{ id: "far", lng: 185, lat: -5, label: "Hidden" }] }, 0);
    expect(rec.calls.some((c) => c[0] === "fillText")).toBe(false);
  });

  it("draws the pin dropping, a pin at a point, a ripple and a glide", () => {
    const { globe, rec } = renderer();
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 40 }, pin: { kind: "point", lng: 5, lat: 5, drop: 0.4 } }, 0);
    expect(rec.count("bezierCurveTo")).toBe(2);
    rec.clear();
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 40 }, ripple: { progress: 0.5 } }, 0);
    expect(rec.count("arc")).toBeGreaterThanOrEqual(3);
    rec.clear();
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 40 }, glide: { from: [3, 3], to: [8, 6], progress: 0.7 } }, 0);
    expect(rec.count("setLineDash")).toBe(1);
  });

  it("draws the swipe trail, and not under reduced motion", () => {
    const trail = new Trail();
    for (let i = 0; i < 8; i += 1) trail.add(i * 0.05, 0.1, 1000 + i * 12);
    const normal = renderer();
    normal.globe.draw({ ...WHOLE, trail }, 1100);
    expect(normal.rec.count("quadraticCurveTo")).toBeGreaterThan(0);
    const reduced = renderer();
    reduced.globe.draw({ ...WHOLE, trail, reducedMotion: true }, 1100);
    expect(reduced.rec.count("quadraticCurveTo")).toBe(0);
  });

  it("is pure over its inputs: the same frame at the same time makes the same calls", () => {
    const a = renderer();
    const b = renderer();
    const frame: GlobeFrame = { view: { centre: [10, 5], viewRadiusDeg: 25 }, emphasis: { candidateUnits: ["AAA"], litUnit: "AAA" }, pin: { kind: "centre" } };
    a.globe.draw(frame, 1234);
    b.globe.draw(frame, 1234);
    expect(JSON.stringify(a.rec.calls)).toBe(JSON.stringify(b.rec.calls));
  });

  it("is a no-op after destroy", () => {
    const { globe, rec } = renderer();
    globe.destroy();
    globe.draw(WHOLE, 0);
    expect(rec.calls).toEqual([]);
    expect(() => globe.resize(10, 10, 1)).not.toThrow();
  });
});

describe("project and invert", () => {
  it("map the view centre to the middle of the canvas and back", () => {
    const { globe } = renderer(recordingContext(), [300, 500, 2]);
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 90 } }, 0);
    const p = globe.project(5, 5);
    expect(p?.[0]).toBeCloseTo(150, 6);
    expect(p?.[1]).toBeCloseTo(250, 6);
    const back = globe.invert(150, 250);
    expect(back?.[0]).toBeCloseTo(5, 6);
    expect(back?.[1]).toBeCloseTo(5, 6);
  });

  it("report null for a point on the far side and a pixel off the globe", () => {
    const { globe } = renderer(recordingContext(), [300, 500, 2]);
    globe.draw({ view: { centre: [5, 5], viewRadiusDeg: 90 } }, 0);
    expect(globe.project(185, -5)).toBeNull();
    expect(globe.invert(2, 2)).toBeNull();
  });

  it("follow the zoom: a 20 degree view puts a point 10 degrees away at half the radius from the middle", () => {
    const { globe } = renderer(recordingContext(), [300, 500, 2]);
    globe.draw({ view: { centre: [0, 0], viewRadiusDeg: 20 } }, 0);
    const p = globe.project(10, 0);
    // 0.45 * min(w, h) = 135 pixels show 20 degrees: R = 135 / sin(20 deg); 10 degrees out is R sin(10 deg).
    const expected = (135 / Math.sin((20 * Math.PI) / 180)) * Math.sin((10 * Math.PI) / 180);
    expect((p?.[0] ?? 0) - 150).toBeCloseTo(expected, 6);
  });
});

describe("the still-map cache", () => {
  it("paints a resting view once into an offscreen canvas and blits it afterwards", () => {
    const rec = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => rec.ctx) as never);
    const canvas = document.createElement("canvas");
    const globe = createGlobeRenderer(canvas, world, { imagery: false });
    globe.resize(300, 500, 1);
    rec.clear();
    const frame: GlobeFrame = { view: { centre: [10, 5], viewRadiusDeg: 25 }, emphasis: { candidateUnits: ["AAA", "BBB"], litUnit: "AAA" } };
    globe.draw(frame, 0);
    const first = rec.count("drawImage");
    const fillsFirst = rec.count("fill");
    rec.clear();
    globe.draw({ ...frame, emphasis: { candidateUnits: ["AAA", "BBB"], litUnit: "BBB" } }, 90);
    expect(first).toBe(1);
    expect(rec.count("drawImage")).toBe(1);
    expect(rec.count("fill")).toBeLessThan(fillsFirst); // the map was not repainted, only the lit unit
  });

  it("does not use the cache while the view is moving", () => {
    const rec = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => rec.ctx) as never);
    const globe = createGlobeRenderer(document.createElement("canvas"), world, { imagery: false });
    globe.resize(300, 500, 1);
    rec.clear();
    globe.draw({ view: { centre: [10, 5], viewRadiusDeg: 25 }, moving: true }, 0);
    expect(rec.count("drawImage")).toBe(0);
  });
});

describe("map style and imagery", () => {
  it("is always classic with imagery switched off, and a style change does nothing", () => {
    const { globe } = renderer();
    expect(globe.mapStyle).toBe("classic");
    globe.setMapStyle("satellite");
    expect(globe.mapStyle).toBe("classic");
    expect(globe.imageryAvailable).toBe(false);
    expect(globe.textured).toBe(false);
  });

  it("starts from this device's saved style and saves a change", () => {
    window.localStorage.setItem("wixy.adventure.mapStyle", "atlas");
    const globe = createGlobeRenderer(canvasWith(recordingContext()), world);
    expect(globe.mapStyle).toBe("atlas");
    globe.setMapStyle("classic");
    expect(globe.mapStyle).toBe("classic");
    expect(window.localStorage.getItem("wixy.adventure.mapStyle")).toBe("classic");
    globe.destroy();
  });

  it("falls back to classic, silently, where WebGL 2 is missing", () => {
    const rec = recordingContext();
    const canvas = canvasWith(rec);
    const host = document.createElement("div");
    host.append(canvas);
    document.body.append(host);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as never);
    const loader = vi.fn(async () => {
      throw new Error("never asked");
    });
    const globe = createGlobeRenderer(canvas, world, { imagery: { loader } });
    globe.resize(300, 500, 1);
    globe.draw(WHOLE, 0);
    expect(globe.imageryAvailable).toBe(false);
    expect(globe.textured).toBe(false);
    expect(host.querySelectorAll("canvas").length).toBe(1); // no stray imagery canvas left behind
    globe.destroy();
    host.remove();
  });

  it("keeps drawing the classic map when the picture fails to load", async () => {
    const rec = recordingContext();
    const globe = createGlobeRenderer(canvasWith(rec), world, {
      imagery: {
        style: "satellite",
        loader: async () => {
          throw new Error("offline");
        },
      },
    });
    globe.resize(300, 500, 1);
    globe.draw(WHOLE, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    rec.clear();
    expect(() => globe.draw(WHOLE, 16)).not.toThrow();
    expect(globe.textured).toBe(false);
    expect(rec.count("fill")).toBeGreaterThan(0); // the flat ocean and land are still there
    globe.destroy();
  });
});
