// Live drawing — the client's record of stored and pending drawings, and the rules that
// reconcile it with the server (spec/server-chat/07-live-drawing.md §2, §4, §6). Pure data: no
// DOM, no network, no timers — `drawingSync.ts` drives it and `drawingLayer.ts` draws it.
//
// The rules that keep it honest:
// - The server's `GET /messages/{seq}/drawings` is the only authority on what exists. A
//   `message_updated` summary (`drawings: [{id, rev}]`) only ever TRIGGERS a fetch; it never
//   deletes anything by itself, because the stream and this client's own POST responses travel
//   on different connections and can arrive in either order.
// - A drawing is removed for being absent from a fetch only if the client already knew it
//   before that fetch was sent (`knownAtEpoch < requestEpoch`): a fetch the server answered
//   just before this client's own create committed must not delete the drawing it just made.
// - A fetch answer older than one already applied for the same message is dropped whole.
// - Own strokes are matched to the server's by `strokeId` (client-generated), so an answer that
//   races this client's own create response adopts the drawing instead of showing it twice.
// - Ids a delete has removed are remembered (numbers only — never content), so a stale answer
//   cannot bring the drawing back.

import type { DrawingStroke, DrawingSummary, StoredDrawing } from "./api/drawings";
import type { DrawPoint } from "./drawingGeometry";
import type { DrawingColor, DrawingWidth } from "./drawings";

/** `drawing`: under the finger right now. `pending`: finished, not yet confirmed stored.
 * `stored`: confirmed by the server (its answer to our write, or a fetch). */
export type StrokeState = "drawing" | "pending" | "stored";

export interface ModelStroke {
  readonly strokeId: string;
  readonly color: DrawingColor;
  readonly width: DrawingWidth;
  points: DrawPoint[];
  state: StrokeState;
  /** A write carrying this stroke has left the client at least once (it may have landed). */
  sent: boolean;
}

export interface ModelDrawing {
  /** Stable local key: `c:<clientId>` for a drawing made here, `s:<id>` for one fetched. */
  readonly key: string;
  id: number | null;
  /** Only for a drawing made on this screen (the `POST /drawings` idempotency key). */
  readonly clientId: string | null;
  readonly own: boolean;
  readonly anchorSeq: number;
  readonly columnWidth: number;
  readonly sender: string;
  rev: number;
  strokes: ModelStroke[];
  /** The epoch at which the client first knew this drawing's server id (see the header). */
  knownAtEpoch: number;
}

export interface ApplyResult {
  /** Keys whose strokes may have changed (re-render them). */
  readonly changed: readonly string[];
  /** Drawings removed because the server no longer has them. */
  readonly removed: readonly ModelDrawing[];
  /** Stroke ids now stored (their live previews are over). */
  readonly storedStrokeIds: readonly string[];
  /** True when the answer was older than one already applied, and so ignored. */
  readonly stale: boolean;
}

export interface NewOwnDrawing {
  readonly clientId: string;
  readonly anchorSeq: number;
  readonly columnWidth: number;
  readonly sender: string;
}

export interface DrawingModel {
  /** Advances and returns the epoch clock (see the header). */
  nextEpoch(): number;
  get(key: string): ModelDrawing | undefined;
  byId(id: number): ModelDrawing | undefined;
  forAnchor(seq: number): ModelDrawing[];
  all(): IterableIterator<ModelDrawing>;
  anchorSeqs(): number[];
  hasOwnClientId(clientId: string): boolean;
  /** Any drawing currently holds a stroke with this id (stored, pending or being drawn). */
  hasStroke(strokeId: string): boolean;
  addOwn(input: NewOwnDrawing): ModelDrawing;
  /** Our create answered `id`/`rev`. Returns the drawing (merged into one a fetch already
   * adopted under the same id, if that happened first). */
  confirmCreate(key: string, id: number, rev: number): ModelDrawing | undefined;
  /** Our append (or the create) stored `strokeId`; `rev` is the server's new revision. */
  confirmStroke(key: string, strokeId: string, rev: number): void;
  /** Moves `strokeIds` (in order) out of `from` into a new own drawing on the same anchor and
   * scale — the answer to a drawing that filled up (409) with strokes still to store. */
  split(fromKey: string, strokeIds: readonly string[], clientId: string): ModelDrawing | undefined;
  remove(key: string): ModelDrawing | undefined;
  /** Puts back a drawing a failed delete had removed (and forgets its tombstone). */
  restore(drawing: ModelDrawing): void;
  removeAnchor(seq: number): ModelDrawing[];
  tombstone(id: number): void;
  untombstone(id: number): void;
  isTombstoned(id: number): boolean;
  /** Does `summaries` (a message's `drawings` field) say something this client does not know? */
  needsFetch(seq: number, summaries: readonly DrawingSummary[]): boolean;
  applyFetched(seq: number, drawings: readonly StoredDrawing[], requestEpoch: number): ApplyResult;
  /** Forget per-message fetch bookkeeping (the message is gone). */
  forgetAnchor(seq: number): void;
  clear(): void;
}

function samePoints(a: readonly DrawPoint[], b: readonly DrawPoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i]!;
    const q = b[i]!;
    if (p[0] !== q[0] || p[1] !== q[1]) return false;
  }
  return true;
}

function storedStroke(stroke: DrawingStroke): ModelStroke {
  return {
    strokeId: stroke.strokeId,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.slice(),
    state: "stored",
    sent: true,
  };
}

export function createDrawingModel(): DrawingModel {
  const byKey = new Map<string, ModelDrawing>();
  const idToKey = new Map<number, string>();
  const tombstones = new Set<number>();
  const lastApplied = new Map<number, number>();
  let epoch = 0;

  function forAnchor(seq: number): ModelDrawing[] {
    const out: ModelDrawing[] = [];
    for (const drawing of byKey.values()) if (drawing.anchorSeq === seq) out.push(drawing);
    // Stored ids in server order, then drawings not yet created, in the order they were made.
    return out.sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
  }

  function remove(key: string): ModelDrawing | undefined {
    const drawing = byKey.get(key);
    if (drawing === undefined) return undefined;
    byKey.delete(key);
    if (drawing.id !== null && idToKey.get(drawing.id) === key) idToKey.delete(drawing.id);
    return drawing;
  }

  function setId(drawing: ModelDrawing, id: number): void {
    drawing.id = id;
    idToKey.set(id, drawing.key);
  }

  return {
    nextEpoch(): number {
      epoch += 1;
      return epoch;
    },
    get: (key) => byKey.get(key),
    byId(id: number): ModelDrawing | undefined {
      const key = idToKey.get(id);
      return key === undefined ? undefined : byKey.get(key);
    },
    forAnchor,
    all: () => byKey.values(),
    anchorSeqs(): number[] {
      return Array.from(new Set(Array.from(byKey.values(), (drawing) => drawing.anchorSeq)));
    },
    hasOwnClientId(clientId: string): boolean {
      return byKey.has(`c:${clientId}`);
    },
    hasStroke(strokeId: string): boolean {
      for (const drawing of byKey.values()) {
        if (drawing.strokes.some((stroke) => stroke.strokeId === strokeId)) return true;
      }
      return false;
    },
    addOwn(input: NewOwnDrawing): ModelDrawing {
      const drawing: ModelDrawing = {
        key: `c:${input.clientId}`,
        id: null,
        clientId: input.clientId,
        own: true,
        anchorSeq: input.anchorSeq,
        columnWidth: input.columnWidth,
        sender: input.sender,
        rev: 0,
        strokes: [],
        knownAtEpoch: Number.POSITIVE_INFINITY,
      };
      byKey.set(drawing.key, drawing);
      return drawing;
    },
    confirmCreate(key: string, id: number, rev: number): ModelDrawing | undefined {
      const drawing = byKey.get(key);
      if (drawing === undefined) return undefined;
      const adoptedKey = idToKey.get(id);
      if (adoptedKey !== undefined && adoptedKey !== key) {
        // A fetch answered first and was filed under a different key: fold it into ours.
        const adopted = byKey.get(adoptedKey);
        byKey.delete(adoptedKey);
        if (adopted !== undefined) {
          for (const stroke of adopted.strokes) {
            const mine = drawing.strokes.find((candidate) => candidate.strokeId === stroke.strokeId);
            if (mine === undefined) drawing.strokes.push(stroke);
            else mine.state = "stored";
          }
          drawing.rev = Math.max(drawing.rev, adopted.rev);
        }
      }
      if (drawing.id === null) {
        setId(drawing, id);
        drawing.knownAtEpoch = epoch + 1;
        epoch += 1;
      }
      drawing.rev = Math.max(drawing.rev, rev);
      return drawing;
    },
    confirmStroke(key: string, strokeId: string, rev: number): void {
      const drawing = byKey.get(key);
      if (drawing === undefined) return;
      const stroke = drawing.strokes.find((candidate) => candidate.strokeId === strokeId);
      if (stroke !== undefined && stroke.state !== "drawing") stroke.state = "stored";
      drawing.rev = Math.max(drawing.rev, rev);
    },
    split(fromKey: string, strokeIds: readonly string[], clientId: string): ModelDrawing | undefined {
      const from = byKey.get(fromKey);
      if (from === undefined) return undefined;
      const moving = new Set(strokeIds);
      const to: ModelDrawing = {
        key: `c:${clientId}`,
        id: null,
        clientId,
        own: true,
        anchorSeq: from.anchorSeq,
        columnWidth: from.columnWidth,
        sender: from.sender,
        rev: 0,
        strokes: [],
        knownAtEpoch: Number.POSITIVE_INFINITY,
      };
      for (const strokeId of strokeIds) {
        const stroke = from.strokes.find((candidate) => candidate.strokeId === strokeId);
        if (stroke !== undefined) to.strokes.push({ ...stroke, sent: false });
      }
      from.strokes = from.strokes.filter((stroke) => !moving.has(stroke.strokeId));
      byKey.set(to.key, to);
      return to;
    },
    remove,
    restore(drawing: ModelDrawing): void {
      if (drawing.id !== null) {
        tombstones.delete(drawing.id);
        idToKey.set(drawing.id, drawing.key);
      }
      byKey.set(drawing.key, drawing);
    },
    removeAnchor(seq: number): ModelDrawing[] {
      const removed: ModelDrawing[] = [];
      for (const drawing of forAnchor(seq)) {
        remove(drawing.key);
        removed.push(drawing);
      }
      lastApplied.delete(seq);
      return removed;
    },
    tombstone(id: number): void {
      tombstones.add(id);
    },
    untombstone(id: number): void {
      tombstones.delete(id);
    },
    isTombstoned: (id) => tombstones.has(id),
    needsFetch(seq: number, summaries: readonly DrawingSummary[]): boolean {
      const listed = new Set<number>();
      for (const summary of summaries) {
        listed.add(summary.id);
        if (tombstones.has(summary.id)) continue;
        const key = idToKey.get(summary.id);
        const drawing = key === undefined ? undefined : byKey.get(key);
        if (drawing === undefined) return true;
        // Only this screen appends to its own drawing, so every revision up to the number of
        // strokes it has SENT is already accounted for (a sent write may have landed).
        const accounted = drawing.own
          ? Math.max(drawing.rev, drawing.strokes.filter((stroke) => stroke.sent).length)
          : drawing.rev;
        if (summary.rev > accounted) return true;
      }
      for (const drawing of byKey.values()) {
        if (drawing.anchorSeq === seq && drawing.id !== null && !listed.has(drawing.id)) return true;
      }
      return false;
    },
    applyFetched(seq: number, drawings: readonly StoredDrawing[], requestEpoch: number): ApplyResult {
      if (requestEpoch <= (lastApplied.get(seq) ?? 0)) {
        return { changed: [], removed: [], storedStrokeIds: [], stale: true };
      }
      lastApplied.set(seq, requestEpoch);
      const changed: string[] = [];
      const storedStrokeIds: string[] = [];
      const present = new Set<number>();
      for (const fetched of drawings) {
        if (tombstones.has(fetched.id)) continue;
        present.add(fetched.id);
        for (const stroke of fetched.strokes) storedStrokeIds.push(stroke.strokeId);
        let drawing = (() => {
          const key = idToKey.get(fetched.id);
          return key === undefined ? undefined : byKey.get(key);
        })();
        if (drawing === undefined) {
          // Our own create may have landed before its answer reached us: adopt by stroke id.
          const fetchedIds = new Set(fetched.strokes.map((stroke) => stroke.strokeId));
          drawing = Array.from(byKey.values()).find(
            (candidate) =>
              candidate.own
              && candidate.id === null
              && candidate.anchorSeq === seq
              && candidate.strokes.some((stroke) => fetchedIds.has(stroke.strokeId)),
          );
          if (drawing !== undefined) {
            setId(drawing, fetched.id);
            drawing.knownAtEpoch = requestEpoch;
          }
        }
        if (drawing === undefined) {
          const created: ModelDrawing = {
            key: `s:${fetched.id}`,
            id: fetched.id,
            clientId: null,
            own: false,
            anchorSeq: seq,
            columnWidth: fetched.columnWidth,
            sender: fetched.sender,
            rev: fetched.rev,
            strokes: fetched.strokes.map(storedStroke),
            knownAtEpoch: requestEpoch,
          };
          byKey.set(created.key, created);
          idToKey.set(fetched.id, created.key);
          changed.push(created.key);
          continue;
        }
        const target = drawing;
        const fetchedIds = new Set(fetched.strokes.map((stroke) => stroke.strokeId));
        const merged = fetched.strokes.map((stroke) => {
          const local = target.strokes.find((candidate) => candidate.strokeId === stroke.strokeId);
          if (local !== undefined && local.state !== "drawing" && samePoints(local.points, stroke.points)) {
            local.state = "stored";
            local.sent = true;
            return local;
          }
          return storedStroke(stroke);
        });
        // Strokes the server does not have yet (still being drawn, or on their way) stay, after it.
        const localOnly = target.strokes.filter((stroke) => !fetchedIds.has(stroke.strokeId));
        target.strokes = [...merged, ...localOnly];
        target.rev = Math.max(target.rev, fetched.rev);
        changed.push(target.key);
      }
      const removed: ModelDrawing[] = [];
      for (const drawing of forAnchor(seq)) {
        if (drawing.id === null || present.has(drawing.id)) continue;
        if (drawing.knownAtEpoch >= requestEpoch) continue;
        remove(drawing.key);
        tombstones.add(drawing.id);
        removed.push(drawing);
      }
      return { changed, removed, storedStrokeIds, stale: false };
    },
    forgetAnchor(seq: number): void {
      lastApplied.delete(seq);
    },
    clear(): void {
      byKey.clear();
      idToKey.clear();
      tombstones.clear();
      lastApplied.clear();
    },
  };
}
