from __future__ import annotations

from pathlib import Path

import pytest

from pixelart.model import (
    PxlError,
    dump,
    parse,
    resolve_anchors,
    resolve_frames,
)

FIXTURES = Path(__file__).parent / "fixtures"

BASE = """\
pxl 1
name demo
size 4x3
maxcolors 4
tag icon
palette
  .  transparent
  k  #101010  outline
  s  #c08040  skin
  #  #ffffff  highlight
  ramp skin = k s #
end
anchor eye 1,1
frame a ms=120
.kk.
ksk#
.kk.
anchor foot 0,2
frame b like=a shift=1,0
 1| ksss
anim walk = a b loop
require anchors eye
require height 1..3
require width 2..4
"""


def test_happy_path_everything() -> None:
    sp = parse(BASE)
    assert (sp.name, sp.w, sp.h, sp.maxcolors, sp.tags) == ("demo", 4, 3, 4, ["icon"])
    assert sp.palette.entries["k"].role == "outline"
    assert sp.palette.entries["#"].rgb == (255, 255, 255)
    assert sp.palette.ramps == {"skin": ["k", "s", "#"]}
    assert sp.frames["a"].ms == 120 and sp.frames["b"].ms == 100
    assert sp.anims["walk"].frames == ["a", "b"] and sp.anims["walk"].mode == "loop"
    assert sp.requires.anchors == ["eye"]
    assert sp.requires.height == (1, 3) and sp.requires.width == (2, 4)
    assert sp.anchors["eye"].x == 1


def test_comments_and_blank_lines_and_hash_key() -> None:
    text = BASE.replace("tag icon", "# a comment\n\ntag icon   # trailing note")
    sp = parse(text)
    assert sp.tags == ["icon"]
    # '#' as a palette key is not a comment, '#' rows are not comments
    assert sp.frames["a"].rows == [".kk.", "ksk#", ".kk."]


def test_derived_frame_shift_and_overrides() -> None:
    sp = parse(BASE)
    grids = resolve_frames(sp)
    # a shifted right by 1: vacated column -> '.', pixel pushed off-canvas dropped
    assert grids["b"][0] == "..kk"
    assert grids["b"][2] == "..kk"
    # row 1 overridden AFTER the shift
    assert grids["b"][1] == "ksss"


def test_derived_frame_zero_overrides_and_chain() -> None:
    text = BASE + "frame c like=b shift=0,1 ms=40\nframe d like=c\n"
    # anchors/anim after the frame lines are fine; this extends the chain
    sp = parse(text)
    g = resolve_frames(sp)
    assert g["c"] == ["....", "..kk", "ksss"]
    assert g["d"] == g["c"]
    assert sp.frames["c"].ms == 40


def test_shift_negative_drops_pixels() -> None:
    sp = parse(BASE + "frame c like=a shift=-1,-1\n")
    assert resolve_frames(sp)["c"] == ["sk#.", "kk..", "...."]


def test_anchor_resolution() -> None:
    sp = parse(BASE)
    anchors = resolve_anchors(sp)
    assert anchors["a"]["foot"].x == 0 and anchors["a"]["eye"].y == 1
    # derived frame inherits the parent's per-frame anchor, moved by shift
    assert (anchors["b"]["foot"].x, anchors["b"]["foot"].y) == (1, 2)
    # defaults are NOT shifted
    assert (anchors["b"]["eye"].x, anchors["b"]["eye"].y) == (1, 1)


def test_dump_roundtrip() -> None:
    sp = parse(BASE)
    again = parse(dump(sp))
    assert resolve_frames(again) == resolve_frames(sp)
    assert resolve_anchors(again) == resolve_anchors(sp)
    assert again.palette.ramps == sp.palette.ramps
    assert again.anims.keys() == sp.anims.keys() and again.requires == sp.requires
    assert [f.ms for f in again.frames.values()] == [f.ms for f in sp.frames.values()]


def _bad(text: str, match: str, snippet: str | None = None) -> None:
    """Parse must fail with `match`; the reported line must contain `snippet`."""
    with pytest.raises(PxlError, match=match) as ei:
        parse(text)
    assert str(ei.value).startswith("<pxl>")
    if snippet is not None:
        line = ei.value.line
        assert line is not None, f"no line number: {ei.value}"
        assert snippet in text.splitlines()[line - 1], (
            f"line {line} is {text.splitlines()[line - 1]!r}, expected it to contain {snippet!r}"
        )


def _sub(old: str, new: str) -> str:
    assert old in BASE
    return BASE.replace(old, new, 1)


# (id, text, message regex, snippet that must be on the reported line or None)
ERROR_CASES: list[tuple[str, str, str, str | None]] = [
    ("no-pxl", "name demo\n", "first directive must be 'pxl 1'", "name demo"),
    ("bad-version", BASE.replace("pxl 1", "pxl 2", 1), "first directive must be 'pxl 1'", "pxl 2"),
    ("dup-pxl", _sub("name demo", "pxl 1\nname demo"), "duplicate 'pxl'", "pxl 1"),
    ("bad-name", _sub("name demo", "name Demo_X"), "name must be", "Demo_X"),
    ("size-zero", _sub("size 4x3", "size 0x3"), "1..256", "size 0x3"),
    ("size-big", _sub("size 4x3", "size 300x3"), "1..256", "size 300x3"),
    ("size-syntax", _sub("size 4x3", "size 4"), "WxH", "size 4"),
    ("maxcolors", _sub("maxcolors 4", "maxcolors 0"), "maxcolors", "maxcolors 0"),
    ("unknown-directive", _sub("tag icon", "wibble 1"), "unknown directive 'wibble'", "wibble"),
    ("row-short", _sub(".kk.\nksk#", ".kk\nksk#"), "row has 3 keys, expected 4", ".kk"),
    ("row-long", _sub("ksk#", "ksk#k"), "row has 5 keys", "ksk#k"),
    ("row-unknown-key", _sub("ksk#", "kzk#"), "unknown palette key 'z'", "kzk#"),
    (
        "rows-missing",
        "pxl 1\nname t\nsize 4x3\npalette\n  k #000000\nend\nframe a\nkkkk\n",
        "has 1 rows, expected 3",
        "frame a",
    ),
    ("dup-frame", BASE + "frame a\n....\n....\n....\n", "duplicate frame 'a'", "frame a"),
    ("like-missing", _sub("like=a", "like=zzz"), "must name an earlier frame", "like=zzz"),
    ("like-forward", _sub("frame a ms=120", "frame a ms=120 like=b"), "earlier frame", "like=b"),
    (
        "shift-without-like",
        _sub("frame a ms=120", "frame a ms=120 shift=1,0"),
        "requires like=",
        "frame a",
    ),
    ("shift-syntax", _sub("shift=1,0", "shift=1"), "shift must be written x,y", "shift=1"),
    ("ms-low", _sub("ms=120", "ms=5"), "ms must be", "ms=5"),
    ("ms-high", _sub("ms=120", "ms=20000"), "ms must be", "ms=20000"),
    ("frame-opt", _sub("ms=120", "foo=1"), "unknown frame option 'foo'", "foo=1"),
    ("frame-opt-bare", _sub("ms=120", "fast"), "unknown frame option 'fast'", "fast"),
    ("frame-opt-dup", _sub("ms=120", "ms=120 ms=100"), "duplicate frame option 'ms'", "ms=100"),
    (
        "override-full-frame",
        _sub("anchor foot 0,2", " 1| ksss"),
        "only valid in a frame with like=",
        "1| ksss",
    ),
    ("override-range", _sub(" 1| ksss", " 7| ksss"), "override row 7 out of range", "7| ksss"),
    ("override-length", _sub(" 1| ksss", " 1| kss"), "row has 3 keys", "1| kss"),
    ("override-unknown", _sub(" 1| ksss", " 1| kszs"), "unknown palette key 'z'", "kszs"),
    ("override-twice", _sub(" 1| ksss", " 1| ksss\n 1| kkkk"), "overridden twice", "kkkk"),
    (
        "anchor-outside",
        _sub("anchor eye 1,1", "anchor eye 9,1"),
        "outside the 4x3 canvas",
        "eye 9,1",
    ),
    (
        "anchor-syntax",
        _sub("anchor eye 1,1", "anchor eye 1"),
        "must be written x,y",
        "anchor eye 1",
    ),
    ("anchor-xy", _sub("anchor eye 1,1", "anchor eye 1;1"), "must be written x,y", "1;1"),
    (
        "anim-missing-frame",
        _sub("anim walk = a b", "anim walk = a zz"),
        "missing frame 'zz'",
        "anim walk",
    ),
    (
        "anim-empty",
        _sub("anim walk = a b loop", "anim walk = loop"),
        "at least one frame",
        "anim walk",
    ),
    ("anim-syntax", _sub("anim walk = a b loop", "anim walk"), "anim must be", "anim walk"),
    ("anim-dup", BASE + "anim walk = a\n", "duplicate anim", "anim walk = a"),
    (
        "palette-dup-key",
        _sub("  s  #c08040  skin", "  s  #c08040  skin\n  s  #000000"),
        "duplicate palette key 's'",
        "s  #000000",
    ),
    ("palette-bad-colour", _sub("#c08040", "#c0804"), "invalid colour", "#c0804"),
    (
        "palette-transparent-key",
        _sub("  s  #c08040  skin", "  s  transparent"),
        "only '.' may be transparent",
        "s  transparent",
    ),
    (
        "palette-dot-colour",
        _sub("  .  transparent", "  .  #ffffff"),
        "always transparent",
        ".  #ffffff",
    ),
    ("palette-bad-role", _sub("skin\n", "Skin!\n"), "invalid role name", "Skin!"),
    (
        "palette-pipe-key",
        _sub("  s  #c08040  skin", "  |  #c08040"),
        "invalid palette key",
        "|  #c08040",
    ),
    ("palette-entry-shape", _sub("  s  #c08040  skin", "  s"), "palette entry must be", "  s"),
    ("ramp-syntax", _sub("ramp skin = k s #", "ramp skin k s"), "ramp must be", "ramp skin k s"),
    (
        "ramp-unknown-key",
        _sub("ramp skin = k s #", "ramp skin = k q"),
        "undefined/transparent key 'q'",
        "end",
    ),
    (
        "ramp-dup",
        _sub("ramp skin = k s #", "ramp skin = k s\n  ramp skin = k s"),
        "duplicate ramp",
        "ramp skin",
    ),
    (
        "palette-extend-no-uses",
        _sub("palette\n", "palette extend\n"),
        "requires 'uses model='",
        "palette extend",
    ),
    (
        "palette-dup-block",
        _sub("anchor eye", "palette\nend\nanchor eye"),
        "duplicate palette block",
        "palette",
    ),
    (
        "palette-arg",
        _sub("palette\n", "palette junk\n"),
        "expected 'palette' or 'palette extend'",
        "palette junk",
    ),
    (
        "require-shape",
        _sub("require height 1..3", "require height 3"),
        "expected a range",
        "height 3",
    ),
    ("require-range", _sub("1..3", "3..1"), "low > high", "3..1"),
    ("require-range-syntax", _sub("1..3", "a..b"), "expected a range", "a..b"),
    (
        "require-bad-anchor",
        _sub("require anchors eye", "require anchors Eye!"),
        "invalid anchor name",
        "Eye!",
    ),
    (
        "require-kind",
        _sub("require anchors eye", "require colours eye"),
        "require needs",
        "colours",
    ),
    ("end-stray", _sub("anchor eye", "end\nanchor eye"), "'end' without a palette block", "end"),
    (
        "uses-no-path",
        _sub("tag icon", "uses model=m.pxl"),
        "needs the sprite's file path",
        "uses model",
    ),
    ("uses-syntax", _sub("tag icon", "uses m.pxl"), "expected 'uses model=<file>'", "uses m.pxl"),
    ("tag-arity", _sub("tag icon", "tag a b"), "tag takes exactly one word", "tag a b"),
    ("missing-name", BASE.replace("name demo\n", ""), "missing required 'name'", None),
    ("missing-size", BASE.replace("size 4x3\n", ""), "'size WxH' must come before", "palette"),
    ("empty", "", "empty file", None),
]


@pytest.mark.parametrize(
    "text,match,snippet", [c[1:] for c in ERROR_CASES], ids=[c[0] for c in ERROR_CASES]
)
def test_parse_errors(text: str, match: str, snippet: str | None) -> None:
    _bad(text, match, snippet)


def test_palette_without_end() -> None:
    text = "pxl 1\nname t\nsize 1x1\npalette\n  k #000000\n"
    _bad(text, "missing 'end'", "palette")


def test_default_anchor_after_frame_is_error() -> None:
    text = BASE.replace("anim walk = a b loop\n", "anim walk = a b loop\nanchor late 0,0\n")
    _bad(text, "default anchors must come before the first frame", "anchor late")


def test_error_message_has_path_and_line() -> None:
    with pytest.raises(PxlError) as ei:
        parse(_sub("ksk#", "kzk#"), "some/file.pxl")
    assert str(ei.value).startswith("some/file.pxl:16:")


# ---------------------------------------------------------------- models


def test_uses_model_inherits_palette_and_requirements() -> None:
    path = FIXTURES / "child.pxl"
    sp = parse(path.read_text(encoding="utf-8"), str(path))
    assert sp.model is not None and sp.model.name == "hero.model"
    k = sp.palette.entries["k"]
    assert k.inherited and k.role == "outline"
    assert sp.palette.entries["x"].inherited is False  # from `palette extend`
    assert sp.palette.ramps["skin"] == ["k", "s", "l"]  # ramp inherited
    reqs = {name: r for name, r in sp.requirements()}
    assert reqs["hero.model"].anchors == ["eye-l", "eye-r"]
    assert reqs["hero.model"].height == (2, 4)


def test_uses_model_plain_palette_must_match(tmp_path: Path) -> None:
    (tmp_path / "m.pxl").write_text(
        "pxl 1\nname m.model\nsize 2x2\npalette\n  k #000000\nend\nframe a\nkk\nkk\n",
        encoding="utf-8",
    )
    ok = "pxl 1\nname c\nsize 2x2\nuses model=m.pxl\npalette\n  k #000000\nend\nframe a\nkk\nkk\n"
    parse(ok, str(tmp_path / "c.pxl"))
    with pytest.raises(PxlError, match="not in the model palette; use 'palette extend'"):
        parse(ok.replace("k #000000", "z #ff0000"), str(tmp_path / "c.pxl"))
    with pytest.raises(PxlError, match="differs from the model"):
        parse(ok.replace("#000000", "#111111"), str(tmp_path / "c.pxl"))
    with pytest.raises(PxlError, match="redefines the model's colour"):
        parse(
            ok.replace("palette\n", "palette extend\n").replace("#000000", "#111111"),
            str(tmp_path / "c.pxl"),
        )


def test_uses_missing_and_cyclic_model(tmp_path: Path) -> None:
    text = "pxl 1\nname c\nsize 2x2\nuses model=nope.pxl\n"
    with pytest.raises(PxlError, match="cannot read model"):
        parse(text, str(tmp_path / "c.pxl"))
    a = tmp_path / "a.pxl"
    b = tmp_path / "b.pxl"
    a.write_text("pxl 1\nname a\nsize 2x2\nuses model=b.pxl\n", encoding="utf-8")
    b.write_text("pxl 1\nname b\nsize 2x2\nuses model=a.pxl\n", encoding="utf-8")
    with pytest.raises(PxlError, match="cycle"):
        parse(a.read_text(encoding="utf-8"), str(a))


def test_uses_must_precede_palette(tmp_path: Path) -> None:
    (tmp_path / "m.pxl").write_text("pxl 1\nname m\nsize 2x2\n", encoding="utf-8")
    text = "pxl 1\nname c\nsize 2x2\npalette\nend\nuses model=m.pxl\n"
    with pytest.raises(PxlError, match="before the palette"):
        parse(text, str(tmp_path / "c.pxl"))


def test_model_parse_error_is_attributed(tmp_path: Path) -> None:
    (tmp_path / "m.pxl").write_text("pxl 1\nname m\nsize 2x2\nbogus\n", encoding="utf-8")
    text = "pxl 1\nname c\nsize 2x2\nuses model=m.pxl\n"
    with pytest.raises(
        PxlError, match=r"in model m.pxl: unknown directive 'bogus' \(line 4\)"
    ) as ei:
        parse(text, str(tmp_path / "c.pxl"))
    assert ei.value.line == 4
