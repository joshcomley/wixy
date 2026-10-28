import { geoArea, geoContains } from "d3-geo";
import { quantize } from "topojson-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorldFormatError,
  loadWorld,
  parseWorld,
  resetWorldCache,
  unitOutline,
  withoutCutEdges,
  worldUrl,
} from "../../src/server/adventure/world";
import { fixtureJson, fixtureWorld, makeTopology, makeWorld } from "../fixtures/adventureWorld";

afterEach(() => {
  resetWorldCache();
});

describe("parseWorld", () => {
  it("decodes the units with names, ids, parts and both geometry levels", () => {
    const world = fixtureWorld();
    expect([...world.units.keys()]).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"]);
    const gamma = world.units.get("CCC");
    expect(gamma?.name).toBe("Gamma");
    expect(gamma?.detail.id).toBe("CCC");
    expect(gamma?.detail.geometry.type).toBe("MultiPolygon");
    expect(gamma?.parts.length).toBe(2);
    expect(gamma?.parts.map((p) => p.centre)).toEqual([
      [32.5, 2.5],
      [42.5, 2.5],
    ]);
    expect(world.detail.features.length).toBe(7);
    expect(world.coarse.features.length).toBe(6);
  });

  it("gives a unit too small for the coarse level no coarse shape", () => {
    const world = fixtureWorld();
    expect(world.units.get("DDD")?.coarse).toBeNull();
    expect(world.units.get("AAA")?.coarse).not.toBeNull();
  });

  it("computes bounding boxes with d3's geoBounds", () => {
    const world = fixtureWorld();
    const [[w, s], [e, n]] = (world.units.get("BBB") as { bbox: readonly [readonly [number, number], readonly [number, number]] }).bbox;
    expect(w).toBeCloseTo(10, 6);
    expect(e).toBeCloseTo(20, 6);
    expect(s).toBeCloseTo(0, 6);
    expect(n).toBeGreaterThanOrEqual(10); // the great-circle top edge bulges a little north
    expect(n).toBeLessThan(10.5);
    const gamma = (world.units.get("CCC") as { parts: ReadonlyArray<{ bbox: readonly [readonly [number, number], readonly [number, number]] }> }).parts;
    expect(gamma[1]?.bbox[0][0]).toBeCloseTo(40, 6);
  });

  it("builds borders (shared edges) and coast (the rest) meshes", () => {
    const world = fixtureWorld();
    const border = world.meshes.detail.borders.coordinates;
    // Two shared boundaries: Alpha/Beta, and Foxtrot's enclave (Golf).
    expect(border.length).toBe(2);
    const ab = border.find((line) => line.some((p) => p[0] === 10 && p[1] === 10));
    expect(ab?.map((p) => `${p[0]},${p[1]}`)).toEqual(expect.arrayContaining(["10,10", "10,0"]));
    expect(border.some((line) => line.some((p) => p[0] === -24 && p[1] === 27))).toBe(true);
    const coastPoints = world.meshes.detail.coast.coordinates.flat().map((p) => `${p[0]},${p[1]}`);
    expect(coastPoints).toContain("0,0");
    expect(coastPoints).toContain("20,10");
  });

  it("decodes a quantized topology the same way", () => {
    const quantized = quantize(fixtureJson() as never, 1e5) as unknown as Record<string, unknown>;
    expect(quantized["transform"]).toBeDefined();
    // quantize() keeps the extra top-level key, so the world file shape is preserved.
    quantized["centres"] = (fixtureJson() as Record<string, unknown>)["centres"];
    const a = fixtureWorld();
    const b = parseWorld(quantized);
    for (const id of a.units.keys()) {
      const ua = a.units.get(id);
      const ub = b.units.get(id);
      expect(ub?.parts.length).toBe(ua?.parts.length);
      expect(ub?.bbox[0][0]).toBeCloseTo(ua?.bbox[0][0] ?? Number.NaN, 2);
      expect(ub?.bbox[1][1]).toBeCloseTo(ua?.bbox[1][1] ?? Number.NaN, 2);
    }
  });

  it("rewinds a polygon wound the wrong way so it means the country, not everything but it", () => {
    // Exterior counter-clockwise: d3 would read it as the whole sphere minus the square.
    const json = {
      type: "Topology",
      arcs: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      objects: {
        detail: { type: "GeometryCollection", geometries: [{ type: "Polygon", id: "WWW", properties: { name: "Wrong" }, arcs: [[0]] }] },
        coarse: { type: "GeometryCollection", geometries: [{ type: "Polygon", id: "WWW", properties: { name: "Wrong" }, arcs: [[0]] }] },
      },
      centres: { WWW: [[5, 5]] },
    };
    const world = parseWorld(json);
    const unit = world.units.get("WWW");
    expect(geoArea(unit?.detail as never)).toBeLessThan(0.1);
    expect(geoContains(unit?.detail as never, [5, 5])).toBe(true);
    expect(geoContains(unit?.detail as never, [100, 40])).toBe(false);
  });

  it("falls back to the part's centroid when a stored centre is not inside its part", () => {
    const json = makeTopology([{ id: "AAA", rects: [[0, 0, 10, 10], [30, 0, 40, 10]] }]);
    (json["centres"] as Record<string, number[][]>)["AAA"] = [[35, 5], [35, 5]]; // part 0's centre is in part 1
    const world = parseWorld(json);
    const parts = world.units.get("AAA")?.parts ?? [];
    expect(parts[0]?.centre[0]).toBeCloseTo(5, 0);
    expect(parts[1]?.centre).toEqual([35, 5]);
  });

  it("uses a centroid for a unit with no centres entry at all", () => {
    const json = makeTopology([{ id: "AAA", rects: [[0, 0, 10, 10]] }]);
    json["centres"] = {};
    const part = parseWorld(json).units.get("AAA")?.parts[0];
    expect(part?.centre[0]).toBeCloseTo(5, 0);
    expect(part?.centre[1]).toBeCloseTo(5, 0);
  });

  describe("rejects a malformed file with a clear error", () => {
    const cases: Array<[string, (j: Record<string, unknown>) => unknown, RegExp]> = [
      ["null", () => null, /not a TopoJSON Topology/],
      ["a number", () => 42, /not a TopoJSON Topology/],
      ["a different type", (j) => ({ ...j, type: "FeatureCollection" }), /not a TopoJSON Topology/],
      ["no arcs", (j) => ({ ...j, arcs: undefined }), /no arcs array/],
      ["no objects", (j) => ({ ...j, objects: undefined }), /no objects/],
      ["no detail object", (j) => ({ ...j, objects: { coarse: (j["objects"] as Record<string, unknown>)["coarse"] } }), /objects\.detail must be a GeometryCollection/],
      ["no coarse object", (j) => ({ ...j, objects: { detail: (j["objects"] as Record<string, unknown>)["detail"] } }), /objects\.coarse must be a GeometryCollection/],
      ["no centres", (j) => ({ ...j, centres: undefined }), /missing top-level centres/],
      ["a bad transform", (j) => ({ ...j, transform: { scale: [0, 1], translate: [0, 0] } }), /transform is malformed/],
      ["a bad transform shape", (j) => ({ ...j, transform: "x" }), /transform is malformed/],
    ];
    for (const [label, mutate, message] of cases) {
      it(label, () => {
        const broken = mutate(JSON.parse(JSON.stringify(fixtureJson())) as Record<string, unknown>);
        expect(() => parseWorld(broken)).toThrow(WorldFormatError);
        expect(() => parseWorld(broken)).toThrow(message);
      });
    }

    function withDetail(edit: (geometries: Array<Record<string, unknown>>) => void): unknown {
      const json = JSON.parse(JSON.stringify(fixtureJson())) as { objects: { detail: { geometries: Array<Record<string, unknown>> } } };
      edit(json.objects.detail.geometries);
      return json;
    }

    it("a unit without an id", () => {
      expect(() => parseWorld(withDetail((g) => delete (g[0] as Record<string, unknown>)["id"]))).toThrow(/no string id/);
    });
    it("a unit that is not a polygon", () => {
      expect(() => parseWorld(withDetail((g) => ((g[0] as Record<string, unknown>)["type"] = "Point")))).toThrow(/must be a Polygon or MultiPolygon/);
    });
    it("a unit without a name", () => {
      expect(() => parseWorld(withDetail((g) => ((g[0] as Record<string, unknown>)["properties"] = {})))).toThrow(/no properties\.name/);
    });
    it("a duplicate unit id", () => {
      expect(() => parseWorld(withDetail((g) => ((g[1] as Record<string, unknown>)["id"] = "AAA")))).toThrow(/duplicate unit id/);
    });
    it("a coarse unit the detail level does not have", () => {
      const json = JSON.parse(JSON.stringify(fixtureJson())) as { objects: { coarse: { geometries: Array<Record<string, unknown>> } } };
      (json.objects.coarse.geometries[0] as Record<string, unknown>)["id"] = "ZZZ";
      expect(() => parseWorld(json)).toThrow(/coarse unit ZZZ has no detail geometry/);
    });
    it("an arc index that does not exist", () => {
      expect(() => parseWorld(withDetail((g) => ((g[0] as Record<string, unknown>)["arcs"] = [[99]])))).toThrow(WorldFormatError);
    });
    it("an empty detail object", () => {
      const json = JSON.parse(JSON.stringify(fixtureJson())) as { objects: { detail: { geometries: unknown[] } } };
      json.objects.detail.geometries = [];
      expect(() => parseWorld(json)).toThrow(/no units/);
    });
  });
});

describe("withoutCutEdges", () => {
  it("drops edges along the antimeridian and the pole and splits the line there", () => {
    const line = [[170, 0], [180, 0], [180, 10], [-180, 20], [-170, 20], [-170, 30]];
    const parts = withoutCutEdges([line]);
    expect(parts).toEqual([
      [[170, 0], [180, 0]],
      [[-180, 20], [-170, 20], [-170, 30]],
    ]);
    expect(withoutCutEdges([[[0, 90], [90, 90], [180, 90]]])).toEqual([]);
  });

  it("keeps ordinary lines whole", () => {
    expect(withoutCutEdges([[[0, 0], [1, 1], [2, 0]]])).toEqual([[[0, 0], [1, 1], [2, 0]]]);
  });
});

describe("unitOutline", () => {
  it("is a MultiLineString of every ring, cached per unit", () => {
    const world = fixtureWorld();
    const foxtrot = (world.units.get("FFF") as { detail: Parameters<typeof unitOutline>[0] }).detail;
    const outline = unitOutline(foxtrot);
    expect(outline.type).toBe("MultiLineString");
    expect(outline.coordinates.length).toBe(2); // exterior + the enclave's hole
    expect(unitOutline(foxtrot)).toBe(outline);
  });
});

describe("loadWorld", () => {
  const okResponse = (): Response => ({ ok: true, status: 200, json: async () => fixtureJson() }) as unknown as Response;

  it("fetches and parses once, and every caller shares the promise", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      return okResponse();
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([loadWorld({ fetch: fetchStub }), loadWorld({ fetch: fetchStub })]);
    expect(a).toBe(b);
    expect(await loadWorld({ fetch: fetchStub })).toBe(a);
    expect(calls).toBe(1);
  });

  it("does not remember a failure: the next call tries again", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return okResponse();
    }) as unknown as typeof fetch;
    await expect(loadWorld({ fetch: flaky })).rejects.toThrow("offline");
    const world = await loadWorld({ fetch: flaky });
    expect(world.units.size).toBe(7);
    expect(calls).toBe(2);
  });

  it("rejects an HTTP error and a malformed body", async () => {
    const notFound = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    await expect(loadWorld({ fetch: notFound })).rejects.toThrow("HTTP 404");
    const garbage = (async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }) as unknown as Response) as typeof fetch;
    await expect(loadWorld({ fetch: garbage })).rejects.toThrow(WorldFormatError);
  });

  it("requests the configured URL with same-origin credentials", async () => {
    let seen: { url: unknown; init: unknown } | null = null;
    const spy = (async (url: unknown, init: unknown) => {
      seen = { url, init };
      return okResponse();
    }) as unknown as typeof fetch;
    await loadWorld({ fetch: spy, url: "/x/world.json?v=abc" });
    expect(seen).toEqual({ url: "/x/world.json?v=abc", init: { credentials: "same-origin" } });
    expect(worldUrl()).toBe("/admin/static/admin/adventure-world.json");
  });
});

describe("makeWorld fixtures", () => {
  it("builds a world from rectangles", () => {
    const world = makeWorld([{ id: "ONE", rects: [[0, 0, 1, 1]] }, { id: "TWO", name: "Two", rects: [[5, 5, 6, 6], [8, 8, 9, 9]] }]);
    expect(world.units.get("TWO")?.parts.length).toBe(2);
    expect(world.units.get("TWO")?.name).toBe("Two");
  });
});
