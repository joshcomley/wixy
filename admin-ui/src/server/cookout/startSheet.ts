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
//
// GAME MODES (spec/server-chat/09c-cookout-modes.md §6.1): when the server lists more than Classic, a first
// section "What are we making?" shows one picture tile per mode (a radio group; Classic selected), and the
// Open/Blind choice follows under "How do we play?". The twists shown are the chosen mode's; a toasted
// sandwich's fridge raid searches breads. "New" preselects the round's mode; an encore locks the tile to its
// source round's mode ("Same game as before"). With Classic alone listed the sheet is exactly as before.
// Open/Blind is called the "play style" in this file, so "mode" means one thing.

import type {
  CatalogueEntry,
  ChallengeId,
  ConceptId,
  CookoutOptions,
  EncoreKind,
  IngredientSnap,
  ModeOption,
  SearchResult,
  StyleId,
} from "./api";
import { CLASSIC_MODE_ID, CLASSIC_OPTION, isChallengeId, isStyleId } from "./api";
import { createFridgeSearch } from "./fridgeSearch";
import { modeTileUrl, ordinal } from "./modes";

/** An encore's source concept and the starters it offers (its leftovers, or the banked dish's own). */
export interface EncorePreset {
  readonly fromSeq: number;
  readonly generation: number;
  readonly conceptId: ConceptId;
  readonly kind: EncoreKind;
  /** The source dish's title, for the banner (null when unknown). */
  readonly title: string | null;
  /** The starters on offer. `kind` (a mode round's pick kind) seats each one (09c §2.5); absent = unknown. */
  readonly candidates: readonly EncoreCandidate[];
  /** The source round's game mode: an encore stays in it (09c §2.5). Absent = Classic. */
  readonly mode?: string;
}

/** What the sheet opens with. Anything absent is the default (Classic, Open, no twists). */
export interface StartPreset {
  /** The game mode to preselect ("New" of a round); an encore's own mode wins and locks the tile. */
  readonly mode?: string;
  readonly blind?: boolean;
  readonly style?: StyleId | "spin" | null;
  readonly challenge?: ChallengeId | null;
  readonly wildcard?: boolean;
  readonly stars?: boolean;
  readonly fridge?: IngredientSnap | null;
  readonly encore?: EncorePreset | null;
}

/** What Start sends. Chef-only twists are already dropped when the server has no chef, and twists the chosen
 * mode does not allow are dropped too. */
export interface StartChoices {
  /** The game mode's id ("classic" by default). */
  readonly mode: string;
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
  /** The fridge raid's bank search, within the chosen mode's fridge kinds (Classic: the whole bank). */
  search(q: string, mode: string): Promise<SearchResult>;
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

/** An encore starter on offer, with its pick kind when the wire says it. */
export type EncoreCandidate = IngredientSnap & { readonly kind?: string | null };

/** Where an encore starter sits: anywhere (Classic: two starters, one per player), the first turn (a mode's
 * fridge kind — a toasted sandwich's bread), the filling turn, or nowhere (`reason` says why). */
export type EncoreSeat = "any" | "first" | "filling";

export interface EncoreSeatRule {
  readonly seat: EncoreSeat | null;
  readonly reason: string | null;
}

/** The fridge kinds of a mode in words ("bread"). */
function fridgeWord(mode: ModeOption): string {
  return (mode.fridgeKinds ?? []).map((k) => k.replace(/-+/g, " ")).join(" or ");
}

/** A mode whose first turn takes only its fridge kinds (Toasted sandwich: the bread). */
function seatsByKind(mode: ModeOption): boolean {
  return mode.id !== CLASSIC_MODE_ID && mode.fridgeKinds !== null && mode.fridgeKinds.length > 0;
}

/** Where one encore starter may sit (09c §2.5): a leftovers encore's starters are always fillings (exactly
 * one); a remix seats at most one of the mode's first-turn kind (not when the fridge raid already supplies it)
 * and at most one filling; a remix starter whose kind is unknown cannot be seated. */
export function encoreSeat(mode: ModeOption, encoreKind: EncoreKind, candidate: EncoreCandidate, hasFridge: boolean): EncoreSeatRule {
  if (!seatsByKind(mode)) return { seat: "any", reason: null };
  if (encoreKind === "leftovers") return { seat: "filling", reason: null };
  const kind = candidate.kind ?? null;
  if (kind === null) return { seat: null, reason: "Can't be a starter here" };
  if (mode.fridgeKinds?.includes(kind) === true) {
    return hasFridge ? { seat: null, reason: `Your fridge ${fridgeWord(mode)} is the ${fridgeWord(mode)}` } : { seat: "first", reason: null };
  }
  return { seat: "filling", reason: null };
}

/** Thrown by the caller's `start` when the server refused the round: `kind` says why. */
export class CookoutStartError extends Error {
  constructor(
    readonly kind: "unsupported" | "invalid" | "game_unavailable" | "unavailable" | "lost",
    message: string,
  ) {
    super(message);
    this.name = "CookoutStartError";
  }
}

/** The fridge raid row's words for a mode (09c §6.1): Classic's own, else "Start with a bread you have at
 * home" from the mode's fridge kinds. */
export function fridgeWords(mode: ModeOption): { readonly hint: string; readonly placeholder: string } {
  if (mode.id === CLASSIC_MODE_ID || mode.fridgeKinds === null || mode.fridgeKinds.length === 0) {
    return { hint: "Start with one thing you actually have at home tonight", placeholder: "Search the pantry — e.g. tomatoes" };
  }
  const kinds = mode.fridgeKinds.map((k) => k.replace(/-+/g, " "));
  return { hint: `Start with a ${kinds.join(" or ")} you have at home`, placeholder: `Search for a ${kinds.join(" or ")} — e.g. sourdough` };
}

/** The cloche row's hint (09c §6.1): Classic's own words, a mode's "a mystery 9th ingredient". */
export function clocheHint(mode: ModeOption): string {
  return mode.id === CLASSIC_MODE_ID
    ? "Lift a lid for a surprise 11th ingredient"
    : `Lift a lid for a mystery ${ordinal(mode.turns + 1)} ingredient`;
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

  // -- What are we making? (the game mode tiles; hidden while Classic is the only mode) -------------------

  const what = el("div", "wx-srv-ck-start-what");
  what.hidden = true;
  const whatHead = el("p", "wx-srv-ck-start-section", "What are we making?");
  whatHead.id = "wx-srv-ck-start-what";
  const tiles = el("div", "wx-srv-ck-mtiles");
  tiles.setAttribute("role", "radiogroup");
  tiles.setAttribute("aria-labelledby", whatHead.id);
  const lockedNote = el("p", "wx-srv-ck-mtiles-note", "Same game as before");
  lockedNote.hidden = true;
  what.append(whatHead, tiles, lockedNote);
  const howHead = el("p", "wx-srv-ck-start-section", "How do we play?");
  howHead.id = "wx-srv-ck-start-how";
  howHead.hidden = true;

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

  // -- The play style: Open or Blind ------------------------------------------------------------------------

  const playStyles = el("div", "wx-srv-ck-start-modes");
  playStyles.setAttribute("role", "radiogroup");
  playStyles.setAttribute("aria-label", "Open or Blind");

  function playStyleOption(blind: boolean, icon: string, name: string, hint: string): HTMLButtonElement {
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

  const openOption = playStyleOption(false, "👀", "Open mode", "You both see every pair and every pick");
  const blindOption = playStyleOption(true, "🕵️", "Blind mode", "Secret picks, then one big reveal");
  playStyles.append(openOption, blindOption);

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
  const clocheHintEl = cloche.button.querySelector<HTMLElement>(".wx-srv-ck-twist-hint");
  const stars = toggleRow("stars", "⭐", "Secret stars", "Each star one of your picks; the chef makes them the heroes");
  chefRows.append(styleRow, challengeRow, cloche.row, stars.row);

  const fridgeRow = el("div", "wx-srv-ck-twist wx-srv-ck-twist-fridge");
  const fridge = createFridgeSearch({
    document: doc,
    search: (q) => deps.search(q, modeChosen),
    onChange: (snap) => {
      const before = encoreSeeds;
      fridgeChosen = snap;
      // The fridge raid takes one of the two starter places.
      trimEncore();
      if (snap !== null) {
        // What the fridge pick pushed out comes back if it is cleared again (a bread starter, 09c §2.5).
        fridgeDisplaced = [...fridgeDisplaced, ...before.filter((id) => !encoreSeeds.includes(id) && !fridgeDisplaced.includes(id))];
      } else if (fridgeDisplaced.length > 0) {
        encoreSeeds = [...fridgeDisplaced, ...encoreSeeds];
        fridgeDisplaced = [];
        trimEncore();
      }
      refresh();
    },
    ...(deps.setTimeout === undefined ? {} : { setTimeout: deps.setTimeout }),
    ...(deps.clearTimeout === undefined ? {} : { clearTimeout: deps.clearTimeout }),
  });
  const fridgeHead = rowHead("🧊", "Fridge raid", "Start with one thing you actually have at home tonight");
  const fridgeHintEl = fridgeHead.querySelector<HTMLElement>(".wx-srv-ck-twist-hint");
  fridgeRow.append(fridgeHead, fridge.element);
  twistsBody.append(chefNote, chefRows, fridgeRow);

  const error = el("p", "wx-srv-ck-start-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  /** A mode encore whose game the options did not describe (the read failed, or it is not listed): Start
   * waits, and the read can be tried again (09c §2.5 — its starters are never seated by Classic's rules). */
  const modeMissing = el("div", "wx-srv-ck-mode-missing");
  modeMissing.setAttribute("role", "alert");
  modeMissing.hidden = true;
  const modeMissingRetry = plainButton("wx-srv-ck-mode-missing-retry", "Try again");
  modeMissing.append(el("p", "wx-srv-ck-mode-missing-text", "Couldn't load this game — try again."), modeMissingRetry);
  const actions = el("div", "wx-srv-ck-start-actions");
  const cancel = plainButton("wx-srv-ck-start-cancel", "Cancel");
  const go = plainButton("wx-srv-ck-start-go", "Start Cookout");
  actions.append(cancel, go);
  const body = el("div", "wx-srv-ck-start-body");
  body.append(intro, what, encoreBox, modeMissing, howHead, playStyles, twists, error);
  sheet.append(heading, body, actions);
  root.append(backdrop, sheet);

  // -- State -----------------------------------------------------------------------------------------------

  let opened = false;
  let modeChosen: string = CLASSIC_MODE_ID;
  /** An encore's mode: the tile cannot change. */
  let modeLocked = false;
  let blindChosen = false;
  let style: StyleId | "spin" | null = null;
  let challenge: ChallengeId | null = null;
  let wildcard = false;
  let starsOn = false;
  let fridgeChosen: IngredientSnap | null = null;
  let encore: EncorePreset | null = null;
  let encoreSeeds: string[] = [];
  /** Starters a fridge pick pushed out, given back when it is cleared. */
  let fridgeDisplaced: string[] = [];
  /** The options are being read again from "Try again". */
  let retryingOptions = false;
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

  /** The modes the server lists (Classic alone until the options are read). */
  function listedModes(): readonly ModeOption[] {
    return options?.modes ?? [CLASSIC_OPTION];
  }

  /** The chosen mode's entry; a locked encore mode the server no longer lists still names itself. */
  /** The chosen mode is described by the options (Classic always is). */
  function modeKnown(): boolean {
    return modeChosen === CLASSIC_MODE_ID || listedModes().some((m) => m.id === modeChosen);
  }

  function chosenMode(): ModeOption {
    return listedModes().find((m) => m.id === modeChosen) ?? (modeChosen === CLASSIC_MODE_ID ? CLASSIC_OPTION : { ...CLASSIC_OPTION, id: modeChosen, label: modeChosen });
  }

  /** Whether the chosen mode allows a twist (09c §4: the start sheet shows only the mode's twists). */
  function allows(twist: string): boolean {
    return chosenMode().twists.includes(twist);
  }

  function choices(): StartChoices {
    const chef = chefAvailable();
    return {
      mode: modeChosen,
      blind: blindChosen,
      style: chef && allows("style") ? style : null,
      challenge: chef && allows("challenge") ? challenge : null,
      wildcard: chef && allows("wildcard") && wildcard,
      stars: chef && allows("stars") && starsOn,
      fridgeSeedId: allows("fridge") ? (fridgeChosen?.id ?? null) : null,
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

  function seatOf(candidate: EncoreCandidate): EncoreSeatRule {
    if (encore === null) return { seat: null, reason: null };
    return encoreSeat(chosenMode(), encore.kind, candidate, fridgeChosen !== null);
  }

  /** Keep the encore's starters to what the round can seat: Classic, within the limit the fridge raid leaves;
   * a mode round, one per seat (a leftovers encore: one filling) and none that cannot be seated. With none
   * left, the first starter that can be seated is ticked so the encore can still start at once. */
  function trimEncore(): void {
    if (encore === null) return;
    // Until the mode is known its seats are not: leave the starters as they are (Start waits).
    if (!modeKnown()) return;
    if (!seatsByKind(chosenMode())) {
      const limit = encoreSeedLimit(fridgeChosen !== null);
      if (encoreSeeds.length > limit) encoreSeeds = encoreSeeds.slice(0, limit);
      return;
    }
    const kept: string[] = [];
    const seats = new Set<EncoreSeat>();
    for (const id of encoreSeeds) {
      const candidate = encore.candidates.find((c) => c.id === id);
      const seat = candidate === undefined ? null : seatOf(candidate).seat;
      if (seat === null || seats.has(seat)) continue;
      seats.add(seat);
      kept.push(id);
    }
    if (encore.kind === "leftovers") kept.splice(1);
    if (kept.length === 0) {
      const first = encore.candidates.find((c) => seatOf(c).seat !== null);
      if (first !== undefined) kept.push(first.id);
    }
    encoreSeeds = kept;
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
    const mode = chosenMode();
    const byKind = seatsByKind(mode);
    const word = fridgeWord(mode);
    encoreHint.textContent = !byKind
      ? limit === 1
        ? "Choose 1 starter to begin the basket with (the fridge raid takes the other place)."
        : "Choose 1 or 2 starters to begin the basket with — you both see them."
      : encore.kind === "leftovers" || fridgeChosen !== null
        ? `Choose 1 filling to begin the basket with${fridgeChosen !== null ? ` (your fridge ${word} is the ${word})` : ""}.`
        : `Choose a ${word}, a filling, or one of each to begin the basket with — you both see them.`;
    const current = encore;
    encoreList.replaceChildren(
      ...encore.candidates.map((snap) => {
        const on = encoreSeeds.includes(snap.id);
        const rule = seatOf(snap);
        const item = plainButton("wx-srv-ck-encore-seed", "");
        item.setAttribute("role", "checkbox");
        item.setAttribute("aria-checked", on ? "true" : "false");
        item.dataset["ingredient"] = snap.id;
        item.classList.toggle("wx-srv-ck-encore-seed-on", on);
        item.append(glyph("wx-srv-ck-encore-box", on ? "☑" : "☐"), glyph("wx-srv-ck-encore-emoji", snap.emoji !== "" ? snap.emoji : "🍽️"));
        item.append(el("span", "wx-srv-ck-encore-name", snap.name));
        if (rule.reason !== null) item.append(el("span", "wx-srv-ck-encore-why", rule.reason));
        if (byKind) {
          // One starter per seat: ticking another of the same seat swaps it in (09c §2.5).
          item.disabled = busy || rule.seat === null;
        } else {
          // A full set of starters leaves the others to be swapped in, not added.
          item.disabled = busy || (!on && encoreSeeds.length >= limit && limit > 1);
        }
        item.addEventListener("click", () => {
          if (busy) return;
          if (encoreSeeds.includes(snap.id)) encoreSeeds = encoreSeeds.filter((id) => id !== snap.id);
          else if (byKind) {
            const seat = seatOf(snap).seat;
            if (seat === null) return;
            const sameSeat = (id: string): boolean => {
              const other = current.candidates.find((c) => c.id === id);
              return other !== undefined && seatOf(other).seat === seat;
            };
            const rest = encoreSeeds.filter((id) => !sameSeat(id));
            encoreSeeds = current.kind === "leftovers" ? [snap.id] : [...rest, snap.id];
          } else if (encoreSeeds.length < limit) encoreSeeds = [...encoreSeeds, snap.id];
          else encoreSeeds = [...encoreSeeds.slice(1), snap.id];
          refresh();
        });
        return item;
      }),
    );
  }

  /** One "What are we making?" tile: the mode's picture (its emoji when there is none or it fails), its
   * label and its one-line blurb. */
  function modeTile(mode: ModeOption): HTMLButtonElement {
    const on = mode.id === modeChosen;
    const tile = plainButton("wx-srv-ck-mtile", "");
    tile.setAttribute("role", "radio");
    tile.setAttribute("aria-checked", on ? "true" : "false");
    tile.dataset["modeId"] = mode.id;
    tile.classList.toggle("wx-srv-ck-mtile-on", on);
    tile.tabIndex = on ? 0 : -1;
    const art = el("span", "wx-srv-ck-mtile-art");
    const emoji = el("span", "wx-srv-ck-mtile-emoji", mode.emoji !== "" ? mode.emoji : "🍽️");
    emoji.setAttribute("aria-hidden", "true");
    const url = modeTileUrl(mode.id);
    if (url !== null) {
      const img = doc.createElement("img");
      img.className = "wx-srv-ck-mtile-img";
      img.src = url;
      img.alt = mode.label;
      img.decoding = "async";
      img.draggable = false;
      emoji.hidden = true;
      img.addEventListener("error", () => {
        img.remove();
        emoji.hidden = false;
      });
      art.append(img, emoji);
    } else {
      art.append(emoji);
    }
    tile.append(art, el("span", "wx-srv-ck-mtile-label", mode.label));
    if (mode.blurb !== "") tile.append(el("span", "wx-srv-ck-mtile-blurb", mode.blurb));
    tile.append(glyph("wx-srv-ck-mtile-tick", "✓"));
    tile.disabled = busy || (modeLocked && !on);
    tile.addEventListener("click", () => chooseMode(mode.id));
    return tile;
  }

  function drawModes(): void {
    const listed = listedModes();
    const shown = listed.length > 1;
    what.hidden = !shown;
    howHead.hidden = !shown;
    // The sheet tightens its rows while the tiles show, so it still fits a phone (09c §6.1).
    sheet.classList.toggle("wx-srv-ck-start-with-modes", shown);
    playStyles.setAttribute("aria-labelledby", shown ? howHead.id : "");
    if (!shown) {
      playStyles.removeAttribute("aria-labelledby");
      tiles.replaceChildren();
      return;
    }
    const entries = modeLocked ? listed.filter((m) => m.id === modeChosen) : listed;
    // Redrawing the tiles must not drop the focus from the group (a tap, the arrows): it moves to the chosen tile.
    const hadFocus = tiles.contains(doc.activeElement);
    tiles.replaceChildren(...(entries.length > 0 ? entries : [chosenMode()]).map((m) => modeTile(m)));
    if (hadFocus) tiles.querySelector<HTMLElement>(".wx-srv-ck-mtile-on")?.focus();
    lockedNote.hidden = !modeLocked;
  }

  function chooseMode(id: string): void {
    if (busy || modeLocked || id === modeChosen) return;
    modeChosen = id;
    // A fridge pick searched in another mode may not be one this mode can start with.
    fridgeChosen = null;
    fridge.reset();
    refresh();
  }

  // The arrows move the choice (and the focus) between the mode tiles, as a radio group does.
  tiles.addEventListener("keydown", (event) => {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !back) return;
    event.preventDefault();
    const listed = listedModes();
    if (modeLocked || listed.length < 2) return;
    const index = Math.max(0, listed.findIndex((m) => m.id === modeChosen));
    const next = listed[(index + (forward ? 1 : listed.length - 1)) % listed.length];
    if (next === undefined) return;
    chooseMode(next.id);
    tiles.querySelector<HTMLElement>(`[data-mode-id="${next.id}"]`)?.focus();
  });

  function refresh(): void {
    const mode = chosenMode();
    drawModes();
    // With the mode tiles showing, their blurbs say what each game is: the one-line intro steps aside.
    intro.hidden = !what.hidden;
    intro.textContent =
      mode.id === CLASSIC_MODE_ID
        ? "Take turns picking 10 ingredients, then see what the chef invents."
        : `Take turns picking ${mode.turns} ingredients, then see what the chef invents.`;
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
    // Only the chosen mode's twists (09c §4), in that mode's words.
    styleRow.hidden = !allows("style");
    challengeRow.hidden = !allows("challenge");
    cloche.row.hidden = !allows("wildcard");
    stars.row.hidden = !allows("stars");
    fridgeRow.hidden = !allows("fridge");
    if (clocheHintEl !== null) clocheHintEl.textContent = clocheHint(mode);
    const fridgeText = fridgeWords(mode);
    if (fridgeHintEl !== null) fridgeHintEl.textContent = fridgeText.hint;
    fridge.setPlaceholder(fridgeText.placeholder);
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
    const missing = optionsLoaded && !modeKnown();
    modeMissing.hidden = !missing;
    modeMissingRetry.disabled = busy || retryingOptions;
    modeMissingRetry.textContent = retryingOptions ? "Trying…" : "Try again";
    go.disabled = busy || !optionsLoaded || missing || (encore !== null && encoreSeeds.length === 0);
    cancel.disabled = busy;
    go.textContent = busy ? "Starting…" : encore !== null ? "Start encore" : "Start Cookout";
  }

  function select(blind: boolean): void {
    if (busy) return;
    blindChosen = blind;
    refresh();
  }

  // The arrows move the choice (and the focus) between Open and Blind, as a radio group does.
  playStyles.addEventListener("keydown", (event) => {
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
    // Not an encore any more: the game mode can be chosen again.
    modeLocked = false;
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
        // Inside each radio group only the chosen option is a stop.
        !((node.parentElement === playStyles || node.parentElement === tiles) && node.tabIndex < 0),
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
    // Until the options are read the chef rows' choices cannot be judged, and a preselected twist would be
    // dropped without a word; the read always settles (the request has a timeout, a failure reads as none).
    if (busy || !optionsLoaded) return;
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
          thrown instanceof CookoutStartError && thrown.kind === "invalid" && chosen.encore !== null && seatsByKind(chosenMode())
            ? chosen.encore.kind === "leftovers"
              ? "Pick one filling to start with."
              : `Pick one ${fridgeWord(chosenMode())} and one filling to start with.`
            : thrown instanceof Error && thrown.message !== ""
              ? thrown.message
              : "Couldn't start a Cookout — try again.";
        error.hidden = false;
        setBusy(false);
        // A mode switched off meanwhile (09c §6.1): read the options again so its tile goes.
        if (chosen.mode !== CLASSIC_MODE_ID) void loadOptions(true);
      }
      return;
    }
    if (started === generation) close();
  }

  /** `reload`: after a failed start; the sheet keeps its message and only drops what the server no longer
   * lists (a gone mode falls back to Classic). */
  async function loadOptions(reload = false): Promise<void> {
    const asked = generation;
    let loaded: CookoutOptions | null = null;
    try {
      loaded = await deps.loadOptions();
    } catch {
      loaded = null;
    }
    if (asked !== generation || !opened) return;
    if (reload && loaded === null) return;
    options = loaded;
    optionsLoaded = true;
    // A preselected mode the server does not list (switched off) falls back to Classic — unless an encore
    // locked it, when the server's own answer says why it cannot start.
    if (!modeLocked && !listedModes().some((m) => m.id === modeChosen)) {
      modeChosen = CLASSIC_MODE_ID;
      fridgeChosen = null;
      fridge.reset();
    }
    // The encore's seating rules come with the mode's entry: re-seat its starters now.
    trimEncore();
    refresh();
  }

  modeMissingRetry.addEventListener("click", () => {
    if (busy || retryingOptions) return;
    retryingOptions = true;
    refresh();
    void loadOptions(true).finally(() => {
      retryingOptions = false;
      if (opened) refresh();
    });
  });
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
      const encoreMode = preset.encore !== undefined && preset.encore !== null && preset.encore.candidates.length > 0 ? (preset.encore.mode ?? CLASSIC_MODE_ID) : null;
      modeChosen = encoreMode ?? preset.mode ?? CLASSIC_MODE_ID;
      modeLocked = encoreMode !== null;
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
      fridgeDisplaced = [];
      retryingOptions = false;
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
