"""Game-mode tile pictures (spec/server-chat/09c §6.1): render candidates, then install one.

Two committed 512x512 WebP files, `admin-ui/data/cookout-mode-{classic,toastie}.webp`, each at
most 60 KB, rendered once on hub's ComfyUI with the §3.6 house look. Rendering goes through the
same empty-queue gate as the 09b picture batch (`wait_for_idle`), one picture at a time, so it
never jumps a running batch or a live game's picture.

    python -m tooling.cookout.mode_tiles render --out <dir> [--mode toastie] [--count 4]
    python -m tooling.cookout.mode_tiles install --mode toastie --source <candidate.png|webp>

`render` writes `<mode>-<n>.png` candidates (a person looks at them); `install` encodes the chosen
one to the committed path.
"""

from __future__ import annotations

import argparse
import io
import os
import random
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from tooling.cookout.visual.images import comfy_queue_getter, wait_for_idle

_REPO = Path(__file__).resolve().parents[2]
DATA_DIR = _REPO / "admin-ui" / "data"
TILE_PX = 512
MAX_BYTES = 60 * 1024
GATE_MAX_WAIT_S = 6 * 3600.0

_HOUSE = (
    "Photorealistic appetising food photograph, shallow depth of field, natural light, "
    "no people, no hands, no text, labels, logos, or watermark."
)

PROMPTS: Mapping[str, str] = {
    "classic": (
        "A rustic wicker basket on a wooden kitchen table, overflowing with a colourful mix of "
        "fresh ingredients: tomatoes, a loaf of bread, a wedge of cheese, herbs, eggs, peppers, "
        "lemons and a bunch of carrots, seen from slightly above, square composition. " + _HOUSE
    ),
    "toastie": (
        "One closed toasted sandwich cut in half, the two halves stacked slightly apart so the "
        "hot, melted cheese filling shows in the cross-section, golden crisp evenly toasted "
        "bread, on a wooden board in a home kitchen, square composition. " + _HOUSE
    ),
}


def tile_path(mode: str) -> Path:
    if mode not in PROMPTS:
        raise ValueError(f"unknown mode {mode!r}; expected one of {sorted(PROMPTS)}")
    return DATA_DIR / f"cookout-mode-{mode}.webp"


def encode_tile(source: Path, *, max_bytes: int = MAX_BYTES) -> bytes:
    """Centre-crop to a square, resize to 512, and encode WebP at the highest quality that fits
    `max_bytes`. Metadata is stripped."""
    from PIL import Image

    with Image.open(source) as im:
        rgb = im.convert("RGB")
        side = min(rgb.size)
        left, top = (rgb.width - side) // 2, (rgb.height - side) // 2
        square = rgb.crop((left, top, left + side, top + side)).resize(
            (TILE_PX, TILE_PX), Image.Resampling.LANCZOS
        )
    for quality in range(90, 29, -4):
        buf = io.BytesIO()
        square.save(buf, "WEBP", quality=quality, method=6)
        if buf.tell() <= max_bytes:
            return buf.getvalue()
    raise ValueError(f"could not encode {source} within {max_bytes} bytes")


def render_candidates(
    generator: Any,
    get_queue: Any,
    mode: str,
    out_dir: Path,
    *,
    count: int,
    seeds: Sequence[int] | None = None,
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    chosen = list(seeds) if seeds is not None else []
    while len(chosen) < count:
        chosen.append(random.SystemRandom().randrange(2**32))
    made: list[Path] = []
    for n, seed in enumerate(chosen[:count], start=1):
        if not wait_for_idle(get_queue, max_wait_s=GATE_MAX_WAIT_S):
            raise RuntimeError("ComfyUI never went idle; not rendering")
        scratch = out_dir / "_scratch"
        scratch.mkdir(exist_ok=True)
        paths = generator.generate_many([PROMPTS[mode]], scratch, seeds=[seed])
        png = paths[0] if paths else None
        if png is None:
            raise RuntimeError(f"ComfyUI produced no picture for {mode} (seed {seed})")
        dest = out_dir / f"{mode}-{n}-seed{seed}.png"
        png.replace(dest)
        made.append(dest)
    return made


def _load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
    return out


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    sub = parser.add_subparsers(dest="cmd", required=True)
    render = sub.add_parser("render")
    render.add_argument("--out", required=True)
    render.add_argument("--mode", choices=sorted(PROMPTS), action="append")
    render.add_argument("--count", type=int, default=4)
    install = sub.add_parser("install")
    install.add_argument("--mode", choices=sorted(PROMPTS), required=True)
    install.add_argument("--source", required=True)
    args = parser.parse_args(argv)

    if args.cmd == "install":
        data = encode_tile(Path(args.source))
        target = tile_path(args.mode)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f"{target} {len(data)} bytes")
        return 0

    from wixy_server.livechat.wyr_images import ComfyImageGenerator

    env = _load_env(Path(os.environ.get("WIXY_ENV_FILE", r"D:\Servers\Wixy\Storage\.env")))
    base_url = env.get("WIXY_COMFY_URL", "http://127.0.0.1:8199")
    out_dir = env.get("WIXY_COMFY_OUTPUT_DIR")
    if not out_dir:
        print("WIXY_COMFY_OUTPUT_DIR is not set; refusing to render", file=sys.stderr)
        return 2
    generator = ComfyImageGenerator(base_url, output_dir=Path(out_dir))
    get_queue = comfy_queue_getter(base_url)
    for mode in args.mode or sorted(PROMPTS):
        for path in render_candidates(generator, get_queue, mode, Path(args.out), count=args.count):
            print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
