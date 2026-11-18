// Cookout ingredient pictures (workspace 00058; spec/server-chat/09b-cookout-visual.md §D.6, §E.3): every
// place an ingredient appears draws it through `ingredientPicture`, so they all share one tile and one
// fallback. The tile is the catalogue photographs' own warm off-white (#F5F2EC, 09b §B.2), so a picture's
// edge disappears into it in either theme. A missing picture (`image: null`) and one that fails to load
// both render the SAME tile with the ingredient's emoji centred — identical box, so a missing picture can
// never change the screen's fit.
//
// The pictures are content-addressed (`/admin/cookout-img/<sha>.webp`, immutable for a year), so the
// browser's own cache is the only cache: nothing here remembers a URL.

import type { IngredientImage } from "./api";

export type Rendition = "card" | "thumb";

/** The renditions' pixel sizes (09b §B.3), used for the `width`/`height` attributes (no layout shift). */
export const RENDITION_PX: Readonly<Record<Rendition, number>> = { card: 512, thumb: 160 };

/** How long a new pair may wait for both pictures to decode before it swaps in anyway (09b §D.6). */
export const DECODE_WAIT_MS = 400;

/** The fallback for the cupboard staples (a staple carries no emoji of its own). */
const STAPLE_EMOJI: Readonly<Record<string, string>> = {
  water: "💧",
  salt: "🧂",
  "black-pepper": "🫙",
  butter: "🧈",
  "plain-flour": "🌾",
  "cooking-oil": "🫒",
  "granulated-sugar": "🍬",
  milk: "🥛",
};

/** Anything with a name and maybe a picture: an ingredient snap, a pick, a staple. */
export interface Picturable {
  readonly id: string;
  readonly name: string;
  readonly emoji?: string;
  readonly image: IngredientImage | null;
}

export interface PictureOptions {
  readonly rendition: Rendition;
  /** Extra classes for the tile (its size is the caller's CSS). */
  readonly className?: string;
  /** Load at once (the pair on the table, the carousel's current and next slide); the rest are lazy. */
  readonly eager?: boolean;
  /** The image's alt text (default: the ingredient's name). Empty marks the picture as decoration. */
  readonly alt?: string;
}

/** The emoji a tile falls back on: the snap's own, a seasoning's, else a plate. */
export function fallbackEmoji(item: Picturable): string {
  const own = item.emoji ?? "";
  if (own !== "") return own;
  return STAPLE_EMOJI[item.id] ?? "🍽️";
}

function fallbackInto(doc: Document, tile: HTMLElement, item: Picturable, alt: string): void {
  tile.classList.remove("wx-srv-ck-pic-loading");
  tile.classList.add("wx-srv-ck-pic-fallback");
  const emoji = doc.createElement("span");
  emoji.className = "wx-srv-ck-pic-emoji";
  emoji.textContent = fallbackEmoji(item);
  emoji.setAttribute("aria-hidden", "true");
  tile.replaceChildren(emoji);
  // The emoji is decoration: the tile itself carries the name the picture would have had.
  if (alt !== "") {
    tile.setAttribute("role", "img");
    tile.setAttribute("aria-label", alt);
  }
}

/** One ingredient's picture tile: the photograph, or the same-size emoji tile when there is none or it
 * fails to load. Never throws; the `<img>` is created only for a URL `api.ts` already vetted. */
export function ingredientPicture(doc: Document, item: Picturable, options: PictureOptions): HTMLElement {
  const tile = doc.createElement("span");
  tile.className = `wx-srv-ck-pic wx-srv-ck-pic-${options.rendition}${options.className !== undefined ? ` ${options.className}` : ""}`;
  const alt = options.alt ?? item.name;
  const url = item.image === null ? null : item.image[options.rendition];
  if (url === null) {
    fallbackInto(doc, tile, item, alt);
    return tile;
  }
  const img = doc.createElement("img");
  img.className = "wx-srv-ck-pic-img";
  img.alt = alt;
  const px = RENDITION_PX[options.rendition];
  img.width = px;
  img.height = px;
  // Attributes, not properties: what every engine reads (and what a DOM without the IDL keeps).
  img.setAttribute("decoding", "async");
  img.setAttribute("loading", options.eager === true ? "eager" : "lazy");
  img.draggable = false;
  tile.classList.add("wx-srv-ck-pic-loading");
  img.addEventListener("load", () => tile.classList.remove("wx-srv-ck-pic-loading"), { once: true });
  img.addEventListener("error", () => fallbackInto(doc, tile, item, alt), { once: true });
  img.src = url;
  tile.append(img);
  return tile;
}

/** Waits until every URL has decoded (or failed), or `waitMs` has passed — whichever is first. Resolves,
 * never rejects: a picture that cannot decode simply falls back when it is drawn. */
export function decodeAll(
  doc: Document,
  urls: readonly string[],
  waitMs: number,
  timers: { setTimeout(callback: () => void, ms: number): number; clearTimeout(id: number): void },
): Promise<void> {
  if (urls.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      resolve();
    };
    const timer = timers.setTimeout(finish, waitMs);
    const decodes = urls.map((url) => {
      const img = doc.createElement("img");
      img.decoding = "async";
      img.src = url;
      // jsdom (and very old engines) have no decode(): treat the picture as ready.
      return typeof img.decode === "function" ? img.decode().catch(() => undefined) : Promise.resolve();
    });
    void Promise.all(decodes).then(finish);
  });
}
