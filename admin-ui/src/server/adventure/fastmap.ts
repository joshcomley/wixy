// Adventure Time — the fast path of the globe renderer.
//
// d3's geoPath is general: for every vertex it clips, rotates, resamples and projects through a chain of
// stream objects, ~0.3 microseconds a vertex. That is fine for a still picture and too slow for the
// spinning globe on a phone (10 000 coarse vertices every frame, on a CPU a quarter of a laptop's).
// The orthographic projection of a unit vector is just a 3x3 matrix and a scale, so for geometry that
// lies wholly on the visible hemisphere this module draws it directly from precomputed unit vectors:
// nine multiplies and one `lineTo` per vertex. Geometry that straddles the horizon is left to d3 (its
// clipping is the hard part), and lines are simply broken where they pass behind the globe.
//
// The maths is the same as d3's — `x = cx + R·u.y`, `y = cy − R·u.z`, `depth = u.x` for `u = M·v` — so
// a fast-drawn unit and a d3-drawn neighbour meet exactly (tested against `projection()` to 1e-9 px).
// Edges are densified once at index time to at most `MAX_EDGE_DEG`, so a chord on screen stays within a
// fraction of a pixel of the great-circle arc d3 would have resampled.

import { geoRotation } from "d3-geo";
import type { UnitFeature } from "./world";

const RAD = Math.PI / 180;
/** Longest edge kept; longer ones get intermediate vertices along the great circle. */
export const MAX_EDGE_DEG = 1.5;

/** Unit vectors for `coords` (lng/lat degrees), with long edges subdivided. Returns x y z per vertex. */
export function vectorsOf(coords: ReadonlyArray<readonly number[]>, maxEdgeDeg = MAX_EDGE_DEG): Float64Array {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  let pz = 0;
  const maxEdge = maxEdgeDeg * RAD;
  for (let i = 0; i < coords.length; i += 1) {
    const c = coords[i] as readonly number[];
    const lng = (c[0] as number) * RAD;
    const lat = (c[1] as number) * RAD;
    const cosLat = Math.cos(lat);
    const x = cosLat * Math.cos(lng);
    const y = cosLat * Math.sin(lng);
    const z = Math.sin(lat);
    if (i > 0) {
      const angle = Math.acos(Math.max(-1, Math.min(1, px * x + py * y + pz * z)));
      if (angle > maxEdge) {
        const steps = Math.ceil(angle / maxEdge);
        const sinAngle = Math.sin(angle);
        for (let s = 1; s < steps; s += 1) {
          const t = s / steps;
          const a = Math.sin((1 - t) * angle) / sinAngle;
          const b = Math.sin(t * angle) / sinAngle;
          out.push(a * px + b * x, a * py + b * y, a * pz + b * z);
        }
      }
    }
    out.push(x, y, z);
    px = x;
    py = y;
    pz = z;
  }
  return Float64Array.from(out);
}

/** All the rings of all the features of one level, as flat vectors. */
export interface FastRings {
  readonly verts: Float64Array;
  /** `ringStart[r]..ringStart[r+1]` are ring `r`'s vertex indices. */
  readonly ringStart: Int32Array;
  /** Feature `f` owns rings `featureRing[f]..featureRing[f+1]`. */
  readonly featureRing: Int32Array;
}

export function buildFastRings(features: readonly UnitFeature[]): FastRings {
  const verts: number[] = [];
  const ringStart: number[] = [0];
  const featureRing: number[] = [0];
  for (const feature of features) {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        // A closed ring repeats its first point; the fill closes it by itself.
        const open = ring.length > 1 && ring[0]?.[0] === ring[ring.length - 1]?.[0] && ring[0]?.[1] === ring[ring.length - 1]?.[1] ? ring.slice(0, -1) : ring;
        if (open.length < 3) continue;
        const v = vectorsOf([...open, open[0] as number[]]);
        // `vectorsOf` of the ring plus its first point again also densifies the closing edge; drop the repeat.
        for (let i = 0; i < v.length - 3; i += 1) verts.push(v[i] as number);
        ringStart.push(verts.length / 3);
      }
    }
    featureRing.push(ringStart.length - 1);
  }
  return {
    verts: Float64Array.from(verts),
    ringStart: Int32Array.from(ringStart),
    featureRing: Int32Array.from(featureRing),
  };
}

/**
 * Fills `out` (9 numbers, row-major) with the matrix `M` such that `u = M·v` for a unit vector `v` of a
 * point is the point in the view's frame: `u.x` is its depth toward the viewer, `u.y` its screen x and
 * `u.z` its screen height (before scale). `rotation` is d3's `[λ, φ, γ]`.
 */
export function rotationMatrix(rotation: readonly [number, number, number], out: Float64Array): void {
  const rotate = geoRotation(rotation as [number, number, number]);
  // Columns of M are the images of the basis vectors e_x (lng 0, lat 0), e_y (lng 90) and e_z (north pole).
  const basis: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [90, 0],
    [0, 90],
  ];
  for (let col = 0; col < 3; col += 1) {
    const [lng, lat] = rotate(basis[col] as [number, number]);
    const cosLat = Math.cos(lat * RAD);
    out[col] = cosLat * Math.cos(lng * RAD);
    out[3 + col] = cosLat * Math.sin(lng * RAD);
    out[6 + col] = Math.sin(lat * RAD);
  }
}

export const HIDDEN = 0;
export const FRONT = 1;
export const MIXED = 2;

/** Is feature `f` wholly behind the globe (`HIDDEN`), wholly in front (`FRONT`) or across the horizon? */
export function classify(rings: FastRings, f: number, m: Float64Array): number {
  const v = rings.verts;
  const from = (rings.ringStart[rings.featureRing[f] as number] as number) * 3;
  const to = (rings.ringStart[rings.featureRing[f + 1] as number] as number) * 3;
  const m0 = m[0] as number;
  const m1 = m[1] as number;
  const m2 = m[2] as number;
  let front = 0;
  let back = 0;
  for (let o = from; o < to; o += 3) {
    const depth = m0 * (v[o] as number) + m1 * (v[o + 1] as number) + m2 * (v[o + 2] as number);
    if (depth > 0) front += 1;
    else back += 1;
    if (front > 0 && back > 0) return MIXED;
  }
  return back === 0 ? FRONT : HIDDEN;
}

/** Adds feature `f` (which must be `FRONT`) to the current path. */
export function emitFeature(c: CanvasRenderingContext2D, rings: FastRings, f: number, m: Float64Array, cx: number, cy: number, r: number): void {
  const v = rings.verts;
  const m3 = m[3] as number;
  const m4 = m[4] as number;
  const m5 = m[5] as number;
  const m6 = m[6] as number;
  const m7 = m[7] as number;
  const m8 = m[8] as number;
  const last = rings.featureRing[f + 1] as number;
  for (let ring = rings.featureRing[f] as number; ring < last; ring += 1) {
    const from = rings.ringStart[ring] as number;
    const to = rings.ringStart[ring + 1] as number;
    for (let i = from; i < to; i += 1) {
      const o = i * 3;
      const x = v[o] as number;
      const y = v[o + 1] as number;
      const z = v[o + 2] as number;
      const sx = cx + r * (m3 * x + m4 * y + m5 * z);
      const sy = cy - r * (m6 * x + m7 * y + m8 * z);
      if (i === from) c.moveTo(sx, sy);
      else c.lineTo(sx, sy);
    }
  }
}

/**
 * Adds a polyline (`vec`: x y z per vertex) to the current path, broken where it passes behind the
 * globe; the pieces end exactly on the limb.
 */
export function emitLine(c: CanvasRenderingContext2D, vec: Float64Array, m: Float64Array, cx: number, cy: number, r: number): void {
  const m0 = m[0] as number;
  const m1 = m[1] as number;
  const m2 = m[2] as number;
  const m3 = m[3] as number;
  const m4 = m[4] as number;
  const m5 = m[5] as number;
  const m6 = m[6] as number;
  const m7 = m[7] as number;
  const m8 = m[8] as number;
  let pen = false;
  let pd = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  for (let o = 0; o < vec.length; o += 3) {
    const x = vec[o] as number;
    const y = vec[o + 1] as number;
    const z = vec[o + 2] as number;
    const d = m0 * x + m1 * y + m2 * z;
    if (d > 0) {
      if (!pen) {
        if (o > 0 && pd <= 0) {
          // Coming round the limb: start at the horizon crossing.
          const t = -pd / (d - pd);
          lineAtLimb(c, true, px + t * (x - px), py + t * (y - py), pz + t * (z - pz), m, cx, cy, r);
        } else {
          c.moveTo(cx + r * (m3 * x + m4 * y + m5 * z), cy - r * (m6 * x + m7 * y + m8 * z));
        }
        pen = true;
      } else {
        c.lineTo(cx + r * (m3 * x + m4 * y + m5 * z), cy - r * (m6 * x + m7 * y + m8 * z));
      }
    } else if (pen) {
      const t = pd / (pd - d);
      lineAtLimb(c, false, px + t * (x - px), py + t * (y - py), pz + t * (z - pz), m, cx, cy, r);
      pen = false;
    }
    pd = d;
    px = x;
    py = y;
    pz = z;
  }
}

/** Projects the horizon-crossing point (renormalised onto the sphere) and moves or draws to it. */
function lineAtLimb(c: CanvasRenderingContext2D, move: boolean, x: number, y: number, z: number, m: Float64Array, cx: number, cy: number, r: number): void {
  const len = Math.hypot(x, y, z) || 1;
  const nx = x / len;
  const ny = y / len;
  const nz = z / len;
  const sx = cx + r * ((m[3] as number) * nx + (m[4] as number) * ny + (m[5] as number) * nz);
  const sy = cy - r * ((m[6] as number) * nx + (m[7] as number) * ny + (m[8] as number) * nz);
  if (move) c.moveTo(sx, sy);
  else c.lineTo(sx, sy);
}
