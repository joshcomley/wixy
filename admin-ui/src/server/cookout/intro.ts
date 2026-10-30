// The Cookout intro (workspace 00058; spec/server-chat/09b-cookout-visual.md §D.2): a light card over the
// game pane that says, in a handful of short lines, what kind of round this is and what to do. It shows
// the first time THIS device opens THIS round while it is being picked, and comes back from the title
// row's `?`. Dismissed by "Let's cook" or a tap on the backdrop. Nothing here scrolls and nothing is sent
// anywhere: "seen" is one per-device flag per round (`wx-srv-ck-intro:<seq>`), with an in-memory set for
// the page's life when storage is unavailable or throws.
//
// GAME MODES (spec/server-chat/09c-cookout-modes.md §6.2): a non-Classic round's card starts with the mode's
// own `intro` lines from `GET /cookout/options`. The card never waits for that read: it paints at once with
// the same lines built from the view's mode, and swaps in the server's words (text only) if they arrive
// while it is open. A Classic round's card is exactly as before.

import { isClassic, type CookoutView, type ModeOption } from "./api";
import { anchorKind, dishNoun, fillStarter, kindNoun, numberWord, ordinal, plural } from "./modes";

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
  if (setup.wildcard) out.push(`🛎️ a mystery ${ordinal(view.mode.turns + 1)} ingredient`);
  if (setup.fridgeRaid) out.push("🧊 starts with your fridge pick");
  if (setup.encore !== null) {
    const from = setup.encore.fromTitle;
    if (setup.encore.kind === "remix") out.push(from !== null ? `🔁 a remix of ${from}` : "🔁 a remix of a past dish");
    else out.push(from !== null ? `🔁 the leftovers of ${from}` : "🔁 an encore with the leftovers");
  }
  return out;
}

/** A mode's three intro lines built from the view alone (the options' own lines, when not to hand). */
export function fallbackModeIntro(view: CookoutView): string[] {
  const mode = view.mode;
  const noun = dishNoun(mode);
  const anchor = anchorKind(mode);
  const each = `${mode.picksPerPlayer} picks each`;
  return [
    `You're making a ${noun}.`,
    anchor !== null
      ? `{starter} picks ${anchor.label} first, then you take turns adding fillings — ${each}.`
      : `You take turns choosing ingredients — ${mode.picksPerPlayer} each, ${mode.turns} in the basket.`,
    anchor !== null ? `The chef makes three ${plural(noun)} with your ${kindNoun(anchor)}.` : `The chef makes three ${plural(noun)}.`,
  ];
}

/** The card's lines for a non-Classic round: the mode's first line, Open/Blind, the mode's middle lines, how a
 * turn works, what each player sees, and the mode's last line (09c §6.2). */
function modeLines(view: CookoutView, option: ModeOption | null): string[] {
  const mode = view.mode;
  const raw = option !== null && option.id === mode.id && option.intro.length > 0 ? [...option.intro] : fallbackModeIntro(view);
  const starter = view.players[0].name;
  const lines = raw.map((line) => fillStarter(line, starter, view.you?.slot === 1));
  const first = lines[0] ?? "";
  const last = lines.length > 1 ? (lines[lines.length - 1] ?? "") : "";
  const middle = lines.slice(1, lines.length > 1 ? -1 : 1);
  return [
    first,
    view.blind ? "You're playing blind mode." : "You're playing non-blind mode.",
    ...middle,
    "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice).",
    view.blind
      ? `Your picks are secret — the ${dishNoun(mode)} is revealed when all ${numberWord(mode.turns)} are in.`
      : "You'll see each other's picks as you go.",
    last,
  ].filter((line) => line !== "");
}

/** The card's words. `option` is the round's mode as `GET /cookout/options` lists it, when known. */
export function introWords(view: CookoutView, option: ModeOption | null = null): IntroWords {
  const phrases = twistPhrases(view);
  const twists = phrases.length === 0 ? null : `Twists on: ${phrases.join(" · ")}`;
  if (!isClassic(view.mode)) return { title: "Cookout", lines: modeLines(view, option), twists };
  const lines = [
    view.blind ? "You're playing blind mode." : "You're playing non-blind mode.",
    "You take turns choosing ingredients — 5 each, 10 in the basket.",
    "Each turn, tap the one you want. Don't fancy either? Deal two new ones (up to twice).",
    view.blind ? "Your picks are secret — the basket is revealed when all ten are in." : "You'll see each other's picks as you go.",
    "Then the chef invents three dishes from your basket.",
  ];
  return { title: "Cookout", lines, twists };
}

export interface IntroDeps {
  readonly document: Document;
  /** The device's storage, or null when there is none (tests pass a fake; a throw counts as none). */
  storage(): Pick<Storage, "getItem" | "setItem"> | null;
  /** Called when the card opens or closes (the pane's layout may have changed). */
  onChange(): void;
  /** The round's mode as the options list it, when they have been read (null: not read, failed, or a mode
   * the options do not list — switched off mid-round). Never awaited. */
  modeOption?(modeId: string): ModeOption | null;
}

export interface Intro {
  /** The overlay: append it to the game pane once. */
  readonly element: HTMLElement;
  /** True when this device has not yet seen the intro for round `seq`. */
  isNew(seq: number): boolean;
  /** Shows the card for `view` (and remembers the round as seen). */
  open(view: CookoutView): void;
  /** The options arrived (or changed): an open card for `view`'s round re-reads its lines, text only. */
  update(view: CookoutView): void;
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

  /** The round on the card while it is open, and the lines it shows. */
  let openSeq: number | null = null;
  let shownLines = "";

  function optionFor(view: CookoutView): ModeOption | null {
    if (isClassic(view.mode) || deps.modeOption === undefined) return null;
    try {
      return deps.modeOption(view.mode.id);
    } catch {
      return null;
    }
  }

  function lineList(lines: readonly string[]): HTMLElement {
    const list = doc.createElement("ul");
    list.className = "wx-srv-ck-intro-lines";
    for (const line of lines) {
      const li = doc.createElement("li");
      li.className = "wx-srv-ck-intro-line";
      li.textContent = line;
      list.append(li);
    }
    return list;
  }

  function open(view: CookoutView): void {
    remember(view.seq);
    const words = introWords(view, optionFor(view));
    openSeq = view.seq;
    shownLines = JSON.stringify(words.lines);
    const heading = doc.createElement("h2");
    heading.className = "wx-srv-ck-intro-title";
    heading.id = "wx-srv-ck-intro-title";
    const pan = doc.createElement("span");
    pan.className = "wx-srv-ck-intro-icon";
    pan.textContent = isClassic(view.mode) || view.mode.emoji === "" ? "🍳" : view.mode.emoji;
    pan.setAttribute("aria-hidden", "true");
    heading.append(pan, doc.createTextNode(words.title));
    const parts: HTMLElement[] = [heading, lineList(words.lines)];
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

  function update(view: CookoutView): void {
    if (element.hidden || openSeq !== view.seq) return;
    const words = introWords(view, optionFor(view));
    const key = JSON.stringify(words.lines);
    if (key === shownLines) return;
    shownLines = key;
    // Only the lines change: the heading, the twists line and the focused button stay where they are.
    card.querySelector(".wx-srv-ck-intro-lines")?.replaceWith(lineList(words.lines));
    deps.onChange();
  }

  function close(): void {
    if (element.hidden) return;
    element.hidden = true;
    openSeq = null;
    shownLines = "";
    card.replaceChildren();
    deps.onChange();
  }

  return { element, isNew, open, update, close, isOpen: () => !element.hidden };
}
