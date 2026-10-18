// The would-you-rather game's HTTP surface (`/wyr*`, workspace 00045). Every response a card is
// drawn from is parsed defensively here: the server filters the other player's answers out of the
// view until both have pressed Reveal, and the client must never invent them.

import type { ServerSession } from "../types";
import { ServerLockedError, serverFetch } from "./http";
import type { Message } from "./messages";

export type WyrState = "voting" | "answering" | "revealing" | "revealed" | "skipped";
export type WyrChoice = "a" | "b";
export type WyrVote = "play" | "skip";
/** The picture job's state: a card waits for pictures only while `pending`. */
export type WyrImages = "none" | "pending" | "done" | "failed";

/** What a `Message` carries about its round: enough to notice it moved, never the answers. */
export interface WyrSummary {
  readonly state: WyrState;
  readonly rev: number;
}

export interface WyrQuestionView {
  readonly id: string;
  readonly category: string;
  readonly a: string;
  readonly b: string;
}

/** A player as everyone may see them: what they have DONE, never what they answered. */
export interface WyrPlayerView {
  readonly name: string;
  readonly vote: WyrVote | null;
  readonly answered: boolean;
  readonly revealed: boolean;
}

/** The viewer's own slot and answers (null when the viewer is not in the round). */
export interface WyrYouView {
  readonly slot: 1 | 2;
  readonly vote: WyrVote | null;
  readonly choice: WyrChoice | null;
  readonly guess: WyrChoice | null;
  readonly revealed: boolean;
}

export interface WyrResultPlayer {
  readonly name: string;
  readonly choice: WyrChoice;
  readonly guess: WyrChoice;
}

/** Present only once both players pressed Reveal. */
export interface WyrResult {
  readonly players: readonly [WyrResultPlayer, WyrResultPlayer];
  /** `guessed[0]`: did player 1 guess player 2's pick; `guessed[1]`: the reverse. */
  readonly guessed: readonly [boolean, boolean];
  readonly agree: boolean;
}

export interface WyrView {
  readonly seq: number;
  readonly state: WyrState;
  readonly rev: number;
  /** Unix timestamp in seconds for the active 30-second two-player Reveal window. */
  readonly revealDeadline: number | null;
  readonly question: WyrQuestionView;
  readonly images: WyrImages;
  readonly players: readonly WyrPlayerView[];
  readonly you: WyrYouView | null;
  readonly result: WyrResult | null;
}

export type WyrOutcome =
  | { readonly ok: true; readonly view: WyrView }
  | { readonly ok: false; readonly kind: "not_found" | "full" | "not_player" | "bad_state" }
  | { readonly ok: false; readonly kind: "unavailable" };

export type CreateWyrResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly kind: "unsupported" | "game_unavailable" | "unavailable" };

const STATES: readonly string[] = ["voting", "answering", "revealing", "revealed", "skipped"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asChoice(value: unknown): WyrChoice | null {
  return value === "a" || value === "b" ? value : null;
}

function asVote(value: unknown): WyrVote | null {
  return value === "play" || value === "skip" ? value : null;
}

function asImages(value: unknown): WyrImages {
  return value === "pending" || value === "done" || value === "failed" ? value : "none";
}

function asPosInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asState(value: unknown): WyrState | null {
  return typeof value === "string" && STATES.includes(value) ? (value as WyrState) : null;
}

/** The `wyr` summary of a `Message`, or null when absent/malformed ("no game here"). */
export function parseWyrSummary(value: unknown): WyrSummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const state = asState(record["state"]);
  const rev = asPosInt(record["rev"]);
  return state === null || rev === null ? null : { state, rev };
}

function parsePlayers(value: unknown): WyrPlayerView[] | null {
  if (!Array.isArray(value)) return null;
  const players: WyrPlayerView[] = [];
  for (const raw of value as unknown[]) {
    const record = asRecord(raw);
    if (record === null || typeof record["name"] !== "string") return null;
    players.push({
      name: record["name"],
      vote: asVote(record["vote"]),
      answered: record["answered"] === true,
      revealed: record["revealed"] === true,
    });
  }
  return players;
}

function parseYou(value: unknown): WyrYouView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const slot = record["slot"];
  if (slot !== 1 && slot !== 2) return null;
  return {
    slot,
    vote: asVote(record["vote"]),
    choice: asChoice(record["choice"]),
    guess: asChoice(record["guess"]),
    revealed: record["revealed"] === true,
  };
}

function parseResult(value: unknown): WyrResult | null {
  const record = asRecord(value);
  if (record === null) return null;
  const rawPlayers = record["players"];
  const rawGuessed = record["guessed"];
  if (!Array.isArray(rawPlayers) || rawPlayers.length !== 2) return null;
  if (!Array.isArray(rawGuessed) || rawGuessed.length !== 2) return null;
  const parsed: WyrResultPlayer[] = [];
  for (const raw of rawPlayers as unknown[]) {
    const player = asRecord(raw);
    if (player === null || typeof player["name"] !== "string") return null;
    const choice = asChoice(player["choice"]);
    const guess = asChoice(player["guess"]);
    if (choice === null || guess === null) return null;
    parsed.push({ name: player["name"], choice, guess });
  }
  const first = parsed[0];
  const second = parsed[1];
  if (first === undefined || second === undefined) return null;
  return {
    players: [first, second],
    guessed: [rawGuessed[0] === true, rawGuessed[1] === true],
    agree: record["agree"] === true,
  };
}

/** A round view from the wire, or null when anything about it is off. */
export function parseWyrView(value: unknown): WyrView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const seq = asPosInt(record["seq"]);
  const rev = asPosInt(record["rev"]);
  const state = asState(record["state"]);
  const question = asRecord(record["question"]);
  const players = parsePlayers(record["players"]);
  if (seq === null || rev === null || state === null || question === null || players === null) {
    return null;
  }
  if (
    typeof question["id"] !== "string" ||
    typeof question["a"] !== "string" ||
    typeof question["b"] !== "string"
  ) {
    return null;
  }
  const result = record["result"] === null ? null : parseResult(record["result"]);
  if (state === "revealed" && result === null) return null;
  return {
    seq,
    state,
    rev,
    revealDeadline: asFiniteNumber(record["revealDeadline"]),
    question: {
      id: question["id"],
      category: typeof question["category"] === "string" ? question["category"] : "",
      a: question["a"],
      b: question["b"],
    },
    images: asImages(record["images"]),
    players,
    you: record["you"] === null ? null : parseYou(record["you"]),
    // Defence in depth: a result is only ever honoured for a revealed round.
    result: state === "revealed" ? result : null,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function toOutcome(response: Response): Promise<WyrOutcome> {
  if (response.ok) {
    const view = parseWyrView(await readJson(response));
    return view === null ? { ok: false, kind: "unavailable" } : { ok: true, view };
  }
  if (response.status === 404) return { ok: false, kind: "not_found" };
  if (response.status === 409) {
    const body = asRecord(await readJson(response));
    const error = body?.["error"];
    if (error === "full" || error === "not_player" || error === "bad_state") {
      return { ok: false, kind: error };
    }
  }
  return { ok: false, kind: "unavailable" };
}

async function call(
  session: ServerSession,
  path: string,
  init: RequestInit,
): Promise<WyrOutcome> {
  let response: Response;
  try {
    response = await serverFetch(path, init, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  return toOutcome(response);
}

function postInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** `POST /wyr` — starts a round (picks the question server-side). Idempotent on `clientId`. */
export async function createWyrRound(
  session: ServerSession,
  input: { readonly clientId: string; readonly sender: string; readonly deviceId: string },
): Promise<CreateWyrResult> {
  let response: Response;
  try {
    response = await serverFetch("/wyr", postInit(input), session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { ok: false, kind: "unavailable" };
  }
  if (response.status === 201 || response.status === 200) {
    const body = asRecord(await readJson(response));
    const message = body?.["message"];
    if (asRecord(message) === null) return { ok: false, kind: "unavailable" };
    return { ok: true, message: message as unknown as Message };
  }
  // A server that predates the game has no such route.
  if (response.status === 404 || response.status === 405) return { ok: false, kind: "unsupported" };
  if (response.status === 503) return { ok: false, kind: "game_unavailable" };
  return { ok: false, kind: "unavailable" };
}

/** `GET /wyr/{seq}?as=<viewer>` — the viewer-filtered round. */
export function getWyrRound(session: ServerSession, seq: number, viewer: string): Promise<WyrOutcome> {
  return call(session, `/wyr/${encodeURIComponent(String(seq))}?as=${encodeURIComponent(viewer)}`, {
    method: "GET",
  });
}

export function voteWyr(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string; readonly vote: WyrVote },
): Promise<WyrOutcome> {
  return call(session, `/wyr/${encodeURIComponent(String(seq))}/vote`, postInit(input));
}

export function answerWyr(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string; readonly choice: WyrChoice; readonly guess: WyrChoice },
): Promise<WyrOutcome> {
  return call(session, `/wyr/${encodeURIComponent(String(seq))}/answer`, postInit(input));
}

export function revealWyr(
  session: ServerSession,
  seq: number,
  input: { readonly sender: string },
): Promise<WyrOutcome> {
  return call(session, `/wyr/${encodeURIComponent(String(seq))}/reveal`, postInit(input));
}
