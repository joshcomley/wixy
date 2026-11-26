// The public Adventure Time page (spec/adventure-public section 1, 2.4): the PRODUCTION game pane
// (`server/adventure/adventureGame.ts`) mounted on its own full-screen page, played alone against the
// local state machine (`localBackend.ts`), remembering the visitor's bank and never-again list in their
// own browser (`memory.ts`).
//
//   <div class="adv-pub">
//     <main class="adv-pub-main">  the pane | the Holiday bank screen | "That place isn't on the map"
//     <footer>                     "Holiday packs are written by AI ... Photos: Wikimedia Commons ..."
//
// Two URLs: `/` starts a game; `/d/<code>` shows one place at once (the deep link). Choosing a place in
// a game puts its link in the address bar (`replaceState`), the Holiday bank opens a place in-page
// (`pushState`, no reload), Back and Forward replay the History API, and "Spin the globe" / New / Play
// again go to `/`. Nothing here talks to the private chat: the only requests are `GET /api/bank`, the
// pack calls and the static assets, all same-origin.

import { createAdventureGame, type AdventureGame } from "../server/adventure/adventureGame";
import type { BankTrip } from "../server/adventure/api";
import type { GlobeRenderer } from "../server/adventure/globe";
import { createHolidayBank, type HolidayBank } from "../server/adventure/holidayBank";
import { setTextureUrls } from "../server/adventure/imagery";
import type { ShareTarget } from "../server/adventure/shareLink";
import { loadWorld, type World } from "../server/adventure/world";
import { parsePublicBank, type PublicBank, type PublicDest } from "./bank";
import type { BootInfo } from "./boot";
import { createLocalBackend, VIEWER, type LocalBackend } from "./localBackend";
import { createMemory, type Memory } from "./memory";
import { createPackClient } from "./packClient";
import { parseRoute, placePath, placeUrl } from "./route";

export const FOOTER_TEXT =
  "Holiday packs are written by AI — check before you book. Photos: Wikimedia Commons (credits on each photo).";
export const PAGE_TITLE = "Adventure Time";
export const MISSING_TITLE = "That place isn't on the map any more";
export const EMPTY_BANK_TEXT = "Nothing banked yet. Tap Yay on a place you like and it will wait here.";

export interface PublicAppDeps {
  readonly document: Document;
  readonly win: Window;
  /** `#adventure-public-root`: the page mounts here. */
  readonly root: HTMLElement;
  readonly boot: BootInfo;
  readonly fetch: typeof fetch;
  /** Test seams (all default to the real thing). */
  readonly storage?: () => Storage | null;
  now?(): number;
  random32?(): number;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
  loadWorld?(): Promise<World>;
  createRenderer?(canvas: HTMLCanvasElement, world: World): GlobeRenderer;
  readonly paneClock?: {
    now(): number;
    requestFrame(callback: (nowMs: number) => void): number;
    cancelFrame(id: number): void;
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
}

export interface PublicApp {
  readonly element: HTMLElement;
  /** Resolves once the bank has loaded and the first screen is up (or the page said it could not start). */
  readonly ready: Promise<void>;
  /** The game, once the bank has loaded. */
  game(): AdventureGame | null;
  backend(): LocalBackend | null;
  memory(): Memory | null;
  holidayBank(): HolidayBank | null;
  destroy(): void;
}

function bankTripOf(bank: PublicBank, entry: { code: string; destinationId: string; unitId: string; at: number }, seq: number): BankTrip {
  const dest = bank.destination(entry.destinationId);
  if (dest !== undefined) {
    return {
      seq,
      unitId: entry.unitId,
      unitName: bank.unitName(bank.unitOf(dest.id)?.id ?? entry.unitId),
      destination: { id: dest.id, name: dest.name, region: dest.region, lat: dest.lat, lng: dest.lng, kind: dest.kind, blurb: dest.blurb },
      headline: null,
      pack: "none",
      code: dest.code,
      at: entry.at,
    };
  }
  // No longer in the bank: all that is known is its id ("PRT.costa-da-prata"), so its slug stands in for a name.
  const slug = entry.destinationId.split(".").slice(1).join(".");
  const name = slug === "" ? entry.destinationId : slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    seq,
    unitId: entry.unitId,
    unitName: bank.unit(entry.unitId)?.name ?? "",
    destination: { id: entry.destinationId, name, region: "", lat: 0, lng: 0, kind: "", blurb: "" },
    headline: null,
    pack: "none",
    code: entry.code,
    at: entry.at,
    gone: true,
  };
}

export function mountPublicApp(deps: PublicAppDeps): PublicApp {
  const doc = deps.document;
  const win = deps.win;
  const boot = deps.boot;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeout ?? ((cb: () => void, ms: number) => win.setTimeout(cb, ms));
  const clearTimer = deps.clearTimeout ?? ((id: number) => win.clearTimeout(id));
  const random32 =
    deps.random32 ??
    (() => {
      const buffer = new Uint32Array(1);
      win.crypto.getRandomValues(buffer);
      return buffer[0] ?? 0;
    });

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // -- The shell: painted at once, before anything is fetched -----------------------------------------------------

  const page = el("div", "adv-pub");
  const main = el("main", "adv-pub-main");
  const footer = el("footer", "adv-pub-footer", FOOTER_TEXT);
  const status = el("div", "adv-pub-status");
  status.setAttribute("role", "status");
  const statusText = el("p", "adv-pub-status-text", "Loading Adventure Time…");
  const statusRetry = el("button", "adv-pub-btn", "Try again");
  statusRetry.type = "button";
  statusRetry.hidden = true;
  status.append(statusText, statusRetry);
  const missing = el("div", "adv-pub-missing");
  missing.hidden = true;
  const missingTitle = el("h1", "adv-pub-missing-title", MISSING_TITLE);
  const missingSpin = el("button", "adv-pub-btn adv-pub-spin", "Spin the globe");
  missingSpin.type = "button";
  missing.append(missingTitle, missingSpin);
  main.append(status, missing);
  page.append(main, footer);
  deps.root.replaceChildren(page);

  let game: AdventureGame | null = null;
  let backend: LocalBackend | null = null;
  let memory: Memory | null = null;
  let holidayBank: HolidayBank | null = null;
  let bank: PublicBank | null = null;
  let destroyed = false;
  let loadedCode: string | null = null;

  // -- Titles, addresses and links -------------------------------------------------------------------------------

  function setTitle(placeName: string | null): void {
    doc.title = placeName === null ? PAGE_TITLE : `${placeName} · ${PAGE_TITLE}`;
  }

  function currentPath(): string {
    return win.location.pathname;
  }

  function shareTargetFor(dest: PublicDest, unitName: string): ShareTarget {
    return {
      url: placeUrl(boot.origin, dest.code),
      title: dest.name,
      text: `${dest.name}, ${unitName} — ${dest.blurb}`,
    };
  }

  function placeOfView(view: { destination: { chosen: { id: string } | null } | null }): PublicDest | null {
    const id = view.destination?.chosen?.id;
    return id === undefined || bank === null ? null : (bank.destination(id) ?? null);
  }

  // -- Moves between screens --------------------------------------------------------------------------------------

  function showMissing(): void {
    game?.close();
    holidayBank?.close();
    status.hidden = true;
    missing.hidden = false;
    setTitle(null);
  }

  /** Shows a place at once (the deep link). `history`: how the address bar follows. */
  function showPlace(code: string, history: "push" | "none"): void {
    if (backend === null || game === null || bank === null) return;
    const found = bank.byCode(code);
    if (found === null) {
      showMissing();
      return;
    }
    // Set first: the model's change notice for the new round must not re-write the address bar itself
    // (this function does it, as a new history entry when asked).
    loadedCode = code;
    const seq = backend.openPlace(code);
    if (seq === null) {
      showMissing();
      return;
    }
    missing.hidden = true;
    status.hidden = true;
    holidayBank?.close();
    const target = placePath(code);
    if (history === "push" && currentPath() !== target) win.history.pushState(null, "", target);
    setTitle(found.dest.name);
    game.open(seq);
  }

  /** A fresh game. From a place's page the address goes back to `/` (a new history entry: Back returns to the place). */
  function newRound(history: "push" | "none" = "push"): void {
    if (backend === null || game === null) return;
    missing.hidden = true;
    status.hidden = true;
    holidayBank?.close();
    if (history === "push" && currentPath() !== "/") win.history.pushState(null, "", "/");
    loadedCode = null;
    const seq = backend.startRound();
    setTitle(null);
    game.open(seq);
  }

  /** A view changed: keep the address bar and the title on the place a game has chosen. */
  function onViewChange(seq: number): void {
    if (game !== null && game.gameSeq() === seq) game.refresh();
    const view = backend?.model.view(seq);
    if (view === undefined) return;
    if (view.state === "chosen" || view.state === "banked" || view.state === "rejected") {
      const dest = placeOfView(view);
      if (dest !== null && dest.code !== loadedCode) {
        loadedCode = dest.code;
        if (currentPath() !== placePath(dest.code)) win.history.replaceState(null, "", placePath(dest.code));
        setTitle(dest.name);
      }
    }
  }

  function onPopState(): void {
    const route = parseRoute(currentPath());
    if (route.kind === "place") showPlace(route.code, "none");
    else newRound("none");
  }

  // -- Start once the bank is in -----------------------------------------------------------------------------------

  function start(loaded: PublicBank): void {
    bank = loaded;
    setTextureUrls({ satellite: boot.assets.satellite, atlas: boot.assets.atlas });
    const mem = createMemory(deps.storage ?? (() => win.localStorage));
    memory = mem;
    backend = createLocalBackend({
      bank: loaded,
      memory: mem,
      packs: createPackClient({ fetch: deps.fetch, setTimeout: setTimer, clearTimeout: clearTimer }),
      now,
      random32,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
      onChange: onViewChange,
    });
    game = createAdventureGame({
      document: doc,
      win,
      model: backend.model,
      api: backend.api,
      loadWorld: deps.loadWorld ?? (() => loadWorld({ url: boot.assets.world })),
      ...(deps.createRenderer !== undefined ? { createRenderer: deps.createRenderer } : {}),
      ...(deps.paneClock !== undefined ? { clock: deps.paneClock } : {}),
      viewer: () => VIEWER,
      startNextRound: () => newRound(),
      openBank: () => holidayBank?.open(0),
      afterChange: () => {},
      shareLink: (view) => {
        const dest = placeOfView(view);
        return dest === null ? null : shareTargetFor(dest, loaded.unitName(loaded.unitOf(dest.id)?.id ?? ""));
      },
      forgetEverything: () => mem.forgetEverything(),
    });
    holidayBank = createHolidayBank({
      document: doc,
      win,
      source: {
        load: () => ({
          ok: true,
          trips: mem.banked().map((entry, index) => bankTripOf(loaded, entry, index + 1)),
        }),
      },
      openTrip: () => {},
      openPlace: (trip) => {
        if (trip.code !== undefined) showPlace(trip.code, "push");
      },
      shareLink: (trip) => {
        const dest = trip.code === undefined ? undefined : loaded.byCode(trip.code)?.dest;
        return dest === undefined ? null : shareTargetFor(dest, trip.unitName);
      },
      closeLabel: "Back to the globe",
      emptyText: EMPTY_BANK_TEXT,
    });
    main.prepend(game.pane);
    main.append(holidayBank.element);
    status.hidden = true;
    win.addEventListener("popstate", onPopState);
    const route = parseRoute(currentPath());
    const wanted = boot.code ?? (route.kind === "place" ? route.code : null);
    if (wanted !== null) showPlace(wanted, "none");
    else newRound("none");
  }

  async function loadBank(): Promise<PublicBank | null> {
    try {
      const response = await deps.fetch("/api/bank", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      return parsePublicBank(await response.json());
    } catch {
      return null;
    }
  }

  async function begin(): Promise<void> {
    statusRetry.hidden = true;
    statusText.textContent = "Loading Adventure Time…";
    status.hidden = false;
    const loaded = await loadBank();
    if (destroyed) return;
    if (loaded === null) {
      statusText.textContent = "Couldn't load the places. Check your connection and try again.";
      statusRetry.hidden = false;
      return;
    }
    start(loaded);
  }

  statusRetry.addEventListener("click", () => void begin());
  missingSpin.addEventListener("click", () => newRound());

  const ready = begin();

  return {
    element: page,
    ready,
    game: () => game,
    backend: () => backend,
    memory: () => memory,
    holidayBank: () => holidayBank,
    destroy() {
      destroyed = true;
      win.removeEventListener("popstate", onPopState);
      backend?.dispose();
      game?.close();
      holidayBank?.close();
      deps.root.replaceChildren();
    },
  };
}
