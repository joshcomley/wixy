// The chef-thinking carousel (workspace 00058; spec/server-chat/09b-cookout-visual.md §D.4): while the
// chef invents the dishes, the basket's ingredients go round one slide at a time — the picture, the name,
// what it is and two or three fun facts. It advances every 7 s and loops; a finger or pointer on it pauses
// it, and it waits 10 s after letting go. Dots (tappable) underneath, arrows where there is a mouse, swipe
// on touch through CSS scroll-snap. Reduced motion: it never advances on its own and never animates the
// scroll — arrows, dots and swipe only.
//
// Its only long-lived resource is one timer, released by `stop`/`destroy` (the pane stops it whenever its
// tab is hidden and destroys it whenever the chef section is redrawn).

import type { PickSnap } from "./api";
import { ingredientPicture } from "./pictures";

export const CAROUSEL_ADVANCE_MS = 7_000;
export const CAROUSEL_RESUME_MS = 10_000;

export interface CarouselDeps {
  readonly document: Document;
  readonly clock: {
    setTimeout(callback: () => void, ms: number): number;
    clearTimeout(id: number): void;
  };
  reducedMotion(): boolean;
}

export interface Carousel {
  readonly element: HTMLElement;
  /** Starts auto-advance (a no-op when already running, under reduced motion, or with one slide). */
  start(): void;
  /** Stops auto-advance (the tab went away). */
  stop(): void;
  /** Stops for good and detaches every observer. */
  destroy(): void;
  /** The slide on show. */
  index(): number;
  /** Shows slide `i` (wrapping). */
  go(i: number): void;
}

export function createCarousel(deps: CarouselDeps, slides: readonly PickSnap[]): Carousel {
  const doc = deps.document;
  const count = slides.length;
  let current = 0;
  let timer: number | null = null;
  let running = false;
  /** A finger or pointer is on the carousel. */
  let holding = false;
  let observer: IntersectionObserver | null = null;

  const element = doc.createElement("section");
  element.className = "wx-srv-ck-car";
  element.setAttribute("aria-roledescription", "carousel");
  element.setAttribute("aria-label", "Your ingredients");

  const viewport = doc.createElement("div");
  viewport.className = "wx-srv-ck-car-view";
  const track = doc.createElement("ul");
  track.className = "wx-srv-ck-car-track";
  track.setAttribute("aria-live", "off");
  const items: HTMLElement[] = [];
  slides.forEach((snap, i) => {
    const slide = doc.createElement("li");
    slide.className = "wx-srv-ck-car-slide";
    slide.dataset["index"] = String(i);
    slide.dataset["ingredient"] = snap.id;
    slide.setAttribute("aria-roledescription", "slide");
    slide.setAttribute("aria-label", `${i + 1} of ${count}: ${snap.name}`);
    slide.append(ingredientPicture(doc, snap, { rendition: "card", className: "wx-srv-ck-car-pic", eager: i <= 1 }));
    // The words in one block under the picture: it scrolls on its own only when a very short screen cannot
    // hold them beside the smallest picture — never clipped, never under the title row.
    const words = doc.createElement("div");
    words.className = "wx-srv-ck-car-words";
    slide.append(words);
    const name = doc.createElement("h4");
    name.className = "wx-srv-ck-car-name";
    name.textContent = snap.name;
    words.append(name);
    const what = snap.what ?? (snap.blurb !== "" ? snap.blurb : null);
    if (what !== null) {
      const line = doc.createElement("p");
      line.className = "wx-srv-ck-car-what";
      line.textContent = what;
      words.append(line);
    }
    const facts = snap.facts ?? [];
    if (facts.length > 0) {
      const list = doc.createElement("ul");
      list.className = "wx-srv-ck-car-facts";
      for (const fact of facts) {
        const li = doc.createElement("li");
        li.className = "wx-srv-ck-car-fact";
        li.textContent = fact;
        list.append(li);
      }
      words.append(list);
    }
    items.push(slide);
    track.append(slide);
  });
  viewport.append(track);

  const prev = arrow("wx-srv-ck-car-prev", "‹", "Previous ingredient", () => step(-1));
  const next = arrow("wx-srv-ck-car-next", "›", "Next ingredient", () => step(1));
  const dots = doc.createElement("div");
  dots.className = "wx-srv-ck-car-dots";
  const dotButtons = slides.map((snap, i) => {
    const dot = doc.createElement("button");
    dot.type = "button";
    dot.className = "wx-srv-ck-car-dot";
    dot.setAttribute("aria-label", `Show ${snap.name}`);
    dot.setAttribute("data-srv-gesture-boundary", "");
    dot.addEventListener("click", () => {
      interacted();
      go(i);
    });
    dots.append(dot);
    return dot;
  });
  element.append(viewport);
  if (count > 1) element.append(prev, next, dots);

  function arrow(className: string, text: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = `wx-srv-ck-car-arrow ${className}`;
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.setAttribute("data-srv-gesture-boundary", "");
    b.addEventListener("click", () => {
      interacted();
      onClick();
    });
    return b;
  }

  function mark(i: number): void {
    current = i;
    dotButtons.forEach((dot, n) => {
      dot.classList.toggle("wx-srv-ck-car-dot-on", n === i);
      if (n === i) dot.setAttribute("aria-current", "true");
      else dot.removeAttribute("aria-current");
    });
    // The current and the next slide load at once; the rest stay lazy.
    for (const n of [i, (i + 1) % Math.max(count, 1)]) {
      const img = items[n]?.querySelector<HTMLImageElement>(".wx-srv-ck-pic-img");
      if (img !== null && img !== undefined && img.getAttribute("loading") !== "eager") img.setAttribute("loading", "eager");
    }
  }

  function go(i: number): void {
    if (count === 0) return;
    const target = ((i % count) + count) % count;
    mark(target);
    const slide = items[target];
    if (slide === undefined) return;
    const left = slide.offsetLeft;
    if (typeof track.scrollTo === "function") {
      track.scrollTo({ left, behavior: deps.reducedMotion() ? "auto" : "smooth" });
    } else {
      track.scrollLeft = left;
    }
  }

  function step(delta: number): void {
    go(current + delta);
  }

  function clearTimer(): void {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  }

  function schedule(ms: number): void {
    clearTimer();
    if (!running || holding || count < 2 || deps.reducedMotion()) return;
    timer = deps.clock.setTimeout(() => {
      timer = null;
      step(1);
      schedule(CAROUSEL_ADVANCE_MS);
    }, ms);
  }

  /** A tap on a dot or an arrow: the viewer is looking — wait 10 s before moving on again. */
  function interacted(): void {
    schedule(CAROUSEL_RESUME_MS);
  }

  function hold(): void {
    holding = true;
    clearTimer();
  }

  function release(): void {
    if (!holding) return;
    holding = false;
    schedule(CAROUSEL_RESUME_MS);
  }

  element.addEventListener("pointerdown", hold);
  element.addEventListener("pointerenter", (event) => {
    if ((event as PointerEvent).pointerType === "mouse") hold();
  });
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
  element.addEventListener("pointerleave", release);
  element.addEventListener("touchstart", hold, { passive: true });
  element.addEventListener("touchend", release);
  element.addEventListener("touchcancel", release);

  // A swipe moves the slide without a click: follow whichever slide is mostly in view.
  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const i = Number((entry.target as HTMLElement).dataset["index"]);
          if (Number.isInteger(i) && i !== current) mark(i);
        }
      },
      { root: track, threshold: 0.6 },
    );
    for (const slide of items) observer.observe(slide);
  }
  mark(0);

  return {
    element,
    start() {
      // Idempotent: the pane calls it on every refresh, which must not keep resetting the countdown.
      if (running) return;
      running = true;
      schedule(CAROUSEL_ADVANCE_MS);
    },
    stop() {
      running = false;
      clearTimer();
    },
    destroy() {
      running = false;
      clearTimer();
      observer?.disconnect();
      observer = null;
    },
    index: () => current,
    go,
  };
}
