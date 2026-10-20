import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ditherLevel } from "../../src/server/goodnight/dither";
import {
  backgroundAt,
  buildTimeline,
  placeStars,
  sceneAt,
  sceneGeometry,
  seededRandom,
  SPRITES,
  TICK_MS,
  TIMELINE,
  type DrawOp,
  type SceneSize,
  type SpriteName,
} from "../../src/server/goodnight/timeline";

const REF: SceneSize = { w: 120, h: 214 };
const SIZES: SceneSize[] = [REF, { w: 120, h: 68 }, { w: 180, h: 400 }, { w: 239, h: 160 }];

function ops(ms: number, size: SceneSize = REF, seed = 7): readonly DrawOp[] {
  return sceneAt(ms, size, seed).ops;
}

describe("sceneGeometry", () => {
  it("scales by max(2, floor(width / 120)) and covers the viewport", () => {
    expect(sceneGeometry(360, 640)).toEqual({ scale: 3, w: 120, h: 214 });
    expect(sceneGeometry(100, 100)).toEqual({ scale: 2, w: 50, h: 50 });
    expect(sceneGeometry(1920, 1080)).toEqual({ scale: 16, w: 120, h: 68 });
    expect(sceneGeometry(375, 667)).toEqual({ scale: 3, w: 125, h: 223 });
  });
});

describe("timeline determinism", () => {
  it("returns identical frames for identical inputs", () => {
    for (const ms of [0, 333, 1200, 7777, TIMELINE.captureMs, TIMELINE.goneMs - 1, TIMELINE.endMs]) {
      expect(sceneAt(ms, REF, 42)).toEqual(sceneAt(ms, REF, 42));
    }
  });

  it("changes star placement with the seed but nothing else", () => {
    const a = ops(5000, REF, 1).filter((o) => o.sprite === "star");
    const b = ops(5000, REF, 2).filter((o) => o.sprite === "star");
    expect(a).not.toEqual(b);
    const rest = (seed: number) => ops(5000, REF, seed).filter((o) => o.sprite !== "star");
    expect(rest(1)).toEqual(rest(2));
  });

  it("seededRandom is reproducible and in [0, 1)", () => {
    const a = seededRandom(5);
    const b = seededRandom(5);
    for (let i = 0; i < 50; i += 1) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("only ever emits integer positions and valid frames, at every size", () => {
    for (const size of SIZES) {
      for (let ms = 0; ms <= TIMELINE.endMs + 2000; ms += 37) {
        for (const op of ops(ms, size, 3)) {
          expect(Number.isInteger(op.x)).toBe(true);
          expect(Number.isInteger(op.y)).toBe(true);
          expect(op.opacity).toBeGreaterThan(0);
          expect(op.opacity).toBeLessThanOrEqual(1);
          expect(SPRITES[op.sprite].frames.some((f) => f.name === op.frame)).toBe(true);
        }
      }
    }
  });
});

describe("star placement", () => {
  it("stays in the sky, clear of the moon, and spaced out", () => {
    for (const size of SIZES) {
      const stars = placeStars(size, seededRandom(9));
      expect(stars.length).toBeGreaterThan(5);
      for (const [i, s] of stars.entries()) {
        expect(s.x).toBeGreaterThanOrEqual(2);
        expect(s.x).toBeLessThan(size.w - 6);
        expect(s.y).toBeGreaterThanOrEqual(2);
        for (const o of stars.slice(i + 1)) expect(Math.abs(s.x - o.x) >= 9 || Math.abs(s.y - o.y) >= 9).toBe(true);
      }
    }
    const ref = placeStars(REF, seededRandom(9));
    expect(ref).toHaveLength(34);
    for (const s of ref) expect(s.x < 34 && s.y < 40).toBe(false);
  });
});

describe("key moments", () => {
  const owl = (ms: number) => ops(ms).find((o) => o.sprite === "owl");
  const bubble = (ms: number) => ops(ms).find((o) => o.sprite === "bubble");

  it("shows nothing but the sky before the stars begin", () => {
    expect(ops(0)).toEqual([]);
    expect(ops(TIMELINE.starsFromMs - 1)).toEqual([]);
    expect(sceneAt(0, REF, 7).skyOpacity).toBe(0);
    expect(sceneAt(TIMELINE.skyFadeMs, REF, 7).skyOpacity).toBe(1);
  });

  it("brings the stars in one by one, then moon, branch and owl", () => {
    const stars = (ms: number) => ops(ms).filter((o) => o.sprite === "star").length;
    expect(stars(TIMELINE.starsFromMs + 100)).toBeGreaterThan(0);
    expect(stars(TIMELINE.starsFromMs + 100)).toBeLessThan(stars(TIMELINE.starsFromMs + TIMELINE.starsSpanMs + 600));
    expect(ops(100).some((o) => o.sprite === "moon")).toBe(false);
    expect(ops(TIMELINE.moonFade[1]![0]).some((o) => o.sprite === "moon")).toBe(true);
    expect(ops(TIMELINE.owlStartMs).some((o) => o.sprite === "branch")).toBe(true);
    expect(owl(TIMELINE.owlStartMs)).toBeDefined();
  });

  it("centres the owl in the bubble when it is captured", () => {
    const o = owl(TIMELINE.captureMs);
    const b = bubble(TIMELINE.captureMs);
    expect(o).toBeDefined();
    expect(b).toBeDefined();
    expect(o!.x + SPRITES.owl.w / 2).toBe(b!.x + SPRITES.bubble.w / 2);
    expect(o!.y + SPRITES.owl.h / 2).toBe(b!.y + SPRITES.bubble.h / 2);
    // and stays centred while being carried off
    for (let ms = TIMELINE.captureMs; ms < TIMELINE.goneMs; ms += 250) {
      const oo = owl(ms);
      const bb = bubble(ms);
      if (oo === undefined || bb === undefined) continue;
      expect(oo.x + 16).toBe(bb.x + 21);
      expect(oo.y + 16).toBe(bb.y + 21);
    }
  });

  it("has the owl and bubble gone by the time the chat comes back", () => {
    expect(owl(TIMELINE.goneMs)).toBeUndefined();
    expect(bubble(TIMELINE.goneMs)).toBeUndefined();
    expect(ops(TIMELINE.goneMs).some((o) => o.sprite === "moon" || o.sprite === "branch")).toBe(false);
  });

  it("leaves only stars after the scene ends", () => {
    for (const ms of [TIMELINE.endMs, TIMELINE.endMs + 3000, 60_000]) {
      const left = ops(ms);
      expect(left.length).toBeGreaterThan(0);
      expect(left.every((o) => o.sprite === "star")).toBe(true);
    }
  });

  it("scales positions with the scene: owl and branch centred, branch at 70% of the height", () => {
    for (const size of SIZES) {
      const frame = sceneAt(TIMELINE.owlStartMs, size, 1).ops;
      const branch = frame.find((o) => o.sprite === "branch")!;
      expect(branch.x).toBe(Math.floor((size.w - SPRITES.branch.w) / 2));
      expect(branch.y).toBe(Math.floor(size.h * 0.7 + 0.5));
      expect(frame.find((o) => o.sprite === "owl")!.x).toBe(Math.floor((size.w - SPRITES.owl.w) / 2));
      const moon = frame.find((o) => o.sprite === "moon")!;
      expect(moon.x).toBeLessThan(size.w / 3);
    }
  });

  it("background mode is the full starfield, still twinkling", () => {
    const bg = backgroundAt(1000, REF, 7);
    expect(bg.skyOpacity).toBe(1);
    expect(bg.ops).toHaveLength(34);
    expect(bg.ops.every((o) => o.sprite === "star" && o.opacity === 1)).toBe(true);
    const frames = new Set<string>();
    for (let ms = 0; ms < 12_000; ms += 20) for (const o of backgroundAt(ms, REF, 7).ops) frames.add(o.frame);
    expect(frames.size).toBeGreaterThan(1);
    const still = backgroundAt(5000, REF, 7, true);
    expect(new Set(still.ops.map((o) => o.frame)).size).toBe(1);
  });
});

// -- Golden check against the reference timeline (pixelart compose's scene.json) ------------------

interface JsonKey {
  t: number;
  x?: number;
  y?: number;
  opacity?: number;
}
interface JsonLayer {
  sprite: string;
  anim?: string;
  frame?: string;
  x?: number;
  y?: number;
  opacity?: number;
  start_tick?: number;
  keyframes?: JsonKey[];
}
interface JsonScene {
  width: number;
  height: number;
  ticks: number;
  tick_ms: number;
  layers: JsonLayer[];
}

/** An independent evaluation of scene.json with compose.py's rules. */
function composeOps(scene: JsonScene, tick: number): DrawOp[] {
  const out: DrawOp[] = [];
  for (const l of scene.layers) {
    const name = l.sprite.replace(".pxl", "") as SpriteName;
    if (name === "star") continue;
    const sprite = SPRITES[name];
    const bx = l.x ?? 0;
    const by = l.y ?? 0;
    const bo = l.opacity ?? 1;
    const keys = (l.keyframes ?? [{ t: 0 }]).map((k) => ({ t: k.t, x: k.x ?? bx, y: k.y ?? by, opacity: k.opacity ?? bo }));
    keys.sort((a, b) => a.t - b.t);
    let x = keys[keys.length - 1]!.x;
    let y = keys[keys.length - 1]!.y;
    let op = keys[keys.length - 1]!.opacity;
    if (tick <= keys[0]!.t) ({ x, y, opacity: op } = keys[0]!);
    else {
      for (let i = 1; i < keys.length; i += 1) {
        const a = keys[i - 1]!;
        const b = keys[i]!;
        if (tick <= b.t) {
          const f = b.t === a.t ? 0 : (tick - a.t) / (b.t - a.t);
          x = a.x + (b.x - a.x) * f;
          y = a.y + (b.y - a.y) * f;
          op = a.opacity + (b.opacity - a.opacity) * f;
          break;
        }
      }
    }
    let frame = l.frame ?? "";
    if (l.anim !== undefined) {
      const anim = sprite.anims[l.anim]!;
      let seq = [...anim.frames];
      if (anim.mode === "pingpong" && seq.length > 2) seq = seq.concat(seq.slice(1, -1).reverse());
      const durs = seq.map((f) => sprite.frames.find((fr) => fr.name === f)!.ms);
      const total = durs.reduce((a, b) => a + b, 0);
      const elapsed = Math.max(0, tick - (l.start_tick ?? 0)) * scene.tick_ms;
      const t = anim.mode === "once" ? Math.min(elapsed, total - 1) : elapsed % total;
      let acc = 0;
      frame = seq[seq.length - 1]!;
      for (const [i, f] of seq.entries()) {
        acc += durs[i]!;
        if (t < acc) {
          frame = f;
          break;
        }
      }
    }
    const rx = Math.floor(x + 0.5);
    const ry = Math.floor(y + 0.5);
    if (ditherLevel(op) <= 0) continue;
    if (!(rx < scene.width && ry < scene.height && rx + sprite.w > 0 && ry + sprite.h > 0)) continue;
    out.push({ sprite: name, frame, x: rx, y: ry, opacity: op });
  }
  return out;
}

describe("matches the reference timeline", () => {
  const path = fileURLToPath(new URL("../../../pixelart/examples/goodnight/scene.json", import.meta.url));
  const scene = JSON.parse(readFileSync(path, "utf-8")) as JsonScene;

  it("scene.json is the size and tick the timeline was ported from", () => {
    expect(scene.width).toBe(REF.w);
    expect(scene.height).toBe(REF.h);
    expect(scene.tick_ms).toBe(TICK_MS);
  });

  it("reproduces every non-star layer (sprite, frame, whole-pixel position, dither level) on every tick", () => {
    const summary = (list: readonly DrawOp[]) =>
      list.map((o) => ({ sprite: o.sprite, frame: o.frame, x: o.x, y: o.y, level: ditherLevel(o.opacity) }));
    for (let tick = 0; tick < scene.ticks; tick += 1) {
      const ours = ops(tick * TICK_MS).filter((o) => o.sprite !== "star");
      expect(summary(ours), `tick ${tick}`).toEqual(summary(composeOps(scene, tick)));
    }
  });

  it("builds the same star count as the reference", () => {
    expect(buildTimeline(REF, 7).stars).toHaveLength(scene.layers.filter((l) => l.sprite === "star.pxl").length);
  });
});
