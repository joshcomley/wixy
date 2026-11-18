"""Regenerate the deterministic Cookout test pack (spec 09b F.4): two real bank ingredients, four
tiny WebPs (a card and a thumb each), the tar and the manifest naming them with exact digests.

Run once and commit the outputs (`pack.tar`, `manifest.json`); CI never runs this. Needs Pillow only
here, to author the four WebPs; the tar and the manifest are stdlib and byte-deterministic."""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
IDS = ("andouille-sausage", "apricot")
COLOURS = {
    ("andouille-sausage", "card"): (200, 160, 120),
    ("andouille-sausage", "thumb"): (200, 160, 121),
    ("apricot", "card"): (250, 170, 60),
    ("apricot", "thumb"): (250, 170, 61),
}
# The URL is a placeholder: the CI job always overrides it with the build arg COOKOUT_PACK_URL
# (the sha256 still pins the content).
URL = "http://127.0.0.1:8099/cookout-test-pack.tar"


def webp(colour: tuple[int, int, int], size: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (size, size), colour).save(buf, "WEBP", lossless=True)
    return buf.getvalue()


def main() -> None:
    objects: dict[str, bytes] = {}
    items: dict[str, dict[str, object]] = {}
    for ingredient in IDS:
        refs: dict[str, str] = {}
        for rendition, size in (("card", 4), ("thumb", 2)):
            data = webp(COLOURS[(ingredient, rendition)], size)
            sha = hashlib.sha256(data).hexdigest()
            objects[sha] = data
            refs[rendition] = sha
        items[ingredient] = {**refs, "attempt": 1, "acceptedBy": "ci-test-pack"}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for sha in sorted(objects):
            info = tarfile.TarInfo(f"objects/{sha[:2]}/{sha}.webp")
            info.size = len(objects[sha])
            info.mode = 0o644
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(objects[sha]))
    tar_bytes = buf.getvalue()
    (HERE / "pack.tar").write_bytes(tar_bytes)
    manifest = {
        "packVersion": 1,
        "pack": {
            "url": URL,
            "sha256": hashlib.sha256(tar_bytes).hexdigest(),
            "bytes": len(tar_bytes),
            "objects": len(objects),
            "installedBytes": sum(len(v) for v in objects.values()),
        },
        "renditions": {"card": 512, "thumb": 160},
        "items": items,
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
