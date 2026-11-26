import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobeFrame, GlobeRenderer } from "../../src/server/adventure/globe";
import type { MapStyle } from "../../src/server/adventure/imagery";
import type { World } from "../../src/server/adventure/world";
import { EMPTY_BANK_TEXT, FOOTER_TEXT, MISSING_TITLE, PAGE_TITLE, mountPublicApp, type PublicApp } from "../../src/public/app";
import type { BootInfo } from "../../src/public/boot";
import { BANKED_KEY, REJECTED_KEY } from "../../src/public/memory";
import { testWorld } from "../adventure/adventureFixtures";
import { T0, fakeStorage, fixtureBankJson, landingResult, packView, readyPackView } from "./publicFixtures";

let world: World;
beforeAll(() => {
  world = testWorld();
});
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.history.replaceState(null, "", "/");
  document.title = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}
const tick = (ms = 15): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

const ORIGIN = "https://adventure.cinnamons.uk";
const BOOT: BootInfo = { code: null, origin: ORIGIN, assets: { world: "/assets/world.json", satellite: "/assets/satellite.webp", atlas: "/assets/atlas.webp" } };

function stubRenderer(): GlobeRenderer {
  const state = { style: "classic" as MapStyle };
  return {
    draw: vi.fn<(frame: GlobeFrame, nowMs: number) => void>(),
    resize: vi.fn(),
    destroy: vi.fn(),
    setMapStyle: vi.fn((style: MapStyle) => {
      state.style = style;
    }),
    project: () => null,
    invert: () => null,
    lastLevel: "coarse" as const,
    get mapStyle() {
      return state.style;
    },
    imageryAvailable: true,
    textured: false,
  } as unknown as GlobeRenderer;
}

interface Rig {
  app: PublicApp;
  root: HTMLElement;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  storage: Storage;
  clock: { t: number };
  /** Runs `ms` of local time through the pane's frames and the app's timers. */
  advance(ms: number): Promise<void>;
  q<T extends Element = HTMLElement>(selector: string): T;
  maybe(selector: string): Element | null;
  text(selector: string): string;
  paneFact(name: string): string;
}

function packJson(view: ReturnType<typeof packView>, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ code: "x", destinationId: "x", state: view.state, data: view.data, error: view.error, canRetry: view.canRetry, images: view.images, pictures: { hero: [], items: {} }, retryAfterS: null, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function mount(
  options: {
    boot?: Partial<BootInfo>;
    storage?: Storage | null;
    bank?: () => Promise<Response>;
    pack?: (method: string, code: string) => Response;
    wait?: boolean;
  } = {},
): Promise<Rig> {
  const root = document.createElement("div");
  root.id = "adventure-public-root";
  document.body.append(root);
  const storage = options.storage === undefined ? fakeStorage() : (options.storage ?? fakeStorage());
  const clock = { t: T0 };
  const frames = new Map<number, (nowMs: number) => void>();
  const timers: Array<{ id: number; at: number; fn: () => void; live: boolean }> = [];
  let ids = 0;
  const calls = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/bank") return options.bank !== undefined ? options.bank() : new Response(JSON.stringify(fixtureBankJson()), { status: 200, headers: { "Content-Type": "application/json" } });
    const m = /^\/api\/pack\/([a-z0-9]+)$/.exec(url);
    if (m !== null) {
      const method = init?.method ?? "GET";
      if (options.pack !== undefined) return options.pack(method, m[1] as string);
      return packJson(method === "POST" ? packView() : packView({ state: "none" }));
    }
    return new Response("nope", { status: 404 });
  });
  const app = mountPublicApp({
    document,
    win: window,
    root,
    boot: { ...BOOT, ...(options.boot ?? {}) },
    fetch: calls,
    storage: () => (options.storage === null ? null : storage),
    now: () => clock.t,
    random32: () => 4242,
    setTimeout: (fn, ms) => {
      ids += 1;
      timers.push({ id: ids, at: clock.t + ms, fn, live: true });
      return ids;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t !== undefined) t.live = false;
    },
    loadWorld: () => Promise.resolve(world),
    createRenderer: () => stubRenderer(),
    paneClock: {
      now: () => clock.t,
      requestFrame: (cb) => {
        ids += 1;
        frames.set(ids, cb);
        return ids;
      },
      cancelFrame: (id) => {
        frames.delete(id);
      },
      setTimeout: (fn, ms) => {
        ids += 1;
        timers.push({ id: ids, at: clock.t + ms, fn, live: true });
        return ids;
      },
      clearTimeout: (id) => {
        const t = timers.find((x) => x.id === id);
        if (t !== undefined) t.live = false;
      },
    },
  });
  if (options.wait !== false) {
    await app.ready;
    await flush();
  }
  function frame(): void {
    clock.t += 16;
    for (const t of timers.filter((x) => x.live && x.at <= clock.t)) {
      t.live = false;
      t.fn();
    }
    const run = [...frames.entries()];
    frames.clear();
    for (const [, cb] of run) cb(clock.t);
  }
  const q = <T extends Element = HTMLElement>(selector: string): T => {
    const el = root.querySelector<T>(selector);
    if (el === null) throw new Error(`no ${selector}`);
    return el;
  };
  const r: Rig = {
    app,
    root,
    fetch: calls,
    storage,
    clock,
    async advance(ms) {
      for (let spent = 0; spent < ms; spent += 16) {
        frame();
        if (spent % 160 === 0) await flush();
      }
      await flush();
    },
    q,
    maybe: (selector) => root.querySelector(selector),
    text: (selector) => q(selector).textContent ?? "",
    paneFact: (name) => root.querySelector(".wx-srv-adv")?.getAttribute(`data-${name}`) ?? "",
  };
  return r;
}

// ---- the page --------------------------------------------------------------------------------------

describe("public app: the page and a fresh game", () => {
  it("paints its shell at once, before the bank has arrived: loading text, the footer, no pane yet", async () => {
    let release: (r: Response) => void = () => {};
    const r = await mount({ wait: false, bank: () => new Promise<Response>((resolve) => (release = resolve)) });
    expect(r.text(".adv-pub-status-text")).toBe("Loading Adventure Time…");
    expect(r.text(".adv-pub-footer")).toBe(FOOTER_TEXT);
    expect(r.maybe(".wx-srv-adv")).toBeNull();
    release(new Response(JSON.stringify(fixtureBankJson()), { status: 200 }));
    await r.app.ready;
    await flush();
    expect(r.q<HTMLElement>(".adv-pub-status").hidden).toBe(true);
    expect(r.q<HTMLElement>(".wx-srv-adv").hidden).toBe(false);
  });

  it("the footer says exactly what the brief says", () => {
    expect(FOOTER_TEXT).toBe("Holiday packs are written by AI — check before you book. Photos: Wikimedia Commons (credits on each photo).");
    expect(PAGE_TITLE).toBe("Adventure Time");
  });

  it("opens a fresh single-player game at /: the pane is up with a sideways-swipe hint, no close button, no chat", async () => {
    const r = await mount();
    await r.advance(100);
    expect(window.location.pathname).toBe("/");
    expect(r.paneFact("phase")).toBe("idle");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Swipe sideways to spin");
    expect(r.maybe(".wx-srv-adv-close")).toBeNull();
    expect(r.maybe(".wx-srv-float")).toBeNull();
    expect(r.app.backend()?.currentSeq()).not.toBeNull();
    expect(document.title).toBe("Adventure Time");
  });

  it("makes no request but its own: the bank, and same-origin pack calls", async () => {
    const r = await mount({ boot: { code: "aaaaa4" } });
    await r.advance(200);
    for (const [input] of r.fetch.mock.calls) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url.startsWith("/"), url).toBe(true);
    }
    expect(r.fetch.mock.calls.map((c) => c[0])).toContain("/api/bank");
  });

  it("a bank that will not load says so and Try again loads it", async () => {
    let attempts = 0;
    const r = await mount({
      bank: async () => {
        attempts += 1;
        return attempts === 1 ? new Response("down", { status: 503 }) : new Response(JSON.stringify(fixtureBankJson()), { status: 200 });
      },
    });
    expect(r.text(".adv-pub-status-text")).toContain("Couldn't load the places");
    const retry = r.q<HTMLButtonElement>(".adv-pub-status .adv-pub-btn");
    expect(retry.hidden).toBe(false);
    retry.click();
    await r.app.ready;
    await flush();
    await tick();
    expect(r.maybe(".wx-srv-adv")).not.toBeNull();
    expect(r.q<HTMLElement>(".adv-pub-status").hidden).toBe(true);
  });

  it("a bank that is not a bank (or a network error) is the same message", async () => {
    const r = await mount({ bank: async () => new Response("{}", { status: 200 }) });
    expect(r.text(".adv-pub-status-text")).toContain("Couldn't load the places");
    const t = await mount({
      bank: async () => {
        throw new TypeError("offline");
      },
    });
    expect(t.text(".adv-pub-status-text")).toContain("Couldn't load the places");
  });
});

// ---- the deep link ---------------------------------------------------------------------------------

describe("public app: /d/<code>", () => {
  it("shows the place at once: globe on it, its name, Yay / Nay / Copy link, no spins, its pack requested", async () => {
    window.history.replaceState(null, "", "/d/aaaaa4");
    const r = await mount();
    await r.advance(48); // three frames: not the seconds a game takes to arrive
    expect(r.paneFact("phase")).toBe("chosen");
    expect(r.paneFact("state")).toBe("chosen");
    expect(r.paneFact("place")).toBe("AAA.a4");
    expect(r.paneFact("landing-unit")).toBe("AAA");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Anchor");
    expect(r.text(".wx-srv-adv-hint-sub")).toBe("Anchor region, Aland");
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-decide").hidden).toBe(false);
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-share").hidden).toBe(false);
    expect(r.maybe(".wx-srv-adv-stop")?.getAttribute("data-live")).not.toBe("1");
    expect(document.title).toBe("Anchor · Adventure Time");
    expect(window.location.pathname).toBe("/d/aaaaa4");
    const view = r.app.backend()?.model.view(r.app.backend()?.currentSeq() as number);
    expect(view?.spins).toEqual({ lng: null, lat: null });
    expect(r.fetch.mock.calls.some(([u, i]) => u === "/api/pack/aaaaa4" && (i?.method ?? "GET") === "GET")).toBe(true);
  });

  it("uses the server's boot code over the path", async () => {
    const r = await mount({ boot: { code: "ddddd1" } });
    await r.advance(48);
    expect(r.paneFact("place")).toBe("DDD.d1");
  });

  it("the place's pack, once the server has it, is shown below the globe", async () => {
    window.history.replaceState(null, "", "/d/aaaaa4");
    const r = await mount({ pack: () => packJson(readyPackView()) });
    await r.advance(100);
    expect(r.paneFact("pack-state")).toBe("ready");
    expect(r.q(".wx-srv-adv-pk-host").textContent).toContain("Sun and tiles");
  });

  it("an unknown code says that place is not on the map, with Spin the globe", async () => {
    window.history.replaceState(null, "", "/d/zzzzzz");
    const r = await mount();
    expect(r.q<HTMLElement>(".adv-pub-missing").hidden).toBe(false);
    expect(r.text(".adv-pub-missing-title")).toBe(MISSING_TITLE);
    expect(MISSING_TITLE).toBe("That place isn't on the map any more");
    expect(r.q<HTMLElement>(".wx-srv-adv").hidden).toBe(true);
    r.q(".adv-pub-spin").click();
    await r.advance(50);
    expect(r.q<HTMLElement>(".adv-pub-missing").hidden).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(r.paneFact("phase")).toBe("idle");
  });

  it("Spin the globe / New / Play again leave a place page for / (a new history entry) and start a fresh game", async () => {
    window.history.replaceState(null, "", "/d/aaaaa4");
    const r = await mount();
    await r.advance(100);
    const historyLength = window.history.length;
    r.q(".wx-srv-adv-new").click();
    await r.advance(50);
    expect(window.location.pathname).toBe("/");
    expect(window.history.length).toBe(historyLength + 1);
    expect(r.paneFact("state")).toBe("spin_lng");
    expect(document.title).toBe("Adventure Time");
  });

  it("Back and Forward replay the History API: back to the place shows it at once, forward to / starts a fresh game", async () => {
    window.history.replaceState(null, "", "/d/aaaaa4");
    const r = await mount();
    await r.advance(100);
    r.q(".wx-srv-adv-new").click();
    await r.advance(50);
    expect(window.location.pathname).toBe("/");
    window.history.back();
    await tick(40);
    await r.advance(100);
    expect(window.location.pathname).toBe("/d/aaaaa4");
    expect(r.paneFact("place")).toBe("AAA.a4");
    expect(r.paneFact("phase")).toBe("chosen");
    window.history.forward();
    await tick(40);
    await r.advance(100);
    expect(window.location.pathname).toBe("/");
    expect(r.paneFact("state")).toBe("spin_lng");
  });
});

// ---- playing a round and the address bar ----------------------------------------------------------

describe("public app: a game puts its place's link in the address bar", () => {
  it("landing on a place makes /d/<code> the address (replacing, not adding) and names the page after it", async () => {
    const r = await mount();
    const backend = r.app.backend();
    if (backend === null) throw new Error("no backend");
    const seq = backend.currentSeq() as number;
    const length = window.history.length;
    const go = (call: () => Promise<unknown>): Promise<unknown> => backend.model.run(call as never);
    await go(() => backend.api.spin(seq, { axis: "lng", from: 10, delta: 1000, durationMs: 4000 }));
    await go(() => backend.api.spin(seq, { axis: "lat", from: -15, delta: 900, durationMs: 4000, result: landingResult({ candidates: ["BBB", "AAA"] }) }));
    r.clock.t += 9_000;
    await go(() => backend.api.stop(seq, { stage: "country", choice: "BBB" }));
    expect(window.location.pathname).toBe("/d/bbbbb1");
    expect(window.history.length).toBe(length);
    expect(document.title).toBe("Bravo · Adventure Time");
    // The link in the share action is the same short link.
    await r.advance(5000);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    r.q(".wx-srv-adv-copylink").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/d/bbbbb1`);
  });
});

// ---- the Holiday bank ------------------------------------------------------------------------------

describe("public app: the Holiday bank", () => {
  it("is empty at first, and says how to fill it", async () => {
    const r = await mount();
    r.q(".wx-srv-adv-bank").click();
    await flush();
    expect(r.q<HTMLElement>(".wx-srv-bank-view").hidden).toBe(false);
    expect(r.text(".wx-srv-bank-empty")).toBe(EMPTY_BANK_TEXT);
    expect(r.q<HTMLElement>(".wx-srv-bank-empty").hidden).toBe(false);
    expect(r.text(".wx-srv-bank-close")).toBe("Back to the globe");
    r.q(".wx-srv-bank-close").click();
    expect(r.q<HTMLElement>(".wx-srv-bank-view").hidden).toBe(true);
  });

  it("lists this browser's banked places newest first, names resolved from the bank, a gone place greyed", async () => {
    const storage = fakeStorage({
      initial: {
        // Names are not stored: only ids. A place no longer in the bank is "No longer on the map".
        [BANKED_KEY]: JSON.stringify([
          { code: "aaaaa1", destinationId: "AAA.a1", unitId: "AAA", at: 1_700_000_000 },
          { code: "oldold", destinationId: "AAA.costa-da-prata", unitId: "AAA", at: 1_700_000_100 },
          { code: "ddddd2", destinationId: "DDD.d2", unitId: "DDD", at: 1_700_000_200 },
        ]),
      },
    });
    const r = await mount({ storage });
    r.q(".wx-srv-adv-bank").click();
    await flush();
    const names = [...r.root.querySelectorAll(".wx-srv-bank-trip-name")].map((n) => n.textContent);
    expect(names).toEqual(["Dune", "Costa Da Prata", "Alpha"]);
    const rows = [...r.root.querySelectorAll<HTMLButtonElement>(".wx-srv-bank-trip")];
    expect(rows[0]?.textContent).toContain("Dland");
    expect(rows[0]?.textContent).toContain("Banked");
    expect(rows[1]?.classList.contains("wx-srv-bank-trip-gone")).toBe(true);
    expect(rows[1]?.disabled).toBe(true);
    expect(rows[1]?.textContent).toContain("No longer on the map");
    expect(rows[0]?.disabled).toBe(false);
  });

  it("a row's Copy link copies the place's short link", async () => {
    const storage = fakeStorage({ initial: { [BANKED_KEY]: JSON.stringify([{ code: "aaaaa4", destinationId: "AAA.a4", unitId: "AAA", at: 1_700_000_000 }]) } });
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const r = await mount({ storage });
    r.q(".wx-srv-adv-bank").click();
    await flush();
    r.q(".wx-srv-bank-trip-copy").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/d/aaaaa4`);
    expect(r.text(".wx-srv-bank-trip-copy")).toBe("Link copied");
  });

  it("tapping a row opens that place in-page at /d/<code> (a pushed history entry, no reload) and closes the screen", async () => {
    const storage = fakeStorage({ initial: { [BANKED_KEY]: JSON.stringify([{ code: "aaaaa4", destinationId: "AAA.a4", unitId: "AAA", at: 1_700_000_000 }]) } });
    const r = await mount({ storage });
    await r.advance(50);
    const length = window.history.length;
    r.q(".wx-srv-adv-bank").click();
    await flush();
    r.q(".wx-srv-bank-trip").click();
    await r.advance(100);
    expect(window.location.pathname).toBe("/d/aaaaa4");
    expect(window.history.length).toBe(length + 1);
    expect(r.q<HTMLElement>(".wx-srv-bank-view").hidden).toBe(true);
    expect(r.paneFact("place")).toBe("AAA.a4");
    expect(r.paneFact("phase")).toBe("chosen");
    expect(document.title).toBe("Anchor · Adventure Time");
  });

  it("Yay on a place adds it to the bank and it survives a reload (a new page over the same storage)", async () => {
    const storage = fakeStorage();
    window.history.replaceState(null, "", "/d/aaaaa4");
    const r = await mount({ storage });
    await r.advance(100);
    r.q(".wx-srv-adv-yay").click();
    await r.advance(100);
    expect(JSON.parse(storage.getItem(BANKED_KEY) as string)).toEqual([{ code: "aaaaa4", destinationId: "AAA.a4", unitId: "AAA", at: expect.any(Number) as number }]);
    r.app.destroy();
    document.body.replaceChildren();
    const again = await mount({ storage });
    again.q(".wx-srv-adv-bank").click();
    await flush();
    expect([...again.root.querySelectorAll(".wx-srv-bank-trip-name")].map((n) => n.textContent)).toEqual(["Anchor"]);
  });

  it("Nay hides the place from this browser's future draws and survives a reload", async () => {
    const storage = fakeStorage();
    window.history.replaceState(null, "", "/d/aaaaa4");
    const r = await mount({ storage });
    await r.advance(100);
    r.q(".wx-srv-adv-nay").click();
    r.q(".wx-srv-adv-never").click();
    await r.advance(100);
    expect(JSON.parse(storage.getItem(REJECTED_KEY) as string)).toEqual(["AAA.a4"]);
    const again = await mount({ storage });
    expect(again.app.memory()?.rejected().has("AAA.a4")).toBe(true);
  });
});

// ---- Options ---------------------------------------------------------------------------------------

describe("public app: Options", () => {
  it("the advised switch is per browser, lists the advised countries, and applies to the round on show", async () => {
    const storage = fakeStorage();
    const r = await mount({ storage });
    await r.advance(50);
    r.q(".wx-srv-adv-options").click();
    await flush();
    const input = r.q<HTMLInputElement>(".wx-srv-adv-switch-input");
    expect(input.checked).toBe(false);
    expect(r.text(".wx-srv-adv-opt-list")).toContain("Cland");
    const seq = r.app.backend()?.currentSeq() as number;
    expect(r.app.backend()?.model.view(seq)?.eligible).toEqual(["AAA", "BBB", "DDD"]);
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await r.advance(200);
    expect(JSON.parse(storage.getItem("advPublic.v1.settings") as string)).toEqual({ includeAdvised: true });
    expect(r.app.backend()?.model.view(seq)?.eligible).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });

  it("Forget everything on this device clears the bank and the never-again list after a confirm, not the setting", async () => {
    const storage = fakeStorage({
      initial: {
        [BANKED_KEY]: JSON.stringify([{ code: "aaaaa1", destinationId: "AAA.a1", unitId: "AAA", at: 1 }]),
        [REJECTED_KEY]: JSON.stringify(["AAA.a2"]),
        "advPublic.v1.settings": JSON.stringify({ includeAdvised: true }),
      },
    });
    const r = await mount({ storage });
    await r.advance(50);
    r.q(".wx-srv-adv-options").click();
    await flush();
    r.q(".wx-srv-adv-forget-start").click();
    expect(JSON.parse(storage.getItem(BANKED_KEY) as string)).toHaveLength(1); // nothing yet: it asked first
    r.q(".wx-srv-adv-forget-yes").click();
    await flush();
    expect(JSON.parse(storage.getItem(BANKED_KEY) as string)).toEqual([]);
    expect(JSON.parse(storage.getItem(REJECTED_KEY) as string)).toEqual([]);
    expect(JSON.parse(storage.getItem("advPublic.v1.settings") as string)).toEqual({ includeAdvised: true });
  });

  it("works with storage blocked: it just does not outlast the visit", async () => {
    const r = await mount({ storage: null, boot: { code: "aaaaa4" } });
    await r.advance(100);
    r.q(".wx-srv-adv-yay").click();
    await r.advance(100);
    expect(r.app.memory()?.banked().map((e) => e.destinationId)).toEqual(["AAA.a4"]);
    expect(r.app.memory()?.persistent).toBe(false);
  });
});
