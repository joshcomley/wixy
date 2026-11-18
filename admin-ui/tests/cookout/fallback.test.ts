import { describe, expect, it, vi } from "vitest";
import { decodeAll, fallbackEmoji, ingredientPicture, RENDITION_PX } from "../../src/server/cookout/pictures";

// spec/server-chat/09b-cookout-visual.md §D.6: a snap with `image: null`, and an `<img>` that errors, both
// render the SAME tile with the ingredient's emoji — identical classes and box, so a missing picture can
// never change the screen's fit. The real picture has width/height attributes (no layout shift).

const IMAGE = { card: `/admin/cookout-img/${"a".repeat(64)}.webp`, thumb: `/admin/cookout-img/${"b".repeat(64)}.webp` };
const RIBEYE = { id: "ribeye-steak", name: "Ribeye steak", emoji: "🥩", image: IMAGE };

describe("an ingredient picture", () => {
  it("draws the requested rendition with its size attributes, async decoding and the name as alt", () => {
    const tile = ingredientPicture(document, RIBEYE, { rendition: "card", className: "x-card" });
    const img = tile.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(IMAGE.card);
    expect(img?.width).toBe(RENDITION_PX.card);
    expect(img?.height).toBe(RENDITION_PX.card);
    expect(img?.getAttribute("decoding")).toBe("async");
    expect(img?.alt).toBe("Ribeye steak");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(tile.className).toContain("wx-srv-ck-pic wx-srv-ck-pic-card x-card");
  });

  it("loads eagerly when asked and uses the thumb rendition for thumbs", () => {
    const tile = ingredientPicture(document, RIBEYE, { rendition: "thumb", eager: true });
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(IMAGE.thumb);
    expect(tile.querySelector("img")?.getAttribute("loading")).toBe("eager");
  });

  it("image: null renders the emoji tile with the same classes, and the name for screen readers", () => {
    const real = ingredientPicture(document, RIBEYE, { rendition: "card", className: "x-card" });
    const none = ingredientPicture(document, { ...RIBEYE, image: null }, { rendition: "card", className: "x-card" });
    expect(none.querySelector("img")).toBeNull();
    expect(none.querySelector(".wx-srv-ck-pic-emoji")?.textContent).toBe("🥩");
    expect(none.getAttribute("role")).toBe("img");
    expect(none.getAttribute("aria-label")).toBe("Ribeye steak");
    // Same size classes: the box is the caller's CSS, identical with or without a picture.
    expect(none.classList.contains("wx-srv-ck-pic-card")).toBe(true);
    expect(none.classList.contains("x-card")).toBe(true);
    expect(real.classList.contains("wx-srv-ck-pic-card")).toBe(true);
  });

  it("an image that errors falls back to the same emoji tile", () => {
    const tile = ingredientPicture(document, RIBEYE, { rendition: "card" });
    tile.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.querySelector(".wx-srv-ck-pic-emoji")?.textContent).toBe("🥩");
    expect(tile.classList.contains("wx-srv-ck-pic-fallback")).toBe(true);
    expect(tile.classList.contains("wx-srv-ck-pic-card")).toBe(true);
    expect(tile.getAttribute("aria-label")).toBe("Ribeye steak");
  });

  it("shimmers while loading and stops once loaded", () => {
    const tile = ingredientPicture(document, RIBEYE, { rendition: "card" });
    expect(tile.classList.contains("wx-srv-ck-pic-loading")).toBe(true);
    tile.querySelector("img")?.dispatchEvent(new Event("load"));
    expect(tile.classList.contains("wx-srv-ck-pic-loading")).toBe(false);
  });

  it("a decorative tile (alt '') carries no name of its own", () => {
    const tile = ingredientPicture(document, { ...RIBEYE, image: null }, { rendition: "thumb", alt: "" });
    expect(tile.hasAttribute("aria-label")).toBe(false);
    expect(tile.hasAttribute("role")).toBe(false);
  });

  it("falls back on a seasoning's emoji, then a plate", () => {
    expect(fallbackEmoji({ id: "salt", name: "Salt", image: null })).toBe("🧂");
    expect(fallbackEmoji({ id: "water", name: "Water", image: null })).toBe("💧");
    expect(fallbackEmoji({ id: "mystery", name: "Mystery", emoji: "", image: null })).toBe("🍽️");
  });
});

describe("decoding before the swap", () => {
  it("resolves at the deadline when the pictures take longer", async () => {
    const timeouts = new Map<number, () => void>();
    let id = 0;
    const timers = {
      setTimeout: (cb: () => void) => {
        id += 1;
        timeouts.set(id, cb);
        return id;
      },
      clearTimeout: (n: number) => void timeouts.delete(n),
    };
    const decode = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode });
    let done = false;
    const waiting = decodeAll(document, [IMAGE.card], 400, timers).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    [...timeouts.values()].forEach((cb) => cb());
    await waiting;
    expect(done).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
    delete (HTMLImageElement.prototype as unknown as { decode?: unknown }).decode;
  });

  it("resolves at once with nothing to decode", async () => {
    await expect(decodeAll(document, [], 400, { setTimeout: () => 1, clearTimeout: () => {} })).resolves.toBeUndefined();
  });
});
