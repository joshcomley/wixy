// Live drawing's HTTP surface (spec/server-chat/07-live-drawing.md §4) — this area's own
// `server/api/<area>.ts`, calling through `serverFetch` so the token/401 handling stays in one
// place (`http.ts`). Every response the client renders from is validated here first: a drawing's
// path data is later built only from these checked numbers (§1), never from a server string.

import type { DrawPoint } from "../drawingGeometry";
import {
  MAX_COLUMN_WIDTH,
  MAX_LIVE_POINTS_PER_BATCH,
  MAX_POINT_X_PAD,
  MAX_POINT_Y_ABS,
  MAX_POINTS_PER_STROKE,
  MIN_COLUMN_WIDTH,
  MIN_POINT_X,
  isDrawingColor,
  isDrawingWidth,
  DEFAULT_DRAWING_COLOR,
  DEFAULT_DRAWING_WIDTH,
  type DrawingColor,
  type DrawingWidth,
} from "../drawings";
import type { ServerSession } from "../types";
import { ServerLockedError, serverFetch } from "./http";

/** What a `Message` carries about its drawings (§4): enough to notice "there is a drawing here I
 * don't have, or it changed" — never the strokes. */
export interface DrawingSummary {
  readonly id: number;
  readonly rev: number;
}

export interface DrawingStroke {
  readonly strokeId: string;
  readonly color: DrawingColor;
  readonly width: DrawingWidth;
  readonly points: readonly DrawPoint[];
}

/** One drawing as `GET /messages/{seq}/drawings` returns it; strokes in stored (`ord`) order. */
export interface StoredDrawing {
  readonly id: number;
  readonly rev: number;
  readonly sender: string;
  readonly columnWidth: number;
  readonly strokes: readonly DrawingStroke[];
}

/** An in-progress stroke's batch, as the drawer posts it and every stream relays it (§4). */
export interface LiveFrame {
  readonly drawingClientId: string;
  readonly anchorSeq: number;
  readonly columnWidth: number;
  readonly strokeId: string;
  readonly batch: number;
  readonly color: DrawingColor;
  readonly width: DrawingWidth;
  readonly points: readonly DrawPoint[];
  readonly cancel: boolean;
}

/** A write's outcome. `retry` is everything that says nothing about the request itself — a
 * dropped connection, a timeout, a 5xx, a 408/429, or a 403 (wixy's own drawing routes never
 * answer 403, so it can only come from Cloudflare Access or a WAF in front of it). Writes are
 * idempotent (`clientId`, `strokeId`), so retrying one can never duplicate it. A 401 is never a
 * result: `serverFetch` throws `ServerLockedError`, which the caller turns into a lock. */
export type CreateDrawingResult =
  | { readonly kind: "ok"; readonly id: number; readonly rev: number }
  /** The anchor message no longer exists (deleted, or wiped). */
  | { readonly kind: "not_found" }
  /** 409: the anchor already carries the maximum number of drawings. */
  | { readonly kind: "full" }
  /** Any other 4xx: the server judged this exact payload and would judge it the same again. */
  | { readonly kind: "invalid"; readonly status: number }
  | { readonly kind: "retry" };

export type AppendStrokeResult =
  | { readonly kind: "ok"; readonly rev: number }
  /** The drawing no longer exists — deleted by either person, or with its anchor message. */
  | { readonly kind: "not_found" }
  /** 409: the drawing already holds the maximum number of strokes. */
  | { readonly kind: "full" }
  | { readonly kind: "invalid"; readonly status: number }
  | { readonly kind: "retry" };

export type DeleteDrawingResult =
  | { readonly kind: "ok" }
  | { readonly kind: "retry" }
  | { readonly kind: "failed"; readonly status: number };

export type LivePostResult =
  | { readonly kind: "ok" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "failed" };

export interface CreateDrawingInput {
  readonly clientId: string;
  readonly anchorSeq: number;
  readonly columnWidth: number;
  readonly sender: string;
  readonly deviceId: string;
  readonly stroke: DrawingStroke;
}

/** A live batch must never hold the relay up behind a slow request: at most one is in flight
 * (`drawingLive.ts`), so a hung one would otherwise freeze the other screen's preview for the
 * whole ordinary 10 s timeout. */
const LIVE_TIMEOUT_MS = 4_000;

function isRetryStatus(status: number): boolean {
  return status >= 500 || status === 403 || status === 408 || status === 429;
}

function strokeBody(stroke: DrawingStroke): Record<string, unknown> {
  return {
    strokeId: stroke.strokeId,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map((point) => [point[0], point[1]]),
  };
}

async function postJson(
  session: ServerSession,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<Response | null> {
  try {
    return await serverFetch(
      path,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      session,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** `POST /drawings` — creates the drawing with its first stroke. A repeated `clientId` answers
 * 200 with the same drawing, so a retry after a lost response is safe. */
export async function createDrawing(session: ServerSession, input: CreateDrawingInput): Promise<CreateDrawingResult> {
  const response = await postJson(session, "/drawings", {
    clientId: input.clientId,
    anchorSeq: input.anchorSeq,
    columnWidth: input.columnWidth,
    sender: input.sender,
    deviceId: input.deviceId,
    stroke: strokeBody(input.stroke),
  });
  if (response === null) return { kind: "retry" };
  if (response.status === 200 || response.status === 201) {
    const body = (await readJson(response)) as { id?: unknown; rev?: unknown } | null;
    const id = positiveInt(body?.id);
    const rev = positiveInt(body?.rev);
    // A 2xx the client cannot read says nothing reliable; the idempotent retry will read it.
    if (id === null || rev === null) return { kind: "retry" };
    return { kind: "ok", id, rev };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 409) return { kind: "full" };
  if (isRetryStatus(response.status)) return { kind: "retry" };
  return { kind: "invalid", status: response.status };
}

/** `POST /drawings/{id}/strokes` — a repeated `strokeId` is a no-op 200. */
export async function appendStroke(
  session: ServerSession,
  drawingId: number,
  stroke: DrawingStroke,
): Promise<AppendStrokeResult> {
  const response = await postJson(session, `/drawings/${encodeURIComponent(String(drawingId))}/strokes`, strokeBody(stroke));
  if (response === null) return { kind: "retry" };
  if (response.status === 200) {
    const body = (await readJson(response)) as { rev?: unknown } | null;
    const rev = positiveInt(body?.rev);
    if (rev === null) return { kind: "retry" };
    return { kind: "ok", rev };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 409) return { kind: "full" };
  if (isRetryStatus(response.status)) return { kind: "retry" };
  return { kind: "invalid", status: response.status };
}

/** `DELETE /drawings/{id}` — 204, idempotent (deleting a drawing that is already gone is 204 too). */
export async function deleteDrawing(session: ServerSession, drawingId: number): Promise<DeleteDrawingResult> {
  let response: Response;
  try {
    response = await serverFetch(`/drawings/${encodeURIComponent(String(drawingId))}`, { method: "DELETE" }, session);
  } catch (error) {
    if (error instanceof ServerLockedError) throw error;
    return { kind: "retry" };
  }
  if (response.ok) return { kind: "ok" };
  if (isRetryStatus(response.status)) return { kind: "retry" };
  return { kind: "failed", status: response.status };
}

/** `POST /drawings/live` — one in-progress batch, relayed to every open stream and never stored.
 * Lossy by design: a failure is just a missed preview frame. */
export async function postLiveBatch(
  session: ServerSession,
  frame: Omit<LiveFrame, "cancel"> & { readonly cancel?: boolean },
): Promise<LivePostResult> {
  const response = await postJson(
    session,
    "/drawings/live",
    {
      drawingClientId: frame.drawingClientId,
      anchorSeq: frame.anchorSeq,
      columnWidth: frame.columnWidth,
      strokeId: frame.strokeId,
      batch: frame.batch,
      color: frame.color,
      width: frame.width,
      points: frame.points.map((point) => [point[0], point[1]]),
      ...(frame.cancel === true ? { cancel: true } : {}),
    },
    LIVE_TIMEOUT_MS,
  );
  if (response === null) return { kind: "failed" };
  if (response.ok) return { kind: "ok" };
  if (response.status === 429) {
    const body = (await readJson(response)) as { retryAfterS?: unknown } | null;
    const header = Number(response.headers.get("Retry-After"));
    const seconds = typeof body?.retryAfterS === "number" && Number.isFinite(body.retryAfterS)
      ? body.retryAfterS
      : Number.isFinite(header) && header > 0 ? header : 1;
    return { kind: "rate_limited", retryAfterMs: Math.min(10_000, Math.max(250, seconds * 1000)) };
  }
  return { kind: "failed" };
}

// -- Validation of everything read back ---------------------------------------------------

function isPointPair(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && Number.isSafeInteger(value[0])
    && Number.isSafeInteger(value[1]);
}

/** Integer pairs inside the server's own bounds for a drawing of `columnWidth`, or null. */
function parsePoints(value: unknown, columnWidth: number, minCount: number, maxCount: number): DrawPoint[] | null {
  if (!Array.isArray(value) || value.length < minCount || value.length > maxCount) return null;
  const points: DrawPoint[] = [];
  for (const entry of value as unknown[]) {
    if (!isPointPair(entry)) return null;
    const [x, y] = entry;
    if (x < MIN_POINT_X || x > columnWidth + MAX_POINT_X_PAD) return null;
    if (y < -MAX_POINT_Y_ABS || y > MAX_POINT_Y_ABS) return null;
    points.push([x, y]);
  }
  return points;
}

function parseColumnWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_COLUMN_WIDTH && value <= MAX_COLUMN_WIDTH
    ? value
    : null;
}

function parseId(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

/** One drawing from `GET /messages/{seq}/drawings`, or null when it is malformed. A malformed
 * STROKE is dropped on its own (the rest of the drawing is still real). */
export function parseStoredDrawing(value: unknown): StoredDrawing | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = positiveInt(record["id"]);
  const rev = positiveInt(record["rev"]);
  const columnWidth = parseColumnWidth(record["columnWidth"]);
  const sender = typeof record["sender"] === "string" ? record["sender"] : "";
  if (id === null || rev === null || columnWidth === null || !Array.isArray(record["strokes"])) return null;
  const strokes: DrawingStroke[] = [];
  for (const raw of record["strokes"] as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const stroke = raw as Record<string, unknown>;
    const strokeId = parseId(stroke["strokeId"], 64);
    const color = stroke["color"];
    const width = stroke["width"];
    const points = parsePoints(stroke["points"], columnWidth, 1, MAX_POINTS_PER_STROKE);
    if (strokeId === null || !isDrawingColor(color) || !isDrawingWidth(width) || points === null) continue;
    strokes.push({ strokeId, color, width, points });
  }
  return { id, rev, sender, columnWidth, strokes };
}

/** `GET /messages/{seq}/drawings` — every drawing anchored to `seq`, with strokes. Throws on
 * any failure (`ServerLockedError` for a 401); an unknown or deleted `seq` is simply `[]`. */
export async function getDrawings(session: ServerSession, seq: number): Promise<readonly StoredDrawing[]> {
  const response = await serverFetch(`/messages/${encodeURIComponent(String(seq))}/drawings`, { method: "GET" }, session);
  if (!response.ok) throw new Error(`Couldn't load drawings (${response.status}).`);
  const body = (await readJson(response)) as { drawings?: unknown } | null;
  if (body === null || !Array.isArray(body.drawings)) throw new Error("Couldn't read drawings.");
  const drawings: StoredDrawing[] = [];
  for (const raw of body.drawings as unknown[]) {
    const drawing = parseStoredDrawing(raw);
    if (drawing !== null) drawings.push(drawing);
  }
  return drawings;
}

/** The `drawings` summary list of a `Message`, or null when the message predates drawings (a
 * blue/green overlap with an older server) or the field is malformed — "unknown", never "none",
 * so a missing field can never be read as "every drawing here was deleted". */
export function parseDrawingSummaries(value: unknown): DrawingSummary[] | null {
  if (!Array.isArray(value)) return null;
  const summaries: DrawingSummary[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const id = positiveInt(record["id"]);
    const rev = positiveInt(record["rev"]);
    if (id === null || rev === null) return null;
    summaries.push({ id, rev });
  }
  return summaries;
}

/** A `drawing_live` stream frame (§4), or null when anything about it is off — a live frame is a
 * lossy preview, so dropping a bad one costs nothing. A cancel carries no points. */
export function parseLiveFrame(value: unknown): LiveFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const drawingClientId = parseId(record["drawingClientId"], 128);
  const strokeId = parseId(record["strokeId"], 128);
  const anchorSeq = positiveInt(record["anchorSeq"]);
  const columnWidth = parseColumnWidth(record["columnWidth"]);
  const batch = record["batch"];
  const cancel = record["cancel"] === true;
  if (
    drawingClientId === null
    || strokeId === null
    || anchorSeq === null
    || columnWidth === null
    || typeof batch !== "number"
    || !Number.isSafeInteger(batch)
    || batch < 0
  ) {
    return null;
  }
  if (cancel) {
    return {
      drawingClientId,
      anchorSeq,
      columnWidth,
      strokeId,
      batch,
      color: isDrawingColor(record["color"]) ? record["color"] : DEFAULT_DRAWING_COLOR,
      width: isDrawingWidth(record["width"]) ? record["width"] : DEFAULT_DRAWING_WIDTH,
      points: [],
      cancel: true,
    };
  }
  const color = record["color"];
  const width = record["width"];
  const points = parsePoints(record["points"], columnWidth, 1, MAX_LIVE_POINTS_PER_BATCH);
  if (!isDrawingColor(color) || !isDrawingWidth(width) || points === null) return null;
  return { drawingClientId, anchorSeq, columnWidth, strokeId, batch, color, width, points, cancel: false };
}
