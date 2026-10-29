import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Camera } from "../../src/server/adventure/camera";
import { prepareLanding } from "../../src/server/adventure/land";
import { MIN_VIEW_RADIUS_DEG } from "../../src/server/adventure/camera";
import { dragDeltaDeg, spinAngleAt } from "../../src/server/adventure/physics";
import { litIndexAt, stepAt } from "../../src/server/adventure/roulette";
import { AdventureScene, CATCHUP_MS, DEST_ROULETTE_LEAD_S, SETTLE_S, type Hud } from "../../src/server/adventure/scene";
import type { RemoteSwipe } from "../../src/server/adventure/live";
import { Trail } from "../../src/server/adventure/trail";
import type { World } from "../../src/server/adventure/world";
import type { GlobeFrame } from "../../src/server/adventure/globe";
import type { AdventureView } from "../../src/server/adventure/api";
import { DEST_A, DEST_B, DEST_C, NOW, spin, testWorld, view } from "./adventureFixtures";

let world: World;
beforeAll(() => {
  world = testWorld();
  prepareLanding(world);
});

const T0 = NOW;

interface Rig {
  scene: AdventureScene;
  /** The server clock, seconds. */
  clock: { s: number };
  vibrate: ReturnType<typeof vi.fn<(ms: number) => void>>;
  names: { viewer: string | null; partner: string | null };
  motion: { reduced: boolean };
  /** update at local time `ms` and server time `s`. */
  at(s: number, ms?: number): { frame: GlobeFrame; hud: Hud };
  ms: { t: number };
}

function rig(random: () => number = () => 0.5): Rig {
  const clock = { s: T0 };
  const vibrate = vi.fn<(ms: number) => void>();
  const names: Rig["names"] = { viewer: "Ann", partner: "Bea" };
  const motion = { reduced: false };
  const ms = { t: 1000 };
  const scene = new AdventureScene({
    world,
    reducedMotion: () => motion.reduced,
    vibrate,
    serverNowS: () => clock.s,
    random, // by default 0.5: the idle globe starts at lambda 0
    viewer: () => names.viewer,
    partner: () => names.partner,
  });
  scene.resize(360, 640);
  return {
    scene,
    clock,
    vibrate,
    names,
    motion,
    ms,
    at(s, local) {
      clock.s = s;
      ms.t = local ?? ms.t + 16;
      return scene.update(ms.t);
    },
  };
}

function rotationOf(frame: GlobeFrame): readonly [number, number] {
  const v = frame.view as { rotation?: readonly number[] };
  expect(v.rotation, "a raw-rotation view").toBeDefined();
  return [v.rotation?.[0] ?? NaN, v.rotation?.[1] ?? NaN];
}

function cameraOf(frame: GlobeFrame): Camera {
  const v = frame.view as Camera;
  expect(v.centre, "a camera view").toBeDefined();
  return v;
}

/** A horizontal swipe on the stage; returns what the release made. */
function swipe(r: Rig, axis: "lng" | "lat", pixels: number, ms: number, id = 1) {
  const t0 = r.ms.t;
  const x0 = 180;
  const y0 = 320;
  const down = r.scene.pointerDown(id, x0, y0, t0);
  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    const f = i / steps;
    const dx = axis === "lng" ? pixels * f : 0;
    const dy = axis === "lat" ? -pixels * f : 0;
    r.scene.pointerMove(id, x0 + dx, y0 + dy, t0 + ms * f);
  }
  const up = r.scene.pointerUp(id, t0 + ms + 3);
  r.ms.t = t0 + ms + 3;
  return { down, up };
}

describe("scene: the idle globe and a swipe", () => {
  it("waits for a sideways swipe, says whose turn it is, and is interactive", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    const { hud, frame } = r.at(T0);
    expect(hud.phase).toBe("idle");
    expect(hud.hint).toBe("Swipe sideways to spin");
    expect(hud.sub).toBe("Your turn"); // Ann started it and Ann is the viewer
    expect(hud.interactive).toBe("spin");
    expect(hud.animating).toBe(false);
    expect(hud.action).toBe("none");
    expect(frame.pin).toEqual({ kind: "centre" });
    expect(rotationOf(frame)[1]).toBe(-15);
  });

  it("names the other person when it is their turn, and says nothing when it cannot tell", () => {
    const r = rig();
    r.scene.setView(view("spin_lng", { startedBy: "Bea" }), r.ms.t);
    expect(r.at(T0).hud.sub).toBe("Bea's turn");
    r.names.partner = null;
    expect(r.at(T0).hud.sub).toBe("Their turn");
    r.names.viewer = null;
    expect(r.at(T0).hud.sub).toBe("Their turn"); // nobody is "me": the starter is "them"
  });

  it("drifts slowly before the first spin, unless motion is reduced", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    const a = rotationOf(r.at(T0, 1000).frame)[0];
    const b = rotationOf(r.at(T0, 3000).frame)[0];
    expect(b).toBeGreaterThan(a);
    r.motion.reduced = true;
    const c = rotationOf(r.at(T0, 5000).frame)[0];
    const d = rotationOf(r.at(T0, 7000).frame)[0];
    expect(d).toBe(c);
  });

  it("the globe follows the finger, sideways only", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const start = rotationOf(r.at(T0).frame)[0];
    const down = r.scene.pointerDown(1, 180, 320, 1000);
    expect(down?.axis).toBe("lng");
    const radius = 0.45 * 360; // the globe's radius on a 360 x 640 stage
    const moved = r.scene.pointerMove(1, 180 + 40, 320 + 90, 1016); // a diagonal move: only the sideways part counts
    expect(moved?.rotation[0]).toBeCloseTo(start + dragDeltaDeg(40, radius), 6);
    expect(moved?.rotation[1]).toBe(-15);
    expect(moved?.point[0]).toBeCloseTo(40 / radius, 9);
    expect(rotationOf(r.at(T0).frame)[0]).toBeCloseTo(start + dragDeltaDeg(40, radius), 6);
    expect(r.at(T0).hud.animating).toBe(true); // a finger on the globe holds the idle lock off
  });

  it("a flick starts the spin at once from the release, ending at from + delta; the hint says it is spinning", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const { up } = swipe(r, "lng", 160, 120);
    expect(up.kind).toBe("spin");
    if (up.kind !== "spin") return;
    expect(up.axis).toBe("lng");
    expect(Math.abs(up.plan.delta)).toBeGreaterThanOrEqual(720);
    expect(up.plan.durationMs).toBeGreaterThanOrEqual(3500);
    expect(up.landing).toBeNull(); // only the second spin carries a landing
    // Half way through, the globe is where the plan says, and the idle lock is held off.
    const { frame, hud } = r.at(T0 + up.plan.durationMs / 2000);
    expect(rotationOf(frame)[0]).toBeCloseTo(spinAngleAt(up.plan, up.plan.durationMs / 2), 3); // (the clock is 1.8e9 s: floats)
    expect(hud.phase).toBe("spin1");
    expect(hud.hint).toBe("Spinning…");
    expect(hud.animating).toBe(true);
    expect(hud.interactive).toBe("none");
    // The end: exactly from + delta.
    expect(rotationOf(r.at(T0 + up.plan.durationMs / 1000 + 1).frame)[0]).toBeCloseTo(up.plan.from + up.plan.delta, 3);
  });

  it("a slow swipe is not a flick: 'Flick it harder!', and the globe stays where it was dragged", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const { up } = swipe(r, "lng", 30, 900);
    expect(up.kind).toBe("weak");
    const { hud, frame } = r.at(T0, r.ms.t + 10);
    expect(hud.toast).toBe("Flick it harder!");
    expect(hud.phase).toBe("idle");
    const rested = rotationOf(frame)[0];
    expect(rotationOf(r.at(T0, r.ms.t + 20).frame)[0]).toBeGreaterThanOrEqual(rested); // it carries on from there
    // The toast goes away on its own.
    expect(r.at(T0, r.ms.t + 5000).hud.toast).toBeNull();
  });

  it("a cancelled gesture (a second finger, the page hiding) makes no spin", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    r.scene.pointerDown(1, 180, 320, 1000);
    r.scene.pointerMove(1, 260, 320, 1016);
    expect(r.scene.pointerUp(1, 1020, true)).toEqual({ kind: "none" });
    expect(r.at(T0).hud.phase).toBe("idle");
  });

  it("ignores a pointer that is not the one dragging, and a swipe when the round is not waiting for one", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    expect(r.scene.pointerDown(1, 180, 320, 1000)).not.toBeNull();
    expect(r.scene.pointerDown(2, 180, 320, 1001)).toBeNull(); // already dragging
    expect(r.scene.pointerMove(2, 200, 320, 1010)).toBeNull();
    expect(r.scene.pointerUp(2, 1020)).toEqual({ kind: "none" });
    const done = rig();
    done.scene.setView(view("country"), done.ms.t);
    done.at(T0);
    expect(done.scene.pointerDown(1, 180, 320, 1000)).toBeNull();
  });
});

describe("scene: the second spin and its landing", () => {
  function afterLng(): Rig & { lngEnd: number } {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const { up } = swipe(r, "lng", 160, 120);
    if (up.kind !== "spin") throw new Error("expected a spin");
    // The server stores it: the view moves on to the second spin, with the same numbers.
    r.clock.s = T0 + 0.2;
    r.scene.setView(view("spin_lat", { rev: 2, lng: spin("Ann", up.plan.from, up.plan.delta, up.plan.durationMs, T0 + 0.1) }), r.ms.t);
    return Object.assign(r, { lngEnd: T0 + up.plan.durationMs / 1000 });
  }

  it("only lets the second swipe start once the first spin has finished", () => {
    const r = afterLng();
    const during = r.at(T0 + 1);
    expect(during.hud.phase).toBe("spin1");
    expect(r.scene.swipeAxis(T0 + 1)).toBeNull();
    const after = r.at(r.lngEnd + 0.5);
    expect(after.hud.phase).toBe("idle2");
    expect(after.hud.hint).toBe("Now spin it up or down");
    expect(after.hud.sub).toBe("Bea's turn"); // Ann spun last
    expect(after.hud.interactive).toBe("spin");
    expect(r.scene.swipeAxis(r.lngEnd + 0.5)).toBe("lat");
  });

  it("a vertical flick posts the landing the globe will make, from the round's eligible units", () => {
    const r = afterLng();
    r.at(r.lngEnd + 0.5);
    const { up } = swipe(r, "lat", 150, 110, 2);
    expect(up.kind).toBe("spin");
    if (up.kind !== "spin") return;
    expect(up.axis).toBe("lat");
    expect(up.landing).not.toBeNull();
    const landing = up.landing!;
    expect(["AAA", "BBB", "CCC"]).toContain(landing.landUnit);
    expect(landing.candidates[0]).toBe(landing.landUnit);
    expect(new Set(landing.candidates).size).toBe(landing.candidates.length);
    expect(landing.candidates.length).toBeLessThanOrEqual(10);
  });

  it("the same flick from the same start lands at a different latitude for a different random draw", () => {
    const latitudeFor = (draw: number): number => {
      const state = { flick: false };
      const r = rig(() => (state.flick ? draw : 0.5));
      r.scene.setView(view("spin_lng"), r.ms.t);
      r.at(T0);
      const lng = swipe(r, "lng", 160, 120).up;
      if (lng.kind !== "spin") throw new Error("expected a spin");
      r.clock.s = T0 + 0.2;
      r.scene.setView(view("spin_lat", { rev: 2, lng: spin("Ann", lng.plan.from, lng.plan.delta, lng.plan.durationMs, T0 + 0.1) }), r.ms.t);
      r.at(T0 + lng.plan.durationMs / 1000 + 0.5);
      state.flick = true;
      const { up } = swipe(r, "lat", 150, 110, 2);
      if (up.kind !== "spin") throw new Error("expected a spin");
      // d3: the landing latitude satisfies sin(lat) = -sin(phi) for any lambda.
      return Math.asin(-Math.sin(((up.plan.from + up.plan.delta) * Math.PI) / 180)) * (180 / Math.PI);
    };
    expect(Math.abs(latitudeFor(0.3) - latitudeFor(0.45))).toBeGreaterThan(5);
  });

  it("says so, and spins nothing, when there is nowhere left to land", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const lng = swipe(r, "lng", 160, 120).up;
    if (lng.kind !== "spin") throw new Error("expected a spin");
    r.clock.s = T0 + 0.2;
    r.scene.setView(view("spin_lat", { rev: 2, eligible: [], lng: spin("Ann", lng.plan.from, lng.plan.delta, lng.plan.durationMs, T0 + 0.1) }), r.ms.t);
    r.at(T0 + lng.plan.durationMs / 1000 + 0.5);
    const { up } = swipe(r, "lat", 150, 110, 2);
    expect(up).toEqual({ kind: "none" });
    expect(r.at(T0 + lng.plan.durationMs / 1000 + 0.6).hud.toast).toBe("There's nowhere left to land.");
  });

  it("a spin that could not be sent is taken back: the globe returns to waiting for it", () => {
    const r = rig();
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const { up } = swipe(r, "lng", 160, 120);
    expect(up.kind).toBe("spin");
    expect(r.at(T0 + 1).hud.phase).toBe("spin1");
    r.scene.discardOwnSpin("lng");
    expect(r.at(T0 + 1.1).hud.phase).toBe("idle");
  });
});

describe("scene: the landing, the zoom and the country roulette", () => {
  // The second spin ends at T0 (stored at T0 - 4, lasting 4 s); the roulette starts 5 s later.
  const lat = spin("Bea", -15, 900, 4000, T0 - 4);
  function country(over: { sea?: boolean } = {}): AdventureView {
    return view("country", {
      lat,
      landing: { point: [5, 5], sea: over.sea === true, land: [5, 5], centre: [5, 5], landUnit: "AAA", landUnitName: "Aland" },
      country: {
        candidates: [
          { id: "AAA", name: "Aland" },
          { id: "BBB", name: "Bland" },
          { id: "CCC", name: "Cland" },
        ],
        seed: 4242,
        rouletteAt: T0 + 5,
        chosen: null,
        by: null,
      },
    });
  }

  it("turns for the length of the spin, then lands: a ripple, and 'Landed in …' when it landed on land", () => {
    const r = rig();
    r.scene.setView(country(), r.ms.t);
    expect(r.at(T0 - 2).hud.phase).toBe("spin2");
    expect(r.at(T0 - 2).hud.hint).toBe("Round and round…");
    const landed = r.at(T0 + 0.3);
    expect(landed.hud.phase).toBe("landing");
    expect(landed.hud.hint).toBe("Landed in Aland");
    expect(landed.hud.nearest).toBeNull();
    expect(landed.frame.ripple?.progress).toBeCloseTo(0.3 / 1.1, 6);
    expect(landed.frame.pin).toEqual({ kind: "centre" });
    expect(landed.hud.action).toBe("stop");
    expect(landed.hud.stopLive).toBe(false); // "Get ready…" until the roulette starts
    expect(landed.hud.animating).toBe(true);
  });

  it("at sea: a splash, a dotted glide to the nearest land (no pin while it runs) and the name of that land", () => {
    const r = rig();
    r.scene.setView(country({ sea: true }), r.ms.t);
    const splash = r.at(T0 + 0.3);
    expect(splash.hud.hint).toBe("Splash! Landed in the sea");
    const glide = r.at(T0 + 1.2);
    expect(glide.hud.hint).toBe("Heading for land…");
    expect(glide.hud.nearest).toBe("Nearest land: Aland");
    expect(glide.frame.glide).toEqual({ from: [5, 5], to: [5, 5], progress: expect.closeTo(0.4, 6) as unknown as number });
    expect(glide.frame.pin).toBeUndefined();
    // Then the camera takes over and the label goes.
    const zoom = r.at(T0 + 2.6);
    expect(zoom.hud.nearest).toBeNull();
    expect(zoom.frame.glide).toBeUndefined();
  });

  it("then spins round and zooms to the centre, with the candidate countries outlined", () => {
    const r = rig();
    r.scene.setView(country(), r.ms.t);
    const before = r.at(T0 + 1);
    expect(rotationOf(before.frame)).toBeDefined(); // still the raw rotation: the zoom has not begun
    const during = r.at(T0 + 1.2 + 1.2); // half way through the 2.4 s zoom
    const cam = cameraOf(during.frame);
    expect(cam.viewRadiusDeg).toBeLessThan(90);
    expect(cam.viewRadiusDeg).toBeGreaterThan(3);
    expect(during.frame.emphasis?.candidateUnits).toEqual(["AAA", "BBB", "CCC"]);
    expect(during.hud.hint).toBe("Zooming in…");
    const end = cameraOf(r.at(T0 + 1.2 + 2.4 + 0.1).frame);
    expect(end.centre[0]).toBeCloseTo(5, 6);
    expect(end.centre[1]).toBeCloseTo(5, 6);
    expect(end.viewRadiusDeg).toBeGreaterThanOrEqual(3);
    expect(end.viewRadiusDeg).toBeLessThanOrEqual(40);
  });

  it("lights the same country as every other screen from server time, four a second, and Stop goes live", () => {
    const r = rig();
    r.scene.setView(country(), r.ms.t);
    for (const k of [0, 1, 2, 3, 7, 12]) {
      const s = T0 + 5 + k * 0.25 + 0.01;
      const { hud, frame } = r.at(s);
      const lit = litIndexAt(4242, 3, stepAt(s, T0 + 5));
      const id = ["AAA", "BBB", "CCC"][lit] as string;
      expect(hud.phase, `step ${k}`).toBe("country");
      expect(hud.litId).toBe(id);
      expect(hud.lit?.name).toBe(["Aland", "Bland", "Cland"][lit]);
      expect(frame.emphasis?.litUnit).toBe(id);
      expect(hud.stopLive).toBe(true);
      expect(hud.roulette).toBe(true);
      expect(hud.hint).toBe("Which country? Hit Stop!");
    }
  });

  it("buzzes the phone at each new item, but not under reduced motion", () => {
    const r = rig();
    r.scene.setView(country(), r.ms.t);
    r.at(T0 + 5.01);
    r.at(T0 + 5.26);
    r.at(T0 + 5.51);
    expect(r.vibrate).toHaveBeenCalledWith(8);
    expect(r.vibrate.mock.calls.length).toBeGreaterThanOrEqual(3);
    const q = rig();
    q.motion.reduced = true;
    q.scene.setView(country(), q.ms.t);
    q.at(T0 + 5.01);
    q.at(T0 + 5.26);
    expect(q.vibrate).not.toHaveBeenCalled();
  });

  it("Stop picks what was lit and settles on it at once; a second press does nothing; a refusal puts the roulette back", () => {
    const r = rig();
    r.scene.setView(country(), r.ms.t);
    const s = T0 + 5.3;
    const { hud } = r.at(s);
    const intent = r.scene.stopPressed();
    expect(intent).toEqual({ stage: "country", choice: hud.litId });
    expect(r.scene.stopPressed()).toBeNull();
    const settled = r.at(s + 0.1);
    expect(settled.hud.phase).toBe("countrySettle");
    expect(settled.hud.hint).toBe(["Aland", "Bland", "Cland"][["AAA", "BBB", "CCC"].indexOf(hud.litId as string)]);
    expect(settled.hud.sub).toBe("That's the one!");
    expect(settled.frame.emphasis?.chosenUnit).toBe(hud.litId);
    expect(settled.hud.stopLive).toBe(false);
    // It keeps showing the choice however the roulette would have moved on.
    expect(r.at(s + 3).hud.litId).toBe(hud.litId);
    r.scene.cancelPendingStop();
    expect(r.at(s + 3.1).hud.phase).toBe("country");
  });

  it("there is nothing to stop before the roulette starts", () => {
    const r = rig();
    r.scene.setView(country(), r.ms.t);
    r.at(T0 + 2);
    expect(r.scene.stopPressed()).toBeNull();
  });
});

describe("scene: the places roulette", () => {
  // The country was stopped at T0; the places roulette starts 3.5 s later.
  const STOP_AT = T0;
  function places(): AdventureView {
    return view("destination", {
      lat: spin("Bea", -15, 900, 4000, T0 - 60),
      destination: { candidates: [DEST_A, DEST_B, DEST_C], seed: 99, rouletteAt: STOP_AT + DEST_ROULETTE_LEAD_S, chosen: null, by: null },
    });
  }

  it("settles on the country first ('That's the one!'), then flies to the places", () => {
    const r = rig();
    r.scene.setView(places(), r.ms.t);
    const settle = r.at(STOP_AT + 0.3);
    expect(settle.hud.phase).toBe("countrySettle");
    expect(settle.hud.hint).toBe("Aland");
    expect(settle.hud.sub).toBe("That's the one!");
    expect(settle.frame.emphasis?.chosenUnit).toBe("AAA");
    const flying = r.at(STOP_AT + SETTLE_S + 1.2);
    expect(cameraOf(flying.frame).viewRadiusDeg).toBeGreaterThan(0);
    expect(flying.hud.phase).toBe("destination");
    expect(flying.hud.hint).toBe("Top places in Aland");
    expect(flying.hud.sub).toBe("Get ready");
    expect(flying.hud.stopLive).toBe(false);
    expect(flying.frame.dots?.map((d) => d.id)).toEqual(["AAA.alpha", "AAA.beta", "AAA.gamma"]);
  });

  it("lights a place from server time, shows its blurb, and Stop picks what was lit", () => {
    const r = rig();
    r.scene.setView(places(), r.ms.t);
    const s = STOP_AT + DEST_ROULETTE_LEAD_S + 0.6;
    const { hud, frame } = r.at(s);
    const lit = litIndexAt(99, 3, stepAt(s, STOP_AT + DEST_ROULETTE_LEAD_S));
    const d = [DEST_A, DEST_B, DEST_C][lit]!;
    expect(hud.litId).toBe(d.id);
    expect(hud.lit).toEqual({ name: d.name, sub: d.blurb });
    expect(hud.sub).toBe("Hit Stop to pick one");
    expect(frame.dots?.filter((x) => x.lit === true).map((x) => x.id)).toEqual([d.id]);
    expect(hud.stopLive).toBe(true);
    expect(hud.stopStage).toBe("destination");
    expect(r.scene.stopPressed()).toEqual({ stage: "destination", choice: d.id });
    const after = r.at(s + 0.1);
    expect(after.hud.phase).toBe("destSettle");
    expect(after.hud.hint).toBe(d.name);
    expect(after.hud.sub).toBe("Off we go!");
    expect(after.frame.dots?.find((x) => x.id === d.id)?.chosen).toBe(true);
    expect(after.frame.dots?.some((x) => x.lit === true)).toBe(false);
  });
});

describe("scene: reaching the place", () => {
  function chosenView(over: { state?: "chosen" | "banked" | "rejected"; decidedBy?: string | null; rev?: number } = {}): AdventureView {
    return view(over.state ?? "chosen", {
      rev: over.rev ?? 3,
      lat: spin("Bea", -15, 900, 4000, T0 - 60),
      decidedBy: over.decidedBy ?? null,
    });
  }

  it("a screen that was watching the places zooms to the chosen one, drops the pin, then offers Bank / No thanks", () => {
    const r = rig();
    r.scene.setView(
      view("destination", { rev: 2, lat: spin("Bea", -15, 900, 4000, T0 - 60), destination: { candidates: [DEST_A, DEST_B, DEST_C], seed: 99, rouletteAt: T0 - 20, chosen: null, by: null } }),
      r.ms.t,
    );
    r.at(T0 - 1);
    r.scene.setView(chosenView(), r.ms.t); // this screen sees `chosen` at T0 - 1
    const settle = r.at(T0 - 0.6);
    expect(settle.hud.phase).toBe("destSettle");
    expect(settle.hud.sub).toBe("Off we go!");
    const arriving = r.at(T0 - 1 + SETTLE_S + 1.4);
    expect(arriving.hud.phase).toBe("arriving");
    expect(arriving.hud.chosen?.dest.id).toBe("AAA.alpha");
    expect(arriving.frame.pin).toBeUndefined(); // not yet: it drops after the zoom
    expect(arriving.hud.canExplore).toBe(false);
    const placed = r.at(T0 - 1 + SETTLE_S + 2.8 + 1.5);
    expect(placed.hud.phase).toBe("chosen");
    expect(placed.hud.action).toBe("decide");
    expect(placed.hud.hint).toBe("Alpha");
    expect(placed.hud.sub).toBe("Alpha region, Aland");
    expect(placed.frame.pin).toEqual({ kind: "point", lng: DEST_A.lng, lat: DEST_A.lat, drop: 1 });
    expect(placed.frame.dots?.map((d) => d.id)).toEqual(["AAA.beta", "AAA.gamma"]); // the country's other places
    expect(placed.hud.interactive).toBe("explore");
    expect(placed.hud.canExplore).toBe(true);
    expect(placed.hud.animating).toBe(false);
    expect(cameraOf(placed.frame).viewRadiusDeg).toBeCloseTo(1.2, 6);
  });

  it("a screen that opens on a finished round sees the place at once, no zoom", () => {
    const r = rig();
    r.scene.setView(chosenView(), r.ms.t);
    const { hud, frame } = r.at(T0);
    expect(hud.phase).toBe("chosen");
    expect(hud.canExplore).toBe(true);
    expect(frame.pin).toEqual({ kind: "point", lng: DEST_A.lng, lat: DEST_A.lat, drop: 1 });
  });

  it("the person who pressed Stop starts the zoom from their press, before the server has answered", () => {
    const r = rig();
    const placesView = view("destination", { rev: 2, lat: spin("Bea", -15, 900, 4000, T0 - 60), destination: { candidates: [DEST_A, DEST_B, DEST_C], seed: 99, rouletteAt: T0 - 10, chosen: null, by: null } });
    r.scene.setView(placesView, r.ms.t);
    r.at(T0 - 1);
    const intent = r.scene.stopPressed();
    expect(intent?.stage).toBe("destination");
    expect(r.at(T0 - 0.8).hud.phase).toBe("destSettle");
    // The answer arrives half a second later with the choice: the settle does not restart.
    r.clock.s = T0 - 0.5;
    r.scene.setView(chosenView(), r.ms.t);
    const hud = r.at(T0 - 0.4).hud;
    expect(hud.phase).toBe("destSettle");
    expect(r.at(T0 - 1 + SETTLE_S + 0.1).hud.phase).toBe("arriving");
  });

  it("says who banked it, or passed on it, in plain words", () => {
    const r = rig();
    r.scene.setView(chosenView({ state: "banked", decidedBy: "Ann", rev: 4 }), r.ms.t);
    const banked = r.at(T0).hud;
    expect(banked.phase).toBe("decided");
    expect(banked.action).toBe("again");
    expect(banked.outcome).toBe("You banked Alpha: it's in your Holiday bank.");
    r.scene.setView(chosenView({ state: "banked", decidedBy: "Bea", rev: 5 }), r.ms.t);
    expect(r.at(T0).hud.outcome).toBe("Bea banked Alpha: it's in your Holiday bank.");
    r.scene.setView(chosenView({ state: "rejected", decidedBy: "Bea", rev: 6 }), r.ms.t);
    expect(r.at(T0).hud.outcome).toBe("Bea passed on Alpha: it won't come up again.");
    r.scene.setView(chosenView({ state: "rejected", decidedBy: null, rev: 7 }), r.ms.t);
    expect(r.at(T0).hud.outcome).toBe("Alpha won't come up again.");
  });

  it("a replaced round says so and offers Play again", () => {
    const r = rig();
    r.scene.setView(view("abandoned"), r.ms.t);
    const { hud } = r.at(T0);
    expect(hud.phase).toBe("replaced");
    expect(hud.hint).toBe("This adventure was replaced");
    expect(hud.action).toBe("again");
  });
});

describe("scene: exploring the final map", () => {
  it("pans and zooms (not past the floor), and 'Back to the place' flies home", () => {
    const r = rig();
    r.scene.setView(view("chosen", { rev: 3, lat: spin("Bea", -15, 900, 4000, T0 - 60) }), r.ms.t);
    r.at(T0);
    const home = cameraOf(r.at(T0).frame);
    r.scene.explorePan(60, 0);
    const panned = cameraOf(r.at(T0).frame);
    expect(panned.centre[0]).not.toBeCloseTo(home.centre[0], 3);
    r.scene.exploreZoom(0.5); // out
    expect(cameraOf(r.at(T0).frame).viewRadiusDeg).toBeCloseTo(home.viewRadiusDeg * 2, 6);
    r.scene.exploreZoom(1e9); // way in: stops at the floor
    expect(cameraOf(r.at(T0).frame).viewRadiusDeg).toBeCloseTo(MIN_VIEW_RADIUS_DEG, 6);
    r.scene.minViewRadiusDeg = 0.8; // imagery showing: a gentler floor
    r.scene.exploreZoom(0.01);
    r.scene.exploreZoom(1e9);
    expect(cameraOf(r.at(T0).frame).viewRadiusDeg).toBeCloseTo(0.8, 6);
    r.scene.backToPlace(r.ms.t);
    const midway = cameraOf(r.at(T0, r.ms.t + 450).frame);
    expect(midway.viewRadiusDeg).toBeGreaterThan(0.8);
    const back = cameraOf(r.at(T0, r.ms.t + 1000).frame);
    expect(back.viewRadiusDeg).toBeCloseTo(1.2, 6);
    expect(back.centre[0]).toBeCloseTo(DEST_A.lng, 6);
  });

  it("cannot be explored before it has arrived", () => {
    const r = rig();
    r.scene.setView(view("destination", { rev: 2, lat: spin("Bea", -15, 900, 4000, T0 - 60), destination: { candidates: [DEST_A, DEST_B], seed: 1, rouletteAt: T0 + 2, chosen: null, by: null } }), r.ms.t);
    r.at(T0);
    r.scene.explorePan(50, 50);
    r.scene.exploreZoom(2);
    expect(r.scene.canExplore).toBe(false);
  });
});

describe("scene: reduced motion", () => {
  it("shows a spin at its end at once, and cuts to the zoomed view instead of flying", () => {
    const r = rig();
    r.motion.reduced = true;
    r.scene.setView(view("spin_lng"), r.ms.t);
    r.at(T0);
    const { up } = swipe(r, "lng", 160, 120);
    if (up.kind !== "spin") throw new Error("expected a spin");
    expect(rotationOf(r.at(T0 + 0.1).frame)[0]).toBeCloseTo(up.plan.from + up.plan.delta, 6);

    const landed = rig();
    landed.motion.reduced = true;
    landed.scene.setView(
      view("country", { lat: spin("Bea", -15, 900, 4000, T0 - 4), country: { candidates: [{ id: "AAA", name: "Aland" }, { id: "BBB", name: "Bland" }], seed: 1, rouletteAt: T0 + 5, chosen: null, by: null } }),
      landed.ms.t,
    );
    const cut = landed.at(T0 + 1.3);
    expect(cut.frame.ripple).toBeUndefined();
    expect(cameraOf(cut.frame).viewRadiusDeg).toBeLessThanOrEqual(40); // already at the fitted view
    expect(cut.frame.reducedMotion).toBe(true);
  });
});

describe("scene: where a local timeline hands over to the server's", () => {
  it("a watcher's live drag becomes the committed spin without a jump, then catches up to the true angle", () => {
    const r = rig();
    r.scene.setView(view("spin_lng", { rev: 1 }), r.ms.t);
    const trail = new Trail();
    const finger: RemoteSwipe = { anchorSeq: 7, axis: "lng", rotation: [50, -15], fingerDown: true };
    r.scene.setRemote(finger, trail);
    expect(r.at(T0).hud.hint).toBe("Bea is spinning it");
    expect(r.at(T0).hud.remote).toBe(true);
    expect(r.at(T0).hud.interactive).toBe("none"); // not while the other finger is on it
    expect(rotationOf(r.at(T0).frame)[0]).toBeCloseTo(50, 6);
    // The server's spin starts from that angle, but it began 0.3 s ago: the true angle is well ahead.
    const committed = spin("Bea", 50, 1200, 4000, T0 - 0.3);
    r.scene.setRemote(null, trail);
    r.scene.setView(view("spin_lat", { rev: 2, lng: committed }), r.ms.t);
    const trueNow = spinAngleAt({ from: 50, delta: 1200, durationMs: 4000 }, 300);
    expect(trueNow - 50).toBeGreaterThan(100);
    const first = rotationOf(r.at(T0, r.ms.t).frame)[0];
    expect(first).toBeCloseTo(50, 3); // continuous with what was on screen
    const later = rotationOf(r.at(T0 + CATCHUP_MS / 1000 + 0.2, r.ms.t + CATCHUP_MS + 200).frame)[0];
    const trueLater = spinAngleAt({ from: 50, delta: 1200, durationMs: 4000 }, 300 + CATCHUP_MS + 200);
    expect(later).toBeCloseTo(trueLater, 3);
  });

  it("does not blend on the very first sight of a round (a screen that opens mid-spin jumps to the true angle)", () => {
    const r = rig();
    r.scene.setView(view("spin_lat", { rev: 2, lng: spin("Bea", 50, 1200, 4000, T0 - 1) }), r.ms.t);
    const shown = rotationOf(r.at(T0).frame)[0];
    expect(shown).toBeCloseTo(spinAngleAt({ from: 50, delta: 1200, durationMs: 4000 }, 1000), 6);
  });

  it("a spin that lost the race is dropped for the winner's, and says who spun it", () => {
    const r = rig();
    r.scene.setView(view("spin_lng", { rev: 1 }), r.ms.t);
    r.at(T0);
    const mine = swipe(r, "lng", 160, 120).up;
    if (mine.kind !== "spin") throw new Error("expected a spin");
    // The server already had Bea's spin: the view says so (a different move).
    const theirs = spin("Bea", 12, 1500, 5000, T0 - 0.05);
    r.scene.setView(view("spin_lat", { rev: 2, lng: theirs }), r.ms.t);
    const { hud } = r.at(T0 + 0.1);
    expect(hud.phase).toBe("spin1");
    expect(hud.sub).toBe("Bea spun it");
    const end = rotationOf(r.at(T0 + 8, r.ms.t + 6000).frame)[0];
    expect(end).toBeCloseTo(12 + 1500, 6);
  });

  it("the same move coming back from the server leaves the spin running without a hitch", () => {
    const r = rig();
    r.scene.setView(view("spin_lng", { rev: 1 }), r.ms.t);
    r.at(T0);
    const mine = swipe(r, "lng", 160, 120).up;
    if (mine.kind !== "spin") throw new Error("expected a spin");
    const before = rotationOf(r.at(T0 + 1).frame)[0];
    r.clock.s = T0 + 1;
    r.scene.setView(view("spin_lat", { rev: 2, lng: spin("Ann", mine.plan.from, mine.plan.delta, mine.plan.durationMs, T0 + 0.1) }), r.ms.t);
    const after = rotationOf(r.at(T0 + 1).frame)[0];
    expect(after).toBeCloseTo(before, 6); // its own timeline continues; nothing was re-based on the server's `at`
  });

  it("never goes back to an older view of the same round, and starts afresh for another round", () => {
    const r = rig();
    r.scene.setView(view("spin_lat", { rev: 5 }), r.ms.t);
    r.scene.setView(view("spin_lng", { rev: 4 }), r.ms.t);
    expect(r.scene.currentView?.state).toBe("spin_lat");
    r.scene.setView(view("spin_lng", { seq: 8, rev: 1 }), r.ms.t);
    expect(r.scene.seq).toBe(8);
    expect(r.scene.currentView?.state).toBe("spin_lng");
    r.scene.clear();
    expect(r.scene.seq).toBeNull();
    expect(r.at(T0).hud.phase).toBe("none");
  });
});
