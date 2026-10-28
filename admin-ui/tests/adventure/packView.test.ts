import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePack, type PackPicture, type PackView } from "../../src/server/adventure/api";
import { createPackPanel, type PackPanel, type PackPanelDeps } from "../../src/server/adventure/packView";
import { DEST_A, NO_PACK, dishesPack, readyPack } from "./adventureFixtures";

function pic(name: string, over: Partial<PackPicture> = {}): PackPicture {
  return { thumbUrl: `/m/${name}-t.jpg`, fullUrl: `/m/${name}.jpg`, credit: `${name} / CC BY`, page: `https://commons.example/${name}`, caption: `The ${name}`, ...over };
}

function ready(over: Partial<PackView> = {}): PackView {
  return { ...readyPack(), ...over };
}

function make(deps: Partial<PackPanelDeps> = {}): { panel: PackPanel; retry: ReturnType<typeof vi.fn>; host: HTMLElement } {
  const retry = vi.fn();
  const panel = createPackPanel({ document, retry, retrying: () => false, ...deps });
  const host = document.createElement("div");
  host.append(panel.element, panel.viewer);
  document.body.append(host);
  return { panel, retry, host };
}

function render(panel: PackPanel, pack: PackView, seq = 7): void {
  panel.render({ seq, place: DEST_A, unitName: "Aland", pack });
}

afterEach(() => document.body.replaceChildren());

describe("the holiday pack panel", () => {
  it("shows the headline, summary, every section as a card, the facts and the sources", () => {
    const { panel } = make();
    render(panel, ready());
    const root = panel.element;
    expect(root.querySelector(".wx-srv-adv-pk-place")?.textContent).toBe("Alpha, Aland");
    expect(root.querySelector(".wx-srv-adv-pk-headline")?.textContent).toBe("Sun and tiles");
    expect(root.querySelector(".wx-srv-adv-pk-summary")?.textContent).toBe("A warm place.");
    expect([...root.querySelectorAll(".wx-srv-adv-pk-title")].map((n) => n.textContent)).toEqual(["Where to eat", "Best time to go", "Getting there", "Travel advice", "Sources"]);
    expect(root.querySelector(".wx-srv-adv-pk-item-name")?.textContent).toBe("Tarts");
    expect(root.querySelector(".wx-srv-adv-pk-item-detail")?.textContent).toBe("Custard.");
    expect(root.querySelector(".wx-srv-adv-pk-food")).not.toBeNull();
  });

  it("opens every link in a new tab without the opener, and never builds a link from anything but a vetted URL", () => {
    const { panel } = make();
    const pack = ready();
    render(panel, pack);
    const links = [...panel.element.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => a.href)).toEqual(["https://example.com/tarts", "https://example.com/visit"]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noopener");
      expect(a.rel).toContain("noreferrer");
    }
  });

  it("sets model-written text as text, never as markup", () => {
    const { panel } = make();
    const hostile = parsePack({
      headline: `<img src=x onerror="window.__pwned=1">Head`,
      summary: "<script>window.__pwned=2</script>",
      sections: [{ key: "x\"><b>", title: "<b>Food</b>", items: [{ name: "<i>Tarts</i>", detail: "<u>d</u>", url: "https://example.com/a" }] }],
    });
    render(panel, ready({ data: hostile }));
    expect(panel.element.querySelectorAll("img, script, b, i, u")).toHaveLength(0);
    expect(panel.element.querySelector(".wx-srv-adv-pk-headline")?.textContent).toContain("<img src=x");
    expect(panel.element.querySelector(".wx-srv-adv-pk-card")?.className).not.toContain('"');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("shows nothing for a pack still being researched (the pane shows its own waiting row)", () => {
    const { panel } = make();
    render(panel, { ...NO_PACK, state: "pending" });
    expect(panel.element.textContent).toBe("");
  });

  it("a failed pack says so plainly and offers Try again when the server would accept it", () => {
    const { panel, retry } = make();
    render(panel, { ...NO_PACK, state: "failed", error: "The research didn't finish - try again", canRetry: true });
    expect(panel.element.textContent).toContain("The research didn't finish - try again");
    const button = panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-pk-retry");
    expect(button?.textContent).toBe("Try again");
    button?.click();
    expect(retry).toHaveBeenCalledTimes(1);
    // A rejected round cannot be retried: the words, but no button.
    const other = make();
    render(other.panel, { ...NO_PACK, state: "failed", error: null, canRetry: false });
    expect(other.panel.element.textContent).toContain("The research didn't finish");
    expect(other.panel.element.querySelector(".wx-srv-adv-pk-retry")).toBeNull();
  });

  it("the Try again button waits while a retry is in flight", () => {
    let retrying = false;
    const { panel } = make({ retrying: () => retrying });
    const failed: PackView = { ...NO_PACK, state: "failed", canRetry: true };
    render(panel, failed);
    expect(panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-pk-retry")?.disabled).toBe(false);
    retrying = true;
    render(panel, failed);
    expect(panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-pk-retry")?.disabled).toBe(true);
  });

  it("says holiday packs are not available on this server, and still lets Bank / pass on be used", () => {
    const { panel } = make();
    render(panel, { ...NO_PACK, state: "unavailable", canRetry: false });
    expect(panel.element.textContent).toContain("Holiday packs aren't available on this server");
    expect(panel.element.querySelector(".wx-srv-adv-pk-retry")).toBeNull();
    const again = make();
    render(again.panel, { ...NO_PACK, state: "unavailable", canRetry: true });
    expect(again.panel.element.querySelector(".wx-srv-adv-pk-retry")).not.toBeNull();
  });

  it("a ready pack that cannot be read says so instead of showing a blank card", () => {
    const { panel } = make();
    render(panel, ready({ data: null }));
    expect(panel.element.textContent).toContain("couldn't be read");
  });

  it("does not rebuild (and so does not lose scroll or a half-swiped carousel) when nothing it shows changed", () => {
    const { panel } = make();
    render(panel, ready());
    const content = panel.element.firstElementChild;
    render(panel, ready());
    expect(panel.element.firstElementChild).toBe(content);
    render(panel, ready({ images: "pending" }));
    expect(panel.element.firstElementChild).not.toBe(content);
  });
});

describe("the pack's pictures", () => {
  const withPictures = (images: PackView["images"], hero: PackPicture[] = [pic("bay"), pic("old-town")]): PackView =>
    ready({ images, pictures: { hero, items: new Map([["food:0", pic("tarts", { caption: "" })]]) } });

  it("a swipeable hero carousel of the place's photographs, each with its credit linking to its page", () => {
    const { panel } = make();
    render(panel, withPictures("done"));
    const slides = panel.element.querySelectorAll(".wx-srv-adv-hero-slide");
    expect(slides).toHaveLength(2);
    expect(panel.element.querySelector(".wx-srv-adv-hero-track")).not.toBeNull();
    expect(panel.element.querySelectorAll(".wx-srv-adv-hero-dot")).toHaveLength(2);
    const img = slides[0]?.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/m/bay-t.jpg");
    expect(img?.getAttribute("alt")).toBe("The bay");
    const credit = slides[0]?.querySelector(".wx-srv-adv-hero-credit");
    expect(credit?.textContent).toContain("Photo: bay / CC BY");
    const source = credit?.querySelector("a");
    expect(source?.getAttribute("href")).toBe("https://commons.example/bay");
    expect(source?.getAttribute("rel")).toContain("noopener");
  });

  it("a photo on the item that has one, with its credit; the others stay plain text", () => {
    const { panel } = make();
    render(panel, withPictures("done"));
    const item = panel.element.querySelector(".wx-srv-adv-pk-item");
    expect(item?.classList.contains("wx-srv-adv-pk-item-pic")).toBe(true);
    expect(item?.querySelector(".wx-srv-adv-pk-thumb img")?.getAttribute("src")).toBe("/m/tarts-t.jpg");
    expect(item?.querySelector(".wx-srv-adv-pk-credit")?.textContent).toContain("Photo: tarts / CC BY");
  });

  it("holds places for pictures while the server is still finding them", () => {
    const { panel } = make();
    render(panel, ready({ images: "pending", pictures: { hero: [pic("bay")], items: new Map() } }));
    expect(panel.element.querySelectorAll(".wx-srv-adv-hero-slide")).toHaveLength(3); // 1 photo + 2 placeholders
    expect(panel.element.querySelectorAll(".wx-srv-adv-hero-slide.wx-srv-adv-pic-pending")).toHaveLength(2);
    expect(panel.element.querySelector(".wx-srv-adv-pic-note")?.textContent).toBe("Finding photos…");
    expect(panel.element.querySelectorAll(".wx-srv-adv-pk-thumb.wx-srv-adv-pic-pending")).toHaveLength(1); // the item's
    // With no pictures at all yet, still three placeholders and the text is already readable.
    const none = make();
    render(none.panel, ready({ images: "pending", pictures: null }));
    expect(none.panel.element.querySelectorAll(".wx-srv-adv-hero-slide.wx-srv-adv-pic-pending")).toHaveLength(3);
    expect(none.panel.element.querySelector(".wx-srv-adv-pk-headline")?.textContent).toBe("Sun and tiles");
  });

  it("lays out gracefully without pictures: a server that has none, or a finished search that found none", () => {
    for (const pack of [ready({ images: "none", pictures: null }), ready({ images: "done", pictures: { hero: [], items: new Map() } })]) {
      const { panel } = make();
      render(panel, pack);
      expect(panel.element.querySelector(".wx-srv-adv-hero")).toBeNull();
      expect(panel.element.querySelector(".wx-srv-adv-pk-thumb")).toBeNull();
      expect(panel.element.querySelector(".wx-srv-adv-pk-item-pic")).toBeNull();
      expect(panel.element.querySelector(".wx-srv-adv-pk-headline")?.textContent).toBe("Sun and tiles");
    }
  });

  it("a picture that fails to load takes itself away rather than leaving a hole", () => {
    const { panel } = make();
    render(panel, withPictures("done"));
    const slideButton = panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic");
    slideButton?.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(slideButton?.hidden).toBe(true);
    const thumb = panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-pk-thumb");
    thumb?.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(thumb?.classList.contains("wx-srv-adv-pic-broken")).toBe(true);
  });
});

describe("the full-screen photo viewer", () => {
  const pack = (): PackView => ready({ images: "done", pictures: { hero: [pic("bay"), pic("old-town"), pic("beach")], items: new Map([["food:0", pic("tarts")]]) } });

  it("a tap on a hero photo opens it big, with its caption, credit and a source link", () => {
    const { panel } = make();
    render(panel, pack());
    expect(panel.isViewerOpen()).toBe(false);
    panel.element.querySelectorAll<HTMLButtonElement>(".wx-srv-adv-hero-pic")[1]?.click();
    expect(panel.isViewerOpen()).toBe(true);
    expect(panel.viewer.hidden).toBe(false);
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/old-town.jpg"); // the full-size file
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-caption")?.textContent).toBe("The old-town");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-credit-line")?.textContent).toContain("Photo: old-town / CC BY");
    const source = panel.viewer.querySelector<HTMLAnchorElement>(".wx-srv-adv-viewer-source");
    expect(source?.href).toBe("https://commons.example/old-town");
    expect(source?.target).toBe("_blank");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-count")?.textContent).toBe("2 / 3");
  });

  it("Next and Previous wrap around the photos of that group", () => {
    const { panel } = make();
    render(panel, pack());
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic")?.click();
    const next = panel.viewer.querySelector<HTMLButtonElement>(".wx-srv-adv-viewer-next")!;
    const prev = panel.viewer.querySelector<HTMLButtonElement>(".wx-srv-adv-viewer-prev")!;
    next.click();
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/old-town.jpg");
    next.click();
    next.click();
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/bay.jpg"); // wrapped
    prev.click();
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/beach.jpg");
  });

  it("a single photo has no arrows or counter; the close button and the dark around the photo close it", () => {
    const { panel } = make();
    render(panel, ready({ images: "done", pictures: { hero: [], items: new Map([["food:0", pic("tarts")]]) } }));
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-pk-thumb")?.click();
    expect(panel.viewer.querySelector<HTMLButtonElement>(".wx-srv-adv-viewer-next")?.hidden).toBe(true);
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-count")?.textContent).toBe("");
    panel.viewer.querySelector<HTMLButtonElement>(".wx-srv-adv-viewer-close")?.click();
    expect(panel.isViewerOpen()).toBe(false);
    expect(panel.viewer.querySelector("img")?.hasAttribute("src")).toBe(false); // the file is let go
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-pk-thumb")?.click();
    const stage = panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-stage")!;
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { clientX: 102, bubbles: true }));
    expect(panel.isViewerOpen()).toBe(false);
  });

  it("a swipe on the photo moves to the next or previous one", () => {
    const { panel } = make();
    render(panel, pack());
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic")?.click();
    const stage = panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-stage")!;
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: 300, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { clientX: 200, bubbles: true }));
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/old-town.jpg");
    stage.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
    stage.dispatchEvent(new MouseEvent("pointerup", { clientX: 220, bubbles: true }));
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/bay.jpg");
  });

  it("Escape does not close it (Escape is the chat's panic key)", () => {
    const { panel } = make();
    render(panel, pack());
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic")?.click();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    panel.viewer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(panel.isViewerOpen()).toBe(true);
    expect(escape.defaultPrevented).toBe(false); // nothing swallowed it
  });

  it("stays open when more pictures arrive for the same round, and closes when the round changes or on reset", () => {
    const { panel } = make();
    render(panel, ready({ images: "pending", pictures: { hero: [pic("bay")], items: new Map() } }));
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic")?.click();
    render(panel, pack()); // the rest arrived
    expect(panel.isViewerOpen()).toBe(true);
    render(panel, pack(), 8); // another round
    expect(panel.isViewerOpen()).toBe(false);
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic")?.click();
    expect(panel.isViewerOpen()).toBe(true);
    panel.reset();
    expect(panel.isViewerOpen()).toBe(false);
    expect(panel.element.textContent).toBe("");
  });
});

describe("Local food to try: the dishes grid", () => {
  const dishPic = (name: string): PackPicture => pic(name, { caption: `The ${name}`, credit: `${name} / CC BY-SA` });
  /** Photos for dishes 0, 1 and 3; dishes 2 and 4 have none. */
  const photos = (images: PackView["images"] = "done"): PackView =>
    dishesPack({
      images,
      pictures: {
        hero: [pic("bay")],
        items: new Map([
          ["dishes:0", dishPic("pastel")],
          ["dishes:1", dishPic("caldo")],
          ["dishes:3", dishPic("ginjinha")],
        ]),
      },
    });
  const tiles = (panel: PackPanel): HTMLElement[] => [...panel.element.querySelectorAll<HTMLElement>(".wx-srv-adv-dish")];

  it("comes straight after the hero carousel and the summary, before every other section; food is 'Where to eat'", () => {
    const { panel } = make();
    render(panel, photos());
    const content = panel.element.firstElementChild!;
    const order = [...content.children].map((c) => c.className.split(" ")[0]);
    expect(order.slice(0, 5)).toEqual(["wx-srv-adv-hero", "wx-srv-adv-pk-place", "wx-srv-adv-pk-headline", "wx-srv-adv-pk-summary", "wx-srv-adv-dishes"]);
    expect([...panel.element.querySelectorAll(".wx-srv-adv-pk-title")].map((n) => n.textContent)).toEqual([
      "Local food to try",
      "Where to eat",
      "Best time to go",
      "Getting there",
      "Travel advice",
      "Sources",
    ]);
    // The dishes are not ALSO drawn as a list card.
    expect(panel.element.querySelector(".wx-srv-adv-pk-dishes")).toBeNull();
  });

  it("is shown first even when the section is not first in the list, and exactly once", () => {
    const { panel } = make();
    const pack = dishesPack();
    const data = pack.data!;
    const [dishes, ...rest] = data.sections;
    render(panel, { ...pack, data: { ...data, sections: [...rest, dishes!] } });
    expect(panel.element.querySelectorAll(".wx-srv-adv-dishes")).toHaveLength(1);
    expect(panel.element.querySelector(".wx-srv-adv-summary + .wx-srv-adv-dishes, .wx-srv-adv-pk-summary + .wx-srv-adv-dishes")).not.toBeNull();
  });

  it("is a photo-forward grid: a square photo, the dish's name and one line of what it is, per dish", () => {
    const { panel } = make();
    render(panel, photos());
    const all = tiles(panel);
    expect(all).toHaveLength(5);
    expect(panel.element.querySelector(".wx-srv-adv-dish-grid")).not.toBeNull();
    const first = all[0]!;
    expect(first.querySelector(".wx-srv-adv-dish-frame img")?.getAttribute("src")).toBe("/m/pastel-t.jpg"); // the small rendition
    expect(first.querySelector(".wx-srv-adv-dish-name")?.textContent).toBe("Pastel de nata");
    expect(first.querySelector(".wx-srv-adv-dish-detail")?.textContent).toBe("A custard tart with a blistered top, best warm with cinnamon.");
    expect(first.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    expect(first.getAttribute("aria-label")).toContain("Pastel de nata");
    expect(first.classList.contains("wx-srv-adv-dish-nophoto")).toBe(false);
  });

  it("a dish with no photo is a tasteful text tile in the same grid (name below, its description on the tile)", () => {
    const { panel } = make();
    render(panel, photos("done"));
    const bacalhau = tiles(panel)[2]!;
    expect(bacalhau.classList.contains("wx-srv-adv-dish-nophoto")).toBe(true);
    expect(bacalhau.querySelector(".wx-srv-adv-dish-frame")?.classList.contains("wx-srv-adv-dish-text")).toBe(true);
    expect(bacalhau.querySelector("img")).toBeNull();
    expect(bacalhau.querySelector(".wx-srv-adv-dish-blurb")?.textContent).toBe("Salt cod baked in a creamy sauce.");
    expect(bacalhau.querySelector(".wx-srv-adv-dish-name")?.textContent).toBe("Bacalhau com natas");
    // The grid keeps its place: the five tiles are all there, in the server's order.
    expect(tiles(panel).map((t) => t.querySelector(".wx-srv-adv-dish-name")?.textContent)).toEqual(["Pastel de nata", "Caldo verde", "Bacalhau com natas", "Ginjinha", "Bifana"]);
  });

  it("while the server is still finding photos a dish without one shimmers (not the text tile yet)", () => {
    const { panel } = make();
    render(panel, photos("pending"));
    const bacalhau = tiles(panel)[2]!;
    expect(bacalhau.classList.contains("wx-srv-adv-dish-pending")).toBe(true);
    expect(bacalhau.querySelector(".wx-srv-adv-pic-pending")).not.toBeNull();
    expect(bacalhau.querySelector(".wx-srv-adv-dish-blurb")).toBeNull();
    expect(bacalhau.querySelector(".wx-srv-adv-dish-name")?.textContent).toBe("Bacalhau com natas"); // the words are already readable
    // A dish that has its photo already shows it.
    expect(tiles(panel)[0]!.querySelector("img")).not.toBeNull();
    // With the search finished the shimmer becomes the text tile.
    render(panel, photos("done"));
    expect(tiles(panel)[2]!.classList.contains("wx-srv-adv-dish-nophoto")).toBe(true);
  });

  it("lays out with no pictures at all (an older server): every dish is a text tile", () => {
    const { panel } = make();
    render(panel, dishesPack({ images: "none", pictures: null }));
    expect(tiles(panel)).toHaveLength(5);
    expect(tiles(panel).every((t) => t.classList.contains("wx-srv-adv-dish-nophoto"))).toBe(true);
  });

  it("a pack without a dishes section is still valid and shows none of this", () => {
    const { panel } = make();
    render(panel, readyPack());
    expect(panel.element.querySelector(".wx-srv-adv-dishes")).toBeNull();
    expect(panel.element.querySelector(".wx-srv-adv-pk-headline")?.textContent).toBe("Sun and tiles");
  });

  it("a photo that fails to load turns its dish into the text tile, not a hole", () => {
    const { panel } = make();
    render(panel, photos());
    const first = tiles(panel)[0]!;
    first.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(first.classList.contains("wx-srv-adv-dish-nophoto")).toBe(true);
    expect(first.querySelector("img")).toBeNull();
    expect(first.querySelector(".wx-srv-adv-dish-blurb")?.textContent).toContain("custard tart");
  });

  it("a tap opens the full-screen viewer on that dish: the photo, its credit and the dish's whole description", () => {
    const { panel } = make();
    render(panel, photos());
    tiles(panel)[1]!.click();
    expect(panel.isViewerOpen()).toBe(true);
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/caldo.jpg"); // the large rendition
    expect(panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-img")?.hidden).toBe(false);
    expect(panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-tile")?.hidden).toBe(true);
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-caption")?.textContent).toBe("Caldo verde");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-detail")?.textContent).toBe("Kale and potato soup with a slice of chorizo.");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-credit-line")?.textContent).toContain("Photo: caldo / CC BY-SA");
    const source = panel.viewer.querySelector<HTMLAnchorElement>(".wx-srv-adv-viewer-source");
    expect(source?.href).toBe("https://commons.example/caldo");
    expect(source?.rel).toContain("noopener");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-count")?.textContent).toBe("2 / 5");
  });

  it("a dish with no photo opens the same viewer on a tile, with its description", () => {
    const { panel } = make();
    render(panel, photos());
    tiles(panel)[2]!.click();
    expect(panel.isViewerOpen()).toBe(true);
    expect(panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-img")?.hidden).toBe(true);
    expect(panel.viewer.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-tile")?.hidden).toBe(false);
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-caption")?.textContent).toBe("Bacalhau com natas");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-detail")?.textContent).toBe("Salt cod baked in a creamy sauce.");
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-credit-line")).toBeNull(); // nothing to credit
  });

  it("Next and Previous walk the dishes, photo or not, and wrap around", () => {
    const { panel } = make();
    render(panel, photos());
    tiles(panel)[0]!.click();
    const next = panel.viewer.querySelector<HTMLButtonElement>(".wx-srv-adv-viewer-next")!;
    const prev = panel.viewer.querySelector<HTMLButtonElement>(".wx-srv-adv-viewer-prev")!;
    const caption = (): string | null | undefined => panel.viewer.querySelector(".wx-srv-adv-viewer-caption")?.textContent;
    next.click();
    next.click(); // dish 2, no photo
    expect(caption()).toBe("Bacalhau com natas");
    expect(panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-tile")?.hidden).toBe(false);
    next.click(); // dish 3, a photo again: the picture comes back
    expect(caption()).toBe("Ginjinha");
    expect(panel.viewer.querySelector("img")?.getAttribute("src")).toBe("/m/ginjinha.jpg");
    expect(panel.viewer.querySelector<HTMLElement>(".wx-srv-adv-viewer-tile")?.hidden).toBe(true);
    next.click();
    next.click(); // wrapped to dish 0
    expect(caption()).toBe("Pastel de nata");
    prev.click(); // and back to the last
    expect(caption()).toBe("Bifana");
  });

  it("the dishes' viewer is its own group: the hero photos and the other sections' photos are not in it", () => {
    const { panel } = make();
    render(panel, photos());
    panel.element.querySelector<HTMLButtonElement>(".wx-srv-adv-hero-pic")?.click();
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-count")?.textContent).toBe(""); // one hero photo only
    panel.closeViewer();
    tiles(panel)[0]!.click();
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-count")?.textContent).toBe("1 / 5");
  });

  it("keeps an open viewer when the pictures arrive (the same round is redrawn, not reset)", () => {
    const { panel } = make();
    render(panel, dishesPack({ images: "pending", pictures: { hero: [], items: new Map([["dishes:0", dishPic("pastel")]]) } }));
    tiles(panel)[0]!.click();
    render(panel, photos("done"));
    expect(panel.isViewerOpen()).toBe(true);
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-caption")?.textContent).toBe("Pastel de nata");
  });

  it("sets dish text as text, never as markup", () => {
    const { panel } = make();
    const hostile = dishesPack();
    const data = hostile.data!;
    const [dishes, ...rest] = data.sections;
    const evil = { ...dishes!, items: [{ index: 0, name: "<img src=x onerror=\"window.__dish=1\">Nata", detail: "<script>window.__dish=2</script>", url: null }] };
    render(panel, { ...hostile, data: { ...data, sections: [evil, ...rest] } });
    expect(panel.element.querySelectorAll(".wx-srv-adv-dish img, script")).toHaveLength(0);
    tiles(panel)[0]!.click();
    expect(panel.viewer.querySelectorAll("script")).toHaveLength(0);
    expect(panel.viewer.querySelector(".wx-srv-adv-viewer-caption")?.textContent).toContain("<img src=x");
    expect((window as unknown as { __dish?: number }).__dish).toBeUndefined();
  });
});
