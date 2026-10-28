// The Adventure Time card (workspace 00056; the `wyrCard.ts` precedent): what a round looks like in the
// MAIN chat — a small static map of the country with the destination dot once it is known, one line of
// status, and a button that opens the game tab. Scrolling up the thread shows each adventure's context
// here; the playing itself (spins, Stop, the pack, the destination's chat) happens in the game tab
// (`adventureGame.ts`). Text comes first: the map appears when the world data has loaded, and a card
// with no map yet (or an unknown country) is just its text. Everything user-visible is set via
// `textContent`.

import { geoOrthographic, geoPath } from "d3-geo";
import type { Message } from "../api/messages";
import { firstDishPicture, type AdventureView, type PackState } from "./api";
import { angularDistanceDeg, clampViewRadius, scaleFor, type Camera } from "./camera";
import { cameraForUnit } from "./land";
import type { AdventureModel } from "./model";
import type { World } from "./world";

export interface AdventureCardDeps {
  readonly model: AdventureModel;
  readonly document: Document;
  /** Opens (or focuses) the game tab for this round. */
  openGame(seq: number): void;
  /** The world map, loaded once; the card's map is painted when it resolves. */
  loadWorld(): Promise<World>;
}

export interface AdventureCards {
  /** Builds the card's container for a round-anchor message. */
  create(message: Message): HTMLElement;
  /** Re-draws the card inside `container` from the model's current state. */
  render(container: HTMLElement, message: Message): void;
}

const MAP_W = 96;
const MAP_H = 72;
const OCEAN = "#17598a";
const LAND = "#f4e8c6";
const COAST = "rgba(122, 92, 50, 0.85)";
const DOT = "#ff4d6a";

/** One line of status for the card, from the view when there is one and the message's summary when not. */
export function adventureStatusLine(view: AdventureView | undefined, summary: Message["adventure"]): string {
  if (view === undefined) {
    if (summary === undefined || summary === null) return "Adventure Time";
    switch (summary.state) {
      case "banked":
        return "Banked ✓";
      case "rejected":
        return "Not for us";
      case "abandoned":
        return "Replaced by a newer adventure";
      default:
        return "Loading…";
    }
  }
  const unit = view.country?.chosen?.name ?? "";
  const place = view.destination?.chosen ?? null;
  const where = place === null ? "" : [place.name, unit].filter((s) => s !== "").join(", ");
  const packState: PackState = view.pack.state;
  const headline = view.pack.data?.headline ?? "";
  switch (view.state) {
    case "spin_lng":
      return "Spin the globe!";
    case "spin_lat":
      return "Spinning…";
    case "country": {
      const landing = view.landing;
      return landing === null ? "Spinning…" : `Landed near ${landing.landUnitName}`;
    }
    case "destination":
      return unit === "" ? "Picking a place…" : `${unit}: picking a place…`;
    case "chosen":
      if (packState === "ready" && headline !== "") return `${where}: ${headline}`;
      if (packState === "failed") return `${where}: the research didn't finish`;
      if (packState === "unavailable") return where;
      return `${where}: preparing the holiday pack`;
    case "banked":
      return headline !== "" ? `Banked ✓ ${where}: ${headline}` : `Banked ✓ ${where}`;
    case "rejected":
      return place === null ? "Not for us" : `Not for us: ${place.name}`;
    case "abandoned":
      return "Replaced by a newer adventure";
  }
}

/** Paints `unitId`'s land (and the destination dot, when known) on a small ocean-blue map. */
export function drawUnitMap(
  canvas: HTMLCanvasElement,
  world: World,
  unitId: string,
  dot: readonly [number, number] | null,
  dpr = 1,
): boolean {
  const unit = world.units.get(unitId);
  if (unit === undefined) return false;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null; // jsdom, a locked-down browser: the card stays text
  }
  if (ctx === null) return false;
  const ratio = Math.max(1, Math.min(2, dpr));
  canvas.width = Math.round(MAP_W * ratio);
  canvas.height = Math.round(MAP_H * ratio);
  const camera: Camera | null = cameraForUnit(world, unitId, 1.5, 40);
  if (camera === null) return false;
  // A destination far from the country's main land (an island, a territory) widens the view to hold it.
  let viewRadius = camera.viewRadiusDeg;
  if (dot !== null) viewRadius = clampViewRadius(Math.max(viewRadius, angularDistanceDeg(camera.centre, dot) * 1.3));
  const scale = scaleFor(viewRadius, MAP_W, MAP_H);
  const projection = geoOrthographic()
    .clipAngle(90)
    .rotate([-camera.centre[0], -camera.centre[1]])
    .scale(scale)
    .translate([MAP_W / 2, MAP_H / 2])
    .precision(0.5);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = OCEAN;
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  const path = geoPath(projection, ctx);
  ctx.beginPath();
  path(unit.detail);
  ctx.fillStyle = LAND;
  ctx.fill();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = COAST;
  ctx.stroke();
  if (dot !== null) {
    const at = projection([dot[0], dot[1]]);
    if (at !== null) {
      ctx.beginPath();
      ctx.arc(at[0], at[1], 4.2, 0, Math.PI * 2);
      ctx.fillStyle = DOT;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }
  return true;
}

export function createAdventureCards(deps: AdventureCardDeps): AdventureCards {
  const doc = deps.document;
  let world: World | null = null;
  let worldRequested = false;
  /** Paint jobs waiting for the world map. */
  const waiting = new Set<() => void>();

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function whenWorld(paint: () => void): void {
    if (world !== null) {
      paint();
      return;
    }
    waiting.add(paint);
    if (worldRequested) return;
    worldRequested = true;
    deps
      .loadWorld()
      .then((loaded) => {
        world = loaded;
        for (const job of [...waiting]) job();
        waiting.clear();
      })
      .catch(() => {
        // No map: the cards stay as text. A later card tries again.
        worldRequested = false;
        waiting.clear();
      });
  }

  function render(container: HTMLElement, message: Message): void {
    const seq = message.seq;
    const view = deps.model.view(seq);
    container.replaceChildren();
    container.dataset["advSeq"] = String(seq);
    container.dataset["advState"] = view?.state ?? message.adventure?.state ?? "";

    const text = el("div", "wx-srv-adv-mcard-text");
    text.append(el("div", "wx-srv-adv-mcard-title", "Adventure Time"));
    text.append(el("p", "wx-srv-adv-mcard-status", adventureStatusLine(view, message.adventure)));
    const finished = (view?.state ?? message.adventure?.state) === "abandoned";
    if (!finished) {
      const open = el("button", "wx-srv-adv-mcard-open", view?.state === "banked" || view?.state === "rejected" ? "Open" : "Play");
      open.type = "button";
      open.setAttribute("data-srv-gesture-boundary", "");
      open.addEventListener("click", () => deps.openGame(seq));
      text.append(open);
    }

    // The pictures, in one column beside the words: the dish photo first (the food is what the operator is
    // looking forward to; it is shown once the pack has one), then the little map of the country.
    const media = el("div", "wx-srv-adv-mcard-media");
    const dish = view === undefined ? null : firstDishPicture(view.pack);
    if (dish !== null) {
      const img = doc.createElement("img");
      img.className = "wx-srv-adv-mcard-dish";
      img.src = dish.thumbUrl;
      img.alt = "A dish to try";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.width = MAP_W;
      img.height = MAP_H;
      // A photo that will not load leaves the card as it was before (the map and the words).
      img.addEventListener("error", () => img.remove());
      media.append(img);
    }

    const unitId = view?.country?.chosen?.id ?? view?.landing?.landUnit ?? null;
    if (unitId !== null) {
      const dest = view?.destination?.chosen ?? null;
      const dot: [number, number] | null = dest === null ? null : [dest.lng, dest.lat];
      const map = doc.createElement("canvas");
      map.className = "wx-srv-adv-mcard-map";
      map.setAttribute("role", "img");
      map.setAttribute("aria-label", dest === null ? "Map of the country" : `Map showing ${dest.name}`);
      map.style.width = `${MAP_W}px`;
      map.style.height = `${MAP_H}px`;
      map.hidden = true;
      media.append(map);
      container.append(media, text);
      whenWorld(() => {
        // (A canvas that is not in the page yet keeps what is painted on it: no `isConnected` check.)
        if (world === null) return;
        if (drawUnitMap(map, world, unitId, dot, doc.defaultView?.devicePixelRatio ?? 1)) map.hidden = false;
      });
    } else {
      if (media.childElementCount > 0) container.append(media);
      container.append(text);
    }
  }

  return {
    create(message) {
      const container = el("div", "wx-srv-adv-mcard");
      render(container, message);
      return container;
    },
    render,
  };
}
