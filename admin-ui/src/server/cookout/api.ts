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

export const CONCEPT_IDS: readonly ConceptId[] = ["a", "b", "c"];
/** Ten picks in a round: five each. */
export const TOTAL_PICKS = 10;
export const PICKS_PER_PLAYER = 5;

const STATES: readonly string[] = ["picking", "finished", "abandoned"];
const CONCEPT_STATES: readonly string[] = ["none", "pending", "ready", "failed", "unavailable"];
const IMAGE_STATES: readonly string[] = ["none", "pending", "done", "failed"];
const RECIPE_STATES: readonly string[] = ["none", "pending", "banked", "failed", "unavailable"];
const ROLES: readonly string[] = ["base", "protein", "produce", "accent"];

/** What a `Message` carries about its round: enough to notice it moved and draw the card's status
 * line — never an ingredient, an option or a recipe (spec §1.3 "wire & cache hygiene"). */
export interface CookoutSummary {
  readonly state: CookoutState;
  readonly blind: boolean;
  readonly pickedCount: number;
  readonly concepts: ConceptsState;
  readonly bankedCount: number;
  readonly rev: number;
}

/** One ingredient as the round froze it when it was offered (spec §2.3 rule 5). */
export interface IngredientSnap {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly emoji: string;
  readonly blurb: string;
}

export interface Staple {
  readonly id: string;
  readonly name: string;
}

export interface CookoutPlayer {
  readonly slot: PlayerSlot;
  /** Null for Slot 2 until somebody presses Join. */
  readonly name: string | null;
  readonly pickCount: number;
  /** Null for the partner's picks in a Blind round that has not been revealed. */
  readonly picks: readonly IngredientSnap[] | null;
}

export interface CookoutTurn {
  readonly turn: number;
  readonly player: PlayerSlot;
  /** The four fields below are null for anybody but the active player in a Blind round. */
  readonly role: CookoutRole | null;
  readonly waitingForJoin: boolean;
  readonly options: readonly [IngredientSnap, IngredientSnap] | null;
  readonly offerIndex: number | null;
  readonly skipsRemaining: number | null;
}

export interface HistoryTurn {
  readonly turn: number;
  readonly player: PlayerSlot;
  readonly offers: ReadonlyArray<readonly [IngredientSnap, IngredientSnap]>;
  readonly choice: IngredientSnap | null;
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
}

export interface RecipeSlot {
  readonly state: RecipeState;
  readonly requestedBy: string | null;
  readonly bankedAt: number | null;
  readonly error: string | null;
  readonly data: FullRecipe | null;
}

export interface CookoutView {
  readonly seq: number;
  readonly state: CookoutState;
  readonly rev: number;
  readonly blind: boolean;
  readonly revealed: boolean;
  readonly players: readonly [CookoutPlayer, CookoutPlayer];
  readonly you: { readonly slot: PlayerSlot } | null;
  readonly current: CookoutTurn | null;
  readonly history: readonly HistoryTurn[];
  readonly staples: readonly Staple[];
  readonly concepts: ConceptsView;
  readonly images: ImagesView;
  readonly recipes: { readonly a: RecipeSlot; readonly b: RecipeSlot; readonly c: RecipeSlot };
}

export type CookoutFailure =
  | "not_found"
  | "bad_state"
  | "not_your_turn"
  | "not_player"
  | "skip_exhausted"
  | "exhausted"
  | "invalid"
  | "game_unavailable"
  | "unavailable";

export type CookoutOutcome =
  | { readonly ok: true; readonly view: CookoutView }
  | { readonly ok: false; readonly kind: CookoutFailure };

export type CreateCookoutResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly kind: "unsupported" | "game_unavailable" | "unavailable" };

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
  return {
    state: state as CookoutState,
    blind: record["blind"] === true,
    pickedCount: asIntIn(record["pickedCount"], 0, TOTAL_PICKS) ?? 0,
    concepts: typeof concepts === "string" && CONCEPT_STATES.includes(concepts) ? (concepts as ConceptsState) : "none",
    bankedCount: asIntIn(record["bankedCount"], 0, CONCEPT_IDS.length) ?? 0,
    rev,
  };
}

// -- View pieces ---------------------------------------------------------------------------------------

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
  return { id, name };
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

function parsePlayer(value: unknown, slot: PlayerSlot): CookoutPlayer | null {
  const record = asRecord(value);
  if (record === null || asSlot(record["slot"]) !== slot) return null;
  const nameRaw = record["name"];
  const name = nameRaw === null || nameRaw === undefined ? null : asText(nameRaw, 120);
  if (name === null && (slot === 1 || (nameRaw !== null && nameRaw !== undefined))) return null;
  const pickCount = asIntIn(record["pickCount"], 0, PICKS_PER_PLAYER);
  if (pickCount === null) return null;
  const picksRaw = record["picks"];
  let picks: IngredientSnap[] | null = null;
  if (picksRaw !== null && picksRaw !== undefined) {
    picks = parseSnaps(picksRaw, PICKS_PER_PLAYER);
    if (picks === null) return null;
  }
  return { slot, name, pickCount, picks };
}

function parseCurrent(value: unknown): CookoutTurn | null {
  const record = asRecord(value);
  if (record === null) return null;
  const turn = asIntIn(record["turn"], 1, TOTAL_PICKS);
  const player = asSlot(record["player"]);
  if (turn === null || player === null) return null;
  // Odd turns are Slot 1's, even turns Slot 2's (spec §1.1): a view that says otherwise is not drawn.
  if ((turn % 2 === 1 ? 1 : 2) !== player) return null;
  const roleRaw = record["role"];
  const role = typeof roleRaw === "string" && ROLES.includes(roleRaw) ? (roleRaw as CookoutRole) : null;
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
  return { turn, player, role, waitingForJoin: record["waitingForJoin"] === true, options, offerIndex, skipsRemaining };
}

function parseHistory(value: unknown): HistoryTurn[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryTurn[] = [];
  for (const raw of (value as unknown[]).slice(0, TOTAL_PICKS)) {
    const record = asRecord(raw);
    if (record === null) continue;
    const turn = asIntIn(record["turn"], 1, TOTAL_PICKS);
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
    out.push({ turn, player, offers, choice });
  }
  return out;
}

function parseConcept(value: unknown): Concept | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record["id"];
  const title = asText(record["title"], 200);
  const description = asText(record["description"], 1200);
  if (!isConceptId(id) || title === null || title.trim() === "" || description === null) return null;
  const picked = parseSnaps(record["pickedIngredients"], TOTAL_PICKS) ?? [];
  const staplesUsed = parseStaples(record["staplesUsed"]);
  const omitted: OmittedItem[] = [];
  const omittedRaw = record["omitted"];
  if (Array.isArray(omittedRaw)) {
    for (const raw of (omittedRaw as unknown[]).slice(0, TOTAL_PICKS)) {
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
  };
}

function parseConcepts(value: unknown): ConceptsView {
  const record = asRecord(value);
  if (record === null) return { state: "none", data: null, error: null };
  const state = record["state"];
  const dataRaw = record["data"];
  let data: Concept[] | null = null;
  if (Array.isArray(dataRaw)) {
    const seen = new Set<ConceptId>();
    data = [];
    for (const raw of (dataRaw as unknown[]).slice(0, CONCEPT_IDS.length)) {
      const concept = parseConcept(raw);
      if (concept === null || seen.has(concept.id)) continue;
      seen.add(concept.id);
      data.push(concept);
    }
    data.sort((x, y) => x.id.localeCompare(y.id));
  }
  return {
    state: typeof state === "string" && CONCEPT_STATES.includes(state) ? (state as ConceptsState) : "none",
    data,
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

function parseImages(value: unknown): ImagesView {
  const record = asRecord(value);
  const state = record?.["state"];
  const pictures = asRecord(record?.["pictures"]);
  return {
    state: typeof state === "string" && IMAGE_STATES.includes(state) ? (state as ImagesState) : "none",
    pictures: {
      a: parsePicture(pictures?.["a"]),
      b: parsePicture(pictures?.["b"]),
      c: parsePicture(pictures?.["c"]),
    },
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
  return { serves, prepMinutes, cookMinutes, totalMinutes, ingredients, steps, tips };
}

const NO_RECIPE: RecipeSlot = { state: "none", requestedBy: null, bankedAt: null, error: null, data: null };

function parseRecipeSlot(value: unknown): RecipeSlot {
  const record = asRecord(value);
  if (record === null) return NO_RECIPE;
  const state = record["state"];
  const parsedState = typeof state === "string" && RECIPE_STATES.includes(state) ? (state as RecipeState) : "none";
  const dataRaw = record["data"];
  const data = dataRaw === null || dataRaw === undefined ? null : parseFullRecipe(dataRaw);
  const bankedAt = asFinite(record["bankedAt"]);
  return {
    // "Banked" with no readable recipe cannot show the recipe it promises: read it as not finished,
    // so the card offers to try again rather than a "View full recipe" that opens nothing.
    state: parsedState === "banked" && data === null ? "failed" : parsedState,
    requestedBy: asText(record["requestedBy"], 120),
    bankedAt,
    error: asText(record["error"], 600),
    data,
  };
}

/** A round view from the wire, or null when anything load-bearing about it is off. */
export function parseCookoutView(value: unknown): CookoutView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const seq = asPosInt(record["seq"]);
  const rev = asPosInt(record["rev"]);
  const state = record["state"];
  if (seq === null || rev === null || typeof state !== "string" || !STATES.includes(state)) return null;
  const playersRaw = record["players"];
  if (!Array.isArray(playersRaw) || playersRaw.length !== 2) return null;
  const p1 = parsePlayer(playersRaw[0], 1);
  const p2 = parsePlayer(playersRaw[1], 2);
  if (p1 === null || p2 === null) return null;
  const youRecord = asRecord(record["you"]);
  const youSlot = youRecord === null ? null : asSlot(youRecord["slot"]);
  const currentRaw = record["current"];
  const current = currentRaw === null || currentRaw === undefined ? null : parseCurrent(currentRaw);
  const s = state as CookoutState;
  // A round being picked has a turn; a turn that would not parse cannot be played (not drawn at all).
  if (s === "picking" && current === null) return null;
  const recipes = asRecord(record["recipes"]);
  return {
    seq,
    state: s,
    rev,
    blind: record["blind"] === true,
    revealed: record["revealed"] === true,
    players: [p1, p2],
    you: youSlot === null ? null : { slot: youSlot },
    current: s === "picking" ? current : null,
    history: parseHistory(record["history"]),
    staples: parseStaples(record["staples"]),
    concepts: parseConcepts(record["concepts"]),
    images: parseImages(record["images"]),
    recipes: {
      a: parseRecipeSlot(recipes?.["a"]),
      b: parseRecipeSlot(recipes?.["b"]),
      c: parseRecipeSlot(recipes?.["c"]),
    },
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

const CONFLICTS: readonly string[] = ["bad_state", "not_your_turn", "not_player", "skip_exhausted", "exhausted"];

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

/** `POST /cookout` — starts a round (abandons an unfinished one). Idempotent on `clientId`. */
export async function createCookout(
  session: ServerSession,
  input: { readonly clientId: string; readonly sender: string; readonly deviceId: string; readonly blind: boolean },
): Promise<CreateCookoutResult> {
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

/** `POST /cookout/{seq}/skip` — deal a fresh pair (at most twice a turn). */
export function skipCookout(session: ServerSession, seq: number, input: MoveInput): Promise<CookoutOutcome> {
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

/** `POST /cookout/{seq}/concepts/retry`. */
export function retryCookoutConcepts(session: ServerSession, seq: number, input: { readonly sender: string }): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/concepts/retry"), postInit(input));
}

/** `POST /cookout/{seq}/pictures/retry`. */
export function retryCookoutPictures(session: ServerSession, seq: number, input: { readonly sender: string }): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, "/pictures/retry"), postInit(input));
}

/** `POST /cookout/{seq}/concepts/{id}/bank` — write the full recipe and save it to the Recipe book. */
export function bankCookoutConcept(
  session: ServerSession,
  seq: number,
  conceptId: ConceptId,
  input: { readonly sender: string; readonly moveId: string },
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, `/concepts/${conceptId}/bank`), postInit(input));
}

/** `POST /cookout/{seq}/concepts/{id}/recipe/retry`. */
export function retryCookoutRecipe(
  session: ServerSession,
  seq: number,
  conceptId: ConceptId,
  input: { readonly sender: string },
): Promise<CookoutOutcome> {
  return call(session, seqPath(seq, `/concepts/${conceptId}/recipe/retry`), postInit(input));
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

/** The ingredient picks of a finished round, everybody's, in pick order where known. */
export function allPicks(view: CookoutView): IngredientSnap[] {
  const out: IngredientSnap[] = [];
  const [one, two] = view.players;
  const a = one.picks ?? [];
  const b = two.picks ?? [];
  for (let i = 0; i < PICKS_PER_PLAYER; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x !== undefined) out.push(x);
    if (y !== undefined) out.push(y);
  }
  return out;
}
