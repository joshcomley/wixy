// Test fixtures for the Adventure Time globe engine: a hand-written TopoJSON (the JSON next to this
// file: two squares sharing a border, a two-part country, an island, a polar "ineligible" land and a
// country with an enclave inside it) and a generator for the specialised worlds a test needs (a cluster
// of twelve small countries, a strip of countries at known distances…). Tests never depend on the
// real map.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorld, type World } from "../../src/server/adventure/world";

export function fixtureJson(): Record<string, unknown> {
  // vitest runs from admin-ui/ (jsdom's `import.meta.url` is not a file URL).
  return JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "adventure-world.fixture.json"), "utf8")) as Record<string, unknown>;
}

export function fixtureWorld(): World {
  return parseWorld(fixtureJson());
}

/** A rectangle `[west, south, east, north]`; rings are wound the way d3 wants (exterior clockwise). */
export type Rect = readonly [number, number, number, number];

export interface UnitSpec {
  readonly id: string;
  readonly name?: string;
  readonly rects: readonly Rect[];
}

function ring([w, s, e, n]: Rect): number[][] {
  return [[w, s], [w, n], [e, n], [e, s], [w, s]];
}

/** A TopoJSON (detail = coarse geometry) with one arc per rectangle and the rectangles' middles as centres. */
export function makeTopology(units: readonly UnitSpec[]): Record<string, unknown> {
  const arcs: number[][][] = [];
  const centres: Record<string, number[][]> = {};
  const geometries = units.map((unit) => {
    const indices = unit.rects.map((rect) => {
      arcs.push(ring(rect));
      return arcs.length - 1;
    });
    centres[unit.id] = unit.rects.map(([w, s, e, n]) => [(w + e) / 2, (s + n) / 2]);
    const base = { id: unit.id, properties: { name: unit.name ?? unit.id } };
    return indices.length === 1
      ? { type: "Polygon", ...base, arcs: [[indices[0]]] }
      : { type: "MultiPolygon", ...base, arcs: indices.map((i) => [[i]]) };
  });
  return {
    type: "Topology",
    arcs,
    objects: {
      detail: { type: "GeometryCollection", geometries },
      coarse: { type: "GeometryCollection", geometries },
    },
    centres,
  };
}

export function makeWorld(units: readonly UnitSpec[]): World {
  return parseWorld(makeTopology(units));
}
