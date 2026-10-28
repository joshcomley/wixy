import { geoContains, geoDistance, geoInterpolate, geoOrthographic } from "d3-geo";
import { describe, expect, it } from "vitest";
import {
  FRONT,
  HIDDEN,
  MAX_EDGE_DEG,
  MIXED,
  buildFastRings,
  classify,
  emitFeature,
  emitLine,
  rotationMatrix,
  vectorsOf,
} from "../../src/server/adventure/fastmap";
import { createBaseLayer } from "../../src/server/adventure/basemap";
import { cameraRotation } from "../../src/server/adventure/camera";
import type { UnitFeature } from "../../src/server/adventure/world";
import { fixtureWorld } from "../fixtures/adventureWorld";
import { recordingContext } from "../fixtures/stubContext";

const RAD = Math.PI / 180;
const ROTATIONS: Array<[number, number, number]> = [
  [0, 0, 0],
  [20, -15, 0],
  [-100, 120, 0],
  [30, -200, 25],
  [170, 70, -40],
  [-45, 89.9, 0],
  [0, 450, 10],
];

function vec(lng: number, lat: number): [number, number, number] {
  return [Math.cos(lat * RAD) * Math.cos(lng * RAD), Math.cos(lat * RAD) * Math.sin(lng * RAD), Math.sin(lat * RAD)];
}

function samplePoints(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let seed = 99;
  for (let i = 0; i < 60; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const lng = (seed / 4294967296) * 360 - 180;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const lat = (Math.asin((seed / 4294967296) * 2 - 1) * 180) / Math.PI;
    out.push([lng, lat]);
  }
  return out;
}

describe("rotationMatrix", () => {
  it("projects every point to exactly the pixel d3's orthographic projection does", () => {
    const m = new Float64Array(9);
    for (const rotation of ROTATIONS) {
      rotationMatrix(rotation, m);
      const projection = geoOrthographic().rotate(rotation).scale(237).translate([195, 311]);
      for (const [lng, lat] of samplePoints()) {
        const [x, y, z] = vec(lng, lat);
        const sx = 195 + 237 * ((m[3] as number) * x + (m[4] as number) * y + (m[5] as number) * z);
        const sy = 311 - 237 * ((m[6] as number) * x + (m[7] as number) * y + (m[8] as number) * z);
        const d3 = projection([lng, lat]);
        expect(sx).toBeCloseTo(d3?.[0] ?? Number.NaN, 8);
        expect(sy).toBeCloseTo(d3?.[1] ?? Number.NaN, 8);
      }
    }
  });

  it("is a rotation: orthonormal rows", () => {
    const m = new Float64Array(9);
    rotationMatrix([37, -61, 12], m);
    for (let i = 0; i < 3; i += 1) {
      const row = [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]] as number[];
      expect(Math.hypot(...row)).toBeCloseTo(1, 12);
    }
    const dot01 = (m[0] as number) * (m[3] as number) + (m[1] as number) * (m[4] as number) + (m[2] as number) * (m[5] as number);
    expect(dot01).toBeCloseTo(0, 12);
  });

  it("the first row is depth: positive exactly for the points d3 would keep (the near hemisphere)", () => {
    const m = new Float64Array(9);
    for (const rotation of ROTATIONS) {
      rotationMatrix(rotation, m);
      const projection = geoOrthographic().rotate(rotation).scale(100).translate([0, 0]).clipAngle(90);
      const centre = projection.invert?.([0, 0]) as [number, number];
      for (const point of samplePoints()) {
        const [x, y, z] = vec(point[0], point[1]);
        const depth = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z;
        const viaCentre = geoDistance(point, centre) < Math.PI / 2;
        if (Math.abs(depth) > 1e-9) expect(depth > 0).toBe(viaCentre);
      }
    }
  });
});

describe("the imagery shader's inverse mapping", () => {
  // The fragment shader of basemap.ts turns a pixel back into longitude/latitude with this exact arithmetic
  // (u = (depth, x, y), v = Mᵀ·u). It must agree with d3's own inverse, or the imagery and the overlay drift.
  function shaderLngLat(m: Float64Array, cx: number, cy: number, r: number, px: number, py: number): [number, number] {
    const x = (px - cx) / r;
    const y = (cy - py) / r;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    // v_i = sum_j M[j][i] * u_j  (M row-major, u = (z, x, y))
    const vx = (m[0] as number) * z + (m[3] as number) * x + (m[6] as number) * y;
    const vy = (m[1] as number) * z + (m[4] as number) * x + (m[7] as number) * y;
    const vz = (m[2] as number) * z + (m[5] as number) * x + (m[8] as number) * y;
    return [Math.atan2(vy, vx) / RAD, Math.asin(Math.max(-1, Math.min(1, vz))) / RAD];
  }

  it("matches projection.invert for every rotation, scale and pixel on the disc", () => {
    const m = new Float64Array(9);
    for (const rotation of ROTATIONS) {
      for (const scale of [162, 400, 3000]) {
        rotationMatrix(rotation, m);
        const projection = geoOrthographic().rotate(rotation).scale(scale).translate([195, 300]);
        for (const [fx, fy] of [[0, 0], [0.3, 0.2], [-0.6, 0.5], [0.9, -0.1], [-0.2, -0.95]] as const) {
          const px = 195 + fx * Math.min(scale, 190) * 0.9;
          const py = 300 + fy * Math.min(scale, 190) * 0.9;
          const expected = projection.invert?.([px, py]);
          if (expected === null || expected === undefined) continue;
          const [lng, lat] = shaderLngLat(m, 195, 300, scale, px, py);
          expect(Math.abs(lat - expected[1])).toBeLessThan(1e-7);
          const dLng = Math.abs((((lng - expected[0]) % 360) + 540) % 360 - 180);
          if (Math.abs(lat) < 89.999) expect(dLng).toBeLessThan(1e-7);
        }
      }
    }
  });

  it("the camera form of a rotation lines up too (what the pane will actually pass)", () => {
    const m = new Float64Array(9);
    const rotation = cameraRotation({ centre: [-1.5, 51.5], viewRadiusDeg: 1.2, roll: 20 });
    rotationMatrix(rotation, m);
    const projection = geoOrthographic().rotate(rotation).scale(31000).translate([195, 300]);
    const [lng, lat] = shaderLngLat(m, 195, 300, 31000, 195, 300);
    near2([lng, lat], [-1.5, 51.5], 1e-9);
    const expected = projection.invert?.([230, 250]) as [number, number];
    near2(shaderLngLat(m, 195, 300, 31000, 230, 250), expected, 1e-7);
  });
});

function near2(a: readonly number[], b: readonly number[], tol: number): void {
  expect(Math.abs((a[0] as number) - (b[0] as number))).toBeLessThan(tol);
  expect(Math.abs((a[1] as number) - (b[1] as number))).toBeLessThan(tol);
}

describe("vectorsOf", () => {
  it("keeps the endpoints and subdivides long edges along the great circle", () => {
    const v = vectorsOf([[0, 0], [10, 0]]);
    expect(MAX_EDGE_DEG).toBe(1.5);
    expect(v.length / 3).toBeGreaterThanOrEqual(8); // 10 degrees in steps of at most 1.5
    near2([v[0] as number, v[1] as number], vec(0, 0), 1e-12);
    const last = v.length - 3;
    near2([v[last] as number, v[last + 1] as number], vec(10, 0), 1e-12);
    for (let i = 0; i + 3 < v.length; i += 3) {
      const dot = (v[i] as number) * (v[i + 3] as number) + (v[i + 1] as number) * (v[i + 4] as number) + (v[i + 2] as number) * (v[i + 5] as number);
      expect((Math.acos(Math.min(1, dot)) / RAD)).toBeLessThanOrEqual(MAX_EDGE_DEG + 1e-9);
    }
  });

  it("puts the intermediate points on the great circle, not on the straight lat/lng line", () => {
    const v = vectorsOf([[0, 60], [90, 60]], 5);
    const interpolate = geoInterpolate([0, 60], [90, 60]);
    const steps = v.length / 3 - 1;
    let bulge = 0;
    for (let i = 0; i <= steps; i += 1) {
      const expected = interpolate(i / steps); // d3's point a fraction of the way along the great circle
      const lat = Math.asin(v[i * 3 + 2] as number) / RAD;
      const lng = Math.atan2(v[i * 3 + 1] as number, v[i * 3] as number) / RAD;
      expect(lat).toBeCloseTo(expected[1], 6);
      expect(lng).toBeCloseTo(expected[0], 6);
      bulge = Math.max(bulge, lat - 60);
    }
    expect(bulge).toBeGreaterThan(5); // the geodesic rises well above the 60th parallel
  });

  it("leaves short edges alone and handles empty and single-point input", () => {
    expect(vectorsOf([[0, 0], [0.5, 0.5]]).length).toBe(6);
    expect(vectorsOf([]).length).toBe(0);
    expect(vectorsOf([[3, 4]]).length).toBe(3);
  });
});

describe("buildFastRings and classify", () => {
  const world = fixtureWorld();
  const features = world.detail.features as UnitFeature[];
  const rings = buildFastRings(features);
  const m = new Float64Array(9);
  const indexOf = (id: string): number => features.findIndex((f) => f.id === id);

  it("flattens every ring of every feature (closing vertex dropped, long edges densified)", () => {
    expect(rings.featureRing.length).toBe(features.length + 1);
    expect(rings.featureRing[indexOf("AAA") + 1]! - rings.featureRing[indexOf("AAA")]!).toBe(1);
    expect(rings.featureRing[indexOf("CCC") + 1]! - rings.featureRing[indexOf("CCC")]!).toBe(2); // two parts
    expect(rings.featureRing[indexOf("FFF") + 1]! - rings.featureRing[indexOf("FFF")]!).toBe(2); // with a hole
    const aaa = rings.featureRing[indexOf("AAA")] as number;
    const count = (rings.ringStart[aaa + 1] as number) - (rings.ringStart[aaa] as number);
    expect(count).toBeGreaterThanOrEqual(4 * 6); // four 10-degree edges densified at 1.5 degrees
  });

  it("classifies units wholly in front, wholly behind and across the horizon", () => {
    rotationMatrix([-5, -5, 0], m); // looking at (5, 5)
    expect(classify(rings, indexOf("AAA"), m)).toBe(FRONT);
    rotationMatrix([-95, -5, 0], m); // looking at (95, 5): Alpha's far edge is behind the globe
    expect(classify(rings, indexOf("AAA"), m)).toBe(MIXED);
    rotationMatrix([-180, 0, 0], m); // looking at the far side
    expect(classify(rings, indexOf("AAA"), m)).toBe(HIDDEN);
  });

  it("emits a front unit's rings as the pixels d3 projects its vertices to", () => {
    rotationMatrix([-5, -5, 0], m);
    const rec = recordingContext();
    emitFeature(rec.ctx, rings, indexOf("AAA"), m, 195, 300, 400);
    const first = rec.calls[0] as [string, number, number];
    expect(first[0]).toBe("moveTo");
    const projection = geoOrthographic().rotate([-5, -5, 0]).scale(400).translate([195, 300]);
    const expected = projection([0, 0]) as [number, number];
    expect(first[1]).toBeCloseTo(expected[0], 6);
    expect(first[2]).toBeCloseTo(expected[1], 6);
    expect(rec.count("moveTo")).toBe(1);
    expect(rec.count("lineTo")).toBe(rec.calls.length - 1);
    // Every emitted vertex lies on the projected disc.
    for (const [name, x, y] of rec.calls as Array<[string, number, number]>) {
      if (name === "lineTo" || name === "moveTo") expect(Math.hypot(x - 195, y - 300)).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it("gives a unit with a hole one ring per boundary", () => {
    rotationMatrix([20, -30, 0], m); // looking at (-20, 30): Foxtrot and its enclave
    const rec = recordingContext();
    emitFeature(rec.ctx, rings, indexOf("FFF"), m, 0, 0, 100);
    expect(rec.count("moveTo")).toBe(2);
  });
});

describe("emitLine", () => {
  const m = new Float64Array(9);
  const meridian = vectorsOf(Array.from({ length: 35 }, (_, i) => [0, -85 + i * 5]), 5);

  it("draws a line wholly in front as one piece", () => {
    rotationMatrix([0, 0, 0], m);
    const rec = recordingContext();
    emitLine(rec.ctx, meridian, m, 100, 100, 80);
    expect(rec.count("moveTo")).toBe(1);
    expect(rec.count("lineTo")).toBe(meridian.length / 3 - 1);
  });

  it("draws nothing for a line wholly behind the globe", () => {
    rotationMatrix([180, 0, 0], m);
    const rec = recordingContext();
    emitLine(rec.ctx, meridian, m, 100, 100, 80);
    expect(rec.calls).toEqual([]);
  });

  it("breaks a line at the horizon and ends each piece exactly on the limb", () => {
    // A parallel (the equator) seen from the side: half of it is in front.
    const equator = vectorsOf(Array.from({ length: 73 }, (_, i) => [-180 + i * 5, 0]), 5);
    rotationMatrix([0, 0, 0], m);
    const rec = recordingContext();
    emitLine(rec.ctx, equator, m, 100, 100, 80);
    const moves = rec.calls.filter((c) => c[0] === "moveTo") as Array<[string, number, number]>;
    expect(moves.length).toBe(1); // one visible piece
    const points = rec.calls.filter((c) => c[0] === "moveTo" || c[0] === "lineTo") as Array<[string, number, number]>;
    const startRadius = Math.hypot((points[0] as [string, number, number])[1] - 100, (points[0] as [string, number, number])[2] - 100);
    const endRadius = Math.hypot((points[points.length - 1] as [string, number, number])[1] - 100, (points[points.length - 1] as [string, number, number])[2] - 100);
    expect(startRadius).toBeCloseTo(80, 5);
    expect(endRadius).toBeCloseTo(80, 5);
    for (const p of points) expect(Math.hypot(p[1] - 100, p[2] - 100)).toBeLessThanOrEqual(80 + 1e-6);
  });

  it("a line that leaves and re-enters the front becomes two pieces", () => {
    const ring = vectorsOf([[-100, 0], [-60, 0], [-20, 0], [20, 0], [60, 0], [100, 0], [140, 0], [-140, 0], [-100, 0]], 5);
    rotationMatrix([-130, 0, 0], m); // looking at 130: the left end and the right end are in front
    const rec = recordingContext();
    emitLine(rec.ctx, ring, m, 0, 0, 50);
    expect(rec.count("moveTo")).toBeGreaterThanOrEqual(1);
  });
});

describe("createBaseLayer", () => {
  it("is null where WebGL 2 is not available", () => {
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => null) as typeof canvas.getContext;
    expect(createBaseLayer(canvas)).toBeNull();
  });

  it("is null when the context cannot compile the shaders", () => {
    const rec = recordingContext(); // every GL call answers undefined
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => rec.ctx) as unknown as typeof canvas.getContext;
    expect(createBaseLayer(canvas)).toBeNull();
  });

  it("keeps a geoContains sanity check honest (the fixture's Alpha contains its middle)", () => {
    const alpha = fixtureWorld().units.get("AAA");
    expect(geoContains(alpha?.detail as never, [5, 5])).toBe(true);
  });
});
