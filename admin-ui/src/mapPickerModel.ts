// Pure, DOM-free math for the Contact panel's map picker (decisions/00129) —
// Web Mercator projection, the visible tile grid, and coordinate parsing/
// formatting, kept separate so the geometry is unit-testable with vitest with
// no canvas/DOM at all (mirrors `alignerModel.ts` / `sectionPanelModel.ts`'s
// "framework-free core" convention).
//
// Standard slippy-map tile math (OSM wiki "Slippy map tilenames") in WORLD
// PIXEL space rather than tile-index space throughout: a world pixel is a
// continuous, non-floored coordinate (`tileIndex * TILE_SIZE`), which is what
// lets panning be a plain subtraction instead of re-deriving tile indices on
// every pointer-move.

export const TILE_SIZE = 256;

/** Web Mercator is undefined at the poles; OSM's own conventional cutoff. */
export const MAX_LAT = 85.0511;

export function clampLat(lat: number): number {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Longitude/latitude → continuous world-pixel coordinates at `zoom` (whole
 * tiles are `TILE_SIZE` px apart; NOT floored — a pan is a pixel subtraction
 * on this value, floored only when deciding which tile images to fetch). */
export function lonLatToWorldPixel(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * scale;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

/** The inverse of `lonLatToWorldPixel` — a click's world-pixel position back
 * to lon/lat, e.g. for a "click to pin coordinates" placement. */
export function worldPixelToLonLat(x: number, y: number, zoom: number): { lon: number; lat: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

export interface VisibleTile {
  /** Wrapped to `[0, 2^zoom)` — OSM tile servers expect a wrapped X for
   * longitudes that circle the world at low zoom; Y is never wrapped (the map
   * doesn't repeat pole-to-pole) — see `tilesForViewport`'s Y-range clamp. */
  tileX: number;
  tileY: number;
  /** Top-left placement of this tile within the viewport, in CSS px — may be
   * negative/overflow the viewport at the edges; the caller clips via
   * `overflow: hidden` on the viewport element rather than by not rendering. */
  screenX: number;
  screenY: number;
}

/** Every tile needed to cover a `viewportW`×`viewportH` box centered on
 * `(centerWorldX, centerWorldY)` at `zoom`, each with its screen placement.
 * One tile of padding on every side (`start - 1` / `+ 1` beyond the exact
 * bound) so a tile is already loaded before its edge scrolls into view. */
export function tilesForViewport(
  centerWorldX: number,
  centerWorldY: number,
  viewportW: number,
  viewportH: number,
  zoom: number,
): VisibleTile[] {
  const topLeftWorldX = centerWorldX - viewportW / 2;
  const topLeftWorldY = centerWorldY - viewportH / 2;
  const firstTileX = Math.floor(topLeftWorldX / TILE_SIZE) - 1;
  const firstTileY = Math.floor(topLeftWorldY / TILE_SIZE) - 1;
  const lastTileX = Math.floor((topLeftWorldX + viewportW) / TILE_SIZE) + 1;
  const lastTileY = Math.floor((topLeftWorldY + viewportH) / TILE_SIZE) + 1;

  const tilesPerSide = 2 ** zoom;
  const tiles: VisibleTile[] = [];
  for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
    if (tileY < 0 || tileY >= tilesPerSide) continue; // no tiles beyond the poles
    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      const wrappedX = ((tileX % tilesPerSide) + tilesPerSide) % tilesPerSide;
      tiles.push({
        tileX: wrappedX,
        tileY,
        screenX: tileX * TILE_SIZE - topLeftWorldX,
        screenY: tileY * TILE_SIZE - topLeftWorldY,
      });
    }
  }
  return tiles;
}

export function osmTileUrl(tileX: number, tileY: number, zoom: number): string {
  return `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;
}

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 18;

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
}

/** Coordinates round-trip through `_global.json` as `"lat,lng"` — 6dp is
 * ~11cm of precision at the equator, far tighter than a hand-placed pin or a
 * phone GPS reading needs, and short enough to stay a plain, readable string
 * in the admin's text field. */
const COORD_DP = 6;

export function roundCoord(n: number): number {
  return Math.round(n * 10 ** COORD_DP) / 10 ** COORD_DP;
}

export function formatCoords(lat: number, lng: number): string {
  return `${roundCoord(lat)},${roundCoord(lng)}`;
}

/** Parses the STORED `"lat,lng"` form or the more forgiving `"lat, lng"` a
 * human might type into the plain text field — two floats, each in its valid
 * geographic range. Returns `null` for anything else (blank, malformed,
 * out-of-range) so the caller never commits a bad value; never throws. */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const parts = text.split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]?.trim());
  const lng = Number(parts[1]?.trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
