// Adventure Time — the globe renderer (spec/server-chat/08-adventure-time.md §3, §5.2).
//
// One <canvas>, d3's orthographic projection (`clipAngle(90)`) and `geoPath(projection, ctx)`. The
// renderer owns NO clock and NO animation loop: the pane calls `draw(frame, nowMs)` whenever it wants a
// picture, and the picture is a pure function of the two arguments — every animated thing (the lit
// unit's glow, the ripple, the glide, the pin dropping, the trail's fade) is driven by numbers the frame
// carries or by `nowMs`. That is what lets tests drive it with a recording stub context and lets two
// screens that replay the same server timestamps show the same picture.
//
// What is drawn, back to front: the atmosphere halo, the ocean (radial gradient while the whole globe
// is on screen, a calm flat blue once zoomed in), a graticule that gets finer as you zoom, the land
// (one fill for everything, then the emphasised units), the borders and coastlines (stroked from the
// world's meshes so no line is drawn twice and none along the horizon), the sphere shading and rim,
// the glide line, the ripple, the destination dots with their labels, the pin and the swipe trail.
//
// Geometry level: the `coarse` unit shapes while the view radius is >= 60 degrees (a fast fill for the
// spinning globe), the `detail` shapes once closer. Quality knobs are per pixel, not per frame: DPR is
// clamped at 2, and nothing allocates per unit per frame except d3's own stream objects.
//
// Everything is guarded against a missing 2D context (jsdom, a locked-down browser): `draw` is then a
// no-op rather than a throw.

import {
  geoGraticule,
  geoGraticule10,
  geoInterpolate,
  geoOrthographic,
  geoPath,
  type GeoPath,
  type GeoProjection,
} from "d3-geo";
import type { MultiLineString } from "geojson";
import {
  DETAIL_BELOW_DEG,
  MAX_VIEW_RADIUS_DEG,
  cameraRotation,
  centreOfRotation,
  clampViewRadius,
  scaleFor,
  type Camera,
  type LngLat,
  type Rotation,
} from "./camera";
import { HIDDEN, FRONT, buildFastRings, classify, emitFeature, emitLine, rotationMatrix, vectorsOf, type FastRings } from "./fastmap";
import { easeOutCubic } from "./physics";
import { drawTrail, type Trail } from "./trail";
import { unitOutline, type UnitCollection, type UnitFeature, type World, type WorldMeshes } from "./world";

// -- The frame ---------------------------------------------------------------------------------------

/** A view given as a raw d3 rotation (a spin in progress: φ is unbounded) rather than a camera. */
export interface GlobeRotationView {
  readonly rotation: Rotation;
  /** Default 90: the whole globe. */
  readonly viewRadiusDeg?: number;
}

export type GlobeView = Camera | GlobeRotationView;

export interface GlobeDot {
  readonly id: string;
  readonly lng: number;
  readonly lat: number;
  /** The roulette's current pick: bigger, gold, glowing. */
  readonly lit?: boolean;
  /** The settled choice: calm green. */
  readonly chosen?: boolean;
  /** Drawn beside the dot (short: the place's name). */
  readonly label?: string;
}

export interface GlobeEmphasis {
  /** The roulette's current pick: filled bright with a glow. */
  readonly litUnit?: string | null;
  /** The settled pick: a calm accent fill. */
  readonly chosenUnit?: string | null;
  /** Units in the running roulette: outlined and drawn in full colour. */
  readonly candidateUnits?: readonly string[] | null;
  /** Mute every other unit. Default: true whenever a lit, chosen or candidate unit is given. */
  readonly muteOthers?: boolean;
}

export type GlobePin =
  | { readonly kind: "centre"; /** 0..1, how far the pin has fallen (default 1: resting). */ readonly drop?: number }
  | { readonly kind: "point"; readonly lng: number; readonly lat: number; readonly drop?: number };

export interface GlobeRipple {
  /** 0..1 */
  readonly progress: number;
  /** Where the rings spread from (default: the pin at the screen centre). */
  readonly at?: LngLat;
}

/** A dotted great-circle line growing from `from` toward `to`. */
export interface GlobeGlide {
  readonly from: LngLat;
  readonly to: LngLat;
  /** 0..1 */
  readonly progress: number;
}

export interface AvoidRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const NO_AVOID: readonly AvoidRect[] = [];

export interface GlobeFrame {
  readonly view: GlobeView;
  /** `auto` (default): coarse while the view radius is >= 60 degrees, else detail. */
  readonly level?: "auto" | "coarse" | "detail";
  readonly emphasis?: GlobeEmphasis | null;
  readonly dots?: readonly GlobeDot[] | null;
  readonly pin?: GlobePin | null;
  readonly ripple?: GlobeRipple | null;
  readonly glide?: GlobeGlide | null;
  readonly trail?: Trail | null;
  /** `prefers-reduced-motion`: no glow pulse, no pin bob, and the trail is not drawn. */
  readonly reducedMotion?: boolean;
  /**
   * Rectangles (CSS pixels, canvas coordinates) the page covers with its own overlays: the banner, a
   * button, a card. No dot label is drawn over one: it moves to a free spot beside its dot or is left out.
   */
  readonly avoid?: readonly AvoidRect[];
  /**
   * The view changes every frame (a spin, a camera flight): paint straight to the canvas with the cheap
   * coarse geometry whatever the zoom, and skip the still-map cache. Set it false the moment the view
   * rests and the renderer snaps to detail and caches the map.
   */
  readonly moving?: boolean;
}

export interface GlobeRenderer {
  /** Paints one frame. A no-op without a 2D context, after `destroy`, or before the first `resize`. */
  draw(frame: GlobeFrame, nowMs: number): void;
  /** Sets the CSS size (and the canvas's pixel size from `dpr`, clamped to 2). Clears the canvas. */
  resize(width: number, height: number, dpr: number): void;
  /** Screen position (CSS pixels) of a point in the LAST drawn frame, or null on the far side. */
  project(lng: number, lat: number): [number, number] | null;
  /** The point under a screen position (CSS pixels) in the last drawn frame, or null off the globe. */
  invert(x: number, y: number): LngLat | null;
  /** Which geometry the last frame used. */
  readonly lastLevel: "coarse" | "detail";
  /** Releases the context; further calls do nothing. */
  destroy(): void;
}

// -- Look --------------------------------------------------------------------------------------------

const MAX_DPR = 2;
/** Above this globe radius (pixels) a straight chord between vertices no longer follows the arc: use d3. */
const FAST_MAX_SCALE_PX = 1600;
const FONT = '"SF Pro Rounded", ui-rounded, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const COLOUR = {
  oceanHighlight: "#2f8fbf",
  oceanMid: "#17598a",
  oceanDeep: "#07213b",
  oceanZoomA: "#1d6f9e",
  oceanZoomB: "#124f7c",
  land: "#f4e8c6",
  landEdge: "rgba(143, 110, 62, 0.55)",
  coast: "rgba(122, 92, 50, 0.85)",
  mutedLand: "#4e6a7e",
  mutedEdge: "rgba(14, 34, 52, 0.45)",
  mutedCoast: "rgba(10, 28, 44, 0.65)",
  lit: "#ffc933",
  litGlow: "255, 201, 51",
  chosen: "#52dcae",
  chosenGlow: "82, 220, 174",
  candidateRing: "rgba(255, 255, 255, 0.92)",
  graticule: "rgba(255, 255, 255, 0.10)",
  graticuleOverLand: "rgba(120, 165, 215, 0.30)",
  pin: "#ff4d6a",
  pinDark: "#d92a4b",
} as const;

/** Cached graticule geometry. */
let graticuleChunks: readonly LineChunk[] | null = null;

/** The 10-degree graticule, cut into culling chunks once. */
function coarseGraticule(): readonly LineChunk[] {
  if (graticuleChunks === null) graticuleChunks = chunkLines(geoGraticule10());
  return graticuleChunks;
}

interface GraticuleCache {
  key: string;
  lines: MultiLineString;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// -- Culling -----------------------------------------------------------------------------------------
//
// d3 clips every vertex it is handed, so handing it the whole planet at a 5-degree zoom would cost the
// same as the spinning globe. Each geometry level is therefore indexed once: every unit gets a spherical
// cap (from its bounding box) and every border/coast line is cut into short chunks, each with its own
// cap. A frame hands d3 only the units and chunks whose cap reaches into the clip circle.

const RAD = Math.PI / 180;
/** A line chunk is at most this many points (consecutive chunks share their joining point). */
const CHUNK_POINTS = 40;

interface Cap {
  x: number;
  y: number;
  z: number;
  /** Radians. */
  r: number;
}

interface LineChunk extends Cap {
  readonly coordinates: number[][];
  /** The same points as unit vectors (long edges densified) for the fast path. */
  readonly vec: Float64Array;
}

interface LevelData {
  readonly features: readonly UnitFeature[];
  readonly caps: readonly Cap[];
  readonly borders: readonly LineChunk[];
  readonly coast: readonly LineChunk[];
  /** Scratch: which features are in view this frame. */
  readonly visible: Uint8Array;
  readonly scratchBorders: MultiLineString;
  readonly scratchCoast: MultiLineString;
  /** The unit shapes as flat vectors for the fast path. */
  readonly rings: FastRings;
}

function unitVector(lng: number, lat: number): [number, number, number] {
  const cosLat = Math.cos(lat * RAD);
  return [cosLat * Math.cos(lng * RAD), cosLat * Math.sin(lng * RAD), Math.sin(lat * RAD)];
}

function angleBetween(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

/** A cap around a bounding box (geoBounds order: `[[w, s], [e, n]]`; w > e wraps the antimeridian). */
function capOfBbox(bbox: readonly [LngLat, LngLat]): Cap {
  const [[w, s], [e, n]] = bbox;
  const east = e < w ? e + 360 : e;
  const midLng = (w + east) / 2;
  const midLat = (s + n) / 2;
  const [x, y, z] = unitVector(midLng, midLat);
  let r = 0;
  for (const lng of [w, midLng, east]) {
    for (const lat of [s, midLat, n]) r = Math.max(r, angleBetween([x, y, z], unitVector(lng, lat)));
  }
  // Great-circle edges bulge a little beyond the box's corners; the pad covers it.
  return { x, y, z, r: Math.min(Math.PI, r + 0.01) };
}

function capOfPoints(points: readonly number[][]): Cap {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  const vectors = points.map((p) => unitVector(p[0] as number, p[1] as number));
  for (const [x, y, z] of vectors) {
    sx += x;
    sy += y;
    sz += z;
  }
  const length = Math.hypot(sx, sy, sz);
  const first = vectors[0] as [number, number, number];
  const centre: [number, number, number] = length < 1e-9 ? first : [sx / length, sy / length, sz / length];
  let r = 0;
  for (const v of vectors) r = Math.max(r, angleBetween(centre, v));
  return { x: centre[0], y: centre[1], z: centre[2], r: length < 1e-9 ? Math.PI : Math.min(Math.PI, r + 1e-6) };
}

function chunkLines(lines: MultiLineString): LineChunk[] {
  const out: LineChunk[] = [];
  for (const line of lines.coordinates) {
    for (let from = 0; from < line.length - 1; from += CHUNK_POINTS - 1) {
      const coordinates = line.slice(from, Math.min(line.length, from + CHUNK_POINTS));
      if (coordinates.length < 2) continue;
      out.push({ coordinates, vec: vectorsOf(coordinates), ...capOfPoints(coordinates) });
    }
  }
  return out;
}

function buildLevel(world: World, collection: UnitCollection, meshes: WorldMeshes): LevelData {
  const features = collection.features as readonly UnitFeature[];
  const caps = features.map((f) => {
    const unit = world.units.get(f.id);
    return unit === undefined ? { x: 1, y: 0, z: 0, r: Math.PI } : capOfBbox(unit.bbox);
  });
  return {
    features,
    caps,
    borders: chunkLines(meshes.borders),
    coast: chunkLines(meshes.coast),
    visible: new Uint8Array(features.length),
    scratchBorders: { type: "MultiLineString", coordinates: [] },
    scratchCoast: { type: "MultiLineString", coordinates: [] },
    rings: buildFastRings(features),
  };
}

function inView(cap: Cap, centre: readonly [number, number, number], clipRad: number): boolean {
  if (cap.r >= Math.PI) return true;
  const angle = Math.acos(Math.max(-1, Math.min(1, cap.x * centre[0] + cap.y * centre[1] + cap.z * centre[2])));
  return angle - cap.r < clipRad;
}

function gather(chunks: readonly LineChunk[], centre: readonly [number, number, number], clipRad: number, out: MultiLineString): MultiLineString {
  out.coordinates.length = 0;
  for (const chunk of chunks) if (inView(chunk, centre, clipRad)) out.coordinates.push(chunk.coordinates);
  return out;
}

// -- The renderer ------------------------------------------------------------------------------------

export function createGlobeRenderer(canvas: HTMLCanvasElement, world: World): GlobeRenderer {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null; // very old or locked-down browser: draw() stays a no-op
  }
  let destroyed = false;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let lastLevel: "coarse" | "detail" = "coarse";
  let lastProjection: GeoProjection | null = null;
  let graticuleFine: GraticuleCache | null = null;
  let mapLayer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; key: string } | null = null;
  let mapLayerFailed = false;
  const scratchGrid: MultiLineString = { type: "MultiLineString", coordinates: [] };
  // Per-frame state of the fast path (see fastmap.ts): the rotation matrix, the globe centre and radius,
  // and whether the scale is small enough for straight chords to follow the great-circle arcs.
  const matrix = new Float64Array(9);
  let vcx = 0;
  let vcy = 0;
  let vscale = 1;
  let fastOn = false;

  /** The offscreen canvas the still map is painted into (null where a second canvas is unavailable). */
  function mapCache(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; key: string } | null {
    if (mapLayerFailed) return null;
    if (mapLayer === null) {
      const el = canvas.ownerDocument.createElement("canvas");
      el.width = canvas.width;
      el.height = canvas.height;
      const layerCtx = el.getContext("2d");
      if (layerCtx === null) {
        mapLayerFailed = true;
        return null;
      }
      mapLayer = { canvas: el, ctx: layerCtx, key: "" };
    }
    return mapLayer;
  }
  const levels: { coarse: LevelData | null; detail: LevelData | null } = { coarse: null, detail: null };

  function levelData(level: "coarse" | "detail"): LevelData {
    let data = levels[level];
    if (data === null) {
      data = level === "coarse" ? buildLevel(world, world.coarse, world.meshes.coarse) : buildLevel(world, world.detail, world.meshes.detail);
      levels[level] = data;
    }
    return data;
  }

  const projection = geoOrthographic().clipAngle(90).precision(0.6);
  const path: GeoPath = ctx === null ? geoPath(projection) : geoPath(projection, ctx);

  // The view-centre unit vector, reused each frame.
  const centreVec: [number, number, number] = [0, 0, 1];

  function setCentreVec(centre: LngLat): void {
    const lng = (centre[0] * Math.PI) / 180;
    const lat = (centre[1] * Math.PI) / 180;
    centreVec[0] = Math.cos(lat) * Math.cos(lng);
    centreVec[1] = Math.cos(lat) * Math.sin(lng);
    centreVec[2] = Math.sin(lat);
  }

  /** Dot product of the view-centre vector with a point: > 0 on the visible hemisphere. */
  function facing(lng: number, lat: number): number {
    const l = (lng * Math.PI) / 180;
    const p = (lat * Math.PI) / 180;
    const cp = Math.cos(p);
    return cp * Math.cos(l) * centreVec[0] + cp * Math.sin(l) * centreVec[1] + Math.sin(p) * centreVec[2];
  }

  function fineGraticule(centre: LngLat, viewRadiusDeg: number): MultiLineString | null {
    // Finer lines as the view tightens; built only for the area around the centre, cached by cell.
    const step = viewRadiusDeg >= 30 ? 0 : viewRadiusDeg >= 8 ? 5 : viewRadiusDeg >= 2 ? 1 : 0.25;
    if (step === 0) return null;
    const span = Math.min(180, viewRadiusDeg * 2.6);
    const cell = step * 4;
    const lng0 = Math.floor((centre[0] - span / Math.max(0.2, Math.cos((Math.min(80, Math.abs(centre[1])) * Math.PI) / 180))) / cell) * cell;
    const lng1 = Math.ceil((centre[0] + span / Math.max(0.2, Math.cos((Math.min(80, Math.abs(centre[1])) * Math.PI) / 180))) / cell) * cell;
    const lat0 = Math.max(-90, Math.floor((centre[1] - span) / cell) * cell);
    const lat1 = Math.min(90, Math.ceil((centre[1] + span) / cell) * cell);
    const key = `${step}|${lng0}|${lng1}|${lat0}|${lat1}`;
    if (graticuleFine !== null && graticuleFine.key === key) return graticuleFine.lines;
    const generated = geoGraticule()
      .extent([
        [Math.max(-180, lng0), lat0],
        [Math.min(180, lng1), lat1],
      ])
      .step([step, step])
      .precision(Math.max(0.05, step / 8))
      .lines();
    const lines: MultiLineString = { type: "MultiLineString", coordinates: generated.map((line) => line.coordinates) };
    graticuleFine = { key, lines };
    return lines;
  }

  function levelFor(frame: GlobeFrame, viewRadiusDeg: number): "coarse" | "detail" {
    if (frame.level === "coarse" || frame.level === "detail") return frame.level;
    return viewRadiusDeg >= DETAIL_BELOW_DEG || frame.moving === true ? "coarse" : "detail";
  }

  function unitShape(id: string, level: "coarse" | "detail"): UnitFeature | null {
    const unit = world.units.get(id);
    if (unit === undefined) return null;
    return level === "coarse" ? (unit.coarse ?? unit.detail) : unit.detail;
  }

  // -- Layers ---------------------------------------------------------------------------------------

  function drawOcean(c: CanvasRenderingContext2D, cx: number, cy: number, scale: number, limbVisible: boolean): void {
    if (limbVisible) {
      // Atmosphere halo just outside the limb.
      const halo = c.createRadialGradient(cx, cy, scale * 0.97, cx, cy, scale * 1.2);
      halo.addColorStop(0, "rgba(120, 196, 255, 0.40)");
      halo.addColorStop(0.45, "rgba(120, 196, 255, 0.12)");
      halo.addColorStop(1, "rgba(120, 196, 255, 0)");
      c.fillStyle = halo;
      c.beginPath();
      c.arc(cx, cy, scale * 1.2, 0, Math.PI * 2);
      c.fill();
      const sea = c.createRadialGradient(cx - scale * 0.35, cy - scale * 0.42, scale * 0.05, cx, cy, scale * 1.04);
      sea.addColorStop(0, COLOUR.oceanHighlight);
      sea.addColorStop(0.5, COLOUR.oceanMid);
      sea.addColorStop(1, COLOUR.oceanDeep);
      c.fillStyle = sea;
      c.beginPath();
      c.arc(cx, cy, scale, 0, Math.PI * 2);
      c.fill();
    } else {
      const sea = c.createLinearGradient(0, 0, cssW, cssH);
      sea.addColorStop(0, COLOUR.oceanZoomA);
      sea.addColorStop(1, COLOUR.oceanZoomB);
      c.fillStyle = sea;
      c.fillRect(0, 0, cssW, cssH);
    }
  }

  function strokeLines(c: CanvasRenderingContext2D, lines: MultiLineString, style: string, width: number): void {
    c.beginPath();
    path(lines);
    c.strokeStyle = style;
    c.lineWidth = width;
    c.stroke();
  }

  /** Strokes the line chunks in view: through the fast path where it applies, else through d3. */
  function strokeChunks(
    c: CanvasRenderingContext2D,
    chunks: readonly LineChunk[],
    clipRad: number,
    scratch: MultiLineString,
    style: string,
    width: number,
  ): void {
    if (!fastOn) {
      strokeLines(c, gather(chunks, centreVec, clipRad, scratch), style, width);
      return;
    }
    c.beginPath();
    for (const chunk of chunks) if (inView(chunk, centreVec, clipRad)) emitLine(c, chunk.vec, matrix, vcx, vcy, vscale);
    c.strokeStyle = style;
    c.lineWidth = width;
    c.stroke();
  }

  function fillShape(c: CanvasRenderingContext2D, shape: UnitFeature, style: string | CanvasGradient): void {
    c.beginPath();
    path(shape);
    c.fillStyle = style;
    c.fill();
  }

  function muteFor(emphasis: GlobeEmphasis | null): boolean {
    if (emphasis === null) return false;
    const hasCandidates = (emphasis.candidateUnits?.length ?? 0) > 0;
    return emphasis.muteOthers ?? (hasCandidates || (emphasis.litUnit ?? null) !== null || (emphasis.chosenUnit ?? null) !== null);
  }

  function drawLand(
    c: CanvasRenderingContext2D,
    level: "coarse" | "detail",
    data: LevelData,
    clipRad: number,
    emphasis: GlobeEmphasis | null,
  ): void {
    const candidates = emphasis?.candidateUnits ?? null;
    const hasCandidates = candidates !== null && candidates.length > 0;
    const chosen = emphasis?.chosenUnit ?? null;
    const mute = muteFor(emphasis);

    const edgeScale = level === "coarse" ? 0.8 : 1;
    // Everything in view in one fill: units wholly in front of the globe go through the fast path, units
    // across the horizon through d3 (which clips them properly), units behind it are skipped.
    c.beginPath();
    for (let i = 0; i < data.features.length; i += 1) {
      if (!inView(data.caps[i] as Cap, centreVec, clipRad)) continue;
      if (fastOn) {
        const where = classify(data.rings, i, matrix);
        if (where === HIDDEN) continue;
        if (where === FRONT) {
          emitFeature(c, data.rings, i, matrix, vcx, vcy, vscale);
          continue;
        }
      }
      path(data.features[i] as UnitFeature);
    }
    c.fillStyle = mute ? COLOUR.mutedLand : COLOUR.land;
    c.fill();

    // Emphasised units, full colour over the muted base.
    if (mute && hasCandidates) {
      for (const id of candidates) {
        const shape = unitShape(id, level);
        if (shape !== null) fillShape(c, shape, COLOUR.land);
      }
    }
    // Hairline borders, then coasts.
    strokeChunks(c, data.borders, clipRad, data.scratchBorders, mute ? COLOUR.mutedEdge : COLOUR.landEdge, 0.7 * edgeScale);
    strokeChunks(c, data.coast, clipRad, data.scratchCoast, mute ? COLOUR.mutedCoast : COLOUR.coast, 0.9 * edgeScale);

    if (hasCandidates) {
      for (const id of candidates) {
        const shape = unitShape(id, level);
        if (shape !== null) strokeLines(c, unitOutline(shape), COLOUR.candidateRing, 1.6);
      }
    }
    if (chosen !== null) {
      const shape = unitShape(chosen, level);
      if (shape !== null) {
        for (const [width, alpha] of [[10, 0.1], [6, 0.18], [3, 0.3]] as const) {
          strokeLines(c, unitOutline(shape), `rgba(${COLOUR.chosenGlow}, ${alpha})`, width);
        }
        fillShape(c, shape, COLOUR.chosen);
        strokeLines(c, unitOutline(shape), "rgba(255, 255, 255, 0.95)", 1.8);
      }
    }
  }

  /** The roulette's lit unit: the one thing in the land layer that changes while the camera is still. */
  function drawLit(c: CanvasRenderingContext2D, level: "coarse" | "detail", lit: string | null, nowMs: number, reduced: boolean): void {
    if (lit === null) return;
    const shape = unitShape(lit, level);
    if (shape === null) return;
    const pulse = reduced ? 0.75 : 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(nowMs / 90));
    const outline = unitOutline(shape);
    for (const [width, alpha] of [[16, 0.08], [10, 0.16], [5, 0.3]] as const) {
      strokeLines(c, outline, `rgba(${COLOUR.litGlow}, ${(alpha * pulse).toFixed(3)})`, width);
    }
    fillShape(c, shape, COLOUR.lit);
    strokeLines(c, outline, "rgba(255, 255, 255, 0.95)", 2);
  }

  function drawShading(c: CanvasRenderingContext2D, cx: number, cy: number, scale: number): void {
    const shade = c.createRadialGradient(cx - scale * 0.32, cy - scale * 0.38, scale * 0.15, cx, cy, scale);
    shade.addColorStop(0, "rgba(255, 255, 255, 0.10)");
    shade.addColorStop(0.55, "rgba(255, 255, 255, 0)");
    shade.addColorStop(0.86, "rgba(4, 16, 36, 0.20)");
    shade.addColorStop(1, "rgba(2, 10, 26, 0.55)");
    c.fillStyle = shade;
    c.beginPath();
    c.arc(cx, cy, scale, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(170, 220, 255, 0.35)";
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(cx, cy, scale - 0.6, 0, Math.PI * 2);
    c.stroke();
  }

  function drawGlide(c: CanvasRenderingContext2D, glide: GlobeGlide): void {
    const progress = Math.max(0, Math.min(1, glide.progress));
    if (progress <= 0) return;
    const interpolate = geoInterpolate(glide.from as [number, number], glide.to as [number, number]);
    const steps = 40;
    const coordinates: Array<[number, number]> = [];
    const eased = easeOutCubic(progress);
    const last = Math.max(1, Math.ceil(steps * eased));
    for (let i = 0; i <= last; i += 1) coordinates.push(interpolate(Math.min(eased, i / steps)));
    c.save();
    c.lineCap = "round";
    c.setLineDash([0.1, 7]);
    c.shadowColor = "rgba(0, 20, 40, 0.5)";
    c.shadowBlur = 4 * dpr;
    strokeLines(c, { type: "MultiLineString", coordinates: [coordinates] }, "rgba(255, 255, 255, 0.95)", 3.4);
    c.restore();
    // Where the globe came to rest: a ring the dotted line leaves from.
    const origin = projection(glide.from as [number, number]);
    if (origin !== null && facing(glide.from[0], glide.from[1]) > 0) {
      c.beginPath();
      c.arc(origin[0], origin[1], 6, 0, Math.PI * 2);
      c.lineWidth = 2;
      c.strokeStyle = "rgba(255, 255, 255, 0.9)";
      c.stroke();
    }
    const head = projection(interpolate(eased));
    const [lng, lat] = interpolate(eased);
    if (head !== null && facing(lng, lat) > 0) {
      c.beginPath();
      c.arc(head[0], head[1], 5, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.shadowColor = "rgba(0, 20, 40, 0.5)";
      c.shadowBlur = 5 * dpr;
      c.fill();
      c.shadowBlur = 0;
    }
  }

  function drawRipple(c: CanvasRenderingContext2D, x: number, y: number, progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    if (p <= 0 || p >= 1) return;
    const maxR = 0.2 * Math.min(cssW, cssH);
    c.save();
    for (let k = 0; k < 3; k += 1) {
      const q = p - k * 0.16;
      if (q <= 0 || q >= 1) continue;
      const r = maxR * easeOutCubic(q);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255, 255, 255, ${(0.85 * (1 - q) ** 1.4).toFixed(3)})`;
      c.lineWidth = 1 + 3 * (1 - q);
      c.stroke();
    }
    const flash = c.createRadialGradient(x, y, 0, x, y, maxR * 0.5);
    flash.addColorStop(0, `rgba(255, 255, 255, ${(0.5 * (1 - p) ** 2).toFixed(3)})`);
    flash.addColorStop(1, "rgba(255, 255, 255, 0)");
    c.fillStyle = flash;
    c.beginPath();
    c.arc(x, y, maxR * 0.5, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function drawDot(c: CanvasRenderingContext2D, x: number, y: number, dot: GlobeDot, alpha: number, nowMs: number, reduced: boolean): void {
    const isLit = dot.lit === true;
    const isChosen = dot.chosen === true;
    const glow = isLit ? COLOUR.litGlow : isChosen ? COLOUR.chosenGlow : "255, 255, 255";
    const radius = isLit ? 7.5 : isChosen ? 8 : 5;
    const pulse = isLit && !reduced ? 1 + 0.18 * Math.sin(nowMs / 90) : 1;
    const haloR = radius * (isLit ? 4.2 : 3) * pulse;
    const halo = c.createRadialGradient(x, y, radius * 0.4, x, y, haloR);
    halo.addColorStop(0, `rgba(${glow}, ${((isLit || isChosen ? 0.65 : 0.35) * alpha).toFixed(3)})`);
    halo.addColorStop(1, `rgba(${glow}, 0)`);
    c.fillStyle = halo;
    c.beginPath();
    c.arc(x, y, haloR, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = alpha;
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fillStyle = isLit ? COLOUR.lit : isChosen ? COLOUR.chosen : COLOUR.pin;
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = "#ffffff";
    c.stroke();
    c.globalAlpha = 1;
  }

  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  function overlaps(a: Box, b: Box): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function drawDotLabels(
    c: CanvasRenderingContext2D,
    placed: Array<{ dot: GlobeDot; x: number; y: number; alpha: number }>,
    avoid: readonly AvoidRect[],
  ): void {
    // Boxes already taken: the page's own overlays (banner, buttons) first, then each label as it is placed.
    const boxes: Box[] = avoid.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    // Lit and chosen first so they get the best spot.
    const order = placed.slice().sort((a, b) => weight(b.dot) - weight(a.dot));
    for (const { dot, x, y, alpha } of order) {
      if (dot.label === undefined || dot.label === "") continue;
      const strong = dot.lit === true || dot.chosen === true;
      c.font = `${strong ? 700 : 600} ${strong ? 15 : 13}px ${FONT}`;
      const w = c.measureText(dot.label).width + 4;
      const h = strong ? 20 : 17;
      const gap = (strong ? 11 : 8) + 2;
      const spots: Array<[number, number]> = [
        [x + gap, y - h / 2],
        [x - gap - w, y - h / 2],
        [x - w / 2, y - gap - h],
        [x - w / 2, y + gap],
        [x + gap, y - h - 2],
        [x + gap, y + 2],
        [x - gap - w, y - h - 2],
        [x - gap - w, y + 2],
      ];
      let chosen: Box | null = null;
      for (const [bx, by] of spots) {
        const box: Box = { x: bx, y: by, w, h };
        const inside = box.x >= 2 && box.y >= 2 && box.x + box.w <= cssW - 2 && box.y + box.h <= cssH - 2;
        if (inside && !boxes.some((other) => overlaps(box, other))) {
          chosen = box;
          break;
        }
      }
      // No free spot: the label is left out (a dot without a name beats text over a button or banner).
      if (chosen === null) continue;
      boxes.push(chosen);
      c.globalAlpha = alpha;
      c.textBaseline = "middle";
      c.textAlign = "left";
      c.lineJoin = "round";
      c.lineWidth = 4;
      c.strokeStyle = "rgba(4, 20, 40, 0.85)";
      c.strokeText(dot.label, chosen.x + 2, chosen.y + h / 2 + 0.5);
      c.fillStyle = strong ? "#ffffff" : "rgba(255, 255, 255, 0.96)";
      c.fillText(dot.label, chosen.x + 2, chosen.y + h / 2 + 0.5);
      c.globalAlpha = 1;
    }
  }

  function weight(dot: GlobeDot): number {
    return dot.lit === true ? 2 : dot.chosen === true ? 1 : 0;
  }

  function drawPin(c: CanvasRenderingContext2D, x: number, y: number, drop: number, nowMs: number, reduced: boolean): void {
    const s = Math.max(0.8, Math.min(1.35, Math.min(cssW, cssH) / 360));
    const d = Math.max(0, Math.min(1, drop));
    // Falls from above and settles with one small bounce.
    const fall = d >= 1 ? 0 : -(1 - easeOutCubic(d)) * 90 * s;
    const bounce = d >= 1 || d < 0.6 ? 0 : -Math.sin(((d - 0.6) / 0.4) * Math.PI) * 5 * s;
    const bob = reduced || d < 1 ? 0 : Math.sin(nowMs / 520) * 1.4 * s;
    const ty = y + fall + bounce + bob;
    // Shadow on the ground at the tip.
    c.save();
    c.fillStyle = `rgba(0, 12, 30, ${(0.35 * d).toFixed(3)})`;
    c.beginPath();
    c.ellipse(x, y + 1, 7 * s * (0.5 + 0.5 * d), 2.6 * s * (0.5 + 0.5 * d), 0, 0, Math.PI * 2);
    c.fill();
    c.translate(x, ty);
    c.scale(s, s);
    // Teardrop: tip at the origin.
    const headY = -27;
    const r = 12;
    c.beginPath();
    c.moveTo(0, 0);
    c.bezierCurveTo(-4, -7, -r, -14, -r, headY);
    c.arc(0, headY, r, Math.PI, 0, false);
    c.bezierCurveTo(r, -14, 4, -7, 0, 0);
    c.closePath();
    const body = c.createLinearGradient(-r, headY - r, r, 0);
    body.addColorStop(0, "#ff7a8f");
    body.addColorStop(0.5, COLOUR.pin);
    body.addColorStop(1, COLOUR.pinDark);
    c.shadowColor = "rgba(0, 12, 30, 0.45)";
    c.shadowBlur = 6 * dpr;
    c.shadowOffsetY = 2 * dpr;
    c.fillStyle = body;
    c.fill();
    c.shadowColor = "transparent";
    c.lineWidth = 1.6;
    c.strokeStyle = "rgba(255, 255, 255, 0.9)";
    c.stroke();
    c.beginPath();
    c.arc(0, headY, 4.8, 0, Math.PI * 2);
    c.fillStyle = "#ffffff";
    c.fill();
    c.restore();
  }

  // -- draw -----------------------------------------------------------------------------------------

  function draw(frame: GlobeFrame, nowMs: number): void {
    const c = ctx;
    if (destroyed || c === null || cssW <= 0 || cssH <= 0) return;
    const reduced = frame.reducedMotion === true;
    const view = frame.view;
    let rotation: [number, number, number];
    let centre: LngLat;
    let viewRadius: number;
    if ("rotation" in view) {
      rotation = [view.rotation[0], view.rotation[1], view.rotation[2] ?? 0];
      centre = centreOfRotation(view.rotation);
      viewRadius = clampViewRadius(view.viewRadiusDeg ?? MAX_VIEW_RADIUS_DEG);
    } else {
      rotation = cameraRotation(view);
      centre = view.centre;
      viewRadius = clampViewRadius(view.viewRadiusDeg);
    }
    const scale = scaleFor(viewRadius, cssW, cssH);
    const cx = cssW / 2;
    const cy = cssH / 2;
    const halfDiagonal = Math.hypot(cssW, cssH) / 2;
    const limbVisible = scale < halfDiagonal;
    // Clip to just beyond the corners of the canvas (a hemisphere when the whole globe shows).
    const clipDeg = limbVisible ? 90 : Math.min(90, (Math.asin(Math.min(1, halfDiagonal / scale)) * 180) / Math.PI + 2);
    projection.rotate(rotation).scale(scale).translate([cx, cy]).clipAngle(clipDeg).precision(frame.moving === true ? 2 : 0.6);
    lastProjection = projection;
    setCentreVec(centre);
    rotationMatrix(rotation, matrix);
    vcx = cx;
    vcy = cy;
    vscale = scale;
    fastOn = scale <= FAST_MAX_SCALE_PX;

    const level = levelFor(frame, viewRadius);
    lastLevel = level;
    const data = levelData(level);
    const emphasis = frame.emphasis ?? null;

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);
    c.lineJoin = "round";
    c.lineCap = "round";

    // The map itself (ocean, graticule, land, borders, shading) only changes when the view or the set of
    // emphasised units does. While the camera rests — the whole roulette — it is painted once into an
    // offscreen canvas and blitted, so a flickering lit unit costs one drawImage plus its own outline.
    const clipRad = (clipDeg * Math.PI) / 180;
    const paintMap = (target: CanvasRenderingContext2D): void => {
      drawOcean(target, cx, cy, scale, limbVisible);
      // Graticule: under the land while the whole globe shows; over it once zoomed in, where it is the
      // only thing that tells a pan or a zoom apart on a big flat country.
      const fineGrid = fineGraticule(centre, viewRadius);
      const drawGrid = (style: string, width: number): void => {
        if (fineGrid !== null) strokeLines(target, fineGrid, style, width);
        else strokeChunks(target, coarseGraticule(), clipRad, scratchGrid, style, width);
      };
      if (limbVisible) drawGrid(COLOUR.graticule, 0.6);
      drawLand(target, level, data, clipRad, emphasis);
      if (!limbVisible) drawGrid(COLOUR.graticuleOverLand, 0.7);
      if (limbVisible) drawShading(target, cx, cy, scale);
    };
    const cache = frame.moving === true ? null : mapCache();
    if (cache === null) {
      paintMap(c);
    } else {
      const key = `${rotation[0]}|${rotation[1]}|${rotation[2]}|${scale}|${level}|${dpr}|${muteFor(emphasis)}|${emphasis?.candidateUnits?.join(",") ?? ""}|${emphasis?.chosenUnit ?? ""}`;
      if (key !== cache.key) {
        cache.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        cache.ctx.clearRect(0, 0, cssW, cssH);
        cache.ctx.lineJoin = "round";
        cache.ctx.lineCap = "round";
        path.context(cache.ctx);
        paintMap(cache.ctx);
        path.context(c);
        cache.key = key;
      }
      c.drawImage(cache.canvas, 0, 0, cssW, cssH);
    }
    drawLit(c, level, emphasis?.litUnit ?? null, nowMs, reduced);

    if (frame.glide !== undefined && frame.glide !== null) drawGlide(c, frame.glide);

    // Ripple and pin sit at the pin's tip.
    const ripple = frame.ripple;
    if (ripple !== undefined && ripple !== null) {
      if (ripple.at === undefined) drawRipple(c, cx, cy, ripple.progress);
      else {
        const p = projection(ripple.at as [number, number]);
        if (p !== null && facing(ripple.at[0], ripple.at[1]) > 0) drawRipple(c, p[0], p[1], ripple.progress);
      }
    }

    // Dots.
    const dots = frame.dots;
    if (dots !== undefined && dots !== null && dots.length > 0) {
      const placed: Array<{ dot: GlobeDot; x: number; y: number; alpha: number }> = [];
      for (const dot of dots) {
        const f = facing(dot.lng, dot.lat);
        if (f <= 0.02) continue;
        const p = projection([dot.lng, dot.lat]);
        if (p === null) continue;
        const alpha = smoothstep(0.02, 0.22, f);
        // Unlit dots first so the lit one is on top.
        placed.push({ dot, x: p[0], y: p[1], alpha });
      }
      placed.sort((a, b) => weight(a.dot) - weight(b.dot));
      for (const { dot, x, y, alpha } of placed) drawDot(c, x, y, dot, alpha, nowMs, reduced);
      drawDotLabels(c, placed, frame.avoid ?? NO_AVOID);
    }

    // Pin.
    const pin = frame.pin;
    if (pin !== undefined && pin !== null) {
      if (pin.kind === "centre") drawPin(c, cx, cy, pin.drop ?? 1, nowMs, reduced);
      else if (facing(pin.lng, pin.lat) > 0) {
        const p = projection([pin.lng, pin.lat]);
        if (p !== null) drawPin(c, p[0], p[1], pin.drop ?? 1, nowMs, reduced);
      }
    }

    // Swipe trail on top of everything.
    if (frame.trail !== undefined && frame.trail !== null) {
      drawTrail(c, frame.trail, { cx, cy, radiusPx: scale, nowMs, reducedMotion: reduced, dpr });
    }
  }

  return {
    draw,
    resize(width, height, ratio) {
      if (destroyed) return;
      cssW = Math.max(0, Math.floor(width));
      cssH = Math.max(0, Math.floor(height));
      dpr = Math.max(1, Math.min(MAX_DPR, Number.isFinite(ratio) ? ratio : 1));
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      graticuleFine = null;
      mapLayer = null;
    },
    project(lng, lat) {
      if (lastProjection === null || facing(lng, lat) <= 0) return null;
      const p = lastProjection([lng, lat]);
      return p === null ? null : [p[0], p[1]];
    },
    invert(x, y) {
      if (lastProjection === null || lastProjection.invert === undefined) return null;
      const p = lastProjection.invert([x, y]);
      return p === null || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ? null : [p[0], p[1]];
    },
    get lastLevel() {
      return lastLevel;
    },
    destroy() {
      destroyed = true;
      ctx = null;
      lastProjection = null;
      graticuleFine = null;
      mapLayer = null;
    },
  };
}
