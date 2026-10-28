// Adventure Time's scene: the picture and the words the pane shows, DERIVED from the round's view and
// the server's clock (spec/server-chat/08-adventure-time.md §3, §4.4, §5.3). It owns no DOM and no
// timers: `update(nowMs)` returns the `GlobeFrame` to draw and the `Hud` to say, and the pane feeds
// pointer events in. It is the logic of the approved preview (`dev/preview/game.ts`) re-founded on the
// server's data instead of a local state machine:
//
//   spin_lng -> a swipe sideways (spin 1, changes lambda only), the globe turns for 3.5-7 s
//   spin_lat -> a swipe up or down (spin 2, phi only; it tumbles freely over the poles)
//   country  -> the landing (ripple; at sea a dotted glide to the nearest land), the spin round and zoom
//               to the 30 %-inland centre with the candidate countries outlined, then the roulette
//   destination -> the country's top places, same again
//   chosen / banked / rejected -> zoom to the place, the pin drops, the map is explorable
//
// EVERYTHING TIMED comes from stored server timestamps (`spin.at`, `rouletteAt`), so two screens show the
// same picture and a screen that opens the tab late jumps to the right point:
//   - a spin is `from + delta · easeOutCubic((now − at) / duration)`;
//   - the landing's ripple, glide and zoom run from the end of the second spin;
//   - the country roulette starts at `country.rouletteAt`; the Stop that ended it happened at
//     `destination.rouletteAt − 3.5 s` (the server sets that start 3.5 s after the Stop), so the
//     settle pulse and the flight to the places are timed from there;
//   - the one thing the server never stores is when the LAST Stop happened: the zoom to the place starts
//     when this screen sees `chosen` (or when the person pressed Stop), and a screen that arrives later
//     shows the place at once.
// What is local: the finger (the globe follows it), the spin THIS screen just made (it animates from the
// release at once, before the server has answered), the Stop just pressed (the settle shows at once),
// and the explorable map. Where a local timeline hands over to the server's (a watcher's live drag
// becoming the committed spin; a spin that lost a race), the displayed angle is blended over a few
// hundred milliseconds instead of jumping.

import {
  MIN_VIEW_RADIUS_DEG,
  cameraAt,
  cameraFromRotation,
  fitCamera,
  meanPoint,
  scaleFor,
  type Camera,
  type LngLat,
} from "./camera";
import type {
  AvoidRect,
  GlobeDot,
  GlobeEmphasis,
  GlobeFrame,
  GlobePin,
  GlobeRipple,
  GlobeGlide,
  GlobeView,
} from "./globe";
import { computeLanding, landingPointFor, nearestPointOnUnit, type Landing } from "./land";
import {
  VelocityTracker,
  dragDeltaDeg,
  planSpin,
  spinAngleAt,
  type SpinPlan,
} from "./physics";
import { litIndexAt, stepAt } from "./roulette";
import { Trail } from "./trail";
import type { World } from "./world";
import type { AdventureAxis, AdventureDest, AdventureView } from "./api";
import type { RemoteSwipe } from "./live";

// -- Timing (seconds unless the name says ms; the server's own numbers where it has them) ---------------

const RIPPLE_S = 1.1;
const GLIDE_START_S = 0.6;
const GLIDE_S = 1.5;
/** The zoom to the countries starts this long after the glide ends. */
const GLIDE_TO_ZOOM_S = 0.2;
/** …or this long after the second spin when it landed on land. */
const LAND_ZOOM_DELAY_S = 1.2;
export const ZOOM_S = 2.4;
export const SETTLE_S = 0.9;
/** The server starts the destination roulette this long after the Stop that picked the country. */
export const DEST_ROULETTE_LEAD_S = 3.5;
const ARRIVE_ZOOM_S = 2.8;
const PIN_DROP_S = 0.9;
const BACK_TO_PLACE_MS = 900;
/** Where the watcher's angle catches up to the committed spin, ms. */
export const CATCHUP_MS = 400;
const IDLE_PHI = -15;
const IDLE_DRIFT_DEG_PER_MS = 0.0045;
const PLACE_VIEW_RADIUS_DEG = 1.2;

export type ScenePhase =
  | "none"
  | "idle"
  | "spin1"
  | "idle2"
  | "spin2"
  | "landing"
  | "country"
  | "countrySettle"
  | "destination"
  | "destSettle"
  | "arriving"
  | "chosen"
  | "decided"
  | "replaced";

export interface SceneDeps {
  readonly world: World;
  reducedMotion(): boolean;
  vibrate(ms: number): void;
  /** The server's clock, epoch seconds. */
  serverNowS(): number;
  /** [0, 1): the idle globe's starting angle. */
  random(): number;
  /** This person's display name. */
  viewer(): string | null;
  /** The other person's display name, when it is known. */
  partner(): string | null;
}

export interface Hud {
  readonly phase: ScenePhase;
  /** The big pill at the top of the stage. */
  readonly hint: string;
  readonly sub: string;
  readonly toast: string | null;
  /** "Nearest land: X" while the glide runs. */
  readonly nearest: string | null;
  /** The big lit name at the bottom of the stage (country or place), and the place's blurb. */
  readonly lit: { readonly name: string; readonly sub: string | null } | null;
  /** The id of what the roulette has lit right now, or null. */
  readonly litId: string | null;
  readonly action: "none" | "stop" | "decide" | "again";
  /** Stop only: is it live? */
  readonly stopLive: boolean;
  readonly stopStage: "country" | "destination" | null;
  readonly chosen: { readonly dest: AdventureDest; readonly unitName: string } | null;
  readonly outcome: string | null;
  readonly canExplore: boolean;
  readonly interactive: "spin" | "explore" | "none";
  /** Something is moving on its own (a drag, a spin, a landing, a roulette): the idle lock waits. */
  readonly animating: boolean;
  /** A roulette is flickering (the idle-lock wait for it is capped by the pane). */
  readonly roulette: boolean;
  /** The other person's finger is on the globe right now (their live swipe is being shown). */
  readonly remote: boolean;
}

/** A spin the person just made, for the pane to post. */
export interface SpinIntent {
  readonly kind: "spin";
  readonly axis: AdventureAxis;
  readonly plan: SpinPlan;
  /** The landing for a `lat` spin (the second spin's POST carries it). */
  readonly landing: Landing | null;
}

export type ReleaseOutcome =
  | SpinIntent
  /** Too slow to count as a flick: the globe stays where it was dragged. */
  | { readonly kind: "weak" }
  /** The drag was withdrawn, or there was no drag to end. */
  | { readonly kind: "none" };

export interface StopIntent {
  readonly stage: "country" | "destination";
  /** The id the presser SAW lit. */
  readonly choice: string;
}

interface SpinTimeline {
  readonly plan: SpinPlan;
  readonly startS: number;
  /** A spin this screen made itself (it runs from the release, before the server has answered). */
  readonly own: boolean;
}

interface Blend {
  readonly offset: number;
  readonly startMs: number;
}

interface Drag {
  readonly pointerId: number;
  readonly axis: AdventureAxis;
  angle: number;
  readonly tracker: VelocityTracker;
  lastX: number;
  lastY: number;
}

interface PendingStop extends StopIntent {
  readonly atS: number;
}

interface Prepared {
  /** The camera that frames the candidate countries around the landing centre. */
  readonly countries: Camera | null;
  /** The camera that frames the places. */
  readonly places: Camera | null;
}

function smoothstep(k: number): number {
  const x = Math.max(0, Math.min(1, k));
  return x * x * (3 - 2 * x);
}

function sameName(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function destPoint(dest: AdventureDest): LngLat {
  return [dest.lng, dest.lat];
}

function samePlan(a: SpinPlan, b: SpinPlan): boolean {
  return Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.delta - b.delta) < 1e-6;
}

function endS(tl: SpinTimeline): number {
  return tl.startS + tl.plan.durationMs / 1000;
}

export class AdventureScene {
  // The round on show.
  private view: AdventureView | null = null;
  private eligible: ReadonlySet<string> = new Set();
  private readonly viewTimelines: { lng: SpinTimeline | null; lat: SpinTimeline | null } = { lng: null, lat: null };
  private prepared: Prepared | null = null;

  // Local state: the finger, the spins and Stop this screen just made, the explorable map.
  private w = 360;
  private h = 640;
  private idleLambda: number;
  private idlePhi = IDLE_PHI;
  private drag: Drag | null = null;
  private readonly own: { lng: SpinTimeline | null; lat: SpinTimeline | null } = { lng: null, lat: null };
  private readonly ownLanding: { lat: Landing | null } = { lat: null };
  private readonly blend: { lng: Blend | null; lat: Blend | null } = { lng: null, lat: null };
  private readonly seenSpin: { lng: string | null; lat: string | null } = { lng: null, lat: null };
  private lastShown: { lng: number; lat: number } = { lng: 0, lat: IDLE_PHI };
  private remote: RemoteSwipe | null = null;
  private remoteTrail: Trail | null = null;
  private readonly trail = new Trail();
  private pendingStop: PendingStop | null = null;
  private arriveStartS = Number.NEGATIVE_INFINITY;
  private settleStartS = Number.NEGATIVE_INFINITY;
  private explore: Camera | null = null;
  private exploreTween: { from: Camera; to: Camera; startMs: number; durMs: number } | null = null;
  private toast: { text: string; until: number } | null = null;
  private avoid: AvoidRect[] = [];
  private litCountry = -1;
  private litDest = -1;
  private lastUpdateMs = -1;
  private cameraMoving = false;
  /** How far the explorable map may zoom in: tighter while satellite imagery shows (it turns soft). */
  minViewRadiusDeg = MIN_VIEW_RADIUS_DEG;

  constructor(private readonly deps: SceneDeps) {
    this.idleLambda = deps.random() * 360 - 180;
    this.lastShown = { lng: this.idleLambda, lat: IDLE_PHI };
  }

  // -- The round -------------------------------------------------------------------------------------

  /** Forgets the round on show and everything local about it. */
  clear(): void {
    this.view = null;
    this.viewTimelines.lng = null;
    this.viewTimelines.lat = null;
    this.prepared = null;
    this.drag = null;
    this.own.lng = null;
    this.own.lat = null;
    this.ownLanding.lat = null;
    this.blend.lng = null;
    this.blend.lat = null;
    this.seenSpin.lng = null;
    this.seenSpin.lat = null;
    this.remote = null;
    this.remoteTrail = null;
    this.trail.clear();
    this.pendingStop = null;
    this.arriveStartS = Number.NEGATIVE_INFINITY;
    this.settleStartS = Number.NEGATIVE_INFINITY;
    this.explore = null;
    this.exploreTween = null;
    this.toast = null;
    this.litCountry = -1;
    this.litDest = -1;
    this.eligible = new Set();
    this.idleLambda = this.deps.random() * 360 - 180;
    this.idlePhi = IDLE_PHI;
    this.lastShown = { lng: this.idleLambda, lat: IDLE_PHI };
  }

  get seq(): number | null {
    return this.view?.seq ?? null;
  }

  get currentView(): AdventureView | null {
    return this.view;
  }

  /** Adopts the round's latest view (never an older one of the same round). */
  setView(view: AdventureView, nowMs: number): void {
    if (this.view !== null && this.view.seq !== view.seq) this.clear();
    const previous = this.view;
    if (previous !== null && previous.rev > view.rev) return;
    const first = previous === null;
    const tS = this.deps.serverNowS();

    if (view.eligible !== null) this.eligible = new Set(view.eligible);

    // The spins: a stored one replaces this screen's own only when it is a different move (a race lost).
    for (const axis of ["lng", "lat"] as const) {
      const stored = view.spins[axis];
      const mine = this.own[axis];
      if (stored === null) {
        this.viewTimelines[axis] = null;
        continue;
      }
      const plan: SpinPlan = { from: stored.from, delta: stored.delta, durationMs: stored.durationMs };
      this.viewTimelines[axis] = { plan, startS: stored.at, own: false };
      if (mine !== null && !samePlan(mine.plan, plan)) {
        // Somebody else's move won: this screen's own spin never happened.
        this.own[axis] = null;
        if (axis === "lat") this.ownLanding.lat = null;
      }
      const signature = `${stored.from}|${stored.delta}|${stored.at}`;
      if (this.seenSpin[axis] !== signature) {
        this.seenSpin[axis] = signature;
        // A spin that was already on show (this screen's own) hands over to the server's without a jolt;
        // anything else (a watcher's live drag, a lost race) is blended; the first sight of a round is not.
        const adopting = this.own[axis] === null && !first;
        const elapsedMs = (tS - stored.at) * 1000;
        if (adopting && elapsedMs < stored.durationMs) {
          const target = spinAngleAt(plan, Math.max(0, elapsedMs));
          this.blend[axis] = { offset: this.lastShown[axis] - target, startMs: nowMs };
        }
      }
    }

    // The Stop this screen pressed is answered by the stage moving on.
    const ps = this.pendingStop;
    if (ps !== null) {
      const moved =
        (ps.stage === "country" && view.country?.chosen != null) ||
        (ps.stage === "destination" && view.destination?.chosen != null);
      if (moved) this.pendingStop = null;
    }

    // Reaching the place: time the zoom from the Stop (this screen's, or when it saw `chosen`).
    const reaching = isPlaceState(view.state) && (previous === null || !isPlaceState(previous.state));
    if (reaching) {
      if (previous === null) {
        this.settleStartS = Number.NEGATIVE_INFINITY; // a late joiner sees the place at once
        this.arriveStartS = Number.NEGATIVE_INFINITY;
      } else {
        this.settleStartS = ps !== null && ps.stage === "destination" ? ps.atS : tS;
        this.arriveStartS = this.settleStartS + SETTLE_S;
      }
    }

    this.view = view;
    this.prepared = null;
  }

  /** The 4-decimal landing for the second spin, using the round's current `eligible`. */
  private landingFor(rotation: readonly [number, number]): Landing | null {
    if (this.eligible.size === 0) return null;
    return computeLanding(this.deps.world, this.eligible, landingPointFor(rotation));
  }

  // -- Sizing and overlays -----------------------------------------------------------------------------

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  /** The page overlays (banner, buttons, cards) the globe must keep its dot labels clear of. */
  setAvoid(rects: AvoidRect[]): void {
    this.avoid = rects;
  }

  /** The other screen's finger, as the live receiver shows it now (null when there is none). */
  setRemote(remote: RemoteSwipe | null, trail: Trail | null): void {
    this.remote = remote;
    this.remoteTrail = trail;
  }

  notify(text: string, nowMs: number, ms = 2400): void {
    this.toast = { text, until: nowMs + ms };
  }

  private get reduced(): boolean {
    return this.deps.reducedMotion();
  }

  private get radius(): number {
    return scaleFor(90, this.w, this.h);
  }

  // -- Pointer input ---------------------------------------------------------------------------------

  /** Which axis a swipe would spin right now, or null when the globe is not waiting for one. */
  swipeAxis(tS: number = this.deps.serverNowS()): AdventureAxis | null {
    const v = this.view;
    if (v === null || this.drag !== null) return null;
    if (this.remote?.fingerDown === true) return null;
    if (v.state === "spin_lng" && this.timeline("lng") === null) return "lng";
    if (v.state === "spin_lat" && this.timeline("lat") === null) {
      const lng = this.timeline("lng");
      if (lng !== null && tS >= endS(lng)) return "lat";
    }
    return null;
  }

  /** Pointer positions are CSS pixels relative to the stage's top-left. */
  pointerDown(id: number, x: number, y: number, tMs: number): { axis: AdventureAxis; rotation: [number, number]; point: LngLat } | null {
    const axis = this.swipeAxis();
    if (axis === null) return null;
    const angle = axis === "lng" ? this.shownAngle("lng") : this.shownAngle("lat");
    this.drag = { pointerId: id, axis, angle, tracker: new VelocityTracker(), lastX: x, lastY: y };
    this.drag.tracker.add(angle, tMs);
    this.trail.clear();
    this.addTrailPoint(x, y, tMs);
    return { axis, rotation: this.dragRotation(), point: this.relative(x, y) };
  }

  private relative(x: number, y: number): LngLat {
    const r = this.radius;
    return [(x - this.w / 2) / r, (y - this.h / 2) / r];
  }

  private addTrailPoint(x: number, y: number, tMs: number): void {
    const [rx, ry] = this.relative(x, y);
    this.trail.add(rx, ry, tMs);
  }

  private shownAngle(axis: AdventureAxis): number {
    return this.lastShown[axis];
  }

  private dragRotation(): [number, number] {
    const d = this.drag;
    const lambda = d?.axis === "lng" ? d.angle : this.lastShown.lng;
    const phi = d?.axis === "lat" ? d.angle : this.lastShown.lat;
    return [lambda, phi];
  }

  /** A pointer moved: the globe follows the finger, axis-locked. Returns what the live sender needs. */
  pointerMove(id: number, x: number, y: number, tMs: number): { rotation: [number, number]; point: LngLat } | null {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== id) return null;
    const r = this.radius;
    // Sideways moves lambda; dragging UP raises phi (d3 lifts the content as phi grows), so dy < 0 is a
    // positive turn.
    if (drag.axis === "lng") drag.angle += dragDeltaDeg(x - drag.lastX, r);
    else drag.angle -= dragDeltaDeg(y - drag.lastY, r);
    drag.tracker.add(drag.angle, tMs);
    drag.lastX = x;
    drag.lastY = y;
    this.addTrailPoint(x, y, tMs);
    return { rotation: this.dragRotation(), point: this.relative(x, y) };
  }

  /** The finger lifted (or the gesture was cancelled). */
  pointerUp(id: number, tMs: number, cancelled = false): ReleaseOutcome {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== id) return { kind: "none" };
    this.drag = null;
    // Whatever happens next the globe rests where the finger left it until a spin takes over.
    if (drag.axis === "lng") this.idleLambda = drag.angle;
    else this.idlePhi = drag.angle;
    this.lastShown[drag.axis] = drag.angle;
    if (cancelled) return { kind: "none" };
    const plan = planSpin(drag.angle, drag.tracker.release(tMs));
    if (plan === null) {
      this.notify("Flick it harder!", tMs);
      return { kind: "weak" };
    }
    let landing: Landing | null = null;
    if (drag.axis === "lat") {
      // The second spin's POST carries where it will land: the spin is deterministic, so it is known now.
      const end: [number, number] = [this.lastShown.lng, plan.from + plan.delta];
      landing = this.landingFor(end);
      if (landing === null) {
        this.notify("There's nowhere left to land.", tMs);
        return { kind: "none" };
      }
    }
    const timeline: SpinTimeline = { plan, startS: this.deps.serverNowS(), own: true };
    this.own[drag.axis] = timeline;
    if (drag.axis === "lat") this.ownLanding.lat = landing;
    return { kind: "spin", axis: drag.axis, plan, landing };
  }

  /** The globe's `[λ, φ]` as last shown (the live relay's rotation at a release). */
  shownRotation(): [number, number] {
    return [this.lastShown.lng, this.lastShown.lat];
  }

  /** A spin this screen made could not be sent: it never happened. */
  discardOwnSpin(axis: AdventureAxis): void {
    this.own[axis] = null;
    if (axis === "lat") this.ownLanding.lat = null;
  }

  // -- Stop ------------------------------------------------------------------------------------------

  /** Stop pressed: what the presser SAW lit is what is chosen. Null when nothing is lit to stop. */
  stopPressed(): StopIntent | null {
    const v = this.view;
    if (v === null || this.pendingStop !== null) return null;
    let intent: StopIntent | null = null;
    if (v.state === "country" && v.country !== null && this.litCountry >= 0 && v.country.chosen === null) {
      const unit = v.country.candidates[this.litCountry];
      if (unit !== undefined) intent = { stage: "country", choice: unit.id };
    } else if (v.state === "destination" && v.destination !== null && this.litDest >= 0 && v.destination.chosen === null) {
      const dest = v.destination.candidates[this.litDest];
      if (dest !== undefined) intent = { stage: "destination", choice: dest.id };
    }
    if (intent === null) return null;
    this.pendingStop = { ...intent, atS: this.deps.serverNowS() };
    this.deps.vibrate(20);
    return intent;
  }

  /** The Stop could not be sent (or lost the race): the roulette runs on from the server's time. */
  cancelPendingStop(): void {
    this.pendingStop = null;
  }

  // -- Explore (the final map) -----------------------------------------------------------------------

  get canExplore(): boolean {
    return this.exploreReady(this.deps.serverNowS());
  }

  private exploreReady(tS: number): boolean {
    const v = this.view;
    if (v === null || !isPlaceState(v.state)) return false;
    return tS >= this.arriveStartS + (this.reduced ? 0 : ARRIVE_ZOOM_S);
  }

  private placeCamera(): Camera | null {
    const dest = this.view?.destination?.chosen;
    return dest == null ? null : { centre: destPoint(dest), viewRadiusDeg: PLACE_VIEW_RADIUS_DEG, roll: 0 };
  }

  private currentExploreCamera(): Camera | null {
    return this.explore ?? this.placeCamera();
  }

  explorePan(dx: number, dy: number): void {
    const cam = this.currentExploreCamera();
    if (cam === null || !this.canExplore) return;
    const r = scaleFor(cam.viewRadiusDeg, this.w, this.h);
    const lambda = -cam.centre[0] + dragDeltaDeg(dx, r);
    const phi = Math.max(-89.5, Math.min(89.5, -cam.centre[1] - dragDeltaDeg(dy, r)));
    this.explore = { centre: [-lambda, -phi], viewRadiusDeg: cam.viewRadiusDeg, roll: 0 };
    this.exploreTween = null;
  }

  exploreZoom(factor: number): void {
    const cam = this.currentExploreCamera();
    if (cam === null || !this.canExplore || !(factor > 0)) return;
    this.explore = { ...cam, viewRadiusDeg: Math.max(this.minViewRadiusDeg, Math.min(90, cam.viewRadiusDeg / factor)) };
    this.exploreTween = null;
  }

  backToPlace(nowMs: number): void {
    const place = this.placeCamera();
    const from = this.currentExploreCamera();
    if (place === null || from === null) return;
    this.exploreTween = { from, to: place, startMs: nowMs, durMs: this.reduced ? 0 : BACK_TO_PLACE_MS };
    this.explore = from;
  }

  // -- Timelines and phases ----------------------------------------------------------------------------

  private timeline(axis: AdventureAxis): SpinTimeline | null {
    return this.own[axis] ?? this.viewTimelines[axis];
  }

  /** The angle the globe shows on `axis` at server time `tS`. */
  private angleFor(axis: AdventureAxis, tS: number, nowMs: number): number {
    const tl = this.timeline(axis);
    if (tl !== null) {
      const elapsedMs = this.reduced ? (tS >= tl.startS ? tl.plan.durationMs : 0) : Math.max(0, (tS - tl.startS) * 1000);
      let angle = spinAngleAt(tl.plan, elapsedMs);
      const b = this.blend[axis];
      if (b !== null) {
        const k = (nowMs - b.startMs) / CATCHUP_MS;
        if (k >= 1) this.blend[axis] = null;
        else angle += b.offset * (1 - smoothstep(k));
      }
      return angle;
    }
    if (this.drag !== null && this.drag.axis === axis) return this.drag.angle;
    if (this.remote !== null && this.remote.axis === axis) {
      return axis === "lng" ? this.remote.rotation[0] : this.remote.rotation[1];
    }
    return axis === "lng" ? this.idleLambda : this.idlePhi;
  }

  private spinning(tS: number): boolean {
    for (const axis of ["lng", "lat"] as const) {
      const tl = this.timeline(axis);
      if (tl !== null && tS < endS(tl)) return true;
    }
    return false;
  }

  private landingZoomDelayS(): number {
    return this.view?.landing?.sea === true ? GLIDE_START_S + GLIDE_S + GLIDE_TO_ZOOM_S : LAND_ZOOM_DELAY_S;
  }

  private pendingFor(stage: "country" | "destination"): PendingStop | null {
    return this.pendingStop !== null && this.pendingStop.stage === stage ? this.pendingStop : null;
  }

  private phaseAt(tS: number): ScenePhase {
    const v = this.view;
    if (v === null) return "none";
    switch (v.state) {
      case "abandoned":
        return "replaced";
      case "spin_lng": {
        const lng = this.timeline("lng");
        if (lng === null) return "idle";
        return tS < endS(lng) ? "spin1" : "idle2";
      }
      case "spin_lat": {
        const lng = this.timeline("lng");
        if (lng !== null && tS < endS(lng)) return "spin1";
        const lat = this.timeline("lat");
        if (lat === null) return "idle2";
        return "spin2"; // still turning, or landed and waiting for the server's word
      }
      case "country": {
        const lat = this.timeline("lat");
        if (lat !== null && tS < endS(lat)) return "spin2";
        if (this.pendingFor("country") !== null) return "countrySettle";
        if (v.country !== null && tS >= v.country.rouletteAt) return "country";
        return "landing";
      }
      case "destination": {
        const dest = v.destination;
        if (dest === null || dest.rouletteAt === null) return "destination";
        const stopAt = dest.rouletteAt - DEST_ROULETTE_LEAD_S;
        if (tS < stopAt + (this.reduced ? 0.3 : SETTLE_S)) return "countrySettle";
        if (this.pendingFor("destination") !== null) return "destSettle";
        return "destination";
      }
      case "chosen":
      case "banked":
      case "rejected": {
        if (tS < this.settleStartS + (this.reduced ? 0.3 : SETTLE_S)) return "destSettle";
        if (!this.exploreReady(tS) || this.cameraTweening(tS)) return "arriving";
        return v.state === "chosen" ? "chosen" : "decided";
      }
    }
  }

  private cameraTweening(tS: number): boolean {
    const v = this.view;
    if (v === null || !isPlaceState(v.state)) return false;
    return tS < this.arriveStartS + (this.reduced ? 0 : ARRIVE_ZOOM_S);
  }

  // -- Cameras -----------------------------------------------------------------------------------------

  /** The framing cameras of the round on show, built once per view (`setView` drops the cache). */
  private prepare(): Prepared {
    if (this.prepared !== null) return this.prepared;
    const v = this.view as AdventureView;
    const landing = v.landing;
    let countries: Camera | null = null;
    if (landing !== null && v.country !== null) {
      const centre = landing.centre;
      const near: LngLat[] = v.country.candidates.map(
        (c) => nearestPointOnUnit(this.deps.world, c.id, centre)?.point ?? centre,
      );
      countries = fitCamera(centre, near, 3, 40);
    }
    let places: Camera | null = null;
    if (v.destination !== null && v.destination.candidates.length > 0) {
      const points = v.destination.candidates.map(destPoint);
      places = fitCamera(meanPoint(points), points, 1.5, 40);
    }
    this.prepared = { countries, places };
    return this.prepared;
  }

  /** The camera at server time `tS` in a state after the second spin, or null for the raw rotation. */
  private cameraAtTime(tS: number, nowMs: number, rotationEnd: readonly [number, number]): Camera | null {
    const v = this.view;
    if (v === null) return null;
    const reduced = this.reduced;
    const prep = v.state === "country" || v.state === "destination" || isPlaceState(v.state) ? this.prepare() : null;
    switch (v.state) {
      case "country": {
        const lat = this.timeline("lat");
        if (lat === null || prep?.countries == null) return null;
        const zoomStart = endS(lat) + this.landingZoomDelayS();
        if (tS < zoomStart) return null;
        const from = cameraFromRotation(rotationEnd, 90);
        return reduced ? prep.countries : cameraAt(from, prep.countries, (tS - zoomStart) * 1000, ZOOM_S * 1000);
      }
      case "destination": {
        const dest = v.destination;
        if (prep?.countries == null || prep.places === null || dest === null || dest.rouletteAt === null) return prep?.countries ?? null;
        const zoomStart = dest.rouletteAt - DEST_ROULETTE_LEAD_S + (reduced ? 0 : SETTLE_S);
        if (tS < zoomStart) return prep.countries;
        return reduced ? prep.places : cameraAt(prep.countries, prep.places, (tS - zoomStart) * 1000, ZOOM_S * 1000);
      }
      case "chosen":
      case "banked":
      case "rejected": {
        const place = this.placeCamera();
        if (place === null) return null;
        const through = prep?.places ?? prep?.countries ?? null;
        if (tS < this.arriveStartS + (reduced ? 0 : ARRIVE_ZOOM_S)) {
          if (through === null) return place;
          return reduced ? place : cameraAt(through, place, Math.max(0, tS - this.arriveStartS) * 1000, ARRIVE_ZOOM_S * 1000);
        }
        if (this.exploreTween !== null) {
          const t = this.exploreTween;
          if (t.durMs <= 0 || nowMs - t.startMs >= t.durMs) {
            this.explore = null;
            this.exploreTween = null;
            return place;
          }
          const cam = cameraAt(t.from, t.to, nowMs - t.startMs, t.durMs);
          this.explore = cam;
          return cam;
        }
        return this.explore ?? place;
      }
      default:
        return null;
    }
  }

  // -- The clock -------------------------------------------------------------------------------------

  /** Advances to local time `nowMs` and returns what to draw and say. */
  update(nowMs: number): { frame: GlobeFrame; hud: Hud } {
    const dt = this.lastUpdateMs < 0 ? 0 : Math.min(64, Math.max(0, nowMs - this.lastUpdateMs));
    this.lastUpdateMs = nowMs;
    const tS = this.deps.serverNowS();
    const reduced = this.reduced;
    const v = this.view;
    if (this.toast !== null && nowMs > this.toast.until) this.toast = null;

    // The globe's resting angle follows a remote finger (so it carries on from there afterwards) and
    // drifts slowly before the first spin, so the globe feels alive.
    if (this.remote !== null) {
      if (this.remote.axis === "lng") this.idleLambda = this.remote.rotation[0];
      else this.idlePhi = this.remote.rotation[1];
    }
    if (v !== null && v.state === "spin_lng" && this.drag === null && this.remote === null && this.timeline("lng") === null && !reduced) {
      this.idleLambda += dt * IDLE_DRIFT_DEG_PER_MS;
    }

    const lambda = this.angleFor("lng", tS, nowMs);
    const phi = this.angleFor("lat", tS, nowMs);
    this.lastShown.lng = lambda;
    this.lastShown.lat = phi;

    const phase = this.phaseAt(tS);
    const camera = this.cameraAtTime(tS, nowMs, [lambda, phi]);
    this.cameraMoving = camera !== null && (this.cameraTweening(tS) || this.tweeningToCountries(tS) || this.exploreTween !== null);

    // The fading strokes (the person's own, and the other finger's as the receiver builds it).
    if (this.drag === null) this.trail.prune(nowMs);
    this.remoteTrail?.prune(nowMs);

    this.stepRoulettes(tS, phase);

    const frame = this.buildFrame(tS, nowMs, phase, lambda, phi, camera);
    const hud = this.buildHud(tS, nowMs, phase, camera);
    return { frame, hud };
  }

  private tweeningToCountries(tS: number): boolean {
    const v = this.view;
    if (v === null) return false;
    if (v.state === "country") {
      const lat = this.timeline("lat");
      if (lat === null) return false;
      const start = endS(lat) + this.landingZoomDelayS();
      return tS >= start && tS < start + ZOOM_S;
    }
    if (v.state === "destination" && v.destination?.rouletteAt != null) {
      const start = v.destination.rouletteAt - DEST_ROULETTE_LEAD_S + SETTLE_S;
      return tS >= start && tS < start + ZOOM_S;
    }
    return false;
  }

  private stepRoulettes(tS: number, phase: ScenePhase): void {
    const v = this.view;
    if (v === null) return;
    if (v.state === "country" && v.country !== null && v.country.chosen === null) {
      const pending = this.pendingFor("country");
      let lit: number;
      if (pending !== null) lit = v.country.candidates.findIndex((c) => c.id === pending.choice);
      else lit = phase === "country" ? litIndexAt(v.country.seed, v.country.candidates.length, stepAt(tS, v.country.rouletteAt)) : -1;
      if (lit !== this.litCountry) {
        this.litCountry = lit;
        if (lit >= 0 && pending === null && !this.reduced) this.deps.vibrate(8);
      }
    } else {
      this.litCountry = -1;
    }
    if (v.state === "destination" && v.destination !== null && v.destination.seed !== null && v.destination.rouletteAt !== null && v.destination.chosen === null) {
      const pending = this.pendingFor("destination");
      let lit: number;
      if (pending !== null) lit = v.destination.candidates.findIndex((d) => d.id === pending.choice);
      else if (phase === "countrySettle") lit = -1;
      else lit = litIndexAt(v.destination.seed, v.destination.candidates.length, stepAt(tS, v.destination.rouletteAt));
      if (lit !== this.litDest) {
        this.litDest = lit;
        if (lit >= 0 && pending === null && !this.reduced) this.deps.vibrate(8);
      }
    } else {
      this.litDest = -1;
    }
  }

  // -- What to draw ----------------------------------------------------------------------------------

  private unitName(id: string | null): string {
    if (id === null) return "";
    const named = this.view?.country?.candidates.find((c) => c.id === id)?.name;
    return named ?? this.deps.world.units.get(id)?.name ?? id;
  }

  private buildFrame(
    tS: number,
    nowMs: number,
    phase: ScenePhase,
    lambda: number,
    phi: number,
    camera: Camera | null,
  ): GlobeFrame {
    const reduced = this.reduced;
    const v = this.view;
    const view: GlobeView = camera ?? { rotation: [lambda, phi], viewRadiusDeg: 90 };
    const spinning = this.spinning(tS);
    const remoteActive = this.remote !== null;
    const ownTrailVisible = !this.trail.isEmpty(nowMs);
    const trail = ownTrailVisible || this.remoteTrail === null ? this.trail : this.remoteTrail;
    const driftIdle = v !== null && v.state === "spin_lng" && this.timeline("lng") === null && !reduced;
    const frame: {
      view: GlobeView;
      emphasis?: GlobeEmphasis;
      dots?: GlobeDot[];
      pin?: GlobePin;
      ripple?: GlobeRipple;
      glide?: GlobeGlide;
      trail?: Trail;
      moving: boolean;
      avoid: AvoidRect[];
      reducedMotion: boolean;
    } = {
      view,
      reducedMotion: reduced,
      avoid: this.avoid,
      moving: this.cameraMoving || this.drag !== null || remoteActive || spinning || driftIdle,
    };
    if (v === null) return frame;

    switch (phase) {
      case "idle":
      case "spin1":
      case "idle2":
      case "spin2":
        frame.pin = { kind: "centre" };
        frame.trail = trail;
        if (phase === "spin2" || (phase === "idle2" && ownTrailVisible)) frame.trail = trail;
        break;
      case "landing":
      case "country": {
        const landing = v.landing;
        const lat = this.timeline("lat");
        if (landing !== null && lat !== null) {
          const u = tS - endS(lat);
          const zooming = camera !== null;
          const glideActive = landing.sea && !zooming && u >= GLIDE_START_S && !reduced;
          if (!glideActive) frame.pin = { kind: "centre" };
          if (!reduced && u >= 0 && u < RIPPLE_S) frame.ripple = { progress: u / RIPPLE_S };
          if (glideActive && u < GLIDE_START_S + GLIDE_S + 0.5) {
            frame.glide = { from: landing.point, to: landing.land, progress: Math.min(1, (u - GLIDE_START_S) / GLIDE_S) };
          }
        } else {
          frame.pin = { kind: "centre" };
        }
        if (camera !== null && v.country !== null) {
          const lit = this.litCountry >= 0 ? (v.country.candidates[this.litCountry]?.id ?? null) : null;
          frame.emphasis = {
            candidateUnits: v.country.candidates.map((c) => c.id),
            ...(lit !== null ? { litUnit: lit } : {}),
          };
        }
        break;
      }
      case "countrySettle": {
        // Either the settle after the country Stop (the view has moved to the places) or this screen's own
        // Stop that the server has not answered yet.
        const chosen = v.country?.chosen?.id ?? this.pendingFor("country")?.choice ?? null;
        frame.pin = { kind: "centre" };
        frame.emphasis = {
          candidateUnits: v.country?.candidates.map((c) => c.id) ?? [],
          ...(chosen !== null ? { chosenUnit: chosen } : {}),
        };
        break;
      }
      case "destination":
      case "destSettle": {
        const dest = v.destination;
        if (v.country?.chosen != null) frame.emphasis = { chosenUnit: v.country.chosen.id };
        if (dest !== null) {
          const chosenId = dest.chosen?.id ?? this.pendingFor("destination")?.choice ?? null;
          frame.dots = dest.candidates.map<GlobeDot>((d, i) => ({
            id: d.id,
            lng: d.lng,
            lat: d.lat,
            label: d.name,
            ...(phase === "destination" && i === this.litDest && chosenId === null ? { lit: true } : {}),
            ...(chosenId === d.id ? { chosen: true } : {}),
          }));
        }
        break;
      }
      case "arriving":
      case "chosen":
      case "decided": {
        // The place itself: no country tint any more, the country's other places as small dots.
        const chosen = v.destination?.chosen ?? null;
        if (chosen !== null) {
          frame.dots = (v.destination?.candidates ?? [])
            .filter((d) => d.id !== chosen.id)
            .map<GlobeDot>((d) => ({ id: d.id, lng: d.lng, lat: d.lat }));
          const sinceArrival = tS - (this.arriveStartS + ARRIVE_ZOOM_S);
          const drop = reduced ? 1 : Math.max(0, Math.min(1, sinceArrival / PIN_DROP_S));
          if (phase !== "arriving" || sinceArrival > 0) frame.pin = { kind: "point", lng: chosen.lng, lat: chosen.lat, drop };
        }
        break;
      }
      case "replaced":
      case "none":
        break;
    }
    return frame as GlobeFrame;
  }

  // -- What to say -----------------------------------------------------------------------------------

  private side(by: string | null): "me" | "partner" | null {
    if (by === null) return null;
    return sameName(by, this.deps.viewer()) ? "me" : "partner";
  }

  /** "Your turn" / "<name>'s turn" for the move after one made by `lastBy` (the starter makes the first). */
  private turnText(lastBy: string | null): string {
    const v = this.view;
    let expected: "me" | "partner" | null;
    if (lastBy === null) expected = v === null ? null : this.side(v.startedBy);
    else {
      const last = this.side(lastBy);
      expected = last === null ? null : last === "me" ? "partner" : "me";
    }
    if (expected === null) return "";
    if (expected === "me") return "Your turn";
    const partner = this.deps.partner();
    return partner !== null && partner.trim() !== "" ? `${partner}'s turn` : "Their turn";
  }

  private byText(by: string | null, verb: string): string {
    if (by === null || by === "") return "";
    return this.side(by) === "me" ? "" : `${by} ${verb}`;
  }

  private buildHud(tS: number, nowMs: number, phase: ScenePhase, camera: Camera | null): Hud {
    const v = this.view;
    let hint = "";
    let sub = "";
    let nearest: string | null = null;
    let lit: Hud["lit"] = null;
    let litId: string | null = null;
    let action: Hud["action"] = "none";
    let stopStage: Hud["stopStage"] = null;
    let stopLive = false;
    let interactive: Hud["interactive"] = "none";
    let outcome: string | null = null;
    let roulette = false;

    if (v !== null) {
      const landing = v.landing;
      const lat = this.timeline("lat");
      const u = lat === null ? 0 : tS - endS(lat);
      switch (phase) {
        case "idle": {
          const swipe = this.swipeAxis(tS) === "lng";
          if (this.remote?.fingerDown === true) {
            hint = "Watch them spin it";
            const partner = this.deps.partner();
            if (partner !== null && partner.trim() !== "") hint = `${partner} is spinning it`;
          } else {
            hint = "Swipe sideways to spin";
            sub = this.turnText(null);
          }
          interactive = swipe ? "spin" : "none";
          break;
        }
        case "spin1":
          hint = "Spinning…";
          sub = this.byText(v.spins.lng?.by ?? null, "spun it");
          break;
        case "idle2": {
          const swipe = this.swipeAxis(tS) === "lat";
          if (this.remote?.fingerDown === true) {
            const partner = this.deps.partner();
            hint = partner !== null && partner.trim() !== "" ? `${partner} is spinning it` : "Watch them spin it";
          } else {
            hint = "Now spin it up or down";
            sub = this.turnText(v.spins.lng?.by ?? null);
          }
          interactive = swipe ? "spin" : "none";
          break;
        }
        case "spin2":
          hint = lat !== null && tS >= endS(lat) ? "Landing…" : "Round and round…";
          sub = this.byText(v.spins.lat?.by ?? null, "spun it");
          break;
        case "landing":
        case "country": {
          if (landing !== null) {
            if (landing.sea) {
              nearest = u >= GLIDE_START_S && camera === null ? `Nearest land: ${landing.landUnitName}` : null;
              hint = u < GLIDE_START_S ? "Splash! Landed in the sea" : "Heading for land…";
            } else {
              hint = `Landed in ${landing.landUnitName}`;
            }
          }
          if (camera !== null) hint = phase === "country" ? "Which country? Hit Stop!" : "Zooming in…";
          sub = camera !== null && phase === "landing" ? "Get ready" : "";
          if (phase === "country" && this.litCountry >= 0) {
            const unit = v.country?.candidates[this.litCountry];
            if (unit !== undefined) {
              lit = { name: unit.name, sub: null };
              litId = unit.id;
            }
          }
          action = "stop";
          stopStage = "country";
          stopLive = phase === "country" && this.litCountry >= 0 && this.pendingStop === null;
          roulette = phase === "country";
          break;
        }
        case "countrySettle": {
          const id = v.country?.chosen?.id ?? this.pendingFor("country")?.choice ?? null;
          hint = this.unitName(id);
          sub = "That's the one!";
          lit = { name: this.unitName(id), sub: null };
          litId = id;
          break;
        }
        case "destination": {
          const dest = v.destination;
          hint = `Top places in ${v.country?.chosen?.name ?? ""}`.trim();
          sub = this.litDest >= 0 ? "Hit Stop to pick one" : "Get ready";
          const d = this.litDest >= 0 ? dest?.candidates[this.litDest] : undefined;
          if (d !== undefined) {
            lit = { name: d.name, sub: d.blurb === "" ? null : d.blurb };
            litId = d.id;
          }
          action = "stop";
          stopStage = "destination";
          stopLive = this.litDest >= 0 && this.pendingStop === null;
          roulette = true;
          break;
        }
        case "destSettle": {
          const id = v.destination?.chosen?.id ?? this.pendingFor("destination")?.choice ?? null;
          const name = v.destination?.candidates.find((d) => d.id === id)?.name ?? "";
          hint = name;
          sub = "Off we go!";
          litId = id;
          break;
        }
        case "arriving":
          hint = v.destination?.chosen?.name ?? "";
          sub = v.country?.chosen?.name ?? "";
          break;
        case "chosen":
        case "decided": {
          const chosen = v.destination?.chosen ?? null;
          hint = chosen?.name ?? "";
          sub = [chosen?.region ?? "", v.country?.chosen?.name ?? ""].filter((s) => s !== "").join(", ");
          interactive = this.canExplore ? "explore" : "none";
          action = phase === "chosen" ? "decide" : "again";
          if (v.state === "banked" || v.state === "rejected") {
            const who = v.decidedBy === null ? "" : this.side(v.decidedBy) === "me" ? "You" : v.decidedBy;
            const name = chosen?.name ?? "This place";
            if (v.state === "banked") {
              outcome = who === "" ? `${name} is saved to your Holiday bank.` : `${who} banked ${name}: it's in your Holiday bank.`;
            } else {
              outcome = who === "" ? `${name} won't come up again.` : `${who} passed on ${name}: it won't come up again.`;
            }
          }
          break;
        }
        case "replaced":
          hint = "This adventure was replaced";
          sub = "A newer one has started";
          action = "again";
          break;
        case "none":
          break;
      }
    }

    const unit = v?.country?.chosen?.name ?? "";
    const chosenDest = v?.destination?.chosen ?? null;
    const chosen = chosenDest !== null && (phase === "chosen" || phase === "decided" || phase === "arriving") ? { dest: chosenDest, unitName: unit } : null;
    const dragging = this.drag !== null;
    const remoteDown = this.remote?.fingerDown === true;
    const animating =
      dragging ||
      remoteDown ||
      phase === "spin1" ||
      phase === "spin2" ||
      phase === "landing" ||
      phase === "country" ||
      phase === "countrySettle" ||
      phase === "destination" ||
      phase === "destSettle" ||
      phase === "arriving";
    return {
      phase,
      hint,
      sub,
      toast: this.toast === null ? null : this.toast.text,
      nearest,
      lit,
      litId,
      action,
      stopLive,
      stopStage,
      chosen,
      outcome,
      canExplore: interactive === "explore",
      interactive,
      animating,
      roulette,
      remote: remoteDown,
    };
  }

  /** For the debug corner and tests. */
  describe(): string {
    const v = this.view;
    if (v === null) return "no round";
    return [`state ${v.state}`, `lambda ${this.lastShown.lng.toFixed(1)} phi ${this.lastShown.lat.toFixed(1)}`].join("\n");
  }

}

function isPlaceState(state: AdventureView["state"]): boolean {
  return state === "chosen" || state === "banked" || state === "rejected";
}
