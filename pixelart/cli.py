"""Command line entry point (`python -m pixelart <command>`)."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from PIL import Image

from . import palette as pal
from .compose import load_scene, save_scene_gif
from .export import export_ts
from .lint import lint
from .model import Frame, Palette, PaletteEntry, PxlError, Sprite, dump, parse
from .pixelize import KEY_CHARS, pixelize
from .render import preview_board, save_gif, save_png, save_sheet

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_USAGE = 2


def _load(path: str) -> Sprite:
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as e:
        raise _Fail(f"cannot read {path}: {e.strerror or e}", EXIT_USAGE) from e
    return parse(text, str(p))


class _Fail(Exception):
    def __init__(self, msg: str, code: int = EXIT_FINDINGS) -> None:
        super().__init__(msg)
        self.code = code


def _size(text: str) -> tuple[int, int]:
    m = re.fullmatch(r"(\d+)x(\d+)", text)
    if not m:
        raise argparse.ArgumentTypeError("size must be written WxH, e.g. 32x32")
    return int(m.group(1)), int(m.group(2))


def _cmd_render(a: argparse.Namespace) -> int:
    sp = _load(a.file)
    stem = Path(a.file).with_suffix("")
    if a.frame is not None and a.anim is not None:
        raise _Fail("use --frame or --anim, not both", EXIT_USAGE)
    try:
        if a.anim is not None:
            out = Path(a.output) if a.output else Path(f"{stem}-{a.anim}.gif")
            save_gif(sp, a.anim, out, a.scale)
        else:
            frame = a.frame if a.frame is not None else next(iter(sp.frames))
            out = Path(a.output) if a.output else Path(f"{stem}-{frame}.png")
            save_png(sp, frame, out, a.scale)
    except KeyError as e:
        raise _Fail(str(e.args[0]), EXIT_USAGE) from e
    print(f"wrote {out}")
    return EXIT_OK


def _cmd_sheet(a: argparse.Namespace) -> int:
    sp = _load(a.file)
    out = Path(a.output) if a.output else Path(f"{Path(a.file).with_suffix('')}-sheet.png")
    side = save_sheet(sp, out, a.scale)
    print(f"wrote {out} and {side}")
    return EXIT_OK


def _cmd_preview(a: argparse.Namespace) -> int:
    sp = _load(a.file)
    out = Path(a.output) if a.output else Path(f"{Path(a.file).with_suffix('')}-board.png")
    board = preview_board(sp, a.scale)
    board.save(out, format="PNG")
    print(f"wrote {out} ({board.width}x{board.height})")
    return EXIT_OK


def _cmd_check(a: argparse.Namespace) -> int:
    try:
        sp = _load(a.file)
    except PxlError as e:
        print(f"error parse: {e}")
        print("1 error, 0 warnings")
        return EXIT_FINDINGS
    findings = sorted(lint(sp), key=lambda f: f.level != "error")
    for f in findings:
        print(f"{f.level:5} {f.code:22} {f.where():24} {f.message}")
        print(f"      fix: {f.hint}")
    errors = sum(1 for f in findings if f.level == "error")
    warns = len(findings) - errors
    print(f"{errors} error{'s' * (errors != 1)}, {warns} warning{'s' * (warns != 1)}")
    if errors or (a.strict and warns):
        return EXIT_FINDINGS
    return EXIT_OK


def _cmd_pixelize(a: argparse.Namespace) -> int:
    try:
        img = Image.open(a.png)
    except OSError as e:
        raise _Fail(f"cannot read {a.png}: {e}", EXIT_USAGE) from e
    palette = None
    if a.palette:
        try:
            palette = pal.load_palette(a.palette)
        except (FileNotFoundError, ValueError) as e:
            raise _Fail(str(e), EXIT_USAGE) from e
    try:
        sp = pixelize(img, a.size, palette, a.colors, key_bg=not a.no_bg, name=Path(a.png).stem)
    except ValueError as e:
        raise _Fail(str(e)) from e
    out = Path(a.output)
    out.write_text(dump(sp), encoding="utf-8", newline="\n")
    print(f"wrote {out} ({sp.w}x{sp.h}, {len(sp.palette.opaque_keys())} colours)")
    return EXIT_OK


def _cmd_ramp(a: argparse.Namespace) -> int:
    try:
        cols = pal.ramp(a.hex, a.n, a.shift)
    except ValueError as e:
        raise _Fail(str(e), EXIT_USAGE) from e
    keys = a.keys or "abcdefghijklmnopqrstuvwxyz"[: a.n]
    if len(keys) != a.n:
        raise _Fail(f"--keys needs exactly {a.n} characters", EXIT_USAGE)
    for i, (k, c) in enumerate(zip(keys, cols, strict=True), 1):
        print(f"  {k}  {c}  {a.name}-{i}")
    print(f"  ramp {a.name} = {' '.join(keys)}")
    return EXIT_OK


def _cmd_palettes(_: argparse.Namespace) -> int:
    for n in pal.palette_names():
        print(f"{n:14} {len(pal.load_palette(n))} colours")
    return EXIT_OK


def _cmd_new(a: argparse.Namespace) -> int:
    if not re.fullmatch(r"[a-z0-9-]+", a.name):
        raise _Fail("name must match [a-z0-9-]+", EXIT_USAGE)
    try:
        cols = pal.load_palette(a.palette)
    except (FileNotFoundError, ValueError) as e:
        raise _Fail(str(e), EXIT_USAGE) from e
    if len(cols) > len(KEY_CHARS):
        raise _Fail("palette has too many colours for single-character keys", EXIT_USAGE)
    ordered = sorted(cols, key=lambda c: pal.luminance_key(c))
    entries = {KEY_CHARS[i]: PaletteEntry(KEY_CHARS[i], c) for i, c in enumerate(ordered)}
    w, h = a.size
    sp = Sprite(name=a.name, w=w, h=h, palette=Palette(entries))
    sp.frames["main"] = Frame("main", rows=["." * w for _ in range(h)])
    out = Path(a.output) if a.output else Path(f"{a.name}.pxl")
    if out.exists() and not a.force:
        raise _Fail(f"{out} already exists (use --force)", EXIT_USAGE)
    out.write_text(dump(sp), encoding="utf-8", newline="\n")
    print(f"wrote {out}")
    return EXIT_OK


def _cmd_compose(a: argparse.Namespace) -> int:
    try:
        scene = load_scene(a.scene)
    except OSError as e:
        raise _Fail(f"cannot read {a.scene}: {e.strerror or e}", EXIT_USAGE) from e
    except ValueError as e:
        raise _Fail(str(e)) from e
    out = Path(a.output) if a.output else Path(a.scene).with_suffix(".gif")
    save_scene_gif(scene, out)
    print(f"wrote {out} ({scene.ticks} ticks of {scene.tick_ms}ms)")
    return EXIT_OK


def _cmd_export_ts(a: argparse.Namespace) -> int:
    out = Path(a.output)
    files = sorted(a.files)
    names = " ".join(Path(f).as_posix() for f in files)
    command = f"python -m pixelart export-ts {names} -o {out.as_posix()}"
    text = export_ts(files, command)
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print(f"wrote {out} ({len(files)} sprites)")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="python -m pixelart", description="Palette-locked pixel art authored as data (.pxl)."
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("render", help="render a frame to PNG or an anim to GIF")
    p.add_argument("file")
    p.add_argument("--frame")
    p.add_argument("--anim")
    p.add_argument("--scale", type=int, default=8)
    p.add_argument("-o", "--output")
    p.set_defaults(fn=_cmd_render)

    p = sub.add_parser("sheet", help="sprite sheet PNG + JSON sidecar")
    p.add_argument("file")
    p.add_argument("--scale", type=int, default=1)
    p.add_argument("-o", "--output")
    p.set_defaults(fn=_cmd_sheet)

    p = sub.add_parser("preview", help="one inspection board PNG for visual review")
    p.add_argument("file")
    p.add_argument("--scale", type=int, default=None)
    p.add_argument("-o", "--output")
    p.set_defaults(fn=_cmd_preview)

    p = sub.add_parser("check", help="lint; exit 1 on errors (and warnings with --strict)")
    p.add_argument("file")
    p.add_argument("--strict", action="store_true")
    p.set_defaults(fn=_cmd_check)

    p = sub.add_parser("pixelize", help="PNG -> .pxl sketch")
    p.add_argument("png")
    p.add_argument("--size", type=_size, help="target WxH in pixels (default: auto-detect)")
    p.add_argument("--palette", help="built-in palette name or .pal file")
    p.add_argument("--colors", type=int, default=16)
    p.add_argument("--no-bg", action="store_true", help="do not key out the background")
    p.add_argument("-o", "--output", required=True)
    p.set_defaults(fn=_cmd_pixelize)

    p = sub.add_parser("ramp", help="print a hue-shifted dark->light ramp as palette lines")
    p.add_argument("hex")
    p.add_argument("-n", type=int, default=5)
    p.add_argument("--shift", type=float, default=20.0)
    p.add_argument("--keys", help="one palette key character per shade")
    p.add_argument("--name", default="ramp")
    p.set_defaults(fn=_cmd_ramp)

    p = sub.add_parser("palettes", help="list built-in palettes")
    p.set_defaults(fn=_cmd_palettes)

    p = sub.add_parser("new", help="write a skeleton .pxl")
    p.add_argument("name")
    p.add_argument("--size", type=_size, required=True)
    p.add_argument("--palette", default="sweetie-16")
    p.add_argument("-o", "--output")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=_cmd_new)

    p = sub.add_parser("compose", help="render a multi-sprite scene (JSON) to GIF")
    p.add_argument("scene")
    p.add_argument("-o", "--output")
    p.set_defaults(fn=_cmd_compose)

    p = sub.add_parser("export-ts", help="emit sprites as a strict-TypeScript module")
    p.add_argument("files", nargs="+")
    p.add_argument("-o", "--output", required=True)
    p.set_defaults(fn=_cmd_export_ts)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        code: int = args.fn(args)
    except PxlError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_FINDINGS
    except _Fail as e:
        print(f"error: {e}", file=sys.stderr)
        return e.code
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_USAGE
    return code
