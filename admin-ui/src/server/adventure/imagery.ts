// Adventure Time — the map imagery: which picture lies under the borders, where it comes from and how it
// is loaded.
//
// Three styles. "satellite" (NASA Blue Marble Next Generation with topography and bathymetry) and "atlas"
// (Natural Earth II, shaded relief with water) are 8192 x 4096 equirectangular WebP files served as static
// assets; "classic" is the flat illustrated map the renderer paints itself. Both pictures are public
// domain. The choice is per DEVICE (localStorage, never the server): a phone and a laptop may differ.
//
// The pictures are 2.3 MB each and 175 MB of GPU memory once mipmapped, so they are loaded lazily, only
// for the style in use, only after the vector globe is already on screen, and downscaled on devices whose
// GL texture limit or memory is smaller. Until a picture arrives (or if WebGL 2 is missing, or the download
// fails) the renderer simply keeps the classic style: nothing ever waits on or breaks because of imagery.
//
// esbuild copies the files next to the bundle and defines the two URL constants with content hashes (the
// call-worklet / world-map precedent in esbuild.config.mjs); outside a bundle (tests, the dev harness) the
// constants are undefined and `textureUrl` falls back to the conventional path.

export type MapStyle = "satellite" | "atlas" | "classic";
export type ImageryStyle = Exclude<MapStyle, "classic">;

export const MAP_STYLES: readonly MapStyle[] = ["satellite", "atlas", "classic"];
export const DEFAULT_MAP_STYLE: MapStyle = "satellite";

declare const WIXY_ADVENTURE_SATELLITE_URL: string;
declare const WIXY_ADVENTURE_ATLAS_URL: string;

/** Where a style's picture is served from. */
export function textureUrl(style: ImageryStyle): string {
  if (style === "satellite") {
    return typeof WIXY_ADVENTURE_SATELLITE_URL === "string" ? WIXY_ADVENTURE_SATELLITE_URL : "/admin/static/admin/adventure-satellite.webp";
  }
  return typeof WIXY_ADVENTURE_ATLAS_URL === "string" ? WIXY_ADVENTURE_ATLAS_URL : "/admin/static/admin/adventure-atlas.webp";
}

const STORAGE_KEY = "wixy.adventure.mapStyle";

export function isMapStyle(value: unknown): value is MapStyle {
  return value === "satellite" || value === "atlas" || value === "classic";
}

/** This device's saved choice (default satellite). Storage may be blocked or empty: never throws. */
export function readMapStyle(): MapStyle {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMapStyle(raw) ? raw : DEFAULT_MAP_STYLE;
  } catch {
    return DEFAULT_MAP_STYLE;
  }
}

export function writeMapStyle(style: MapStyle): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // private mode / blocked storage: the choice just lasts for this visit
  }
}

/**
 * The widest texture to keep on the GPU: the file is 8192 wide, but a device whose texture limit is smaller,
 * or which reports little memory, gets a downscaled copy (4096 wide is 44 MB instead of 175 MB).
 */
export function textureSide(maxTextureSize: number, deviceMemoryGb: number | undefined): number {
  const limit = maxTextureSize > 0 ? maxTextureSize : 4096;
  const memoryCap = deviceMemoryGb !== undefined && deviceMemoryGb <= 2 ? 4096 : 8192;
  return Math.max(1024, Math.min(8192, limit, memoryCap));
}

/** Loads a style's picture, at most `maxSide` wide. Rejects on any failure; the caller keeps the flat map. */
export type TextureLoader = (style: ImageryStyle, maxSide: number) => Promise<ImageBitmap>;

/** The default loader: fetches `textureUrl(style)` and decodes it off the main thread. */
export const fetchTexture: TextureLoader = async (style, maxSide) => {
  const response = await fetch(textureUrl(style), { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Adventure imagery ${style}: HTTP ${response.status}`);
  return decodeImage(await response.blob(), maxSide);
};

/** Decodes an image blob, downscaled to at most `maxSide` wide when it is wider. */
export async function decodeImage(blob: Blob, maxSide: number): Promise<ImageBitmap> {
  const options = { premultiplyAlpha: "none", colorSpaceConversion: "none" } as const;
  const full = await createImageBitmap(blob, options);
  if (full.width <= maxSide) return full;
  const height = Math.max(1, Math.round((full.height * maxSide) / full.width));
  full.close();
  return createImageBitmap(blob, { ...options, resizeWidth: maxSide, resizeHeight: height, resizeQuality: "high" });
}

/** A loader over base64 files the page carries itself (the single-file dev preview has no server to ask). */
export function inlineLoader(sources: Readonly<Partial<Record<ImageryStyle, { base64: string; mime: string }>>>): TextureLoader {
  return async (style, maxSide) => {
    const source = sources[style];
    if (source === undefined || source.base64 === "") throw new Error(`No inline picture for ${style}`);
    const bytes = Uint8Array.from(atob(source.base64), (c) => c.charCodeAt(0));
    return decodeImage(new Blob([bytes], { type: source.mime }), maxSide);
  };
}
