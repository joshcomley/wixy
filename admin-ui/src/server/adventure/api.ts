// Adventure Time's HTTP surface (`/adventure*`, workspace 00056; spec/server-chat/08-adventure-time.md
// §4.2, docs/ai/contracts.md). Every response the game draws from is parsed defensively HERE and
// nowhere else: a view is only as trustworthy as the server that sent it, an older or newer server may
// omit or add keys, and a half-understood round must never reach the globe (a NaN rotation or a
// negative duration would freeze the pane's animation loop). A body that is not a round yields `null`
// and the caller treats the call as unavailable; nothing in this file throws on a bad shape.
//
// The pack's URLs are the other thing this file guards: a link the research produced is kept only when
// it is plain `http(s)` with a host (the server already sanitises, this is the second lock), and a
// PICTURE URL is kept only when it points at THIS origin — the server serves every picture itself so a
// viewer's device never contacts a third-party image host from a private chat (spec §4.3a).

import type { LngLat } from "./camera";
import type { LivePostResult } from "../api/drawings";
import { ServerLockedError, serverFetch } from "../api/http";
import type { Message } from "../api/messages";
import type { ServerSession } from "../types";

export type AdventureState =
  | "spin_lng"
  | "spin_lat"
  | "country"
  | "destination"
  | "chosen"
  | "banked"
  | "rejected"
  | "abandoned";
export type PackState = "none" | "pending" | "ready" | "failed" | "unavailable";
export type AdventureAxis = "lng" | "lat";
export type PackImages = "none" | "pending" | "done";

const STATES: readonly string[] = [
  "spin_lng",
  "spin_lat",
  "country",
  "destination",
  "chosen",
  "banked",
  "rejected",
  "abandoned",
];
const PACK_STATES: readonly string[] = ["none", "pending", "ready", "failed", "unavailable"];

/** What a `Message` carries about its round: enough to notice it moved, never the spin or the pack. */
export interface AdventureSummary {
  readonly state: AdventureState;
  readonly pack: PackState;
  readonly rev: number;
}

/** One spin as the server stored it (spec §3.1): replayed identically on every screen. */
export interface AdventureSpin {
  readonly by: string;
  /** Degrees the spin started from (where the finger let go). */
  readonly from: number;
  /** Signed degrees travelled. */
  readonly delta: number;
  readonly durationMs: number;
  /** Server epoch seconds the spin was stored (the animation starts here for everyone else). */
  readonly at: number;
}

export interface AdventureLanding {
  readonly point: LngLat;
  readonly sea: boolean;
  readonly land: LngLat;
  readonly centre: LngLat;
  readonly landUnit: string;
  readonly landUnitName: string;
}

export interface NamedUnit {
  readonly id: string;
  readonly name: string;
}

export interface CountryStage {
  /** The landing unit first, then the rest by distance from the landing centre. */
  readonly candidates: readonly NamedUnit[];
  readonly seed: number;
  /** Server epoch seconds the flicker starts. */
  readonly rouletteAt: number;
  readonly chosen: NamedUnit | null;
  readonly by: string | null;
}

export interface AdventureDest {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly lat: number;
  readonly lng: number;
  readonly kind: string;
  readonly blurb: string;
}

export interface DestinationStage {
  readonly candidates: readonly AdventureDest[];
  /** `null` with `rouletteAt` when the country had exactly one place left (no destination roulette). */
  readonly seed: number | null;
  readonly rouletteAt: number | null;
  readonly chosen: AdventureDest | null;
  readonly by: string | null;
}

export interface PackItem {
  /** The item's index in the server's own list of its section: a picture is keyed
   * `"<section key>:<index>"`, so it must survive an earlier item being dropped as unusable here. */
  readonly index: number;
  readonly name: string;
  readonly detail: string;
  readonly url: string | null;
}

export interface PackSection {
  readonly key: string;
  readonly title: string;
  readonly items: readonly PackItem[];
}

export interface PackSource {
  readonly title: string;
  readonly url: string;
}

export interface Pack {
  readonly headline: string;
  readonly summary: string;
  readonly sections: readonly PackSection[];
  readonly bestTime: string;
  readonly gettingThere: string;
  readonly travelAdvice: string;
  readonly sources: readonly PackSource[];
}

/** One picture of the pack: both renditions are signed URLs on this server. */
export interface PackPicture {
  readonly thumbUrl: string;
  readonly fullUrl: string;
  readonly credit: string;
  /** The picture's source page (a link for the credit), or null. */
  readonly page: string | null;
  readonly caption: string;
}

export interface PackPictures {
  /** The photographs of the place, in the order to show them. */
  readonly hero: readonly PackPicture[];
  /** One picture per item that has one, keyed `"<section key>:<item index>"`. */
  readonly items: ReadonlyMap<string, PackPicture>;
}

export interface PackView {
  readonly state: PackState;
  readonly data: Pack | null;
  readonly error: string | null;
  readonly canRetry: boolean;
  /** `pending` while the server is still finding the pack's pictures; `none` for a server without them. */
  readonly images: PackImages;
  readonly pictures: PackPictures | null;
}

export interface AdventureView {
  readonly seq: number;
  readonly state: AdventureState;
  readonly rev: number;
  /** Server epoch seconds when this view was made (the clock-offset sample). */
  readonly serverNow: number;
  readonly startedBy: string;
  /** The units a landing may be in; only present while the round is still spinning. */
  readonly eligible: readonly string[] | null;
  readonly spins: { readonly lng: AdventureSpin | null; readonly lat: AdventureSpin | null };
  readonly landing: AdventureLanding | null;
  readonly country: CountryStage | null;
  readonly destination: DestinationStage | null;
  readonly pack: PackView;
  readonly decidedBy: string | null;
}

export type AdventureFailure = "not_found" | "bad_state" | "too_early" | "exhausted" | "invalid" | "unavailable";

export type AdventureOutcome =
  | { readonly ok: true; readonly view: AdventureView }
  | { readonly ok: false; readonly kind: AdventureFailure };

export type CreateAdventureResult =
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

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPosInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asUint32(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4294967295 ? value : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `[lng, lat]` in degrees (longitude may be a hair outside ±180 after rounding: it is normalised on use). */
export function asLngLat(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lng = asFinite(value[0]);
  const lat = asFinite(value[1]);
  if (lng === null || lat === null || Math.abs(lng) > 360 || Math.abs(lat) > 90) return null;
  return [lng, lat];
}

/** A link from the research: `http(s)` with a host, or null. */
export function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > 600) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.hostname === "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * A picture URL: only ever THIS server's own (a path, or an absolute URL on this origin). The browser
 * must never load a third-party image from a private chat (spec §4.3a), so anything else is dropped
 * here even if a buggy or hostile server sent it.
 */
export function sameOriginMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > 2000) return null;
  if (/[\u0000-\u001f\\]/.test(value)) return null;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  try {
    const origin = globalThis.location?.origin;
    if (origin === undefined || origin === "null") return null;
    const parsed = new URL(value);
    return parsed.origin === origin ? parsed.href : null;
  } catch {
    return null;
  }
}

// -- Summary -------------------------------------------------------------------------------------------

/** The `adventure` summary of a `Message`, or null when absent/malformed ("no adventure here"). */
export function parseAdventureSummary(value: unknown): AdventureSummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const state = record["state"];
  const pack = record["pack"];
  const rev = asPosInt(record["rev"]);
  if (typeof state !== "string" || !STATES.includes(state) || rev === null) return null;
  return {
    state: state as AdventureState,
    pack: typeof pack === "string" && PACK_STATES.includes(pack) ? (pack as PackState) : "none",
    rev,
  };
}

// -- View pieces ---------------------------------------------------------------------------------------

function parseSpin(value: unknown): AdventureSpin | null {
  const record = asRecord(value);
  if (record === null) return null;
  const by = asString(record["by"]);
  const from = asFinite(record["from"]);
  const delta = asFinite(record["delta"]);
  const durationMs = asFinite(record["durationMs"]);
  const at = asFinite(record["at"]);
  if (by === null || from === null || delta === null || durationMs === null || at === null) return null;
  // The server's own bounds are 720..3600 degrees and 3.5..7 s; these are the loose "cannot freeze the
  // animation loop" bounds, so a future change of the server's numbers never blinds the client.
  if (Math.abs(from) > 1e6 || Math.abs(delta) < 1 || Math.abs(delta) > 100_000) return null;
  if (durationMs < 100 || durationMs > 60_000) return null;
  return { by, from, delta, durationMs, at };
}

function parseLanding(value: unknown): AdventureLanding | null {
  const record = asRecord(value);
  if (record === null) return null;
  const point = asLngLat(record["point"]);
  const land = asLngLat(record["land"]);
  const centre = asLngLat(record["centre"]);
  const landUnit = asString(record["landUnit"]);
  if (point === null || land === null || centre === null || landUnit === null || landUnit === "") return null;
  const landUnitName = asString(record["landUnitName"]);
  return {
    point,
    sea: record["sea"] === true,
    land,
    centre,
    landUnit,
    landUnitName: landUnitName !== null && landUnitName !== "" ? landUnitName : landUnit,
  };
}

function parseNamed(value: unknown): NamedUnit | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asString(record["id"]);
  const name = asString(record["name"]);
  if (id === null || id === "") return null;
  return { id, name: name !== null && name !== "" ? name : id };
}

export function parseDest(value: unknown): AdventureDest | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asString(record["id"]);
  const name = asString(record["name"]);
  const lat = asFinite(record["lat"]);
  const lng = asFinite(record["lng"]);
  if (id === null || id === "" || name === null || lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 360) return null;
  return {
    id,
    name,
    region: asString(record["region"]) ?? "",
    lat,
    lng,
    kind: asString(record["kind"]) ?? "",
    blurb: asString(record["blurb"]) ?? "",
  };
}

function parseCountry(value: unknown): CountryStage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const list = record["candidates"];
  const seed = asUint32(record["seed"]);
  const rouletteAt = asFinite(record["rouletteAt"]);
  if (!Array.isArray(list) || seed === null || rouletteAt === null) return null;
  const candidates: NamedUnit[] = [];
  for (const raw of list as unknown[]) {
    const unit = parseNamed(raw);
    if (unit === null) return null; // a roulette with a hole in it would light different items on each screen
    candidates.push(unit);
  }
  if (candidates.length < 1 || candidates.length > 20) return null;
  const chosenRaw = record["chosen"];
  const chosen = chosenRaw === null || chosenRaw === undefined ? null : parseNamed(chosenRaw);
  return { candidates, seed, rouletteAt, chosen, by: asStringOrNull(record["by"]) };
}

function parseDestination(value: unknown): DestinationStage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const list = record["candidates"];
  if (!Array.isArray(list)) return null;
  const candidates: AdventureDest[] = [];
  for (const raw of list as unknown[]) {
    const dest = parseDest(raw);
    if (dest === null) return null;
    candidates.push(dest);
  }
  if (candidates.length < 1 || candidates.length > 20) return null;
  const seedRaw = record["seed"];
  const rouletteRaw = record["rouletteAt"];
  const seed = seedRaw === null || seedRaw === undefined ? null : asUint32(seedRaw);
  const rouletteAt = rouletteRaw === null || rouletteRaw === undefined ? null : asFinite(rouletteRaw);
  // Both or neither: a seed without a start time (or the reverse) cannot light anything.
  if ((seed === null) !== (rouletteAt === null)) return null;
  const chosenRaw = record["chosen"];
  const chosen = chosenRaw === null || chosenRaw === undefined ? null : parseDest(chosenRaw);
  return { candidates, seed, rouletteAt, chosen, by: asStringOrNull(record["by"]) };
}

const MAX_SECTIONS = 12;
const MAX_ITEMS = 12;
const MAX_SOURCES = 24;

function parseItem(value: unknown, index: number): PackItem | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asString(record["name"]);
  if (name === null || name.trim() === "") return null;
  return { index, name, detail: asString(record["detail"]) ?? "", url: safeLink(record["url"]) };
}

/** The holiday pack as the server stored it, or null when it is not a usable pack. */
export function parsePack(value: unknown): Pack | null {
  const record = asRecord(value);
  if (record === null) return null;
  const headline = asString(record["headline"]) ?? "";
  const summary = asString(record["summary"]) ?? "";
  const sections: PackSection[] = [];
  const rawSections = record["sections"];
  if (Array.isArray(rawSections)) {
    for (const raw of (rawSections as unknown[]).slice(0, MAX_SECTIONS)) {
      const section = asRecord(raw);
      if (section === null) continue;
      const key = asString(section["key"]);
      const title = asString(section["title"]);
      const rawItems = section["items"];
      if (key === null || title === null || !Array.isArray(rawItems)) continue;
      const items: PackItem[] = [];
      (rawItems as unknown[]).slice(0, MAX_ITEMS).forEach((rawItem, index) => {
        const item = parseItem(rawItem, index);
        if (item !== null) items.push(item);
      });
      if (items.length > 0) sections.push({ key, title, items });
    }
  }
  if (headline.trim() === "" && summary.trim() === "" && sections.length === 0) return null;
  const sources: PackSource[] = [];
  const rawSources = record["sources"];
  if (Array.isArray(rawSources)) {
    for (const raw of (rawSources as unknown[]).slice(0, MAX_SOURCES)) {
      const source = asRecord(raw);
      const url = safeLink(source?.["url"]);
      if (source === null || url === null) continue;
      const title = asString(source["title"]);
      sources.push({ title: title !== null && title.trim() !== "" ? title : url, url });
    }
  }
  return {
    headline,
    summary,
    sections,
    bestTime: asString(record["bestTime"]) ?? "",
    gettingThere: asString(record["gettingThere"]) ?? "",
    travelAdvice: asString(record["travelAdvice"]) ?? "",
    sources,
  };
}

/** The key a section item's picture is stored under in `PackPictures.items`. */
export function pictureKey(section: PackSection, item: PackItem): string {
  return `${section.key}:${item.index}`;
}

/** The section key of "Local food to try" (spec §4.3b): its items are dishes, pictured as `dishes:0`…`dishes:5`. */
export const DISHES_SECTION = "dishes";

/**
 * The first dish of the pack that has a photo, for the main-chat card (the dishes are the first thing the
 * operator wants to see): the lowest-indexed dish with a picture, or null when the pack has no dishes, no
 * pictures yet, or no dish photo. Never reads a hero or another section's picture.
 */
export function firstDishPicture(pack: PackView): PackPicture | null {
  const pictures = pack.pictures;
  if (pack.data === null || pictures === null) return null;
  const section = pack.data.sections.find((s) => s.key === DISHES_SECTION);
  if (section === undefined) return null;
  for (const item of section.items) {
    const picture = pictures.items.get(pictureKey(section, item));
    if (picture !== undefined) return picture;
  }
  return null;
}

const MAX_PICTURES = 24;
const PICTURE_KEY = /^[a-z]{1,16}:\d{1,2}$/;

function parsePicture(value: unknown): PackPicture | null {
  const record = asRecord(value);
  if (record === null) return null;
  const thumbUrl = sameOriginMediaUrl(record["thumbUrl"]) ?? sameOriginMediaUrl(record["fullUrl"]);
  const fullUrl = sameOriginMediaUrl(record["fullUrl"]) ?? thumbUrl;
  if (thumbUrl === null || fullUrl === null) return null;
  return {
    thumbUrl,
    fullUrl,
    credit: asString(record["credit"]) ?? "",
    page: safeLink(record["page"]),
    caption: asString(record["caption"]) ?? "",
  };
}

function parsePictures(value: unknown): PackPictures | null {
  const record = asRecord(value);
  if (record === null) return null;
  const hero: PackPicture[] = [];
  const rawHero = record["hero"];
  if (Array.isArray(rawHero)) {
    for (const raw of (rawHero as unknown[]).slice(0, MAX_PICTURES)) {
      const picture = parsePicture(raw);
      if (picture !== null) hero.push(picture);
    }
  }
  const items = new Map<string, PackPicture>();
  const rawItems = asRecord(record["items"]);
  if (rawItems !== null) {
    for (const [key, raw] of Object.entries(rawItems).slice(0, MAX_PICTURES * 2)) {
      if (!PICTURE_KEY.test(key)) continue;
      const picture = parsePicture(raw);
      if (picture !== null) items.set(key, picture);
    }
  }
  return { hero, items };
}

function parsePackView(value: unknown): PackView {
  const record = asRecord(value);
  const none: PackView = { state: "none", data: null, error: null, canRetry: false, images: "none", pictures: null };
  if (record === null) return none;
  const state = record["state"];
  const images = record["images"];
  return {
    state: typeof state === "string" && PACK_STATES.includes(state) ? (state as PackState) : "none",
    data: record["data"] === null || record["data"] === undefined ? null : parsePack(record["data"]),
    error: asStringOrNull(record["error"]),
    canRetry: record["canRetry"] === true,
    images: images === "pending" || images === "done" ? images : "none",
    pictures: parsePictures(record["pictures"]),
  };
}

/** A round view from the wire, or null when anything about it is off. */
export function parseAdventureView(value: unknown): AdventureView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const seq = asPosInt(record["seq"]);
  const rev = asPosInt(record["rev"]);
  const state = record["state"];
  const serverNow = asFinite(record["serverNow"]);
  const startedBy = asString(record["startedBy"]);
  if (seq === null || rev === null || serverNow === null || startedBy === null) return null;
  if (typeof state !== "string" || !STATES.includes(state)) return null;

  const spinsRecord = asRecord(record["spins"]);
  const lng = spinsRecord === null || spinsRecord["lng"] === null ? null : parseSpin(spinsRecord["lng"]);
  const lat = spinsRecord === null || spinsRecord["lat"] === null ? null : parseSpin(spinsRecord["lat"]);
  const landing = record["landing"] === null || record["landing"] === undefined ? null : parseLanding(record["landing"]);
  const country = record["country"] === null || record["country"] === undefined ? null : parseCountry(record["country"]);
  const destination =
    record["destination"] === null || record["destination"] === undefined ? null : parseDestination(record["destination"]);

  // A round whose stage is claimed but whose stage data would not parse cannot be drawn: say so
  // (the caller shows "unavailable" and retries) rather than drawing half a round.
  const s = state as AdventureState;
  if (s === "spin_lat" && lng === null) return null;
  if (s !== "spin_lng" && s !== "spin_lat" && s !== "abandoned" && (lat === null || landing === null || country === null)) {
    return null;
  }
  if ((s === "chosen" || s === "banked" || s === "rejected") && (destination === null || destination.chosen === null)) {
    return null;
  }
  if (s === "destination" && (destination === null || destination.seed === null)) return null;

  let eligible: string[] | null = null;
  if (Array.isArray(record["eligible"])) {
    eligible = (record["eligible"] as unknown[]).filter((id): id is string => typeof id === "string" && id !== "");
  }
  return {
    seq,
    state: s,
    rev,
    serverNow,
    startedBy,
    eligible,
    spins: { lng, lat },
    landing,
    country,
    destination,
    pack: parsePackView(record["pack"]),
    decidedBy: asStringOrNull(record["decidedBy"]),
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

async function toOutcome(response: Response): Promise<AdventureOutcome> {
  if (response.ok) {
    const view = parseAdventureView(await readJson(response));
    return view === null ? { ok: false, kind: "unavailable" } : { ok: true, view };
  }
  if (response.status === 404) return { ok: false, kind: "not_found" };
  if (response.status === 409) {
    const error = asRecord(await readJson(response))?.["error"];
    if (error === "bad_state" || error === "too_early" || error === "exhausted") return { ok: false, kind: error };
    return { ok: false, kind: "bad_state" };
  }
  if (response.status === 422) return { ok: false, kind: "invalid" };
  return { ok: false, kind: "unavailable" };
}

async function call(session: ServerSession, path: string, init: RequestInit): Promise<AdventureOutcome> {
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
  return `/adventure/${encodeURIComponent(String(seq))}${suffix}`;
}

/** `POST /adventure` — starts a round (abandons the unfinished ones). Idempotent on `clientId`. */
export async function createAdventure(
  session: ServerSession,
  input: { readonly clientId: string; readonly sender: string; readonly deviceId: string },
): Promise<CreateAdventureResult> {
  let response: Response;
  try {
    response = await serverFetch("/adventure", postInit(input), session);
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

/** `GET /adventure/{seq}` — the round's view. */
export function getAdventure(session: ServerSession, seq: number): Promise<AdventureOutcome> {
  return call(session, seqPath(seq), { method: "GET" });
}

/** The landing a `lat` spin carries (the engine's `Landing`, wire-shaped). */
export interface SpinResultInput {
  readonly point: LngLat;
  readonly sea: boolean;
  readonly land: LngLat;
  readonly centre: LngLat;
  readonly landUnit: string;
  readonly candidates: readonly string[];
}

export interface SpinInput {
  readonly sender: string;
  readonly axis: AdventureAxis;
  readonly from: number;
  readonly delta: number;
  readonly durationMs: number;
  /** Required for `lat`, refused for `lng`. */
  readonly result?: SpinResultInput;
}

/** `POST /adventure/{seq}/spin`. */
export function spinAdventure(session: ServerSession, seq: number, input: SpinInput): Promise<AdventureOutcome> {
  const body: Record<string, unknown> = {
    sender: input.sender,
    axis: input.axis,
    from: input.from,
    delta: input.delta,
    durationMs: input.durationMs,
  };
  if (input.result !== undefined) {
    body["result"] = {
      point: [input.result.point[0], input.result.point[1]],
      sea: input.result.sea,
      land: [input.result.land[0], input.result.land[1]],
      centre: [input.result.centre[0], input.result.centre[1]],
      landUnit: input.result.landUnit,
      candidates: [...input.result.candidates],
    };
  }
  return call(session, seqPath(seq, "/spin"), postInit(body));
}

/** `POST /adventure/{seq}/stop` — `choice` is the candidate the presser SAW lit. */
export function stopAdventure(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string; readonly stage: "country" | "destination"; readonly choice: string },
): Promise<AdventureOutcome> {
  return call(session, seqPath(seq, "/stop"), postInit(input));
}

/** `POST /adventure/{seq}/decide`. */
export function decideAdventure(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string; readonly decision: "bank" | "reject" },
): Promise<AdventureOutcome> {
  return call(session, seqPath(seq, "/decide"), postInit(input));
}

/** `POST /adventure/{seq}/pack/retry`. */
export function retryAdventurePack(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string },
): Promise<AdventureOutcome> {
  return call(session, seqPath(seq, "/pack/retry"), postInit(input));
}

// -- The Holiday bank ------------------------------------------------------------------------------------

export interface BankTrip {
  readonly seq: number;
  readonly unitId: string;
  readonly unitName: string;
  readonly destination: AdventureDest;
  readonly headline: string | null;
  readonly pack: PackState;
}

export type BankResult =
  | { readonly ok: true; readonly trips: readonly BankTrip[] }
  | { readonly ok: false; readonly kind: "unavailable" };

export function parseBank(value: unknown): readonly BankTrip[] | null {
  const trips = asRecord(value)?.["trips"];
  if (!Array.isArray(trips)) return null;
  const out: BankTrip[] = [];
  for (const raw of trips as unknown[]) {
    const record = asRecord(raw);
    if (record === null) continue;
    const seq = asPosInt(record["seq"]);
    const unitId = asString(record["unitId"]);
    const destination = parseDest(record["destination"]);
    if (seq === null || unitId === null || destination === null) continue;
    const headline = asString(record["headline"]);
    const pack = record["pack"];
    out.push({
      seq,
      unitId,
      unitName: asString(record["unitName"]) ?? unitId,
      destination,
      headline: headline !== null && headline.trim() !== "" ? headline : null,
      pack: typeof pack === "string" && PACK_STATES.includes(pack) ? (pack as PackState) : "none",
    });
  }
  return out;
}

/** `GET /adventure/bank` — banked trips, newest first. */
export async function getAdventureBank(session: ServerSession): Promise<BankResult> {
  let response: Response;
  try {
    response = await serverFetch("/adventure/bank", { method: "GET" }, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (!response.ok) return { ok: false, kind: "unavailable" };
  const trips = parseBank(await readJson(response));
  return trips === null ? { ok: false, kind: "unavailable" } : { ok: true, trips };
}

// -- Settings --------------------------------------------------------------------------------------------

export interface AdventureSettings {
  readonly includeAdvised: boolean;
  readonly advisedUnits: readonly NamedUnit[];
}

export type SettingsResult =
  | { readonly ok: true; readonly settings: AdventureSettings }
  | { readonly ok: false; readonly kind: "unavailable" };

export function parseSettings(value: unknown): AdventureSettings | null {
  const record = asRecord(value);
  if (record === null || typeof record["includeAdvised"] !== "boolean") return null;
  const advisedUnits: NamedUnit[] = [];
  if (Array.isArray(record["advisedUnits"])) {
    for (const raw of record["advisedUnits"] as unknown[]) {
      const unit = parseNamed(raw);
      if (unit !== null) advisedUnits.push(unit);
    }
  }
  return { includeAdvised: record["includeAdvised"], advisedUnits };
}

async function settingsCall(session: ServerSession, init: RequestInit): Promise<SettingsResult> {
  let response: Response;
  try {
    response = await serverFetch("/adventure/settings", init, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (!response.ok) return { ok: false, kind: "unavailable" };
  const settings = parseSettings(await readJson(response));
  return settings === null ? { ok: false, kind: "unavailable" } : { ok: true, settings };
}

/** `GET /adventure/settings`. */
export function getAdventureSettings(session: ServerSession): Promise<SettingsResult> {
  return settingsCall(session, { method: "GET" });
}

/** `PUT /adventure/settings` — the shared "include places the UK says not to travel to" switch. */
export function putAdventureSettings(session: ServerSession, includeAdvised: boolean): Promise<SettingsResult> {
  return settingsCall(session, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeAdvised }),
  });
}

// -- The live swipe trail ----------------------------------------------------------------------------------

/** The server's bounds for one live frame (contracts.md `POST adventure/live`). */
export const LIVE_MAX_POINTS = 32;
export const LIVE_MAX_COORD = 3;

/** One relayed frame of the dragger's finger (spec §3.5). */
export interface AdventureLiveFrame {
  readonly anchorSeq: number;
  /** One id per drag: a receiver ignores its own, and a new id is a new drag. */
  readonly clientId: string;
  readonly axis: AdventureAxis;
  /** The globe's `[λ, φ]` (degrees) at this frame. */
  readonly rotation: readonly [number, number];
  /** `[x, y, t]`: globe-radius units from the globe centre, `t` ms since the drag began. */
  readonly points: ReadonlyArray<readonly [number, number, number]>;
  readonly frame: number;
  readonly end: boolean;
}

function parseId(value: unknown): string | null {
  return typeof value === "string" && value.length >= 8 && value.length <= 64 ? value : null;
}

/** An `adventure_live` stream frame, or null when anything about it is off (a live frame is a lossy
 * preview: dropping a bad one costs nothing). */
export function parseAdventureLiveFrame(value: unknown): AdventureLiveFrame | null {
  const record = asRecord(value);
  if (record === null) return null;
  const anchorSeq = asPosInt(record["anchorSeq"]);
  const clientId = parseId(record["clientId"]);
  const axis = record["axis"];
  const frame = record["frame"];
  const rotation = record["rotation"];
  const rawPoints = record["points"];
  if (anchorSeq === null || clientId === null || (axis !== "lng" && axis !== "lat")) return null;
  if (typeof frame !== "number" || !Number.isSafeInteger(frame) || frame < 0) return null;
  if (!Array.isArray(rotation) || rotation.length !== 2) return null;
  const lambda = asFinite(rotation[0]);
  const phi = asFinite(rotation[1]);
  if (lambda === null || phi === null || Math.abs(lambda) > 1e6 || Math.abs(phi) > 1e6) return null;
  if (!Array.isArray(rawPoints) || rawPoints.length > LIVE_MAX_POINTS) return null;
  const points: Array<readonly [number, number, number]> = [];
  for (const raw of rawPoints as unknown[]) {
    if (!Array.isArray(raw) || raw.length !== 3) return null;
    const x = asFinite(raw[0]);
    const y = asFinite(raw[1]);
    const t = asFinite(raw[2]);
    if (x === null || y === null || t === null) return null;
    if (Math.abs(x) > LIVE_MAX_COORD || Math.abs(y) > LIVE_MAX_COORD || t < 0 || t > 600_000) return null;
    points.push([x, y, t]);
  }
  return { anchorSeq, clientId, axis, rotation: [lambda, phi], points, frame, end: record["end"] === true };
}

const LIVE_TIMEOUT_MS = 4_000;

/** `POST /adventure/live` — one frame of the finger trail, relayed to every stream and never stored.
 * Lossy by design: a failure is just a missed preview frame. */
export async function postAdventureLive(session: ServerSession, frame: AdventureLiveFrame): Promise<LivePostResult> {
  let response: Response;
  try {
    response = await serverFetch(
      "/adventure/live",
      postInit({
        anchorSeq: frame.anchorSeq,
        clientId: frame.clientId,
        axis: frame.axis,
        rotation: [frame.rotation[0], frame.rotation[1]],
        points: frame.points.map((p) => [p[0], p[1], p[2]]),
        frame: frame.frame,
        ...(frame.end ? { end: true } : {}),
      }),
      session,
      LIVE_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { kind: "failed" };
  }
  if (response.ok) return { kind: "ok" };
  if (response.status === 429) {
    const body = asRecord(await readJson(response));
    const header = Number(response.headers.get("Retry-After"));
    const fromBody = asFinite(body?.["retryAfterS"]);
    const seconds = fromBody ?? (Number.isFinite(header) && header > 0 ? header : 1);
    return { kind: "rate_limited", retryAfterMs: Math.min(10_000, Math.max(250, seconds * 1000)) };
  }
  return { kind: "failed" };
}
