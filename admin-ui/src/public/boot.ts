// The public page's boot data (spec/adventure-public section 2.3): the server's shell carries it as
//
//   <script type="application/json" id="adventure-public-boot">
//     {"code": "<6 chars>" | null, "origin": "https://adventure.cinnamons.uk",
//      "assets": {"world": "<url>", "satellite": "<url>", "atlas": "<url>"}}
//   </script>
//
// and the page mounts into `<div id="adventure-public-root">`. `code` is the place a `/d/<code>` page
// was served for (null on the home page); `origin` is what a short link is made on; `assets` are the
// (fingerprinted) URLs of the world map and the two map pictures. An asset URL must stay on this site:
// a path, or an absolute URL on `origin`.

export const BOOT_ELEMENT_ID = "adventure-public-boot";
export const ROOT_ELEMENT_ID = "adventure-public-root";

export interface BootInfo {
  readonly code: string | null;
  readonly origin: string;
  readonly assets: {
    readonly world: string;
    readonly satellite: string;
    readonly atlas: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path on this site, or an absolute http(s) URL on `origin`; anything else (another host, a scheme) is refused. */
function sameSiteUrl(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value === "" || value.length > 2000 || /[\u0000-\u001f\\]/.test(value)) return null;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === origin ? parsed.href : null;
  } catch {
    return null;
  }
}

function cleanOrigin(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : fallback;
  } catch {
    return fallback;
  }
}

/** The boot data from its JSON text, or null when it is not usable (no assets to load the globe from). */
export function parseBoot(text: string, fallbackOrigin: string): BootInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !isRecord(json["assets"])) return null;
  const origin = cleanOrigin(json["origin"], fallbackOrigin);
  const assets = json["assets"];
  const world = sameSiteUrl(assets["world"], origin);
  const satellite = sameSiteUrl(assets["satellite"], origin);
  const atlas = sameSiteUrl(assets["atlas"], origin);
  if (world === null || satellite === null || atlas === null) return null;
  const code = json["code"];
  return { code: typeof code === "string" && code !== "" ? code : null, origin, assets: { world, satellite, atlas } };
}

/** Reads the boot element of `doc`. */
export function readBoot(doc: Document, fallbackOrigin: string): BootInfo | null {
  const element = doc.getElementById(BOOT_ELEMENT_ID);
  const text = element?.textContent ?? "";
  return text.trim() === "" ? null : parseBoot(text, fallbackOrigin);
}
