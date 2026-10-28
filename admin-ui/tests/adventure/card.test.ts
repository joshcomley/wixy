import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/server/api/messages";
import { adventureStatusLine, createAdventureCards, drawUnitMap } from "../../src/server/adventure/adventureCard";
import { prepareLanding } from "../../src/server/adventure/land";
import { createAdventureModel, type AdventureModel } from "../../src/server/adventure/model";
import type { World } from "../../src/server/adventure/world";
import { recordingContext } from "../fixtures/stubContext";
import { DEST_A, NOW, dishesPack, readyPack, spin, testWorld, view } from "./adventureFixtures";

let world: World;
beforeAll(() => {
  world = testWorld();
  prepareLanding(world);
});
beforeEach(() => {
  // jsdom has no canvas: say so quietly (a test that wants a context installs its own spy).
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function message(seq = 7, adventure: Message["adventure"] = { state: "spin_lng", pack: "none", rev: 1 }): Message {
  return { seq, clientId: `c${seq}`, sender: "Ann", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, adventure };
}

function modelWith(...views: ReturnType<typeof view>[]): AdventureModel {
  const model = createAdventureModel({
    session: () => ({ token: "t", expiresAt: 1 }),
    fetchRound: async () => ({ ok: false, kind: "unavailable" }),
    onChange: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  for (const v of views) model.apply(v);
  return model;
}

describe("the card's status line", () => {
  const landed = spin("Bea", -15, 900, 4000, NOW - 60);
  it("says one plain thing for every state of the round", () => {
    expect(adventureStatusLine(view("spin_lng"), { state: "spin_lng", pack: "none", rev: 1 })).toBe("Spin the globe!");
    expect(adventureStatusLine(view("spin_lat"), null)).toBe("Spinning…");
    expect(adventureStatusLine(view("country", { lat: landed }), null)).toBe("Landed near Aland");
    expect(adventureStatusLine(view("destination", { lat: landed }), null)).toBe("Aland: picking a place…");
    expect(adventureStatusLine(view("chosen", { lat: landed }), null)).toBe("Alpha, Aland: preparing the holiday pack");
    expect(adventureStatusLine(view("chosen", { lat: landed, pack: readyPack() }), null)).toBe("Alpha, Aland: Sun and tiles");
    expect(adventureStatusLine(view("chosen", { lat: landed, pack: { ...readyPack(), state: "failed", data: null } }), null)).toBe("Alpha, Aland: the research didn't finish");
    expect(adventureStatusLine(view("chosen", { lat: landed, pack: { ...readyPack(), state: "unavailable", data: null } }), null)).toBe("Alpha, Aland");
    expect(adventureStatusLine(view("banked", { lat: landed, pack: readyPack() }), null)).toBe("Banked ✓ Alpha, Aland: Sun and tiles");
    expect(adventureStatusLine(view("banked", { lat: landed }), null)).toBe("Banked ✓ Alpha, Aland");
    expect(adventureStatusLine(view("rejected", { lat: landed }), null)).toBe("Not for us: Alpha");
    expect(adventureStatusLine(view("abandoned"), null)).toBe("Replaced by a newer adventure");
  });

  it("falls back to the message's own summary until the view has been read", () => {
    expect(adventureStatusLine(undefined, null)).toBe("Adventure Time");
    expect(adventureStatusLine(undefined, { state: "chosen", pack: "pending", rev: 3 })).toBe("Loading…");
    expect(adventureStatusLine(undefined, { state: "banked", pack: "ready", rev: 3 })).toBe("Banked ✓");
    expect(adventureStatusLine(undefined, { state: "rejected", pack: "none", rev: 3 })).toBe("Not for us");
    expect(adventureStatusLine(undefined, { state: "abandoned", pack: "none", rev: 3 })).toBe("Replaced by a newer adventure");
  });
});

describe("the main-chat card", () => {
  function make(model: AdventureModel, loadWorld: () => Promise<World> = () => Promise.resolve(world)) {
    const openGame = vi.fn();
    const cards = createAdventureCards({ model, document, openGame, loadWorld });
    return { cards, openGame };
  }

  it("shows the title, one line of status and a Play button that opens the game tab", () => {
    const { cards, openGame } = make(modelWith(view("spin_lng")));
    const card = cards.create(message());
    document.body.append(card);
    expect(card.querySelector(".wx-srv-adv-mcard-title")?.textContent).toBe("Adventure Time");
    expect(card.querySelector(".wx-srv-adv-mcard-status")?.textContent).toBe("Spin the globe!");
    const open = card.querySelector<HTMLButtonElement>(".wx-srv-adv-mcard-open")!;
    expect(open.textContent).toBe("Play");
    expect(open.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    open.click();
    expect(openGame).toHaveBeenCalledWith(7);
  });

  it("says Open once the trip is decided, and has no button for a replaced adventure", () => {
    const banked = make(modelWith(view("banked", { lat: spin("Bea", -15, 900, 4000, NOW - 60) })));
    expect(banked.cards.create(message(7, { state: "banked", pack: "pending", rev: 4 })).querySelector(".wx-srv-adv-mcard-open")?.textContent).toBe("Open");
    const gone = make(modelWith(view("abandoned")));
    expect(gone.cards.create(message(7, { state: "abandoned", pack: "none", rev: 2 })).querySelector(".wx-srv-adv-mcard-open")).toBeNull();
  });

  it("is text only before the view is known, and when it is, redraws in place for the same container", () => {
    const model = modelWith();
    const { cards } = make(model);
    const container = cards.create(message());
    expect(container.querySelector(".wx-srv-adv-mcard-status")?.textContent).toBe("Loading…");
    expect(container.querySelector("canvas")).toBeNull();
    model.apply(view("chosen", { lat: spin("Bea", -15, 900, 4000, NOW - 60) }));
    cards.render(container, message(7, { state: "chosen", pack: "pending", rev: 3 }));
    expect(container.querySelector(".wx-srv-adv-mcard-status")?.textContent).toBe("Alpha, Aland: preparing the holiday pack");
    expect(container.dataset["advState"]).toBe("chosen");
    expect(container.dataset["advSeq"]).toBe("7");
    expect(container.querySelectorAll(".wx-srv-adv-mcard-title")).toHaveLength(1); // replaced, not appended
  });

  it("paints a small map of the country with the destination dot once the world has loaded", async () => {
    const rec = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => (kind === "2d" ? rec.ctx : null)) as never);
    let resolve!: (w: World) => void;
    const loading = new Promise<World>((r) => {
      resolve = r;
    });
    const { cards } = make(modelWith(view("chosen", { lat: spin("Bea", -15, 900, 4000, NOW - 60) })), () => loading);
    const card = cards.create(message(7, { state: "chosen", pack: "pending", rev: 3 }));
    document.body.append(card);
    const map = card.querySelector<HTMLCanvasElement>(".wx-srv-adv-mcard-map")!;
    expect(map.hidden).toBe(true); // text first: no map yet
    resolve(world);
    await loading;
    await Promise.resolve();
    expect(map.hidden).toBe(false);
    expect(rec.count("fillRect")).toBe(1); // the ocean
    expect(rec.count("arc")).toBe(1); // the destination dot
    expect(rec.count("fill")).toBeGreaterThanOrEqual(2); // land, dot
    expect(map.getAttribute("aria-label")).toBe("Map showing Alpha");
  });

  it("stays text only when the map cannot load, and a later card tries again", async () => {
    const loadWorld = vi.fn<() => Promise<World>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(world);
    const { cards } = make(modelWith(view("chosen", { lat: spin("Bea", -15, 900, 4000, NOW - 60) })), loadWorld);
    const first = cards.create(message());
    await Promise.resolve();
    await Promise.resolve();
    expect(first.querySelector<HTMLCanvasElement>(".wx-srv-adv-mcard-map")?.hidden).toBe(true);
    cards.create(message());
    expect(loadWorld).toHaveBeenCalledTimes(2);
  });
});

describe("the card's dish photo", () => {
  const landed = spin("Bea", -15, 900, 4000, NOW - 60);
  const withDishPhotos = (items: Record<string, string>, state: "chosen" | "banked" = "chosen") =>
    view(state, {
      lat: landed,
      pack: dishesPack({
        images: "done",
        pictures: {
          hero: [{ thumbUrl: "/m/hero-t.jpg", fullUrl: "/m/hero.jpg", credit: "", page: null, caption: "" }],
          items: new Map(Object.entries(items).map(([key, name]) => [key, { thumbUrl: `/m/${name}-t.jpg`, fullUrl: `/m/${name}.jpg`, credit: "", page: null, caption: "" }])),
        },
      }),
    });
  function make(v: ReturnType<typeof view>) {
    const cards = createAdventureCards({ model: modelWith(v), document, openGame: vi.fn(), loadWorld: () => Promise.resolve(world) });
    return cards.create(message(7, { state: v.state, pack: "ready", rev: 3 }));
  }

  it("shows the first dish photo once the pack has one, above the little map", () => {
    const card = make(withDishPhotos({ "dishes:2": "bacalhau", "dishes:1": "caldo" }));
    const media = card.querySelector(".wx-srv-adv-mcard-media")!;
    const img = media.querySelector<HTMLImageElement>("img.wx-srv-adv-mcard-dish")!;
    expect(img.getAttribute("src")).toBe("/m/caldo-t.jpg"); // the lowest-indexed dish with a photo, the small rendition
    expect(img.alt).toBe("A dish to try");
    expect(media.firstElementChild).toBe(img);
    expect(media.querySelector("canvas.wx-srv-adv-mcard-map")).not.toBeNull();
    expect(card.firstElementChild).toBe(media); // the pictures are in front of the words
  });

  it("shows no dish photo before the pack is ready, when no dish has one, or for a hero or other section's photo", () => {
    const pending = make(view("chosen", { lat: landed }));
    expect(pending.querySelector(".wx-srv-adv-mcard-dish")).toBeNull();
    const none = make(withDishPhotos({}));
    expect(none.querySelector(".wx-srv-adv-mcard-dish")).toBeNull();
    const other = make(withDishPhotos({ "food:0": "tarts" }));
    expect(other.querySelector(".wx-srv-adv-mcard-dish")).toBeNull();
    // The map still shows, as before.
    expect(other.querySelector("canvas.wx-srv-adv-mcard-map")).not.toBeNull();
  });

  it("keeps it on a banked trip, and a photo that will not load leaves the card as it was", () => {
    const card = make(withDishPhotos({ "dishes:0": "pastel" }, "banked"));
    const img = card.querySelector<HTMLImageElement>(".wx-srv-adv-mcard-dish")!;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event("error"));
    expect(card.querySelector(".wx-srv-adv-mcard-dish")).toBeNull();
    expect(card.querySelector(".wx-srv-adv-mcard-map")).not.toBeNull();
    expect(card.querySelector(".wx-srv-adv-mcard-status")).not.toBeNull();
  });
});

describe("drawing a country's map", () => {
  it("paints the unit and the dot, and says no for a unit the world does not have or a canvas without a context", () => {
    const rec = recordingContext();
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => rec.ctx) as never;
    expect(drawUnitMap(canvas, world, "AAA", [DEST_A.lng, DEST_A.lat], 2)).toBe(true);
    expect(canvas.width).toBe(192); // 96 css px at a device pixel ratio of 2
    expect(canvas.height).toBe(144);
    expect(rec.count("fillRect")).toBe(1);
    expect(drawUnitMap(canvas, world, "ZZZ", null)).toBe(false);
    const none = document.createElement("canvas");
    none.getContext = (() => null) as never;
    expect(drawUnitMap(none, world, "AAA", null)).toBe(false);
  });

  it("widens the view to hold a destination far from the country's main land", () => {
    const near = recordingContext();
    const far = recordingContext();
    const a = document.createElement("canvas");
    a.getContext = (() => near.ctx) as never;
    const b = document.createElement("canvas");
    b.getContext = (() => far.ctx) as never;
    expect(drawUnitMap(a, world, "AAA", [5, 5])).toBe(true);
    expect(drawUnitMap(b, world, "AAA", [35, -5])).toBe(true); // an island in the next country's area
    expect(near.count("arc")).toBe(1);
    expect(far.count("arc")).toBe(1); // still visible: the camera reached for it
  });
});
