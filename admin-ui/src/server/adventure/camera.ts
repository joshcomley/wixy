// Adventure Time — camera maths (spec/server-chat/08-adventure-time.md §3.3).
//
// The globe is always drawn with d3's orthographic projection, whose view is an Euler rotation
// `[λ, φ, γ]`. Two ways of describing a view are used:
//
// - the RAW rotation `[λ, φ]` of a spin: φ is unbounded (the globe tumbles over the poles), so the
//   point under the pin is not simply `[-λ, -φ]` once |φ| passes 90°; and
// - a CAMERA: the point looked at (`centre`), how much of the sphere fills the view (`viewRadiusDeg`)
//   and a `roll` (0 = north is up, 180 = upside down). A camera is what the zoom moves tween between.
//
// `cameraFromRotation` turns the first into the second WITHOUT changing the picture (a globe that
// ended a tumble upside down becomes `roll: 180`), so a camera move can start from wherever the spin
// stopped and right the globe on the way. The maths is exact: `rotate([-lng, -lat, -roll])` is the same
// projection as the raw rotation it came from (tested to 1e-9 degrees).
//
// Nothing here draws anything and nothing touches the DOM.

import { geoDistance, geoInterpolate, geoRotation } from "d3-geo";
import { clamp, easeInOutCubic } from "./physics";

/** `[longitude, latitude]` in degrees, GeoJSON order. */
export type LngLat = readonly [number, number];
/** d3's rotation: `[λ, φ]` or `[λ, φ, γ]`, degrees. */
export type Rotation = readonly [number, number] | readonly [number, number, number];

export interface Camera {
  /** The point at the centre of the view (under the pin). */
  readonly centre: LngLat;
  /**
   * Angular radius of what the view's `0.45 · min(width, height)` pixels show, degrees. 90 shows
   * the whole globe; 1.2 is "a place"; the limits are `MIN_VIEW_RADIUS_DEG`..`MAX_VIEW_RADIUS_DEG`.
   */
  readonly viewRadiusDeg: number;
  /** Clockwise angle from screen-up to local north, degrees; 0 (the default) is north-up. */
  readonly roll?: number;
}

export const MIN_VIEW_RADIUS_DEG = 0.3;
export const MAX_VIEW_RADIUS_DEG = 90;
/**
 * Over satellite or atlas imagery (8192 px across the globe, ~23 px per degree) a view tighter than this is
 * enlarged more than ~7x and turns soft: an explorable map should not zoom past it while imagery shows.
 * The vector borders stay crisp at any zoom; this is a taste limit, not a technical one.
 */
export const MIN_VIEW_RADIUS_TEXTURED_DEG = 0.8;
/** At a view radius of 90° the globe's radius is this fraction of the shorter canvas side. */
export const GLOBE_FILL = 0.45;
/** The view radius at which drawing switches from the coarse to the detail geometry. */
export const DETAIL_BELOW_DEG = 60;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Longitude wrapped to [-180, 180). */
export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** An angle wrapped to (-180, 180]. */
export function wrapAngle(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** The d3 rotation that centres `centre` with the given roll (clockwise degrees of north from up). */
export function rotationFor(centre: LngLat, roll = 0): [number, number, number] {
  return [-centre[0], -centre[1], -roll];
}

/** The d3 rotation of a whole camera. */
export function cameraRotation(camera: Camera): [number, number, number] {
  return rotationFor(camera.centre, camera.roll ?? 0);
}

/**
 * The point on the sphere under the pin (the screen centre) for any rotation. d3's rotation is a true 3D
 * rotation, so this is right for every φ: tumbling past a pole carries the point over it and out the
 * other side (φ = 120° at λ = 20° looks at `[160, -60]`, upside down).
 */
export function centreOfRotation(rotation: Rotation): LngLat {
  const [lng, lat] = geoRotation(rotation as [number, number, number]).invert([0, 0]);
  return [normalizeLng(lng), lat];
}

/**
 * The roll of a rotation: the clockwise angle from screen-up to local north at the centre. 0 for any
 * φ in [-90, 90] (mod 360) with γ = 0, 180 once the globe has tumbled over a pole.
 */
export function rollOfRotation(rotation: Rotation): number {
  const rotate = geoRotation(rotation as [number, number, number]);
  const [lng, lat] = rotate.invert([0, 0]);
  // Look slightly north of the centre (south at the north pole, where north has no direction).
  const step = lat > 89.9 ? -0.01 : 0.01;
  const [rx, ry] = rotate([lng, lat + step]);
  const dx = rx * RAD * Math.cos(ry * RAD);
  const dy = ry * RAD;
  const angle = Math.atan2(dx, dy) * DEG + (step < 0 ? 180 : 0);
  // |roll| below the 4th decimal is arithmetic noise: report an exact 0 / 180.
  const rounded = Math.round(wrapAngle(angle) * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
}

/** The camera that draws the same picture as the raw rotation `rotation` at `viewRadiusDeg`. */
export function cameraFromRotation(rotation: Rotation, viewRadiusDeg: number = MAX_VIEW_RADIUS_DEG): Camera {
  return {
    centre: centreOfRotation(rotation),
    viewRadiusDeg: clampViewRadius(viewRadiusDeg),
    roll: rollOfRotation(rotation),
  };
}

export function clampViewRadius(deg: number): number {
  return clamp(Number.isFinite(deg) ? deg : MAX_VIEW_RADIUS_DEG, MIN_VIEW_RADIUS_DEG, MAX_VIEW_RADIUS_DEG);
}

/**
 * The orthographic scale (the globe's radius in pixels) at which `viewRadiusDeg` of the sphere fills
 * `0.45 · min(width, height)` pixels: `R · sin(min(viewRadius, 90°)) = 0.45 · min(w, h)`. At 90° the
 * whole globe is on screen at radius `0.45 · min(w, h)`.
 */
export function scaleFor(viewRadiusDeg: number, width: number, height: number): number {
  const radius = clamp(Number.isFinite(viewRadiusDeg) ? viewRadiusDeg : MAX_VIEW_RADIUS_DEG, 0.01, 90);
  return (GLOBE_FILL * Math.min(width, height)) / Math.sin(radius * RAD);
}

/** The inverse of `scaleFor`. */
export function viewRadiusForScale(scale: number, width: number, height: number): number {
  if (!(scale > 0)) return MAX_VIEW_RADIUS_DEG;
  const ratio = (GLOBE_FILL * Math.min(width, height)) / scale;
  return ratio >= 1 ? 90 : Math.asin(ratio) * DEG;
}

/** Great-circle distance between two points, degrees. */
export function angularDistanceDeg(a: LngLat, b: LngLat): number {
  return geoDistance(a as [number, number], b as [number, number]) * DEG;
}

/** The spherical mean of some points (the direction of the sum of their unit vectors). */
export function meanPoint(points: readonly LngLat[]): LngLat {
  const first = points[0];
  if (first === undefined) return [0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lng, lat] of points) {
    const cosLat = Math.cos(lat * RAD);
    x += cosLat * Math.cos(lng * RAD);
    y += cosLat * Math.sin(lng * RAD);
    z += Math.sin(lat * RAD);
  }
  const horizontal = Math.hypot(x, y);
  if (horizontal < 1e-9 && Math.abs(z) < 1e-9) return first; // balanced around the sphere: no mean
  return [Math.atan2(y, x) * DEG, Math.atan2(z, horizontal) * DEG];
}

/**
 * A camera on `centre` that shows every point in `points` with a 25 % margin: the view radius is the
 * largest angular distance from `centre` to a point, times 1.25, clamped to `[minDeg, maxDeg]`.
 */
export function fitCamera(centre: LngLat, points: readonly LngLat[], minDeg: number, maxDeg: number, roll = 0): Camera {
  let farthest = 0;
  for (const p of points) farthest = Math.max(farthest, angularDistanceDeg(centre, p));
  return {
    centre,
    viewRadiusDeg: clamp(farthest * 1.25, minDeg, Math.max(minDeg, maxDeg)),
    roll,
  };
}

/**
 * The camera `t` of the way from `a` to `b` (`t` is NOT eased here: pass `easeInOutCubic(t)` or use
 * `cameraAt`). The centre travels the great circle between the two centres, the view radius changes
 * evenly in log space (so a zoom looks the same speed at every scale), and the roll takes the short way.
 */
export function tweenCamera(a: Camera, b: Camera, t: number): Camera {
  if (!(t > 0)) return a;
  if (!(t < 1)) return b;
  const radius = Math.exp(Math.log(a.viewRadiusDeg) * (1 - t) + Math.log(b.viewRadiusDeg) * t);
  const rollA = a.roll ?? 0;
  const rollB = b.roll ?? 0;
  const roll = wrapAngle(rollA + wrapAngle(rollB - rollA) * t);
  return { centre: greatCircleAt(a.centre, b.centre, t), viewRadiusDeg: radius, roll };
}

/** `tweenCamera` over time, ease-in-out: the camera `elapsedMs` into a `durationMs` move. */
export function cameraAt(a: Camera, b: Camera, elapsedMs: number, durationMs: number): Camera {
  if (!(durationMs > 0)) return b;
  return tweenCamera(a, b, easeInOutCubic(elapsedMs / durationMs));
}

/** The point `t` of the way along the shorter great circle from `a` to `b`. */
export function greatCircleAt(a: LngLat, b: LngLat, t: number): LngLat {
  let target = b;
  // Exactly antipodal points have no unique great circle (and a zero denominator in d3's formula):
  // nudge the target a hair off, which picks one of the equally short routes.
  if (geoDistance(a as [number, number], b as [number, number]) > Math.PI - 1e-9) target = [b[0], b[1] + 1e-6];
  const [lng, lat] = geoInterpolate(a as [number, number], target as [number, number])(t);
  return [normalizeLng(lng), lat];
}
