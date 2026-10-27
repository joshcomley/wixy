// Adventure Time — the world map (spec/server-chat/08-adventure-time.md §2.1, §5.2).
//
// `admin-ui/data/adventure-world.json` is ONE TopoJSON with two objects over the same unit ids:
// `detail` (lightly simplified — used for zoomed views and for EVERY geometry decision: landing,
// nearest coast, candidates) and `coarse` (heavily simplified — used only to draw the spinning globe),
// plus a top-level `centres: { [id]: [[lng, lat], …] }` giving the pole of inaccessibility of every
// polygon part of each detail feature in part order (the 30 %-inland step walks toward it).
//
// The file is a static asset, fetched lazily the first time the game needs it: esbuild copies it next
// to the bundle and defines `WIXY_ADVENTURE_WORLD_URL` as its content-hashed URL (the call-worklet
// precedent in esbuild.config.mjs). `parseWorld` is defensive — the file is committed content but a
// stale cached or truncated download must produce a clear error, not a silently half-drawn planet —
// and `loadWorld` shares one in-flight/finished promise, retrying on the next call after a failure.
//
// d3 reads polygons with its own winding convention (an exterior ring runs clockwise on the sphere);
// a ring wound the other way means "everything EXCEPT this country". `parseWorld` checks every
// polygon's spherical area and rewinds the (rare) inverted one, so a mis-wound source file cannot
// invert a country in `geoContains` or in the drawing.

import { geoArea, geoBounds, geoCentroid } from "d3-geo";
import type { Feature, FeatureCollection, MultiLineString, MultiPolygon, Polygon } from "geojson";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, GeometryObject, Topology } from "topojson-specification";
import type { LngLat } from "./camera";

export type UnitGeometry = Polygon | MultiPolygon;
export interface UnitProperties {
  readonly name: string;
}
export type UnitFeature = Feature<UnitGeometry, UnitProperties> & { readonly id: string };
export type UnitCollection = FeatureCollection<UnitGeometry, UnitProperties>;

/** d3's `geoBounds`: `[[west, south], [east, north]]`; `west > east` means it crosses the antimeridian. */
export type Bbox = readonly [LngLat, LngLat];

export interface WorldPart {
  /** The part as a standalone GeoJSON polygon (exterior ring + holes). */
  readonly polygon: Polygon;
  /** Its pole of inaccessibility (the point farthest from its boundary). */
  readonly centre: LngLat;
  readonly bbox: Bbox;
}

export interface WorldUnit {
  readonly id: string;
  readonly name: string;
  readonly detail: UnitFeature;
  /** Absent for a unit too small to survive the coarse simplification. */
  readonly coarse: UnitFeature | null;
  readonly bbox: Bbox;
  readonly parts: readonly WorldPart[];
}

/** The unit boundaries as two line sets, so borders are stroked once rather than once per neighbour. */
export interface WorldMeshes {
  /** Boundaries shared by two units. */
  readonly borders: MultiLineString;
  /** Boundaries with sea (or nothing) on the other side. */
  readonly coast: MultiLineString;
}

export interface World {
  readonly units: ReadonlyMap<string, WorldUnit>;
  readonly coarse: UnitCollection;
  readonly detail: UnitCollection;
  readonly meshes: { readonly coarse: WorldMeshes; readonly detail: WorldMeshes };
}

/** Thrown for a world file that is not what `spec/server-chat/08-adventure-time.md` §2.1 describes. */
export class WorldFormatError extends Error {
  constructor(message: string) {
    super(`Adventure world map: ${message}`);
    this.name = "WorldFormatError";
  }
}

// -- Parsing ---------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLngLat(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180.0001 &&
    Math.abs(value[1]) <= 90.0001
  );
}

function requireCollection(objects: Record<string, unknown>, key: "detail" | "coarse"): GeometryCollection {
  const obj = objects[key];
  if (!isRecord(obj) || obj["type"] !== "GeometryCollection" || !Array.isArray(obj["geometries"])) {
    throw new WorldFormatError(`objects.${key} must be a GeometryCollection`);
  }
  return obj as unknown as GeometryCollection;
}

function geometryId(g: unknown, where: string): string {
  if (!isRecord(g)) throw new WorldFormatError(`${where}: a geometry is not an object`);
  const id = g["id"];
  if (typeof id !== "string" || id === "") throw new WorldFormatError(`${where}: a geometry has no string id`);
  const type = g["type"];
  if (type !== "Polygon" && type !== "MultiPolygon") {
    throw new WorldFormatError(`${where}: unit ${id} must be a Polygon or MultiPolygon (got ${String(type)})`);
  }
  if (!Array.isArray(g["arcs"])) throw new WorldFormatError(`${where}: unit ${id} has no arcs`);
  return id;
}

function unitName(g: Record<string, unknown>, id: string): string {
  const props = g["properties"];
  const name = isRecord(props) ? props["name"] : undefined;
  if (typeof name !== "string" || name === "") throw new WorldFormatError(`unit ${id} has no properties.name`);
  return name;
}

const TWO_PI = 2 * Math.PI;

/** Reverses the rings of any polygon whose spherical area exceeds a hemisphere (d3 winding check). */
function rewound(geometry: UnitGeometry): UnitGeometry {
  if (geometry.type === "Polygon") return polygonInverted(geometry) ? reversePolygon(geometry) : geometry;
  let changed = false;
  const coordinates = geometry.coordinates.map((rings) => {
    const poly: Polygon = { type: "Polygon", coordinates: rings };
    if (!polygonInverted(poly)) return rings;
    changed = true;
    return reversePolygon(poly).coordinates;
  });
  return changed ? { type: "MultiPolygon", coordinates } : geometry;
}

function polygonInverted(polygon: Polygon): boolean {
  return geoArea(polygon) > TWO_PI;
}

function reversePolygon(polygon: Polygon): Polygon {
  return { type: "Polygon", coordinates: polygon.coordinates.map((ring) => ring.slice().reverse()) };
}

function bboxContains(bbox: Bbox, p: LngLat, margin: number): boolean {
  const [[w, s], [e, n]] = bbox;
  if (p[1] < s - margin || p[1] > n + margin) return false;
  const lng = p[0];
  return w <= e ? lng >= w - margin && lng <= e + margin : lng >= w - margin || lng <= e + margin;
}

function toUnitFeature(raw: Feature<UnitGeometry, UnitProperties>, id: string, name: string): UnitFeature {
  return {
    type: "Feature",
    id,
    properties: { name },
    geometry: rewound(raw.geometry),
  } as UnitFeature;
}

function polygonsOf(geometry: UnitGeometry): Polygon[] {
  return geometry.type === "Polygon"
    ? [geometry]
    : geometry.coordinates.map((coordinates): Polygon => ({ type: "Polygon", coordinates }));
}

function decode(topology: Topology, collection: GeometryCollection, label: string): Feature<UnitGeometry, UnitProperties>[] {
  try {
    const decoded = feature(topology, collection as GeometryCollection<UnitProperties>);
    return (decoded as unknown as FeatureCollection<UnitGeometry, UnitProperties>).features;
  } catch (error) {
    throw new WorldFormatError(`could not decode ${label} (${error instanceof Error ? error.message : String(error)})`);
  }
}

// Natural Earth cuts countries that cross the antimeridian (Russia, Fiji) at exactly ±180° and closes
// Antarctica along the pole. Those edges are not borders: stroked, they would draw a line through the
// middle of a country. `withoutCutEdges` removes them from line sets (fills are unaffected).
const CUT_TOLERANCE = 1e-4;

function onCut(a: readonly number[], b: readonly number[]): boolean {
  const meridian = Math.abs(Math.abs(a[0] as number) - 180) < CUT_TOLERANCE && Math.abs(Math.abs(b[0] as number) - 180) < CUT_TOLERANCE;
  const pole = Math.abs(Math.abs(a[1] as number) - 90) < CUT_TOLERANCE && Math.abs(Math.abs(b[1] as number) - 90) < CUT_TOLERANCE;
  return meridian || pole;
}

/** Splits every line wherever it runs along the antimeridian or the pole, dropping those edges. */
export function withoutCutEdges(lines: ReadonlyArray<ReadonlyArray<readonly number[]>>): number[][][] {
  const out: number[][][] = [];
  for (const line of lines) {
    let run: number[][] = [];
    for (let i = 0; i < line.length; i += 1) {
      const p = line[i] as readonly number[];
      const previous = line[i - 1];
      if (previous !== undefined && onCut(previous, p)) {
        if (run.length > 1) out.push(run);
        run = [];
      }
      run.push(p as number[]);
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

function cleanMesh(lines: MultiLineString): MultiLineString {
  return { type: "MultiLineString", coordinates: withoutCutEdges(lines.coordinates) };
}

function meshes(topology: Topology, collection: GeometryCollection): WorldMeshes {
  const object = collection as unknown as GeometryObject;
  return {
    borders: cleanMesh(mesh(topology, object, (a, b) => a !== b)),
    coast: cleanMesh(mesh(topology, object, (a, b) => a === b)),
  };
}

const outlines = new WeakMap<object, MultiLineString>();

/**
 * A unit's boundary as lines (every ring, cut edges removed), cached. Stroking this rather than the
 * polygon avoids the seam d3 draws along the horizon when it closes a clipped polygon.
 */
export function unitOutline(unit: UnitFeature): MultiLineString {
  const hit = outlines.get(unit);
  if (hit !== undefined) return hit;
  const rings: number[][][] = [];
  for (const polygon of polygonsOf(unit.geometry)) for (const ring of polygon.coordinates) rings.push(ring);
  const made: MultiLineString = { type: "MultiLineString", coordinates: withoutCutEdges(rings) };
  outlines.set(unit, made);
  return made;
}

/** Validates and decodes a parsed world file. Throws `WorldFormatError` when it is not one. */
export function parseWorld(json: unknown): World {
  if (!isRecord(json) || json["type"] !== "Topology") throw new WorldFormatError("not a TopoJSON Topology");
  if (!Array.isArray(json["arcs"])) throw new WorldFormatError("topology has no arcs array");
  const objects = json["objects"];
  if (!isRecord(objects)) throw new WorldFormatError("topology has no objects");
  const transform = json["transform"];
  if (transform !== undefined) {
    const ok =
      isRecord(transform) &&
      Array.isArray(transform["scale"]) &&
      Array.isArray(transform["translate"]) &&
      transform["scale"].length === 2 &&
      transform["translate"].length === 2 &&
      transform["scale"].every((v) => typeof v === "number" && v > 0) &&
      transform["translate"].every((v) => typeof v === "number");
    if (!ok) throw new WorldFormatError("topology transform is malformed");
  }
  const centresRaw = json["centres"];
  if (!isRecord(centresRaw)) throw new WorldFormatError("missing top-level centres");

  const detailCollection = requireCollection(objects, "detail");
  const coarseCollection = requireCollection(objects, "coarse");
  const topology = json as unknown as Topology;

  const detailIds = detailCollection.geometries.map((g) => geometryId(g, "detail"));
  const coarseIds = coarseCollection.geometries.map((g) => geometryId(g, "coarse"));
  if (detailIds.length === 0) throw new WorldFormatError("objects.detail has no units");
  if (new Set(detailIds).size !== detailIds.length) throw new WorldFormatError("duplicate unit id in objects.detail");
  if (new Set(coarseIds).size !== coarseIds.length) throw new WorldFormatError("duplicate unit id in objects.coarse");
  const detailIdSet = new Set(detailIds);
  for (const id of coarseIds) {
    if (!detailIdSet.has(id)) throw new WorldFormatError(`coarse unit ${id} has no detail geometry`);
  }

  const detailFeatures = decode(topology, detailCollection, "objects.detail");
  const coarseFeatures = decode(topology, coarseCollection, "objects.coarse");

  const coarseById = new Map<string, UnitFeature>();
  coarseFeatures.forEach((raw, i) => {
    const id = coarseIds[i] as string;
    const g = coarseCollection.geometries[i] as unknown as Record<string, unknown>;
    if (raw.geometry === null) throw new WorldFormatError(`coarse unit ${id} decoded to no geometry`);
    coarseById.set(id, toUnitFeature(raw, id, unitName(g, id)));
  });

  const units = new Map<string, WorldUnit>();
  const detailOut: UnitFeature[] = [];
  detailFeatures.forEach((raw, i) => {
    const id = detailIds[i] as string;
    const g = detailCollection.geometries[i] as unknown as Record<string, unknown>;
    const name = unitName(g, id);
    if (raw.geometry === null) throw new WorldFormatError(`unit ${id} decoded to no geometry`);
    const unitFeature = toUnitFeature(raw, id, name);
    const polygons = polygonsOf(unitFeature.geometry);
    const given = centresRaw[id];
    const givenList = Array.isArray(given) ? (given as unknown[]) : [];
    const parts: WorldPart[] = polygons.map((polygon, partIndex) => {
      const bbox = geoBounds(polygon) as unknown as Bbox;
      const candidate = givenList[partIndex];
      // A stored centre that is not inside its part's box means the part list and the centre list have
      // drifted apart (e.g. tiny parts were left out): trust geometry over the index.
      const centre: LngLat =
        isLngLat(candidate) && bboxContains(bbox, candidate, 0.5)
          ? [candidate[0], candidate[1]]
          : (geoCentroid(polygon) as unknown as LngLat);
      return { polygon, centre, bbox };
    });
    units.set(id, {
      id,
      name,
      detail: unitFeature,
      coarse: coarseById.get(id) ?? null,
      bbox: geoBounds(unitFeature) as unknown as Bbox,
      parts,
    });
    detailOut.push(unitFeature);
  });

  return {
    units,
    detail: { type: "FeatureCollection", features: detailOut },
    coarse: { type: "FeatureCollection", features: [...coarseById.values()] },
    meshes: { detail: meshes(topology, detailCollection), coarse: meshes(topology, coarseCollection) },
  };
}

// -- Loading ---------------------------------------------------------------------------------------

declare const WIXY_ADVENTURE_WORLD_URL: string;

/** Where the world file is served (a content-hashed URL in the production bundle). */
export function worldUrl(): string {
  return typeof WIXY_ADVENTURE_WORLD_URL === "string"
    ? WIXY_ADVENTURE_WORLD_URL
    : "/admin/static/admin/adventure-world.json";
}

export interface LoadWorldOptions {
  /** Override `fetch` (tests, the dev harness). */
  readonly fetch?: typeof fetch;
  /** Override the URL (the dev harness). */
  readonly url?: string;
}

let cached: Promise<World> | null = null;

/**
 * Fetches and parses the world file once; every caller shares the same promise. A failure is not
 * remembered: the next call tries again.
 */
export function loadWorld(options: LoadWorldOptions = {}): Promise<World> {
  if (cached !== null) return cached;
  const doFetch = options.fetch ?? fetch;
  const url = options.url ?? worldUrl();
  const attempt: Promise<World> = (async () => {
    const response = await doFetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Adventure world map: HTTP ${response.status}`);
    return parseWorld(await response.json());
  })();
  cached = attempt;
  attempt.catch(() => {
    if (cached === attempt) cached = null;
  });
  return attempt;
}

/** Forgets the cached world (tests). */
export function resetWorldCache(): void {
  cached = null;
}
