from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from pixelart.cli import main
from pixelart.export import BASE36, const_name, export_ts, sprite_data
from pixelart.model import PxlError, anim_sequence, parse, resolve_frames

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "pixelart" / "examples" / "goodnight"
GEN = ROOT / "admin-ui" / "src" / "server" / "goodnight" / "sprites.gen.ts"
SPRITES = ["owl", "bubble", "star", "moon", "branch"]

SMALL = """\
pxl 1
name small-thing
size 3x2
palette
  .  transparent
  k  #101820
  s  #c08040
end
frame a ms=120
.ks
sk.
frame b ms=80 like=a shift=1,0
anim go = a b a pingpong
"""


def _object_literal(ts: str, const: str) -> dict[str, object]:
    """Parse one exported constant back out of the module (its body is JSON + trailing commas)."""
    m = re.search(rf"export const {const}: SpriteData = (\{{.*?\n\}});\n", ts, re.S)
    assert m, const
    body = re.sub(r",(\s*[}\]])", r"\1", m.group(1))
    value = json.loads(body)
    assert isinstance(value, dict)
    return value


def test_round_trip_matches_resolve_frames(tmp_path: Path) -> None:
    f = tmp_path / "small.pxl"
    f.write_text(SMALL, encoding="utf-8")
    ts = export_ts([f], "cmd")
    out = _object_literal(ts, "SMALL_THING_SPRITE")
    sp = parse(SMALL)
    assert (out["w"], out["h"]) == (3, 2)
    palette = out["palette"]
    assert isinstance(palette, list)
    assert palette == [None, "#101820", "#c08040"]
    grids = resolve_frames(sp)
    frames = out["frames"]
    assert isinstance(frames, list)
    assert [fr["name"] for fr in frames] == list(grids)
    for fr in frames:
        grid = [
            "".join(
                "." if palette[BASE36.index(c)] is None else _key_for(sp, palette[BASE36.index(c)])
                for c in fr["data"][y * 3 : (y + 1) * 3]
            )
            for y in range(2)
        ]
        assert grid == grids[fr["name"]]
    assert [fr["ms"] for fr in frames] == [120, 80]
    assert out["anims"] == {"go": {"frames": ["a", "b", "a"], "mode": "pingpong"}}


def _key_for(sp: object, colour: str | None) -> str:
    assert colour is not None
    h = colour.lstrip("#")
    rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    for k, e in sp.palette.entries.items():  # type: ignore[attr-defined]
        if e.rgb == rgb:
            return str(k)
    raise AssertionError(colour)


@pytest.mark.parametrize("name", SPRITES)
def test_goodnight_sprites_round_trip(name: str) -> None:
    sp = parse((EXAMPLES / f"{name}.pxl").read_text(encoding="utf-8"))
    data = sprite_data(sp)
    palette = data["palette"]
    assert isinstance(palette, list)
    assert palette[0] is None
    grids = resolve_frames(sp)
    frames = data["frames"]
    assert isinstance(frames, list)
    assert [fr["name"] for fr in frames] == list(grids)
    for fr in frames:
        assert len(fr["data"]) == sp.w * sp.h
        for i, ch in enumerate(fr["data"]):
            key = grids[fr["name"]][i // sp.w][i % sp.w]
            entry = sp.palette.entries[key]
            colour = palette[BASE36.index(ch)]
            if entry.rgb is None:
                assert colour is None
            else:
                r, g, b = entry.rgb
                assert colour == f"#{r:02x}{g:02x}{b:02x}"
    for an, a in sp.anims.items():
        assert data["anims"][an]["frames"] == a.frames  # type: ignore[index]
        assert anim_sequence(a)  # expandable


def test_deterministic(tmp_path: Path) -> None:
    f = tmp_path / "small.pxl"
    f.write_text(SMALL, encoding="utf-8")
    assert export_ts([f], "x") == export_ts([f], "x")


def test_duplicate_names_rejected(tmp_path: Path) -> None:
    a, b = tmp_path / "a.pxl", tmp_path / "b.pxl"
    a.write_text(SMALL, encoding="utf-8")
    b.write_text(SMALL, encoding="utf-8")
    with pytest.raises(PxlError):
        export_ts([a, b], "x")


def test_const_name() -> None:
    assert const_name("owl-perched") == "OWL_PERCHED_SPRITE"


def test_cli_writes_lf_file(tmp_path: Path) -> None:
    f = tmp_path / "small.pxl"
    f.write_text(SMALL, encoding="utf-8")
    out = tmp_path / "out.ts"
    assert main(["export-ts", str(f), "-o", str(out)]) == 0
    raw = out.read_bytes()
    assert b"\r" not in raw
    assert raw.startswith(b"// GENERATED FILE - DO NOT EDIT.")


def test_committed_gen_ts_is_fresh(tmp_path: Path) -> None:
    """Drift guard: the committed sprites.gen.ts must equal a fresh export."""
    header = GEN.read_text(encoding="utf-8").splitlines()[1]
    prefix = "// Regenerate with: "
    assert header.startswith(prefix)
    argv = header[len(prefix) :].split()
    assert argv[:4] == ["python", "-m", "pixelart", "export-ts"]
    out = tmp_path / "fresh.ts"
    # Same relative paths as the committed command, run from the repo root.
    args = argv[4:-2]
    assert argv[-2] == "-o"
    subprocess.run(
        [sys.executable, "-m", "pixelart", "export-ts", *args, "-o", str(out)],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    fresh = out.read_text(encoding="utf-8").replace(f"-o {out.as_posix()}", f"-o {argv[-1]}")
    assert GEN.read_text(encoding="utf-8") == fresh, (
        "admin-ui/src/server/goodnight/sprites.gen.ts is stale; regenerate with: "
        + header[len(prefix) :]
    )
