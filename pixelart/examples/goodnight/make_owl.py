"""Write owl.pxl: the base front pose plus every other frame as override rows.

The face lives in columns 7..24 of rows 7..15 (inside the head outline). Every frame
other than `front` only rewrites that band, so the body, outline and feet are shared by
construction and can never drift between frames.

    python -m pixelart.examples.goodnight.make_owl
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).parent
FACE_X, FACE_Y, FACE_W = 7, 7, 18

FRONT = [
    "................................",
    "................................",
    "................................",
    ".....k....................k.....",
    "......kk................kk......",
    "......k3kk............kk2k......",
    "......k344kkkkkkkkkkkk322k......",
    "......k344443333333333332k......",
    "......k341111432233111132k......",
    "......k31yyyy142231yyyy12k......",
    "......k31yYpy142231yYpy12k......",
    "......k31yppy142231yppy12k......",
    "......k31yyyy14bb31yyyy12k......",
    "......k34111144bB44111132k......",
    "......k34444444B444444432k......",
    "......k333444433334444322k......",
    "......k333344444444443322k......",
    ".....k33315555555555441222k.....",
    ".....k43315455455455441221k.....",
    ".....k43215455455455441221k.....",
    "....k3432155555555554412221k....",
    "....k3432155455455454412221k....",
    "....k3332155455455454412211k....",
    "....k2332155555555544412211k....",
    ".....k23215455455454441211k.....",
    ".....k22214455455444441111k.....",
    "......k212144444433321111k......",
    ".......k1223333322222221k.......",
    "........k12222222222221k........",
    ".........kkbbbkkkkbbbkk.........",
    "...........kkk....kkk...........",
    "................................",
]

# Face bands (rows 7..15, x7..x24). Moonlight comes from the upper left in every frame.
FACES: dict[str, list[str]] = {
    # three-quarters to the viewer's right: features slide right, the far eye narrows
    "turn-34r": [
        "344443333333333332",
        "343411114322311132",
        "3331yyyy14221yyy12",
        "3331yYpy14221Ypy12",
        "3331yppy14221ppy12",
        "3331yyyy14bb1yyy12",
        "3334111144bB411132",
        "33444444444B444432",
        "333334444333344322",
    ],
    # full profile to the right: one eye near the front, the beak at the edge
    "turn-side-r": [
        "344443333333333332",
        "343333333334111432",
        "333333333341yyy142",
        "333233333341yYp142",
        "333323333341ypp142",
        "333333333341yyy1bb",
        "3333333333441114bB",
        "33333333344444444B",
        "333333333333444432",
    ],
    # the back of the head: no face, staggered feather streaks
    "turn-back": [
        "344443333333333332",
        "343333333333333322",
        "334333333333333322",
        "333323332333233322",
        "333323332333233322",
        "333333333333333322",
        "332333233323333222",
        "332333233323333222",
        "333333333333333322",
    ],
    # a gentle smile: eyes open, lower lids lifted by the cheeks, a soft blush
    "smile-open": [
        "344443333333333332",
        "341111432233111132",
        "31yyyy142231yyyy12",
        "31yYpy142231yYpy12",
        "314yy41422314yy412",
        "3rr44444bb44444rr2",
        "34444444bB44444432",
        "34444444B444444432",
        "333444433334444322",
    ],
    # content: eyes closed in happy arcs (the sleeping blink curves the other way)
    "smile-closed": [
        "344443333333333332",
        "341111432233111132",
        "333333342233333332",
        "333113342233311332",
        "331331342233133132",
        "3rr44444bb44444rr2",
        "34444444bB44444432",
        "34444444B444444432",
        "333444433334444322",
    ],
}


def mirror_face(rows: list[str]) -> list[str]:
    """Mirror the features for the other side. The crown (first row) does not turn, and the
    outer columns keep the lit-left / shaded-right edge wherever no beak is involved."""
    out = rows[:1]
    for r in rows[1:]:
        m = list(r[::-1])
        for i in (0, -1):
            if m[i] not in "bB" and r[i] not in "bB":
                m[i] = r[i]
            elif m[i] not in "bB":
                m[i] = "3" if i == 0 else "2"
        out.append("".join(m))
    return out


FACES["turn-side-l"] = mirror_face(FACES["turn-side-r"])
# the brow above the near eye keeps its moonlit pixel on the left instead of the far edge
FACES["turn-side-l"][1] = "344111433333333332"


def face_rows(face: list[str]) -> dict[int, str]:
    rows: dict[int, str] = {}
    for i, band in enumerate(face):
        y = FACE_Y + i
        assert len(band) == FACE_W, (y, band)
        rows[y] = FRONT[y][:FACE_X] + band + FRONT[y][FACE_X + FACE_W :]
    return rows


def eye_rows(
    edits: dict[int, tuple[str, str]], x_left: int = 9, x_right: int = 19
) -> dict[int, str]:
    """Replace the left/right eye spans (same width) on the given rows."""
    rows: dict[int, str] = {}
    for y, (left, right) in edits.items():
        r = list(FRONT[y])
        r[x_left : x_left + len(left)] = list(left)
        r[x_right : x_right + len(right)] = list(right)
        rows[y] = "".join(r)
    return rows


def beak_rows(dx: int) -> dict[int, str]:
    """The beak moved one pixel left (dx=-1) or right (dx=1), face disc filled behind it."""
    rows: dict[int, str] = {}
    for y in (12, 13, 14):
        r = list(FRONT[y])
        beak = [(x, c) for x, c in enumerate(FRONT[y]) if c in "bB"]
        for x, _ in beak:
            r[x] = "4"
        for x, c in beak:
            r[x + dx] = c
        rows[y] = "".join(r)
    return rows


def combine(*edits: dict[int, str]) -> dict[int, str]:
    """Overlay several row edits; a pixel any edit changed wins over the front pose."""
    rows: dict[int, str] = {}
    for edit in edits:
        for y, new in edit.items():
            base = rows.get(y, FRONT[y])
            rows[y] = "".join(
                n if n != f else b for n, f, b in zip(new, FRONT[y], base, strict=True)
            )
    return rows


def as_overrides(rows: dict[int, str]) -> list[str]:
    return [f"{y:2d}| {rows[y]}" for y in sorted(rows) if rows[y] != FRONT[y]]


def build() -> str:
    out: list[str] = [
        "pxl 1",
        "name owl-perched",
        "size 32x32",
        "maxcolors 14",
        "palette",
        "  k #0e1121 outline",
        "  p #0f1a3d eye-pupil",
        "  1 #1b2536 body-0",
        "  2 #2b3a4c body-1",
        "  3 #445868 body-2",
        "  4 #6a7f88 body-3",
        "  5 #9fb2b0 body-4",
        "  y #4fa3dc eye",
        "  Y #d8f3ff highlight",
        "  b #9a8670 beak",
        "  B #5e5048 beak-dark",
        "  r #b98593 blush",
        "  ramp body = 1 2 3 4 5",
        "  ramp beak = B b",
        "end",
        "anchor eye-l 10,10",
        "anchor eye-r 20,10",
        "anchor foot-l 12,29",
        "anchor foot-r 19,29",
        "# lint-justified: jaggies at 6,5 is where the ear tuft meets the flat head top",
        "# (a corner, not a line)",
        "frame front ms=1200",
        *FRONT,
    ]

    def frame(name: str, ms: int, like: str, rows: dict[int, str] | None = None) -> None:
        out.append(f"frame {name} ms={ms} like={like}")
        out.extend(as_overrides(rows or {}))

    for name, ms in [("front-300", 300), ("front-500", 500), ("front-hold", 1600)]:
        frame(name, ms, "front")
    frame("blink-half", 70, "front", eye_rows({9: ("3333", "3333"), 10: ("1111", "1111")}))
    frame(
        "blink-closed",
        100,
        "front",
        combine(
            eye_rows(
                {
                    9: ("333333", "333333"),
                    10: ("313313", "313313"),
                    11: ("331133", "331133"),
                    12: ("333333", "333333"),
                },
                x_left=8,
                x_right=18,
            ),
            eye_rows({13: ("4444", "4444")}),
        ),
    )
    frame(
        "look-left",
        700,
        "front",
        combine(eye_rows({10: ("Ypyy", "Ypyy"), 11: ("ppyy", "ppyy")}), beak_rows(-1)),
    )
    frame(
        "look-right",
        700,
        "front",
        combine(eye_rows({10: ("yyYp", "yyYp"), 11: ("yypp", "yypp")}), beak_rows(1)),
    )
    frame("look-left-hold", 1600, "look-left")
    frame("glance-left", 120, "look-left")
    frame("glance-right", 120, "look-right")
    frame("turn-34r", 140, "front", face_rows(FACES["turn-34r"]))
    frame("turn-side-r", 160, "front", face_rows(FACES["turn-side-r"]))
    frame("turn-back", 400, "front", face_rows(FACES["turn-back"]))
    frame("turn-side-l", 600, "front", face_rows(FACES["turn-side-l"]))
    frame("turn-back-2", 300, "turn-back")
    frame("turn-side-r-2", 160, "turn-side-r")
    frame("turn-34r-2", 140, "turn-34r")
    frame("smile-open", 1400, "front", face_rows(FACES["smile-open"]))
    frame("smile-closed", 1800, "front", face_rows(FACES["smile-closed"]))

    out += [
        "anim blink = front blink-half blink-closed blink-half front once",
        # eyes one way and the other, then the head nearly all the way round and back
        "anim intro = front look-left front-300 look-right front-500 blink-half blink-closed"
        " blink-half front-500 turn-34r turn-side-r turn-back turn-side-l turn-back-2"
        " turn-side-r-2 turn-34r-2 front-500 blink-half blink-closed blink-half front-hold once",
        # watching the bubble drift in from the lower left
        "anim watch = look-left-hold blink-half blink-closed blink-half look-left-hold front-500"
        " loop",
        # caught: a few quick glances, then a gentle smile settling into a content one
        "anim bubble-happy = glance-left glance-right glance-left glance-right front-300"
        " smile-open smile-closed once",
        "anim turn = front turn-34r turn-side-r turn-back turn-side-l turn-back-2 turn-side-r-2"
        " turn-34r-2 front once",
        "anim smile = front-500 smile-open smile-closed once",
    ]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    (HERE / "owl.pxl").write_text(build(), encoding="utf-8", newline="\n")
