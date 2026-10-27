// Adventure Time preview / dev harness entry: mounts the REAL globe engine (world, land, physics, camera,
// roulette, trail, renderer) behind a phone-first page that plays the whole flow, so the feel can be
// judged on a real phone before the pane is built. Built by `npm run dev:adventure` into ONE
// self-contained file (`dev/out/adventure-preview.html`): the bundle, the CSS, the real world map and the
// destination bank are all inlined, so it opens from a plain link.
//
// Test hooks for Playwright live on `window.__adv` (not used by the page itself).

import { prepareLanding } from "../src/server/adventure/land";
import { createGlobeRenderer, type GlobeFrame } from "../src/server/adventure/globe";
import { mulberry32 } from "../src/server/adventure/roulette";
import { parseWorld } from "../src/server/adventure/world";
import { Memory, loadBank, loadSamplePack, loadWorldJson } from "./preview/data";
import { Game } from "./preview/game";
import { buildUi, renderPack } from "./preview/ui";

function boot(): void {
  const params = new URLSearchParams(window.location.search);
  const seedParam = params.get("seed");
  const seed = seedParam === null ? Math.floor(Math.random() * 4294967296) : Number.parseInt(seedParam, 10) >>> 0;
  const rng = mulberry32(seed);

  const memory = new Memory();
  const world = parseWorld(loadWorldJson());
  prepareLanding(world);
  const bank = loadBank();
  const samplePack = loadSamplePack();

  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = (): boolean => memory.settings.reducedMotion ?? media.matches;

  const game = new Game({
    world,
    bank,
    memory,
    reducedMotion,
    vibrate: (ms) => {
      try {
        if (typeof navigator.vibrate === "function") navigator.vibrate(ms);
      } catch {
        // unsupported (iOS Safari): the flicker is still visible
      }
    },
    rng,
  });

  const ui = buildUi(memory, media.matches, {
    onNew: () => game.startRound(performance.now()),
    onStop: () => game.stop(performance.now()),
    onBank: () => {
      game.decide("bank", performance.now());
      ui.refreshBank();
      game.refreshEligible();
    },
    onReject: () => {
      if (game.rejectPending) {
        game.decide("reject", performance.now());
        game.refreshEligible();
      } else game.askReject();
    },
    onKeep: () => game.cancelReject(),
    onAgain: () => game.startRound(performance.now()),
    onBackToPlace: () => game.backToPlace(performance.now()),
    onOptionsChanged: (what) => {
      if (what === "advised") game.refreshEligible();
      if (what === "other" && (game.phase === "idle" || game.phase === "idle2")) game.startRound(performance.now());
    },
    onForget: () => {
      memory.forgetAll();
      game.refreshEligible();
      if (game.phase === "exhausted") game.startRound(performance.now());
    },
  });
  document.body.append(ui.root);

  const renderer = createGlobeRenderer(ui.canvas, world);

  // -- Sizing ---------------------------------------------------------------------------------------

  let lastFrame: GlobeFrame | null = null;
  let lastNow = performance.now();
  const resize = (): void => {
    const rect = ui.stage.getBoundingClientRect();
    renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    game.resize(rect.width, rect.height);
    // Resizing clears the canvas: repaint at once so a stage that is animating its height never flashes.
    if (lastFrame !== null) renderer.draw(lastFrame, lastNow);
  };
  new ResizeObserver(resize).observe(ui.stage);
  resize();

  // -- Pointer input --------------------------------------------------------------------------------

  const canvas = ui.canvas;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  const local = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const p = local(e);
    const mode = ui.stage.getAttribute("data-interactive");
    if (mode === "spin") {
      canvas.setPointerCapture(e.pointerId);
      game.pointerDown(e.pointerId, p.x, p.y, e.timeStamp);
    } else if (mode === "explore") {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) pinchDistance = distanceBetween(pointers);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const mode = ui.stage.getAttribute("data-interactive");
    const p = local(e);
    if (mode === "spin") {
      // Coalesced events keep a fast swipe's trail and speed smooth between frames.
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const list = events.length > 0 ? events : [e];
      for (const ev of list) {
        const q = local(ev);
        game.pointerMove(e.pointerId, q.x, q.y, ev.timeStamp);
      }
    } else if (mode === "explore" && pointers.has(e.pointerId)) {
      const before = pointers.get(e.pointerId) as { x: number; y: number };
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) game.explorePan(p.x - before.x, p.y - before.y);
      else if (pointers.size === 2) {
        const d = distanceBetween(pointers);
        if (pinchDistance > 0 && d > 0) game.exploreZoom(d / pinchDistance);
        pinchDistance = d;
      }
    }
  });
  const end = (e: PointerEvent, cancelled: boolean): void => {
    game.pointerUp(e.pointerId, e.timeStamp, cancelled);
    pointers.delete(e.pointerId);
    pinchDistance = 0;
  };
  canvas.addEventListener("pointerup", (e) => end(e, false));
  canvas.addEventListener("pointercancel", (e) => end(e, true));
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (ui.stage.getAttribute("data-interactive") !== "explore") return;
      e.preventDefault();
      game.exploreZoom(Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // -- Frame loop -----------------------------------------------------------------------------------

  const samples: number[] = [];
  let rendered = "";
  let lastDebug = 0;
  let lastAvoid = -1000;
  let previous = performance.now();

  /** The page's own overlays on the stage, in canvas coordinates: no dot label is drawn over one. */
  const measureAvoid = (): void => {
    const stage = ui.stage.getBoundingClientRect();
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const el of ui.stage.querySelectorAll<HTMLElement>(".hint, .toast, .nearest, .lit, .back, .debug")) {
      if (el.hidden || el.getAttribute("data-show") === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const pad = 6;
      rects.push({ x: r.left - stage.left - pad, y: r.top - stage.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    }
    game.setAvoid(rects);
  };

  const tick = (now: number): void => {
    const dt = Math.min(64, Math.max(0, now - previous));
    previous = now;
    lastNow = now;
    if (now - lastAvoid > 120) {
      lastAvoid = now;
      measureAvoid();
    }
    const { frame, hud } = game.update(now, dt);
    lastFrame = frame;
    const t0 = performance.now();
    renderer.draw(frame, now);
    samples.push(performance.now() - t0);
    if (samples.length > 120) samples.shift();
    ui.applyHud(hud, game.rejectPending);

    // The holiday pack is built once per chosen place.
    if (hud.pack?.state === "ready" && hud.chosen !== null && rendered !== hud.chosen.dest.id) {
      rendered = hud.chosen.dest.id;
      ui.packHost.replaceChildren(renderPack(samplePack, hud.chosen.dest, hud.chosen.unitName, true));
      ui.packHost.scrollTop = 0;
    }
    if (hud.pack === null) rendered = "";

    if (now - lastDebug > 250) {
      lastDebug = now;
      const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
      const worst = samples.reduce((a, b) => Math.max(a, b), 0);
      ui.setDebug(`${game.describe()}\ndraw ${avg.toFixed(2)} ms avg, ${worst.toFixed(1)} ms worst\nlevel ${renderer.lastLevel}  seed ${seed}`);
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);

  // Test hooks (Playwright).
  (window as unknown as Record<string, unknown>)["__adv"] = {
    game,
    renderer,
    world,
    seed,
    drawStats: () => ({ avg: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length), worst: Math.max(0, ...samples) }),
    /** A synthetic flick: drags `px` pixels along the axis in `ms`, then lets go. */
    flick(axis: "lng" | "lat", px: number, ms: number): void {
      const rect = ui.stage.getBoundingClientRect();
      const t0 = performance.now();
      const cx = rect.width / 2;
      const cy = rect.height * 0.62;
      const steps = Math.max(4, Math.round(ms / 8));
      game.pointerDown(1, cx - (axis === "lng" ? px / 2 : 0), cy - (axis === "lat" ? px / 2 : 0), t0);
      for (let i = 1; i <= steps; i += 1) {
        const f = (i / steps) ** 1.8;
        game.pointerMove(1, cx - (axis === "lng" ? px / 2 : 0) + (axis === "lng" ? px * f : 0), cy - (axis === "lat" ? px / 2 : 0) + (axis === "lat" ? px * f : 0), t0 + (ms * i) / steps);
      }
      game.pointerUp(1, t0 + ms + 2);
    },
  };
}

function distanceBetween(pointers: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...pointers.values()];
  return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
}

boot();
