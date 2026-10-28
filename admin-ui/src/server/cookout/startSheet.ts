// The Cookout START SHEET (workspace 00058; spec/server-chat/09-cookout.md §5.4, twists 09a §9): the ⋯
// menu's "Cookout" and the pane's "New" open this compact sheet over the chat — choose Open mode (the
// default) or Blind mode, then Start Cookout. From "New" the current round's whole setup comes
// preselected; from a Recipe book or dish encore button the sheet opens with an Encore banner.
//
//   [ 🍳 New Cookout                                   ]
//   [ 🔁 Encore of "Smoky toast stack" — starters: [x] Parsley [ ] Beans  ✕ ]   <- only for an encore
//   [ ( ) Open mode   — you both see every pair and pick ]
//   [ ( ) Blind mode  — secret picks, one big reveal    ]
//   [ ▸ Add twists (optional)                           ]   <- collapsed by default
//   [    Chef's style: None · 🎡 Spin · 🍺 Cosy pub …    ]
//   [    Kitchen challenge: None · 🍳 One pan only …     ]
//   [    🛎️ Wildcard cloche [ ]   ⭐ Secret stars [ ]      ]
//   [    🧊 Fridge raid: 🔎 search the pantry            ]
//   [ Cancel                          Start Cookout ▸  ]
//
// Every twist is optional and off by default (09a rule 2). The four that only change what the chef makes
// (style, challenge, cloche, stars) are hidden when this server has no chef (`GET /cookout/options`
// answers `chef: false`, or could not be read) — the server would refuse them.
//
// A plain `div` with a backdrop rather than a `<dialog>`: Escape is this chat's panic key (it locks
// everything at once), so nothing here listens for it and the sheet closes by its buttons. Like the other
// screens of the ⋯ menu it sits BELOW the chat header, so the panic ✕ and the lock gestures stay reachable.

import type {
  CatalogueEntry,
  ChallengeId,
  ConceptId,
  CookoutOptions,
  EncoreKind,
  IngredientSnap,
  SearchResult,
  StyleId,
} from "./api";
import { isChallengeId, isStyleId } from "./api";
import { createFridgeSearch } from "./fridgeSearch";

/** An encore's source concept and the starters it offers (its leftovers, or the banked dish's own). */
export interface EncorePreset {
  readonly fromSeq: number;
  readonly generation: number;
  readonly conceptId: ConceptId;
  readonly kind: EncoreKind;
  /** The source dish's title, for the banner (null when unknown). */
  readonly title: string | null;
  readonly candidates: readonly IngredientSnap[];
}

/** What the sheet opens with. Anything absent is the default (Open, no twists). */
export interface StartPreset {
  readonly blind?: boolean;
  readonly style?: StyleId | "spin" | null;
  readonly challenge?: ChallengeId | null;
  readonly wildcard?: boolean;
  readonly stars?: boolean;
  readonly fridge?: IngredientSnap | null;
  readonly encore?: EncorePreset | null;
}

/** What Start sends. Chef-only twists are already dropped when the server has no chef. */
export interface StartChoices {
  readonly blind: boolean;
  readonly style: StyleId | "spin" | null;
  readonly challenge: ChallengeId | null;
  readonly wildcard: boolean;
  readonly stars: boolean;
  readonly fridgeSeedId: string | null;
  readonly encore: {
    readonly fromSeq: number;
    readonly generation: number;
    readonly conceptId: ConceptId;
    readonly kind: EncoreKind;
    readonly seedIds: readonly string[];
  } | null;
}

export interface CookoutStartSheetDeps {
  readonly document: Document;
  /** Start a round with these choices. Resolves once the request is settled (the sheet waits on it, then
   * closes); rejects with the words to show when the round could not start (the sheet stays open).
   * `clientId` is the same for every retry of one start (the server answers a replay with the round it
   * already made, so a lost answer followed by "try again" never makes a second round); different
   * choices are a different start. */
  start(choices: StartChoices, clientId: string): Promise<void>;
  /** The style/challenge catalogue and the chef's availability (cached per unlock by the caller); null
   * when it could not be read. */
  loadOptions(): Promise<CookoutOptions | null>;
  /** The fridge raid's bank search. */
  search(q: string): Promise<SearchResult>;
  /** A fresh id for a start. */
  newId(): string;
  /** Test seams for the search debounce. */
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

export interface CookoutStartSheet {
  /** The sheet and its backdrop: put it in the thread view. */
  readonly element: HTMLElement;
  /** Show the sheet below `topOffsetPx` (the chat header's height) with `preset` preselected (Open and no
   * twists by default). */
  open(preset?: StartPreset, topOffsetPx?: number): void;
  close(): void;
  isOpen(): boolean;
}

/** At most two starters a round; one when the fridge raid supplies the other (09a §1.3). */
export function encoreSeedLimit(hasFridge: boolean): number {
  return hasFridge ? 1 : 2;
}

export function createCookoutStartSheet(deps: CookoutStartSheetDeps): CookoutStartSheet {
  const doc = deps.document;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function glyph(className: string, text: string): HTMLElement {
    const span = el("span", className, text);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  function plainButton(className: string, text: string): HTMLButtonElement {
    const b = el("button", className, text);
    b.type = "button";
    b.setAttribute("data-srv-gesture-boundary", "");
    return b;
  }

  const root = el("div", "wx-srv-ck-start");
  root.hidden = true;
  const backdrop = el("div", "wx-srv-ck-start-backdrop");
  backdrop.setAttribute("data-srv-gesture-boundary", "");
  const sheet = el("div", "wx-srv-ck-start-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const heading = el("h2", "wx-srv-ck-start-title");
  heading.id = "wx-srv-ck-start-title";
  heading.append(glyph("wx-srv-ck-start-icon", "🍳"), doc.createTextNode("New Cookout"));
  sheet.setAttribute("aria-labelledby", heading.id);
  const intro = el("p", "wx-srv-ck-start-intro", "Take turns picking 10 ingredients, then see what the chef invents.");

  // -- The encore banner ---------------------------------------------------------------------------------

  const encoreBox = el("div", "wx-srv-ck-encore");
  encoreBox.hidden = true;
  const encoreHead = el("div", "wx-srv-ck-encore-head");
  const encoreTitle = el("p", "wx-srv-ck-encore-title");
  const encoreDrop = plainButton("wx-srv-ck-encore-drop", "✕");
  encoreDrop.setAttribute("aria-label", "Don't make this an encore");
  encoreHead.append(encoreTitle, encoreDrop);
  const encoreHint = el("p", "wx-srv-ck-encore-hint");
  const encoreList = el("div", "wx-srv-ck-encore-list");
  encoreList.setAttribute("role", "group");
  encoreList.setAttribute("aria-label", "Starters");
  encoreBox.append(encoreHead, encoreHint, encoreList);

  // -- The modes -------------------------------------------------------------------------------------------

  const modes = el("div", "wx-srv-ck-start-modes");
  modes.setAttribute("role", "radiogroup");
  modes.setAttribute("aria-label", "Game mode");

  function modeOption(blind: boolean, icon: string, name: string, hint: string): HTMLButtonElement {
    const option = el("button", "wx-srv-ck-mode");
    option.type = "button";
    option.setAttribute("role", "radio");
    option.setAttribute("data-srv-gesture-boundary", "");
    option.dataset["mode"] = blind ? "blind" : "open";
    const words = el("span", "wx-srv-ck-mode-words");
    words.append(el("span", "wx-srv-ck-mode-name", name), el("span", "wx-srv-ck-mode-hint", hint));
    option.append(glyph("wx-srv-ck-mode-icon", icon), words, glyph("wx-srv-ck-mode-tick", "✓"));
    option.addEventListener("click", () => select(blind));
    return option;
  }

  const openOption = modeOption(false, "👀", "Open mode", "You both see every pair and every pick");
  const blindOption = modeOption(true, "🕵️", "Blind mode", "Secret picks, then one big reveal");
  modes.append(openOption, blindOption);

  // -- The twists ------------------------------------------------------------------------------------------

  const twists = el("div", "wx-srv-ck-twists");
  const twistsToggle = plainButton("wx-srv-ck-twists-toggle", "");
  const twistsCaret = glyph("wx-srv-ck-twists-caret", "▸");
  const twistsCount = el("span", "wx-srv-ck-twists-count");
  twistsToggle.append(twistsCaret, el("span", "wx-srv-ck-twists-label", "Add twists (optional)"), twistsCount);
  twistsToggle.setAttribute("aria-controls", "wx-srv-ck-twists-body");
  const twistsBody = el("div", "wx-srv-ck-twists-body");
  twistsBody.id = "wx-srv-ck-twists-body";
  twistsBody.hidden = true;
  twists.append(twistsToggle, twistsBody);

  const chefRows = el("div", "wx-srv-ck-twists-chef");
  const chefNote = el("p", "wx-srv-ck-twists-note");
  chefNote.hidden = true;

  function rowHead(icon: string, name: string, hint: string): HTMLElement {
    const head = el("div", "wx-srv-ck-twist-head");
    const words = el("span", "wx-srv-ck-twist-words");
    words.append(el("span", "wx-srv-ck-twist-name", name), el("span", "wx-srv-ck-twist-hint", hint));
    head.append(glyph("wx-srv-ck-twist-icon", icon), words);
    return head;
  }

  const styleRow = el("div", "wx-srv-ck-twist wx-srv-ck-twist-style");
  const styleChips = el("div", "wx-srv-ck-twist-chips");
  styleChips.setAttribute("role", "radiogroup");
  styleChips.setAttribute("aria-label", "Chef's style");
  styleRow.append(rowHead("🎨", "Chef's style", "Pick a mood for the dishes, or spin the wheel"), styleChips);

  const challengeRow = el("div", "wx-srv-ck-twist wx-srv-ck-twist-challenge");
  const challengeChips = el("div", "wx-srv-ck-twist-chips");
  challengeChips.setAttribute("role", "radiogroup");
  challengeChips.setAttribute("aria-label", "Kitchen challenge");
  challengeRow.append(rowHead("🏁", "Kitchen challenge", "A rule the chef has to stick to"), challengeChips);

  function toggleRow(kind: string, icon: string, name: string, hint: string): { row: HTMLElement; button: HTMLButtonElement } {
    const button = plainButton(`wx-srv-ck-twist wx-srv-ck-twist-toggle wx-srv-ck-twist-${kind}`, "");
    button.setAttribute("role", "switch");
    const words = el("span", "wx-srv-ck-twist-words");
    words.append(el("span", "wx-srv-ck-twist-name", name), el("span", "wx-srv-ck-twist-hint", hint));
    button.append(glyph("wx-srv-ck-twist-icon", icon), words, glyph("wx-srv-ck-switch", ""));
    return { row: button, button };
  }

  const cloche = toggleRow("cloche", "🛎️", "Wildcard cloche", "Lift a lid for a surprise 11th ingredient");
  const stars = toggleRow("stars", "⭐", "Secret stars", "Each star one of your picks; the chef makes them the heroes");
  chefRows.append(styleRow, challengeRow, cloche.row, stars.row);

  const fridgeRow = el("div", "wx-srv-ck-twist wx-srv-ck-twist-fridge");
  const fridge = createFridgeSearch({
    document: doc,
    search: (q) => deps.search(q),
    onChange: (snap) => {
      fridgeChosen = snap;
      // The fridge raid takes one of the two starter places.
      trimEncore();
      refresh();
    },
    ...(deps.setTimeout === undefined ? {} : { setTimeout: deps.setTimeout }),
    ...(deps.clearTimeout === undefined ? {} : { clearTimeout: deps.clearTimeout }),
  });
  fridgeRow.append(rowHead("🧊", "Fridge raid", "Start with one thing you actually have at home tonight"), fridge.element);
  twistsBody.append(chefNote, chefRows, fridgeRow);

  const error = el("p", "wx-srv-ck-start-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = el("div", "wx-srv-ck-start-actions");
  const cancel = plainButton("wx-srv-ck-start-cancel", "Cancel");
  const go = plainButton("wx-srv-ck-start-go", "Start Cookout");
  actions.append(cancel, go);
  const body = el("div", "wx-srv-ck-start-body");
  body.append(intro, encoreBox, modes, twists, error);
  sheet.append(heading, body, actions);
  root.append(backdrop, sheet);

  // -- State -----------------------------------------------------------------------------------------------

  let opened = false;
  let blindChosen = false;
  let style: StyleId | "spin" | null = null;
  let challenge: ChallengeId | null = null;
  let wildcard = false;
  let starsOn = false;
  let fridgeChosen: IngredientSnap | null = null;
  let encore: EncorePreset | null = null;
  let encoreSeeds: string[] = [];
  let twistsOpen = false;
  let options: CookoutOptions | null = null;
  let optionsLoaded = false;
  let busy = false;
  /** The id of the start this sheet is making, and the choices it was minted for: kept across retries of
   * the same choices, new as soon as anything changes. */
  let clientId = "";
  let clientKey = "";
  /** Bumped on open/close: a start or an options read that settles after the sheet went away does not
   * touch it. */
  let generation = 0;

  function chefAvailable(): boolean {
    return options !== null && options.chef;
  }

  function choices(): StartChoices {
    const chef = chefAvailable();
    return {
      blind: blindChosen,
      style: chef ? style : null,
      challenge: chef ? challenge : null,
      wildcard: chef && wildcard,
      stars: chef && starsOn,
      fridgeSeedId: fridgeChosen?.id ?? null,
      encore:
        encore === null || encoreSeeds.length === 0
          ? null
          : { fromSeq: encore.fromSeq, generation: encore.generation, conceptId: encore.conceptId, kind: encore.kind, seedIds: [...encoreSeeds] },
    };
  }

  function twistCount(): number {
    const c = choices();
    return [c.style !== null, c.challenge !== null, c.wildcard, c.stars, c.fridgeSeedId !== null].filter(Boolean).length;
  }

  /** Keep the encore's starters within the limit the fridge raid leaves. */
  function trimEncore(): void {
    const limit = encoreSeedLimit(fridgeChosen !== null);
    if (encoreSeeds.length > limit) encoreSeeds = encoreSeeds.slice(0, limit);
  }

  function chipButton(group: string, id: string, icon: string, label: string, on: boolean, hint: string, onPick: () => void): HTMLButtonElement {
    const chip = plainButton("wx-srv-ck-twist-chip", "");
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", on ? "true" : "false");
    chip.dataset[group] = id;
    chip.classList.toggle("wx-srv-ck-twist-chip-on", on);
    if (icon !== "") chip.append(glyph("wx-srv-ck-twist-chip-icon", icon));
    chip.append(el("span", "wx-srv-ck-twist-chip-label", label));
    if (hint !== "") chip.title = hint;
    chip.disabled = busy;
    chip.addEventListener("click", () => {
      if (busy) return;
      onPick();
      refresh();
    });
    return chip;
  }

  function drawCatalogue(): void {
    const styles: readonly CatalogueEntry[] = options?.styles ?? [];
    styleChips.replaceChildren(
      chipButton("style", "none", "", "None", style === null, "", () => (style = null)),
      chipButton("style", "spin", "🎡", "Spin", style === "spin", "Let the wheel choose", () => (style = "spin")),
      ...styles.map((entry) =>
        chipButton("style", entry.id, entry.emoji, entry.label, style === entry.id, entry.blurb, () => {
          if (isStyleId(entry.id)) style = entry.id;
        }),
      ),
    );
    const challenges: readonly CatalogueEntry[] = options?.challenges ?? [];
    challengeChips.replaceChildren(
      chipButton("challenge", "none", "", "None", challenge === null, "", () => (challenge = null)),
      ...challenges.map((entry) =>
        chipButton("challenge", entry.id, entry.emoji, entry.label, challenge === entry.id, entry.blurb, () => {
          if (isChallengeId(entry.id)) challenge = entry.id;
        }),
      ),
    );
  }

  function drawEncore(): void {
    if (encore === null) {
      encoreBox.hidden = true;
      encoreList.replaceChildren();
      return;
    }
    encoreBox.hidden = false;
    encoreBox.dataset["kind"] = encore.kind;
    const what = encore.kind === "remix" ? "Remix" : "Leftovers encore";
    encoreTitle.replaceChildren(
      glyph("wx-srv-ck-encore-icon", "🔁"),
      doc.createTextNode(encore.title !== null ? `${what} of “${encore.title}”` : what),
    );
    const limit = encoreSeedLimit(fridgeChosen !== null);
    encoreHint.textContent =
      limit === 1
        ? "Choose 1 starter to begin the basket with (the fridge raid takes the other place)."
        : "Choose 1 or 2 starters to begin the basket with — you both see them.";
    encoreList.replaceChildren(
      ...encore.candidates.map((snap) => {
        const on = encoreSeeds.includes(snap.id);
        const item = plainButton("wx-srv-ck-encore-seed", "");
        item.setAttribute("role", "checkbox");
        item.setAttribute("aria-checked", on ? "true" : "false");
        item.dataset["ingredient"] = snap.id;
        item.classList.toggle("wx-srv-ck-encore-seed-on", on);
        item.append(glyph("wx-srv-ck-encore-box", on ? "☑" : "☐"), glyph("wx-srv-ck-encore-emoji", snap.emoji !== "" ? snap.emoji : "🍽️"));
        item.append(el("span", "wx-srv-ck-encore-name", snap.name));
        // A full set of starters leaves the others to be swapped in, not added.
        item.disabled = busy || (!on && encoreSeeds.length >= limit && limit > 1);
        item.addEventListener("click", () => {
          if (busy) return;
          if (encoreSeeds.includes(snap.id)) encoreSeeds = encoreSeeds.filter((id) => id !== snap.id);
          else if (encoreSeeds.length < limit) encoreSeeds = [...encoreSeeds, snap.id];
          else encoreSeeds = [...encoreSeeds.slice(1), snap.id];
          refresh();
        });
        return item;
      }),
    );
  }

  function refresh(): void {
    for (const [option, on] of [
      [openOption, !blindChosen],
      [blindOption, blindChosen],
    ] as const) {
      option.setAttribute("aria-checked", on ? "true" : "false");
      option.classList.toggle("wx-srv-ck-mode-on", on);
      // A radio group is ONE tab stop (the chosen mode); the arrow keys move within it.
      option.tabIndex = on ? 0 : -1;
      option.disabled = busy;
    }
    twistsBody.hidden = !twistsOpen;
    twistsToggle.setAttribute("aria-expanded", twistsOpen ? "true" : "false");
    twistsCaret.textContent = twistsOpen ? "▾" : "▸";
    const count = twistCount();
    twistsCount.textContent = count === 0 ? "" : count === 1 ? "1 on" : `${count} on`;
    twistsCount.hidden = count === 0;
    twistsToggle.disabled = busy;

    const chef = chefAvailable();
    chefRows.hidden = !chef;
    chefNote.hidden = !optionsLoaded || chef;
    chefNote.textContent = "Chef's style, kitchen challenges, the cloche and secret stars need the chef, who isn't available right now.";
    if (chef) drawCatalogue();
    for (const [toggle, on] of [
      [cloche.button, wildcard],
      [stars.button, starsOn],
    ] as const) {
      toggle.setAttribute("aria-checked", on ? "true" : "false");
      toggle.classList.toggle("wx-srv-ck-twist-on", on);
      toggle.disabled = busy;
    }
    fridge.setDisabled(busy);
    drawEncore();
    go.disabled = busy || (encore !== null && encoreSeeds.length === 0);
    cancel.disabled = busy;
    go.textContent = busy ? "Starting…" : encore !== null ? "Start encore" : "Start Cookout";
  }

  function select(blind: boolean): void {
    if (busy) return;
    blindChosen = blind;
    refresh();
  }

  // The arrows move the choice (and the focus) between the two modes, as a radio group does.
  modes.addEventListener("keydown", (event) => {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back) return;
    event.preventDefault();
    select(!blindChosen);
    (blindChosen ? blindOption : openOption).focus();
  });

  twistsToggle.addEventListener("click", () => {
    if (busy) return;
    twistsOpen = !twistsOpen;
    refresh();
  });
  cloche.button.addEventListener("click", () => {
    if (busy) return;
    wildcard = !wildcard;
    refresh();
  });
  stars.button.addEventListener("click", () => {
    if (busy) return;
    starsOn = !starsOn;
    refresh();
  });
  encoreDrop.addEventListener("click", () => {
    if (busy) return;
    encore = null;
    encoreSeeds = [];
    refresh();
  });

  // Tab stays inside the sheet while it is open (it is modal over the chat). Escape is deliberately not
  // handled: it is the chat's panic key.
  sheet.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const stops = [...sheet.querySelectorAll<HTMLElement>("button, input")].filter(
      (node) =>
        !(node as HTMLButtonElement).disabled &&
        node.closest("[hidden]") === null &&
        // Inside the radio group only the chosen mode is a stop.
        !(node.parentElement === modes && node.tabIndex < 0),
    );
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;
    const active = doc.activeElement;
    if (event.shiftKey && (active === first || !sheet.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });

  function setBusy(next: boolean): void {
    busy = next;
    refresh();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    generation += 1;
    busy = false;
    fridge.reset();
    root.hidden = true;
  }

  async function start(): Promise<void> {
    if (busy) return;
    const chosen = choices();
    if (encore !== null && chosen.encore === null) return;
    const key = JSON.stringify(chosen);
    if (key !== clientKey) {
      clientId = deps.newId();
      clientKey = key;
    }
    const started = ++generation;
    setBusy(true);
    error.hidden = true;
    try {
      await deps.start(chosen, clientId);
    } catch (thrown) {
      if (started === generation) {
        error.textContent =
          thrown instanceof Error && thrown.message !== "" ? thrown.message : "Couldn't start a Cookout — try again.";
        error.hidden = false;
        setBusy(false);
      }
      return;
    }
    if (started === generation) close();
  }

  async function loadOptions(): Promise<void> {
    const asked = generation;
    let loaded: CookoutOptions | null = null;
    try {
      loaded = await deps.loadOptions();
    } catch {
      loaded = null;
    }
    if (asked !== generation || !opened) return;
    options = loaded;
    optionsLoaded = true;
    refresh();
  }

  cancel.addEventListener("click", () => close());
  backdrop.addEventListener("click", () => {
    if (!busy) close();
  });
  go.addEventListener("click", () => void start());

  return {
    element: root,
    open(preset = {}, topOffsetPx = 0) {
      // A start in flight finishes first (opening again must not allow a second Start beside it).
      if (busy) return;
      generation += 1;
      clientId = "";
      clientKey = "";
      blindChosen = preset.blind ?? false;
      style = preset.style ?? null;
      challenge = preset.challenge ?? null;
      wildcard = preset.wildcard ?? false;
      starsOn = preset.stars ?? false;
      fridgeChosen = preset.fridge ?? null;
      fridge.set(fridgeChosen);
      encore = preset.encore !== undefined && preset.encore !== null && preset.encore.candidates.length > 0 ? preset.encore : null;
      // The first starter is ticked so an encore can start at once; the players can change it.
      encoreSeeds = encore === null ? [] : encore.candidates.slice(0, 1).map((s) => s.id);
      trimEncore();
      // The twists show when the round already uses some (a "New" of a twisty round), else stay folded.
      twistsOpen = style !== null || challenge !== null || wildcard || starsOn || fridgeChosen !== null;
      options = null;
      optionsLoaded = false;
      root.style.top = `${topOffsetPx}px`;
      opened = true;
      busy = false;
      error.hidden = true;
      body.scrollTop = 0;
      refresh();
      root.hidden = false;
      go.focus();
      void loadOptions();
    },
    close,
    isOpen: () => opened,
  };
}
