import { beforeEach, describe, expect, it } from "vitest";
import { parsePickSnap, type PickSnap } from "../../src/server/cookout/api";
import { CAROUSEL_ADVANCE_MS, CAROUSEL_RESUME_MS, createCarousel } from "../../src/server/cookout/carousel";
import { CONCEPTS, finishedView, makeHarness, q, qa, visible } from "./twistFixtures";
import { P1_PICKS, P2_PICKS } from "./fixtures";

// spec/server-chat/09b-cookout-visual.md §D.4: while the chef works, the basket goes round one slide at a
// time (picture, name, what it is, fun facts). It advances every 7 s and loops; a pointer or finger on it
// pauses it, and it waits 10 s after letting go; dots and arrows move it; reduced motion never advances it
// on its own. It is gone once the dishes arrive.

interface FakeClock {
  now: number;
  timers: Map<number, { at: number; cb: () => void }>;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let next = 1;
  const clock: FakeClock = {
    now: 0,
    timers: new Map(),
    setTimeout(cb, ms) {
      const id = next++;
      clock.timers.set(id, { at: clock.now + ms, cb });
      return id;
    },
    clearTimeout(id) {
      clock.timers.delete(id);
    },
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = [...clock.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        clock.timers.delete(due[0]);
        clock.now = due[1].at;
        due[1].cb();
      }
      clock.now = end;
    },
  };
  return clock;
}

function slides(n = 4): PickSnap[] {
  return [...P1_PICKS, ...P2_PICKS].slice(0, n).map((raw, i) => {
    const snap = parsePickSnap({ ...raw, turn: i + 1, via: "pick", what: `What ${i}`, facts: [`Fact ${i}a`, `Fact ${i}b`] });
    if (snap === null) throw new Error("bad fixture");
    return snap;
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe("the carousel", () => {
  it("shows one slide per ingredient with its picture, name, what-line and facts", () => {
    const c = createCarousel({ document, clock: fakeClock(), reducedMotion: () => false }, slides(3));
    const all = qa(c.element, ".wx-srv-ck-car-slide");
    expect(all).toHaveLength(3);
    expect(q(all[0]!, ".wx-srv-ck-car-name").textContent).toBe("Thick-cut white toast");
    expect(q(all[0]!, ".wx-srv-ck-car-what").textContent).toBe("What 0");
    expect(qa(all[0]!, ".wx-srv-ck-car-fact").map((f) => f.textContent)).toEqual(["Fact 0a", "Fact 0b"]);
    expect(qa(c.element, ".wx-srv-ck-car-dot")).toHaveLength(3);
  });

  it("advances every 7 s and loops", () => {
    const clock = fakeClock();
    const c = createCarousel({ document, clock, reducedMotion: () => false }, slides(3));
    c.start();
    expect(c.index()).toBe(0);
    clock.advance(CAROUSEL_ADVANCE_MS - 1);
    expect(c.index()).toBe(0);
    clock.advance(1);
    expect(c.index()).toBe(1);
    clock.advance(CAROUSEL_ADVANCE_MS * 2);
    expect(c.index()).toBe(0);
    // Starting again while running does not reset the countdown.
    clock.advance(CAROUSEL_ADVANCE_MS - 100);
    c.start();
    clock.advance(100);
    expect(c.index()).toBe(1);
  });

  it("pauses while a pointer is on it and resumes 10 s after it lifts", () => {
    const clock = fakeClock();
    const c = createCarousel({ document, clock, reducedMotion: () => false }, slides(3));
    c.start();
    c.element.dispatchEvent(new Event("pointerdown"));
    clock.advance(CAROUSEL_ADVANCE_MS * 3);
    expect(c.index()).toBe(0);
    c.element.dispatchEvent(new Event("pointerup"));
    clock.advance(CAROUSEL_RESUME_MS - 1);
    expect(c.index()).toBe(0);
    clock.advance(1);
    expect(c.index()).toBe(1);
    clock.advance(CAROUSEL_ADVANCE_MS);
    expect(c.index()).toBe(2);
  });

  it("dots and arrows move it, and a tap waits 10 s before moving on", () => {
    const clock = fakeClock();
    const c = createCarousel({ document, clock, reducedMotion: () => false }, slides(4));
    c.start();
    qa<HTMLButtonElement>(c.element, ".wx-srv-ck-car-dot")[2]!.click();
    expect(c.index()).toBe(2);
    expect(qa(c.element, ".wx-srv-ck-car-dot")[2]!.getAttribute("aria-current")).toBe("true");
    q<HTMLButtonElement>(c.element, ".wx-srv-ck-car-next").click();
    expect(c.index()).toBe(3);
    q<HTMLButtonElement>(c.element, ".wx-srv-ck-car-next").click();
    expect(c.index()).toBe(0);
    q<HTMLButtonElement>(c.element, ".wx-srv-ck-car-prev").click();
    expect(c.index()).toBe(3);
    clock.advance(CAROUSEL_ADVANCE_MS);
    expect(c.index()).toBe(3);
    clock.advance(CAROUSEL_RESUME_MS - CAROUSEL_ADVANCE_MS);
    expect(c.index()).toBe(0);
  });

  it("reduced motion: never advances on its own; buttons still work", () => {
    const clock = fakeClock();
    const c = createCarousel({ document, clock, reducedMotion: () => true }, slides(3));
    c.start();
    expect(clock.timers.size).toBe(0);
    clock.advance(CAROUSEL_ADVANCE_MS * 5);
    expect(c.index()).toBe(0);
    q<HTMLButtonElement>(c.element, ".wx-srv-ck-car-next").click();
    expect(c.index()).toBe(1);
    expect(clock.timers.size).toBe(0);
  });

  it("stop and destroy release the timer", () => {
    const clock = fakeClock();
    const c = createCarousel({ document, clock, reducedMotion: () => false }, slides(3));
    c.start();
    expect(clock.timers.size).toBe(1);
    c.stop();
    expect(clock.timers.size).toBe(0);
    c.start();
    c.destroy();
    expect(clock.timers.size).toBe(0);
  });

  it("the current and next slide load eagerly, the rest lazily", () => {
    const image = { card: `/admin/cookout-img/${"c".repeat(64)}.webp`, thumb: `/admin/cookout-img/${"d".repeat(64)}.webp` };
    const withPictures = slides(4).map((s) => ({ ...s, image }));
    const c = createCarousel({ document, clock: fakeClock(), reducedMotion: () => false }, withPictures);
    const loading = (): Array<string | null> => qa<HTMLImageElement>(c.element, "img").map((img) => img.getAttribute("loading"));
    expect(loading()).toEqual(["eager", "eager", "lazy", "lazy"]);
    c.go(2);
    expect(loading()).toEqual(["eager", "eager", "eager", "eager"]);
  });
});

describe("the carousel in the pane", () => {
  it("shows while the chef works and goes when the dishes arrive", () => {
    const h = makeHarness();
    h.show(finishedView({ concepts: "pending", images: "none" }));
    expect(visible(h.pane, ".wx-srv-ck-chef .wx-srv-ck-car")).toBe(true);
    expect(qa(h.pane, ".wx-srv-ck-car-slide")).toHaveLength(10);
    // It is running: a timer is armed for the next slide.
    const armed = h.clock.timeouts.size;
    expect(armed).toBeGreaterThan(0);
    h.show(finishedView({ concepts: "ready", images: "pending" }));
    expect(h.pane.querySelector(".wx-srv-ck-car")).toBeNull();
    expect(qa(h.pane, ".wx-srv-ck-dish")).toHaveLength(CONCEPTS.length);
  });

  it("is not shown when the chef failed", () => {
    const h = makeHarness();
    h.show(finishedView({ concepts: "failed", images: "none" }));
    expect(h.pane.querySelector(".wx-srv-ck-car")).toBeNull();
    expect(visible(h.pane, ".wx-srv-ck-retry")).toBe(true);
  });
});
