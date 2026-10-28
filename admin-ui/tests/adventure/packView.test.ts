import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePack, type PackPicture, type PackView } from "../../src/server/adventure/api";
import { createPackPanel, type PackPanel, type PackPanelDeps } from "../../src/server/adventure/packView";
import { DEST_A, NO_PACK, readyPack } from "./adventureFixtures";

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
    expect([...root.querySelectorAll(".wx-srv-adv-pk-title")].map((n) => n.textContent)).toEqual(["Food", "Best time to go", "Getting there", "Travel advice", "Sources"]);
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
