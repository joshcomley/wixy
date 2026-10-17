// The gallery's HTTP surface (`GET /gallery`, workspace 00046): the whole media history, newest
// first, a page at a time. Parsed defensively — a tile the client cannot draw is dropped here
// rather than breaking the grid.

import type { ServerSession } from "../types";
import { serverFetch } from "./http";

export type GalleryKind = "photo" | "video";

/** One photo or video in the history. `seq`/`ordinal` give its place (message, then position
 * within it) — also the paging cursor and the device's "downloaded up to here" mark. */
export interface GalleryItem {
  readonly id: string;
  readonly kind: GalleryKind;
  readonly seq: number;
  readonly ordinal: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationS: number | null;
  /** Epoch seconds the media was sent. */
  readonly createdAt: number;
  readonly animated: boolean;
  readonly urls: {
    readonly full?: string;
    readonly thumb?: string;
    readonly poster?: string;
    readonly play?: string;
  };
  /** The original (a photo's `full`, a video's `play`) as a save-not-show link, or null if the
   * server has no such file. */
  readonly downloadUrl: string | null;
  /** The name a saved copy gets, e.g. `wixy-20261017-081500-1a2b3c4d.jpg`. */
  readonly filename: string;
}

export interface GalleryPage {
  readonly items: readonly GalleryItem[];
  readonly hasMore: boolean;
}

export interface GalleryCursor {
  readonly seq: number;
  readonly ordinal: number;
}

export const GALLERY_FIRST_PAGE = 60;
export const GALLERY_PAGE = 200;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseGalleryItem(raw: unknown): GalleryItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = stringOrUndefined(r["id"]);
  const kind = r["kind"];
  const seq = numberOrNull(r["seq"]);
  const ordinal = numberOrNull(r["ordinal"]);
  if (id === undefined || (kind !== "photo" && kind !== "video") || seq === null || ordinal === null) {
    return null;
  }
  const urlsRaw = typeof r["urls"] === "object" && r["urls"] !== null ? (r["urls"] as Record<string, unknown>) : {};
  const full = stringOrUndefined(urlsRaw["full"]);
  const thumb = stringOrUndefined(urlsRaw["thumb"]);
  const poster = stringOrUndefined(urlsRaw["poster"]);
  const play = stringOrUndefined(urlsRaw["play"]);
  return {
    id,
    kind,
    seq,
    ordinal,
    width: numberOrNull(r["width"]),
    height: numberOrNull(r["height"]),
    durationS: numberOrNull(r["durationS"]),
    createdAt: numberOrNull(r["createdAt"]) ?? 0,
    animated: r["animated"] === true,
    urls: {
      ...(full !== undefined ? { full } : {}),
      ...(thumb !== undefined ? { thumb } : {}),
      ...(poster !== undefined ? { poster } : {}),
      ...(play !== undefined ? { play } : {}),
    },
    downloadUrl: stringOrUndefined(r["downloadUrl"]) ?? null,
    filename: stringOrUndefined(r["filename"]) ?? `wixy-${id.slice(0, 8)}`,
  };
}

/** `before` is the last item of the page already held (newest-first paging). */
export async function getGalleryPage(
  session: ServerSession,
  opts: { before?: GalleryCursor; limit?: number } = {},
): Promise<GalleryPage> {
  const params = new URLSearchParams();
  if (opts.before !== undefined) params.set("before", `${opts.before.seq}.${opts.before.ordinal}`);
  params.set("limit", String(opts.limit ?? GALLERY_PAGE));
  const response = await serverFetch(`/gallery?${params.toString()}`, { method: "GET" }, session);
  if (!response.ok) throw new Error(`Couldn't load the gallery (${response.status}).`);
  const body = (await response.json()) as { items?: unknown; hasMore?: unknown };
  const items: GalleryItem[] = [];
  for (const raw of Array.isArray(body.items) ? body.items : []) {
    const item = parseGalleryItem(raw);
    if (item !== null) items.push(item);
  }
  return { items, hasMore: body.hasMore === true };
}
