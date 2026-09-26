// Live drawing's HTTP surface (spec/server-chat/07-live-drawing.md §4): the exact request each
// route gets, how every answer maps to a verdict ("retry" only when the answer says nothing about
// the request itself), and the validation of everything read back — a drawing is only ever drawn
// from checked numbers (§1).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendStroke,
  createDrawing,
  deleteDrawing,
  getDrawings,
  parseDrawingSummaries,
  parseLiveFrame,
  parseStoredDrawing,
  postLiveBatch,
  type DrawingStroke,
} from "../../src/server/api/drawings";
import { ServerLockedError } from "../../src/server/api/http";
import type { ServerSession } from "../../src/server/types";

const SESSION: ServerSession = { token: "tok", expiresAt: 9_999_999_999 };
const STROKE: DrawingStroke = { strokeId: "stroke-0001", color: "#ff3b30", width: 4, points: [[1, 2], [3, 4]] };
const CREATE = {
  clientId: "client-0001",
  anchorSeq: 12,
  columnWidth: 310,
  sender: "Alice",
  deviceId: "device-0001",
  stroke: STROKE,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function lastRequest(): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
}

describe("createDrawing (POST /drawings)", () => {
  it("posts exactly the spec's body with the unlock token", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: 41, rev: 1 }, { status: 201 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "ok", id: 41, rev: 1 });
    const { url, init, body } = lastRequest();
    expect(url).toBe("/api/admin/server/drawings");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Wixy-Server-Token")).toBe("tok");
    expect(body).toEqual({
      clientId: "client-0001",
      anchorSeq: 12,
      columnWidth: 310,
      sender: "Alice",
      deviceId: "device-0001",
      stroke: { strokeId: "stroke-0001", color: "#ff3b30", width: 4, points: [[1, 2], [3, 4]] },
    });
  });

  it("a repeated client id (200) is the same drawing", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: 41, rev: 3 }, { status: 200 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "ok", id: 41, rev: 3 });
  });

  it("maps the verdicts: 404 gone, 409 full, other 4xx invalid", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "not_found" });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "full" }, { status: 409 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "full" });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid" }, { status: 422 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "invalid", status: 422 });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 400 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "invalid", status: 400 });
  });

  it.each([500, 502, 503, 408, 429, 403])("a %i says nothing about the stroke: retry", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("", { status }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "retry" });
  });

  it("a dropped connection, or a 2xx whose body cannot be read, is retry", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "retry" });
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 201 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "retry" });
    fetchMock.mockResolvedValueOnce(Response.json({ id: 0, rev: 1 }, { status: 201 }));
    await expect(createDrawing(SESSION, CREATE)).resolves.toEqual({ kind: "retry" });
  });

  it("a 401 locks", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(createDrawing(SESSION, CREATE)).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("appendStroke (POST /drawings/{id}/strokes)", () => {
  it("posts the stroke alone to the drawing's route", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ rev: 2 }));
    await expect(appendStroke(SESSION, 41, STROKE)).resolves.toEqual({ kind: "ok", rev: 2 });
    const { url, body } = lastRequest();
    expect(url).toBe("/api/admin/server/drawings/41/strokes");
    expect(body).toEqual({ strokeId: "stroke-0001", color: "#ff3b30", width: 4, points: [[1, 2], [3, 4]] });
  });

  it("maps 404 (deleted), 409 (full), 422, 5xx and a network failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(appendStroke(SESSION, 41, STROKE)).resolves.toEqual({ kind: "not_found" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 409 }));
    await expect(appendStroke(SESSION, 41, STROKE)).resolves.toEqual({ kind: "full" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 422 }));
    await expect(appendStroke(SESSION, 41, STROKE)).resolves.toEqual({ kind: "invalid", status: 422 });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(appendStroke(SESSION, 41, STROKE)).resolves.toEqual({ kind: "retry" });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(appendStroke(SESSION, 41, STROKE)).resolves.toEqual({ kind: "retry" });
  });
});

describe("deleteDrawing (DELETE /drawings/{id})", () => {
  it("204 is ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteDrawing(SESSION, 41)).resolves.toEqual({ kind: "ok" });
    const { url, init } = lastRequest();
    expect(url).toBe("/api/admin/server/drawings/41");
    expect(init.method).toBe("DELETE");
  });

  it("an unknown outcome is retry, a definite refusal is failed, a 401 locks", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }));
    await expect(deleteDrawing(SESSION, 41)).resolves.toEqual({ kind: "retry" });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(deleteDrawing(SESSION, 41)).resolves.toEqual({ kind: "retry" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 400 }));
    await expect(deleteDrawing(SESSION, 41)).resolves.toEqual({ kind: "failed", status: 400 });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(deleteDrawing(SESSION, 41)).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("postLiveBatch (POST /drawings/live)", () => {
  const FRAME = {
    drawingClientId: "client-0001",
    anchorSeq: 12,
    columnWidth: 310,
    strokeId: "stroke-0001",
    batch: 3,
    color: "#ff3b30" as const,
    width: 4 as const,
    points: [[1, 2], [3, 4]] as Array<[number, number]>,
  };

  it("posts the batch; `cancel` is only sent when withdrawing a stroke", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "ok" });
    expect(lastRequest().url).toBe("/api/admin/server/drawings/live");
    expect(lastRequest().body).toEqual(FRAME);
    await postLiveBatch(SESSION, { ...FRAME, points: [], cancel: true });
    expect(lastRequest().body).toEqual({ ...FRAME, points: [], cancel: true });
  });

  it("a 429 pauses for the server's retryAfterS (else Retry-After), clamped to 0.25-10 s", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "rate_limited", retryAfterS: 2 }, { status: 429 }));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 2_000 });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "3" } }));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 3_000 });
    fetchMock.mockResolvedValueOnce(Response.json({ retryAfterS: 60 }, { status: 429 }));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 10_000 });
    fetchMock.mockResolvedValueOnce(Response.json({ retryAfterS: 0 }, { status: 429 }));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 250 });
  });

  it("anything else is a lost frame (lossy by design); a 401 still locks", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "failed" });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(postLiveBatch(SESSION, FRAME)).resolves.toEqual({ kind: "failed" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(postLiveBatch(SESSION, FRAME)).rejects.toBeInstanceOf(ServerLockedError);
  });
});

describe("getDrawings (GET /messages/{seq}/drawings) and what it accepts", () => {
  const GOOD = {
    id: 9,
    rev: 2,
    sender: "Bob",
    columnWidth: 310,
    strokes: [
      { strokeId: "s1", color: "#0a84ff", width: 8, points: [[1, 2], [3, 4]] },
      { strokeId: "s2", color: "#ffffff", width: 2, points: [[-50, -20000], [360, 20000]] },
    ],
  };

  it("returns the validated drawings", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ drawings: [GOOD] }));
    await expect(getDrawings(SESSION, 12)).resolves.toEqual([GOOD]);
    expect(lastRequest().url).toBe("/api/admin/server/messages/12/drawings");
  });

  it("drops a malformed drawing but keeps the valid ones; drops a malformed stroke but keeps its drawing", async () => {
    const badStroke = { ...GOOD, id: 10, strokes: [...GOOD.strokes, { strokeId: "s3", color: "red", width: 8, points: [[1, 2]] }] };
    fetchMock.mockResolvedValueOnce(Response.json({ drawings: [{ id: "x" }, badStroke] }));
    const drawings = await getDrawings(SESSION, 12);
    expect(drawings.map((d) => d.id)).toEqual([10]);
    expect(drawings[0]?.strokes.map((s) => s.strokeId)).toEqual(["s1", "s2"]);
  });

  it("throws on a failure (a later summary retries) and locks on a 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(getDrawings(SESSION, 12)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(Response.json({ nope: [] }));
    await expect(getDrawings(SESSION, 12)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(getDrawings(SESSION, 12)).rejects.toBeInstanceOf(ServerLockedError);
  });

  it("rejects bad ids, revisions and column widths", () => {
    for (const bad of [{ id: 0 }, { id: 1.5 }, { rev: 0 }, { columnWidth: 150 }, { columnWidth: 4001 }, { columnWidth: Number.NaN }, { strokes: "x" }]) {
      expect(parseStoredDrawing({ ...GOOD, ...bad })).toBeNull();
    }
    expect(parseStoredDrawing(null)).toBeNull();
  });

  it("drops strokes with an unknown colour, a disallowed width, a bad point or id, or too many points", () => {
    const withStroke = (stroke: Record<string, unknown>) => parseStoredDrawing({ ...GOOD, strokes: [stroke] })?.strokes ?? [];
    const base = { strokeId: "s1", color: "#0a84ff", width: 8, points: [[1, 2], [3, 4]] };
    expect(withStroke(base)).toHaveLength(1);
    for (const bad of [
      { color: "#FF3B30" },
      { color: "red" },
      { width: 5 },
      { width: "4" },
      { points: [[1.5, 2]] },
      { points: [[1, 2, 3]] },
      { points: [[-51, 0]] },
      { points: [[361, 0]] },
      { points: [[0, 20001]] },
      { points: "M0 0 L9 9" },
      { strokeId: "" },
      { strokeId: "x".repeat(65) },
      { points: Array.from({ length: 1001 }, () => [1, 1]) },
    ]) {
      expect(withStroke({ ...base, ...bad }), JSON.stringify(bad).slice(0, 60)).toHaveLength(0);
    }
  });
});

describe("parseDrawingSummaries (a Message's `drawings`)", () => {
  it("reads a list of {id, rev}", () => {
    expect(parseDrawingSummaries([{ id: 1, rev: 1 }, { id: 5, rev: 3 }])).toEqual([{ id: 1, rev: 1 }, { id: 5, rev: 3 }]);
    expect(parseDrawingSummaries([])).toEqual([]);
  });

  it("a missing or malformed field is UNKNOWN (null), never 'no drawings' — an older server must not delete anything", () => {
    for (const value of [undefined, null, {}, "x", [{ id: 1 }], [{ id: 0, rev: 1 }], [null]]) {
      expect(parseDrawingSummaries(value)).toBeNull();
    }
  });
});

describe("parseLiveFrame (a drawing_live frame)", () => {
  const LIVE = {
    drawingClientId: "client-0001",
    anchorSeq: 12,
    columnWidth: 310,
    strokeId: "stroke-0001",
    batch: 0,
    color: "#ff3b30",
    width: 4,
    points: [[1, 2]],
    cancel: false,
  };

  it("a valid frame round-trips", () => {
    expect(parseLiveFrame(LIVE)).toEqual(LIVE);
  });

  it("rejects anything off: batch, anchor, column, ids, colour, width, points", () => {
    for (const bad of [
      { batch: -1 },
      { batch: 1.5 },
      { anchorSeq: 0 },
      { columnWidth: 100 },
      { drawingClientId: "" },
      { strokeId: "x".repeat(129) },
      { color: "#000000" },
      { width: 3 },
      { points: [] },
      { points: Array.from({ length: 201 }, () => [1, 1]) },
      { points: [[1.2, 3]] },
      { points: [[400, 3]] },
    ]) {
      expect(parseLiveFrame({ ...LIVE, ...bad }), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
    expect(parseLiveFrame("x")).toBeNull();
    expect(parseLiveFrame(null)).toBeNull();
  });

  it("a cancel carries no points and needs no valid colour or width", () => {
    expect(parseLiveFrame({ ...LIVE, cancel: true, color: "junk", width: 99, points: "junk" })).toEqual({
      ...LIVE,
      cancel: true,
      color: "#ff3b30",
      width: 4,
      points: [],
    });
  });
});
