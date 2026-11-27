import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdventureGame, type AdventureGame, type AdventureGameDeps, type AdventureGamePaneApi } from "../../src/server/adventure/adventureGame";
import type { AdventureOutcome, AdventureView, PackView } from "../../src/server/adventure/api";
import type { GlobeFrame, GlobeRenderer } from "../../src/server/adventure/globe";
import type { MapStyle } from "../../src/server/adventure/imagery";
import { createAdventureModel, type AdventureModel } from "../../src/server/adventure/model";
import type { ShareTarget } from "../../src/server/adventure/shareLink";
import type { World } from "../../src/server/adventure/world";
import { NOW, readyPack, spin, testWorld, view } from "../adventure/adventureFixtures";

// The pane with NONE of the Server chat's dependencies (spec/adventure-public section 2.4): no tab frame, chat
// overlay, idle lock, partner or live trail. The private pane's own tests (tests/adventure/pane.test.ts) run
// unedited and cover the other side.

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
  Reflect.deleteProperty(window.navigator, "clipboard");
  Reflect.deleteProperty(window.navigator, "share");
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

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
  game: AdventureGame;
  model: AdventureModel;
  api: { [K in keyof Omit<AdventureGamePaneApi, "postLive">]: ReturnType<typeof vi.fn<NonNullable<AdventureGamePaneApi[K]>>> };
  startNext: ReturnType<typeof vi.fn>;
  openBank: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
  clock: { t: number };
  /** Applies `v` to the model and opens the pane on it. */
  open(v: AdventureView): Promise<void>;
  advance(ms: number): void;
  q<T extends Element = HTMLElement>(selector: string): T;
  maybe(selector: string): Element | null;
  text(selector: string): string;
  fact(name: string): string;
  flick(axis: "lng" | "lat"): void;
}

function rig(options: { share?: (v: AdventureView) => ShareTarget | null; withForget?: boolean } = {}): Rig {
  const clock = { t: 0 };
  const frames = new Map<number, (nowMs: number) => void>();
  const timers: Array<{ id: number; at: number; fn: () => void; live: boolean }> = [];
  let ids = 0;
  let game: AdventureGame | null = null;
  const model = createAdventureModel({
    session: () => ({ token: "t", expiresAt: 1 }),
    fetchRound: async () => ({ ok: false, kind: "unavailable" }),
    onChange: () => game?.refresh(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    now: () => NOW * 1000 + clock.t,
  });
  const api = {
    spin: vi.fn<AdventureGamePaneApi["spin"]>(async () => ({ ok: false, kind: "unavailable" })),
    stop: vi.fn<AdventureGamePaneApi["stop"]>(async () => ({ ok: false, kind: "unavailable" })),
    decide: vi.fn<AdventureGamePaneApi["decide"]>(async () => ({ ok: false, kind: "unavailable" })),
    retryPack: vi.fn<AdventureGamePaneApi["retryPack"]>(async () => ({ ok: false, kind: "unavailable" })),
    getSettings: vi.fn<AdventureGamePaneApi["getSettings"]>(async () => ({ ok: true, settings: { includeAdvised: false, advisedUnits: [] } })),
    putSettings: vi.fn<AdventureGamePaneApi["putSettings"]>(async (includeAdvised) => ({ ok: true, settings: { includeAdvised, advisedUnits: [] } })),
  };
  const startNext = vi.fn();
  const openBank = vi.fn();
  const forget = vi.fn<() => void | Promise<void>>();
  const deps: AdventureGameDeps = {
    document,
    win: window,
    model,
    api,
    loadWorld: () => Promise.resolve(world),
    createRenderer: () => stubRenderer(),
    viewer: () => "You",
    startNextRound: startNext,
    openBank,
    afterChange: vi.fn(),
    ...(options.share !== undefined ? { shareLink: options.share } : {}),
    ...(options.withForget === true ? { forgetEverything: forget } : {}),
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
  };
  game = createAdventureGame(deps);
  document.body.append(game.pane);
  const pane = game.pane;

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
    const el = pane.querySelector<T>(selector);
    if (el === null) throw new Error(`no ${selector}`);
    return el;
  };
  const r: Rig = {
    game,
    model,
    api: api as unknown as Rig["api"],
    startNext,
    openBank,
    forget,
    clock,
    async open(v) {
      model.apply(v);
      game?.open(v.seq);
      await flush();
      frame();
    },
    advance(ms) {
      for (let spent = 0; spent < ms; spent += 16) frame();
    },
    q,
    maybe: (selector) => pane.querySelector(selector),
    text: (selector) => q(selector).textContent ?? "",
    fact: (name) => pane.getAttribute(`data-${name}`) ?? "",
    flick(axis) {
      const canvas = q<HTMLCanvasElement>(".wx-srv-adv-globe");
      const fire = (type: string, x: number, y: number, ts: number): void => {
        const e = new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
        Object.defineProperty(e, "timeStamp", { value: ts });
        canvas.dispatchEvent(e);
      };
      const t0 = clock.t;
      fire("pointerdown", 180, 320, t0);
      for (let i = 1; i <= 10; i += 1) fire("pointermove", 180 + (axis === "lng" ? 16 * i : 0), 320 - (axis === "lat" ? 16 * i : 0), t0 + 12 * i);
      fire("pointerup", 180 + (axis === "lng" ? 160 : 0), 320 - (axis === "lat" ? 160 : 0), t0 + 123);
    },
  };
  return r;
}

const PLACE: ShareTarget = { url: "https://adventure.cinnamons.uk/d/abcdef", title: "Alpha", text: "Alpha, Aland - Alpha is lovely." };

function chosenView(over: Parameters<typeof view>[1] = {}, state: "chosen" | "banked" | "rejected" = "chosen"): AdventureView {
  return view(state, { lat: spin("You", -15, 900, 4000, NOW - 60), lng: spin("You", 10, 1000, 4000, NOW - 100), ...over });
}

// ---- standing alone --------------------------------------------------------------------------------

describe("standalone pane: no Server chat around it", () => {
  it("is hidden until opened; opening shows it itself (no tab frame), builds the globe and says it is single-player", async () => {
    const r = rig();
    expect(r.game.pane.hidden).toBe(true);
    expect(r.game.gameSeq()).toBeNull();
    expect(r.game.pane.dataset["solo"]).toBe("1");
    await r.open(view("spin_lng", { startedBy: "You" }));
    expect(r.game.pane.hidden).toBe(false);
    expect(r.game.gameSeq()).toBe(7);
    expect(r.fact("phase")).toBe("idle");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Swipe sideways to spin");
    expect(r.q(".wx-srv-adv-globe").parentElement).toBe(r.q(".wx-srv-adv-stage"));
  });

  it("has no close button, no chat overlay and no live-trail relay", async () => {
    const r = rig();
    await r.open(view("spin_lng", { startedBy: "You" }));
    expect(r.maybe(".wx-srv-adv-close")).toBeNull();
    expect(r.maybe(".wx-srv-float")).toBeNull();
    expect(r.q(".wx-srv-adv-body").children).toHaveLength(1);
  });

  it("never says Your turn or Their turn (there is nobody else)", async () => {
    const r = rig();
    await r.open(view("spin_lng", { startedBy: "You" }));
    expect(r.text(".wx-srv-adv-hint-sub")).toBe("");
    await r.open(view("spin_lat", { startedBy: "You", rev: 2, lng: spin("You", 10, 1000, 4000, NOW - 100) }));
    r.advance(200);
    expect(r.fact("phase")).toBe("idle2");
    expect(r.text(".wx-srv-adv-hint-main")).toBe("Now spin it up or down");
    expect(r.text(".wx-srv-adv-hint-sub")).toBe("");
  });

  it("a flick posts the spin through the model's api with no idle lock and no live trail to feed", async () => {
    const r = rig();
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.api.spin.mockImplementation(async (seq, input) => ({ ok: true, view: view("spin_lat", { seq, rev: 2, startedBy: "You", lng: spin("You", input.from, input.delta, input.durationMs, NOW) }) }) as AdventureOutcome);
    r.flick("lng");
    await flush();
    expect(r.api.spin).toHaveBeenCalledTimes(1);
    expect(r.api.spin.mock.calls[0]?.[1].axis).toBe("lng");
    r.advance(500);
    // The answer's view reached the pane through the model; the pane is on the next stage.
    expect(r.game.gameSeq()).toBe(7);
    expect(r.model.view(7)?.state).toBe("spin_lat");
  });

  it("refresh() redraws the open round when its model changes (there is no tab frame to do it), and is a no-op before open", async () => {
    const r = rig();
    r.game.refresh();
    expect(r.game.pane.hidden).toBe(true);
    await r.open(chosenView({ startedBy: "You", pack: { ...readyPack(), state: "pending", data: null } }));
    expect(r.fact("pack-state")).toBe("pending");
    r.model.apply(chosenView({ startedBy: "You", rev: 2, pack: readyPack() }));
    r.advance(50);
    expect(r.fact("pack-state")).toBe("ready");
    expect(r.q(".wx-srv-adv-pk-host").textContent).toContain("Sun and tiles");
  });

  it("opening another round starts from nothing; close() hides the pane and forgets the round", async () => {
    const r = rig();
    await r.open(view("spin_lng", { startedBy: "You", seq: 3 }));
    await r.open(chosenView({ startedBy: "You", seq: 4 }));
    expect(r.game.gameSeq()).toBe(4);
    expect(r.fact("phase")).toBe("chosen");
    r.game.close();
    expect(r.game.pane.hidden).toBe(true);
    expect(r.game.gameSeq()).toBeNull();
    expect(r.maybe(".wx-srv-adv-globe")).toBeNull();
  });

  it("offer() is not a thing without a tab frame: it does nothing", async () => {
    const r = rig();
    r.game.offer(5);
    expect(r.game.pane.hidden).toBe(true);
    expect(r.game.gameSeq()).toBeNull();
  });

  it("the header buttons still do their jobs (Bank, New)", async () => {
    const r = rig();
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.q(".wx-srv-adv-bank").click();
    r.q(".wx-srv-adv-new").click();
    expect(r.openBank).toHaveBeenCalledTimes(1);
    expect(r.startNext).toHaveBeenCalledTimes(1);
  });

  it("Yay and Nay work from the title row; Nay asks first", async () => {
    const r = rig();
    r.api.decide.mockResolvedValue({ ok: false, kind: "unavailable" });
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(4000);
    expect(r.fact("phase")).toBe("chosen");
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-decide").hidden).toBe(false);
    r.q(".wx-srv-adv-yay").click();
    await flush();
    expect(r.api.decide).toHaveBeenCalledWith(7, "bank");
    r.q(".wx-srv-adv-nay").click();
    expect(r.text(".wx-srv-adv-ask")).toBe("Never show Alpha again?");
  });

  it("the pack's wait line can be replaced by a notice (the public page's rate-limit line) and goes back to the default", async () => {
    const r = rig();
    const pending: PackView = { state: "pending", data: null, error: null, canRetry: false, images: "none", pictures: null };
    await r.open(chosenView({ startedBy: "You", pack: { ...pending, notice: "Lots of people are exploring right now" } }));
    r.advance(50);
    expect(r.text(".wx-srv-adv-pk-pending-sub")).toBe("Lots of people are exploring right now");
    r.model.apply(chosenView({ startedBy: "You", rev: 2, pack: pending }));
    r.advance(50);
    expect(r.text(".wx-srv-adv-pk-pending-sub")).toBe("This can take a couple of minutes.");
  });
});

// ---- Copy link / Share -----------------------------------------------------------------------------

describe("standalone pane: Copy link and Share", () => {
  it("are absent without a shareLink dep", async () => {
    const r = rig();
    await r.open(chosenView({ startedBy: "You" }));
    expect(r.maybe(".wx-srv-adv-bar-share")).toBeNull();
  });

  it("appear beside Yay / Nay only once a place is chosen, and name the place's link", async () => {
    const shareLink = vi.fn<(v: AdventureView) => ShareTarget | null>(() => PLACE);
    const r = rig({ share: shareLink });
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.advance(50);
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-share").hidden).toBe(true);
    expect(shareLink).not.toHaveBeenCalled();
    await r.open(chosenView({ startedBy: "You", rev: 2 }));
    r.advance(5000); // the zoom to the place, then it is shown
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-share").hidden).toBe(false);
    expect(r.q(".wx-srv-adv-copylink").getAttribute("aria-label")).toBe("Copy the link to this place");
    expect(r.text(".wx-srv-adv-copylink-text")).toBe("Copy link");
    expect(r.q(".wx-srv-adv-copylink").hasAttribute("data-srv-gesture-boundary")).toBe(true);
    expect(shareLink).toHaveBeenCalled();
    // Still there once decided (the link outlives the decision).
    await r.open(chosenView({ startedBy: "You", rev: 3 }, "banked"));
    r.advance(100);
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-share").hidden).toBe(false);
  });

  it("a place with no link (the dep says null) shows no action", async () => {
    const r = rig({ share: () => null });
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(50);
    expect(r.q<HTMLElement>(".wx-srv-adv-bar-share").hidden).toBe(true);
  });

  it("Copy link puts the short link on the clipboard and says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const r = rig({ share: () => PLACE });
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(50);
    r.q(".wx-srv-adv-copylink").click();
    await flush();
    r.advance(50);
    expect(writeText).toHaveBeenCalledWith("https://adventure.cinnamons.uk/d/abcdef");
    expect(r.text(".wx-srv-adv-toast")).toBe("Link copied");
  });

  it("when the browser refuses to copy, the link is shown so it can be copied by hand", async () => {
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new DOMException("denied", "NotAllowedError"))) }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    const r = rig({ share: () => PLACE });
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(50);
    r.q(".wx-srv-adv-copylink").click();
    await flush();
    r.advance(50);
    expect(r.text(".wx-srv-adv-toast")).toBe("Copy this link: https://adventure.cinnamons.uk/d/abcdef");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("falls back to the legacy copy command when there is no Clipboard API", async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    const r = rig({ share: () => PLACE });
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(50);
    r.q(".wx-srv-adv-copylink").click();
    await flush();
    r.advance(50);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(r.text(".wx-srv-adv-toast")).toBe("Link copied");
    expect(document.querySelector("textarea")).toBeNull();
    Reflect.deleteProperty(document, "execCommand");
  });

  it("Share appears only where the browser has navigator.share, and hands it the place's title, text and link", async () => {
    const without = rig({ share: () => PLACE });
    expect(without.q<HTMLElement>(".wx-srv-adv-share").hidden).toBe(true);
    document.body.replaceChildren();
    const share = vi.fn<(data: ShareData) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "share", { value: share, configurable: true });
    const r = rig({ share: () => PLACE });
    expect(r.q<HTMLElement>(".wx-srv-adv-share").hidden).toBe(false);
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(50);
    r.q(".wx-srv-adv-share").click();
    await flush();
    expect(share).toHaveBeenCalledWith({ title: "Alpha", text: PLACE.text, url: PLACE.url });
  });

  it("closing the share sheet is not an error, but a share that fails falls back to copying the link", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const share = vi.fn<(data: ShareData) => Promise<void>>().mockRejectedValueOnce(new DOMException("closed", "AbortError")).mockRejectedValueOnce(new Error("no"));
    Object.defineProperty(window.navigator, "share", { value: share, configurable: true });
    const r = rig({ share: () => PLACE });
    await r.open(chosenView({ startedBy: "You" }));
    r.advance(50);
    r.q(".wx-srv-adv-share").click();
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    r.q(".wx-srv-adv-share").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(PLACE.url);
  });
});

// ---- Forget everything -----------------------------------------------------------------------------

describe("standalone pane: Forget everything on this device", () => {
  it("is not in Options without the dep", async () => {
    const r = rig();
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.q(".wx-srv-adv-options").click();
    await flush();
    expect(r.maybe(".wx-srv-adv-forget")).toBeNull();
  });

  it("asks before it forgets; Keep everything cancels", async () => {
    const r = rig({ withForget: true });
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.q(".wx-srv-adv-options").click();
    await flush();
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-ask").hidden).toBe(true);
    expect(r.text(".wx-srv-adv-forget-start")).toBe("Forget everything on this device");
    r.q(".wx-srv-adv-forget-start").click();
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-ask").hidden).toBe(false);
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-start").hidden).toBe(true);
    expect(r.text(".wx-srv-adv-forget-ask")).toContain("Holiday bank");
    r.q(".wx-srv-adv-forget-no").click();
    expect(r.forget).not.toHaveBeenCalled();
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-ask").hidden).toBe(true);
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-start").hidden).toBe(false);
  });

  it("Yes forgets, says so, and the round on show is read again (its eligible places changed)", async () => {
    const r = rig({ withForget: true });
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.q(".wx-srv-adv-options").click();
    await flush();
    r.q(".wx-srv-adv-forget-start").click();
    r.q(".wx-srv-adv-forget-yes").click();
    await flush();
    expect(r.forget).toHaveBeenCalledTimes(1);
    expect(r.text(".wx-srv-adv-opt-status")).toContain("forgotten");
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-ask").hidden).toBe(true);
  });

  it("a failure is reported and nothing breaks; closing Options drops an open confirm", async () => {
    const r = rig({ withForget: true });
    r.forget.mockRejectedValueOnce(new Error("boom"));
    await r.open(view("spin_lng", { startedBy: "You" }));
    r.q(".wx-srv-adv-options").click();
    await flush();
    r.q(".wx-srv-adv-forget-start").click();
    r.q(".wx-srv-adv-forget-yes").click();
    await flush();
    expect(r.text(".wx-srv-adv-opt-status")).toBe("Couldn't clear that. Try again.");
    r.q(".wx-srv-adv-forget-start").click();
    r.q(".wx-srv-adv-sheet-close").click();
    expect(r.q<HTMLElement>(".wx-srv-adv-forget-ask").hidden).toBe(true);
  });
});
