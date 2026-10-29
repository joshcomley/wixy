// The Adventure Time GAME PANE (workspace 00056; spec/server-chat/08-adventure-time.md §5.3): when a
// round is opened its tab shows the globe FULL SCREEN (decisions/00194) — the chat header and composer
// are hidden while a game tab shows, so this title row is the only way to Options / Bank / New / close:
//
//   [ Yay  Nay                 Options  Bank  New  ✕ ]      <- pinned (no title text; Yay / Nay only while a place can be decided)
//   [ the scrolling column:                                   <- scrolls ONLY once the place is chosen
//       the stage: the globe, the pin, the hint pill, the big lit name, "Nearest land: …"
//       the holiday pack, or "Preparing holiday pack…" ]
//   [ the action dock: Stop · ("Never show again?" after Nay) · Play again ]      <- pinned
//   (over the column's bottom corners: the chat FAB right, a floating message left — `gameFloat.ts`)
//
// While the globe spins or a roulette runs nothing scrolls and the globe has the whole column. Once the
// place is chosen the map and the pack are ONE column: the map is a fixed-height block at the top that
// scrolls up and away as the pack is read (a finger on the map scrolls too; "Explore map" is the mode
// that fills the column with the map and hands drags to it).
//
// This module is the PANE: the DOM, the frame loop, the pointer input and the calls. What the screen
// SHOWS comes from `scene.ts` (the round's view + the server's clock -> a globe frame and some words);
// the holiday pack's panel is `packView.ts`; the finger trail is relayed by `live.ts`. The look is the
// approved preview's (`dev/adventureHarness.ts`): a deep-blue space card with a glass hint pill, a big
// coral Stop, a mint "Bank this" and a pack that slides in under a shrunken globe.
//
// Like WYR's pane it registers with the shared frame (`gameTabs.ts`) as "adventure" and embeds an overlay of
// the shared chat FAB / floating message / quick reply (`gameFloat.ts`). It owns three kinds of long-lived resource, and releases all
// of them in `reset()` (the game closing, a lock, a wipe) and the first two in `onHide()` (another tab):
//   - the requestAnimationFrame loop,
//   - the idle-lock suspension (`hooks.suspend("adventureAnimating")`, held ONLY while something is moving
//     on screen: a drag, a spin, the landing, a roulette — never during the minutes of the pack wait —
//     and a roulette left running holds it for at most `ROULETTE_SUSPEND_CAP_MS`), and
//   - the live-trail sender's timers.
// Escape is the chat's panic key: nothing here listens for it, and the sheets close by their buttons.

import type { Message } from "../api/messages";
import { ServerLockedError } from "../api/http";
import type { LivePostResult } from "../api/drawings";
import type { GameTabs } from "../gameTabs";
import type { GameFloat } from "../gameFloat";
import type { LockHooks } from "../types";
import {
  type AdventureLiveFrame,
  type AdventureOutcome,
  type AdventureSettings,
  type AdventureView,
  type SettingsResult,
  type SpinInput,
} from "./api";
import { MIN_VIEW_RADIUS_DEG, MIN_VIEW_RADIUS_TEXTURED_DEG } from "./camera";
import { MAP_STYLES, readMapStyle, writeMapStyle, type MapStyle } from "./imagery";
import { createPackPanel, type PackPanel } from "./packView";
import { prepareLanding } from "./land";
import { createGlobeRenderer, type GlobeRenderer } from "./globe";
import { createLiveReceiver, createLiveSender, type LiveReceiver, type LiveSender } from "./live";
import type { AdventureModel } from "./model";
import { AdventureScene, type Hud, type SpinIntent, type StopIntent } from "./scene";
import type { World } from "./world";

export interface AdventureGameApi {
  spin(seq: number, input: Omit<SpinInput, "sender">): Promise<AdventureOutcome>;
  stop(seq: number, input: StopIntent): Promise<AdventureOutcome>;
  decide(seq: number, decision: "bank" | "reject"): Promise<AdventureOutcome>;
  retryPack(seq: number): Promise<AdventureOutcome>;
  getSettings(): Promise<SettingsResult>;
  putSettings(includeAdvised: boolean): Promise<SettingsResult>;
  postLive(frame: AdventureLiveFrame): Promise<LivePostResult | "locked">;
}

export interface AdventureGameDeps {
  readonly document: Document;
  readonly win: Window;
  readonly model: AdventureModel;
  /** The shared tab bar: this pane registers itself as the game "adventure". */
  readonly tabs: GameTabs;
  /** The shared chat FAB / floating message / quick reply: this pane embeds one overlay of it. */
  readonly float: GameFloat;
  readonly hooks: Pick<LockHooks, "suspend" | "lockNow">;
  readonly api: AdventureGameApi;
  /** The world map (loaded once, lazily); rejects when it cannot be fetched. */
  loadWorld(): Promise<World>;
  /** Test seam: the globe renderer (default `createGlobeRenderer`). */
  createRenderer?(canvas: HTMLCanvasElement, world: World): GlobeRenderer;
  /** The round's anchor message, or undefined once it is gone (deleted, wiped). */
  roundMessage(seq: number): Message | undefined;
  /** This person's display name, and the other person's when it is known. */
  viewer(): string | null;
  partner(): string | null;
  /** Starts the next adventure (the header's New, and Play again). */
  startNextRound(): void;
  /** Opens the Holiday bank screen. */
  openBank(): void;
  /** Call after any change that may have altered the layout's height. */
  afterChange(): void;
  /** Test seams. */
  readonly clock?: {
    now(): number;
    requestFrame(callback: (nowMs: number) => void): number;
    cancelFrame(id: number): void;
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
  random?(): number;
  newId?(): string;
}

export interface AdventureGame {
  /** The game tab's content — sits in the thread view where the message thread is. */
  readonly pane: HTMLElement;
  open(seq: number): void;
  offer(seq: number): void;
  close(): void;
  /** The open round, or null. */
  gameSeq(): number | null;
  /** An `adventure_live` stream frame (the other person's finger). */
  handleLive(frame: AdventureLiveFrame): void;
}

/** A roulette left flickering holds the idle lock off for this long at most (the lock is a privacy
 * feature; a phone put down mid-roulette must still lock). */
export const ROULETTE_SUSPEND_CAP_MS = 90_000;
const SPIN_POST_ATTEMPTS = 3;
const SPIN_POST_RETRY_MS = 800;
const STOP_DEBOUNCE_MS = 700;

export function createAdventureGame(deps: AdventureGameDeps): AdventureGame {
  const doc = deps.document;
  const win = deps.win;
  const clock = deps.clock ?? {
    now: () => performance.now(),
    requestFrame: (cb: (nowMs: number) => void) => win.requestAnimationFrame(cb),
    cancelFrame: (id: number) => win.cancelAnimationFrame(id),
    setTimeout: (cb: () => void, ms: number) => win.setTimeout(cb, ms),
    clearTimeout: (id: number) => win.clearTimeout(id),
  };

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className: string, label: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", onClick);
    return b;
  }

  // -- Pane DOM -------------------------------------------------------------------------------------------

  const pane = el("div", "wx-srv-game wx-srv-adv");
  pane.setAttribute("data-game", "adventure");
  pane.hidden = true;

  const card = el("div", "wx-srv-adv-card");
  card.dataset["pack"] = "none";
  card.dataset["explore"] = "0";
  card.dataset["action"] = "none";

  // Header.
  const optionsButton = button("wx-srv-adv-chip wx-srv-adv-options", "Options", "", () => void openOptions());
  // A word on a wide screen, a gear on a narrow one (CSS): the whole title row must fit a 360 px phone on one line.
  optionsButton.append(el("span", "wx-srv-adv-options-text", "Options"), el("span", "wx-srv-adv-options-gear", "⚙"));
  optionsButton.querySelector(".wx-srv-adv-options-gear")?.setAttribute("aria-hidden", "true");
  optionsButton.setAttribute("aria-haspopup", "dialog");
  const bankButton = button("wx-srv-adv-chip wx-srv-adv-bank", "Open the Holiday bank", "Bank", () => deps.openBank());
  const newButton = button("wx-srv-adv-chip wx-srv-adv-new", "Start a new adventure", "New", () => deps.startNextRound());
  const closeButton = button("wx-srv-adv-chip wx-srv-adv-close", "Close the game", "✕", () => close());
  const bar = el("header", "wx-srv-adv-bar");
  // Yay / Nay (the decision: bank this place / not this one) sit on the LEFT of the row, only while a
  // decision is possible; there is no title text. The row is then just the right-hand buttons.
  const yay = button("wx-srv-adv-chip wx-srv-adv-yay wx-srv-adv-bank-this", "Yay: bank this trip", "Yay", () => void decide("bank"));
  const nay = button("wx-srv-adv-chip wx-srv-adv-nay wx-srv-adv-pass", "Nay: not this one", "Nay", () => askReject());
  const barDecide = el("div", "wx-srv-adv-bar-decide");
  barDecide.hidden = true;
  barDecide.append(yay, nay);
  const barActions = el("div", "wx-srv-adv-bar-actions");
  barActions.append(optionsButton, bankButton, newButton, closeButton);
  bar.append(barDecide, barActions);

  // The stage: the globe and its overlays.
  const canvas = doc.createElement("canvas");
  canvas.className = "wx-srv-adv-globe";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Spinning globe");
  const hintMain = el("div", "wx-srv-adv-hint-main");
  const hintSub = el("div", "wx-srv-adv-hint-sub");
  const hint = el("div", "wx-srv-adv-hint", "");
  hint.setAttribute("aria-live", "polite");
  hint.append(hintMain, hintSub);
  const toast = el("div", "wx-srv-adv-toast");
  toast.setAttribute("role", "status");
  const nearest = el("div", "wx-srv-adv-nearest");
  const litName = el("div", "wx-srv-adv-lit-name");
  const litSub = el("div", "wx-srv-adv-lit-sub");
  const lit = el("div", "wx-srv-adv-lit");
  lit.setAttribute("aria-live", "polite");
  lit.append(litName, litSub);
  // The overlays start invisible (the first frame would otherwise flash them while their fade-out runs).
  for (const overlay of [hint, toast, nearest, lit]) overlay.dataset["show"] = "0";
  const backButton = button("wx-srv-adv-chip wx-srv-adv-back", "Back to the place", "Back to the place", () => scene?.backToPlace(clock.now()));
  backButton.hidden = true;
  const note = el("div", "wx-srv-adv-note");
  const stage = el("section", "wx-srv-adv-stage");
  stage.dataset["interactive"] = "none";
  stage.setAttribute("data-srv-gesture-boundary", "");
  // The canvas joins the stage when the pane is first shown and leaves it when the game closes, so a
  // chat that never plays (or has locked) carries no canvas at all.
  stage.append(hint, toast, nearest, lit, backButton, note);

  // The holiday pack.
  const packTimer = el("span", "wx-srv-adv-pk-timer", "0:00");
  const packPending = el("div", "wx-srv-adv-pk-pending");
  const packPendingText = el("div", "wx-srv-adv-pk-pending-text");
  const packPendingTitle = el("b", "", "Preparing holiday pack… ");
  packPendingText.append(packPendingTitle, packTimer, el("div", "wx-srv-adv-pk-pending-sub", "This can take a couple of minutes."));
  const spinner = el("span", "wx-srv-adv-spinner");
  spinner.setAttribute("aria-hidden", "true");
  packPending.append(spinner, packPendingText);
  const exploreToggle = button("wx-srv-adv-chip wx-srv-adv-explore-toggle", "Explore the map", "Explore map", () => toggleExplore());
  const packBar = el("div", "wx-srv-adv-pk-bar");
  packBar.append(el("span", "wx-srv-adv-pk-bar-title", "Holiday pack"), exploreToggle);
  const packHost = el("div", "wx-srv-adv-pk-host");
  const packSection = el("section", "wx-srv-adv-pack");
  const packPanel: PackPanel = createPackPanel({
    document: doc,
    retry: () => void retryPack(),
    retrying: () => busy.retry,
  });
  packHost.append(packPanel.element);
  packSection.append(packPending, packBar, packHost);

  // The action dock.
  const stopButton = el("button", "wx-srv-adv-stop", "Stop");
  stopButton.type = "button";
  stopButton.setAttribute("data-srv-gesture-boundary", "");
  stopButton.setAttribute("aria-label", "Stop the roulette");
  const dockStop = el("div", "wx-srv-adv-dock-row wx-srv-adv-dock-stop");
  dockStop.append(stopButton);
  const askText = el("div", "wx-srv-adv-ask");
  const neverYes = button("wx-srv-adv-big wx-srv-adv-big-no wx-srv-adv-never", "Never show this place again", "Never show again", () => void decide("reject"));
  const neverNo = button("wx-srv-adv-big wx-srv-adv-big-keep wx-srv-adv-keep", "Keep it", "Keep it", () => cancelReject());
  const askRow = el("div", "wx-srv-adv-dock-row wx-srv-adv-dock-ask-row");
  askRow.append(neverYes, neverNo);
  const dockDecide = el("div", "wx-srv-adv-dock-block wx-srv-adv-dock-decide");
  dockDecide.append(askText, askRow);
  const outcomeText = el("div", "wx-srv-adv-outcome");
  const againButton = button("wx-srv-adv-big wx-srv-adv-big-again wx-srv-adv-again", "Play again", "Play again", () => deps.startNextRound());
  const dockAgain = el("div", "wx-srv-adv-dock-block wx-srv-adv-dock-again");
  dockAgain.append(outcomeText, againButton);
  const dock = el("footer", "wx-srv-adv-dock");
  dock.append(dockStop, dockDecide, dockAgain);

  // The options sheet.
  const optionsSheet = el("div", "wx-srv-adv-sheet");
  optionsSheet.hidden = true;
  optionsSheet.setAttribute("role", "dialog");
  optionsSheet.setAttribute("aria-modal", "true");
  optionsSheet.setAttribute("aria-label", "Adventure Time options");
  const sheetCard = el("div", "wx-srv-adv-sheet-card");
  const sheetHead = el("div", "wx-srv-adv-sheet-head");
  const optionsDone = button("wx-srv-adv-chip wx-srv-adv-sheet-close", "Close the options", "Done", () => closeOptions());
  sheetHead.append(el("h2", "wx-srv-adv-sheet-title", "Options"), optionsDone);
  const advisedInput = doc.createElement("input");
  advisedInput.type = "checkbox";
  advisedInput.id = "wx-srv-adv-opt-advised";
  advisedInput.className = "wx-srv-adv-switch-input";
  advisedInput.setAttribute("data-srv-gesture-boundary", "");
  const advisedTrack = el("span", "wx-srv-adv-switch-track");
  advisedTrack.append(el("span", "wx-srv-adv-switch-knob"));
  const advisedSwitch = el("span", "wx-srv-adv-switch");
  advisedSwitch.append(advisedInput, advisedTrack);
  const advisedRow = el("label", "wx-srv-adv-opt");
  advisedRow.htmlFor = advisedInput.id;
  const advisedText = el("div", "wx-srv-adv-opt-text");
  advisedText.append(
    el("div", "wx-srv-adv-opt-title", "Include places the UK says not to travel to"),
    el("div", "wx-srv-adv-opt-help", "Off by default. Countries where the UK government advises against all travel are left out of the draws."),
  );
  advisedRow.append(advisedText, advisedSwitch);
  const advisedList = el("p", "wx-srv-adv-opt-list");
  const optionsStatus = el("p", "wx-srv-adv-opt-status");
  optionsStatus.setAttribute("role", "status");
  // Map style (per device, never the server's): a satellite photo, a shaded-relief atlas, or the flat
  // illustrated map. The renderer remembers the choice itself (`imagery.writeMapStyle`).
  const styleRow = el("div", "wx-srv-adv-opt-block");
  styleRow.setAttribute("role", "group");
  styleRow.setAttribute("aria-label", "Map style");
  styleRow.append(
    el("div", "wx-srv-adv-opt-title", "Map style"),
    el("div", "wx-srv-adv-opt-help", "Kept on this device only. A photo of the Earth, a shaded-relief atlas, or the classic illustrated map."),
  );
  const styleButtons = new Map<MapStyle, HTMLButtonElement>();
  const styleSeg = el("div", "wx-srv-adv-seg");
  const STYLE_LABELS: Readonly<Record<MapStyle, string>> = { satellite: "Satellite", atlas: "Atlas", classic: "Classic" };
  for (const mapStyle of MAP_STYLES) {
    const b = button("wx-srv-adv-seg-button", `${STYLE_LABELS[mapStyle]} map`, STYLE_LABELS[mapStyle], () => chooseMapStyle(mapStyle));
    b.dataset["mapStyle"] = mapStyle;
    b.setAttribute("aria-pressed", "false");
    styleButtons.set(mapStyle, b);
    styleSeg.append(b);
  }
  const styleNote = el("p", "wx-srv-adv-opt-list");
  styleRow.append(styleSeg, styleNote);
  const imageryCredit = el(
    "p",
    "wx-srv-adv-opt-credit",
    "Map imagery: NASA Visible Earth, Blue Marble Next Generation (July); Natural Earth II shaded relief",
  );
  sheetCard.append(sheetHead, advisedRow, advisedList, styleRow, imageryCredit, optionsStatus);
  optionsSheet.append(sheetCard);
  optionsSheet.addEventListener("pointerdown", (event) => {
    if (event.target === optionsSheet) closeOptions();
  });

  // The column the map and the pack share: it scrolls once the place is chosen (see the CSS), and the
  // chat overlay floats over its bottom corners.
  const column = el("div", "wx-srv-adv-scroll");
  column.append(stage, packSection);
  const body = el("div", "wx-srv-adv-body");
  body.append(
    column,
    deps.float.createOverlay({
      fabLabel: "Open this destination's chat",
      popupTitle: "Adventure chat",
      item: () => deps.tabs.seqOf("adventure"),
    }),
  );
  card.append(bar, body, dock);
  pane.append(card, packPanel.viewer, optionsSheet);

  // -- State ------------------------------------------------------------------------------------------------

  const random = deps.random ?? Math.random;
  const newId = deps.newId ?? (() => (win.crypto?.randomUUID?.() ?? `${Date.now()}-${random().toString(36).slice(2)}`));
  let world: World | null = null;
  let worldPromise: Promise<void> | null = null;
  let worldFailed = false;
  let renderer: GlobeRenderer | null = null;
  let scene: AdventureScene | null = null;
  let drawnSeq: number | null = null;
  let visible = false;
  let frameId: number | null = null;
  let releaseSuspend: (() => void) | null = null;
  let rouletteSince: number | null = null;
  let rejectPending = false;
  let lastHud: Hud | null = null;
  let lastFrameMs = 0;
  let lastAvoidMs = -1000;
  let lastStopAt = -1e9;
  /** When each pending pack was first seen (the elapsed timer counts from there). */
  const packSince = new Map<number, number>();
  const busy = { spin: false, stop: false, decide: false, retry: false };
  let spinRetryTimer: number | null = null;
  let generation = 0;
  let stageW = 0;
  let stageH = 0;
  let resizeObserver: ResizeObserver | null = null;
  const reduceQuery = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const reducedMotion = (): boolean => reduceQuery?.matches === true;

  // Live trail: the sender posts this screen's own drag; the receiver turns the other screen's into a
  // turning globe and a stroke.
  const sender: LiveSender = createLiveSender({
    post: (frame) => deps.api.postLive(frame),
    onLocked: () => deps.hooks.lockNow("unauthorized"),
    setTimeout: (cb, ms) => clock.setTimeout(cb, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    now: () => clock.now(),
    newId,
  });
  const receiver: LiveReceiver = createLiveReceiver({
    isOwn: (clientId) => sender.owns(clientId),
    context: {
      waitingForSpin(anchorSeq, axis) {
        const view = deps.model.view(anchorSeq);
        if (!visible || drawnSeq !== anchorSeq || view === undefined) return false;
        if (axis === "lng") return view.state === "spin_lng" && view.spins.lng === null;
        return view.state === "spin_lat" && view.spins.lat === null;
      },
    },
  });

  // -- The world and the renderer -----------------------------------------------------------------------------

  function setNote(text: string | null): void {
    note.textContent = text ?? "";
    note.hidden = text === null;
  }

  function ensureWorld(): void {
    if (world !== null || worldPromise !== null) return;
    worldFailed = false;
    setNote("Loading the map…");
    worldPromise = deps
      .loadWorld()
      .then((loaded) => {
        worldPromise = null;
        prepareLanding(loaded);
        world = loaded;
        buildStage();
      })
      .catch(() => {
        worldPromise = null;
        worldFailed = true;
        setNote("Couldn't load the map. Tap here to try again.");
      });
  }

  /**
   * Builds the renderer and the scene over the loaded world. The renderer is destroyed again when the
   * game closes or the chat locks (it holds a WebGL context and, with imagery, a few hundred MB of
   * texture on the GPU), so opening the game later builds it afresh; the world itself is cached.
   */
  function buildStage(): void {
    const loaded = world;
    if (loaded === null || scene !== null) return;
    if (canvas.parentElement === null) stage.prepend(canvas);
    try {
      // The imagery layer is a sibling the renderer inserts under the 2D canvas, inside the stage
      // (which is positioned). It follows this device's saved map style, satellite by default.
      renderer = (deps.createRenderer ?? createGlobeRenderer)(canvas, loaded);
    } catch {
      renderer = null;
    }
    scene = new AdventureScene({
      world: loaded,
      reducedMotion,
      vibrate: (ms) => {
        try {
          if (typeof win.navigator.vibrate === "function") win.navigator.vibrate(ms);
        } catch {
          // unsupported (iOS Safari): the flicker is still visible
        }
      },
      serverNowS: () => deps.model.serverNowS(),
      random,
      viewer: deps.viewer,
      partner: deps.partner,
    });
    setNote(null);
    measureStage(true);
    if (drawnSeq !== null) feedView(drawnSeq);
    drawMapStyle();
    ensureLoop();
  }

  function destroyStage(): void {
    stopLoop();
    renderer?.destroy();
    renderer = null;
    scene = null;
    canvas.remove();
    stageW = 0;
    stageH = 0;
  }

  note.addEventListener("click", () => {
    if (worldFailed) ensureWorld();
  });

  function measureStage(force = false): void {
    const rect = stage.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 1 || h < 1) return;
    if (!force && w === stageW && h === stageH) return;
    stageW = w;
    stageH = h;
    renderer?.resize(rect.width, rect.height, win.devicePixelRatio || 1);
    scene?.resize(rect.width, rect.height);
    // Resizing clears the canvas: repaint at once so a stage that is animating its height never flashes.
    if (lastFrame !== null) renderer?.draw(lastFrame, lastFrameMs);
  }

  let lastFrame: Parameters<GlobeRenderer["draw"]>[0] | null = null;

  // -- The frame loop -------------------------------------------------------------------------------------

  function ensureLoop(): void {
    if (frameId !== null || !visible || scene === null) return;
    frameId = clock.requestFrame(tick);
  }

  function stopLoop(): void {
    if (frameId !== null) clock.cancelFrame(frameId);
    frameId = null;
  }

  /** The page's own overlays on the stage, in canvas coordinates: no dot label is drawn over one. */
  function measureAvoid(): void {
    const stageRect = stage.getBoundingClientRect();
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const element of stage.querySelectorAll<HTMLElement>(".wx-srv-adv-hint, .wx-srv-adv-toast, .wx-srv-adv-nearest, .wx-srv-adv-lit, .wx-srv-adv-back")) {
      if (element.hidden || element.getAttribute("data-show") === "0") continue;
      const r = element.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const pad = 6;
      rects.push({ x: r.left - stageRect.left - pad, y: r.top - stageRect.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    }
    scene?.setAvoid(rects);
  }

  function tick(nowMs: number): void {
    frameId = null;
    if (!visible || scene === null) return;
    lastFrameMs = nowMs;
    measureStage();
    if (nowMs - lastAvoidMs > 120) {
      lastAvoidMs = nowMs;
      measureAvoid();
    }
    receiver.sweep(nowMs);
    let swipe = receiver.current(nowMs);
    // The committed spin takes over from the other finger the moment the server has stored it.
    if (swipe !== null && lastView !== null && lastView.spins[swipe.axis] !== null) {
      receiver.finish();
      swipe = null;
    }
    scene.setRemote(swipe, receiver.trail);
    scene.minViewRadiusDeg = renderer?.textured === true ? MIN_VIEW_RADIUS_TEXTURED_DEG : MIN_VIEW_RADIUS_DEG;
    const { frame, hud } = scene.update(nowMs);
    lastFrame = frame;
    renderer?.draw(frame, nowMs);
    applyHud(hud);
    syncSuspension(hud, nowMs);
    ensureLoop();
  }

  // -- The idle lock -----------------------------------------------------------------------------------------

  function syncSuspension(hud: Hud, nowMs: number): void {
    if (hud.roulette) {
      if (rouletteSince === null) rouletteSince = nowMs;
    } else {
      rouletteSince = null;
    }
    const capped = rouletteSince !== null && nowMs - rouletteSince > ROULETTE_SUSPEND_CAP_MS;
    const wanted = visible && hud.animating && !capped;
    if (wanted && releaseSuspend === null) releaseSuspend = deps.hooks.suspend("adventureAnimating");
    else if (!wanted && releaseSuspend !== null) {
      releaseSuspend();
      releaseSuspend = null;
    }
  }

  function dropSuspension(): void {
    if (releaseSuspend !== null) releaseSuspend();
    releaseSuspend = null;
    rouletteSince = null;
  }

  // -- Drawing the HUD ---------------------------------------------------------------------------------------

  const shown = new Map<string, string>();
  function setText(key: string, node: HTMLElement, text: string): void {
    if (shown.get(key) === text) return;
    shown.set(key, text);
    node.textContent = text;
  }
  function setAttr(key: string, node: HTMLElement, name: string, value: string): void {
    if (shown.get(key) === value) return;
    shown.set(key, value);
    node.setAttribute(name, value);
  }

  function formatElapsed(totalS: number): string {
    const s = Math.max(0, Math.floor(totalS));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function applyHud(hud: Hud): void {
    lastHud = hud;
    // No round view yet (it is being read): say so rather than show an empty globe.
    const hintText = hud.phase === "none" ? "Loading…" : hud.hint;
    setText("hint", hintMain, hintText);
    setText("sub", hintSub, hud.sub);
    hintSub.hidden = hud.sub === "";
    setAttr("hintShow", hint, "data-show", hintText === "" ? "0" : "1");
    setText("toast", toast, hud.toast ?? "");
    setAttr("toastShow", toast, "data-show", hud.toast === null ? "0" : "1");
    setText("nearest", nearest, hud.nearest ?? "");
    setAttr("nearestShow", nearest, "data-show", hud.nearest === null ? "0" : "1");
    setText("litName", litName, hud.lit?.name ?? "");
    setText("litSub", litSub, hud.lit?.sub ?? "");
    litSub.hidden = hud.lit === null || hud.lit.sub === null;
    setAttr("litShow", lit, "data-show", hud.lit === null ? "0" : "1");
    setAttr("interactive", stage, "data-interactive", hud.interactive);
    backButton.hidden = !(hud.canExplore && hud.chosen !== null);

    // The dock: Stop while a roulette runs, Bank/No thanks once the place is chosen, Play again at the end.
    const action = hud.action === "decide" && rejectPending ? "ask" : hud.action;
    setAttr("action", card, "data-action", action);
    barDecide.hidden = action !== "decide";
    if (hud.action !== "decide" && rejectPending) rejectPending = false;
    if (hud.action === "stop") {
      setText("stopLabel", stopButton, hud.stopLive ? "Stop" : "Get ready…");
      setAttr("stopLive", stopButton, "data-live", hud.stopLive ? "1" : "0");
      stopButton.setAttribute("aria-disabled", hud.stopLive ? "false" : "true");
    }
    const placeName = hud.chosen?.dest.name ?? "";
    setText("ask", askText, rejectPending && placeName !== "" ? `Never show ${placeName} again?` : "");
    setText("outcome", outcomeText, hud.outcome ?? "");
    applyDecideBusy();

    // The pack: waiting row, or the panel with the globe shrunk.
    const view = lastView;
    const inPlace = hud.chosen !== null && (hud.phase === "chosen" || hud.phase === "decided");
    let packMode: "none" | "pending" | "panel" = "none";
    if (view !== null && inPlace) {
      const state = view.pack.state;
      if (state === "pending" || state === "none") packMode = "pending";
      else packMode = "panel";
    }
    setAttr("pack", card, "data-pack", packMode);
    if (view !== null && packMode === "pending") {
      let since = packSince.get(view.seq);
      if (since === undefined) {
        since = Date.now();
        packSince.set(view.seq, since);
      }
      setText("timer", packTimer, formatElapsed((Date.now() - since) / 1000));
    }
    if (view !== null && packMode === "panel" && hud.chosen !== null) {
      packPanel.render({ seq: view.seq, place: hud.chosen.dest, unitName: hud.chosen.unitName, pack: view.pack });
    }
    // Facts for the tests and for CSS.
    setAttr("phase", pane, "data-phase", hud.phase);
    setAttr("state", pane, "data-state", view?.state ?? "");
    setAttr("lit", pane, "data-lit", hud.litId ?? "");
    setAttr("landing", pane, "data-landing-unit", view?.landing?.landUnit ?? "");
    setAttr("country", pane, "data-country", view?.country?.chosen?.id ?? "");
    setAttr("place", pane, "data-place", view?.destination?.chosen?.id ?? "");
    setAttr("packState", pane, "data-pack-state", view?.pack.state ?? "");
    setAttr("remote", pane, "data-remote", hud.remote ? "1" : "0");
    setAttr("map", pane, "data-map", renderer === null ? "" : `${renderer.mapStyle}${renderer.textured ? "-textured" : ""}`);
  }

  // -- Feeding the scene -----------------------------------------------------------------------------------------

  let lastView: AdventureView | null = null;

  function feedView(seq: number): void {
    const view = deps.model.view(seq);
    lastView = view ?? null;
    if (view === undefined) return;
    scene?.setView(view, clock.now());
  }

  // -- Pointer input ---------------------------------------------------------------------------------------------

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  function local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function distanceBetween(map: Map<number, { x: number; y: number }>): number {
    const [a, b] = [...map.values()];
    return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (scene === null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = local(e);
    if (stage.getAttribute("data-interactive") === "explore") {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // a synthetic pointer: the gesture still works through the events that reach the canvas
      }
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) pinchDistance = distanceBetween(pointers);
      return;
    }
    // Whether a swipe is wanted right now is the scene's call (it knows the round and the clock).
    const started = scene.pointerDown(e.pointerId, p.x, p.y, e.timeStamp);
    if (started === null) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // see above
    }
    if (lastView !== null) sender.begin({ anchorSeq: lastView.seq, axis: started.axis }, started.point, started.rotation);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (scene === null) return;
    const mode = stage.getAttribute("data-interactive");
    const p = local(e);
    // A drag in progress keeps going even though the stage stops advertising "spin" (the scene says
    // so as soon as the finger is down).
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const list = events.length > 0 ? events : [e];
    let moved = false;
    for (const ev of list) {
      const q = local(ev);
      const result = scene.pointerMove(e.pointerId, q.x, q.y, ev.timeStamp);
      if (result !== null) {
        moved = true;
        sender.push(result.point, result.rotation);
      }
    }
    if (moved) return;
    if (mode === "explore" && pointers.has(e.pointerId)) {
      const before = pointers.get(e.pointerId) as { x: number; y: number };
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) scene.explorePan(p.x - before.x, p.y - before.y);
      else if (pointers.size === 2) {
        const d = distanceBetween(pointers);
        if (pinchDistance > 0 && d > 0) scene.exploreZoom(d / pinchDistance);
        pinchDistance = d;
      }
    }
  });

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    pointers.delete(e.pointerId);
    pinchDistance = 0;
    if (scene === null) return;
    const outcome = scene.pointerUp(e.pointerId, e.timeStamp, cancelled);
    if (outcome.kind === "none") {
      sender.cancel();
      return;
    }
    sender.end(scene.shownRotation());
    if (outcome.kind === "spin") void postSpin(outcome);
  }
  canvas.addEventListener("pointerup", (e) => endPointer(e, false));
  canvas.addEventListener("pointercancel", (e) => endPointer(e, true));
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (stage.getAttribute("data-interactive") !== "explore" || scene === null) return;
      e.preventDefault();
      scene.exploreZoom(Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // Stop fires on the press, not the release: what you saw lit is what you get. A keyboard or a screen
  // reader activates it with a click, which is taken only when no press just did.
  function pressStop(): void {
    const now = clock.now();
    if (now - lastStopAt < STOP_DEBOUNCE_MS) return;
    lastStopAt = now;
    void doStop();
  }
  stopButton.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pressStop();
  });
  stopButton.addEventListener("click", () => pressStop());

  // -- Calls -----------------------------------------------------------------------------------------------------

  /** Runs a call, turning a lock (401) into the chat locking and any other throw into "unavailable". */
  async function guarded(call: () => Promise<AdventureOutcome>): Promise<AdventureOutcome> {
    try {
      return await deps.model.run(call);
    } catch (error) {
      if (error instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
      return { ok: false, kind: "unavailable" };
    }
  }

  function currentSeq(): number | null {
    return drawnSeq;
  }

  function notify(text: string): void {
    scene?.notify(text, clock.now());
  }

  async function postSpin(intent: SpinIntent): Promise<void> {
    const seq = currentSeq();
    if (seq === null) return;
    const started = generation;
    busy.spin = true;
    const input: Omit<SpinInput, "sender"> = {
      axis: intent.axis,
      from: intent.plan.from,
      delta: intent.plan.delta,
      durationMs: intent.plan.durationMs,
      ...(intent.landing !== null
        ? {
            result: {
              point: intent.landing.point,
              sea: intent.landing.sea,
              land: intent.landing.land,
              centre: intent.landing.centre,
              landUnit: intent.landing.landUnit,
              candidates: intent.landing.candidates,
            },
          }
        : {}),
    };
    let outcome: AdventureOutcome = { ok: false, kind: "unavailable" };
    for (let attempt = 0; attempt < SPIN_POST_ATTEMPTS; attempt += 1) {
      outcome = await guarded(() => deps.api.spin(seq, input));
      if (started !== generation) return;
      // Replaying the same move is idempotent on the server, so a lost answer is safe to ask again.
      if (outcome.ok || outcome.kind !== "unavailable" || attempt === SPIN_POST_ATTEMPTS - 1) break;
      await new Promise<void>((resolve) => {
        spinRetryTimer = clock.setTimeout(() => {
          spinRetryTimer = null;
          resolve();
        }, SPIN_POST_RETRY_MS);
      });
      if (started !== generation) return;
    }
    busy.spin = false;
    if (outcome.ok) return;
    // The spin never happened for anyone else: this screen takes its own back.
    scene?.discardOwnSpin(intent.axis);
    deps.model.refetch(seq);
    notify(outcome.kind === "bad_state" ? "Somebody else got there first." : "That spin didn't go through. Try again.");
  }

  async function doStop(): Promise<void> {
    const seq = currentSeq();
    if (seq === null || scene === null || busy.stop) return;
    const intent = scene.stopPressed();
    if (intent === null) return;
    const started = generation;
    busy.stop = true;
    let outcome: AdventureOutcome = { ok: false, kind: "unavailable" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      outcome = await guarded(() => deps.api.stop(seq, intent));
      if (started !== generation) return;
      if (outcome.ok || outcome.kind !== "unavailable") break;
    }
    busy.stop = false;
    if (outcome.ok) return;
    scene?.cancelPendingStop();
    deps.model.refetch(seq);
    if (outcome.kind === "exhausted") {
      const name = intent.stage === "country" ? (lastView?.country?.candidates.find((c) => c.id === intent.choice)?.name ?? "there") : "there";
      notify(`Nowhere left to go in ${name}. Hit Stop again for another country.`);
    } else if (outcome.kind === "unavailable" || outcome.kind === "invalid") {
      notify("Couldn't send Stop. Try again.");
    }
    // too_early / bad_state: the re-read shows what happened.
  }

  async function decide(decision: "bank" | "reject"): Promise<void> {
    const seq = currentSeq();
    if (seq === null || busy.decide) return;
    const started = generation;
    busy.decide = true;
    applyDecideBusy();
    const outcome = await guarded(() => deps.api.decide(seq, decision));
    if (started !== generation) return;
    busy.decide = false;
    rejectPending = false;
    if (!outcome.ok) {
      deps.model.refetch(seq);
      notify(outcome.kind === "unavailable" ? "Couldn't save that. Try again." : "Somebody already decided.");
    }
    applyDecideBusy();
  }

  function applyDecideBusy(): void {
    for (const b of [yay, nay, neverYes, neverNo]) b.disabled = busy.decide;
  }

  async function retryPack(): Promise<void> {
    const seq = currentSeq();
    if (seq === null || busy.retry) return;
    const started = generation;
    busy.retry = true; // the next frame redraws the panel with its button waiting
    const outcome = await guarded(() => deps.api.retryPack(seq));
    if (started !== generation) return;
    busy.retry = false;
    if (!outcome.ok) {
      deps.model.refetch(seq);
      notify("Couldn't restart the research. Try again.");
    }
  }

  function askReject(): void {
    rejectPending = true;
    if (lastHud !== null) applyHud(lastHud);
  }

  function cancelReject(): void {
    rejectPending = false;
    if (lastHud !== null) applyHud(lastHud);
  }

  function toggleExplore(): void {
    const exploring = card.dataset["explore"] === "1";
    card.dataset["explore"] = exploring ? "0" : "1";
    exploreToggle.textContent = exploring ? "Explore map" : "Show holiday pack";
    exploreToggle.setAttribute("aria-label", exploring ? "Explore the map" : "Show the holiday pack");
    deps.afterChange();
  }

  // -- Options -----------------------------------------------------------------------------------------------------

  let settings: AdventureSettings | null = null;

  function drawOptions(): void {
    advisedInput.checked = settings?.includeAdvised === true;
    const names = settings?.advisedUnits.map((u) => u.name) ?? [];
    if (names.length === 0) advisedList.textContent = "";
    else {
      const shownNames = names.slice(0, 12).join(", ");
      advisedList.textContent = `${settings?.includeAdvised === true ? "In the draws" : "Left out"}: ${shownNames}${names.length > 12 ? ` and ${names.length - 12} more` : ""}.`;
    }
  }

  /** Marks the map style in use (the renderer's, or this device's saved one before it exists). */
  function drawMapStyle(): void {
    const current: MapStyle = renderer?.mapStyle ?? readMapStyle();
    const noImagery = renderer !== null && !renderer.imageryAvailable;
    for (const [mapStyle, b] of styleButtons) {
      const on = mapStyle === (noImagery ? "classic" : current);
      b.classList.toggle("wx-srv-adv-seg-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.disabled = noImagery && mapStyle !== "classic";
    }
    styleNote.textContent = noImagery ? "This browser can't show map pictures, so the classic map is used." : "";
  }

  function chooseMapStyle(next: MapStyle): void {
    if (renderer !== null) renderer.setMapStyle(next);
    else writeMapStyle(next);
    drawMapStyle();
  }

  async function openOptions(): Promise<void> {
    optionsSheet.hidden = false;
    drawMapStyle();
    optionsStatus.textContent = "Loading…";
    advisedInput.disabled = true;
    const started = generation;
    let result: SettingsResult;
    try {
      result = await deps.api.getSettings();
    } catch (error) {
      if (error instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
      result = { ok: false, kind: "unavailable" };
    }
    if (started !== generation || optionsSheet.hidden) return;
    if (result.ok) {
      settings = result.settings;
      optionsStatus.textContent = "";
      advisedInput.disabled = false;
      drawOptions();
    } else {
      optionsStatus.textContent = "Couldn't load the options. Close this and try again.";
    }
  }

  function closeOptions(): void {
    optionsSheet.hidden = true;
  }

  advisedInput.addEventListener("change", () => {
    const wanted = advisedInput.checked;
    advisedInput.disabled = true;
    optionsStatus.textContent = "Saving…";
    const started = generation;
    void (async () => {
      let result: SettingsResult;
      try {
        result = await deps.api.putSettings(wanted);
      } catch (error) {
        if (error instanceof ServerLockedError) deps.hooks.lockNow("unauthorized");
        result = { ok: false, kind: "unavailable" };
      }
      if (started !== generation) return;
      advisedInput.disabled = false;
      if (result.ok) {
        settings = result.settings;
        optionsStatus.textContent = "";
        // The server announces a real change; this screen's open round re-reads through the model.
        const seq = currentSeq();
        if (seq !== null) deps.model.refetch(seq);
      } else {
        optionsStatus.textContent = "Couldn't save that. Try again.";
      }
      drawOptions();
    })();
  });

  // -- Pane lifecycle ------------------------------------------------------------------------------------------------

  function forgetRound(): void {
    generation += 1;
    busy.spin = false;
    busy.stop = false;
    busy.decide = false;
    busy.retry = false;
    if (spinRetryTimer !== null) clock.clearTimeout(spinRetryTimer);
    spinRetryTimer = null;
    sender.shutdown();
    receiver.clear();
    scene?.clear();
    packPanel.reset();
    packSince.clear();
    pointers.clear();
    pinchDistance = 0;
    rejectPending = false;
    lastView = null;
    lastHud = null;
    lastFrame = null;
    closeOptions();
    card.dataset["explore"] = "0";
    exploreToggle.textContent = "Explore map";
    shown.clear();
    dropSuspension();
  }

  function refreshPane(seq: number): void {
    visible = true;
    if (canvas.parentElement === null) stage.prepend(canvas);
    if (drawnSeq !== seq) {
      // A different round starts from nothing.
      forgetRound();
      drawnSeq = seq;
    }
    if (world !== null) buildStage();
    else ensureWorld();
    if (typeof ResizeObserver === "function" && resizeObserver === null) {
      resizeObserver = new ResizeObserver(() => measureStage());
      resizeObserver.observe(stage);
    }
    if (world !== null) feedView(seq);
    else lastView = deps.model.view(seq) ?? null;
    const view = lastView;
    if (view === null) {
      setText("hint", hintMain, "Loading…");
      setAttr("hintShow", hint, "data-show", "1");
    }
    ensureLoop();
  }

  function forget(): void {
    visible = false;
    stopLoop();
    forgetRound();
    drawnSeq = null;
    packPanel.closeViewer();
    setNote(null);
    destroyStage();
  }

  function close(): void {
    deps.tabs.close("adventure");
  }

  deps.tabs.register({
    key: "adventure",
    tabLabel: "Adventure",
    tabAriaLabel: "Adventure Time game",
    pane,
    exists: (seq) => deps.roundMessage(seq) !== undefined,
    refresh: refreshPane,
    onShow: () => {
      visible = true;
      ensureLoop();
    },
    onHide: () => {
      // Another tab came to the front: nothing may keep running for a pane nobody can see.
      visible = false;
      stopLoop();
      dropSuspension();
      sender.cancel();
      packPanel.closeViewer();
      closeOptions();
    },
    reset: forget,
  });

  return {
    pane,
    open: (seq) => deps.tabs.open("adventure", seq),
    offer: (seq) => deps.tabs.offer("adventure", seq),
    close,
    gameSeq: () => deps.tabs.seqOf("adventure"),
    handleLive(frame) {
      if (!visible) return;
      receiver.apply(frame, clock.now());
    },
  };
}
