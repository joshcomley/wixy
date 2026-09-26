"""Live drawing palette and limits (spec/server-chat/07-live-drawing.md §3).

The colour and width allowlists are the one place the accepted values are spelled out. The
browser keeps the same lists in `admin-ui/src/server/drawings.ts`;
`test_livechat_drawings.py` parses that file and fails if the two drift (the reaction-emoji
drift guard's own pattern, `reactions.py`).
"""

from __future__ import annotations

DRAWING_COLORS: tuple[str, ...] = (
    "#1c1c1e",  # near-black
    "#ffffff",  # white
    "#ff3b30",  # red
    "#ff9500",  # orange
    "#ffcc00",  # yellow
    "#34c759",  # green
    "#0a84ff",  # blue
    "#af52de",  # purple
)

DRAWING_WIDTHS: tuple[int, ...] = (2, 4, 8, 14)

MIN_COLUMN_WIDTH = 200.0
MAX_COLUMN_WIDTH = 4000.0
"""Must match the `column_width` CHECK bounds in `store.py`'s schema — the route layer
validates BEFORE the insert so a bad value 422s instead of surfacing as a raw
`sqlite3.IntegrityError`."""

MIN_POINT_X = -50
MAX_POINT_X_PAD = 50
"""A point's x can run 50px past either edge of the column (a stroke started just off
one side is still meaningful, spec 07 §3)."""
MAX_POINT_Y_ABS = 20000

MAX_POINTS_PER_STROKE = 1000
MIN_POINTS_PER_STROKE = 2
MAX_STROKES_PER_DRAWING = 200
MAX_DRAWINGS_PER_ANCHOR = 20
MAX_LIVE_POINTS_PER_BATCH = 200
MAX_LIVE_BATCHES_PER_SECOND = 30

_COLOR_SET = frozenset(DRAWING_COLORS)
_WIDTH_SET = frozenset(DRAWING_WIDTHS)


def is_allowed_drawing_color(color: str) -> bool:
    return color in _COLOR_SET


def is_allowed_drawing_width(width: int) -> bool:
    return width in _WIDTH_SET
