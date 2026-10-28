#!/usr/bin/env node
/**
 * Adventure Time - world map build (spec/server-chat/08-adventure-time.md section 2.1).
 *
 * Builds `admin-ui/data/adventure-world.json` (ONE TopoJSON with TWO objects sharing ids,
 * `detail` and `coarse`, plus a top-level `centres` table) and `tooling/adventure/units.json`
 * (id / name / sovereign / subregion for the 256 map units) from Natural Earth 1:50m vectors.
 *
 * SOURCE (pinned, immutable):
 *   repo    https://github.com/nvkelso/natural-earth-vector
 *   commit  ca96624a56bd078437bca8184e78163e5039ad19
 *           (tip of `master` when looked up on 2026-10-27; the commit itself is dated 2022-06-02,
 *            "marine for both #697 and #735")
 *   files   geojson/ne_50m_admin_0_countries.geojson
 *           geojson/ne_50m_admin_0_map_units.geojson
 *   licence Natural Earth is public domain (https://www.naturalearthdata.com/about/terms-of-use/).
 *   Each file's SHA-256 is pinned below and verified on every run, so a corrupt cache or a
 *   tampered download fails loudly instead of silently changing the map.
 *
 * Usage (from this directory, after `npm ci`):
 *   node build_world.mjs            write admin-ui/data/adventure-world.json + units.json
 *   node build_world.mjs --check    rebuild in memory and fail if the committed files differ
 *
 * The output is deterministic: no timestamps, stable key order, no randomness, so a re-run
 * produces identical bytes. Downloads are cached under the OS temp folder
 * (`<tmp>/wixy-adventure-ne/<commit>/`), never in the repo.
 *
 * Pipeline: GeoJSON units -> d3 winding (exterior clockwise) -> topojson-server `topology`
 * (quantized, shared borders become shared arcs) -> topojson-simplify `presimplify` with
 * SPHERICAL triangle-area weights -> per level (`detail`, `coarse`): drop points under the
 * level's minimum weight while keeping polygons alive (`coarse`: each unit's largest polygon;
 * `detail`: EVERY Natural Earth polygon, so no island the validator measures against vanishes),
 * drop degenerate rings, garbage-collect arcs -> merge both levels into one arc table (identical
 * arcs shared) -> polylabel part centres (one per `detail` polygon, in feature() order).
 *
 * Antarctica: its coast is one ring running -180..+180, closed along the pole line. Points on the
 * antimeridian or at a pole have zero spherical area, so Visvalingam would delete them and leave
 * a short edge across the antimeridian near the pole (a valid SPHERICAL ring for d3-geo, but not
 * a valid planar lng/lat polygon). They are therefore always kept, so the ring stays exactly as
 * Natural Earth draws it and planar consumers still see an ordinary polygon.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import polylabel from "polylabel";
import { feature } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, sphericalTriangleArea } from "topojson-simplify";

// ---------------------------------------------------------------------------------------------
// Pinned source
// ---------------------------------------------------------------------------------------------

export const NE_SHA = "ca96624a56bd078437bca8184e78163e5039ad19";
export const NE_RAW = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_SHA}/geojson`;
export const SOURCES = {
  ne_50m_admin_0_countries: "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
  ne_50m_admin_0_map_units: "b8d421aca6e9e08e8cdf09cc26af111cc3e0deba4fe915611d58ade71e8a4db0",
};

/** Countries replaced by their `map_units` pieces (spec 2.1). */
export const SPLIT_PARENTS = new Set(["FRA", "PRT", "NOR", "NLD", "TZA", "GBR"]);
/** The unit ids those pieces must produce (`GU_A3`); verified, not assumed. */
export const SPLIT_UNIT_IDS = [
  "FXX", "MTQ", "GLP", "GUF", "REU", "MYT", "PRX", "PMD", "PAZ", "NOR",
  "NSV", "NJM", "NLD", "NLY", "TZA", "TZZ", "ENG", "SCT", "WLS", "NIR",
];
export const EXPECTED_UNIT_COUNT = 256;

// ---------------------------------------------------------------------------------------------
// Tunables (every number that shapes the output lives here)
// ---------------------------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0088;
/** Convert a triangle area in km^2 to the steradian weights `sphericalTriangleArea` produces. */
const km2ToWeight = (km2) => km2 / (EARTH_RADIUS_KM * EARTH_RADIUS_KM);

export const CONFIG = {
  /** Grid resolution of the shared TopoJSON transform (steps across the whole bbox). */
  quantization: 1e5,
  /**
   * Visvalingam minimum effective triangle area per level, tuned against the byte budget by
   * rendering Greece and Norway at a 5 degree view radius (~2.7 km per pixel on a phone).
   * `detail` (25 km^2) keeps the Aegean islands and the Norwegian fjord mouths; going to
   * 40 km^2 starts merging islets, going to 15 km^2 costs +90 KB for nothing visible.
   * `coarse` (800 km^2) is for the fast-spinning globe, where a pixel is 30-45 km.
   * `minKeep` is the number of distinct vertices a unit's largest polygon is guaranteed to keep
   * at that level (micro-states: Vatican City, Monaco, Nauru, Tuvalu...). `minKeepPart` does the
   * same for EVERY other polygon of the unit (0 = no promise): `detail` keeps all of Natural
   * Earth's 1,6xx parts (each costs ~60 bytes), because the destination validator measures
   * against `detail` and a Maldivian atoll or a Greek islet that vanished from it would make a
   * real resort fail validation. `coarse` only ever needs the unit's main body.
   */
  detail: { minAreaKm2: 25, minKeep: 8, minKeepPart: 4 },
  coarse: { minAreaKm2: 800, minKeep: 4, minKeepPart: 0 },
  /** Polylabel precision, in degrees of arc on the part's own equirectangular plane. */
  centrePrecisionDeg: 0.05,
  /** Hard budgets (spec 2.1 / task brief). Exceeding any of them fails the build. */
  budget: { totalBytes: 600 * 1000, coarseVertices: 12000 },
};

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const OUT_WORLD = path.join(REPO, "admin-ui", "data", "adventure-world.json");
export const OUT_UNITS = path.join(HERE, "units.json");

// ---------------------------------------------------------------------------------------------
// Download (cached under the OS temp folder, hash-verified)
// ---------------------------------------------------------------------------------------------

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function loadSource(name) {
  const expected = SOURCES[name];
  const dir = path.join(os.tmpdir(), "wixy-adventure-ne", NE_SHA);
  const file = path.join(dir, `${name}.geojson`);
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file);
    if (sha256(cached) === expected) return cached;
    console.warn(`cache ${file} fails its SHA-256 check; re-downloading`);
    fs.rmSync(file);
  }
  const url = `${NE_RAW}/${name}.geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) {
    throw new Error(`${url}: SHA-256 ${got} does not match the pinned ${expected}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return buf;
}

// ---------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Planar signed area of a ring in lng/lat (y up): > 0 anticlockwise, < 0 clockwise. */
function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

/**
 * d3-geo winding: exterior rings clockwise, holes anticlockwise (in lng/lat with y up).
 * Natural Earth already follows it; this is a safety net that also counts what it flipped.
 */
function rewindPolygon(rings, stats) {
  return rings.map((ring, i) => {
    const a = signedArea(ring);
    const wantClockwise = i === 0;
    if (a === 0 || (a < 0) === wantClockwise) return ring;
    stats.flipped++;
    return ring.slice().reverse();
  });
}

function rewindGeometry(geometry, stats) {
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: rewindPolygon(geometry.coordinates, stats) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((p) => rewindPolygon(p, stats)),
    };
  }
  throw new Error(`unexpected geometry type ${geometry.type}`);
}

/** Reject a ring that jumps across the antimeridian (Natural Earth splits there instead). */
function assertNoAntimeridianJump(id, geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x0, y0] = ring[i - 1];
        const [x1, y1] = ring[i];
        const alongPole = Math.abs(y0) === 90 && y0 === y1; // Antarctica's closing edge
        if (Math.abs(x1 - x0) > 180 && !alongPole) {
          throw new Error(`${id}: ring jumps ${x0} -> ${x1} across the antimeridian`);
        }
      }
    }
  }
}

export function buildUnits(countries, mapUnits) {
  const units = [];
  const seen = new Set();
  const add = (f, id) => {
    if (typeof id !== "string" || !/^[A-Z0-9]{3}$/.test(id)) {
      throw new Error(`bad unit id ${JSON.stringify(id)} (${f.properties.NAME_LONG})`);
    }
    if (seen.has(id)) throw new Error(`duplicate unit id ${id}`);
    seen.add(id);
    units.push({
      id,
      name: String(f.properties.NAME_LONG),
      sovereign: String(f.properties.SOVEREIGNT),
      subregion: String(f.properties.SUBREGION),
      geometry: f.geometry,
    });
  };
  for (const f of countries.features) {
    if (!SPLIT_PARENTS.has(f.properties.ADM0_A3)) add(f, f.properties.ADM0_A3);
  }
  const pieces = mapUnits.features.filter((f) => SPLIT_PARENTS.has(f.properties.ADM0_A3));
  for (const f of pieces) add(f, f.properties.GU_A3);

  const pieceIds = pieces.map((f) => f.properties.GU_A3).sort(cmp);
  const wantPieces = SPLIT_UNIT_IDS.slice().sort(cmp);
  if (JSON.stringify(pieceIds) !== JSON.stringify(wantPieces)) {
    throw new Error(`split pieces ${pieceIds.join(",")} differ from the spec's ${wantPieces.join(",")}`);
  }
  if (units.length !== EXPECTED_UNIT_COUNT) {
    throw new Error(`expected ${EXPECTED_UNIT_COUNT} units, built ${units.length}`);
  }
  units.sort((a, b) => cmp(a.id, b.id));
  return units;
}

// ---------------------------------------------------------------------------------------------
// Topology + simplification
// ---------------------------------------------------------------------------------------------

/** Decode presimplified (absolute lng/lat + weight) arcs back onto the integer grid. */
function decodeToGrid(pre, transform) {
  const [kx, ky] = transform.scale;
  const [tx, ty] = transform.translate;
  return pre.arcs.map((arc) => {
    const n = arc.length;
    const x = new Int32Array(n);
    const y = new Int32Array(n);
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = Math.round((arc[i][0] - tx) / kx);
      y[i] = Math.round((arc[i][1] - ty) / ky);
      w[i] = arc[i][2];
    }
    return { x, y, w };
  });
}

/** Visit the ring-reference lists (arrays of arc indices) of a Polygon/MultiPolygon geometry. */
function polygonsOf(geometry) {
  return geometry.type === "Polygon" ? [geometry.arcs] : geometry.arcs;
}

/**
 * The points of a ring as (arc, index) references in ring order, joints de-duplicated. A negative
 * arc reference walks its arc backwards.
 */
function ringRefs(base, refs) {
  const out = [];
  refs.forEach((ref, r) => {
    const a = ref < 0 ? ~ref : ref;
    const n = base[a].x.length;
    for (let k = r === 0 ? 0 : 1; k < n; k++) out.push([a, ref < 0 ? n - 1 - k : k]);
  });
  return out;
}

const ringArea = (xs, ys) => {
  let s = 0;
  for (let i = 0, n = xs.length - 1; i < n; i++) s += xs[i] * ys[i + 1] - xs[i + 1] * ys[i];
  return s / 2;
};

/** Is the ring (as grid points, closed) a real polygon: >= 3 distinct vertices and non-zero area? */
function ringIsReal(xs, ys) {
  if (xs.length < 4) return false;
  const distinct = new Set();
  for (let i = 0; i < xs.length - 1; i++) distinct.add(xs[i] * 4194304 + ys[i]);
  return distinct.size >= 3 && ringArea(xs, ys) !== 0;
}

/**
 * Make sure a unit's polygons survive the level's threshold: the largest keeps at least
 * `minKeep` distinct vertices and, when `minKeepPart` > 0, so does every other part (more if the
 * survivors are collinear), by promoting the highest-weight points the threshold would have
 * removed. The largest-part rule keeps Vatican City, Monaco, Nauru, Tuvalu... alive; the
 * every-part rule keeps each island Natural Earth draws (an atoll, a Greek islet) in the map the
 * destination validator measures against.
 */
function protectParts(base, W, geometry, minWeight, { minKeep, minKeepPart }) {
  const parts = polygonsOf(geometry).map((rings) => {
    const refs = ringRefs(base, rings[0]);
    const xs = refs.map(([a, k]) => base[a].x[k]);
    const ys = refs.map(([a, k]) => base[a].y[k]);
    return { area: Math.abs(ringArea(xs, ys)), refs };
  });
  let largest = parts[0];
  for (const p of parts) if (p.area > largest.area) largest = p;
  let promoted = protectRing(base, W, largest.refs, minWeight, minKeep);
  if (minKeepPart > 0) {
    for (const p of parts) if (p !== largest) promoted += protectRing(base, W, p.refs, minWeight, minKeepPart);
  }
  return promoted;
}

/** Do the segments (a, b) and (c, d) touch or cross? (exact: grid coordinates are integers) */
function segmentsMeet(ax, ay, bx, by, cx, cy, dx, dy) {
  const orient = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const within = (px, py, qx, qy, rx, ry) =>
    Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && within(ax, ay, bx, by, cx, cy)) ||
    (o2 === 0 && within(ax, ay, bx, by, dx, dy)) ||
    (o3 === 0 && within(cx, cy, dx, dy, ax, ay)) ||
    (o4 === 0 && within(cx, cy, dx, dy, bx, by))
  );
}

/** Is a closed ring of grid points free of self-touching and self-crossing? (O(n^2): small rings.) */
function ringIsSimple(xs, ys) {
  const n = xs.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // first and last edges are neighbours
      if (segmentsMeet(xs[i], ys[i], xs[i + 1], ys[i + 1], xs[j], ys[j], xs[j + 1], ys[j + 1])) return false;
    }
  }
  return true;
}

/** Rings longer than this are Visvalingam-simplified well enough that the O(n^2) check is skipped. */
const SIMPLE_CHECK_MAX_POINTS = 200;

/**
 * Promote enough of one ring's highest-weight points that its survivors form a real polygon with
 * at least `minKeep` distinct vertices, the same winding as the full ring and (for the small
 * rings this matters for) no self-crossing: a thin island such as the Chandeleur Islands can
 * otherwise collapse into a bow-tie whose winding is reversed.
 */
function protectRing(base, W, refs, minWeight, minKeep) {
  const key = ([a, k]) => base[a].x[k] * 4194304 + base[a].y[k];
  const fullSign = Math.sign(
    ringArea(
      refs.map(([a, k]) => base[a].x[k]),
      refs.map(([a, k]) => base[a].y[k]),
    ),
  );
  const acceptable = () => {
    const pts = refs.filter(([a, k]) => W[a][k] >= minWeight);
    if (pts.length < 4) return false;
    const xs = pts.map(([a, k]) => base[a].x[k]);
    const ys = pts.map(([a, k]) => base[a].y[k]);
    if (new Set(pts.map(key)).size < minKeep || !ringIsReal(xs, ys)) return false;
    if (Math.sign(ringArea(xs, ys)) !== fullSign) return false;
    return pts.length > SIMPLE_CHECK_MAX_POINTS || ringIsSimple(xs, ys);
  };
  if (acceptable()) return 0;
  const dropped = refs
    .map((ref, order) => ({ ref, order, w: W[ref[0]][ref[1]] }))
    .filter((e) => e.w < minWeight)
    .sort((p, q) => q.w - p.w || p.order - q.order);
  let promoted = 0;
  for (const e of dropped) {
    const [a, k] = e.ref;
    if (W[a][k] >= minWeight) continue; // already promoted through a shared arc
    W[a][k] = Infinity;
    promoted++;
    if (acceptable()) break;
  }
  return promoted;
}

/**
 * Build one detail level over a shared presimplified arc table. `isSeam(x)` marks grid columns on
 * the antimeridian: those points (and the pole line between them) have zero spherical area, so
 * Visvalingam would delete them, yet they are what keeps Antarctica a valid planar ring (coast +
 * pole line). They always stay.
 */
export function buildLevel(base, geometries, { minAreaKm2, minKeep, minKeepPart }, isSeam) {
  const minWeight = km2ToWeight(minAreaKm2);
  const W = base.map((a) => Float64Array.from(a.w));
  base.forEach((a, i) => {
    for (let k = 0; k < a.x.length; k++) if (isSeam(a.x[k])) W[i][k] = Infinity;
  });
  let promoted = 0;
  for (const g of geometries) {
    promoted += protectParts(base, W, g, minWeight, { minKeep, minKeepPart });
  }

  // Surviving points of every arc, as grid coordinates.
  const kept = base.map((a, i) => {
    const xs = [];
    const ys = [];
    for (let k = 0; k < a.x.length; k++) {
      if (W[i][k] >= minWeight) {
        xs.push(a.x[k]);
        ys.push(a.y[k]);
      }
    }
    return { x: xs, y: ys };
  });

  const ringPoints = (refs) => {
    const xs = [];
    const ys = [];
    refs.forEach((ref, r) => {
      const a = kept[ref < 0 ? ~ref : ref];
      const n = a.x.length;
      for (let k = r === 0 ? 0 : 1; k < n; k++) {
        const j = ref < 0 ? n - 1 - k : k;
        xs.push(a.x[j]);
        ys.push(a.y[j]);
      }
    });
    return { xs, ys };
  };

  let droppedRings = 0;
  const outGeoms = geometries.map((g) => {
    const polys = [];
    for (const rings of polygonsOf(g)) {
      const outRings = [];
      for (let i = 0; i < rings.length; i++) {
        const { xs, ys } = ringPoints(rings[i]);
        if (ringIsReal(xs, ys)) outRings.push(rings[i]);
        else if (i === 0) break; // exterior is degenerate: the whole polygon goes (holes with it)
        else droppedRings++;
      }
      if (outRings.length > 0 && outRings[0] === rings[0]) polys.push(outRings);
      else droppedRings++;
    }
    if (polys.length === 0) throw new Error(`${g.id}: no polygon survives at minArea ${minAreaKm2} km2`);
    const base2 = { id: g.id, properties: g.properties };
    return polys.length === 1
      ? { type: "Polygon", arcs: polys[0], ...base2 }
      : { type: "MultiPolygon", arcs: polys, ...base2 };
  });

  // Garbage-collect arcs the surviving geometry no longer references; renumber in first-use order.
  const remap = new Map();
  const arcs = [];
  const mapRef = (ref) => {
    const a = ref < 0 ? ~ref : ref;
    let idx = remap.get(a);
    if (idx === undefined) {
      idx = arcs.length;
      remap.set(a, idx);
      arcs.push(kept[a]);
    }
    return ref < 0 ? ~idx : idx;
  };
  const geometriesOut = outGeoms.map((g) => {
    const arcsOut =
      g.type === "Polygon"
        ? g.arcs.map((ring) => ring.map(mapRef))
        : g.arcs.map((poly) => poly.map((ring) => ring.map(mapRef)));
    return { ...g, arcs: arcsOut };
  });
  return { arcs, geometries: geometriesOut, stats: { promoted, droppedRings } };
}

/** Delta-encode a grid-coordinate arc as TopoJSON expects. */
function deltaEncode(arc) {
  const out = new Array(arc.x.length);
  let px = 0;
  let py = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = [arc.x[i] - px, arc.y[i] - py];
    px = arc.x[i];
    py = arc.y[i];
  }
  return out;
}

/** Merge the two levels into one arc table (identical arcs are shared) and one set of objects. */
function mergeLevels(detail, coarse) {
  const table = [];
  const index = new Map();
  const intern = (arc) => {
    const enc = deltaEncode(arc);
    const key = JSON.stringify(enc);
    let i = index.get(key);
    if (i === undefined) {
      i = table.length;
      index.set(key, i);
      table.push(enc);
    }
    return i;
  };
  const rewrite = (level) => {
    const ids = level.arcs.map(intern);
    const mapRef = (ref) => (ref < 0 ? ~ids[~ref] : ids[ref]);
    return level.geometries.map((g) => ({
      type: g.type,
      arcs:
        g.type === "Polygon"
          ? g.arcs.map((r) => r.map(mapRef))
          : g.arcs.map((p) => p.map((r) => r.map(mapRef))),
      id: g.id,
      properties: g.properties,
    }));
  };
  const detailGeoms = rewrite(detail);
  const coarseGeoms = rewrite(coarse);
  return { arcs: table, detail: detailGeoms, coarse: coarseGeoms };
}

// ---------------------------------------------------------------------------------------------
// Part centres
// ---------------------------------------------------------------------------------------------

function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Midpoint of the widest interior stretch of a horizontal scanline: always inside a real polygon. */
function scanlineCentre(rings) {
  let bestW = -1;
  let best = null;
  const ys = rings[0].map((p) => p[1]).sort((a, b) => a - b);
  const lo = ys[0];
  const hi = ys[ys.length - 1];
  for (let s = 1; s < 40; s++) {
    const y = lo + ((hi - lo) * s) / 40;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > bestW) {
        bestW = w;
        best = [(xs[k] + xs[k + 1]) / 2, y];
      }
    }
  }
  return best;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Pole of inaccessibility of one polygon part: polylabel on an equirectangular projection scaled
 * by cos(mean latitude of the exterior ring), converted back to lng/lat and rounded to 4 dp.
 * Returns { point, method } where method is "polylabel" or a logged fallback.
 */
export function partCentre(rings, precisionDeg) {
  const outer = rings[0];
  let latSum = 0;
  for (let i = 0; i < outer.length - 1; i++) latSum += outer[i][1];
  const k = Math.max(Math.cos(((latSum / (outer.length - 1)) * Math.PI) / 180), 0.01);
  const flat = rings.map((r) => r.map(([x, y]) => [x * k, y]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of flat[0]) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // polylabel returns the bbox corner for a part thinner than its precision, so tighten the
  // precision for small parts rather than let a tiny island fall back every time.
  const thin = Math.min(maxX - minX, maxY - minY);
  const tries = [Math.min(precisionDeg, thin / 40), Math.min(precisionDeg / 10, thin / 400)];
  for (const [i, p] of tries.entries()) {
    if (!(p > 0)) continue;
    const c = polylabel(flat, p);
    const pt = [round4(c[0] / k), round4(c[1])];
    if (pointInRings(pt[0], pt[1], rings)) return { point: pt, method: i === 0 ? "polylabel" : "polylabel-fine" };
  }
  const s = scanlineCentre(rings);
  const pt = [round4(s[0]), round4(s[1])];
  if (!pointInRings(pt[0], pt[1], rings)) {
    throw new Error(`no interior point found for a part starting at ${JSON.stringify(outer[0])}`);
  }
  return { point: pt, method: "scanline" };
}

function buildCentres(topo, precisionDeg) {
  const centres = {};
  const fallbacks = [];
  let parts = 0;
  for (const f of feature(topo, topo.objects.detail).features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    centres[f.id] = polys.map((rings, i) => {
      const { point, method } = partCentre(rings, precisionDeg);
      parts++;
      if (method !== "polylabel") fallbacks.push(`${f.id}#${i}:${method}`);
      return point;
    });
  }
  return { centres, fallbacks, parts };
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

function countVertices(topo, geometries) {
  const used = new Set();
  const visit = (a) => {
    if (typeof a === "number") used.add(a < 0 ? ~a : a);
    else a.forEach(visit);
  };
  geometries.forEach((g) => visit(g.arcs));
  let n = 0;
  for (const i of used) n += topo.arcs[i].length;
  return n;
}

function verify(topo, idsExpected, bytes, budget) {
  const problems = [];
  const objects = ["detail", "coarse"];
  for (const name of objects) {
    const fc = feature(topo, topo.objects[name]);
    const ids = fc.features.map((f) => f.id);
    if (JSON.stringify(ids) !== JSON.stringify(idsExpected)) {
      problems.push(`${name}: unit ids differ from the expected sorted list`);
    }
    for (const f of fc.features) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      let real = 0;
      polys.forEach((rings, part) => {
        rings.forEach((ring, i) => {
          const a = signedArea(ring);
          const distinct = new Set(ring.slice(0, -1).map((p) => `${p[0]},${p[1]}`)).size;
          const at = `${name}/${f.id} part ${part} (${ring.length - 1} vertices from ${JSON.stringify(ring[0])})`;
          if (ring.length < 4 || distinct < 3 || a === 0) {
            problems.push(`${at}: degenerate ${i === 0 ? "exterior" : "hole"} ring`);
            return;
          }
          if (i === 0) real++;
          if ((a < 0) !== (i === 0)) {
            problems.push(`${at}: ${i === 0 ? "exterior not clockwise" : "hole not anticlockwise"}`);
          }
        });
      });
      if (real < 1) problems.push(`${name}/${f.id}: no non-degenerate polygon`);
    }
  }
  const dv = countVertices(topo, topo.objects.detail.geometries);
  const cv = countVertices(topo, topo.objects.coarse.geometries);
  if (cv > budget.coarseVertices) {
    problems.push(`coarse has ${cv} vertices (> ${budget.coarseVertices})`);
  }
  if (bytes > budget.totalBytes) problems.push(`file is ${bytes} bytes (> ${budget.totalBytes})`);
  for (const id of Object.keys(topo.centres)) {
    const n = topo.objects.detail.geometries.find((g) => g.id === id);
    const parts = n.type === "Polygon" ? 1 : n.arcs.length;
    if (topo.centres[id].length !== parts) problems.push(`centres/${id}: ${topo.centres[id].length} centres for ${parts} parts`);
  }
  return { problems, detailVertices: dv, coarseVertices: cv };
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

export async function build({ log = console.log, config = CONFIG } = {}) {
  const countries = JSON.parse((await loadSource("ne_50m_admin_0_countries")).toString("utf8"));
  const mapUnits = JSON.parse((await loadSource("ne_50m_admin_0_map_units")).toString("utf8"));
  const units = buildUnits(countries, mapUnits);
  log(`units: ${units.length} (${SPLIT_UNIT_IDS.length} from map_units, ${units.length - SPLIT_UNIT_IDS.length} from countries)`);

  const rewindStats = { flipped: 0 };
  const fc = {
    type: "FeatureCollection",
    features: units.map((u) => {
      assertNoAntimeridianJump(u.id, u.geometry);
      return {
        type: "Feature",
        id: u.id,
        properties: { name: u.name },
        geometry: rewindGeometry(u.geometry, rewindStats),
      };
    }),
  };
  log(`winding: ${rewindStats.flipped} ring(s) re-wound to the d3 convention`);

  const topo0 = topology({ units: fc }, config.quantization);
  const pre = presimplify(topo0, sphericalTriangleArea);
  const base = decodeToGrid(pre, topo0.transform);
  const rawVertices = base.reduce((n, a) => n + a.x.length, 0);
  log(`topology: ${base.length} arcs, ${rawVertices} quantized vertices before simplification`);

  const geoms = topo0.objects.units.geometries;
  const partCount = (gs) => gs.reduce((n, g) => n + polygonsOf(g).length, 0);
  const rawParts = fc.features.reduce(
    (n, f) => n + (f.geometry.type === "Polygon" ? 1 : f.geometry.coordinates.length),
    0,
  );
  log(`parts: ${rawParts} in Natural Earth, ${partCount(geoms)} after quantization`);
  const [kx] = topo0.transform.scale;
  const [tx] = topo0.transform.translate;
  const isSeam = (x) => Math.abs(x * kx + tx) > 179.9999;
  const detail = buildLevel(base, geoms, config.detail, isSeam);
  const coarse = buildLevel(base, geoms, config.coarse, isSeam);
  if (config.detail.minKeepPart > 0 && partCount(detail.geometries) !== partCount(geoms)) {
    throw new Error(
      `detail kept ${partCount(detail.geometries)} of ${partCount(geoms)} polygon parts; it must keep them all`,
    );
  }
  log(`detail: ${detail.stats.promoted} point(s) promoted to keep polygons alive, ${detail.stats.droppedRings} ring(s) dropped`);
  log(`coarse: ${coarse.stats.promoted} point(s) promoted to keep polygons alive, ${coarse.stats.droppedRings} ring(s) dropped`);

  const merged = mergeLevels(detail, coarse);
  const topo = {
    type: "Topology",
    transform: topo0.transform,
    objects: {
      detail: { type: "GeometryCollection", geometries: merged.detail },
      coarse: { type: "GeometryCollection", geometries: merged.coarse },
    },
    arcs: merged.arcs,
  };
  const { centres, fallbacks, parts } = buildCentres(topo, config.centrePrecisionDeg);
  topo.centres = centres;

  const worldJson = JSON.stringify(topo) + "\n";
  const worldBytes = Buffer.byteLength(worldJson);
  const ids = units.map((u) => u.id);
  const check = verify(topo, ids, worldBytes, config.budget);
  if (check.problems.length > 0) {
    throw new Error(`world map verification failed:\n  ${check.problems.join("\n  ")}`);
  }

  const unitsJson =
    "[\n" +
    units
      .map((u) => `  ${JSON.stringify({ id: u.id, name: u.name, sovereign: u.sovereign, subregion: u.subregion })}`)
      .join(",\n") +
    "\n]\n";

  log(`world:  ${worldBytes} bytes (${(worldBytes / 1000).toFixed(1)} KB; budget ${config.budget.totalBytes})`);
  log(`        arcs ${topo.arcs.length}; detail ${check.detailVertices} vertices; coarse ${check.coarseVertices} vertices (budget ${config.budget.coarseVertices})`);
  log(`        ${ids.length} units in each object; ${parts} part centres; sha256 ${sha256(Buffer.from(worldJson))}`);
  log(`        centre fallbacks: ${fallbacks.length === 0 ? "none" : fallbacks.join(", ")}`);
  log(`units.json: ${Buffer.byteLength(unitsJson)} bytes`);
  return { worldJson, unitsJson, topo, fallbacks };
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const { worldJson, unitsJson } = await build();
  const targets = [
    [OUT_WORLD, worldJson],
    [OUT_UNITS, unitsJson],
  ];
  if (checkOnly) {
    let bad = 0;
    for (const [file, text] of targets) {
      const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      if (have !== text) {
        console.error(`DIFFERS: ${file}`);
        bad++;
      }
    }
    if (bad > 0) process.exit(1);
    console.log("committed files match a fresh build");
    return;
  }
  for (const [file, text] of targets) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    console.log(`wrote ${path.relative(REPO, file)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
