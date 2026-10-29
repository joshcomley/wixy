// Cookout's HTTP surface (`/cookout*`, workspace 00058; spec/server-chat/09-cookout.md §4.2,
// docs/ai/contracts.md). Every response the game draws from is parsed defensively HERE and nowhere
// else, following `adventure/api.ts`: an older or newer server may omit or add keys, and a
// half-understood round must never reach the pane. A body that is not a round yields `null` and the
// caller treats the call as unavailable; nothing in this file throws on a bad shape.
//
// BLIND MODE is the server's job (spec §1.3): a viewer's view simply never contains the partner's
// options, offers or picks while the round is being picked. Nothing here asks for them, keeps them or
// could reconstruct them: the parsers read only what the view carries.
//
// A dish picture URL is kept only when it points at THIS origin (`sameOriginMediaUrl`, the Adventure
// rule): a private chat never makes the browser contact a third-party image host.
//
// THE TWISTS (spec/server-chat/09a-cookout-twists.md §4, frozen wire A.3) are all additive: every new
// field has an "off" value a core-era server's view parses to, so a twist-free round reads exactly as
// before. Secret-by-design twists (the dinner vote, the secret stars) stay hidden from the partner in
// BOTH modes until their own reveal; the server redacts them, and the parsers below drop them again if
// a buggy server ever sent them early (the same second lock as the Blind picks).
//
// GAME MODES (spec/server-chat/09c-cookout-modes.md §5.4, frozen wire A.3) are additive too: a view,
// summary, book entry or options body without `mode` is a Classic one (ten turns, five picks each), and
// an unknown mode id parses as a generic mode carrying its own label. Every count that decided a round's
// shape (`turns`, `picksPerPlayer`) is read from the view's mode, never assumed.

import { sameOriginMediaUrl } from "../adventure/api";
import { ServerLockedError, serverFetch } from "../api/http";
import type { Message } from "../api/messages";
import type { ServerSession } from "../types";

export type CookoutState = "picking" | "finished" | "abandoned";
export type ConceptsState = "none" | "pending" | "ready" | "failed" | "unavailable";
export type ImagesState = "none" | "pending" | "done" | "failed";
export type RecipeState = "none" | "pending" | "banked" | "failed" | "unavailable";
export type CookoutRole = "base" | "protein" | "produce" | "accent";
export type ConceptId = "a" | "b" | "c";
export type PlayerSlot = 1 | 2;

export type StyleId =
  | "cosy-pub"
  | "street-food"
  | "posh-tasting"
  | "breakfast-for-dinner"
  | "date-night-bistro"
  | "takeaway-at-home"
  | "picnic"
  | "campfire";
export type ChallengeId = "one-pan" | "no-oven" | "thirty-minutes" | "six-steps";
export type WildcardState = "off" | "armed" | "offered" | "lifted" | "declined";
export type SwapState = "none" | "proposed" | "done";
export type PickVia = "pick" | "lucky" | "chaos" | "seed" | "wildcard" | "swap";
/** What the chef gate is waiting on (09a §1.4). */
export type GateWait = "stars" | "wildcard";
export type EncoreKind = "leftovers" | "remix";

export const CONCEPT_IDS: readonly ConceptId[] = ["a", "b", "c"];
/** Ten picks in a Classic round: five each. Also the most turns any mode can have (the store's `turn`
 * column allows 1..10). */
export const TOTAL_PICKS = 10;
export const PICKS_PER_PLAYER = 5;
/** Ten picks plus the cloche's surprise eleventh. */
export const MAX_BASKET = 11;
/** Hearts on a cooked recipe. */
export const MAX_RATING = 5;

const STATES: readonly string[] = ["picking", "finished", "abandoned"];
const CONCEPT_STATES: readonly string[] = ["none", "pending", "ready", "failed", "unavailable"];
const IMAGE_STATES: readonly string[] = ["none", "pending", "done", "failed"];
const RECIPE_STATES: readonly string[] = ["none", "pending", "banked", "failed", "unavailable"];
const ROLES: readonly string[] = ["base", "protein", "produce", "accent"];
const STYLE_IDS: readonly string[] = [
  "cosy-pub",
  "street-food",
  "posh-tasting",
  "breakfast-for-dinner",
  "date-night-bistro",
  "takeaway-at-home",
  "picnic",
  "campfire",
];
const CHALLENGE_IDS: readonly string[] = ["one-pan", "no-oven", "thirty-minutes", "six-steps"];
const WILDCARD_STATES: readonly string[] = ["off", "armed", "offered", "lifted", "declined"];
const SWAP_STATES: readonly string[] = ["none", "proposed", "done"];
const VIAS: readonly string[] = ["pick", "lucky", "chaos", "seed", "wildcard", "swap"];

export const CLASSIC_MODE_ID = "classic";

/** One pick kind of a game mode (09c §5.4): its id ("bread"), label ("the bread") and banner prompt. */
export interface ModeKind {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

/** The game mode a round was created in (public: a setting, not partner data). */
export interface CookoutModeInfo {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly turns: number;
  readonly picksPerPlayer: number;
  readonly kinds: readonly ModeKind[];
  /** The kind every dish is built on ("bread"), or null (Classic). */
  readonly anchorKind: string | null;
}

/** One mode of the start sheet's "What are we making?" (`GET /cookout/options` `modes`). */
export interface ModeOption extends Omit<CookoutModeInfo, "kinds" | "anchorKind"> {
  readonly blurb: string;
  /** 1–3 lines; `{starter}` stands for the player who starts the round. */
  readonly intro: readonly string[];
  readonly twists: readonly string[];
  /** The pick kinds a fridge raid may start with, or null for any (Classic). */
  readonly fridgeKinds: readonly string[] | null;
}

/** A toasted sandwich's build (09c §3.3), as the view names it. */
export interface BuildRef {
  readonly id: string;
  readonly label: string;
}

/** A mode as a Recipe book entry names it. */
export interface ModeRef {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
}

/** The mode of a view that carries none (an older server): today's game. */
export const CLASSIC_MODE: CookoutModeInfo = {
  id: CLASSIC_MODE_ID,
  label: "Classic",
  emoji: "🍳",
  turns: TOTAL_PICKS,
  picksPerPlayer: PICKS_PER_PLAYER,
  kinds: [],
  anchorKind: null,
};

export const CLASSIC_MODE_REF: ModeRef = { id: CLASSIC_MODE_ID, label: "Classic", emoji: "🍳" };

/** Every twist a mode can allow (09a): Classic allows all twelve. */
export const ALL_TWISTS: readonly string[] = [
  "swap",
  "vote",
  "style",
  "cooked",
  "wildcard",
  "fridge",
  "challenge",
  "veto",
  "encore",
  "lucky",
  "stars",
  "chaos",
];

export const CLASSIC_OPTION: ModeOption = {
  id: CLASSIC_MODE_ID,
  label: "Classic",
  emoji: "🍳",
  turns: TOTAL_PICKS,
  picksPerPlayer: PICKS_PER_PLAYER,
  blurb: "",
  intro: [],
  twists: ALL_TWISTS,
  fridgeKinds: null,
};

export function isClassic(mode: { readonly id: string }): boolean {
  return mode.id === CLASSIC_MODE_ID;
}

export function isStyleId(value: unknown): value is StyleId {
  return typeof value === "string" && STYLE_IDS.includes(value);
}

export function isChallengeId(value: unknown): value is ChallengeId {
  return typeof value === "string" && CHALLENGE_IDS.includes(value);
}

/** What a `Message` carries about its round: enough to notice it moved and draw the card's status
 * line — never an ingredient, an option, a star, a vote or a recipe (spec §1.3 "wire & cache hygiene",
 * 09a §4.4: the twists add counts and flags only). */
export interface CookoutSummary {
  readonly state: CookoutState;
  /** The game mode's id ("classic" when the server sent none). */
  readonly mode: string;
  readonly blind: boolean;
  readonly pickedCount: number;
  readonly concepts: ConceptsState;
  readonly bankedCount: number;
  readonly rev: number;
  readonly generation: number;
  readonly waiting: readonly GateWait[];
  readonly swap: SwapState;
  readonly dinnerDecided: boolean;
  readonly cookedCount: number;
}

/** An ingredient's catalogue picture (09b §E.1): two same-origin, content-addressed renditions. */
export interface IngredientImage {
  readonly card: string;
  readonly thumb: string;
}

/** One ingredient as the round froze it when it was offered (spec §2.3 rule 5), plus the two read-time
 * catalogue fields (09b §E.1): what it is, and its picture. Both are null from a pre-round-2 server, for an
 * ingredient the catalogue does not cover yet, and for a picture this server does not hold. */
export interface IngredientSnap {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly emoji: string;
  readonly blurb: string;
  readonly what: string | null;
  readonly image: IngredientImage | null;
}

export interface Staple {
  readonly id: string;
  readonly name: string;
  readonly image: IngredientImage | null;
}

/** A basket ingredient and how it got there (09a §4.3 `PickSnap`). `turn` is null for the wildcard and a
 * swapped-in item. `facts` (09b §E.1) arrive only once the round has left picking. */
export interface PickSnap extends IngredientSnap {
  readonly turn: number | null;
  /** The pick kind it filled ("bread", "cheese"… — 09c §5.4), or null (Classic, an older server). */
  readonly kind: string | null;
  readonly via: PickVia;
  readonly facts: readonly string[] | null;
}

export interface CookoutPlayer {
  readonly slot: PlayerSlot;
  /** Null for Slot 2 until somebody presses Join. */
  readonly name: string | null;
  readonly pickCount: number;
  /** Null for the partner's picks in a Blind round that has not been revealed. */
  readonly picks: readonly PickSnap[] | null;
  /** Null when this viewer may not know it (the partner's, in a Blind round before the reveal). */
  readonly chaosUsed: boolean | null;
  readonly vetoUsed: boolean | null;
}

export interface CookoutTurn {
  readonly turn: number;
  readonly player: PlayerSlot;
  /** The four fields below are null for anybody but the active player in a Blind round. `role` is the
   * turn's pick kind: a Classic bank role, or one of the mode's kinds ("bread", "cheese"…). */
  readonly role: string | null;
  readonly waitingForJoin: boolean;
  readonly options: readonly [IngredientSnap, IngredientSnap] | null;
  readonly offerIndex: number | null;
  readonly skipsRemaining: number | null;
  /** The pair on the table came from the chaos shelf (null when the pair is not shown). */
  readonly chaosPair: boolean | null;
  /** What the partner swept off this table, when they did (shown with the pair only). */
  readonly vetoed: IngredientSnap | null;
  readonly canChaos: boolean | null;
  readonly canLucky: boolean | null;
  /** Computed for THIS viewer: Open mode, they are the waiting partner, their sweep is unused. */
  readonly canVeto: boolean | null;
}

export interface ReplacedOption {
  readonly offer: number;
  readonly snap: IngredientSnap;
  readonly by: "veto" | "chaos";
}

export interface HistoryTurn {
  readonly turn: number;
  readonly player: PlayerSlot;
  readonly offers: ReadonlyArray<readonly [IngredientSnap, IngredientSnap]>;
  readonly choice: IngredientSnap | null;
  /** A starter's ingredient (fridge raid or encore): the turn had no pair. */
  readonly seed: IngredientSnap | null;
  readonly replaced: readonly ReplacedOption[];
  readonly chaosOffer: number | null;
  readonly lucky: boolean;
}

/** One fixed catalogue entry as the round names it (a style or a challenge). */
export interface SetupChip {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
}

/** The start-sheet twists a round was created with (immutable for the round). */
export interface CookoutSetup {
  readonly style: SetupChip | null;
  readonly styleSpun: boolean;
  readonly challenge: SetupChip | null;
  readonly wildcard: boolean;
  readonly stars: boolean;
  readonly fridgeRaid: boolean;
  readonly encore: { readonly kind: EncoreKind; readonly fromSeq: number | null; readonly fromTitle: string | null } | null;
}

export interface WildcardView {
  readonly state: WildcardState;
  readonly ingredient: IngredientSnap | null;
}

export interface StarsView {
  readonly enabled: boolean;
  /** The viewer's own star (a bound player only). */
  readonly mine: string | null;
  readonly partnerChosen: boolean;
  /** Revealed and locked are one moment (09a §1.5). */
  readonly revealed: boolean;
  /** Non-null only once revealed. */
  readonly partner: string | null;
}

export interface VotePair {
  readonly 1: ConceptId;
  readonly 2: ConceptId;
}

export interface VoteView {
  readonly you: ConceptId | null;
  readonly partnerVoted: boolean;
  readonly revealed: boolean;
  /** Both votes, only once both are in. */
  readonly votes: VotePair | null;
  readonly match: ConceptId | null;
}

export interface SwapView {
  readonly state: SwapState;
  /** This viewer may propose a rescue swap now. */
  readonly available: boolean;
  readonly by: PlayerSlot | null;
  readonly out: IngredientSnap | null;
  readonly pair: readonly [IngredientSnap, IngredientSnap] | null;
  readonly in: IngredientSnap | null;
}

export interface CookedInfo {
  readonly cookedAt: number;
  readonly cookedBy: string;
  readonly ratings: { readonly 1: number | null; readonly 2: number | null };
  readonly photo: Picture | null;
  readonly photoMessageSeq: number | null;
}

/** A superseded dish set (after a rescue swap): read-only. */
export interface GenerationView {
  readonly generation: number;
  readonly basket: readonly IngredientSnap[];
  readonly concepts: readonly Concept[];
  readonly pictures: { readonly a: Picture | null; readonly b: Picture | null; readonly c: Picture | null };
  readonly vote: { readonly votes: VotePair | null; readonly match: ConceptId | null };
  readonly recipes: { readonly a: RecipeSlot; readonly b: RecipeSlot; readonly c: RecipeSlot };
}

export interface OmittedItem {
  readonly ingredient: IngredientSnap;
  readonly reason: string;
}

export interface Concept {
  readonly id: ConceptId;
  readonly title: string;
  readonly vibe: string;
  readonly dishType: string;
  readonly technique: string;
  readonly description: string;
  readonly pickedIngredients: readonly IngredientSnap[];
  readonly staplesUsed: readonly Staple[];
  readonly omitted: readonly OmittedItem[];
  /** How the dish keeps the round's kitchen challenge (null without one). */
  readonly challengeNote: string | null;
  readonly totalMinutes: number | null;
  /** How a single-dish mode's idea is made ("Skillet-fried"); null for Classic. */
  readonly build: BuildRef | null;
}

export interface ConceptsView {
  readonly state: ConceptsState;
  readonly data: readonly Concept[] | null;
  readonly error: string | null;
}

/** A dish photo: both renditions are signed URLs on this server. */
export interface Picture {
  readonly attachmentId: string;
  readonly thumbUrl: string;
  readonly fullUrl: string;
}

export interface ImagesView {
  readonly state: ImagesState;
  readonly pictures: { readonly a: Picture | null; readonly b: Picture | null; readonly c: Picture | null };
}

export interface RecipeIngredient {
  readonly id: string;
  /** The display name when the server resolved it; otherwise the pane resolves `id` itself. */
  readonly name: string | null;
  readonly quantity: string;
  readonly note: string;
}

export interface RecipeStep {
  readonly text: string;
  readonly minutes: number | null;
  readonly uses: readonly string[];
}

export interface FullRecipe {
  readonly serves: number;
  readonly prepMinutes: number;
  readonly cookMinutes: number;
  readonly totalMinutes: number;
  readonly ingredients: readonly RecipeIngredient[];
  readonly steps: readonly RecipeStep[];
  readonly tips: readonly string[];
  /** "You'll need: …" (empty when the recipe does not list it). */
  readonly cookware: readonly string[];
}

export interface RecipeSlot {
  readonly state: RecipeState;
  readonly requestedBy: string | null;
  readonly bankedAt: number | null;
  readonly error: string | null;
  readonly data: FullRecipe | null;
  /** The dish set this recipe belongs to (1 unless a rescue swap happened). */
  readonly generation: number;
  readonly cooked: CookedInfo | null;
}

export interface CookoutView {
  readonly seq: number;
  readonly state: CookoutState;
  /** The round's game mode (Classic when the server sent none). */
  readonly mode: CookoutModeInfo;
  readonly rev: number;
  readonly blind: boolean;
  readonly revealed: boolean;
  readonly players: readonly [CookoutPlayer, CookoutPlayer];
  readonly you: { readonly slot: PlayerSlot; readonly chaosUsed: boolean; readonly vetoUsed: boolean } | null;
  readonly current: CookoutTurn | null;
  readonly history: readonly HistoryTurn[];
  readonly staples: readonly Staple[];
  readonly concepts: ConceptsView;
  readonly images: ImagesView;
  readonly recipes: { readonly a: RecipeSlot; readonly b: RecipeSlot; readonly c: RecipeSlot };
  // -- Twists (09a §4.3) --
  readonly setup: CookoutSetup;
  readonly generation: number;
  /** Fridge-raid and encore starters: public in both modes. */
  readonly starters: readonly PickSnap[];
  /** The effective basket once this viewer may see all of it (incl. wildcard and swap), else null. */
  readonly basket: readonly PickSnap[] | null;
  readonly gate: { readonly waitingFor: readonly GateWait[] };
  readonly wildcard: WildcardView;
  readonly stars: StarsView;
  readonly vote: VoteView | null;
  readonly swap: SwapView;
  readonly generations: readonly GenerationView[];
}

export type CookoutFailure =
  | "not_found"
  | "bad_state"
  | "not_your_turn"
  | "not_player"
  | "skip_exhausted"
  | "exhausted"
  | "token_used"
  | "recipe_pending"
  | "invalid"
  | "game_unavailable"
  | "unavailable";

export type CookoutOutcome =
  | { readonly ok: true; readonly view: CookoutView }
  | { readonly ok: false; readonly kind: CookoutFailure };

export type CreateCookoutResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly kind: "unsupported" | "invalid" | "game_unavailable" | "unavailable" };

// -- Primitive readers ---------------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPosInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asIntIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function asSlot(value: unknown): PlayerSlot | null {
  return value === 1 || value === 2 ? value : null;
}

function isConceptId(value: unknown): value is ConceptId {
  return value === "a" || value === "b" || value === "c";
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// -- Summary -------------------------------------------------------------------------------------------

/** The `cookout` summary of a `Message`, or null when absent/malformed ("no Cookout here"). */
export function parseCookoutSummary(value: unknown): CookoutSummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const state = record["state"];
  const rev = asPosInt(record["rev"]);
  if (typeof state !== "string" || !STATES.includes(state) || rev === null) return null;
  const concepts = record["concepts"];
  const swap = record["swap"];
  const mode = record["mode"];
  return {
    state: state as CookoutState,
    mode: typeof mode === "string" && ID_RE.test(mode) ? mode : CLASSIC_MODE_ID,
    blind: record["blind"] === true,
    pickedCount: asIntIn(record["pickedCount"], 0, TOTAL_PICKS) ?? 0,
    concepts: typeof concepts === "string" && CONCEPT_STATES.includes(concepts) ? (concepts as ConceptsState) : "none",
    // A round of two dish sets can hold up to six banked recipes.
    bankedCount: asIntIn(record["bankedCount"], 0, CONCEPT_IDS.length * 2) ?? 0,
    rev,
    generation: asPosInt(record["generation"]) ?? 1,
    waiting: parseWaiting(record["waiting"]),
    swap: typeof swap === "string" && SWAP_STATES.includes(swap) ? (swap as SwapState) : "none",
    dinnerDecided: record["dinnerDecided"] === true,
    cookedCount: asIntIn(record["cookedCount"], 0, CONCEPT_IDS.length * 2) ?? 0,
  };
}

function parseWaiting(value: unknown): GateWait[] {
  if (!Array.isArray(value)) return [];
  const out: GateWait[] = [];
  for (const raw of value as unknown[]) {
    if ((raw === "stars" || raw === "wildcard") && !out.includes(raw)) out.push(raw);
  }
  return out;
}

// -- View pieces ---------------------------------------------------------------------------------------

/** A catalogue picture URL: only this server's own content-addressed route (09b §E.3). */
const IMAGE_URL_RE = /^\/admin\/cookout-img\/[0-9a-f]{64}\.webp$/;
export const MAX_WHAT = 120;
export const MAX_FACTS = 3;
export const MAX_FACT = 200;

/** `{card, thumb}` when both are this server's picture URLs, else null — a malformed half drops the whole
 * picture, so a card never shows one rendition and falls back on the other. */
export function parseIngredientImage(value: unknown): IngredientImage | null {
  const record = asRecord(value);
  const card = asString(record?.["card"]);
  const thumb = asString(record?.["thumb"]);
  if (card === null || thumb === null || !IMAGE_URL_RE.test(card) || !IMAGE_URL_RE.test(thumb)) return null;
  return { card, thumb };
}

/** The "what it is" line: a non-blank string of at most 120 characters, else null. */
export function parseWhat(value: unknown): string | null {
  const what = asText(value, MAX_WHAT);
  return what === null || what.trim() === "" ? null : what;
}

/** Fun facts: an array of at most three strings of at most 200 characters each, else null (all or none). */
export function parseFacts(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FACTS) return null;
  const out: string[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "string" || raw.length > MAX_FACT) return null;
    if (raw.trim() !== "") out.push(raw);
  }
  return out;
}

/** One frozen ingredient, or null. The emoji and blurb are decoration: a missing one is blank. */
export function parseSnap(value: unknown): IngredientSnap | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asString(record["id"]);
  const name = asText(record["name"], 120);
  if (id === null || !ID_RE.test(id) || name === null || name.trim() === "") return null;
  return {
    id,
    name,
    category: asText(record["category"], 64) ?? "",
    emoji: asText(record["emoji"], 16) ?? "",
    blurb: asText(record["blurb"], 200) ?? "",
    what: parseWhat(record["what"]),
    image: parseIngredientImage(record["image"]),
  };
}

function parseSnaps(value: unknown, max: number): IngredientSnap[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: IngredientSnap[] = [];
  for (const raw of value as unknown[]) {
    const snap = parseSnap(raw);
    if (snap === null) return null; // a basket with a hole in it would miscount the picks
    out.push(snap);
  }
  return out;
}

function asIngredientKind(value: unknown): string | null {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

/** A basket ingredient with its turn and how it got in. A missing `via` (a core-era server) is a pick. */
export function parsePickSnap(value: unknown): PickSnap | null {
  const snap = parseSnap(value);
  if (snap === null) return null;
  const record = value as Record<string, unknown>;
  const via = record["via"];
  return {
    ...snap,
    turn: asIntIn(record["turn"], 1, TOTAL_PICKS),
    kind: asIngredientKind(record["kind"]),
    via: typeof via === "string" && VIAS.includes(via) ? (via as PickVia) : "pick",
    facts: parseFacts(record["facts"]),
  };
}

function parsePickSnaps(value: unknown, max: number): PickSnap[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: PickSnap[] = [];
  for (const raw of value as unknown[]) {
    const snap = parsePickSnap(raw);
    if (snap === null) return null;
    out.push(snap);
  }
  return out;
}

function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parsePair(value: unknown): readonly [IngredientSnap, IngredientSnap] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = parseSnap(value[0]);
  const b = parseSnap(value[1]);
  if (a === null || b === null || a.id === b.id) return null;
  return [a, b];
}

function parseStaple(value: unknown): Staple | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asString(record["id"]);
  const name = asText(record["name"], 120);
  if (id === null || !ID_RE.test(id) || name === null || name.trim() === "") return null;
  return { id, name, image: parseIngredientImage(record["image"]) };
}

function parseStaples(value: unknown): Staple[] {
  if (!Array.isArray(value)) return [];
  const out: Staple[] = [];
  for (const raw of (value as unknown[]).slice(0, 16)) {
    const staple = parseStaple(raw);
    if (staple !== null) out.push(staple);
  }
  return out;
}

function parsePlayer(value: unknown, slot: PlayerSlot, picksPerPlayer: number): CookoutPlayer | null {
  const record = asRecord(value);
  if (record === null || asSlot(record["slot"]) !== slot) return null;
  const nameRaw = record["name"];
  const name = nameRaw === null || nameRaw === undefined ? null : asText(nameRaw, 120);
  if (name === null && (slot === 1 || (nameRaw !== null && nameRaw !== undefined))) return null;
  const pickCount = asIntIn(record["pickCount"], 0, picksPerPlayer);
  if (pickCount === null) return null;
  const picksRaw = record["picks"];
  let picks: PickSnap[] | null = null;
  if (picksRaw !== null && picksRaw !== undefined) {
    picks = parsePickSnaps(picksRaw, picksPerPlayer);
    if (picks === null) return null;
  }
  return {
    slot,
    name,
    pickCount,
    picks,
    chaosUsed: asBoolOrNull(record["chaosUsed"]),
    vetoUsed: asBoolOrNull(record["vetoUsed"]),
  };
}

function parseCurrent(value: unknown, mode: CookoutModeInfo): CookoutTurn | null {
  const record = asRecord(value);
  if (record === null) return null;
  const turn = asIntIn(record["turn"], 1, mode.turns);
  const player = asSlot(record["player"]);
  if (turn === null || player === null) return null;
  // Odd turns are Slot 1's, even turns Slot 2's (spec §1.1): a view that says otherwise is not drawn.
  if ((turn % 2 === 1 ? 1 : 2) !== player) return null;
  const roleRaw = record["role"];
  // A Classic turn names one of the four bank roles; a mode's turn one of the mode's own kinds.
  const role =
    typeof roleRaw !== "string"
      ? null
      : isClassic(mode)
        ? ROLES.includes(roleRaw)
          ? roleRaw
          : null
        : mode.kinds.some((k) => k.id === roleRaw)
          ? roleRaw
          : null;
  const optionsRaw = record["options"];
  let options: readonly [IngredientSnap, IngredientSnap] | null = null;
  let offerIndex: number | null = null;
  let skipsRemaining: number | null = null;
  if (optionsRaw !== null && optionsRaw !== undefined) {
    options = parsePair(optionsRaw);
    offerIndex = asIntIn(record["offerIndex"], 0, 2);
    skipsRemaining = asIntIn(record["skipsRemaining"], 0, 2);
    // Options without their offer index cannot be picked (the move names the offer it answers).
    if (options === null || offerIndex === null) return null;
    if (skipsRemaining === null) skipsRemaining = 2 - offerIndex;
  }
  const shown = options !== null;
  const vetoedRaw = asRecord(record["vetoed"]);
  return {
    turn,
    player,
    role,
    waitingForJoin: record["waitingForJoin"] === true,
    options,
    offerIndex,
    skipsRemaining,
    // The table's twist flags travel with the pair: without it they mean nothing to this viewer.
    chaosPair: shown ? asBoolOrNull(record["chaosPair"]) : null,
    vetoed: shown ? parseSnap(vetoedRaw?.["snap"]) : null,
    canChaos: shown ? asBoolOrNull(record["canChaos"]) : null,
    canLucky: shown ? asBoolOrNull(record["canLucky"]) : null,
    canVeto: asBoolOrNull(record["canVeto"]),
  };
}

function parseReplaced(value: unknown): ReplacedOption[] {
  if (!Array.isArray(value)) return [];
  const out: ReplacedOption[] = [];
  for (const raw of (value as unknown[]).slice(0, 8)) {
    const record = asRecord(raw);
    const offer = asIntIn(record?.["offer"], 0, 2);
    const snap = parseSnap(record?.["snap"]);
    const by = record?.["by"];
    if (offer === null || snap === null || (by !== "veto" && by !== "chaos")) continue;
    out.push({ offer, snap, by });
  }
  return out;
}

function parseHistory(value: unknown, turns: number): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryTurn[] = [];
  for (const raw of (value as unknown[]).slice(0, turns)) {
    const record = asRecord(raw);
    if (record === null) continue;
    const turn = asIntIn(record["turn"], 1, turns);
    const player = asSlot(record["player"]);
    const offersRaw = record["offers"];
    if (turn === null || player === null || !Array.isArray(offersRaw) || offersRaw.length > 3) continue;
    const offers: Array<readonly [IngredientSnap, IngredientSnap]> = [];
    let ok = true;
    for (const pair of offersRaw as unknown[]) {
      const parsed = parsePair(pair);
      if (parsed === null) {
        ok = false;
        break;
      }
      offers.push(parsed);
    }
    if (!ok) continue;
    const choiceRaw = record["choice"];
    const choice = choiceRaw === null || choiceRaw === undefined ? null : parseSnap(choiceRaw);
    const seedRaw = record["seed"];
    out.push({
      turn,
      player,
      offers,
      choice,
      seed: seedRaw === null || seedRaw === undefined ? null : parseSnap(seedRaw),
      replaced: parseReplaced(record["replaced"]),
      chaosOffer: asIntIn(record["chaosOffer"], 0, 2),
      lucky: record["lucky"] === true,
    });
  }
  return out;
}

/** `{id, label}` of a build, or null (Classic, or a malformed one). */
export function parseBuild(value: unknown): BuildRef | null {
  const record = asRecord(value);
  const id = record?.["id"];
  const label = asText(record?.["label"], 60);
  if (typeof id !== "string" || !ID_RE.test(id) || label === null || label.trim() === "") return null;
  return { id, label };
}

/** A mode's turns: even (both players pick equally), 2..10 (the store's turn range). */
function asTurns(value: unknown): number | null {
  const turns = asIntIn(value, 2, TOTAL_PICKS);
  return turns !== null && turns % 2 === 0 ? turns : null;
}

/** The mode's kinds: at most 8, one per id, each with a non-blank label and prompt. */
function parseKinds(value: unknown): ModeKind[] {
  if (!Array.isArray(value)) return [];
  const out: ModeKind[] = [];
  for (const raw of (value as unknown[]).slice(0, 8)) {
    const record = asRecord(raw);
    const id = record?.["id"];
    const label = asText(record?.["label"], 60);
    const prompt = asText(record?.["prompt"], 40);
    if (typeof id !== "string" || !ID_RE.test(id) || label === null || label.trim() === "" || prompt === null || prompt.trim() === "") continue;
    if (out.some((k) => k.id === id)) continue;
    out.push({ id, label, prompt });
  }
  return out;
}

interface ModeHead {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly turns: number;
  readonly picksPerPlayer: number;
}

/** The identity every mode shape shares; null when the id is missing or malformed. Counts that are
 * missing or disagree with each other are not trusted: Classic's are used instead. */
function parseModeHead(record: Record<string, unknown> | null): ModeHead | null {
  const id = record?.["id"];
  if (record === null || typeof id !== "string" || !ID_RE.test(id)) return null;
  const label = asText(record["label"], 60);
  const classic = id === CLASSIC_MODE_ID;
  const fallbackLabel = classic ? CLASSIC_MODE.label : id.replace(/-+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const turns = asTurns(record["turns"]);
  const perPlayer = asIntIn(record["picksPerPlayer"], 1, PICKS_PER_PLAYER);
  const counts =
    turns !== null && perPlayer !== null && perPlayer * 2 === turns
      ? { turns, picksPerPlayer: perPlayer }
      : { turns: TOTAL_PICKS, picksPerPlayer: PICKS_PER_PLAYER };
  return {
    id,
    label: label !== null && label.trim() !== "" ? label : fallbackLabel,
    emoji: asText(record["emoji"], 16) ?? (classic ? CLASSIC_MODE.emoji : ""),
    ...counts,
  };
}

/** The view's `mode` block: Classic when absent or unreadable; an unknown id keeps its own label. */
export function parseModeInfo(value: unknown): CookoutModeInfo {
  const record = asRecord(value);
  const head = parseModeHead(record);
  if (head === null) return CLASSIC_MODE;
  const kinds = parseKinds(record?.["kinds"]);
  const anchor = record?.["anchorKind"];
  return {
    ...head,
    kinds,
    anchorKind: typeof anchor === "string" && kinds.some((k) => k.id === anchor) ? anchor : null,
  };
}

function parseModeRef(value: unknown): ModeRef {
  const head = parseModeHead(asRecord(value));
  return head === null ? CLASSIC_MODE_REF : { id: head.id, label: head.label, emoji: head.emoji };
}

function parseConcept(value: unknown): Concept | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record["id"];
  const title = asText(record["title"], 200);
  const description = asText(record["description"], 1200);
  if (!isConceptId(id) || title === null || title.trim() === "" || description === null) return null;
  // A dish can use the whole basket: 11 when the wildcard cloche was lifted (09a §1.4).
  const picked = parseSnaps(record["pickedIngredients"], MAX_BASKET) ?? [];
  const staplesUsed = parseStaples(record["staplesUsed"]);
  const omitted: OmittedItem[] = [];
  const omittedRaw = record["omitted"];
  if (Array.isArray(omittedRaw)) {
    for (const raw of (omittedRaw as unknown[]).slice(0, MAX_BASKET)) {
      const item = asRecord(raw);
      const ingredient = parseSnap(item?.["ingredient"]);
      const reason = asText(item?.["reason"], 400);
      if (ingredient !== null && reason !== null) omitted.push({ ingredient, reason });
    }
  }
  return {
    id,
    title,
    vibe: asText(record["vibe"], 80) ?? "",
    dishType: asText(record["dishType"], 32) ?? "",
    technique: asText(record["technique"], 32) ?? "",
    description,
    pickedIngredients: picked,
    staplesUsed,
    omitted,
    challengeNote: asText(record["challengeNote"], 300),
    totalMinutes: asIntIn(record["totalMinutes"], 1, 10_000),
    build: parseBuild(record["build"]),
  };
}

/** Up to three dish ideas in a/b/c order, one per id. */
function parseConceptList(value: unknown): Concept[] {
  const data: Concept[] = [];
  if (!Array.isArray(value)) return data;
  const seen = new Set<ConceptId>();
  for (const raw of (value as unknown[]).slice(0, CONCEPT_IDS.length)) {
    const concept = parseConcept(raw);
    if (concept === null || seen.has(concept.id)) continue;
    seen.add(concept.id);
    data.push(concept);
  }
  data.sort((x, y) => x.id.localeCompare(y.id));
  return data;
}

function parseConcepts(value: unknown): ConceptsView {
  const record = asRecord(value);
  if (record === null) return { state: "none", data: null, error: null };
  const state = record["state"];
  const dataRaw = record["data"];
  return {
    state: typeof state === "string" && CONCEPT_STATES.includes(state) ? (state as ConceptsState) : "none",
    data: Array.isArray(dataRaw) ? parseConceptList(dataRaw) : null,
    error: asText(record["error"], 600),
  };
}

function parsePicture(value: unknown): Picture | null {
  const record = asRecord(value);
  if (record === null) return null;
  const thumbUrl = sameOriginMediaUrl(record["thumbUrl"]) ?? sameOriginMediaUrl(record["fullUrl"]);
  const fullUrl = sameOriginMediaUrl(record["fullUrl"]) ?? thumbUrl;
  if (thumbUrl === null || fullUrl === null) return null;
  const attachmentId = record["attachmentId"];
  return {
    attachmentId: typeof attachmentId === "string" || typeof attachmentId === "number" ? String(attachmentId) : "",
    thumbUrl,
    fullUrl,
  };
}

function parsePictureMap(value: unknown): ImagesView["pictures"] {
  const pictures = asRecord(value);
  return {
    a: parsePicture(pictures?.["a"]),
    b: parsePicture(pictures?.["b"]),
    c: parsePicture(pictures?.["c"]),
  };
}

function parseImages(value: unknown): ImagesView {
  const record = asRecord(value);
  const state = record?.["state"];
  return {
    state: typeof state === "string" && IMAGE_STATES.includes(state) ? (state as ImagesState) : "none",
    pictures: parsePictureMap(record?.["pictures"]),
  };
}

const MAX_RECIPE_INGREDIENTS = 24;
const MAX_STEPS = 20;
const MAX_TIPS = 4;

/** A full recipe as the server validated it, or null when it is not a usable recipe. */
export function parseFullRecipe(value: unknown): FullRecipe | null {
  const record = asRecord(value);
  if (record === null) return null;
  const serves = asIntIn(record["serves"], 1, 99) ?? 2;
  const prep = asFinite(record["prepMinutes"]);
  const cook = asFinite(record["cookMinutes"]);
  const prepMinutes = prep !== null && prep >= 0 && prep <= 10_000 ? Math.round(prep) : 0;
  const cookMinutes = cook !== null && cook >= 0 && cook <= 10_000 ? Math.round(cook) : 0;
  const total = asFinite(record["totalMinutes"]);
  const totalMinutes = total !== null && total >= 0 && total <= 20_000 ? Math.round(total) : prepMinutes + cookMinutes;
  const ingredients: RecipeIngredient[] = [];
  const ingredientsRaw = record["ingredients"];
  if (Array.isArray(ingredientsRaw)) {
    for (const raw of (ingredientsRaw as unknown[]).slice(0, MAX_RECIPE_INGREDIENTS)) {
      const item = asRecord(raw);
      const id = asString(item?.["id"]);
      const quantity = asText(item?.["quantity"], 200);
      if (item === null || id === null || !ID_RE.test(id) || quantity === null) continue;
      const name = asText(item["name"], 120);
      ingredients.push({
        id,
        name: name !== null && name.trim() !== "" ? name : null,
        quantity,
        note: asText(item["note"], 300) ?? "",
      });
    }
  }
  const steps: RecipeStep[] = [];
  const stepsRaw = record["steps"];
  if (Array.isArray(stepsRaw)) {
    for (const raw of (stepsRaw as unknown[]).slice(0, MAX_STEPS)) {
      const step = asRecord(raw);
      const text = asText(step?.["text"], 1200);
      if (step === null || text === null || text.trim() === "") continue;
      const minutesRaw = asFinite(step["minutes"]);
      const usesRaw = step["uses"];
      steps.push({
        text,
        minutes: minutesRaw !== null && minutesRaw >= 0 && minutesRaw <= 10_000 ? Math.round(minutesRaw) : null,
        uses: Array.isArray(usesRaw)
          ? (usesRaw as unknown[]).filter((u): u is string => typeof u === "string" && ID_RE.test(u)).slice(0, MAX_RECIPE_INGREDIENTS)
          : [],
      });
    }
  }
  if (ingredients.length === 0 || steps.length === 0) return null;
  const tipsRaw = record["tips"];
  const tips = Array.isArray(tipsRaw)
    ? (tipsRaw as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "" && t.length <= 600).slice(0, MAX_TIPS)
    : [];
  const cookwareRaw = record["cookware"];
  const cookware = Array.isArray(cookwareRaw)
    ? (cookwareRaw as unknown[]).filter((c): c is string => typeof c === "string" && c.trim() !== "" && c.length <= 120).slice(0, 12)
    : [];
  return { serves, prepMinutes, cookMinutes, totalMinutes, ingredients, steps, tips, cookware };
}

function asRating(value: unknown): number | null {
  return asIntIn(value, 1, MAX_RATING);
}

function parseCooked(value: unknown): CookedInfo | null {
  const record = asRecord(value);
  if (record === null) return null;
  const cookedAt = asFinite(record["cookedAt"]);
  if (cookedAt === null) return null;
  const ratings = asRecord(record["ratings"]);
  return {
    cookedAt,
    cookedBy: asText(record["cookedBy"], 120) ?? "",
    ratings: { 1: asRating(ratings?.["1"]), 2: asRating(ratings?.["2"]) },
    photo: parsePicture(record["photo"]),
    photoMessageSeq: asPosInt(record["photoMessageSeq"]),
  };
}

const NO_RECIPE: RecipeSlot = { state: "none", requestedBy: null, bankedAt: null, error: null, data: null, generation: 1, cooked: null };

function parseRecipeSlot(value: unknown, generation: number): RecipeSlot {
  const record = asRecord(value);
  if (record === null) return { ...NO_RECIPE, generation };
  const state = record["state"];
  const parsedState = typeof state === "string" && RECIPE_STATES.includes(state) ? (state as RecipeState) : "none";
  const dataRaw = record["data"];
  const data = dataRaw === null || dataRaw === undefined ? null : parseFullRecipe(dataRaw);
  const bankedAt = asFinite(record["bankedAt"]);
  return {
    // "Banked" with no readable recipe stays banked (the server will not write it again): the pane says
    // it cannot show it rather than offering a retry the server would refuse.
    state: parsedState,
    requestedBy: asText(record["requestedBy"], 120),
    bankedAt,
    error: asText(record["error"], 600),
    data,
    // The slot names its own dish set; T4 actions on it always use THAT generation (09a §1.10).
    generation: asPosInt(record["generation"]) ?? generation,
    // Only a banked recipe can be cooked.
    cooked: parsedState === "banked" ? parseCooked(record["cooked"]) : null,
  };
}

function parseRecipeMap(value: unknown, generation: number): CookoutView["recipes"] {
  const recipes = asRecord(value);
  return {
    a: parseRecipeSlot(recipes?.["a"], generation),
    b: parseRecipeSlot(recipes?.["b"], generation),
    c: parseRecipeSlot(recipes?.["c"], generation),
  };
}

/** A vote pair only when BOTH votes are there: a one-sided vote is never shown to anybody (09a §1.7). */
function parseVotePair(value: unknown): VotePair | null {
  const record = asRecord(value);
  const one = record?.["1"];
  const two = record?.["2"];
  return isConceptId(one) && isConceptId(two) ? { 1: one, 2: two } : null;
}

function parseVoteResult(value: unknown): { readonly votes: VotePair | null; readonly match: ConceptId | null } {
  const record = asRecord(value);
  const votes = parseVotePair(record?.["votes"]);
  // A match is only real when both votes are known and agree on it.
  const match = votes !== null && votes[1] === votes[2] ? votes[1] : null;
  return { votes, match };
}

function parseChip(value: unknown, known: (id: unknown) => boolean): SetupChip | null {
  const record = asRecord(value);
  const id = record?.["id"];
  const label = asText(record?.["label"], 60);
  if (!known(id) || label === null || label.trim() === "") return null;
  return { id: id as string, label, emoji: asText(record?.["emoji"], 16) ?? "" };
}

const NO_SETUP: CookoutSetup = {
  style: null,
  styleSpun: false,
  challenge: null,
  wildcard: false,
  stars: false,
  fridgeRaid: false,
  encore: null,
};

function parseSetup(value: unknown): CookoutSetup {
  const record = asRecord(value);
  if (record === null) return NO_SETUP;
  const style = parseChip(record["style"], isStyleId);
  const encoreRaw = asRecord(record["encore"]);
  const kind = encoreRaw?.["kind"];
  const fromTitle = asText(encoreRaw?.["fromTitle"], 200);
  return {
    style,
    styleSpun: style !== null && record["styleSpun"] === true,
    challenge: parseChip(record["challenge"], isChallengeId),
    wildcard: record["wildcard"] === true,
    stars: record["stars"] === true,
    fridgeRaid: record["fridgeRaid"] === true,
    encore:
      kind === "leftovers" || kind === "remix"
        ? { kind, fromSeq: asPosInt(encoreRaw?.["fromSeq"]), fromTitle: fromTitle !== null && fromTitle.trim() !== "" ? fromTitle : null }
        : null,
  };
}

function parseWildcard(value: unknown): WildcardView {
  const record = asRecord(value);
  const state = record?.["state"];
  const parsed = typeof state === "string" && WILDCARD_STATES.includes(state) ? (state as WildcardState) : "off";
  // The surprise ingredient exists only once the lid is lifted.
  return { state: parsed, ingredient: parsed === "lifted" ? parseSnap(record?.["ingredient"]) : null };
}

function asIngredientId(value: unknown): string | null {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

function parseStars(value: unknown): StarsView {
  const record = asRecord(value);
  const revealed = record?.["revealed"] === true;
  return {
    enabled: record?.["enabled"] === true,
    mine: asIngredientId(record?.["mine"]),
    partnerChosen: record?.["partnerChosen"] === true,
    revealed,
    // Second lock (both modes): a partner's star is a secret until the reveal.
    partner: revealed ? asIngredientId(record?.["partner"]) : null,
  };
}

function parseVote(value: unknown): VoteView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const you = record["you"];
  const revealed = record["revealed"] === true;
  // Second lock (both modes): the votes exist for this viewer only once both are in.
  const result = revealed ? parseVoteResult(record) : { votes: null, match: null };
  return {
    you: isConceptId(you) ? you : null,
    partnerVoted: record["partnerVoted"] === true,
    revealed: revealed && result.votes !== null,
    votes: result.votes,
    match: result.match,
  };
}

function parseSwap(value: unknown): SwapView {
  const record = asRecord(value);
  const state = record?.["state"];
  const parsed = typeof state === "string" && SWAP_STATES.includes(state) ? (state as SwapState) : "none";
  const pairRaw = record?.["pair"];
  const inRaw = record?.["in"];
  return {
    state: parsed,
    available: parsed === "none" && record?.["available"] === true,
    by: parsed === "none" ? null : asSlot(record?.["by"]),
    out: parsed === "none" ? null : parseSnap(record?.["out"]),
    pair: parsed === "proposed" && pairRaw !== null && pairRaw !== undefined ? parsePair(pairRaw) : null,
    in: parsed === "done" && inRaw !== null && inRaw !== undefined ? parseSnap(inRaw) : null,
  };
}

function parseGenerations(value: unknown, current: number): GenerationView[] {
  if (!Array.isArray(value)) return [];
  const out: GenerationView[] = [];
  for (const raw of (value as unknown[]).slice(0, 4)) {
    const record = asRecord(raw);
    const generation = asPosInt(record?.["generation"]);
    // Only superseded sets: the dishes on the table are never "earlier".
    if (record === null || generation === null || generation >= current || out.some((g) => g.generation === generation)) continue;
    out.push({
      generation,
      basket: parseSnaps(record["basket"], MAX_BASKET) ?? [],
      concepts: parseConceptList(record["concepts"]),
      pictures: parsePictureMap(record["pictures"]),
      vote: parseVoteResult(record["vote"]),
      recipes: parseRecipeMap(record["recipes"], generation),
    });
  }
  out.sort((x, y) => x.generation - y.generation);
  return out;
}

/** A round view from the wire, or null when anything load-bearing about it is off. */
export function parseCookoutView(value: unknown): CookoutView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const seq = asPosInt(record["seq"]);
  const rev = asPosInt(record["rev"]);
  const state = record["state"];
  if (seq === null || rev === null || typeof state !== "string" || !STATES.includes(state)) return null;
  const mode = parseModeInfo(record["mode"]);
  const playersRaw = record["players"];
  if (!Array.isArray(playersRaw) || playersRaw.length !== 2) return null;
  const p1 = parsePlayer(playersRaw[0], 1, mode.picksPerPlayer);
  const p2 = parsePlayer(playersRaw[1], 2, mode.picksPerPlayer);
  if (p1 === null || p2 === null) return null;
  const youRecord = asRecord(record["you"]);
  const youSlot = youRecord === null ? null : asSlot(youRecord["slot"]);
  const currentRaw = record["current"];
  const current = currentRaw === null || currentRaw === undefined ? null : parseCurrent(currentRaw, mode);
  const s = state as CookoutState;
  // A round being picked has a turn; a turn that would not parse cannot be played (not drawn at all).
  if (s === "picking" && current === null) return null;
  const blind = record["blind"] === true;
  const revealed = record["revealed"] === true;
  const generation = asPosInt(record["generation"]) ?? 1;
  let players: readonly [CookoutPlayer, CookoutPlayer] = [p1, p2];
  let shownCurrent = s === "picking" ? current : null;
  let basket = parsePickSnaps(record["basket"], MAX_BASKET);
  const hidden = blind && !(s === "finished" && revealed);
  if (hidden) {
    // The server redacts a Blind round (spec §1.3); this is the second lock. Whatever a buggy server
    // sent, only the viewer's own picks and — on their own turn — their own pair are kept, so the
    // partner's secrets can never reach the DOM. The twists ride the same lock: the partner's chaos
    // token, the whole basket, and every flag of a table this viewer cannot see.
    const hide = (p: CookoutPlayer): CookoutPlayer => ({ ...p, picks: null, chaosUsed: null });
    players = [youSlot === 1 ? p1 : hide(p1), youSlot === 2 ? p2 : hide(p2)];
    basket = null;
    if (shownCurrent !== null && youSlot !== shownCurrent.player) {
      shownCurrent = {
        ...shownCurrent,
        role: null,
        options: null,
        offerIndex: null,
        skipsRemaining: null,
        chaosPair: null,
        vetoed: null,
        canChaos: null,
        canLucky: null,
      };
    }
    // Veto is an Open-mode twist: nobody sweeps a table they cannot see.
    if (shownCurrent !== null) shownCurrent = { ...shownCurrent, canVeto: null };
  }
  const swap = parseSwap(record["swap"]);
  const concepts = parseConcepts(record["concepts"]);
  return {
    seq,
    state: s,
    mode,
    rev,
    blind,
    revealed,
    players,
    you:
      youSlot === null
        ? null
        : { slot: youSlot, chaosUsed: youRecord?.["chaosUsed"] === true, vetoUsed: youRecord?.["vetoUsed"] === true },
    current: shownCurrent,
    // Blind: only the viewer's own turns, ever — even after the reveal (spec §1.3); the second lock again.
    history: blind
      ? parseHistory(record["history"], mode.turns).filter((t) => youSlot !== null && t.player === youSlot)
      : parseHistory(record["history"], mode.turns),
    staples: parseStaples(record["staples"]),
    concepts,
    images: parseImages(record["images"]),
    recipes: parseRecipeMap(record["recipes"], generation),
    setup: parseSetup(record["setup"]),
    generation,
    starters: parsePickSnaps(record["starters"], 2) ?? [],
    basket,
    gate: { waitingFor: s === "finished" && concepts.state === "none" ? parseWaiting(asRecord(record["gate"])?.["waitingFor"]) : [] },
    wildcard: parseWildcard(record["wildcard"]),
    // Stars reveal only on a finished round (an abandoned one never reveals them).
    stars: s === "finished" ? parseStars(record["stars"]) : { ...parseStars(record["stars"]), revealed: false, partner: null },
    // The dinner vote exists only over ready dishes.
    vote: concepts.state === "ready" ? parseVote(record["vote"]) : null,
    swap,
    generations: parseGenerations(record["generations"], generation),
  };
}

// -- Calls ---------------------------------------------------------------------------------------------

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function postInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const CONFLICTS: readonly string[] = [
  "bad_state",
  "not_your_turn",
  "not_player",
  "skip_exhausted",
  "exhausted",
  "token_used",
  "recipe_pending",
];

async function toOutcome(response: Response): Promise<CookoutOutcome> {
  if (response.ok) {
    const view = parseCookoutView(await readJson(response));
    return view === null ? { ok: false, kind: "unavailable" } : { ok: true, view };
  }
  if (response.status === 404) return { ok: false, kind: "not_found" };
  if (response.status === 409) {
    const error = asRecord(await readJson(response))?.["error"];
    return { ok: false, kind: typeof error === "string" && CONFLICTS.includes(error) ? (error as CookoutFailure) : "bad_state" };
  }
  if (response.status === 422) return { ok: false, kind: "invalid" };
  if (response.status === 503) return { ok: false, kind: "game_unavailable" };
  return { ok: false, kind: "unavailable" };
}

async function call(session: ServerSession, path: string, init: RequestInit): Promise<CookoutOutcome> {
  let response: Response;
  try {
    response = await serverFetch(path, init, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  return toOutcome(response);
}

function seqPath(seq: number, suffix = ""): string {
  return `/cookout/${encodeURIComponent(String(seq))}${suffix}`;
}

/** An encore's source: a concept of a finished round, and the starters chosen from it (09a §1.3). */
export interface EncoreInput {
  readonly fromSeq: number;
  readonly generation: number;
  readonly conceptId: ConceptId;
  readonly kind: EncoreKind;
  readonly seedIds: readonly string[];
}

/** The start sheet's choices. Every twist is optional; an absent one is "off". */
export interface CreateCookoutInput {
  readonly clientId: string;
  readonly sender: string;
  readonly deviceId: string;
  readonly blind: boolean;
  /** The game mode; absent = Classic (a Classic start sends no `mode` at all: the core request). */
  readonly mode?: string;
  readonly style?: StyleId | "spin" | null;
  readonly challenge?: ChallengeId | null;
  readonly wildcard?: boolean;
  readonly stars?: boolean;
  readonly fridgeSeedId?: string | null;
  readonly encore?: EncoreInput | null;
}

/** `POST /cookout` — starts a round (abandons an unfinished one). Idempotent on `clientId`. */
export async function createCookout(session: ServerSession, input: CreateCookoutInput): Promise<CreateCookoutResult> {
  let response: Response;
  try {
    response = await serverFetch("/cookout", postInit(input), session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (response.status === 201 || response.status === 200) {
    const message = asRecord(await readJson(response))?.["message"];
    if (asRecord(message) === null) return { ok: false, kind: "unavailable" };
    return { ok: true, message: message as unknown as Message };
  }
  // A server that predates the game has no such route.
  if (response.status === 404 || response.status === 405) return { ok: false, kind: "unsupported" };
  // A twist the server will not take (the chef went away, an encore's source changed).
  if (response.status === 422) return { ok: false, kind: "invalid" };
  if (response.status === 503) return { ok: false, kind: "game_unavailable" };
  return { ok: false, kind: "unavailable" };
}

/** `GET /cookout/{seq}?as=<viewer>` — the round as THIS viewer may see it. */
export function getCookout(session: ServerSession, seq: number, viewer: string): Promise<CookoutOutcome> {
  return call(session, `${seqPath(seq)}?as=${encodeURIComponent(viewer)}`, { method: "GET" });
}

/** `POST /cookout/{seq}/join` — binds Slot 2. */
export function joinCookout(session: ServerSession, seq: number, input: { readonly sender: string }): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/join"), postInit(input));
}

export interface MoveInput {
  readonly sender: string;
  /** One id per intended move: a resend of the same move (a lost answer) is answered, not repeated. */
  readonly moveId: string;
  readonly turn: number;
  readonly offer: number;
}

/** A skip names the pair it saw: a veto or the chaos shelf changes the pair without changing `offer`. */
export interface SkipInput extends MoveInput {
  readonly optionIds: readonly [string, string];
}

/** `POST /cookout/{seq}/skip` — deal a fresh pair (at most twice a turn); a pair that changed first is `409 bad_state`. */
export function skipCookout(session: ServerSession, seq: number, input: SkipInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/skip"), postInit(input));
}

/** `POST /cookout/{seq}/pick`. */
export function pickCookout(
  session: ServerSession,
  seq: number,
  input: MoveInput & { readonly ingredientId: string },
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/pick"), postInit(input));
}

/** `POST /cookout/{seq}/abandon` — End game. */
export function abandonCookout(session: ServerSession, seq: number, input: { readonly sender: string }): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/abandon"), postInit(input));
}

/** The chef-stage actions on the dishes on the table name the dish set they were rendered from (09a
 * §1.10): a tap that lands after a rescue swap is refused instead of acting on a different dish. */
export interface GenerationInput {
  readonly sender: string;
  readonly generation: number;
}

/** `POST /cookout/{seq}/concepts/retry`. */
export function retryCookoutConcepts(session: ServerSession, seq: number, input: GenerationInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/concepts/retry"), postInit(input));
}

/** `POST /cookout/{seq}/pictures/retry`. */
export function retryCookoutPictures(session: ServerSession, seq: number, input: GenerationInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/pictures/retry"), postInit(input));
}

/** `POST /cookout/{seq}/concepts/{id}/bank` — write the full recipe and save it to the Recipe book. */
export function bankCookoutConcept(
  session: ServerSession,
  seq: number,
  conceptId: ConceptId,
  input: GenerationInput & { readonly moveId: string },
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, `/concepts/${conceptId}/bank`), postInit(input));
}

/** `POST /cookout/{seq}/concepts/{id}/recipe/retry`. */
export function retryCookoutRecipe(
  session: ServerSession,
  seq: number,
  conceptId: ConceptId,
  input: GenerationInput,
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, `/concepts/${conceptId}/recipe/retry`), postInit(input));
}

// -- The twists' moves (09a §4.2) ----------------------------------------------------------------------

/** Lucky dip and chaos shelf name the pair they saw: a table that changed first makes them stale. */
export interface TwistMoveInput extends MoveInput {
  readonly optionIds: readonly [string, string];
}

export interface VetoInput extends MoveInput {
  readonly ingredientId: string;
}

/** `POST /cookout/{seq}/lucky` — the kitchen coin picks one of the two for the active player. */
export function luckyCookout(session: ServerSession, seq: number, input: TwistMoveInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/lucky"), postInit(input));
}

/** `POST /cookout/{seq}/chaos` — swap the pair for two exotic ones (once per player). */
export function chaosCookout(session: ServerSession, seq: number, input: TwistMoveInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/chaos"), postInit(input));
}

/** `POST /cookout/{seq}/veto` — the waiting partner sweeps one option off the table (Open, once). */
export function vetoCookout(session: ServerSession, seq: number, input: VetoInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/veto"), postInit(input));
}

/** `POST /cookout/{seq}/star` — set or change the caller's secret star. */
export function starCookout(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string; readonly ingredientId: string },
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/star"), postInit(input));
}

/** `POST /cookout/{seq}/wildcard` — lift the cloche (or decline it). */
export function wildcardCookout(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string; readonly moveId: string; readonly lift: boolean },
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/wildcard"), postInit(input));
}

export interface VoteInput {
  readonly sender: string;
  readonly generation: number;
  readonly conceptId: ConceptId;
}

/** `POST /cookout/{seq}/vote` — "I'd eat this tonight". */
export function voteCookout(session: ServerSession, seq: number, input: VoteInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/vote"), postInit(input));
}

export interface SwapMoveInput {
  readonly sender: string;
  readonly moveId: string;
  readonly ingredientId: string;
}

/** `POST /cookout/{seq}/swap/propose` — send one basket ingredient back. */
export function proposeSwap(session: ServerSession, seq: number, input: SwapMoveInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/swap/propose"), postInit(input));
}

/** `POST /cookout/{seq}/swap/choose` — the partner picks the replacement (that is the consent). */
export function chooseSwap(session: ServerSession, seq: number, input: SwapMoveInput): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/swap/choose"), postInit(input));
}

/** `POST /cookout/{seq}/swap/cancel` — keep these dishes. */
export function cancelSwap(session: ServerSession, seq: number, input: { readonly sender: string }): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/swap/cancel"), postInit(input));
}

function recipePath(seq: number, generation: number, conceptId: ConceptId, action: string): string {
  return seqPath(seq, `/recipes/${encodeURIComponent(String(generation))}/${conceptId}/${action}`);
}

/** `POST /cookout/{seq}/recipes/{generation}/{conceptId}/cooked` — "We cooked it!" (or unmark). */
export function markCooked(
  session: ServerSession,
  seq: number,
  generation: number,
  conceptId: ConceptId,
  input: { readonly sender: string; readonly cooked: boolean },
): Promise<CookoutOutcome> {
  return call(session, recipePath(seq, generation, conceptId, "cooked"), postInit(input));
}

/** `POST …/rating` — the caller's own hearts (null clears them). */
export function rateRecipe(
  session: ServerSession,
  seq: number,
  generation: number,
  conceptId: ConceptId,
  input: { readonly sender: string; readonly rating: number | null },
): Promise<CookoutOutcome> {
  return call(session, recipePath(seq, generation, conceptId, "rating"), postInit(input));
}

export interface LinkPhotoInput {
  readonly sender: string;
  /** Both null = unlink. */
  readonly messageSeq: number | null;
  readonly attachmentId: string | null;
}

/** `POST …/photo` — link the exact mini-chat photo the chooser showed (or unlink). */
export function linkRecipePhoto(
  session: ServerSession,
  seq: number,
  generation: number,
  conceptId: ConceptId,
  input: LinkPhotoInput,
): Promise<CookoutOutcome> {
  return call(session, recipePath(seq, generation, conceptId, "photo"), postInit(input));
}

// -- The twists' reads ---------------------------------------------------------------------------------

export interface CatalogueEntry {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly blurb: string;
}

export interface CookoutOptions {
  readonly styles: readonly CatalogueEntry[];
  readonly challenges: readonly CatalogueEntry[];
  /** The chef (and so style, challenge, cloche and stars) is available on this server. */
  readonly chef: boolean;
  readonly pictures: boolean;
  /** The switched-on game modes, Classic first (Classic alone from a server without modes). */
  readonly modes: readonly ModeOption[];
}

function parseIdList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of (value as unknown[]).slice(0, max)) {
    if (typeof raw === "string" && ID_RE.test(raw) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

function parseModeOption(value: unknown): ModeOption | null {
  const record = asRecord(value);
  const head = parseModeHead(record);
  if (record === null || head === null) return null;
  const introRaw = record["intro"];
  const intro = Array.isArray(introRaw)
    ? (introRaw as unknown[]).filter((line): line is string => typeof line === "string" && line.trim() !== "" && line.length <= 200).slice(0, 3)
    : [];
  const twistsRaw = record["twists"];
  const fridgeRaw = record["fridgeKinds"];
  return {
    ...head,
    blurb: asText(record["blurb"], 200) ?? "",
    intro,
    // A mode that does not list its twists offers none (never more than the server allows); Classic, from a
    // server that predates modes, offers all twelve as it always has.
    twists: Array.isArray(twistsRaw)
      ? parseIdList(twistsRaw, ALL_TWISTS.length * 2).filter((t) => ALL_TWISTS.includes(t))
      : head.id === CLASSIC_MODE_ID
        ? ALL_TWISTS
        : [],
    fridgeKinds: Array.isArray(fridgeRaw) ? parseIdList(fridgeRaw, 8) : null,
  };
}

/** The listed modes, one per id, Classic always present and first (09c §5.4). */
export function parseModeOptions(value: unknown): ModeOption[] {
  const out: ModeOption[] = [];
  if (Array.isArray(value)) {
    for (const raw of (value as unknown[]).slice(0, 16)) {
      const option = parseModeOption(raw);
      if (option !== null && !out.some((o) => o.id === option.id)) out.push(option);
    }
  }
  const classic = out.find((o) => o.id === CLASSIC_MODE_ID) ?? CLASSIC_OPTION;
  return [classic, ...out.filter((o) => o.id !== CLASSIC_MODE_ID)];
}

function parseCatalogue(value: unknown, known: (id: unknown) => boolean): CatalogueEntry[] {
  if (!Array.isArray(value)) return [];
  const out: CatalogueEntry[] = [];
  for (const raw of (value as unknown[]).slice(0, 32)) {
    const record = asRecord(raw);
    const id = record?.["id"];
    const label = asText(record?.["label"], 60);
    if (!known(id) || label === null || label.trim() === "" || out.some((e) => e.id === id)) continue;
    out.push({ id: id as string, label, emoji: asText(record?.["emoji"], 16) ?? "", blurb: asText(record?.["blurb"], 200) ?? "" });
  }
  return out;
}

export function parseCookoutOptions(value: unknown): CookoutOptions | null {
  const record = asRecord(value);
  if (record === null) return null;
  return {
    styles: parseCatalogue(record["styles"], isStyleId),
    challenges: parseCatalogue(record["challenges"], isChallengeId),
    chef: record["chef"] === true,
    pictures: record["pictures"] === true,
    modes: parseModeOptions(record["modes"]),
  };
}

/** `GET /cookout/options` — the style and challenge catalogues and what this server's chef can do. A
 * server without the route (or a failed read) answers null: the sheet then offers no chef-only twist. */
export async function getCookoutOptions(session: ServerSession): Promise<CookoutOptions | null> {
  let response: Response;
  try {
    response = await serverFetch("/cookout/options", { method: "GET" }, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return null;
  }
  if (!response.ok) return null;
  return parseCookoutOptions(await readJson(response));
}

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 40;

export type SearchResult =
  | { readonly ok: true; readonly ingredients: readonly IngredientSnap[] }
  | { readonly ok: false; readonly kind: "invalid" | "game_unavailable" | "unavailable" };

/** `GET /cookout/ingredients?q=&mode=` — the fridge raid's bank search (≤ 20 bank entries). A non-Classic
 * `mode` searches only that mode's fridge kinds (09c §5.4); Classic sends no `mode` (the whole bank). */
export async function searchIngredients(session: ServerSession, q: string, mode: string | null = null): Promise<SearchResult> {
  const query = q.trim();
  if (query.length < SEARCH_MIN || query.length > SEARCH_MAX) return { ok: false, kind: "invalid" };
  const modeParam = mode === null || mode === CLASSIC_MODE_ID ? "" : `&mode=${encodeURIComponent(mode)}`;
  let response: Response;
  try {
    response = await serverFetch(`/cookout/ingredients?q=${encodeURIComponent(query)}${modeParam}`, { method: "GET" }, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (response.status === 422) return { ok: false, kind: "invalid" };
  if (response.status === 503) return { ok: false, kind: "game_unavailable" };
  if (!response.ok) return { ok: false, kind: "unavailable" };
  const list = asRecord(await readJson(response))?.["ingredients"];
  if (!Array.isArray(list)) return { ok: false, kind: "unavailable" };
  const ingredients: IngredientSnap[] = [];
  for (const raw of (list as unknown[]).slice(0, 20)) {
    const snap = parseSnap(raw);
    if (snap !== null && !ingredients.some((i) => i.id === snap.id)) ingredients.push(snap);
  }
  return { ok: true, ingredients };
}

/** A mini-chat photo that can be linked as "Our plate": one per message, its lowest-ordinal ready photo
 * at the time of the read. The link posts back exactly this `attachmentId`. */
export interface RoundPhoto {
  readonly messageSeq: number;
  readonly attachmentId: string;
  readonly sender: string;
  readonly createdAt: number;
  readonly picture: Picture;
}

export type PhotosResult =
  | { readonly ok: true; readonly photos: readonly RoundPhoto[] }
  | { readonly ok: false; readonly kind: CookoutFailure };

export function parseRoundPhotos(value: unknown): RoundPhoto[] | null {
  const list = asRecord(value)?.["photos"];
  if (!Array.isArray(list)) return null;
  const out: RoundPhoto[] = [];
  for (const raw of (list as unknown[]).slice(0, 50)) {
    const record = asRecord(raw);
    const messageSeq = asPosInt(record?.["messageSeq"]);
    const attachmentId = asText(record?.["attachmentId"], 128);
    const picture = parsePicture(record?.["picture"]);
    // One entry per message: a second one for the same message is not offered.
    if (messageSeq === null || attachmentId === null || attachmentId === "" || picture === null) continue;
    if (out.some((p) => p.messageSeq === messageSeq)) continue;
    out.push({
      messageSeq,
      attachmentId,
      sender: asText(record?.["sender"], 120) ?? "",
      createdAt: asFinite(record?.["createdAt"]) ?? 0,
      picture,
    });
  }
  return out;
}

/** `GET /cookout/{seq}/photos?as=<viewer>` — the round's linkable mini-chat photos, newest first. */
export async function getRoundPhotos(session: ServerSession, seq: number, viewer: string): Promise<PhotosResult> {
  let response: Response;
  try {
    response = await serverFetch(`${seqPath(seq, "/photos")}?as=${encodeURIComponent(viewer)}`, { method: "GET" }, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (response.ok) {
    const photos = parseRoundPhotos(await readJson(response));
    return photos === null ? { ok: false, kind: "unavailable" } : { ok: true, photos };
  }
  if (response.status === 404) return { ok: false, kind: "not_found" };
  if (response.status === 409) return { ok: false, kind: "not_player" };
  return { ok: false, kind: "unavailable" };
}

// -- The Recipe book -----------------------------------------------------------------------------------

export interface BookRecipe {
  readonly seq: number;
  readonly conceptId: ConceptId;
  readonly title: string;
  readonly vibe: string;
  readonly description: string;
  readonly serves: number;
  readonly prepMinutes: number;
  readonly cookMinutes: number;
  readonly totalMinutes: number;
  readonly bankedAt: number | null;
  readonly requestedBy: string | null;
  readonly picture: Picture | null;
  /** The dish set the recipe came from (1 unless the round had a rescue swap). */
  readonly generation: number;
  readonly cooked: BookCooked | null;
  /** Both players' dinner votes matched on this dish. */
  readonly dinnerPick: boolean;
  readonly style: SetupChip | null;
  readonly challenge: SetupChip | null;
  /** The basket items the dish used (Remix starters) and the ones it left out (Leftovers starters), each
   * with its pick kind in a mode round (null for Classic, or from a server that does not send it). */
  readonly ingredients: readonly KindedSnap[];
  readonly leftovers: readonly KindedSnap[];
  /** The game mode the dish came from (Classic when the server sent none). */
  readonly mode: ModeRef;
  readonly build: BuildRef | null;
}

export interface BookCooked {
  readonly cookedAt: number;
  readonly ratings: ReadonlyArray<{ readonly name: string; readonly rating: number | null }>;
  readonly photo: Picture | null;
}

function parseBookCooked(value: unknown): BookCooked | null {
  const record = asRecord(value);
  const cookedAt = asFinite(record?.["cookedAt"]);
  if (record === null || cookedAt === null) return null;
  const ratings: Array<{ readonly name: string; readonly rating: number | null }> = [];
  const raw = record["ratings"];
  if (Array.isArray(raw)) {
    for (const item of (raw as unknown[]).slice(0, 2)) {
      const entry = asRecord(item);
      const name = asText(entry?.["name"], 120);
      if (entry === null || name === null) continue;
      ratings.push({ name, rating: asRating(entry["rating"]) });
    }
  }
  return { cookedAt, ratings, photo: parsePicture(record["photo"]) };
}

/** A snap with the pick kind it filled (a Recipe book starter): null for Classic or when not sent. */
export interface KindedSnap extends IngredientSnap {
  readonly kind: string | null;
}

/** Bank-listed snaps, skipping any that will not parse (a list for buttons, not a basket count). */
function parseSnapList(value: unknown, max: number): KindedSnap[] {
  if (!Array.isArray(value)) return [];
  const out: KindedSnap[] = [];
  for (const raw of (value as unknown[]).slice(0, max)) {
    const snap = parseSnap(raw);
    if (snap !== null && !out.some((s) => s.id === snap.id)) out.push({ ...snap, kind: asIngredientKind((raw as Record<string, unknown>)["kind"]) });
  }
  return out;
}

export type BookResult =
  | { readonly ok: true; readonly recipes: readonly BookRecipe[] }
  | { readonly ok: false; readonly kind: "unavailable" };

export function parseRecipeBook(value: unknown): readonly BookRecipe[] | null {
  const recipes = asRecord(value)?.["recipes"];
  if (!Array.isArray(recipes)) return null;
  const out: BookRecipe[] = [];
  for (const raw of (recipes as unknown[]).slice(0, 1000)) {
    const record = asRecord(raw);
    if (record === null) continue;
    const seq = asPosInt(record["seq"]);
    const conceptId = record["conceptId"];
    const title = asText(record["title"], 200);
    if (seq === null || !isConceptId(conceptId) || title === null || title.trim() === "") continue;
    const prep = asFinite(record["prepMinutes"]);
    const cook = asFinite(record["cookMinutes"]);
    const total = asFinite(record["totalMinutes"]);
    const prepMinutes = prep !== null && prep >= 0 ? Math.round(prep) : 0;
    const cookMinutes = cook !== null && cook >= 0 ? Math.round(cook) : 0;
    out.push({
      seq,
      conceptId,
      title,
      vibe: asText(record["vibe"], 80) ?? "",
      description: asText(record["description"], 1200) ?? "",
      serves: asIntIn(record["serves"], 1, 99) ?? 2,
      prepMinutes,
      cookMinutes,
      totalMinutes: total !== null && total >= 0 ? Math.round(total) : prepMinutes + cookMinutes,
      bankedAt: asFinite(record["bankedAt"]),
      requestedBy: asText(record["requestedBy"], 120),
      picture: parsePicture(record["picture"]),
      generation: asPosInt(record["generation"]) ?? 1,
      cooked: parseBookCooked(record["cooked"]),
      dinnerPick: record["dinnerPick"] === true,
      style: parseChip(record["style"], isStyleId),
      challenge: parseChip(record["challenge"], isChallengeId),
      ingredients: parseSnapList(record["ingredients"], MAX_BASKET),
      leftovers: parseSnapList(record["leftovers"], MAX_BASKET),
      mode: parseModeRef(record["mode"]),
      build: parseBuild(record["build"]),
    });
  }
  return out;
}

/** `GET /cookout/bank` — banked recipes, newest first. */
export async function getRecipeBook(session: ServerSession): Promise<BookResult> {
  let response: Response;
  try {
    response = await serverFetch("/cookout/bank", { method: "GET" }, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (!response.ok) return { ok: false, kind: "unavailable" };
  const recipes = parseRecipeBook(await readJson(response));
  return recipes === null ? { ok: false, kind: "unavailable" } : { ok: true, recipes };
}

// -- Small shared helpers for the pane, the card and the book ------------------------------------------

/** "35 min", "1 hr", "1 hr 20 min". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} hr` : `${h} hr ${rest} min`;
}

/** The basket of a round as this viewer may see it: the server's effective basket when it sent one
 * (starters, the cloche's wildcard and a rescue swap included), else everybody's known picks in pick
 * order. */
export function allPicks(view: CookoutView): PickSnap[] {
  if (view.basket !== null) return [...view.basket];
  const out: PickSnap[] = [];
  const [one, two] = view.players;
  const a = one.picks ?? [];
  const b = two.picks ?? [];
  for (let i = 0; i < view.mode.picksPerPlayer; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x !== undefined) out.push(x);
    if (y !== undefined) out.push(y);
  }
  return out;
}
