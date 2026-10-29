// The Cookout intro (workspace 00058; spec/server-chat/09b-cookout-visual.md §D.2): a light card over the
// game pane that says, in a handful of short lines, what kind of round this is and what to do. It shows
// the first time THIS device opens THIS round while it is being picked, and comes back from the title
// row's `?`. Dismissed by "Let's cook" or a tap on the backdrop. Nothing here scrolls and nothing is sent
// anywhere: "seen" is one per-device flag per round (`wx-srv-ck-intro:<seq>`), with an in-memory set for
// the page's life when storage is unavailable or throws.

import type { CookoutView } from "./api";

export const INTRO_KEY_PREFIX = "wx-srv-ck-intro:";

/** The words of the card for one round. */
export interface IntroWords {
  readonly title: string;
  readonly lines: readonly string[];
  /** "Twists on: ⭐ secret stars · …", or null for a twist-free round. */
  readonly twists: string | null;
}

/** The start-sheet twists, one short phrase each (the in-game buttons explain themselves when tapped). */
export function twistPhrases(view: CookoutView): string[] {
  const setup = view.setup;
  const out: string[] = [];
  if (setup.style !== null) {
    out.push(setup.styleSpun ? `🎡 ${setup.style.label} style` : `${setup.style.emoji} ${setup.style.label} style`.trim());
  }
  if (setup.challenge !== null) out.push(`${setup.challenge.emoji} ${setup.challenge.label}`.trim());
  if (setup.stars) out.push("⭐ secret stars");
  if (setup.wildcard) out.push("🛎️ a mystery 11th ingredient");
  if (setup.fridgeRaid) out.push("🧊 starts with your fridge pick");
  if (setup.encore !== null) {
    const from = setup.encore.fromTitle;
    if (setup.encore.kind === "remix") out.push(from !== null ? `🔁 a remix of ${from}` : "🔁 a remix of a past dish");
    else out.push(from !== null ? `🔁 the leftovers of ${from}` : "🔁 an encore with the leftovers");
  }
  return out;
}

export function introWords(view: CookoutView): IntroWords {
  const lines = [
    view.blind ? "You're playing blind mode." : "You're playing non-blind mode.",
    "You take turns choosing ingredients — 5 each, 10 in the basket.",
    "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice).",
    view.blind ? "Your picks are secret — the basket is revealed when all ten are in." : "You'll see each other's picks as you go.",
    "Then the chef invents three dishes from your basket.",
  ];
  const phrases = twistPhrases(view);
  return { title: "Cookout", lines, twists: phrases.length === 0 ? null : `Twists on: ${phrases.join(" · ")}` };
}

export interface IntroDeps {
  readonly document: Document;
  /** The device's storage, or null when there is none (tests pass a fake; a throw counts as none). */
  storage(): Pick<Storage, "getItem" | "setItem"> | null;
  /** Called when the card opens or closes (the pane's layout may have changed). */
  onChange(): void;
}

export interface Intro {
  /** The overlay: append it to the game pane once. */
  readonly element: HTMLElement;
  /** True when this device has not yet seen the intro for round `seq`. */
  isNew(seq: number): boolean;
  /** Shows the card for `view` (and remembers the round as seen). */
  open(view: CookoutView): void;
  close(): void;
  isOpen(): boolean;
}

export function createIntro(deps: IntroDeps): Intro {
  const doc = deps.document;
  /** Rounds seen on this page when storage could not remember them. */
  const memory = new Set<number>();

  const element = doc.createElement("div");
  element.className = "wx-srv-ck-intro";
  element.hidden = true;
  const backdrop = doc.createElement("div");
  backdrop.className = "wx-srv-ck-intro-backdrop";
  backdrop.setAttribute("data-srv-gesture-boundary", "");
  backdrop.addEventListener("click", () => close());
  const card = doc.createElement("div");
  card.className = "wx-srv-ck-intro-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "wx-srv-ck-intro-title");
  element.append(backdrop, card);

  function storage(): Pick<Storage, "getItem" | "setItem"> | null {
    try {
      return deps.storage();
    } catch {
      return null;
    }
  }

  function isNew(seq: number): boolean {
    if (memory.has(seq)) return false;
    try {
      return storage()?.getItem(`${INTRO_KEY_PREFIX}${seq}`) !== "1";
    } catch {
      return true;
    }
  }

  function remember(seq: number): void {
    memory.add(seq);
    try {
      storage()?.setItem(`${INTRO_KEY_PREFIX}${seq}`, "1");
    } catch {
      // Private mode / blocked storage: the in-memory set serves this page's life.
    }
  }

  function open(view: CookoutView): void {
    remember(view.seq);
    const words = introWords(view);
    const heading = doc.createElement("h2");
    heading.className = "wx-srv-ck-intro-title";
    heading.id = "wx-srv-ck-intro-title";
    const pan = doc.createElement("span");
    pan.className = "wx-srv-ck-intro-icon";
    pan.textContent = "🍳";
    pan.setAttribute("aria-hidden", "true");
    heading.append(pan, doc.createTextNode(words.title));
    const list = doc.createElement("ul");
    list.className = "wx-srv-ck-intro-lines";
    for (const line of words.lines) {
      const li = doc.createElement("li");
      li.className = "wx-srv-ck-intro-line";
      li.textContent = line;
      list.append(li);
    }
    const parts: HTMLElement[] = [heading, list];
    if (words.twists !== null) {
      const twists = doc.createElement("p");
      twists.className = "wx-srv-ck-intro-twists";
      twists.textContent = words.twists;
      parts.push(twists);
    }
    const go = doc.createElement("button");
    go.type = "button";
    go.className = "wx-srv-ck-intro-go";
    go.textContent = "Let's cook";
    go.setAttribute("data-srv-gesture-boundary", "");
    go.addEventListener("click", () => close());
    parts.push(go);
    card.replaceChildren(...parts);
    element.hidden = false;
    go.focus();
    deps.onChange();
  }

  function close(): void {
    if (element.hidden) return;
    element.hidden = true;
    card.replaceChildren();
    deps.onChange();
  }

  return { element, isNew, open, close, isOpen: () => !element.hidden };
}
