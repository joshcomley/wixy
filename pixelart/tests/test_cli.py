from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from PIL import Image

from pixelart.cli import main
from pixelart.model import dump, parse, resolve_frames

from .util import make, rect

FIXTURES = Path(__file__).parent / "fixtures"

GOOD = """\
pxl 1
name good
size 8x8
palette
  .  transparent
  k  #101820  outline
  s  #c08040
  l  #f0d090
end
frame a ms=100
........
.kkkkkk.
.kssssk.
.ksllsk.
.ksllsk.
.kssssk.
.kkkkkk.
........
frame b ms=120 like=a shift=0,0
 3| .ksssk..
anim idle = a b loop
"""


@pytest.fixture
def good(tmp_path: Path) -> Path:
    p = tmp_path / "good.pxl"
    p.write_text(GOOD, encoding="utf-8")
    return p


def test_check_clean_exit_0(good: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check", str(good)]) == 0
    assert "0 errors, 0 warnings" in capsys.readouterr().out


def test_check_error_exit_1_and_output_format(
    good: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = tmp_path / "bad.pxl"
    bad.write_text(GOOD.replace("name good", "name good\nmaxcolors 2"), encoding="utf-8")
    assert main(["check", str(bad)]) == 1
    out = capsys.readouterr().out
    assert "error" in out and "palette-over-limit" in out and "fix:" in out
    assert "1 error, 0 warnings" in out


def test_check_warning_only_strict_semantics(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    warny = tmp_path / "warny.pxl"
    text = GOOD.replace("  l  #f0d090\n", "  l  #f0d090\n  z  #123456\n")
    warny.write_text(text, encoding="utf-8")
    assert main(["check", str(warny)]) == 0
    out = capsys.readouterr().out
    assert "unused-palette" in out and "1 warning" in out
    assert main(["check", str(warny), "--strict"]) == 1


def test_check_orphan_output_has_coordinates(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    p = tmp_path / "o.pxl"
    p.write_text(GOOD.replace(".ksllsk.\n.ksllsk.", ".ksllsk.\n.ksllsl."), encoding="utf-8")
    main(["check", str(p)])
    out = capsys.readouterr().out
    assert "orphan" in out and "frame a 6,4" in out


def test_check_parse_error_exit_1(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    p = tmp_path / "broken.pxl"
    p.write_text("pxl 1\nname x\nsize 2x2\nwibble\n", encoding="utf-8")
    assert main(["check", str(p)]) == 1
    assert "broken.pxl:4" in capsys.readouterr().out


def test_missing_file_exit_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check", str(tmp_path / "nope.pxl")]) == 2
    assert "cannot read" in capsys.readouterr().err


def test_usage_error_exit_2() -> None:
    with pytest.raises(SystemExit) as ei:
        main(["render"])
    assert ei.value.code == 2
    with pytest.raises(SystemExit) as ei:
        main([])
    assert ei.value.code == 2


def test_render_png_default_and_frame(good: Path, tmp_path: Path) -> None:
    assert main(["render", str(good), "--scale", "3"]) == 0
    img = Image.open(tmp_path / "good-a.png")
    assert img.size == (24, 24)
    out = tmp_path / "bb.png"
    assert main(["render", str(good), "--frame", "b", "--scale", "2", "-o", str(out)]) == 0
    assert Image.open(out).size == (16, 16)


def test_render_gif_for_anim(good: Path, tmp_path: Path) -> None:
    assert main(["render", str(good), "--anim", "idle", "--scale", "2"]) == 0
    im = Image.open(tmp_path / "good-idle.gif")
    assert im.n_frames == 2 and im.size == (16, 16)


def test_render_bad_args(good: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["render", str(good), "--frame", "a", "--anim", "idle"]) == 2
    assert main(["render", str(good), "--frame", "zz"]) == 2
    assert main(["render", str(good), "--anim", "zz"]) == 2
    assert "no anim" in capsys.readouterr().err


def test_sheet_and_preview(good: Path, tmp_path: Path) -> None:
    assert main(["sheet", str(good), "--scale", "2"]) == 0
    doc = json.loads((tmp_path / "good-sheet.json").read_text(encoding="utf-8"))
    assert [f["name"] for f in doc["frames"]] == ["a", "b"]
    assert Image.open(tmp_path / "good-sheet.png").size == (32, 16)
    out = tmp_path / "board.png"
    assert main(["preview", str(good), "-o", str(out)]) == 0
    assert max(Image.open(out).size) <= 1800


def test_pixelize_cli(good: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from pixelart.render import to_image

    sp = parse(GOOD)
    png = tmp_path / "up.png"
    to_image(sp, "a", 10).save(png)
    out = tmp_path / "out.pxl"
    assert main(["pixelize", str(png), "--size", "8x8", "-o", str(out)]) == 0
    back = parse(out.read_text(encoding="utf-8"))
    assert (back.w, back.h) == (8, 8)
    assert to_image(back, "main", 1).tobytes() == to_image(sp, "a", 1).tobytes()
    out2 = tmp_path / "out2.pxl"
    assert main(["pixelize", str(png), "--palette", "pico-8", "-o", str(out2)]) == 0
    assert parse(out2.read_text(encoding="utf-8")).w == 8
    assert main(["pixelize", str(tmp_path / "none.png"), "-o", str(out)]) == 2
    assert main(["pixelize", str(png), "--palette", "nope", "-o", str(out)]) == 2
    with pytest.raises(SystemExit):
        main(["pixelize", str(png), "--size", "huge", "-o", str(out)])


def test_ramp_command(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["ramp", "#c0502a", "-n", "4", "--shift", "20", "--name", "skin"]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 5
    assert lines[0].startswith("  a  #") and lines[0].endswith("skin-1")
    assert lines[-1] == "  ramp skin = a b c d"
    assert main(["ramp", "#c0502a", "-n", "3", "--keys", "xy"]) == 2
    assert main(["ramp", "#zzzzzz"]) == 2


def test_palettes_command(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["palettes"]) == 0
    out = capsys.readouterr().out
    for name in ("pico-8", "sweetie-16", "endesga-32", "night-owl"):
        assert name in out
    assert "16 colours" in out and "32 colours" in out


def test_new_writes_valid_skeleton(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert main(["new", "hero", "--size", "12x10", "--palette", "night-owl"]) == 0
    sp = parse((tmp_path / "hero.pxl").read_text(encoding="utf-8"))
    assert (sp.w, sp.h, len(sp.palette.opaque_keys())) == (12, 10, 16)
    assert set("".join(resolve_frames(sp)["main"])) == {"."}
    assert main(["new", "hero", "--size", "12x10"]) == 2  # refuses to overwrite
    assert main(["new", "hero", "--size", "12x10", "--force"]) == 0
    assert main(["new", "Bad Name", "--size", "4x4"]) == 2
    assert main(["new", "x", "--size", "4x4", "--palette", "nope"]) == 2


def test_compose_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    shutil.copy(FIXTURES / "dot.pxl", tmp_path / "dot.pxl")
    shutil.copy(FIXTURES / "scene.json", tmp_path / "scene.json")
    assert main(["compose", str(tmp_path / "scene.json")]) == 0
    assert Image.open(tmp_path / "scene.gif").n_frames == 5
    (tmp_path / "bad.json").write_text("{}", encoding="utf-8")
    assert main(["compose", str(tmp_path / "bad.json")]) == 1
    assert main(["compose", str(tmp_path / "gone.json")]) == 2


def test_python_dash_m_entrypoint(tmp_path: Path) -> None:
    import subprocess
    import sys

    r = subprocess.run(
        [sys.executable, "-m", "pixelart", "palettes"],
        capture_output=True,
        text=True,
        cwd=Path(__file__).resolve().parents[2],
        check=False,
    )
    assert r.returncode == 0 and "night-owl" in r.stdout


def test_dump_of_made_sprite_is_checkable(tmp_path: Path) -> None:
    sp = make({"a": rect(8, 8, 1, 1, 6, 6, "s")})
    p = tmp_path / "m.pxl"
    p.write_text(dump(sp), encoding="utf-8")
    assert main(["check", str(p)]) in (0, 1)
