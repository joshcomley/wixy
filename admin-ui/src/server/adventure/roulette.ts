// Adventure Time — the roulette (spec/server-chat/08-adventure-time.md §3.4).
//
// Both screens must show the SAME lit item at the same moment without exchanging a single frame, so
// the lit item is a pure function of three stored numbers: the stage's `seed`, its `rouletteAt`
// (server epoch seconds when flickering starts) and the number of candidates `n`. A screen asks
// "what is lit at server time T?" and gets the answer every other screen gets, within clock error;
// a late joiner who opens the tab mid-roulette lands on the right item at once.
//
// Time units are SECONDS throughout (the wire carries epoch seconds), never milliseconds.

/** One flicker every quarter of a second: four a second. */
export const ROULETTE_STEP_S = 0.25;

/** mulberry32 (public domain): a tiny, well-mixed 32-bit generator; returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The roulette's step at server time `serverNowS`: -1 before it starts, else `floor(elapsed / 0.25 s)`. */
export function stepAt(serverNowS: number, rouletteAtS: number): number {
  if (!Number.isFinite(serverNowS) || !Number.isFinite(rouletteAtS)) return -1;
  const elapsed = serverNowS - rouletteAtS;
  if (elapsed < 0) return -1;
  return Math.floor(elapsed / ROULETTE_STEP_S);
}

/** When (server seconds) step `k` begins. */
export function stepStartS(rouletteAtS: number, step: number): number {
  return rouletteAtS + step * ROULETTE_STEP_S;
}

/** `r_k`: the k-th random draw, first output of a generator seeded `seed + k` (as an unsigned 32-bit). */
function draw(seed: number, k: number): number {
  return mulberry32((seed + k) >>> 0)();
}

/**
 * Lit sequences are built forward and remembered per (seed, n): a 10-minute roulette is 2400 steps,
 * and only the first frame (or a late joiner) pays for them; every later frame is an array read.
 */
const MEMO_LIMIT = 6;
/** Step 40 000 is 2 h 46 min into a roulette. */
const MAX_STEP = 40000;
const memo = new Map<string, number[]>();

function sequenceFor(seed: number, n: number): number[] {
  const key = `${seed >>> 0}:${n}`;
  const hit = memo.get(key);
  if (hit !== undefined) {
    // Most recently used goes last, so the oldest entry is the one evicted.
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const fresh: number[] = [];
  memo.set(key, fresh);
  if (memo.size > MEMO_LIMIT) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  return fresh;
}

/** Drops the remembered sequences (tests). */
export function clearRouletteMemo(): void {
  memo.clear();
}

/**
 * The lit index among `n` candidates at `step`. `i0 = floor(r0·n)`, then
 * `i_k = (i_{k-1} + 1 + floor(r_k·(n-1))) mod n`: the same item is never lit twice running (for n ≥ 2).
 * Returns -1 for `step < 0` (not started) or `n < 1`; always 0 for `n === 1`.
 */
export function litIndexAt(seed: number, n: number, step: number): number {
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(step) || step < 0) return -1;
  if (n === 1) return 0;
  // A roulette is over in minutes; the clamp only bounds the memory a hostile `step` could ask for
  // (both screens clamp the same way, so they still agree).
  const k = Math.min(Math.floor(step), MAX_STEP);
  const sequence = sequenceFor(seed, n);
  while (sequence.length <= k) {
    const i = sequence.length;
    if (i === 0) {
      sequence.push(Math.min(n - 1, Math.floor(draw(seed, 0) * n)));
    } else {
      const previous = sequence[i - 1] as number;
      sequence.push((previous + 1 + Math.floor(draw(seed, i) * (n - 1))) % n);
    }
  }
  return sequence[k] as number;
}

/** Convenience: the lit index at server time `serverNowS` (-1 before the roulette starts). */
export function litIndexNow(seed: number, n: number, rouletteAtS: number, serverNowS: number): number {
  return litIndexAt(seed, n, stepAt(serverNowS, rouletteAtS));
}
