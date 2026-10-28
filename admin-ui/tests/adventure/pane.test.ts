import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePostResult } from "../../src/server/api/drawings";
import { ServerLockedError } from "../../src/server/api/http";
import type { Message } from "../../src/server/api/messages";
import { createGameTabs, type GameTabs } from "../../src/server/gameTabs";
import type { ItemChat } from "../../src/server/itemChat";
import type { GameFloat } from "../../src/server/gameFloat";
import type { LockCause } from "../../src/server/types";
import type { AdventureLiveFrame, AdventureOutcome, AdventureView, SettingsResult } from "../../src/server/adventure/api";
import {
  ROULETTE_SUSPEND_CAP_MS,
  createAdventureGame,
  type AdventureGame,
  type AdventureGameApi,
  type AdventureGameDeps,
} from "../../src/server/adventure/adventureGame";
import type { GlobeFrame, GlobeRenderer } from "../../src/server/adventure/globe";
import type { MapStyle } from "../../src/server/adventure/imagery";
import { createAdventureModel, type AdventureModel } from "../../src/server/adventure/model";
import type { World } from "../../src/server/adventure/world";
import { DEST_A, DEST_B, DEST_C, NOW, readyPack, spin, testWorld, view } from "./adventureFixtures";

let world: World;
beforeAll(() => {
  world = testWorld();
});
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// ---- the rig --------------------------------------------------------------------------------------

interface StubRenderer extends GlobeRenderer {
  draw: ReturnType<typeof vi.fn<(frame: GlobeFrame, nowMs: number) => void>>;
  resize: ReturnType<typeof vi.fn<(w: number, h: number, dpr: number) => void>>;
  destroy: ReturnType<typeof vi.fn<() => void>>;
  setMapStyle: ReturnType<typeof vi.fn<(style: MapStyle) => void>>;
  state: { style: MapStyle; textured: boolean; imagery: boolean };
}

function stubRenderer(): StubRenderer {
  const state = { style: "classic" as MapStyle, textured: false, imagery: true };
  const renderer = {
    draw: vi.fn<(frame: GlobeFrame, nowMs: number) => void>(),
    resize: vi.fn<(w: number, h: number, dpr: number) => void>(),
    destroy: vi.fn<() => void>(),
    setMapStyle: vi.fn<(style: MapStyle) => void>((style) => {
      state.style = style;
    }),
    project: () => null,
    invert: () => null,
    lastLevel: "coarse" as const,
    get mapStyle() {
      return state.style;
    },
    get imageryAvailable() {
      return state.imagery;
    },
    get textured() {
      return state.textured;
    },
    state,
  };
  return renderer as unknown as StubRenderer;
}

interface Rig {
  game: AdventureGame;
  tabs: GameTabs;
  model: AdventureModel;
  api: { [K in keyof AdventureGameApi]: ReturnType<typeof vi.fn<AdventureGameApi[K]>> };
  hooks: { suspend: ReturnType<typeof vi.fn<(reason: string) => () => void>>; lockNow: ReturnType<typeof vi.fn<(cause: LockCause) => void>> };
  releases: Array<ReturnType<typeof vi.fn<() => void>>>;
  renderers: StubRenderer[];
  startNext: ReturnType<typeof vi.fn>;
  openBank: ReturnType<typeof vi.fn>;
  /** The chat overlay the pane embeds (a stub of gameFloat.ts) and the options it was created with. */
  overlay: { element: HTMLElement; options: () => { fabLabel: string; popupTitle: string; item(): number | null } };
  clock: { t: number };
  names: { viewer: string | null; partner: string | null };
  messages: Map<number, Message>;
  stage: HTMLElement;
  canvas: () => HTMLCanvasElement;
  /** Opens round `seq` in the tab and waits for the world. */
  open(v: AdventureView): Promise<void>;
  /** Gives round `v` its message and view without opening the tab. */
  prepare(v: AdventureView): void;
  /** Runs `ms` of local time: due timers, then a frame every 16 ms. */
  advance(ms: number): void;
  /** The same, letting promises settle between frames (the live relay waits for each answer). */
  advanceAsync(ms: number): Promise<void>;
  frame(): void;
  fire(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", x: number, y: number, ts: number, id?: number): void;
  flick(axis: "lng" | "lat", pixels?: number): void;
  q<T extends Element = HTMLElement>(selector: string): T;
  text(selector: string): string;
  fact(name: string): string;
  setView(v: AdventureView): void;
}

function rig(options: { viewer?: string | null; loadWorld?: () => Promise<World> } = {}): Rig {
  const clock = { t: 0 };
  const frames = new Map<number, (nowMs: number) => void>();
  const timers: Array<{ id: number; at: number; fn: () => void; live: boolean }> = [];
  let ids = 0;
  const releases: Rig["releases"] = [];
  const hooks: Rig["hooks"] = {
    suspend: vi.fn<(reason: string) => () => void>(() => {
      const release = vi.fn<() => void>();
      releases.push(release);
      return release;
    }),
    lockNow: vi.fn<(cause: LockCause) => void>(),
  };
  const renderers: StubRenderer[] = [];
  const messages = new Map<number, Message>();
  const names = { viewer: options.viewer === undefined ? "Ann" : options.viewer, partner: "Bea" as string | null };
  const overlayElement = document.createElement("div");
  overlayElement.className = "wx-srv-float";
  let overlayOptions: { fabLabel: string; popupTitle: string; item(): number | null } | null = null;
  const float = {
    createOverlay: (options: { fabLabel: string; popupTitle: string; item(): number | null }) => {
      overlayOptions = options;
      return overlayElement;
    },
  } as unknown as GameFloat;
  const itemChat: ItemChat = {
    popup: document.createElement("div"),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    isPopupOpen: () => false,
    popupSeq: () => null,
    refresh: vi.fn(),
    reset: vi.fn(),
  };
  const tabs = createGameTabs({ document, itemChat, onLayoutChange: vi.fn() });
  const model = createAdventureModel({
    session: () => ({ token: "t", expiresAt: 1 }),
    fetchRound: async () => ({ ok: false, kind: "unavailable" }),
    onChange: () => tabs.refresh(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    now: () => NOW * 1000 + clock.t,
  });
  const api = {
    spin: vi.fn<AdventureGameApi["spin"]>(async () => ({ ok: false, kind: "unavailable" })),
    stop: vi.fn<AdventureGameApi["stop"]>(async () => ({ ok: false, kind: "unavailable" })),
    decide: vi.fn<AdventureGameApi["decide"]>(async () => ({ ok: false, kind: "unavailable" })),
    retryPack: vi.fn<AdventureGameApi["retryPack"]>(async () => ({ ok: false, kind: "unavailable" })),
    getSettings: vi.fn<AdventureGameApi["getSettings"]>(async () => ({ ok: true, settings: { includeAdvised: false, advisedUnits: [{ id: "AFG", name: "Afghanistan" }] } })),
    putSettings: vi.fn<AdventureGameApi["putSettings"]>(async (includeAdvised) => ({ ok: true, settings: { includeAdvised, advisedUnits: [] } })),
    postLive: vi.fn<AdventureGameApi["postLive"]>(async () => ({ kind: "ok" }) as LivePostResult),
  };
  const startNext = vi.fn();
  const openBank = vi.fn();
  const deps: AdventureGameDeps = {
    document,
    win: window,
    model,
    tabs,
    float,
    hooks,
    api,
    loadWorld: options.loadWorld ?? (() => Promise.resolve(world)),
    createRenderer: () => {
      const renderer = stubRenderer();
      renderers.push(renderer);
      return renderer;
    },
    roundMessage: (seq) => messages.get(seq),
    viewer: () => names.viewer,
    partner: () => names.partner,
    startNextRound: startNext,
    openBank,
    afterChange: vi.fn(),
    clock: {
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
    random: () => 0.5,
    newId: () => `drag-test-${(ids += 1).toString().padStart(4, "0")}`,
  };
  const game = createAdventureGame(deps);
  document.body.append(tabs.tabBar, game.pane);

  function runDueTimers(): void {
    for (;;) {
      const due = timers.filter((x) => x.live && x.at <= clock.t).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) return;
      due.live = false;
      due.fn();
    }
  }
  function frame(): void {
    clock.t += 16;
    runDueTimers();
    const run = [...frames.entries()];
    frames.clear();
    for (const [, cb] of run) cb(clock.t);
  }
  const q = <T extends Element = HTMLElement>(selector: string): T => {
    const el = game.pane.querySelector<T>(selector);
    if (el === null) throw new Error(`no ${selector}`);
    return el;
  };
  const r: Rig = {
    game,
    tabs,
    model,
    api: api as unknown as Rig["api"],
    hooks,
    releases,
    renderers,
    startNext,
    openBank,
    overlay: { element: overlayElement, options: () => overlayOptions! },
    clock,
    names,
    messages,
    stage: q(".wx-srv-adv-stage"),
    canvas: () => q<HTMLCanvasElement>(".wx-srv-adv-globe"),
    prepare(v) {
      messages.set(v.seq, { seq: v.seq, clientId: "c", sender: "Ann", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, adventure: { state: v.state, pack: v.pack.state, rev: v.rev } });
      model.apply(v);
    },
    async open(v) {
      r.prepare(v);
      tabs.open("adventure", v.seq);
      await flush();
      frame();
    },
    advance(ms) {
      for (let spent = 0; spent < ms; spent += 16) frame();
    },
    async advanceAsync(ms) {
      for (let spent = 0; spent < ms; spent += 16) {
        frame();
        await flush();
      }
    },
    frame,
    fire(type, x, y, ts, id = 1) {
      const e = new PointerEvent(type, { pointerId: id, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperty(e, "timeStamp", { value: ts });
      r.canvas().dispatchEvent(e);
    },
    flick(axis, pixels = 160) {
      const t0 = clock.t;
      r.fire("pointerdown", 180, 320, t0);
      for (let i = 1; i <= 10; i += 1) {
        const f = i / 10;
        r.fire("pointermove", 180 + (axis === "lng" ? pixels * f : 0), 320 - (axis === "lat" ? pixels * f : 0), t0 + 12 * i);
      }
      r.fire("pointerup", 180 + (axis === "lng" ? pixels : 0), 320 - (axis === "lat" ? pixels : 0), t0 + 123);
    },
    q,
    text: (selector) => q(selector).textContent ?? "",
    fact: (name) => game.pane.getAttribute(`data-${name}`) ?? "",
    setView(v) {
      model.apply(v);
    },
  };
  return r;
}

/** The globe's longitude rotation in a drawn frame (a raw-rotation view). */
function rotationLng(frame: GlobeFrame): number {
  return (frame.view as unknown as { rotation: readonly number[] }).rotation[0] ?? Number.NaN;
}

/** The longitude the camera is centred on in a drawn frame (a camera view). */
function centreLng(frame: GlobeFrame): number {
  return (frame.view as unknown as { centre: readonly number[] }).centre[0] ?? Number.NaN;
}

const LNG_DONE = spin("Ann", 10, 1000, 4000, NOW - 30);

function roulette(over: { rouletteAt?: number } = {}): AdventureView {
  return view("country", {
    lng: LNG_DONE,
    lat: spin("Bea", -15, 900, 4000, NOW - 60),
    country: { candidates: [{ id: "AAA", name: "Aland" }, { id: "BBB", name: "Bland" }, { id: "CCC", name: "Cland" }], seed: 4242, rouletteAt: over.rouletteAt ?? NOW - 1, chosen: null, by: null },
  });
}

function chosen(over: Parameters<typeof view>[1] = {}, state: "chosen" | "banked" | "rejected" = "chosen"): AdventureView {
  return view(state, { lat: spin("Bea", -15, 900, 4000, NOW - 60), ...over });
}

// ---- the tab and the pane ------------------------------------------------------------------------

describe("adventure pane: registration and the first draw", () => {
  it("registers as the 'adventure' tab and starts hidden, with no canvas in the chat until it is shown", () => {
    const r = rig();
    expect(r.game.pane.getAttribute("data-game")).toBe("adventure");
    expect(r.game.pane.classList.contains("wx-srv-game")).toBe(true);
    expect(r.game.pane.hidden).toBe(true);
    expect(r.game.pane.querySelector("canvas")).toBeNull();
    expect(r.tabs.tabBar.querySelector(".wx-srv-tab-adventure")?.textContent).toBe("Adventure");
    expect(r.tabs.tabBar.querySelector(".wx-srv-tab-adventure")?.getAttribute("aria-label")).toBe("Adventure Time game");
  });

  it("opening the tab shows 'Loading the map…' until the world has loaded, then builds the renderer and the first frame", async () => {
    const r = rig();
    r.prepare(view("spin_lng"));
    r.tabs.open("adventure", 7);
    expect(r.game.pane.hidden).toBe(false);
    expect(r.text(".wx-srv-adv-note")).toBe("Loading the map…");
    expect(r.renderers).toHaveLength(0);
    await flush();
    r.frame();
    expect(r.renderers).toHaveLength(1);
    expect(r.q<HTMLElement>(".wx-srv-adv-note").hidden).toBe(true);
    expect(r.canvas().parentElement).toBe(r.stage);
    expect(r.renderers[0]?.draw).toHaveBeenCalled();
    expect(r.fact("phase")).toBe("idle");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Swipe sideways to spin");
    expect(r.text(".wx-srv-adv-hint-sub")).toBe("Your turn");
    // The pane embeds the chat overlay over the scrolling column, aimed at the open round.
    expect(r.overlay.element.parentElement).toBe(r.q(".wx-srv-adv-body"));
    expect(r.overlay.options().item()).toBe(7);
    expect(r.overlay.options().fabLabel).toBe("Open this destination's chat");
  });

  it("a map that cannot be loaded says so and a tap on the message tries again", async () => {
    const loadWorld = vi.fn<() => Promise<World>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(world);
    const r = rig({ loadWorld });
    r.prepare(view("spin_lng"));
    r.tabs.open("adventure", 7);
    await flush();
    expect(r.text(".wx-srv-adv-note")).toBe("Couldn't load the map. Tap here to try again.");
    r.q(".wx-srv-adv-note").click();
    await flush();
    r.frame();
    expect(loadWorld).toHaveBeenCalledTimes(2);
    expect(r.renderers).toHaveLength(1);
    expect(r.q<HTMLElement>(".wx-srv-adv-note").hidden).toBe(true);
  });

  it("every control and the stage carry the gesture boundary, so a drag or a tap on them never counts toward the lock", () => {
    const r = rig();
    expect(r.stage.hasAttribute("data-srv-gesture-boundary")).toBe(true);
    for (const selector of [".wx-srv-adv-options", ".wx-srv-adv-bank", ".wx-srv-adv-new", ".wx-srv-adv-close", ".wx-srv-adv-stop", ".wx-srv-adv-bank-this", ".wx-srv-adv-pass", ".wx-srv-adv-never", ".wx-srv-adv-keep", ".wx-srv-adv-again", ".wx-srv-adv-explore-toggle", ".wx-srv-adv-back", ".wx-srv-adv-sheet-close"]) {
      expect(r.q(selector).hasAttribute("data-srv-gesture-boundary"), selector).toBe(true);
    }
  });

  it("the header: Options, Bank, New, ✕ — each does its one job", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-bank").click();
    expect(r.openBank).toHaveBeenCalledTimes(1);
    r.q(".wx-srv-adv-new").click();
    expect(r.startNext).toHaveBeenCalledTimes(1);
    r.q(".wx-srv-adv-close").click();
    expect(r.tabs.seqOf("adventure")).toBeNull();
    expect(r.game.pane.hidden).toBe(true);
    expect(r.game.pane.querySelector("canvas")).toBeNull(); // and the canvas leaves the chat with it
  });

  it("sizes the renderer to the stage (and re-sizes when the stage changes)", async () => {
    const r = rig();
    const rect = { width: 360, height: 420, left: 0, top: 0, right: 360, bottom: 420, x: 0, y: 0, toJSON: () => ({}) };
    vi.spyOn(r.stage, "getBoundingClientRect").mockImplementation(() => rect as DOMRect);
    await r.open(view("spin_lng"));
    expect(r.renderers[0]?.resize).toHaveBeenCalledWith(360, 420, expect.any(Number));
    rect.height = 300;
    r.frame();
    expect(r.renderers[0]?.resize).toHaveBeenLastCalledWith(360, 300, expect.any(Number));
  });
});

// ---- swipes -------------------------------------------------------------------------------------------

describe("adventure pane: spinning", () => {
  it("a sideways flick posts the lng spin (no result) and the globe turns at once", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.flick("lng");
    expect(r.fact("phase")).toBe("idle"); // not until the next frame
    r.advance(200);
    expect(r.fact("phase")).toBe("spin1");
    await flush();
    expect(r.api.spin).toHaveBeenCalledTimes(1);
    const [seq, input] = r.api.spin.mock.calls[0]!;
    expect(seq).toBe(7);
    expect(input).toMatchObject({ axis: "lng" });
    expect(Math.abs(input.delta)).toBeGreaterThanOrEqual(720);
    expect(input.durationMs).toBeGreaterThanOrEqual(3500);
    expect("result" in input).toBe(false);
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Spinning…");
  });

  it("the second flick posts the landing the globe will make", async () => {
    const r = rig();
    await r.open(view("spin_lat", { lng: LNG_DONE }));
    expect(r.fact("phase")).toBe("idle2");
    r.flick("lat", 150);
    r.advance(100);
    await flush();
    const [, input] = r.api.spin.mock.calls[0]!;
    expect(input.axis).toBe("lat");
    expect(input.result).toBeDefined();
    expect(["AAA", "BBB", "CCC"]).toContain(input.result?.landUnit);
    expect(input.result?.candidates[0]).toBe(input.result?.landUnit);
  });

  it("a weak swipe says 'Flick it harder!' and posts nothing", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.fire("pointerdown", 180, 320, r.clock.t);
    r.fire("pointermove", 200, 320, r.clock.t + 400);
    r.fire("pointerup", 200, 320, r.clock.t + 410);
    r.advance(50);
    await flush();
    expect(r.api.spin).not.toHaveBeenCalled();
    expect(r.text(".wx-srv-adv-toast")).toBe("Flick it harder!");
    expect(r.q(".wx-srv-adv-toast").getAttribute("data-show")).toBe("1");
  });

  it("while the finger is down the live relay carries it: a first frame at once, the closing `end` after the release", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.fire("pointerdown", 180, 320, r.clock.t);
    await r.advanceAsync(80);
    r.fire("pointermove", 220, 320, r.clock.t + 10);
    await r.advanceAsync(100);
    const frames = r.api.postLive.mock.calls.map((c) => c[0]);
    expect(frames[0]).toMatchObject({ anchorSeq: 7, axis: "lng", frame: 0, end: false });
    expect(frames[0]?.clientId).toMatch(/^drag-test-/);
    r.fire("pointerup", 220, 320, r.clock.t + 20);
    await r.advanceAsync(200);
    const last = r.api.postLive.mock.calls.at(-1)?.[0] as AdventureLiveFrame;
    expect(last.end).toBe(true);
    expect(new Set(r.api.postLive.mock.calls.map((c) => c[0].clientId)).size).toBe(1);
  });

  it("a spin the server accepts keeps the round going; one that cannot be sent is taken back with a message and a re-read", async () => {
    const accepted = rig();
    accepted.api.spin.mockImplementation(async (seq, input) => ({ ok: true, view: view("spin_lat", { seq, rev: 2, lng: spin("Ann", input.from, input.delta, input.durationMs, NOW) }) }) as AdventureOutcome);
    await accepted.open(view("spin_lng"));
    accepted.flick("lng");
    accepted.advance(100);
    await flush();
    expect(accepted.model.view(7)?.state).toBe("spin_lat");
    accepted.advance(50);
    expect(accepted.fact("state")).toBe("spin_lat");

    const failing = rig();
    const refetch = vi.spyOn(failing.model, "refetch");
    await failing.open(view("spin_lng"));
    failing.flick("lng");
    failing.advance(100);
    await flush();
    expect(failing.api.spin).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i += 1) {
      failing.advance(800); // the same move is asked again (it is idempotent on the server)
      await flush();
    }
    await flush();
    await flush();
    expect(failing.api.spin).toHaveBeenCalledTimes(3);
    expect(refetch).toHaveBeenCalledWith(7);
    failing.advance(50);
    expect(failing.text(".wx-srv-adv-toast")).toBe("That spin didn't go through. Try again.");
    expect(failing.fact("phase")).toBe("idle"); // the globe waits for a real spin again
  });

  it("losing the race (409) says so at once, without asking again", async () => {
    const r = rig();
    r.api.spin.mockResolvedValue({ ok: false, kind: "bad_state" });
    await r.open(view("spin_lng"));
    r.flick("lng");
    r.advance(100);
    await flush();
    expect(r.api.spin).toHaveBeenCalledTimes(1);
    r.advance(50);
    expect(r.text(".wx-srv-adv-toast")).toBe("Somebody else got there first.");
  });

  it("a lock (401) during a spin locks the chat", async () => {
    const r = rig();
    r.api.spin.mockImplementation(async () => {
      throw new ServerLockedError();
    });
    await r.open(view("spin_lng"));
    r.flick("lng");
    r.advance(50);
    await flush();
    expect(r.hooks.lockNow).toHaveBeenCalledWith("unauthorized");
  });
});

// ---- the other person's finger -------------------------------------------------------------------------

describe("adventure pane: watching the other person spin", () => {
  function theirFrame(over: Partial<AdventureLiveFrame> = {}): AdventureLiveFrame {
    return { anchorSeq: 7, clientId: "their-drag-0001", axis: "lng", rotation: [40, -15], points: [[0.1, 0.1, 0], [0.2, 0.1, 30]], frame: 0, end: false, ...over };
  }

  it("turns the globe with their finger, draws their stroke, and says who is spinning", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.game.handleLive(theirFrame());
    r.advance(400);
    expect(r.fact("remote")).toBe("1");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Bea is spinning it");
    const frame = r.renderers[0]?.draw.mock.calls.at(-1)?.[0] as GlobeFrame;
    expect(rotationLng(frame)).toBeCloseTo(40, 3);
    expect(frame.trail?.size).toBeGreaterThan(0);
    expect(r.q(".wx-srv-adv-stage").getAttribute("data-interactive")).toBe("none");
  });

  it("ignores its own relayed frames, frames for another round or axis, and frames while it is not on screen", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    // Make a drag of its own first so its id is remembered, then have the relay hand it back.
    r.fire("pointerdown", 180, 320, r.clock.t);
    r.advance(100);
    const own = r.api.postLive.mock.calls[0]?.[0] as AdventureLiveFrame;
    r.fire("pointercancel", 180, 320, r.clock.t + 5);
    r.advance(200);
    r.game.handleLive({ ...own, frame: 99 });
    r.game.handleLive(theirFrame({ anchorSeq: 99 }));
    r.game.handleLive(theirFrame({ axis: "lat", clientId: "their-drag-0002" }));
    r.advance(300);
    expect(r.fact("remote")).toBe("0");
    r.tabs.showTab("chat"); // the pane is not on screen
    r.game.handleLive(theirFrame({ clientId: "their-drag-0003" }));
    r.tabs.showTab("adventure");
    r.advance(300);
    expect(r.fact("remote")).toBe("0");
  });

  it("the committed spin takes over from the live finger the moment the server has stored it", async () => {
    const r = rig();
    await r.open(view("spin_lng", { rev: 1 }));
    r.game.handleLive(theirFrame());
    r.advance(300);
    expect(r.fact("remote")).toBe("1");
    r.setView(view("spin_lat", { rev: 2, lng: spin("Bea", 40, 1100, 4200, NOW + r.clock.t / 1000 - 0.2) }));
    r.advance(50);
    expect(r.fact("remote")).toBe("0");
    expect(r.fact("phase")).toBe("spin1");
    expect(r.text(".wx-srv-adv-hint-sub")).toBe("Bea spun it");
  });
});

// ---- the roulettes and Stop --------------------------------------------------------------------------

describe("adventure pane: the country roulette", () => {
  it("shows the big Stop live once the roulette runs, lit from server time, and the lit name", async () => {
    const r = rig();
    await r.open(roulette());
    r.advance(50);
    expect(r.fact("phase")).toBe("country");
    expect(r.fact("lit")).not.toBe("");
    expect(r.q(".wx-srv-adv-stop").getAttribute("data-live")).toBe("1");
    expect(r.text(".wx-srv-adv-stop")).toBe("Stop");
    expect(r.q(".wx-srv-adv-lit").getAttribute("data-show")).toBe("1");
    expect(["Aland", "Bland", "Cland"]).toContain(r.text(".wx-srv-adv-lit-name"));
    expect(r.q(".wx-srv-adv-card").getAttribute("data-action")).toBe("stop");
  });

  it("before the roulette starts the button is greyed 'Get ready…'", async () => {
    const r = rig();
    await r.open(roulette({ rouletteAt: NOW + 30 }));
    expect(r.q(".wx-srv-adv-stop").getAttribute("data-live")).toBe("0");
    expect(r.text(".wx-srv-adv-stop")).toBe("Get ready…");
  });

  it("Stop fires on the press and posts what was lit; the same press is not sent twice", async () => {
    const r = rig();
    r.api.stop.mockResolvedValue({ ok: false, kind: "unavailable" });
    await r.open(roulette());
    r.advance(50);
    const lit = r.fact("lit");
    const stop = r.q(".wx-srv-adv-stop");
    stop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    stop.click(); // the click that follows a press (or a second quick press)
    stop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flush();
    expect(r.api.stop).toHaveBeenCalledTimes(2); // one press, retried once because the network failed
    expect(r.api.stop).toHaveBeenNthCalledWith(1, 7, { stage: "country", choice: lit });
  });

  it("settles on the choice at once, before the server answers, and keeps showing it", async () => {
    const r = rig();
    r.api.stop.mockImplementation(() => new Promise<AdventureOutcome>(() => {}));
    await r.open(roulette());
    r.advance(50);
    const lit = r.fact("lit");
    r.q(".wx-srv-adv-stop").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    r.advance(100);
    expect(r.fact("phase")).toBe("countrySettle");
    expect(r.fact("lit")).toBe(lit);
    expect(r.text(".wx-srv-adv-hint-sub")).toBe("That's the one!");
    r.advance(2000);
    expect(r.fact("lit")).toBe(lit);
  });

  it("a Stop the server refuses puts the roulette back: exhausted names the country, a lost race says nothing", async () => {
    const exhausted = rig();
    exhausted.api.stop.mockResolvedValue({ ok: false, kind: "exhausted" });
    await exhausted.open(roulette());
    exhausted.advance(50);
    exhausted.q(".wx-srv-adv-stop").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flush();
    exhausted.advance(50);
    expect(exhausted.text(".wx-srv-adv-toast")).toMatch(/^Nowhere left to go in (Aland|Bland|Cland)\. Hit Stop again for another country\.$/);
    expect(exhausted.fact("phase")).toBe("country");

    const raced = rig();
    const refetch = vi.spyOn(raced.model, "refetch");
    raced.api.stop.mockResolvedValue({ ok: false, kind: "bad_state" });
    await raced.open(roulette());
    raced.advance(50);
    raced.q(".wx-srv-adv-stop").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flush();
    raced.advance(50);
    expect(refetch).toHaveBeenCalledWith(7);
    expect(raced.q(".wx-srv-adv-toast").getAttribute("data-show")).toBe("0");
    expect(raced.fact("phase")).toBe("country");
  });

  it("a Stop that could not be sent at all says so", async () => {
    const r = rig();
    await r.open(roulette());
    r.advance(50);
    r.q(".wx-srv-adv-stop").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flush();
    r.advance(50);
    expect(r.text(".wx-srv-adv-toast")).toBe("Couldn't send Stop. Try again.");
  });

  it("when the server moves on to the places the settle becomes the flight to them and the places roulette", async () => {
    const r = rig();
    await r.open(
      view("destination", {
        lng: LNG_DONE,
        lat: spin("Bea", -15, 900, 4000, NOW - 60),
        destination: { candidates: [DEST_A, DEST_B, DEST_C], seed: 99, rouletteAt: NOW + 3.5, chosen: null, by: null },
      }),
    );
    r.advance(50);
    expect(r.fact("phase")).toBe("countrySettle");
    expect(r.fact("country")).toBe("AAA");
    r.advance(3600);
    expect(r.fact("phase")).toBe("destination");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Top places in Aland");
    expect(["AAA.alpha", "AAA.beta", "AAA.gamma"]).toContain(r.fact("lit"));
    const lit = r.fact("lit");
    r.q(".wx-srv-adv-stop").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flush();
    expect(r.api.stop).toHaveBeenCalledWith(7, { stage: "destination", choice: lit });
  });
});

// ---- the place, the pack and the decision -----------------------------------------------------------------

describe("adventure pane: the place and the holiday pack", () => {
  it("waits with 'Preparing holiday pack…' and a timer while the research runs, with the globe still full size", async () => {
    const r = rig();
    await r.open(chosen({ pack: { state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null } }));
    r.advance(50);
    expect(r.q(".wx-srv-adv-card").getAttribute("data-pack")).toBe("pending");
    expect(r.text(".wx-srv-adv-pk-pending-text")).toContain("Preparing holiday pack…");
    expect(r.text(".wx-srv-adv-pk-pending-text")).toContain("This can take a couple of minutes.");
    expect(r.text(".wx-srv-adv-pk-timer")).toMatch(/^\d+:\d\d$/);
    expect(r.fact("place")).toBe("AAA.alpha");
    expect(r.q(".wx-srv-adv-card").getAttribute("data-action")).toBe("decide");
  });

  it("the idle lock is NOT held through the pack wait (it is minutes long)", async () => {
    const r = rig();
    await r.open(chosen({ pack: { state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null } }));
    r.advance(200);
    expect(r.hooks.suspend).not.toHaveBeenCalled();
  });

  it("shows the pack when it is ready: the panel, the explore toggle, and the globe shrinks (the card says so)", async () => {
    const r = rig();
    await r.open(chosen({ pack: readyPack() }));
    r.advance(50);
    expect(r.q(".wx-srv-adv-card").getAttribute("data-pack")).toBe("panel");
    expect(r.text(".wx-srv-adv-pk-headline")).toBe("Sun and tiles");
    expect(r.q(".wx-srv-adv-card").getAttribute("data-explore")).toBe("0");
    r.q(".wx-srv-adv-explore-toggle").click();
    expect(r.q(".wx-srv-adv-card").getAttribute("data-explore")).toBe("1");
    expect(r.text(".wx-srv-adv-explore-toggle")).toBe("Show holiday pack");
    r.q(".wx-srv-adv-explore-toggle").click();
    expect(r.q(".wx-srv-adv-card").getAttribute("data-explore")).toBe("0");
    expect(r.text(".wx-srv-adv-explore-toggle")).toBe("Explore map");
  });

  it("a failed research offers Try again, which asks the server and re-reads", async () => {
    const r = rig();
    r.api.retryPack.mockResolvedValue({ ok: true, view: chosen({ rev: 5, pack: { state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null } }) });
    await r.open(chosen({ pack: { state: "failed", data: null, error: "The research didn't finish - try again", canRetry: true, images: "none", pictures: null } }));
    r.advance(50);
    expect(r.text(".wx-srv-adv-pk-message-text")).toBe("The research didn't finish - try again");
    r.q(".wx-srv-adv-pk-retry").click();
    await flush();
    expect(r.api.retryPack).toHaveBeenCalledWith(7);
    r.advance(50);
    expect(r.q(".wx-srv-adv-card").getAttribute("data-pack")).toBe("pending");
  });

  it("says holiday packs are unavailable on this server, and Yay / Nay still work", async () => {
    const r = rig();
    r.api.decide.mockResolvedValue({ ok: false, kind: "unavailable" });
    await r.open(chosen({ pack: { state: "unavailable", data: null, error: null, canRetry: false, images: "none", pictures: null } }));
    r.advance(50);
    expect(r.text(".wx-srv-adv-pk-message-text")).toContain("aren't available on this server");
    r.q(".wx-srv-adv-bank-this").click();
    expect(r.api.decide).toHaveBeenCalledWith(7, "bank");
  });

  it("'Yay' banks; the pane then shows the outcome and Play again", async () => {
    const r = rig();
    r.api.decide.mockImplementation(async (seq, decision) => ({ ok: true, view: chosen({ seq, rev: 9, decidedBy: "Ann" }, decision === "bank" ? "banked" : "rejected") }) as AdventureOutcome);
    await r.open(chosen({ pack: readyPack() }));
    r.advance(50);
    // The decision lives on the LEFT of the title row (no title text, no big dock buttons).
    expect(r.text(".wx-srv-adv-bank-this")).toBe("Yay");
    expect(r.q(".wx-srv-adv-bank-this").getAttribute("aria-label")).toBe("Yay: bank this trip");
    expect(r.q(".wx-srv-adv-pass").getAttribute("aria-label")).toBe("Nay: not this one");
    expect(r.text(".wx-srv-adv-pass")).toBe("Nay");
    expect(r.q(".wx-srv-adv-bar-decide").hidden).toBe(false);
    expect(r.q(".wx-srv-adv-bar .wx-srv-adv-bank-this")).toBeTruthy();
    expect(r.q(".wx-srv-adv-bar").textContent).not.toContain("Adventure Time");
    expect(r.q(".wx-srv-adv-dock").querySelector(".wx-srv-adv-bank-this, .wx-srv-adv-pass")).toBeNull();
    r.q(".wx-srv-adv-bank-this").click();
    expect(r.q<HTMLButtonElement>(".wx-srv-adv-bank-this").disabled).toBe(true); // while it is being sent
    await flush();
    r.advance(50);
    expect(r.fact("state")).toBe("banked");
    expect(r.q(".wx-srv-adv-bar-decide").hidden).toBe(true); // nothing left to decide: the row is just the right-hand buttons
    expect(r.q(".wx-srv-adv-card").getAttribute("data-action")).toBe("again");
    expect(r.text(".wx-srv-adv-outcome")).toBe("You banked Alpha: it's in your Holiday bank.");
    r.q(".wx-srv-adv-again").click();
    expect(r.startNext).toHaveBeenCalledTimes(1);
  });

  it("'Nay' asks once; 'Keep it' backs out, 'Never show again' rejects the place", async () => {
    const r = rig();
    r.api.decide.mockImplementation(async (seq) => ({ ok: true, view: chosen({ seq, rev: 9, decidedBy: "Ann" }, "rejected") }) as AdventureOutcome);
    await r.open(chosen({ pack: readyPack() }));
    r.advance(50);
    r.q(".wx-srv-adv-pass").click();
    r.advance(50);
    expect(r.q(".wx-srv-adv-card").getAttribute("data-action")).toBe("ask");
    expect(r.q(".wx-srv-adv-bar-decide").hidden).toBe(true); // the question replaces Yay / Nay while it is open
    expect(r.text(".wx-srv-adv-ask")).toBe("Never show Alpha again?");
    expect(r.api.decide).not.toHaveBeenCalled();
    r.q(".wx-srv-adv-keep").click();
    r.advance(50);
    expect(r.q(".wx-srv-adv-card").getAttribute("data-action")).toBe("decide");
    expect(r.text(".wx-srv-adv-ask")).toBe("");
    r.q(".wx-srv-adv-pass").click();
    r.advance(50);
    r.q(".wx-srv-adv-never").click();
    await flush();
    expect(r.api.decide).toHaveBeenCalledTimes(1);
    expect(r.api.decide).toHaveBeenCalledWith(7, "reject");
    r.advance(50);
    expect(r.fact("state")).toBe("rejected");
    expect(r.text(".wx-srv-adv-outcome")).toBe("You passed on Alpha: it won't come up again.");
  });

  it("a decision that someone else already made is re-read, not forced", async () => {
    const r = rig();
    const refetch = vi.spyOn(r.model, "refetch");
    r.api.decide.mockResolvedValue({ ok: false, kind: "bad_state" });
    await r.open(chosen({ pack: readyPack() }));
    r.advance(50);
    r.q(".wx-srv-adv-bank-this").click();
    await flush();
    expect(refetch).toHaveBeenCalledWith(7);
    r.advance(50);
    expect(r.text(".wx-srv-adv-toast")).toBe("Somebody already decided.");
    expect(r.q<HTMLButtonElement>(".wx-srv-adv-bank-this").disabled).toBe(false);
  });

  it("the final map can be explored, and 'Back to the place' is offered", async () => {
    const r = rig();
    await r.open(chosen({ pack: readyPack() }));
    r.advance(50);
    expect(r.q(".wx-srv-adv-stage").getAttribute("data-interactive")).toBe("explore");
    expect(r.q<HTMLElement>(".wx-srv-adv-back").hidden).toBe(false);
    const before = r.renderers[0]?.draw.mock.calls.at(-1)?.[0] as GlobeFrame;
    r.fire("pointerdown", 180, 320, r.clock.t);
    r.fire("pointermove", 230, 320, r.clock.t + 16);
    r.fire("pointerup", 230, 320, r.clock.t + 32);
    r.advance(50);
    const after = r.renderers[0]?.draw.mock.calls.at(-1)?.[0] as GlobeFrame;
    expect(centreLng(after)).not.toBeCloseTo(centreLng(before), 3);
    r.q(".wx-srv-adv-back").click();
    r.advance(1100);
    const home = r.renderers[0]?.draw.mock.calls.at(-1)?.[0] as GlobeFrame;
    expect(centreLng(home)).toBeCloseTo(DEST_A.lng, 6);
  });
});

// ---- options and the map style ---------------------------------------------------------------------------

describe("adventure pane: Options", () => {
  it("opens a sheet with the one switch (off by default), the explanation and the imagery credit", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-options").click();
    expect(r.q<HTMLElement>(".wx-srv-adv-sheet").hidden).toBe(false);
    await flush();
    const advised = r.q<HTMLInputElement>("#wx-srv-adv-opt-advised");
    expect(advised.checked).toBe(false);
    expect(advised.disabled).toBe(false);
    expect(r.text(".wx-srv-adv-sheet")).toContain("Include places the UK says not to travel to");
    expect(r.text(".wx-srv-adv-sheet")).toContain("Off by default");
    expect(r.text(".wx-srv-adv-opt-list")).toContain("Left out: Afghanistan");
    expect(r.text(".wx-srv-adv-opt-credit")).toBe("Map imagery: NASA Visible Earth, Blue Marble Next Generation (July); Natural Earth II shaded relief");
  });

  it("the switch saves the shared setting and re-reads the round (its eligible list follows it)", async () => {
    const r = rig();
    const refetch = vi.spyOn(r.model, "refetch");
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-options").click();
    await flush();
    const advised = r.q<HTMLInputElement>("#wx-srv-adv-opt-advised");
    advised.checked = true;
    advised.dispatchEvent(new Event("change", { bubbles: true }));
    expect(advised.disabled).toBe(true);
    expect(r.text(".wx-srv-adv-opt-status")).toBe("Saving…");
    await flush();
    expect(r.api.putSettings).toHaveBeenCalledWith(true);
    expect(advised.disabled).toBe(false);
    expect(advised.checked).toBe(true);
    expect(r.text(".wx-srv-adv-opt-status")).toBe("");
    expect(refetch).toHaveBeenCalledWith(7);
    expect(r.text(".wx-srv-adv-opt-list")).toBe(""); // nothing is left out now (the stub answers an empty list)
  });

  it("a switch that could not be saved goes back and says so", async () => {
    const r = rig();
    r.api.putSettings.mockResolvedValue({ ok: false, kind: "unavailable" } as SettingsResult);
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-options").click();
    await flush();
    const advised = r.q<HTMLInputElement>("#wx-srv-adv-opt-advised");
    advised.checked = true;
    advised.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(advised.checked).toBe(false);
    expect(r.text(".wx-srv-adv-opt-status")).toBe("Couldn't save that. Try again.");
  });

  it("settings that cannot be loaded leave the switch disabled with a plain message", async () => {
    const r = rig();
    r.api.getSettings.mockResolvedValue({ ok: false, kind: "unavailable" } as SettingsResult);
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-options").click();
    await flush();
    expect(r.q<HTMLInputElement>("#wx-srv-adv-opt-advised").disabled).toBe(true);
    expect(r.text(".wx-srv-adv-opt-status")).toBe("Couldn't load the options. Close this and try again.");
  });

  it("closes by Done or the backdrop, and NEVER by Escape (Escape is the panic key)", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-options").click();
    await flush();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    r.q(".wx-srv-adv-sheet").dispatchEvent(escape);
    expect(r.q<HTMLElement>(".wx-srv-adv-sheet").hidden).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    r.q(".wx-srv-adv-sheet-close").click();
    expect(r.q<HTMLElement>(".wx-srv-adv-sheet").hidden).toBe(true);
    r.q(".wx-srv-adv-options").click();
    r.q(".wx-srv-adv-sheet").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(r.q<HTMLElement>(".wx-srv-adv-sheet").hidden).toBe(true);
  });

  it("Map style: Satellite / Atlas / Classic on this device, through the renderer", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.q(".wx-srv-adv-options").click();
    const buttons = [...r.game.pane.querySelectorAll<HTMLButtonElement>(".wx-srv-adv-seg-button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Satellite", "Atlas", "Classic"]);
    expect(buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.textContent).toBe("Classic"); // the stub's style
    buttons[0]?.click();
    expect(r.renderers[0]?.setMapStyle).toHaveBeenCalledWith("satellite");
    expect(buttons.find((b) => b.getAttribute("aria-pressed") === "true")?.textContent).toBe("Satellite");
    buttons[1]?.click();
    expect(r.renderers[0]?.setMapStyle).toHaveBeenLastCalledWith("atlas");
  });

  it("a browser without WebGL 2 disables the imagery styles and says why", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.renderers[0]!.state.imagery = false;
    r.q(".wx-srv-adv-options").click();
    const buttons = [...r.game.pane.querySelectorAll<HTMLButtonElement>(".wx-srv-adv-seg-button")];
    expect(buttons.map((b) => b.disabled)).toEqual([true, true, false]);
    expect(r.text(".wx-srv-adv-opt-block .wx-srv-adv-opt-list")).toContain("can't show map pictures");
  });

  it("the explorable map's zoom floor is gentler while imagery shows", async () => {
    const r = rig();
    await r.open(chosen({ pack: readyPack() }));
    r.renderers[0]!.state.textured = true;
    r.advance(50);
    r.fire("pointerdown", 180, 320, r.clock.t);
    r.fire("pointerup", 180, 320, r.clock.t + 10);
    // Zoom in a long way with the wheel: it stops at the textured floor (0.8 degrees), not 0.3.
    for (let i = 0; i < 30; i += 1) {
      r.canvas().dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true }));
      r.frame();
    }
    const frame = r.renderers[0]?.draw.mock.calls.at(-1)?.[0] as GlobeFrame;
    expect((frame.view as unknown as { viewRadiusDeg: number }).viewRadiusDeg).toBeCloseTo(0.8, 6);
  });
});

// ---- the idle lock, the loop and teardown ---------------------------------------------------------------

describe("adventure pane: the idle lock and the lifecycle", () => {
  it("holds the idle lock only while something moves on screen, and lets go the moment it stops", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.advance(100);
    expect(r.hooks.suspend).not.toHaveBeenCalled(); // waiting for a swipe: not moving
    r.fire("pointerdown", 180, 320, r.clock.t);
    r.advance(50);
    expect(r.hooks.suspend).toHaveBeenCalledWith("adventureAnimating");
    expect(r.hooks.suspend).toHaveBeenCalledTimes(1);
    r.fire("pointerup", 180, 320, r.clock.t + 5); // too slow to be a flick: nothing spins
    r.advance(50);
    expect(r.releases[0]).toHaveBeenCalledTimes(1);
  });

  it("holds it through a spin and a roulette, one suspension at a time", async () => {
    const r = rig();
    await r.open(roulette());
    r.advance(200);
    expect(r.hooks.suspend).toHaveBeenCalledTimes(1);
    expect(r.releases[0]).not.toHaveBeenCalled();
  });

  it("a roulette left running does not hold the lock for ever: it is let go after 90 seconds", async () => {
    const r = rig();
    await r.open(roulette({ rouletteAt: NOW }));
    r.advance(200);
    expect(r.hooks.suspend).toHaveBeenCalledTimes(1);
    expect(ROULETTE_SUSPEND_CAP_MS).toBe(90_000);
    r.clock.t += ROULETTE_SUSPEND_CAP_MS + 1000;
    r.frame();
    expect(r.releases[0]).toHaveBeenCalledTimes(1);
    r.advance(500);
    expect(r.hooks.suspend).toHaveBeenCalledTimes(1); // and it is not taken again
  });

  it("another tab, the game closing and a lock each release it, stop the loop and the live relay", async () => {
    const r = rig();
    await r.open(roulette());
    r.advance(100);
    const drawn = r.renderers[0]!.draw.mock.calls.length;
    r.tabs.showTab("chat");
    expect(r.releases[0]).toHaveBeenCalledTimes(1);
    r.advance(200);
    expect(r.renderers[0]?.draw.mock.calls.length).toBe(drawn); // no frames for a pane nobody sees
    r.tabs.showTab("adventure");
    r.advance(100);
    expect(r.renderers[0]?.draw.mock.calls.length).toBeGreaterThan(drawn);
    expect(r.hooks.suspend).toHaveBeenCalledTimes(2);
    r.tabs.reset(); // a lock or a wipe
    expect(r.releases[1]).toHaveBeenCalledTimes(1);
    expect(r.renderers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(r.game.pane.querySelector("canvas")).toBeNull();
    const after = r.renderers[0]!.draw.mock.calls.length;
    r.advance(300);
    expect(r.renderers[0]?.draw.mock.calls.length).toBe(after);
  });

  it("closing mid-drag withdraws the drag with a closing frame", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.fire("pointerdown", 180, 320, r.clock.t);
    r.advance(100);
    r.tabs.reset();
    const last = r.api.postLive.mock.calls.at(-1)?.[0] as AdventureLiveFrame;
    expect(last.end).toBe(true);
  });

  it("opening again after a lock builds a fresh renderer over the cached world, and forgets the old round", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.tabs.reset();
    r.setView(view("spin_lng", { seq: 8, rev: 1 }));
    r.messages.set(8, { seq: 8, clientId: "c", sender: "Ann", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, adventure: { state: "spin_lng", pack: "none", rev: 1 } });
    r.tabs.open("adventure", 8);
    await flush();
    r.frame();
    expect(r.renderers).toHaveLength(2);
    expect(r.fact("state")).toBe("spin_lng");
    expect(r.q(".wx-srv-adv-card").getAttribute("data-pack")).toBe("none");
    expect(r.game.gameSeq()).toBe(8);
  });

  it("the tab closes itself when its round's message is gone (deleted or wiped)", async () => {
    const r = rig();
    await r.open(view("spin_lng"));
    r.messages.delete(7);
    r.tabs.refresh();
    expect(r.tabs.seqOf("adventure")).toBeNull();
    expect(r.game.pane.hidden).toBe(true);
  });

  it("a replaced adventure (someone else began a new one) says so and offers Play again", async () => {
    const r = rig();
    await r.open(view("abandoned"));
    r.advance(50);
    expect(r.text(".wx-srv-adv-hint-main")).toBe("This adventure was replaced");
    expect(r.q(".wx-srv-adv-card").getAttribute("data-action")).toBe("again");
  });

  it("keeps a plain 'Loading…' on screen while the round's view has not been read yet", async () => {
    const r = rig();
    r.messages.set(7, { seq: 7, clientId: "c", sender: "Ann", text: null, attachments: [], reactions: [], createdAt: 1, replyTo: null, adventure: { state: "spin_lng", pack: "none", rev: 1 } });
    r.tabs.open("adventure", 7);
    await flush();
    r.frame();
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Loading…");
  });
});
