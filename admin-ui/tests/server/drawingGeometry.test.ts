// Live drawing's pure geometry (spec/server-chat/07-live-drawing.md §1, §3, §5): the uniform
// draw-space <-> viewer mapping, the anchor choice, the stroke simplification and its bounds, the
// svg box and path data, and Select mode's hit testing.

import { describe, expect, it } from "vitest";
import {
  chooseAnchor,
  declaredColumnWidth,
  distanceToPolyline,
  drawScale,
  hitTestDrawings,
  pathData,
  prepareStoredPoints,
  segmentsPathData,
  simplifyRdp,
  strokesBounds,
  svgBox,
  toDrawSpace,
  wirePoint,
  type DrawPoint,
} from "../../src/server/drawingGeometry";
import { MAX_POINTS_PER_STROKE, SELECT_HIT_RADIUS_PX } from "../../src/server/drawings";

describe("the draw-space <-> viewer mapping (§1)", () => {
  it("scale is the viewer's column over the drawer's; a degenerate input is 1, never 0 or NaN", () => {
    expect(drawScale(620, 310)).toBe(2);
    expect(drawScale(310, 310)).toBe(1);
    for (const [viewer, drawer] of [[0, 310], [310, 0], [-5, 310], [Number.NaN, 310]] as const) {
      expect(drawScale(viewer, drawer)).toBe(1);
    }
  });

  it("a new drawing declares its drawer's column, clamped into the server's 200-4000 range", () => {
    expect(declaredColumnWidth(310.456)).toBe(310.46);
    expect(declaredColumnWidth(150)).toBe(200);
    expect(declaredColumnWidth(5000)).toBe(4000);
  });

  it("maps a point relative to the column's left edge and the anchor's top, divided by the scale", () => {
    expect(toDrawSpace(130, 260, 10, 200, 1)).toEqual([120, 60]);
    expect(toDrawSpace(250, 320, 10, 200, 2)).toEqual([120, 60]);
  });

  it("is uniform: a shape drawn on a 310 px column and shown on 620 px is exactly twice as big in BOTH axes", () => {
    const drawn: DrawPoint[] = [[0, 0], [30, 0], [30, 30], [0, 30]].map(([x, y]) => toDrawSpace(x! + 10, y! + 200, 10, 200, 1));
    const bounds = strokesBounds([{ points: drawn, width: 4 }])!;
    const narrow = svgBox(bounds, 0, 0, drawScale(310, 310), -1000, 1000)!;
    const wide = svgBox(bounds, 0, 0, drawScale(620, 310), -1000, 1000)!;
    expect(wide.width).toBeCloseTo(narrow.width * 2, 9);
    expect(wide.height).toBeCloseTo(narrow.height * 2, 9);
    // The viewBox stays in draw space: the browser scales x, y AND the stroke width by s.
    expect(wide.viewBox).toEqual(narrow.viewBox);
    expect(wide.width / (wide.viewBox.maxX - wide.viewBox.minX)).toBeCloseTo(2, 9);
    expect(wide.height / (wide.viewBox.maxY - wide.viewBox.minY)).toBeCloseTo(2, 9);
  });

  it("wire points are integers inside the server's bounds", () => {
    expect(wirePoint([12.4, -7.6], 310)).toEqual([12, -8]);
    expect(wirePoint([-80, 0], 310)).toEqual([-50, 0]);
    expect(wirePoint([400, 0], 310.4)).toEqual([360, 0]);
    expect(wirePoint([0, 25_000], 310)).toEqual([0, 20_000]);
    expect(wirePoint([0, -25_000], 310)).toEqual([0, -20_000]);
  });
});

describe("the anchor (§1: the bubble whose top is the nearest at or above the start)", () => {
  const bubbles = [
    { seq: 3, top: 100 },
    { seq: 4, top: 180 },
    { seq: 5, top: 260 },
  ];

  it("picks the nearest bubble top above the point", () => {
    expect(chooseAnchor(bubbles, 200)?.seq).toBe(4);
    expect(chooseAnchor(bubbles, 1000)?.seq).toBe(5);
  });

  it("a point exactly on a bubble's top edge belongs to that bubble", () => {
    expect(chooseAnchor(bubbles, 180)?.seq).toBe(4);
  });

  it("above every bubble: the first one (the drawing's offset is then negative)", () => {
    expect(chooseAnchor(bubbles, 20)?.seq).toBe(3);
  });

  it("does not depend on the order it is given, ignores non-finite tops, and is null with nothing to draw on", () => {
    expect(chooseAnchor([...bubbles].reverse(), 200)?.seq).toBe(4);
    expect(chooseAnchor([{ seq: 9, top: Number.NaN }, ...bubbles], 200)?.seq).toBe(4);
    expect(chooseAnchor([], 200)).toBeNull();
  });
});

describe("stroke simplification (§3: Ramer-Douglas-Peucker at 0.75 px)", () => {
  it("keeps both ends and drops points that lie on the line", () => {
    const line: DrawPoint[] = [[0, 0], [1, 1], [2, 2], [3, 3], [10, 10]];
    expect(simplifyRdp(line, 0.75)).toEqual([[0, 0], [10, 10]]);
  });

  it("keeps a point just beyond the tolerance and drops one just inside it", () => {
    expect(simplifyRdp([[0, 0], [5, 0.76], [10, 0]], 0.75)).toEqual([[0, 0], [5, 0.76], [10, 0]]);
    expect(simplifyRdp([[0, 0], [5, 0.74], [10, 0]], 0.75)).toEqual([[0, 0], [10, 0]]);
  });

  it("returns short inputs unchanged (as copies) and never overflows the stack on a long stroke", () => {
    const two: DrawPoint[] = [[0, 0], [1, 1]];
    const copy = simplifyRdp(two, 0.75);
    expect(copy).toEqual(two);
    expect(copy).not.toBe(two);
    const long: DrawPoint[] = Array.from({ length: 10_000 }, (_, i) => [i, Math.sin(i / 3) * 40] as DrawPoint);
    expect(() => simplifyRdp(long, 0.75)).not.toThrow();
  });

  it("stored points are integers with no consecutive duplicates, staying within ~1.25 px of the raw stroke", () => {
    const arc: DrawPoint[] = Array.from({ length: 300 }, (_, i) => {
      const angle = (i / 299) * Math.PI;
      return [150 + Math.cos(angle) * 100, 100 + Math.sin(angle) * 100] as DrawPoint;
    });
    const stored = prepareStoredPoints(arc, 310);
    expect(stored.length).toBeLessThan(arc.length / 3);
    for (const [x, y] of stored) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    }
    for (let i = 1; i < stored.length; i += 1) {
      expect(stored[i]).not.toEqual(stored[i - 1]);
    }
    for (const [x, y] of arc) expect(distanceToPolyline(x, y, stored)).toBeLessThanOrEqual(1.25);
  });

  it("a single tap is a two-point dot; nothing, or only non-finite points, is nothing", () => {
    expect(prepareStoredPoints([[10.2, 20.7]], 310)).toEqual([[10, 21], [10, 21]]);
    expect(prepareStoredPoints([[10, 20], [10.1, 20.2], [10, 20]], 310)).toEqual([[10, 20], [10, 20]]);
    expect(prepareStoredPoints([], 310)).toEqual([]);
    expect(prepareStoredPoints([[Number.NaN, 1], [2, Number.POSITIVE_INFINITY]], 310)).toEqual([]);
  });

  it("never exceeds the server's point limit, however wild the scribble", () => {
    const zigzag: DrawPoint[] = Array.from({ length: 5_000 }, (_, i) => [i % 2 === 0 ? 0 : 300, i * 3] as DrawPoint);
    const stored = prepareStoredPoints(zigzag, 310);
    expect(stored.length).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE);
    expect(stored.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bounds, the svg box and path data", () => {
  it("bounds include half the stroke width plus 1 px on every side, across strokes", () => {
    expect(strokesBounds([{ points: [[10, 20], [30, 40]], width: 4 }])).toEqual({ minX: 7, minY: 17, maxX: 33, maxY: 43 });
    expect(strokesBounds([
      { points: [[0, 0]], width: 2 },
      { points: [[50, 60]], width: 14 },
    ])).toEqual({ minX: -2, minY: -2, maxX: 58, maxY: 68 });
    expect(strokesBounds([{ points: [[Number.NaN, 0]], width: 4 }])).toBeNull();
    expect(strokesBounds([])).toBeNull();
  });

  it("places the box at the origin plus bounds x scale, never clipped vertically (a negative top is fine)", () => {
    const box = svgBox({ minX: 10, minY: -40, maxX: 60, maxY: 20 }, 12, 300, 1.5, 0, 1000)!;
    expect(box.left).toBe(12 + 15);
    expect(box.top).toBe(300 - 60);
    expect(box.width).toBe(75);
    expect(box.height).toBe(90);
    expect(box.viewBox).toEqual({ minX: 10, minY: -40, maxX: 60, maxY: 20 });
    expect(svgBox({ minX: 0, minY: -500, maxX: 10, maxY: -400 }, 0, 100, 1, 0, 100)!.top).toBe(-400);
  });

  it("clips horizontally to the thread (never a sideways scrollbar), keeping the mapping exact", () => {
    const box = svgBox({ minX: -40, minY: 0, maxX: 400, maxY: 10 }, 12, 0, 1, 0, 334)!;
    expect(box.left).toBe(0);
    expect(box.left + box.width).toBe(334);
    // The clipped edges map back to the same draw x: left 0 is draw x -12, right 334 is 322.
    expect(box.viewBox.minX).toBe(-12);
    expect(box.viewBox.maxX).toBe(322);
    expect(svgBox({ minX: 500, minY: 0, maxX: 600, maxY: 10 }, 0, 0, 1, 0, 334)).toBeNull();
  });

  it("path data is built only from finite numbers, rounded to 2 dp; one point is a dot", () => {
    expect(pathData([[1, 2], [3.14159, 4], [5, -6]])).toBe("M1 2 L3.14 4 L5 -6");
    expect(pathData([[7, 8]])).toBe("M7 8 L7 8");
    expect(pathData([[1, Number.NaN], [2, 3]])).toBe("M2 3 L2 3");
    expect(pathData([])).toBe("");
    expect(pathData([[-0.001, 0]])).toBe("M0 0 L0 0");
  });

  it("several batches become separate pieces of one path, so a lost batch shows as a gap", () => {
    expect(segmentsPathData([[[0, 0], [1, 1]], [], [[1, 1], [2, 2]]])).toBe("M0 0 L1 1 M1 1 L2 2");
  });
});

describe("Select mode's hit testing (§5: within 12 px, in viewer px, of a stroke)", () => {
  it("measures the distance to a segment, an end beyond it, and a dot", () => {
    expect(distanceToPolyline(5, 3, [[0, 0], [10, 0]])).toBe(3);
    expect(distanceToPolyline(13, 4, [[0, 0], [10, 0]])).toBe(5);
    expect(distanceToPolyline(3, 4, [[0, 0]])).toBe(5);
    expect(distanceToPolyline(0, 0, [])).toBe(Number.POSITIVE_INFINITY);
  });

  const horizontal = (key: string, width: number, y = 0, scale = 1) => ({
    key,
    originX: 0,
    originY: 0,
    scale,
    strokes: [{ points: [[0, y], [100, y]] as DrawPoint[], width }],
  });

  it("hits within 12 px of the stroke's visible edge, so a thick line is as easy as a thin one", () => {
    // width 14 at scale 1: the edge is 7 px from the centre line.
    expect(hitTestDrawings(50, 7 + SELECT_HIT_RADIUS_PX, [horizontal("a", 14)])).toBe("a");
    expect(hitTestDrawings(50, 7 + SELECT_HIT_RADIUS_PX + 0.5, [horizontal("a", 14)])).toBeNull();
    // width 2: the edge is 1 px out.
    expect(hitTestDrawings(50, 1 + SELECT_HIT_RADIUS_PX, [horizontal("a", 2)])).toBe("a");
    expect(hitTestDrawings(50, 1 + SELECT_HIT_RADIUS_PX + 0.5, [horizontal("a", 2)])).toBeNull();
  });

  it("the 12 px radius is in VIEWER px: a drawing shown at twice its size is hit in viewer terms", () => {
    // Drawn at y = 10 (draw space), shown at scale 2: its centre line is at viewer y = 20, its
    // width 2 becomes 4 (edge 2 px out).
    const doubled = horizontal("d", 2, 10, 2);
    expect(hitTestDrawings(50, 20 + 2 + SELECT_HIT_RADIUS_PX, [doubled])).toBe("d");
    expect(hitTestDrawings(50, 20 + 2 + SELECT_HIT_RADIUS_PX + 0.5, [doubled])).toBeNull();
  });

  it("the closest candidate wins; a candidate with a bad scale is skipped; none is null", () => {
    const near = horizontal("near", 2, 5);
    const far = horizontal("far", 2, 15);
    expect(hitTestDrawings(50, 8, [far, near])).toBe("near");
    expect(hitTestDrawings(50, 13, [far, near])).toBe("far");
    expect(hitTestDrawings(50, 0, [{ ...near, scale: 0 }])).toBeNull();
    expect(hitTestDrawings(50, 0, [])).toBeNull();
  });
});
