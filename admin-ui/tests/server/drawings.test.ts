// The pen's palette and limits are one contract with two copies: `wixy_server/livechat/drawings.py`
// (the server's) and `admin-ui/src/server/drawings.ts` (the browser's). The server's own test parses
// the TypeScript file; this test parses the Python one, so neither side can drift silently (the
// reaction-emoji drift guard's pattern, spec/server-chat/07-live-drawing.md §3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as drawings from "../../src/server/drawings";

const PY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "wixy_server", "livechat", "drawings.py");
const py = readFileSync(PY_PATH, "utf-8");

/** The raw text between a module-level tuple's parentheses (its `# comments` included — the
 * colour entries are themselves "#rrggbb", so callers pick out quoted strings, never strip `#`). */
function pyTuple(name: string): string {
  const match = new RegExp(`^${name}: tuple\\[[^\\]]+\\] = \\(([\\s\\S]*?)\\)\\s*$`, "m").exec(py);
  if (match === null) throw new Error(`${name} not found in drawings.py`);
  return match[1]!;
}

function pyNumber(name: string): number {
  const match = new RegExp(`^${name}(?:: [a-z]+)? = (-?[0-9_.]+)\\s*$`, "m").exec(py);
  if (match === null) throw new Error(`${name} not found in drawings.py`);
  return Number(match[1]!.replaceAll("_", ""));
}

const LIMITS = [
  "MIN_COLUMN_WIDTH",
  "MAX_COLUMN_WIDTH",
  "MIN_POINT_X",
  "MAX_POINT_X_PAD",
  "MAX_POINT_Y_ABS",
  "MAX_POINTS_PER_STROKE",
  "MIN_POINTS_PER_STROKE",
  "MAX_STROKES_PER_DRAWING",
  "MAX_DRAWINGS_PER_ANCHOR",
  "MAX_LIVE_POINTS_PER_BATCH",
  "MAX_LIVE_BATCHES_PER_SECOND",
] as const;

describe("drawings.ts agrees with the server's drawings.py", () => {
  it("the palette is the same 8 colours, in the same order", () => {
    const colors = Array.from(pyTuple("DRAWING_COLORS").matchAll(/"([^"]*)"/g), (m) => m[1]);
    expect(colors).toHaveLength(8);
    expect([...drawings.DRAWING_COLORS]).toEqual(colors);
  });

  it("the thicknesses are the same four, in the same order", () => {
    const widths = pyTuple("DRAWING_WIDTHS").split(",").map((part) => part.trim()).filter(Boolean).map(Number);
    expect(widths).toEqual([2, 4, 8, 14]);
    expect([...drawings.DRAWING_WIDTHS]).toEqual(widths);
  });

  it.each(LIMITS)("%s matches", (name) => {
    expect(drawings[name]).toBe(pyNumber(name));
  });

  it("the parser really finds what it compares (a guard that finds nothing must fail, not pass)", () => {
    expect(() => pyNumber("NOT_A_REAL_LIMIT")).toThrow();
    expect(() => pyTuple("NOT_A_REAL_TUPLE")).toThrow();
  });
});

describe("drawings.ts on its own", () => {
  it("names every colour and thickness for screen readers", () => {
    for (const color of drawings.DRAWING_COLORS) expect(drawings.DRAWING_COLOR_LABELS[color]).toMatch(/\S/);
    for (const width of drawings.DRAWING_WIDTHS) expect(drawings.DRAWING_WIDTH_LABELS[width]).toMatch(/\S/);
    expect(new Set(Object.values(drawings.DRAWING_COLOR_LABELS)).size).toBe(8);
  });

  it("accepts exactly the palette and the thicknesses, with no normalisation", () => {
    for (const color of drawings.DRAWING_COLORS) expect(drawings.isDrawingColor(color)).toBe(true);
    for (const width of drawings.DRAWING_WIDTHS) expect(drawings.isDrawingWidth(width)).toBe(true);
    for (const near of ["#FF3B30", "#ff3b3", "ff3b30", "red", 4, null]) expect(drawings.isDrawingColor(near)).toBe(false);
    for (const near of [3, "4", 4.5, 0, null]) expect(drawings.isDrawingWidth(near)).toBe(false);
  });

  it("the default pen is on the palette", () => {
    expect(drawings.isDrawingColor(drawings.DEFAULT_DRAWING_COLOR)).toBe(true);
    expect(drawings.isDrawingWidth(drawings.DEFAULT_DRAWING_WIDTH)).toBe(true);
  });

  it("a new drawing starts well inside the server's y bound, so a stroke can never cross it", () => {
    expect(drawings.DRAWING_Y_SPLIT_PX).toBeLessThan(drawings.MAX_POINT_Y_ABS - 2_000);
  });
});
