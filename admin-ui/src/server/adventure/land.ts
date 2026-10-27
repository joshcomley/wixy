// Adventure Time — where the globe lands (spec/server-chat/08-adventure-time.md §3.2).
//
// After the second spin the point under the pin is `P`. This module turns it into the whole landing the
// game stores and replays: is it on (eligible) land? if it is sea, the nearest point of eligible land
// `L`; the spot `C` 30 % of the way inland from `L` toward the middle of the land it touched; and the
// countries near `C` that the country roulette will flicker through. One implementation, run by the
// screen that made the move; every other screen replays the stored result, so determinism matters more
// than anything else here (no randomness, ties broken by unit id, coordinates rounded to 4 places).
//
// Everything is decided on the `detail` geometry, on the unit sphere with great-circle edges (the same
// model d3 uses for `geoContains`).
//
// SPEED. "Nearest point on any eligible boundary" is the expensive part: the whole map has tens of
// thousands of edges. The first time a world is used `prepareLanding` builds a flat index: every ring
// split into small runs of edges ("chunks"), each wrapped in a spherical cap (centre + radius). A cap
// of radius < 90° is geodesically convex, so every edge of its chunk lies inside it and the distance
// from `P` to the cap's edge is a true lower bound on the distance to any edge in the chunk. Units are
// scanned nearest-cap first and a chunk is opened only if its lower bound beats the best edge so far,
// so a query touches a few chunks rather than the planet. Distances are compared as `m = 1 − cos(angle)`
// (chord²/2): monotonic, no trigonometry in the inner loop, accurate for tiny distances.

import { geoArea, geoContains } from "d3-geo";
import {
  centreOfRotation,
  fitCamera,
  greatCircleAt,
  normalizeLng,
  type Camera,
  type LngLat,
  type Rotation,
} from "./camera";
import type { World, WorldUnit } from "./world";

/** Kilometres per radian of great circle (mean Earth radius). */
export const EARTH_RADIUS_KM = 6371;
/** How far inland, from the coast toward the land's middle, the roulette centre sits. */
export const INLAND_FRACTION = 0.3;
/** Candidates: everything within this distance of the centre… */
export const CANDIDATE_NEAR_KM = 500;
/** …topped up to `CANDIDATE_MIN` with the nearest others, none farther than this… */
export const CANDIDATE_MIN = 4;
export const CANDIDATE_FAR_KM = 2500;
/** …and never more than this many. */
export const CANDIDATE_MAX = 10;

/** What the second spin's POST carries (spec §3.2); coordinates rounded to 4 decimal places. */
export interface Landing {
  /** `P`: the point under the pin when the globe stopped. */
  readonly point: LngLat;
  /** True when `P` was not on eligible land. */
  readonly sea: boolean;
  /** `L`: `P` itself on land, else the nearest point of eligible land. */
  readonly land: LngLat;
  /** `C`: where the camera zooms to and the roulette is measured from. */
  readonly centre: LngLat;
  /** The unit `L` is in. */
  readonly landUnit: string;
  /** 1–10 unit ids: the landing unit first, then the rest by distance from `centre`. */
  readonly candidates: readonly string[];
}

/** The point on the sphere under the pin for ANY rotation `[λ, φ]` (φ unbounded: tumbles are fine). */
export function landingPointFor(rotation: Rotation): LngLat {
  return centreOfRotation(rotation);
}

// -- Vector helpers ----------------------------------------------------------------------------------

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function lngLatToVec(p: LngLat, out: Float64Array, at = 0): void {
  const lng = p[0] * RAD;
  const lat = p[1] * RAD;
  const cosLat = Math.cos(lat);
  out[at] = cosLat * Math.cos(lng);
  out[at + 1] = cosLat * Math.sin(lng);
  out[at + 2] = Math.sin(lat);
}

function vecToLngLat(x: number, y: number, z: number): LngLat {
  return [normalizeLng(Math.atan2(y, x) * DEG), Math.atan2(z, Math.hypot(x, y)) * DEG];
}

/** Angle (radians) for an `m = 1 − cos(angle)` value: `2·asin(√(m/2))`, accurate for tiny angles. */
function angleOfM(m: number): number {
  return 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, m) / 2)));
}

function mOfAngle(angle: number): number {
  return 1 - Math.cos(angle);
}

function round4(value: number): number {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
}

function roundPoint(p: LngLat): LngLat {
  return [round4(p[0]), round4(p[1])];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -- The index ---------------------------------------------------------------------------------------

/** Edges per chunk: small enough that a cap hugs its coast, large enough to keep the index small. */
const CHUNK_EDGES = 12;
/** A cap at or beyond this radius is not convex enough to bound its edges; it is never used to prune. */
const MAX_PRUNING_RADIUS = 85 * RAD;

interface LandIndex {
  readonly unitIds: readonly string[];
  readonly unitIndex: ReadonlyMap<string, number>;
  /** Unit vectors, x y z per vertex, every ring of every part of every unit back to back. */
  readonly vertices: Float64Array;
  /** Per chunk: index of its first vertex; number of edges. */
  readonly chunkStart: Int32Array;
  readonly chunkEdges: Int32Array;
  readonly chunkPart: Int32Array;
  /** Per chunk: cap centre x y z, then radius. */
  readonly chunkCap: Float64Array;
  /** Per unit: first chunk (inclusive) and end chunk (exclusive). */
  readonly unitChunkFrom: Int32Array;
  readonly unitChunkTo: Int32Array;
  /** Per unit: cap centre x y z, then radius. */
  readonly unitCap: Float64Array;
}

const indexes = new WeakMap<World, LandIndex>();

function buildIndex(world: World): LandIndex {
  const unitIds: string[] = [];
  const units: WorldUnit[] = [];
  for (const unit of world.units.values()) {
    unitIds.push(unit.id);
    units.push(unit);
  }
  let vertexCount = 0;
  let chunkCount = 0;
  for (const unit of units) {
    for (const part of unit.parts) {
      for (const ring of part.polygon.coordinates) {
        vertexCount += ring.length;
        chunkCount += Math.max(0, Math.ceil((ring.length - 1) / CHUNK_EDGES));
      }
    }
  }
  const vertices = new Float64Array(vertexCount * 3);
  const chunkStart = new Int32Array(chunkCount);
  const chunkEdges = new Int32Array(chunkCount);
  const chunkPart = new Int32Array(chunkCount);
  const chunkCap = new Float64Array(chunkCount * 4);
  const unitChunkFrom = new Int32Array(units.length);
  const unitChunkTo = new Int32Array(units.length);
  const unitCap = new Float64Array(units.length * 4);

  let v = 0;
  let c = 0;
  const tmp = new Float64Array(3);
  units.forEach((unit, u) => {
    unitChunkFrom[u] = c;
    unit.parts.forEach((part, partIndex) => {
      for (const ring of part.polygon.coordinates) {
        const ringStart = v;
        for (const position of ring) {
          lngLatToVec([position[0] as number, position[1] as number], tmp);
          vertices[v * 3] = tmp[0] as number;
          vertices[v * 3 + 1] = tmp[1] as number;
          vertices[v * 3 + 2] = tmp[2] as number;
          v += 1;
        }
        const edges = ring.length - 1;
        for (let from = 0; from < edges; from += CHUNK_EDGES) {
          const count = Math.min(CHUNK_EDGES, edges - from);
          const first = ringStart + from;
          chunkStart[c] = first;
          chunkEdges[c] = count;
          chunkPart[c] = partIndex;
          writeCap(vertices, first, count + 1, chunkCap, c * 4);
          c += 1;
        }
      }
    });
    unitChunkTo[u] = c;
    // The unit's cap encloses its chunks' caps (triangle inequality: valid for any size).
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = unitChunkFrom[u] as number; k < c; k += 1) {
      sx += chunkCap[k * 4] as number;
      sy += chunkCap[k * 4 + 1] as number;
      sz += chunkCap[k * 4 + 2] as number;
    }
    const len = Math.hypot(sx, sy, sz);
    let radius = 0;
    if (len < 1e-9) {
      radius = Math.PI;
      sx = 1;
      sy = 0;
      sz = 0;
    } else {
      sx /= len;
      sy /= len;
      sz /= len;
      for (let k = unitChunkFrom[u] as number; k < c; k += 1) {
        const dot = sx * (chunkCap[k * 4] as number) + sy * (chunkCap[k * 4 + 1] as number) + sz * (chunkCap[k * 4 + 2] as number);
        radius = Math.max(radius, Math.acos(Math.max(-1, Math.min(1, dot))) + (chunkCap[k * 4 + 3] as number));
      }
      radius = Math.min(Math.PI, radius);
    }
    unitCap[u * 4] = sx;
    unitCap[u * 4 + 1] = sy;
    unitCap[u * 4 + 2] = sz;
    unitCap[u * 4 + 3] = radius;
  });
  return {
    unitIds,
    unitIndex: new Map(unitIds.map((id, i) => [id, i])),
    vertices,
    chunkStart,
    chunkEdges,
    chunkPart,
    chunkCap,
    unitChunkFrom,
    unitChunkTo,
    unitCap,
  };
}

/** Smallest-ish cap around `count` consecutive vertices starting at `first`. */
function writeCap(vertices: Float64Array, first: number, count: number, out: Float64Array, at: number): void {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < count; i += 1) {
    sx += vertices[(first + i) * 3] as number;
    sy += vertices[(first + i) * 3 + 1] as number;
    sz += vertices[(first + i) * 3 + 2] as number;
  }
  const len = Math.hypot(sx, sy, sz);
  if (len < 1e-9) {
    out[at] = vertices[first * 3] as number;
    out[at + 1] = vertices[first * 3 + 1] as number;
    out[at + 2] = vertices[first * 3 + 2] as number;
    out[at + 3] = Math.PI;
    return;
  }
  sx /= len;
  sy /= len;
  sz /= len;
  let radius = 0;
  for (let i = 0; i < count; i += 1) {
    const dot = sx * (vertices[(first + i) * 3] as number) + sy * (vertices[(first + i) * 3 + 1] as number) + sz * (vertices[(first + i) * 3 + 2] as number);
    radius = Math.max(radius, Math.acos(Math.max(-1, Math.min(1, dot))));
  }
  radius += 1e-9;
  out[at] = sx;
  out[at + 1] = sy;
  out[at + 2] = sz;
  out[at + 3] = radius > MAX_PRUNING_RADIUS ? Math.PI : radius;
}

function indexFor(world: World): LandIndex {
  let index = indexes.get(world);
  if (index === undefined) {
    index = buildIndex(world);
    indexes.set(world, index);
  }
  return index;
}

/** Builds the nearest-coast index for `world` now (otherwise the first landing builds it). Idempotent. */
export function prepareLanding(world: World): void {
  indexFor(world);
}

// -- Nearest-boundary search -------------------------------------------------------------------------

interface Nearest {
  /** `1 − cos(angle)` to the best edge point found so far. */
  m: number;
  x: number;
  y: number;
  z: number;
  unit: number;
  part: number;
}

function newNearest(limitM: number): Nearest {
  return { m: limitM, x: 0, y: 0, z: 0, unit: -1, part: -1 };
}

/** Lower bound (as `m`) on the distance from `p` to anything inside the cap at `caps[at..at+3]`. */
function capLowerBoundM(caps: Float64Array, at: number, px: number, py: number, pz: number): number {
  const radius = caps[at + 3] as number;
  if (radius >= Math.PI) return 0;
  const dot = px * (caps[at] as number) + py * (caps[at + 1] as number) + pz * (caps[at + 2] as number);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))) - radius;
  return angle <= 0 ? 0 : mOfAngle(angle);
}

/** Opens one chunk: updates `best` with the closest edge point of its edges. */
function scanChunk(index: LandIndex, chunk: number, unit: number, px: number, py: number, pz: number, best: Nearest): void {
  const v = index.vertices;
  const part = index.chunkPart[chunk] as number;
  const first = index.chunkStart[chunk] as number;
  const edges = index.chunkEdges[chunk] as number;
  let ia = first * 3;
  let ax = v[ia] as number;
  let ay = v[ia + 1] as number;
  let az = v[ia + 2] as number;
  for (let j = 0; j < edges; j += 1) {
    ia += 3;
    const bx = v[ia] as number;
    const by = v[ia + 1] as number;
    const bz = v[ia + 2] as number;
    // Edge endpoints (each vertex is the start of the next edge, so only `b` needs checking here;
    // the chunk's first vertex is checked on the first pass through `a`).
    if (j === 0) {
      const ma = 1 - (px * ax + py * ay + pz * az);
      if (ma < best.m) {
        best.m = ma;
        best.x = ax;
        best.y = ay;
        best.z = az;
        best.unit = unit;
        best.part = part;
      }
    }
    const mb = 1 - (px * bx + py * by + pz * bz);
    if (mb < best.m) {
      best.m = mb;
      best.x = bx;
      best.y = by;
      best.z = bz;
      best.unit = unit;
      best.part = part;
    }
    // The edge's interior: nearest point of the great circle through a and b, if it lies on the edge.
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const nn = nx * nx + ny * ny + nz * nz;
    if (nn > 1e-24) {
      const aox = ay * pz - az * py;
      const aoy = az * px - ax * pz;
      const aoz = ax * py - ay * px;
      if (aox * nx + aoy * ny + aoz * nz >= 0) {
        const obx = py * bz - pz * by;
        const oby = pz * bx - px * bz;
        const obz = px * by - py * bx;
        if (obx * nx + oby * ny + obz * nz >= 0) {
          const pn = px * nx + py * ny + pz * nz;
          const s2 = (pn * pn) / nn;
          const m = s2 / (1 + Math.sqrt(Math.max(0, 1 - s2)));
          if (m < best.m) {
            const k = pn / nn;
            const qx = px - k * nx;
            const qy = py - k * ny;
            const qz = pz - k * nz;
            const ql = Math.hypot(qx, qy, qz) || 1;
            best.m = m;
            best.x = qx / ql;
            best.y = qy / ql;
            best.z = qz / ql;
            best.unit = unit;
            best.part = part;
          }
        }
      }
    }
    ax = bx;
    ay = by;
    az = bz;
  }
}

/** Opens every chunk of `unit` whose cap could hold something nearer than `best`. */
function scanUnit(index: LandIndex, unit: number, px: number, py: number, pz: number, best: Nearest): void {
  const to = index.unitChunkTo[unit] as number;
  for (let chunk = index.unitChunkFrom[unit] as number; chunk < to; chunk += 1) {
    if (capLowerBoundM(index.chunkCap, chunk * 4, px, py, pz) >= best.m) continue;
    scanChunk(index, chunk, unit, px, py, pz, best);
  }
}

/** Eligible-unit flags by index position, and how many are set. */
function eligibleFlags(index: LandIndex, eligible: ReadonlySet<string>): { flags: Uint8Array; count: number } {
  const flags = new Uint8Array(index.unitIds.length);
  let count = 0;
  for (const id of eligible) {
    const u = index.unitIndex.get(id);
    if (u !== undefined && flags[u] === 0) {
      flags[u] = 1;
      count += 1;
    }
  }
  return { flags, count };
}

/** Eligible units by increasing lower-bound distance from `p` (cap test only). */
function unitsNearestFirst(index: LandIndex, flags: Uint8Array, px: number, py: number, pz: number): Array<{ unit: number; lb: number }> {
  const order: Array<{ unit: number; lb: number }> = [];
  for (let u = 0; u < flags.length; u += 1) {
    if (flags[u] === 1) order.push({ unit: u, lb: capLowerBoundM(index.unitCap, u * 4, px, py, pz) });
  }
  order.sort((a, b) => a.lb - b.lb || a.unit - b.unit);
  return order;
}

function nearestBoundary(index: LandIndex, flags: Uint8Array, p: Float64Array): Nearest | null {
  const best = newNearest(Number.POSITIVE_INFINITY);
  const px = p[0] as number;
  const py = p[1] as number;
  const pz = p[2] as number;
  for (const { unit, lb } of unitsNearestFirst(index, flags, px, py, pz)) {
    if (lb >= best.m) break;
    scanUnit(index, unit, px, py, pz, best);
  }
  return best.unit < 0 ? null : best;
}

// -- Containment -------------------------------------------------------------------------------------

function bboxHas(bbox: readonly [LngLat, LngLat], p: LngLat): boolean {
  const [[w, s], [e, n]] = bbox;
  if (p[1] < s || p[1] > n) return false;
  return w <= e ? p[0] >= w && p[0] <= e : p[0] >= w || p[0] <= e;
}

/** The index of the part of `unit` that contains `p`, or -1. */
function containingPart(unit: WorldUnit, p: LngLat): number {
  if (!bboxHas(unit.bbox, p)) return -1;
  for (let i = 0; i < unit.parts.length; i += 1) {
    const part = unit.parts[i] as WorldUnit["parts"][number];
    if (bboxHas(part.bbox, p) && geoContains(part.polygon, p as [number, number])) return i;
  }
  return -1;
}

/** The first flagged unit (by index order) containing `p`, or -1. */
function containingUnit(index: LandIndex, world: World, flags: Uint8Array, p: LngLat): number {
  for (let u = 0; u < flags.length; u += 1) {
    if (flags[u] !== 1) continue;
    const unit = world.units.get(index.unitIds[u] as string);
    if (unit !== undefined && containingPart(unit, p) >= 0) return u;
  }
  return -1;
}

/**
 * The unit (among `eligible`, or every unit when omitted) whose land contains `point`, or `null` for
 * sea. Great-circle edges, the `detail` geometry.
 */
export function unitContaining(world: World, point: LngLat, eligible?: ReadonlySet<string>): string | null {
  const index = indexFor(world);
  const flags = new Uint8Array(index.unitIds.length);
  if (eligible === undefined) flags.fill(1);
  else for (const id of eligible) {
    const u = index.unitIndex.get(id);
    if (u !== undefined) flags[u] = 1;
  }
  const u = containingUnit(index, world, flags, [normalizeLng(point[0]), point[1]]);
  return u < 0 ? null : (index.unitIds[u] as string);
}

// -- Distance to a unit ------------------------------------------------------------------------------

interface UnitDistance {
  readonly unit: number;
  readonly km: number;
  /** The nearest point of the unit (the point itself when inside). */
  readonly at: LngLat;
}

/** Distance from `point` (vector `p`) to `unit`'s land, or null when it is farther than `limitM`. */
function distanceToUnit(index: LandIndex, world: World, unit: number, point: LngLat, p: Float64Array, limitM: number): UnitDistance | null {
  const px = p[0] as number;
  const py = p[1] as number;
  const pz = p[2] as number;
  const unitObj = world.units.get(index.unitIds[unit] as string);
  if (unitObj !== undefined && containingPart(unitObj, point) >= 0) return { unit, km: 0, at: point };
  if (capLowerBoundM(index.unitCap, unit * 4, px, py, pz) >= limitM) return null;
  const best = newNearest(limitM);
  scanUnit(index, unit, px, py, pz, best);
  if (best.unit < 0) return null;
  return { unit, km: angleOfM(best.m) * EARTH_RADIUS_KM, at: vecToLngLat(best.x, best.y, best.z) };
}

/**
 * The nearest point of `unitId`'s land to `point` and the distance to it in kilometres (0 and `point`
 * itself when inside). `null` for an id the world does not have. The camera fit uses this: the view
 * radius that frames the roulette is the largest such distance, × 1.25.
 */
export function nearestPointOnUnit(world: World, unitId: string, point: LngLat): { point: LngLat; km: number } | null {
  const index = indexFor(world);
  const u = index.unitIndex.get(unitId);
  if (u === undefined) return null;
  const P: LngLat = [normalizeLng(point[0]), point[1]];
  const p = new Float64Array(3);
  lngLatToVec(P, p);
  const found = distanceToUnit(index, world, u, P, p, Number.POSITIVE_INFINITY);
  return found === null ? null : { point: found.at, km: found.km };
}

/**
 * A camera that frames a unit's main land: centred on the pole of inaccessibility of its largest part,
 * fitted to that part's bounding box (so Alaska and Hawaii do not drag the camera off the US mainland).
 * `null` for an unknown id.
 */
export function cameraForUnit(world: World, unitId: string, minDeg = 1.5, maxDeg = 40): Camera | null {
  const unit = world.units.get(unitId);
  if (unit === undefined || unit.parts.length === 0) return null;
  let best = unit.parts[0] as WorldUnit["parts"][number];
  let bestArea = -1;
  for (const part of unit.parts) {
    const area = geoArea(part.polygon);
    if (area > bestArea) {
      best = part;
      bestArea = area;
    }
  }
  const [[w, s], [e, n]] = best.bbox;
  const east = e < w ? e + 360 : e;
  const corners: LngLat[] = [
    [w, s],
    [w, n],
    [east, s],
    [east, n],
  ].map(([lng, lat]) => [normalizeLng(lng as number), lat as number] as LngLat);
  return fitCamera(best.centre, corners, minDeg, maxDeg);
}

// -- The landing -------------------------------------------------------------------------------------

/**
 * Computes the whole landing for the point `P` under the pin (spec §3.2). `eligible` is the set of unit
 * ids the server says still have a destination left. Returns `null` only when none of `eligible` is a
 * unit of the world (nothing to land on).
 */
export function computeLanding(world: World, eligible: ReadonlySet<string>, point: LngLat): Landing | null {
  const index = indexFor(world);
  const { flags, count } = eligibleFlags(index, eligible);
  if (count === 0) return null;
  const P: LngLat = [normalizeLng(point[0]), Math.max(-90, Math.min(90, point[1]))];
  const p = new Float64Array(3);
  lngLatToVec(P, p);

  // 1–3. On eligible land, or the nearest eligible coast and 30 % of the way inland from it.
  let sea = true;
  let land: LngLat = P;
  let centre: LngLat = P;
  let landUnit = containingUnit(index, world, flags, P);
  if (landUnit >= 0) {
    sea = false;
  } else {
    const nearest = nearestBoundary(index, flags, p);
    if (nearest === null) return null;
    land = vecToLngLat(nearest.x, nearest.y, nearest.z);
    landUnit = nearest.unit;
    const owner = world.units.get(index.unitIds[landUnit] as string) as WorldUnit;
    const part = owner.parts[nearest.part] ?? owner.parts[0];
    centre = part === undefined ? land : greatCircleAt(land, part.centre, INLAND_FRACTION);
  }

  // 4. Candidates by distance from the centre.
  const c = new Float64Array(3);
  lngLatToVec(centre, c);
  const farM = mOfAngle(CANDIDATE_FAR_KM / EARTH_RADIUS_KM);
  const nearKm = CANDIDATE_NEAR_KM;
  const others: UnitDistance[] = [];
  for (let u = 0; u < flags.length; u += 1) {
    if (flags[u] !== 1 || u === landUnit) continue; // the landing unit is first whatever its distance
    const found = distanceToUnit(index, world, u, centre, c, farM);
    if (found !== null && found.km <= CANDIDATE_FAR_KM) others.push(found);
  }
  // Nearest first; exact ties by id (code-point order, so the result never depends on a locale).
  others.sort((a, b) => a.km - b.km || compareIds(index.unitIds[a.unit] as string, index.unitIds[b.unit] as string));
  const picked: string[] = [index.unitIds[landUnit] as string];
  for (const o of others) {
    if (picked.length >= CANDIDATE_MAX) break;
    if (o.km <= nearKm || picked.length < CANDIDATE_MIN) picked.push(index.unitIds[o.unit] as string);
    else break; // sorted: every later unit is farther still
  }

  return {
    point: roundPoint(P),
    sea,
    land: roundPoint(land),
    centre: roundPoint(centre),
    landUnit: index.unitIds[landUnit] as string,
    candidates: picked,
  };
}
