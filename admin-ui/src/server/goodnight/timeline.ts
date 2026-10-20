// The good-night timeline: a pure, deterministic function from (elapsed ms, scene size, seed) to
// the draw ops of one frame. It is a port of pixelart/examples/goodnight/make_scene.py (the
// reference the operator approved), evaluated with the same rules as `pixelart compose`
// (FORMAT.md "Scenes"): keyframes interpolate linearly in ticks of 50 ms, x and y are then
// rounded half up to whole scene pixels, an anim shows the frame whose cumulative `ms` interval
// contains the elapsed time. Positions scale with the scene size (owl and branch centred, branch
// at 70% of the height, moon upper-left); at the reference size (120 x 214) every non-star layer
// matches scene.json exactly (tested).
//
// Nothing here touches the DOM or a clock.

import {
  BRANCH_SPRITE,
  BUBBLE_SPRITE,
  MOON_SPRITE,
  OWL_PERCHED_SPRITE,
  STAR_SPRITE,
  type SpriteData,
} from "./sprites.gen";

export type SpriteName = "owl" | "bubble" | "star" | "moon" | "branch";

export const SPRITES: Readonly<Record<SpriteName, SpriteData>> = {
  owl: OWL_PERCHED_SPRITE,
  bubble: BUBBLE_SPRITE,
  star: STAR_SPRITE,
  moon: MOON_SPRITE,
  branch: BRANCH_SPRITE,
};

export const TICK_MS = 50;
/** The sky colour (make_scene.py `background`). */
export const SKY_COLOUR = "#05060d";

/** Total duration of one pass through an anim of a sprite, from the generated data. */
function animTotalMs(sprite: SpriteData, anim: string): number {
  const a = sprite.anims[anim];
  if (a === undefined) throw new Error(`goodnight: sprite has no anim ${anim}`);
  const seq =
    a.mode === "pingpong" && a.frames.length > 2 ? a.frames.concat(a.frames.slice(1, -1).reverse()) : [...a.frames];
  return seq.reduce((sum, f) => sum + (sprite.frames.find((fr) => fr.name === f)?.ms ?? 100), 0);
}

type Fade = readonly (readonly [number, number])[];

// make_scene.py's constants, in the same order. Everything below derives from these.
const APPEAR = 1500; // branch + owl start dithering in
const SETTLED = 2300; // fully visible; the owl's intro starts
const INTRO_END = SETTLED + animTotalMs(OWL_PERCHED_SPRITE, "intro");
const BUBBLE_IN = INTRO_END - 1200; // bubble rises into view as the owl settles after the turn
const CAPTURE = BUBBLE_IN + 9000; // a slow drift in
const LIFT = CAPTURE + 2200; // glances, then the smile, then it starts to float
const GONE = LIFT + 11000; // a slow float up and away
const CHAT_BACK = GONE + 1000;

/**
 * THE ONE PLACE the timing and animation names live. It mirrors make_scene.py; when that file's
 * timeline or the owl's anims change, change this table (and regenerate sprites.gen.ts) and
 * nothing else. All times are ms from the trigger.
 */
export const TIMELINE = {
  /** Sky dithers in from 0 to full over this long. */
  skyFadeMs: 900,
  starsFromMs: 400,
  starsSpanMs: 2000,
  /** A star's own fade-in, in ticks. */
  starFadeTicks: 6,
  /** [ms, opacity] fade points. */
  moonFade: [[800, 0], [1800, 1], [GONE - 1000, 1], [GONE, 0]] as Fade,
  branchFade: [[APPEAR, 0], [SETTLED, 1], [GONE - 1000, 1], [GONE, 0]] as Fade,
  owlFadeIn: [[APPEAR, 0], [SETTLED, 1]] as Fade,
  /** The owl's `intro` anim runs SETTLED..introEndMs, then `watch` until capture. */
  owlStartMs: SETTLED,
  introEndMs: INTRO_END,
  bubbleStartMs: BUBBLE_IN,
  /** Bubble reaches the owl; the owl layer hands over to `bubble-happy`, riding the bubble. */
  captureMs: CAPTURE,
  liftMs: LIFT,
  /** Bubble (with the owl) has left the top of the scene. */
  goneMs: GONE,
  bubbleSwayPeriodMs: 3400,
  bubbleArriveSwayPx: 8,
  bubbleLeaveSwayPx: 7,
  /** The chat fades back in over the last second and the canvas hands over to background mode. */
  messagesBackFromMs: GONE,
  endMs: CHAT_BACK,
  /** Anim names per layer, as authored in the .pxl files. */
  anims: {
    owlIntro: "intro",
    owlWatch: "watch",
    owlCarried: "bubble-happy",
    bubble: "wobble",
    star: "twinkle",
  },
} as const;

export const MESSAGES_BACK_FROM_MS = TIMELINE.messagesBackFromMs;
export const SCENE_END_MS = TIMELINE.endMs;


/** The reference scene the art was drawn for (portrait phone, scene pixels). */
const REF_W = 120;
const REF_H = 214;
const REF_STARS = 34;

export interface SceneSize {
  readonly w: number;
  readonly h: number;
}

export interface SceneGeometry extends SceneSize {
  readonly scale: number;
}

/** spec "Rendering rules": scale = max(2, floor(min(innerWidth / 120, innerHeight / 200))); the scene is as many whole
 * scene pixels as cover the viewport. */
export function sceneGeometry(innerWidth: number, innerHeight: number): SceneGeometry {
  // At least ~120 scene pixels across and ~200 down: on a phone the width decides, on a wide
  // screen the height does, so the owl stays a sensible size on every window.
  const scale = Math.max(2, Math.floor(Math.min(innerWidth / 120, innerHeight / 200)));
  return {
    scale,
    w: Math.max(1, Math.ceil(innerWidth / scale)),
    h: Math.max(1, Math.ceil(innerHeight / scale)),
  };
}

export interface DrawOp {
  readonly sprite: SpriteName;
  readonly frame: string;
  readonly x: number;
  readonly y: number;
  /** 0..1; the scene turns it into a dither level, never an alpha. */
  readonly opacity: number;
}

export interface SceneFrame {
  /** 0..1 dither level of the sky colour (the page shows through the gaps). */
  readonly skyOpacity: number;
  readonly ops: readonly DrawOp[];
}

// -- Keyframed layers (compose.py semantics) -----------------------------------------------------

interface Key {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

interface KeyInput {
  readonly t: number;
  readonly x?: number;
  readonly y?: number;
  readonly opacity?: number;
}

interface Twinkle {
  readonly cycleMs: number;
  readonly phaseMs: number;
}

interface Layer {
  readonly sprite: SpriteName;
  readonly anim: string | null;
  readonly frame: string | null;
  readonly keys: readonly Key[];
  readonly startTick: number;
  readonly twinkle: Twinkle | null;
}

function pyRound(v: number): number {
  // Python's round(): halves go to the even neighbour (make_scene.py rounds its sway paths so).
  const f = Math.floor(v);
  if (v - f === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5);
}

function makeKeys(inputs: readonly KeyInput[], bx: number, by: number, bo: number): Key[] {
  const keys = inputs.map((k) => ({
    t: k.t,
    x: k.x ?? bx,
    y: k.y ?? by,
    opacity: k.opacity ?? bo,
  }));
  // Array.prototype.sort is stable, like Python's, so equal-t keys keep their order.
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

function interpolate(keys: readonly Key[], tick: number): { x: number; y: number; opacity: number } {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return { x: 0, y: 0, opacity: 0 };
  if (tick <= first.t) return { x: first.x, y: first.y, opacity: first.opacity };
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (tick <= b.t) {
      const f = b.t === a.t ? 0 : (tick - a.t) / (b.t - a.t);
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        opacity: a.opacity + (b.opacity - a.opacity) * f,
      };
    }
  }
  return { x: last.x, y: last.y, opacity: last.opacity };
}

function animSequence(frames: readonly string[], mode: string): string[] {
  const seq = [...frames];
  if (mode === "pingpong" && seq.length > 2) return seq.concat(seq.slice(1, -1).reverse());
  return seq;
}

function frameMs(sprite: SpriteData, name: string): number {
  return sprite.frames.find((f) => f.name === name)?.ms ?? 100;
}

function animFrame(layer: Layer, tick: number): string {
  const sprite = SPRITES[layer.sprite];
  if (layer.frame !== null) return layer.frame;
  const anim = layer.anim === null ? undefined : sprite.anims[layer.anim];
  if (anim === undefined) return sprite.frames[0]?.name ?? "";
  const seq = animSequence(anim.frames, anim.mode);
  const durations = seq.map((f) => frameMs(sprite, f));
  const total = durations.reduce((a, b) => a + b, 0);
  const elapsed = Math.max(0, tick - layer.startTick) * TICK_MS;
  const t = anim.mode === "once" ? Math.min(elapsed, total - 1) : elapsed % total;
  let acc = 0;
  for (let i = 0; i < seq.length; i += 1) {
    acc += durations[i]!;
    if (t < acc) return seq[i]!;
  }
  return seq[seq.length - 1] ?? "";
}

/** A star's frame: it holds the dot, then flashes through the rest of the `twinkle` anim once
 * per `cycleMs` (the spec's own 2-6 s cycle; make_scene.py just loops the 1.2 s anim). */
function twinkleFrame(twinkle: Twinkle, elapsedMs: number): string {
  const anim = STAR_SPRITE.anims[TIMELINE.anims.star];
  const names = anim?.frames ?? ["dot"];
  const hold = names[0] ?? "dot";
  const flash = names.slice(1);
  const flashMs = flash.reduce((a, f) => a + frameMs(STAR_SPRITE, f), 0);
  const cycle = Math.max(twinkle.cycleMs, flashMs + 1);
  const t = (((elapsedMs - twinkle.phaseMs) % cycle) + cycle) % cycle;
  if (t < cycle - flashMs) return hold;
  let acc = cycle - flashMs;
  for (const f of flash) {
    acc += frameMs(STAR_SPRITE, f);
    if (t < acc) return f;
  }
  return hold;
}

// -- Seeded randomness and star placement ---------------------------------------------------------

/** mulberry32: a small, well-mixed seeded generator returning [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Moon {
  readonly x: number;
  readonly y: number;
}

function moonPosition(size: SceneSize): Moon {
  return { x: Math.max(2, roundHalfUp(size.w * 0.12)), y: Math.max(2, roundHalfUp(size.h * 0.085)) };
}

/** Stars spread over the sky: whole-pixel positions inside [2, w-7) x [2, h-50), none under the
 * moon (the reference's x < 34 and y < 40 box, i.e. 20 px right of and 22 px below the moon's
 * corner), none within 9 px of another star on both axes. The count scales with the scene area
 * from the reference's 34 stars at 120 x 214. (The spec's "1 per 180 px^2" is ~4x denser than the
 * approved reference and cannot satisfy the 9 px spacing, so the reference density is used.) */
export function placeStars(size: SceneSize, rnd: () => number): { x: number; y: number }[] {
  const target = Math.min(90, Math.max(12, roundHalfUp((REF_STARS * size.w * size.h) / (REF_W * REF_H))));
  const moon = moonPosition(size);
  const maxY = Math.max(14, size.h - 50);
  const maxX = Math.max(10, size.w - 7);
  const stars: { x: number; y: number }[] = [];
  for (let attempts = 0; stars.length < target && attempts < 6000; attempts += 1) {
    const x = 2 + Math.floor(rnd() * (maxX - 2));
    const y = 2 + Math.floor(rnd() * (maxY - 2));
    if (x < moon.x + 20 && y < moon.y + 22) continue;
    if (stars.some((s) => Math.abs(x - s.x) < 9 && Math.abs(y - s.y) < 9)) continue;
    stars.push({ x, y });
  }
  return stars;
}

// -- Building the layers (make_scene.py `build`) ---------------------------------------------------

function tick(ms: number): number {
  return Math.floor(ms / TICK_MS);
}

function fade(...points: readonly (readonly [number, number])[]): KeyInput[] {
  return points.map(([ms, opacity]) => ({ t: tick(ms), opacity }));
}

interface PathKey {
  t: number;
  x: number;
  y: number;
}

/** Eased path p0 -> p1 with a sideways sway that fades out (arriving) or in (leaving). */
function drift(
  t0: number,
  t1: number,
  p0: readonly [number, number],
  p1: readonly [number, number],
  amp: number,
  grow: boolean,
): PathKey[] {
  const keys: PathKey[] = [];
  const n = t1 - t0;
  for (let k = 0; k <= n; k += 2) {
    const f = k / n;
    const e = f * f * (3 - 2 * f);
    const weight = grow ? f : 1 - f;
    const sway = amp * Math.sin((2 * Math.PI * k * TICK_MS) / TIMELINE.bubbleSwayPeriodMs) * weight;
    keys.push({
      t: t0 + k,
      x: pyRound(p0[0] + (p1[0] - p0[0]) * e + sway),
      y: pyRound(p0[1] + (p1[1] - p0[1]) * e),
    });
  }
  return keys;
}

/** Keyframes that follow `path` but are visible only from t0 to t1: a hard cut, so two owl layers
 * hand over between animations without a dissolve. */
function shownBetween(t0: number, t1: number, path: readonly PathKey[]): KeyInput[] {
  const keys: KeyInput[] = path.map((k) => ({
    t: k.t,
    x: k.x,
    y: k.y,
    opacity: t0 <= k.t && k.t <= t1 ? 1 : 0,
  }));
  keys.push(
    { t: t0 - 1, opacity: 0 },
    { t: t0, opacity: 1 },
    { t: t1, opacity: 1 },
    { t: t1 + 1, opacity: 0 },
  );
  keys.sort((a, b) => a.t - b.t);
  // carry the latest known position onto the visibility-only keys
  let x = path[0]?.x ?? 0;
  let y = path[0]?.y ?? 0;
  return keys.map((k) => {
    if (k.x !== undefined && k.y !== undefined) {
      x = k.x;
      y = k.y;
    }
    return { t: k.t, x, y, opacity: k.opacity ?? 1 };
  });
}

export interface Timeline {
  readonly size: SceneSize;
  readonly layers: readonly Layer[];
  readonly stars: readonly { x: number; y: number }[];
}

function layer(
  sprite: SpriteName,
  what: { anim: string } | { frame: string },
  base: { x: number; y: number; opacity: number },
  keys: readonly KeyInput[],
  startTick = 0,
  twinkle: Twinkle | null = null,
): Layer {
  return {
    sprite,
    anim: "anim" in what ? what.anim : null,
    frame: "frame" in what ? what.frame : null,
    keys: makeKeys(keys.length > 0 ? keys : [{ t: 0 }], base.x, base.y, base.opacity),
    startTick,
    twinkle,
  };
}

export function buildTimeline(size: SceneSize, seed: number): Timeline {
  const { w: W, h: H } = size;
  const rnd = seededRandom(seed);
  const layers: Layer[] = [];

  const stars = placeStars(size, rnd);
  stars.forEach((s, i) => {
    const t0 = (TIMELINE.starsFromMs + Math.floor((i * TIMELINE.starsSpanMs) / stars.length)) / TICK_MS;
    const cycleMs = 2000 + Math.floor(rnd() * 4001);
    const phaseMs = Math.floor(rnd() * cycleMs);
    layers.push(
      layer(
        "star",
        { anim: TIMELINE.anims.star },
        { x: s.x, y: s.y, opacity: 1 },
        [
          { t: t0, opacity: 0 },
          { t: t0 + TIMELINE.starFadeTicks, opacity: 1 },
        ],
        0,
        { cycleMs, phaseMs },
      ),
    );
  });

  const moon = moonPosition(size);
  layers.push(
    layer("moon", { frame: "still" }, { x: moon.x, y: moon.y, opacity: 1 }, fade(...TIMELINE.moonFade)),
  );

  const bx = Math.floor((W - BRANCH_SPRITE.w) / 2);
  const by = roundHalfUp(H * 0.7);
  const ox = Math.floor((W - OWL_PERCHED_SPRITE.w) / 2);
  const oy = by - 28; // the owl's feet on the branch top
  layers.push(
    layer("branch", { frame: "still" }, { x: bx, y: by, opacity: 1 }, fade(...TIMELINE.branchFade)),
  );

  const capture = tick(TIMELINE.captureMs);
  const lift = tick(TIMELINE.liftMs);
  const gone = tick(TIMELINE.goneMs);
  const held: readonly [number, number] = [ox - 5, oy - 5]; // the bubble centred on the owl
  const bubble: PathKey[] = [
    ...drift(tick(TIMELINE.bubbleStartMs), capture, [-46, H + 4], held, TIMELINE.bubbleArriveSwayPx, false),
    { t: lift, x: held[0], y: held[1] },
    ...drift(lift, gone, held, [W + 10, -60], TIMELINE.bubbleLeaveSwayPx, true),
  ];
  bubble.sort((a, b) => a.t - b.t);
  const inside = bubble.filter((k) => k.t >= capture).map((k) => ({ t: k.t, x: k.x + 5, y: k.y + 5 }));

  const origin = { x: 0, y: 0, opacity: 1 };
  const introEnd = tick(TIMELINE.introEndMs);
  layers.push(
    layer(
      "owl",
      { anim: TIMELINE.anims.owlIntro },
      { x: ox, y: oy, opacity: 1 },
      [...fade(...TIMELINE.owlFadeIn), { t: introEnd, opacity: 1 }, { t: introEnd + 1, opacity: 0 }],
      tick(TIMELINE.owlStartMs),
    ),
  );
  layers.push(
    layer(
      "owl",
      { anim: TIMELINE.anims.owlWatch },
      { x: ox, y: oy, opacity: 1 },
      [
        { t: introEnd, opacity: 0 },
        { t: introEnd + 1, opacity: 1 },
        { t: capture, opacity: 1 },
        { t: capture + 1, opacity: 0 },
      ],
      introEnd + 1,
    ),
  );
  layers.push(
    layer("owl", { anim: TIMELINE.anims.owlCarried }, origin, shownBetween(capture + 1, gone + 10, inside), capture + 1),
  );
  layers.push(layer("bubble", { anim: TIMELINE.anims.bubble }, origin, bubble));

  return { size, layers, stars };
}

let cached: { key: string; timeline: Timeline } | null = null;

function timelineFor(size: SceneSize, seed: number): Timeline {
  const key = `${size.w}x${size.h}:${seed}`;
  if (cached === null || cached.key !== key) cached = { key, timeline: buildTimeline(size, seed) };
  return cached.timeline;
}

function onScreen(size: SceneSize, sprite: SpriteName, x: number, y: number): boolean {
  const s = SPRITES[sprite];
  return x < size.w && y < size.h && x + s.w > 0 && y + s.h > 0;
}

function evaluate(tl: Timeline, elapsedMs: number, starsOnly: boolean, still = false): DrawOp[] {
  const t = elapsedMs / TICK_MS;
  const ops: DrawOp[] = [];
  for (const l of tl.layers) {
    if (starsOnly && l.sprite !== "star") continue;
    const at = interpolate(l.keys, starsOnly ? Number.POSITIVE_INFINITY : t);
    const x = roundHalfUp(at.x);
    const y = roundHalfUp(at.y);
    const opacity = Math.min(1, Math.max(0, at.opacity));
    if (Math.floor(opacity * 16 + 0.5) <= 0) continue;
    if (!onScreen(tl.size, l.sprite, x, y)) continue;
    const frame =
      l.twinkle === null
        ? animFrame(l, t)
        : still
          ? (STAR_SPRITE.anims[TIMELINE.anims.star]?.frames[0] ?? "dot")
          : twinkleFrame(l.twinkle, elapsedMs);
    ops.push({ sprite: l.sprite, frame, x, y, opacity });
  }
  return ops;
}

/** One frame of the full scene, `elapsedMs` after the trigger. */
export function sceneAt(elapsedMs: number, size: SceneSize, seed: number): SceneFrame {
  const ms = Math.max(0, elapsedMs);
  return {
    skyOpacity: Math.min(1, ms / TIMELINE.skyFadeMs),
    ops: evaluate(timelineFor(size, seed), ms, false),
  };
}

/** The starfield that stays behind the chat: the sky colour and every star, fully shown and
 * still twinkling. `elapsedMs` only drives the twinkle phase; `still` freezes every star on its
 * resting frame (the reduced-motion background). */
export function backgroundAt(elapsedMs: number, size: SceneSize, seed: number, still = false): SceneFrame {
  return {
    skyOpacity: 1,
    ops: evaluate(timelineFor(size, seed), Math.max(0, elapsedMs), true, still),
  };
}

/** Pixels of one sprite frame as palette indices (base 36), for the renderer. */
export function frameData(sprite: SpriteName, frame: string): string {
  return SPRITES[sprite].frames.find((f) => f.name === frame)?.data ?? "";
}
