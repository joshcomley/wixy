// The preview page's holiday-pack panel (admin-ui/dev/preview/pack.ts): the "Local food to try" grid of
// spec 4.3b. The page itself is not shipped, but the same rendering rules go into the pane, so they are tested.

import { afterEach, describe, expect, it } from "vitest";
import { normalizePack, normalizePhoto, type Dest, type Pack } from "../../dev/preview/data";
import { firstSentence, renderPack, tintFor, wikipediaUrl } from "../../dev/preview/pack";

const dest: Dest = { id: "X.kotor", name: "Kotor", region: "Bay of Kotor", lat: 42.4, lng: 18.77, kind: "city", blurb: "x" };

const photo = { file: "dish-a.jpg", credit: "A / CC BY-SA 4.0 via Wikimedia Commons", creditUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", alt: "A" };

function rawPack(): Record<string, unknown> {
  return {
    headline: "Kotor",
    summary: "A walled town.",
    hero: [photo],
    sections: [
      { key: "food", title: "Food and drink", items: [{ name: "Galion", detail: "Harbour-side.", url: "https://example.com" }] },
      {
        key: "dishes",
        title: "Local food to try",
        items: [
          { name: "Black risotto", detail: "Rice with cuttlefish ink. Jet black and briny.", wikipedia: null, photo },
          { name: "Buzara", detail: "Mussels in garlic and wine.", wikipedia: "" },
          { name: "Vranac", detail: "Montenegro's red wine.", wikipedia: "Vranac", photo: { ...photo, file: "dish-v.jpg" } },
        ],
      },
      { key: "stay", title: "Where to stay", items: [{ name: "A villa", detail: "Pool.", url: null }] },
    ],
    bestTime: "May.",
    gettingThere: "Fly.",
    travelAdvice: "Check.",
    sources: [],
  };
}

afterEach(() => {
  // The sheet and the viewer are page-level singletons that stay mounted; only the pack itself is replaced.
  for (const el of document.querySelectorAll(".pk")) el.remove();
  for (const el of document.querySelectorAll<HTMLElement>(".dish-sheet, .viewer")) el.hidden = true;
});

describe("helpers", () => {
  it("firstSentence takes the first sentence, or the whole text without one", () => {
    expect(firstSentence("Rice with ink. Jet black.")).toBe("Rice with ink.");
    expect(firstSentence("No full stop here")).toBe("No full stop here");
    expect(firstSentence("  Spaced out!  Next. ")).toBe("Spaced out!");
  });

  it("tintFor is stable for a name and stays inside the warm hues", () => {
    expect(tintFor("Buzara")).toBe(tintFor("Buzara"));
    for (const name of ["Buzara", "Kačamak", "Priganice", "x"]) {
      const hue = tintFor(name);
      expect(hue).toBeGreaterThanOrEqual(8);
      expect(hue).toBeLessThanOrEqual(44);
    }
  });

  it("wikipediaUrl builds an English Wikipedia link, percent-encoded, or nothing", () => {
    expect(wikipediaUrl("Njeguški pršut")).toBe("https://en.wikipedia.org/wiki/Njegu%C5%A1ki_pr%C5%A1ut");
    expect(wikipediaUrl("Vranac")).toBe("https://en.wikipedia.org/wiki/Vranac");
    expect(wikipediaUrl(null)).toBeNull();
    expect(wikipediaUrl("  ")).toBeNull();
  });
});

describe("normalizePack", () => {
  it("keeps a dish's wikipedia title and photo, and treats a blank title as none", () => {
    const pack = normalizePack(rawPack());
    const dishes = pack.sections.find((s) => s.key === "dishes");
    expect(dishes?.items.map((i) => i.wikipedia)).toEqual([null, null, "Vranac"]);
    expect(dishes?.items[0]?.photo?.credit).toContain("CC BY-SA 4.0");
    expect(dishes?.items[1]?.photo).toBeNull();
  });

  it("accepts photos spelled other ways and drops unusable ones", () => {
    expect(normalizePhoto("x.jpg", "alt")?.src).toBe("x.jpg");
    expect(normalizePhoto({ src: "a.jpg", credit: "C", license: "CC0" }, "alt")?.credit).toBe("C, CC0");
    expect(normalizePhoto({ credit: "no src" }, "alt")).toBeNull();
    expect(normalizePhoto(42, "alt")).toBeNull();
  });
});

describe("renderPack: Local food to try", () => {
  function render(pack: Pack = normalizePack(rawPack())): HTMLElement {
    const root = renderPack(pack, dest, "Montenegro", false);
    document.body.append(root);
    return root;
  }

  it("puts the dishes grid straight after the summary, before every other section, wherever the pack lists it", () => {
    const root = render();
    const body = root.querySelector(".pk-body") as HTMLElement;
    const order = [...body.children].map((c) => c.className.split(" ")[0]);
    expect(order.indexOf("pk-dishes")).toBeGreaterThan(order.indexOf("pk-summary"));
    expect(order.indexOf("pk-dishes")).toBe(order.indexOf("pk-summary") + 1);
    expect(order.indexOf("pk-dishes")).toBeLessThan(order.indexOf("pk-card"));
    expect(root.querySelector(".pk-dishes-title")?.textContent).toContain("Local food to try");
  });

  it("makes a card per dish: a photo card where there is a picture, a text card where there is not", () => {
    const root = render();
    const cards = [...root.querySelectorAll<HTMLElement>(".dish-card")];
    expect(cards.map((c) => c.querySelector(".dish-name")?.textContent)).toEqual(["Black risotto", "Buzara", "Vranac"]);
    expect(cards.map((c) => c.classList.contains("dish-has-photo"))).toEqual([true, false, true]);
    expect(cards[1]?.classList.contains("dish-text")).toBe(true);
    expect(cards[1]?.style.getPropertyValue("--dish-hue")).not.toBe("");
    expect(cards[0]?.querySelector(".dish-line")?.textContent).toBe("Rice with cuttlefish ink.");
  });

  it("retitles the food section 'Where to eat' whatever the pack calls it", () => {
    const root = render();
    const titles = [...root.querySelectorAll(".pk-card h3")].map((h) => h.textContent);
    expect(titles.some((t) => t?.includes("Where to eat"))).toBe(true);
    expect(titles.some((t) => t?.includes("Food and drink"))).toBe(false);
  });

  it("a pack with no dishes section renders without a grid", () => {
    const raw = rawPack();
    raw["sections"] = (raw["sections"] as Array<{ key: string }>).filter((s) => s.key !== "dishes");
    const root = render(normalizePack(raw));
    expect(root.querySelector(".pk-dishes")).toBeNull();
  });

  it("tapping a dish opens its sheet with the full detail, the credit and a Wikipedia link", () => {
    const root = render();
    (root.querySelectorAll<HTMLElement>(".dish-card")[2] as HTMLElement).click();
    const sheet = document.querySelector(".dish-sheet") as HTMLElement;
    expect(sheet.hidden).toBe(false);
    expect(sheet.querySelector(".dish-sheet-name")?.textContent).toBe("Vranac");
    expect(sheet.querySelector(".dish-sheet-detail")?.textContent).toBe("Montenegro's red wine.");
    expect(sheet.querySelector(".dish-sheet-credit")?.textContent).toContain("CC BY-SA 4.0");
    const wiki = sheet.querySelector<HTMLAnchorElement>(".dish-sheet-wiki a");
    expect(wiki?.href).toBe("https://en.wikipedia.org/wiki/Vranac");
    expect(wiki?.target).toBe("_blank");
    expect(wiki?.rel).toBe("noopener noreferrer");
  });

  it("a dish without a photo opens a sheet without a picture, and without a Wikipedia link", () => {
    const root = render();
    (root.querySelectorAll<HTMLElement>(".dish-card")[1] as HTMLElement).click();
    const sheet = document.querySelector(".dish-sheet") as HTMLElement;
    expect((sheet.querySelector(".dish-sheet-photo-host") as HTMLElement).hidden).toBe(true);
    expect(sheet.querySelector(".dish-sheet-wiki a")).toBeNull();
    expect(sheet.querySelector(".dish-sheet-credit")?.textContent).toBe("");
  });

  it("tapping the sheet's photo opens the full-screen viewer at that photo, with its credit", () => {
    const root = render();
    (root.querySelectorAll<HTMLElement>(".dish-card")[0] as HTMLElement).click();
    (document.querySelector(".dish-sheet-photo") as HTMLElement).click();
    const viewer = document.querySelector(".viewer") as HTMLElement;
    expect(viewer.hidden).toBe(false);
    // hero (1 photo) + dish photos (2): three slides
    expect(viewer.querySelectorAll(".viewer-slide").length).toBe(3);
  });

  it("a dish photo that fails to load turns its card into a text card (no hole in the grid)", () => {
    const root = render();
    const card = root.querySelectorAll<HTMLElement>(".dish-card")[0] as HTMLElement;
    card.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(card.classList.contains("dish-text")).toBe(true);
    expect(card.classList.contains("dish-has-photo")).toBe(false);
    expect(card.querySelector(".dish-photo")).toBeNull();
    expect(card.querySelector(".dish-name")?.textContent).toBe("Black risotto");
  });

  it("only ever links http(s): a javascript: URL in a pack becomes plain text", () => {
    const raw = rawPack();
    (raw["sections"] as Array<{ items: Array<Record<string, unknown>> }>)[0]?.items.push({ name: "Evil", detail: "x", url: "javascript:alert(1)" });
    const root = render(normalizePack(raw));
    expect([...root.querySelectorAll("a")].every((a) => a.href.startsWith("http"))).toBe(true);
  });
});
