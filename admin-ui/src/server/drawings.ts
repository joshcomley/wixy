// Live drawing — the pen tool's palette and limits (spec/server-chat/07-live-drawing.md §3/§4).
//
// The server's copy is `wixy_server/livechat/drawings.py`. The two lists below are parsed from
// THIS file by `wixy_server/tests/test_livechat_drawings.py`, and `tests/server/drawings.test.ts`
// parses the Python file in the other direction, so neither side can drift silently (the
// reaction-emoji drift guard's own pattern, `reactions.ts`). Keep each list on one
// `export const NAME = [...] as const;` declaration: that exact shape is what both guards read.

export const DRAWING_COLORS = ["#1c1c1e", "#ffffff", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de"] as const;

export const DRAWING_WIDTHS = [2, 4, 8, 14] as const;

export type DrawingColor = (typeof DRAWING_COLORS)[number];
export type DrawingWidth = (typeof DRAWING_WIDTHS)[number];

/** The spoken name of each colour (the swatch itself is only a filled circle). */
export const DRAWING_COLOR_LABELS: Readonly<Record<DrawingColor, string>> = {
  "#1c1c1e": "Black",
  "#ffffff": "White",
  "#ff3b30": "Red",
  "#ff9500": "Orange",
  "#ffcc00": "Yellow",
  "#34c759": "Green",
  "#0a84ff": "Blue",
  "#af52de": "Purple",
};

/** The spoken name of each thickness. */
export const DRAWING_WIDTH_LABELS: Readonly<Record<DrawingWidth, string>> = {
  2: "Thin",
  4: "Medium",
  8: "Thick",
  14: "Extra thick",
};

/** The pen a first-time drawer starts with. */
export const DEFAULT_DRAWING_COLOR: DrawingColor = "#ff3b30";
export const DEFAULT_DRAWING_WIDTH: DrawingWidth = 4;

// -- Server-enforced limits (mirrors of drawings.py; the drift guard compares every one) -------

export const MIN_COLUMN_WIDTH = 200;
export const MAX_COLUMN_WIDTH = 4000;
/** A point's x may run this far past either edge of the column. */
export const MIN_POINT_X = -50;
export const MAX_POINT_X_PAD = 50;
export const MAX_POINT_Y_ABS = 20000;
export const MIN_POINTS_PER_STROKE = 2;
export const MAX_POINTS_PER_STROKE = 1000;
export const MAX_STROKES_PER_DRAWING = 200;
export const MAX_DRAWINGS_PER_ANCHOR = 20;
export const MAX_LIVE_POINTS_PER_BATCH = 200;
export const MAX_LIVE_BATCHES_PER_SECOND = 30;

// -- Client tuning (spec 07 §3-§5; not server limits) ----------------------------------------

/** §3: the client simplifies each finished stroke (Ramer-Douglas-Peucker) at this tolerance, in
 * draw-space px, before storing it. */
export const RDP_EPSILON_PX = 0.75;
/** §4: in-progress points are batched about this often. */
export const LIVE_BATCH_INTERVAL_MS = 50;
/** §4: a receiver drops a live stroke that has not been updated for this long. */
export const LIVE_STROKE_TIMEOUT_MS = 5_000;
/** A finger held still sends its last point again this often, so a receiver never mistakes a
 * pause for a vanished drawer (well inside `LIVE_STROKE_TIMEOUT_MS`). */
export const LIVE_KEEPALIVE_MS = 2_000;
/** §5: a second finger this soon after the first... */
export const SECOND_FINGER_WINDOW_MS = 150;
/** ...and before the first has moved this far turns the gesture into a two-finger pan. */
export const SECOND_FINGER_SLOP_PX = 12;
/** §5: Select mode picks a drawing tapped within this many viewer px of one of its strokes. */
export const SELECT_HIT_RADIUS_PX = 12;
/** A new stroke further than this from its drawing's anchor (draw space) starts a new drawing,
 * so no point of it can cross the server's ±`MAX_POINT_Y_ABS` bound. */
export const DRAWING_Y_SPLIT_PX = MAX_POINT_Y_ABS - 4_000;

export function isDrawingColor(value: unknown): value is DrawingColor {
  return typeof value === "string" && (DRAWING_COLORS as readonly string[]).includes(value);
}

export function isDrawingWidth(value: unknown): value is DrawingWidth {
  return typeof value === "number" && (DRAWING_WIDTHS as readonly number[]).includes(value);
}
