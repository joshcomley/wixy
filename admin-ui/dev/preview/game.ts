// Adventure Time preview — the whole flow on one phone, built on the REAL engine modules (physics,
// land, camera, roulette, trail, globe): the same maths the finished pane will call. Nothing here is
// shipped; it exists so the feel can be judged before the pane, server and data are wired together.
//
// Timeline of one adventure (spec §1, §3):
//   idle      -> swipe sideways (spin 1, changes lambda only)
//   idle2     -> swipe up or down (spin 2, changes phi only; it tumbles freely over the poles)
//   landing   -> ripple, (sea) dotted glide to the nearest land, spin round and zoom to the 30 %-inland
//                centre with the candidate countries outlined
//   country   -> roulette, four a second, Stop picks the one the presser SAW lit
//   destination -> the unit's top five places, same again
//   chosen    -> zoom in, the pin drops, the map is explorable; "preparing holiday pack", then the pack
//   decided   -> banked / rejected (never again), "Play again"
//
// `Game` owns no DOM and no timers: `update(now)` advances it and returns the frame to draw plus the
// text the HUD should show; the UI feeds pointer events in.

import {
  cameraAt,
  cameraFromRotation,
  fitCamera,
  meanPoint,
  scaleFor,
  type Camera,
  type LngLat,
} from "../../src/server/adventure/camera";
import type { AvoidRect, GlobeDot, GlobeFrame } from "../../src/server/adventure/globe";
import {
  cameraForUnit,
  computeLanding,
  landingPointFor,
  nearestPointOnUnit,
  type Landing,
} from "../../src/server/adventure/land";
import {
  VelocityTracker,
  dragDeltaDeg,
  easeOutCubic,
  planSpin,
  spinAngleAt,
  spinFinished,
  type SpinPlan,
} from "../../src/server/adventure/physics";
import { litIndexAt, stepAt } from "../../src/server/adventure/roulette";
import { Trail } from "../../src/server/adventure/trail";
import type { World } from "../../src/server/adventure/world";
import { destPoint, eligibleUnits, topFive, type Bank, type BankedTrip, type Dest, type Memory } from "./data";
import { RemoteSwipe, type Axis } from "./remote";

export const ME = "Bubble";
export const OTHER = "Cupcake";

export type Phase =
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
  | "exhausted";

/** Seconds, as on the wire. */
const RIPPLE_S = 1.1;
const GLIDE_START_S = 0.6;
const GLIDE_S = 1.5;
const ZOOM_S = 2.4;
const COUNTRY_ROULETTE_SEA_S = 5.0;
const COUNTRY_ROULETTE_LAND_S = 3.8;
const DEST_ROULETTE_S = 3.5;
const SETTLE_MS = 900;
const ARRIVE_ZOOM_MS = 2800;
const PIN_DROP_MS = 900;
const PACK_DELAY_MS = 6000;
const MAX_RESULT_DEG = 5;

export interface GameDeps {
  readonly world: World;
  readonly bank: Bank;
  readonly memory: Memory;
  readonly reducedMotion: () => boolean;
  readonly vibrate: (ms: number) => void;
  readonly rng: () => number;
}

export interface Hud {
  /** The big pill at the top of the stage. */
  readonly hint: string;
  readonly sub: string;
  readonly toast: string | null;
  /** "Nearest land: X" while the glide runs. */
  readonly nearest: string | null;
  /** The big lit name at the bottom of the stage (country or place), and the place's blurb. */
  readonly lit: { readonly name: string; readonly sub: string | null } | null;
  readonly action: "none" | "stop" | "decide" | "again";
  /** Stop only: is it live? */
  readonly stopLive: boolean;
  readonly stopStage: "country" | "destination" | null;
  /** Pack: null before `chosen`. */
  readonly pack: { readonly state: "pending" | "ready"; readonly elapsedS: number } | null;
  readonly chosen: { readonly dest: Dest; readonly unitName: string } | null;
  readonly outcome: string | null;
  readonly canExplore: boolean;
  readonly interactive: "spin" | "explore" | "none";
}

interface Drag {
  readonly pointerId: number;
  readonly axis: Axis;
  angle: number;
  readonly tracker: VelocityTracker;
}

function randomSeed(rng: () => number): number {
  return Math.floor(rng() * 4294967296) >>> 0;
}

export class Game {
  phase: Phase = "idle";
  /** Raw d3 rotation while spinning. */
  lambda = 0;
  phi = -15;
  landing: Landing | null = null;
  landingMs = 0;
  readonly trail = new Trail();
  lastFrameMs = 0;

  private w = 360;
  private h = 640;
  private turnMine = true;
  private drag: Drag | null = null;
  private plan: SpinPlan | null = null;
  private planStart = 0;
  private remote: RemoteSwipe | null = null;
  private remoteAt = 0;
  private toast: { text: string; until: number } | null = null;
  private avoid: AvoidRect[] = [];
  /** How far in the explorable map may zoom: imagery turns to mush below ~0.8 degrees (set by the page). */
  minViewRadius = 0.3;

  // Camera
  private cam: Camera | null = null;
  private camFrom: Camera | null = null;
  private camTo: Camera | null = null;
  private camStart = 0;
  private camDur = 0;
  private exploreTouch = false;

  // Landing / roulettes
  private eligible = new Set<string>();
  private landedServerS = 0;
  private countryRouletteAtS = 0;
  private countrySeed = 0;
  private candidates: string[] = [];
  private litCountry = -1;
  private chosenCountry: string | null = null;
  private settleStart = 0;
  private dests: Dest[] = [];
  private destRouletteAtS = 0;
  private destSeed = 0;
  private litDest = -1;
  private chosenDest: Dest | null = null;
  private arriveStart = 0;
  private chosenAt = 0;
  private outcome: string | null = null;
  private confirmingReject = false;

  constructor(private readonly deps: GameDeps) {
    this.startRound(performance.now());
  }

  // -- Round control --------------------------------------------------------------------------------

  /** Starts a fresh adventure (the previous one, if unfinished, is simply abandoned). */
  startRound(now: number): void {
    this.phase = "idle";
    this.lambda = this.deps.rng() * 360 - 180;
    this.phi = -15;
    this.landing = null;
    this.drag = null;
    this.plan = null;
    this.remote = null;
    this.cam = null;
    this.camFrom = null;
    this.camTo = null;
    this.candidates = [];
    this.litCountry = -1;
    this.litDest = -1;
    this.chosenCountry = null;
    this.chosenDest = null;
    this.dests = [];
    this.outcome = null;
    this.confirmingReject = false;
    this.exploreTouch = false;
    this.trail.clear();
    this.toast = null;
    this.eligible = eligibleUnits(
      this.deps.bank,
      this.deps.memory,
      (id) => this.deps.world.units.has(id),
      this.deps.memory.settings.includeAdvised,
    );
    this.turnMine = !this.deps.memory.settings.playOther;
    if (!this.turnMine) this.remoteAt = now + 1700;
    if (this.eligible.size === 0) this.phase = "exhausted";
  }

  /** Recomputes which units can be landed on (an option changed, or a place was banked/rejected). */
  refreshEligible(): void {
    this.eligible = eligibleUnits(
      this.deps.bank,
      this.deps.memory,
      (id) => this.deps.world.units.has(id),
      this.deps.memory.settings.includeAdvised,
    );
  }

  /** The page overlays (banner, buttons, cards) the globe must keep its dot labels clear of. */
  setAvoid(rects: AvoidRect[]): void {
    this.avoid = rects;
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  private get scale(): number {
    return scaleFor(90, this.w, this.h);
  }

  private get reduced(): boolean {
    return this.deps.reducedMotion();
  }

  private serverNowS(): number {
    return Date.now() / 1000;
  }

  private notify(text: string, now: number, ms = 2200): void {
    this.toast = { text, until: now + ms };
  }

  // -- Pointer input --------------------------------------------------------------------------------

  /** Pointer positions are CSS pixels relative to the stage's top-left. */
  pointerDown(id: number, x: number, y: number, t: number): void {
    if (this.phase === "idle" && this.turnMine) this.beginDrag(id, "lng", this.lambda, x, y, t);
    else if (this.phase === "idle2" && this.turnMine) this.beginDrag(id, "lat", this.phi, x, y, t);
  }

  private lastX = 0;
  private lastY = 0;

  private beginDrag(id: number, axis: Axis, angle: number, x: number, y: number, t: number): void {
    this.drag = { pointerId: id, axis, angle, tracker: new VelocityTracker() };
    this.drag.tracker.add(angle, t);
    this.lastX = x;
    this.lastY = y;
    this.trail.clear();
    this.addTrailPoint(x, y, t);
  }

  private addTrailPoint(x: number, y: number, t: number): void {
    const r = this.scale;
    this.trail.add((x - this.w / 2) / r, (y - this.h / 2) / r, t);
  }

  pointerMove(id: number, x: number, y: number, t: number): void {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== id) return;
    const r = this.scale;
    // The globe follows the finger, axis-locked: sideways moves lambda, and dragging UP raises phi
    // (d3 lifts the content as phi grows), so dy < 0 means a positive turn.
    if (drag.axis === "lng") drag.angle += dragDeltaDeg(x - this.lastX, r);
    else drag.angle -= dragDeltaDeg(y - this.lastY, r);
    drag.tracker.add(drag.angle, t);
    this.lastX = x;
    this.lastY = y;
    this.addTrailPoint(x, y, t);
  }

  pointerUp(id: number, t: number, cancelled = false): void {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== id) return;
    this.drag = null;
    const v = cancelled ? 0 : drag.tracker.release(t);
    const plan = planSpin(drag.angle, v, drag.axis, this.deps.rng());
    if (plan === null) {
      this.notify("Flick it harder!", t);
      return;
    }
    this.plan = plan;
    this.planStart = t;
    this.phase = drag.axis === "lng" ? "spin1" : "spin2";
  }

  // -- Stop / decisions -----------------------------------------------------------------------------

  /** Stop pressed. What the presser SAW lit is what is chosen. */
  stop(now: number): void {
    if (this.phase === "country" && this.litCountry >= 0) {
      this.chosenCountry = this.candidates[this.litCountry] ?? null;
      if (this.chosenCountry === null) return;
      this.settleStart = now;
      this.phase = "countrySettle";
      this.deps.vibrate(20);
    } else if (this.phase === "destination" && this.litDest >= 0) {
      this.chosenDest = this.dests[this.litDest] ?? null;
      if (this.chosenDest === null) return;
      this.settleStart = now;
      this.phase = "destSettle";
      this.deps.vibrate(20);
    }
  }

  private prepareDestinations(now: number): void {
    const unitId = this.chosenCountry;
    if (unitId === null) return;
    this.dests = topFive(this.deps.bank, this.deps.memory, unitId);
    if (this.dests.length === 0) {
      this.phase = "exhausted";
      return;
    }
    if (this.dests.length === 1) {
      this.chosenDest = this.dests[0] ?? null;
      this.beginArrival(now);
      return;
    }
    const points = this.dests.map(destPoint);
    this.flyTo(fitCamera(meanPoint(points), points, 1.5, 40), now, ZOOM_S * 1000);
    this.destRouletteAtS = this.settleStartS() + DEST_ROULETTE_S;
    this.destSeed = randomSeed(this.deps.rng);
    this.phase = "destination";
    this.litDest = -1;
  }

  private settleStartS(): number {
    return this.serverNowS() - (performance.now() - this.settleStart) / 1000;
  }

  private beginArrival(now: number): void {
    const dest = this.chosenDest;
    if (dest === null) return;
    this.arriveStart = now;
    this.flyTo({ centre: destPoint(dest), viewRadiusDeg: 1.2, roll: 0 }, now, ARRIVE_ZOOM_MS);
    this.phase = "arriving";
  }

  decide(decision: "bank" | "reject", now: number): void {
    if (this.phase !== "chosen" || this.chosenDest === null || this.chosenCountry === null) return;
    const unitName = this.deps.world.units.get(this.chosenCountry)?.name ?? this.chosenCountry;
    if (decision === "bank") {
      const trip: BankedTrip = { unitId: this.chosenCountry, unitName, dest: this.chosenDest, at: Date.now() };
      this.deps.memory.bank(trip);
      this.outcome = `Banked: ${this.chosenDest.name} is saved to your Holiday bank.`;
    } else {
      this.deps.memory.reject(this.chosenDest.id);
      this.outcome = `Got it. ${this.chosenDest.name} won't come up again.`;
    }
    this.confirmingReject = false;
    this.phase = "decided";
    void now;
  }

  askReject(): void {
    if (this.phase === "chosen") this.confirmingReject = true;
  }

  cancelReject(): void {
    this.confirmingReject = false;
  }

  get rejectPending(): boolean {
    return this.confirmingReject;
  }

  // -- Explore (the final map) ----------------------------------------------------------------------

  /** True while the final map can be dragged, pinched and wheeled. */
  get canExplore(): boolean {
    return (this.phase === "chosen" || this.phase === "decided") && this.cam !== null && this.camTo === null;
  }

  explorePan(dx: number, dy: number): void {
    const cam = this.cam;
    if (!this.canExplore || cam === null) return;
    const r = scaleFor(cam.viewRadiusDeg, this.w, this.h);
    const lambda = -cam.centre[0] + dragDeltaDeg(dx, r);
    const phi = Math.max(-89.5, Math.min(89.5, -cam.centre[1] - dragDeltaDeg(dy, r)));
    this.cam = { centre: [-lambda, -phi], viewRadiusDeg: cam.viewRadiusDeg, roll: 0 };
  }

  exploreZoom(factor: number): void {
    const cam = this.cam;
    if (!this.canExplore || cam === null) return;
    this.cam = { ...cam, viewRadiusDeg: Math.max(this.minViewRadius, Math.min(90, cam.viewRadiusDeg / factor)) };
  }

  backToPlace(now: number): void {
    const dest = this.chosenDest;
    if (dest === null || this.cam === null) return;
    this.flyTo({ centre: destPoint(dest), viewRadiusDeg: 1.2, roll: 0 }, now, 900);
  }

  // -- Camera ---------------------------------------------------------------------------------------

  private flyTo(target: Camera, now: number, ms: number): void {
    const from = this.cam ?? cameraFromRotation([this.lambda, this.phi], 90);
    this.camFrom = from;
    this.camTo = target;
    this.camStart = now;
    this.camDur = this.reduced ? 0 : ms;
    this.cam = from;
  }

  private stepCamera(now: number): void {
    if (this.camFrom === null || this.camTo === null) return;
    if (this.camDur <= 0 || now - this.camStart >= this.camDur) {
      this.cam = this.camTo;
      this.camFrom = null;
      this.camTo = null;
      return;
    }
    this.cam = cameraAt(this.camFrom, this.camTo, now - this.camStart, this.camDur);
  }

  // -- The clock ------------------------------------------------------------------------------------

  /** Advances the game to `now` (ms) and returns what to draw and say. */
  update(now: number, dt: number): { frame: GlobeFrame; hud: Hud } {
    this.lastFrameMs = now;
    const reduced = this.reduced;
    this.stepCamera(now);

    switch (this.phase) {
      case "idle":
        this.updateIdle(now, dt, "lng");
        break;
      case "idle2":
        this.updateIdle(now, dt, "lat");
        break;
      case "spin1":
      case "spin2":
        this.updateSpin(now);
        break;
      case "landing":
        this.updateLanding(now);
        break;
      case "country":
        this.updateCountry(now);
        break;
      case "countrySettle":
        if (now - this.settleStart >= (reduced ? 300 : SETTLE_MS)) this.prepareDestinations(now);
        break;
      case "destination":
        this.updateDestination(now);
        break;
      case "destSettle":
        if (now - this.settleStart >= (reduced ? 300 : SETTLE_MS)) this.beginArrival(now);
        break;
      case "arriving":
        if (this.camTo === null && now - this.arriveStart >= (reduced ? 0 : ARRIVE_ZOOM_MS) + (reduced ? 0 : PIN_DROP_MS)) {
          this.phase = "chosen";
          this.chosenAt = now;
        }
        break;
      default:
        break;
    }
    if (this.toast !== null && now > this.toast.until) this.toast = null;
    return { frame: this.frame(now), hud: this.hud(now) };
  }

  private updateIdle(now: number, dt: number, axis: Axis): void {
    if (this.drag !== null) {
      // The globe follows the finger.
      if (axis === "lng") this.lambda = this.drag.angle;
      else this.phi = this.drag.angle;
      return;
    }
    if (!this.turnMine) {
      this.updateRemote(now, axis);
      return;
    }
    // A slow idle drift until the first spin, so the globe feels alive.
    if (axis === "lng" && !this.reduced) this.lambda += dt * 0.0045;
    this.trail.prune(now);
  }

  private updateRemote(now: number, axis: Axis): void {
    if (this.remote === null) {
      if (now < this.remoteAt) return;
      this.remote = new RemoteSwipe(axis, axis === "lng" ? this.lambda : this.phi, now, this.deps.rng);
    }
    const angle = this.remote.update(now, this.trail);
    if (axis === "lng") this.lambda = angle;
    else this.phi = angle;
    if (now >= this.remote.planStartMs) {
      this.plan = this.remote.plan;
      this.planStart = this.remote.planStartMs;
      this.remote = null;
      this.phase = axis === "lng" ? "spin1" : "spin2";
    }
  }

  private updateSpin(now: number): void {
    const plan = this.plan;
    if (plan === null) return;
    const spin1 = this.phase === "spin1";
    const elapsed = this.reduced ? plan.durationMs : now - this.planStart;
    const angle = spinAngleAt(plan, elapsed);
    if (spin1) this.lambda = angle;
    else this.phi = angle;
    this.trail.prune(now);
    if (!spinFinished(plan, elapsed)) return;
    this.plan = null;
    if (spin1) {
      this.phase = "idle2";
      this.turnMine = !this.deps.memory.settings.playOther;
      if (!this.turnMine) this.remoteAt = now + 900;
    } else {
      this.finishSpin2(now);
    }
  }

  private finishSpin2(now: number): void {
    const point = landingPointFor([this.lambda, this.phi]);
    const landing = computeLanding(this.deps.world, this.eligible, point);
    if (landing === null) {
      this.phase = "exhausted";
      return;
    }
    this.landing = landing;
    this.landingMs = now;
    this.landedServerS = this.serverNowS();
    this.candidates = [...landing.candidates];
    this.countrySeed = randomSeed(this.deps.rng);
    this.countryRouletteAtS = this.landedServerS + (landing.sea ? COUNTRY_ROULETTE_SEA_S : COUNTRY_ROULETTE_LAND_S);
    this.litCountry = -1;
    this.phase = "landing";
    this.cam = null;
    this.camFrom = null;
    this.camTo = null;
  }

  private landingZoomStartS(): number {
    return this.landing?.sea === true ? GLIDE_START_S + GLIDE_S + 0.2 : 1.2;
  }

  private updateLanding(now: number): void {
    const landing = this.landing;
    if (landing === null) return;
    const t = (now - this.landingMs) / 1000;
    if (this.cam === null && t >= this.landingZoomStartS()) {
      const centre = landing.centre;
      const near: LngLat[] = landing.candidates.map(
        (id) => nearestPointOnUnit(this.deps.world, id, centre)?.point ?? centre,
      );
      this.flyTo(fitCamera(centre, near, 3, 40), now, ZOOM_S * 1000);
    }
    if (this.serverNowS() >= this.countryRouletteAtS) this.phase = "country";
  }

  private updateCountry(now: number): void {
    void now;
    const step = stepAt(this.serverNowS(), this.countryRouletteAtS);
    const lit = litIndexAt(this.countrySeed, this.candidates.length, step);
    if (lit !== this.litCountry) {
      this.litCountry = lit;
      if (!this.reduced) this.deps.vibrate(8);
    }
  }

  private updateDestination(now: number): void {
    void now;
    const step = stepAt(this.serverNowS(), this.destRouletteAtS);
    const lit = litIndexAt(this.destSeed, this.dests.length, step);
    if (lit !== this.litDest) {
      this.litDest = lit;
      if (!this.reduced && lit >= 0) this.deps.vibrate(8);
    }
  }

  // -- What to draw ---------------------------------------------------------------------------------

  private unitName(id: string | null): string {
    return id === null ? "" : (this.deps.world.units.get(id)?.name ?? id);
  }

  private frame(now: number): GlobeFrame {
    const reduced = this.reduced;
    const spinning = this.cam === null;
    const base: {
      view: GlobeFrame["view"];
      emphasis?: GlobeFrame["emphasis"];
      dots?: GlobeFrame["dots"];
      pin?: GlobeFrame["pin"];
      ripple?: GlobeFrame["ripple"];
      glide?: GlobeFrame["glide"];
      trail?: GlobeFrame["trail"];
      moving?: boolean;
      avoid?: GlobeFrame["avoid"];
      reducedMotion: boolean;
    } = {
      view: spinning ? { rotation: [this.lambda, this.phi], viewRadiusDeg: 90 } : (this.cam as Camera),
      reducedMotion: reduced,
      avoid: this.avoid,
      moving: this.camFrom !== null || this.remote !== null || this.drag !== null || this.phase === "spin1" || this.phase === "spin2" || (this.phase === "idle" && !reduced),
    };

    const landing = this.landing;
    const t = (now - this.landingMs) / 1000;
    switch (this.phase) {
      case "idle":
      case "idle2":
      case "spin1":
      case "spin2":
        base.pin = { kind: "centre" };
        base.trail = this.trail;
        break;
      case "landing":
        // While the dotted glide runs the glide itself is the marker (a pin would hide its start).
        if (!(landing?.sea === true && this.cam === null && t >= GLIDE_START_S)) base.pin = { kind: "centre" };
        if (landing !== null) {
          if (t < RIPPLE_S) base.ripple = { progress: t / RIPPLE_S };
          if (landing.sea && t >= GLIDE_START_S && t < GLIDE_START_S + GLIDE_S + 0.5) {
            base.glide = {
              from: landing.point,
              to: landing.land,
              progress: Math.min(1, (t - GLIDE_START_S) / GLIDE_S),
            };
          }
          if (this.cam !== null) base.emphasis = { candidateUnits: this.candidates };
        }
        break;
      case "country":
        base.pin = { kind: "centre" };
        base.emphasis = {
          candidateUnits: this.candidates,
          litUnit: this.litCountry >= 0 ? (this.candidates[this.litCountry] ?? null) : null,
        };
        break;
      case "countrySettle":
        base.pin = { kind: "centre" };
        base.emphasis = { candidateUnits: this.candidates, chosenUnit: this.chosenCountry };
        break;
      case "destination":
      case "destSettle": {
        base.emphasis = { chosenUnit: this.chosenCountry };
        base.dots = this.dests.map<GlobeDot>((d, i) => ({
          id: d.id,
          lng: d.lng,
          lat: d.lat,
          label: d.name,
          ...(this.phase === "destination" && i === this.litDest ? { lit: true } : {}),
          ...(this.phase === "destSettle" && this.chosenDest?.id === d.id ? { chosen: true } : {}),
        }));
        break;
      }
      case "arriving":
      case "chosen":
      case "decided": {
        // The place itself: no country tint any more, the unit's other bank places as small dots.
        const dest = this.chosenDest;
        if (dest !== null && this.chosenCountry !== null) {
          base.dots = (this.deps.bank.countries[this.chosenCountry]?.destinations ?? [])
            .filter((d) => d.id !== dest.id && !this.deps.memory.isTaken(d.id))
            .map<GlobeDot>((d) => ({ id: d.id, lng: d.lng, lat: d.lat }));
        }
        if (dest !== null) {
          const sinceArrival = now - this.arriveStart - ARRIVE_ZOOM_MS;
          const drop = reduced ? 1 : Math.max(0, Math.min(1, sinceArrival / PIN_DROP_MS));
          if (this.phase !== "arriving" || sinceArrival > 0) base.pin = { kind: "point", lng: dest.lng, lat: dest.lat, drop };
        }
        break;
      }
      default:
        break;
    }
    return base as GlobeFrame;
  }

  private hud(now: number): Hud {
    const mine = this.turnMine;
    const who = mine ? `${ME}'s turn` : `${OTHER} is spinning it`;
    const landing = this.landing;
    const t = (now - this.landingMs) / 1000;
    let hint = "";
    let sub = "";
    let nearest: string | null = null;
    let lit: Hud["lit"] = null;
    let action: Hud["action"] = "none";
    let stopStage: Hud["stopStage"] = null;
    let stopLive = false;
    let interactive: Hud["interactive"] = "none";

    switch (this.phase) {
      case "idle":
        hint = mine ? "Swipe sideways to spin" : `Watch ${OTHER} spin it`;
        sub = who;
        interactive = mine ? "spin" : "none";
        break;
      case "spin1":
        hint = "Spinning...";
        sub = "";
        break;
      case "idle2":
        hint = mine ? "Now spin it up or down" : `${OTHER} spins it up or down`;
        sub = who;
        interactive = mine ? "spin" : "none";
        break;
      case "spin2":
        hint = "Round and round...";
        break;
      case "landing":
      case "country":
        if (landing !== null) {
          if (landing.sea) {
            nearest = t >= GLIDE_START_S && this.cam === null ? `Nearest land: ${this.unitName(landing.landUnit)}` : null;
            hint = t < GLIDE_START_S ? "Splash! Landed in the sea" : "Heading for land...";
          } else {
            hint = `Landed in ${this.unitName(landing.landUnit)}`;
          }
          if (this.cam !== null) hint = this.phase === "country" ? "Which country? Hit Stop!" : "Zooming in...";
          sub = this.cam !== null && this.phase === "landing" ? "Get ready" : "";
        }
        if (this.phase === "country" && this.litCountry >= 0) {
          lit = { name: this.unitName(this.candidates[this.litCountry] ?? null), sub: null };
        }
        action = "stop";
        stopStage = "country";
        stopLive = this.phase === "country" && this.litCountry >= 0;
        break;
      case "countrySettle":
        hint = this.unitName(this.chosenCountry);
        sub = "That's the one!";
        lit = { name: this.unitName(this.chosenCountry), sub: null };
        break;
      case "destination": {
        hint = `Top places in ${this.unitName(this.chosenCountry)}`;
        sub = this.litDest >= 0 ? "Hit Stop to pick one" : "Get ready";
        const d = this.litDest >= 0 ? this.dests[this.litDest] : undefined;
        if (d !== undefined) lit = { name: d.name, sub: d.blurb };
        action = "stop";
        stopStage = "destination";
        stopLive = this.litDest >= 0;
        break;
      }
      case "destSettle":
        hint = this.chosenDest?.name ?? "";
        sub = "Off we go!";
        break;
      case "arriving":
        hint = this.chosenDest?.name ?? "";
        sub = this.unitName(this.chosenCountry);
        break;
      case "chosen":
      case "decided":
        hint = this.chosenDest?.name ?? "";
        sub = `${this.chosenDest?.region ?? ""}, ${this.unitName(this.chosenCountry)}`;
        interactive = this.canExplore ? "explore" : "none";
        action = this.phase === "chosen" ? "decide" : "again";
        break;
      case "exhausted":
        hint = "Every destination has been banked or rejected";
        sub = "Use the settings to forget your choices";
        action = "again";
        break;
      default:
        break;
    }
    const toast = this.toast === null ? null : this.toast.text;
    const chosen =
      this.chosenDest !== null && this.chosenCountry !== null
        ? { dest: this.chosenDest, unitName: this.unitName(this.chosenCountry) }
        : null;
    const pack =
      this.phase === "chosen" || this.phase === "decided"
        ? {
            state: now - this.chosenAt >= PACK_DELAY_MS ? ("ready" as const) : ("pending" as const),
            elapsedS: Math.max(0, (now - this.chosenAt) / 1000),
          }
        : null;
    return {
      hint,
      sub,
      toast,
      nearest,
      lit,
      action,
      stopLive,
      stopStage,
      pack,
      chosen,
      outcome: this.outcome,
      canExplore: this.canExplore,
      interactive,
    };
  }

  /** For the debug corner. */
  describe(): string {
    const l = this.landing;
    if (l === null) return `phase ${this.phase}\nrotation [${this.lambda.toFixed(1)}, ${this.phi.toFixed(1)}]`;
    return [
      `phase ${this.phase}`,
      `point  ${l.point.join(", ")}`,
      `sea    ${l.sea}`,
      `land   ${l.land.join(", ")}`,
      `centre ${l.centre.join(", ")}`,
      `unit   ${l.landUnit}`,
      `cands  ${l.candidates.join(" ")}`,
    ].join("\n");
  }

  easeOut(t: number): number {
    return easeOutCubic(t);
  }
}

export { MAX_RESULT_DEG };
