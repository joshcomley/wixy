import { geoContains, geoDistance, geoInterpolate } from "d3-geo";
import { describe, expect, it } from "vitest";
import type { LngLat } from "../../src/server/adventure/camera";
import {
  CANDIDATE_FAR_KM,
  CANDIDATE_MAX,
  CANDIDATE_MIN,
  CANDIDATE_NEAR_KM,
  EARTH_RADIUS_KM,
  INLAND_FRACTION,
  cameraForUnit,
  computeLanding,
  landingPointFor,
  nearestPointOnUnit,
  prepareLanding,
  unitContaining,
} from "../../src/server/adventure/land";
import { parseWorld, type World } from "../../src/server/adventure/world";
import { fixtureWorld, makeWorld, type Rect } from "../fixtures/adventureWorld";

// -- A slow, obviously-correct reference to check the fast index against ------------------------------

/** Points along every boundary edge of `unitId`, 0.02 degrees apart or finer. */
const sampleCache = new WeakMap<World, Map<string, LngLat[]>>();

function boundarySamples(world: World, unitId: string): LngLat[] {
  let perWorld = sampleCache.get(world);
  if (perWorld === undefined) {
    perWorld = new Map();
    sampleCache.set(world, perWorld);
  }
  const cached = perWorld.get(unitId);
  if (cached !== undefined) return cached;
  const out: LngLat[] = [];
  perWorld.set(unitId, out);
  const unit = world.units.get(unitId);
  for (const part of unit?.parts ?? []) {
    for (const ring of part.polygon.coordinates) {
      for (let i = 0; i + 1 < ring.length; i += 1) {
        const a = ring[i] as [number, number];
        const b = ring[i + 1] as [number, number];
        const steps = Math.max(1, Math.ceil(((geoDistance(a, b) * 180) / Math.PI) / 0.02));
        const interpolate = geoInterpolate(a, b);
        for (let s = 0; s <= steps; s += 1) out.push(interpolate(s / steps));
      }
    }
  }
  return out;
}

function refDistanceKm(world: World, unitId: string, p: LngLat): { km: number; at: LngLat } {
  const unit = world.units.get(unitId);
  if (unit !== undefined && geoContains(unit.detail, p as [number, number])) return { km: 0, at: p };
  let best = Number.POSITIVE_INFINITY;
  let at: LngLat = p;
  for (const s of boundarySamples(world, unitId)) {
    const d = geoDistance(p as [number, number], s as [number, number]) * EARTH_RADIUS_KM;
    if (d < best) {
      best = d;
      at = s;
    }
  }
  return { km: best, at };
}

function kmBetween(a: LngLat, b: LngLat): number {
  return geoDistance(a as [number, number], b as [number, number]) * EARTH_RADIUS_KM;
}

/** The spec's candidate rules applied to reference distances. */
function refCandidates(world: World, eligible: ReadonlySet<string>, landUnit: string, centre: LngLat): string[] {
  const others = [...eligible]
    .filter((id) => id !== landUnit && world.units.has(id))
    .map((id) => ({ id, km: refDistanceKm(world, id, centre).km }))
    .filter((o) => o.km <= CANDIDATE_FAR_KM)
    .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1));
  const picked = [landUnit];
  for (const o of others) {
    if (picked.length >= CANDIDATE_MAX) break;
    if (o.km <= CANDIDATE_NEAR_KM || picked.length < CANDIDATE_MIN) picked.push(o.id);
    else break;
  }
  return picked;
}

const ALL = new Set(["AAA", "BBB", "CCC", "DDD", "FFF", "GGG"]); // EEE (the polar land) is not eligible

function near(a: LngLat, b: LngLat, tolerance: number): void {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(tolerance);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(tolerance);
}

describe("constants from the spec", () => {
  it("match §3.2", () => {
    expect(INLAND_FRACTION).toBe(0.3);
    expect(CANDIDATE_NEAR_KM).toBe(500);
    expect(CANDIDATE_MIN).toBe(4);
    expect(CANDIDATE_FAR_KM).toBe(2500);
    expect(CANDIDATE_MAX).toBe(10);
  });
});

describe("landingPointFor", () => {
  it("is the globe's centre for any rotation, including tumbles past the poles", () => {
    near(landingPointFor([20, -15]), [-20, 15], 1e-9);
    near(landingPointFor([20, 120]), [160, -60], 1e-9);
    near(landingPointFor([20, -200]), [160, -20], 1e-9);
    expect(landingPointFor([20, 450])[1]).toBeCloseTo(-90, 9);
  });
});

describe("computeLanding on the fixture world", () => {
  const world = fixtureWorld();

  it("a point inside an eligible unit is not sea: land, point and centre are the point", () => {
    const landing = computeLanding(world, ALL, [5, 5]);
    expect(landing).not.toBeNull();
    expect(landing?.sea).toBe(false);
    expect(landing?.landUnit).toBe("AAA");
    expect(landing?.point).toEqual([5, 5]);
    expect(landing?.land).toEqual([5, 5]);
    expect(landing?.centre).toEqual([5, 5]);
    expect(landing?.candidates[0]).toBe("AAA");
  });

  it("a point in the sea goes to the nearest coast of the nearest eligible unit", () => {
    const landing = computeLanding(world, ALL, [23, 5]);
    expect(landing?.sea).toBe(true);
    expect(landing?.landUnit).toBe("BBB");
    near(landing?.land ?? [0, 0], [20, 5.0137], 0.02); // the foot of the perpendicular on the 20th meridian
    expect(landing?.point).toEqual([23, 5]);
  });

  it("the inland centre is 30 percent of the way from the coast to the part's middle", () => {
    const landing = computeLanding(world, ALL, [23, 5]);
    const expected = geoInterpolate((landing?.land ?? [0, 0]) as [number, number], [15, 5])(0.3);
    near(landing?.centre ?? [0, 0], expected, 1e-3);
    near(landing?.centre ?? [0, 0], [18.5, 5], 0.05);
  });

  it("uses the middle of the part the coast belongs to, not of the whole unit", () => {
    // East of Gamma's second part: its own middle is 42.5, the first part's is 32.5.
    const landing = computeLanding(world, ALL, [47, 2.5]);
    expect(landing?.landUnit).toBe("CCC");
    near(landing?.land ?? [0, 0], [45, 2.5], 0.02);
    near(landing?.centre ?? [0, 0], [44.25, 2.5], 0.02);
  });

  it("land that is not eligible counts as sea: the nearest ELIGIBLE coast is used", () => {
    // (-45, -75) is inside Epsilon, which is not in the bank. The nearest eligible land is Alpha's corner.
    const landing = computeLanding(world, ALL, [-45, -75]);
    expect(landing?.sea).toBe(true);
    expect(landing?.landUnit).toBe("AAA");
    near(landing?.land ?? [0, 0], [0, 0], 0.01);
  });

  it("an enclave that is not eligible is sea; the coast is the surrounding unit's inner border", () => {
    const landing = computeLanding(world, new Set(["FFF", "AAA"]), [-20, 30]); // Golf sits inside Foxtrot
    expect(landing?.sea).toBe(true);
    expect(landing?.landUnit).toBe("FFF");
    expect(Math.abs((landing?.land[1] ?? 0) - 27)).toBeLessThan(0.4); // the hole's southern edge
    expect(Math.abs((landing?.land[0] ?? 0) + 20)).toBeLessThan(0.4);
  });

  it("an eligible enclave contains the point", () => {
    const landing = computeLanding(world, ALL, [-20, 30]);
    expect(landing?.sea).toBe(false);
    expect(landing?.landUnit).toBe("GGG");
  });

  it("starts the candidates with the landing unit, then by distance, never beyond what the rules allow", () => {
    const landing = computeLanding(world, ALL, [5, 5]);
    const expected = refCandidates(world, ALL, "AAA", [5, 5]);
    expect(landing?.candidates).toEqual(expected);
  });

  it("rounds every coordinate to four decimal places", () => {
    const landing = computeLanding(world, ALL, [23.123456789, 5.987654321]);
    for (const point of [landing?.point, landing?.land, landing?.centre]) {
      for (const v of point ?? []) expect(Math.round(v * 1e4) / 1e4).toBe(v);
    }
  });

  it("is deterministic: same answer on repeat, whatever order the eligible set was built in", () => {
    const a = computeLanding(world, new Set(["AAA", "BBB", "CCC", "DDD", "FFF", "GGG"]), [23, 5]);
    const b = computeLanding(world, new Set(["GGG", "FFF", "DDD", "CCC", "BBB", "AAA"]), [23, 5]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(computeLanding(world, ALL, [23, 5]))).toBe(JSON.stringify(a));
  });

  it("returns null when nothing eligible exists in the world, and ignores unknown ids", () => {
    expect(computeLanding(world, new Set(), [5, 5])).toBeNull();
    expect(computeLanding(world, new Set(["NOPE"]), [5, 5])).toBeNull();
    const landing = computeLanding(world, new Set(["NOPE", "AAA"]), [50, 50]);
    expect(landing?.landUnit).toBe("AAA");
  });

  it("wraps longitudes outside [-180, 180) and clamps latitudes", () => {
    const landing = computeLanding(world, ALL, [365, 5]); // = 5 degrees east
    expect(landing?.landUnit).toBe("AAA");
    expect(landing?.sea).toBe(false);
    expect(computeLanding(world, ALL, [10, 95])).not.toBeNull();
  });

  it("agrees with the slow reference on many random points", () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let compared = 0;
    for (let i = 0; i < 120; i += 1) {
      const p: LngLat = [-60 + rand() * 180, -60 + rand() * 110];
      const landing = computeLanding(world, ALL, p);
      expect(landing).not.toBeNull();
      if (landing === null) continue;
      // Nearest land: the distance to the returned point equals the reference minimum.
      const inside = [...ALL].some((id) => geoContains((world.units.get(id) as unknown as { detail: never }).detail, p as [number, number]));
      expect(landing.sea).toBe(!inside);
      if (!inside) {
        const reference = Math.min(...[...ALL].map((id) => refDistanceKm(world, id, p).km));
        expect(Math.abs(kmBetween(p, landing.land) - reference)).toBeLessThan(2.5);
      }
      // Candidates: skip points sitting on a threshold where a rounding-level difference could flip a unit.
      const distances = [...ALL].filter((id) => id !== landing.landUnit).map((id) => refDistanceKm(world, id, landing.centre).km);
      if (distances.some((d) => Math.abs(d - CANDIDATE_NEAR_KM) < 4 || Math.abs(d - CANDIDATE_FAR_KM) < 4)) continue;
      expect(landing.candidates).toEqual(refCandidates(world, ALL, landing.landUnit, landing.centre));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(80);
  }, 60_000);
});

describe("candidate rules (spec §3.2 step 4)", () => {
  const sq = (id: string, ...rects: Rect[]): { id: string; rects: Rect[] } => ({ id, rects });

  it("caps the list at ten, the landing unit first, the rest nearest first", () => {
    const rects: Rect[] = [];
    for (const x of [-3, -1.5, 0, 1.5]) for (const y of [-2.5, -1, 0.5]) rects.push([x, y, x + 1, y + 1]);
    const world = makeWorld(rects.map((r, i) => sq(`C${String(i).padStart(2, "0")}`, r)));
    const eligible = new Set(world.units.keys());
    const landing = computeLanding(world, eligible, [0.5, 1.0]);
    expect(landing?.candidates.length).toBe(10);
    expect(landing?.candidates[0]).toBe(landing?.landUnit);
    expect(new Set(landing?.candidates).size).toBe(10);
    expect(landing?.candidates).toEqual(refCandidates(world, eligible, landing?.landUnit ?? "", landing?.centre ?? [0, 0]));
  });

  it("keeps everything within 500 km, however many, up to the cap", () => {
    const world = makeWorld([
      sq("AAA", [0, 0, 1, 1]),
      sq("N1", [0, 2, 1, 3]),
      sq("N2", [2, 0, 3, 1]),
      sq("N3", [0, -2, 1, -1]),
      sq("N4", [-2, 0, -1, 1]),
      sq("N5", [2, 2, 3, 3]),
      sq("FAR", [10, 0, 11, 1]),
    ]);
    const landing = computeLanding(world, new Set(world.units.keys()), [0.5, 0.5]);
    expect(landing?.candidates[0]).toBe("AAA");
    expect([...(landing?.candidates ?? [])].sort()).toEqual(["AAA", "N1", "N2", "N3", "N4", "N5"]);
  });

  it("tops up to four with the nearest others, none beyond 2500 km", () => {
    const world = makeWorld([
      sq("AAA", [0, 0, 1, 1]),
      sq("BBB", [8, 0, 9, 1]),
      sq("CCC", [11, 0, 12, 1]),
      sq("DDD", [14, 0, 15, 1]),
      sq("EEE", [30, 0, 31, 1]),
    ]);
    const landing = computeLanding(world, new Set(world.units.keys()), [0.5, 0.5]);
    expect(landing?.candidates).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });

  it("stops at 2500 km even when that leaves fewer than four", () => {
    const world = makeWorld([sq("AAA", [0, 0, 1, 1]), sq("BBB", [15, 0, 16, 1]), sq("CCC", [30, 0, 31, 1])]);
    const landing = computeLanding(world, new Set(world.units.keys()), [0.5, 0.5]);
    expect(landing?.candidates).toEqual(["AAA", "BBB"]);
  });

  it("a lone unit is its own only candidate", () => {
    const world = makeWorld([sq("AAA", [0, 0, 1, 1]), sq("ZZZ", [100, 40, 101, 41])]);
    expect(computeLanding(world, new Set(["AAA"]), [0.5, 0.5])?.candidates).toEqual(["AAA"]);
  });

  it("breaks exact distance ties by unit id", () => {
    const world = makeWorld([sq("MID", [0, 0, 1, 1]), sq("ZED", [5, 0, 6, 1]), sq("ABE", [-5, 0, -4, 1])]);
    // The point sits halfway between ZED's and ABE's nearest edges.
    const landing = computeLanding(world, new Set(world.units.keys()), [0.5, 0.5]);
    const ids = landing?.candidates ?? [];
    expect(ids[0]).toBe("MID");
    const tie = ids.slice(1);
    expect(tie.length).toBe(2);
    const dz = refDistanceKm(world, "ZED", [0.5, 0.5]).km;
    const da = refDistanceKm(world, "ABE", [0.5, 0.5]).km;
    if (Math.abs(dz - da) < 1e-6) expect(tie).toEqual(["ABE", "ZED"]);
    else expect(tie[0]).toBe(dz < da ? "ZED" : "ABE");
  });

  it("puts the landing unit first even when another unit is nearer the centre (sea landing)", () => {
    const world = makeWorld([sq("STR", [0, 0, 20, 1]), sq("NOR", [0, 1.3, 20, 10])]);
    const landing = computeLanding(world, new Set(world.units.keys()), [10, -4]);
    expect(landing?.sea).toBe(true);
    expect(landing?.landUnit).toBe("STR");
    expect(landing?.candidates[0]).toBe("STR");
    expect(landing?.candidates).toContain("NOR");
  });
});

describe("the antimeridian and the poles", () => {
  // One unit whose ring crosses the 180th meridian: lng 170..-170, lat 0..10 (clockwise).
  const crossing = parseWorld({
    type: "Topology",
    arcs: [[[170, 0], [170, 10], [-170, 10], [-170, 0], [170, 0]]],
    objects: {
      detail: { type: "GeometryCollection", geometries: [{ type: "Polygon", id: "AMX", properties: { name: "Across" }, arcs: [[0]] }] },
      coarse: { type: "GeometryCollection", geometries: [{ type: "Polygon", id: "AMX", properties: { name: "Across" }, arcs: [[0]] }] },
    },
    centres: { AMX: [[180, 5]] },
  });
  const set = new Set(["AMX"]);

  it("contains points on both sides of the 180th meridian", () => {
    expect(unitContaining(crossing, [179, 5])).toBe("AMX");
    expect(unitContaining(crossing, [-179, 5])).toBe("AMX");
    expect(unitContaining(crossing, [160, 5])).toBeNull();
  });

  it("finds the nearest coast across the antimeridian", () => {
    const west = computeLanding(crossing, set, [160, 5]);
    expect(west?.sea).toBe(true);
    near(west?.land ?? [0, 0], [170, 5.0], 0.2);
    const east = computeLanding(crossing, set, [-160, 5]);
    near(east?.land ?? [0, 0], [-170, 5.0], 0.2);
    // The inland centre moves toward the middle (180, 5), through the meridian.
    expect(Math.abs(Math.abs(west?.centre[0] ?? 0) - 175)).toBeLessThan(3);
  });

  it("copes with a landing right at a pole", () => {
    const world = fixtureWorld();
    const landing = computeLanding(world, ALL, [0, 90]);
    expect(landing).not.toBeNull();
    expect(landing?.sea).toBe(true);
    expect(landing?.candidates.length).toBeGreaterThanOrEqual(1);
  });
});

describe("helpers", () => {
  const world = fixtureWorld();

  it("unitContaining honours an eligible set", () => {
    expect(unitContaining(world, [5, 5])).toBe("AAA");
    expect(unitContaining(world, [5, 5], new Set(["BBB"]))).toBeNull();
    expect(unitContaining(world, [-45, -75])).toBe("EEE");
    expect(unitContaining(world, [50, 50])).toBeNull();
  });

  it("nearestPointOnUnit is 0 km inside and the distance to the edge outside", () => {
    expect(nearestPointOnUnit(world, "AAA", [5, 5])).toEqual({ point: [5, 5], km: 0 });
    const outside = nearestPointOnUnit(world, "BBB", [23, 0]);
    expect(outside?.km).toBeCloseTo(3 * 111.19, 0);
    near(outside?.point ?? [0, 0], [20, 0], 0.01);
    expect(nearestPointOnUnit(world, "NOPE", [0, 0])).toBeNull();
  });

  it("cameraForUnit frames the largest part of a unit", () => {
    const camera = cameraForUnit(world, "FFF", 1.5, 40);
    expect(camera?.centre).toEqual([-20, 36.5]);
    expect(camera?.viewRadiusDeg).toBeGreaterThan(10); // a 20-degree-wide unit
    // The 2-degree island: its corner is 1.414 degrees from the middle, x 1.25 = 1.77 (above the 1.5 minimum).
    expect(cameraForUnit(world, "DDD", 1.5, 40)?.viewRadiusDeg).toBeCloseTo(1.768, 2);
    expect(cameraForUnit(world, "DDD", 3, 40)?.viewRadiusDeg).toBe(3); // a larger minimum wins
    expect(cameraForUnit(world, "NOPE")).toBeNull();
  });

  it("prepareLanding is idempotent", () => {
    prepareLanding(world);
    prepareLanding(world);
    expect(computeLanding(world, ALL, [5, 5])?.landUnit).toBe("AAA");
  });
});
