import { describe, expect, it } from "vitest";
import {
  clampLat,
  clampZoom,
  formatCoords,
  lonLatToWorldPixel,
  MAX_ZOOM,
  MIN_ZOOM,
  osmTileUrl,
  parseCoords,
  roundCoord,
  tilesForViewport,
  worldPixelToLonLat,
} from "../src/mapPickerModel";

describe("clampLat", () => {
  it("passes latitudes within Mercator's valid range through unchanged", () => {
    expect(clampLat(51.5)).toBe(51.5);
    expect(clampLat(-33.9)).toBe(-33.9);
  });

  it("clamps beyond the poles' Mercator cutoff", () => {
    expect(clampLat(90)).toBe(85.0511);
    expect(clampLat(-90)).toBe(-85.0511);
  });
});

describe("lonLatToWorldPixel / worldPixelToLonLat round-trip", () => {
  it("round-trips the real seeded address's coordinates (Hartlebury, Worcestershire)", () => {
    const lat = 52.379464;
    const lon = -2.222315;
    for (const zoom of [2, 10, 16, 18]) {
      const world = lonLatToWorldPixel(lon, lat, zoom);
      const back = worldPixelToLonLat(world.x, world.y, zoom);
      expect(back.lon).toBeCloseTo(lon, 6);
      expect(back.lat).toBeCloseTo(lat, 6);
    }
  });

  it("round-trips the origin (0,0)", () => {
    const world = lonLatToWorldPixel(0, 0, 10);
    const back = worldPixelToLonLat(world.x, world.y, 10);
    expect(back.lon).toBeCloseTo(0, 9);
    expect(back.lat).toBeCloseTo(0, 9);
  });

  it("places (-180, 0) at world-pixel x=0 and (180, 0) at the full world width", () => {
    const zoom = 4;
    const worldWidth = 256 * 2 ** zoom;
    const west = lonLatToWorldPixel(-180, 0, zoom);
    const east = lonLatToWorldPixel(180, 0, zoom);
    expect(west.x).toBeCloseTo(0, 6);
    expect(east.x).toBeCloseTo(worldWidth, 6);
  });

  it("doubles world-pixel span for the same lon/lat delta when zoom increases by 1", () => {
    const a = lonLatToWorldPixel(-2, 52, 10);
    const b = lonLatToWorldPixel(-1, 52, 10);
    const a2 = lonLatToWorldPixel(-2, 52, 11);
    const b2 = lonLatToWorldPixel(-1, 52, 11);
    expect(b2.x - a2.x).toBeCloseTo((b.x - a.x) * 2, 6);
  });
});

describe("tilesForViewport", () => {
  it("covers a viewport with contiguous, gap-free tile placements", () => {
    const zoom = 5;
    const center = lonLatToWorldPixel(-2, 52, zoom);
    const tiles = tilesForViewport(center.x, center.y, 320, 280, zoom);
    // The requested viewport must be fully covered by the union of tile
    // rects — check every viewport corner lands inside some tile's bounds.
    const corners = [
      [0, 0],
      [319, 0],
      [0, 279],
      [319, 279],
    ];
    for (const [cx, cy] of corners) {
      const covered = tiles.some(
        (t) =>
          cx !== undefined &&
          cy !== undefined &&
          cx >= t.screenX &&
          cx < t.screenX + 256 &&
          cy >= t.screenY &&
          cy < t.screenY + 256,
      );
      expect(covered).toBe(true);
    }
  });

  it("wraps tile X around the world at low zoom but never emits a tile Y beyond the poles", () => {
    const zoom = 2; // 4x4 world
    // Center near the antimeridian so the viewport spills past tileX 3 (wraps to 0).
    const center = lonLatToWorldPixel(179.9, 0, zoom);
    const tiles = tilesForViewport(center.x, center.y, 600, 600, zoom);
    for (const t of tiles) {
      expect(t.tileX).toBeGreaterThanOrEqual(0);
      expect(t.tileX).toBeLessThan(4);
      expect(t.tileY).toBeGreaterThanOrEqual(0);
      expect(t.tileY).toBeLessThan(4);
    }
    // Confirms wrapping actually happened (both a low and a wrapped-high X present).
    expect(tiles.some((t) => t.tileX === 0)).toBe(true);
  });
});

describe("osmTileUrl", () => {
  it("builds the documented OSM tile URL shape", () => {
    expect(osmTileUrl(3, 5, 8)).toBe("https://tile.openstreetmap.org/8/3/5.png");
  });
});

describe("clampZoom", () => {
  it("clamps to [MIN_ZOOM, MAX_ZOOM] and rounds to a whole tile zoom", () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(30)).toBe(MAX_ZOOM);
    expect(clampZoom(10.4)).toBe(10);
    expect(clampZoom(10.6)).toBe(11);
  });
});

describe("roundCoord / formatCoords", () => {
  it("rounds to 6dp", () => {
    expect(roundCoord(52.37946412345)).toBe(52.379464);
  });

  it("formats as a compact, no-space \"lat,lng\" pair", () => {
    expect(formatCoords(52.379464, -2.222315)).toBe("52.379464,-2.222315");
  });
});

describe("parseCoords", () => {
  it("accepts the canonical stored no-space form", () => {
    expect(parseCoords("52.379464,-2.222315")).toEqual({ lat: 52.379464, lng: -2.222315 });
  });

  it("is forgiving of a human-typed space after the comma", () => {
    expect(parseCoords("52.379464, -2.222315")).toEqual({ lat: 52.379464, lng: -2.222315 });
  });

  it("rejects out-of-range latitude/longitude", () => {
    expect(parseCoords("91,0")).toBeNull();
    expect(parseCoords("0,181")).toBeNull();
    expect(parseCoords("-91,0")).toBeNull();
    expect(parseCoords("0,-181")).toBeNull();
  });

  it("rejects malformed input rather than throwing", () => {
    expect(parseCoords("")).toBeNull();
    expect(parseCoords("not coordinates")).toBeNull();
    expect(parseCoords("52.379464")).toBeNull();
    expect(parseCoords("52.379464,-2.222315,0")).toBeNull();
  });
});
