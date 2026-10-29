"""Image generation driver (spec/server-chat/09b §B): gate, journal, ladder, renditions, pack.

Run as a Grid task on a hub worker (never session 0). The ComfyUI client is
`wixy_server.livechat.wyr_images.ComfyImageGenerator`, unchanged. Everything that matters for
correctness (the empty-queue gate, the attempt ladder, resumability, the deterministic pack and
the manifest) is a small pure function so it is unit-tested with no GPU or network.

This module holds the library pieces only. The long-running render/check driver and the
`gh` release step need the live fleet and the catalogue (parcel 1), so they are wired in a
later change; nothing here claims a CLI.
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CARD_PX = 512
THUMB_PX = 160
GATE_POLLS = 3
GATE_POLL_GAP_S = 1.0
STATES = ("queued", "rendered", "checked", "accepted", "regenerate", "review")
MAX_AUTO_ATTEMPTS = 4
MAX_REVIEW_ATTEMPTS = 6
EMPTY_MANIFEST_RENDITIONS = {"card": CARD_PX, "thumb": THUMB_PX}


# --- the empty-queue gate --------------------------------------------------------------------


def queue_is_idle(queue: Mapping[str, Any]) -> bool:
    return not queue.get("queue_running") and not queue.get("queue_pending")


def wait_for_idle(
    get_queue: Callable[[], Mapping[str, Any]],
    *,
    pause_file: Path | None = None,
    sleep: Callable[[float], None] = time.sleep,
    polls: int = GATE_POLLS,
    gap_s: float = GATE_POLL_GAP_S,
    max_wait_s: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Block until ComfyUI's `/queue` shows nothing running or pending on `polls` consecutive
    polls `gap_s` apart. Returns False if `pause_file` exists (the batch stops between pictures)
    or `max_wait_s` passes. A live game's picture therefore waits for at most one batch picture."""
    started = clock()
    calm = 0
    while calm < polls:
        if pause_file is not None and pause_file.exists():
            return False
        if max_wait_s is not None and clock() - started > max_wait_s:
            return False
        calm = calm + 1 if queue_is_idle(get_queue()) else 0
        if calm < polls:
            sleep(gap_s)
    return True


# --- the attempt ladder ----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AttemptPlan:
    attempt: int
    rewrite_visual: bool  # attempt 3: Haiku rewrites `visual` first
    new_seed: bool  # attempt 1 draws a random seed too; 2 and 4 are explicit "new seed"


def plan_attempt(attempt: int) -> AttemptPlan:
    """1 catalogue visual; 2 same visual new seed; 3 rewritten visual; 4 rewritten, new seed.
    5 and 6 (after an Opus review gives a new visual) are checked normally."""
    if not 1 <= attempt <= MAX_REVIEW_ATTEMPTS:
        raise ValueError(f"attempt {attempt} is outside 1..{MAX_REVIEW_ATTEMPTS}")
    return AttemptPlan(attempt, rewrite_visual=attempt == 3, new_seed=True)


def after_failure(attempt: int, *, reviewed: bool) -> str:
    """What follows a failed attempt: `retry` (next attempt), `review` (Opus), `pictureless`."""
    if reviewed:
        return "retry" if attempt < MAX_REVIEW_ATTEMPTS else "pictureless"
    return "retry" if attempt < MAX_AUTO_ATTEMPTS else "review"


# --- journal ---------------------------------------------------------------------------------


def journal_append(path: Path, entry: Mapping[str, Any]) -> None:
    if entry.get("state") not in STATES:
        raise ValueError(f"unknown state {entry.get('state')!r}")
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({**entry, "at": time.time()}, sort_keys=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(line + "\n")


def journal_state(path: Path) -> dict[str, dict[str, Any]]:
    """Latest journal line per ingredient id (a torn final line from a crash is ignored)."""
    latest: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return latest
    for raw in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            latest[entry["id"]] = entry
    return latest


def pending_work(
    ids: Sequence[str], state: Mapping[str, Mapping[str, Any]], masters_exist: Callable[[str], bool]
) -> list[str]:
    """Ids still to do: accepted ones are skipped, and an attempt whose master file is missing
    is re-rendered rather than trusted."""
    todo: list[str] = []
    for ident in ids:
        entry = state.get(ident)
        if entry is None:
            todo.append(ident)
        elif entry["state"] == "accepted":
            continue
        elif entry["state"] in ("rendered", "checked") and not masters_exist(ident):
            todo.append(ident)
        elif entry["state"] in ("queued", "regenerate"):
            todo.append(ident)
    return todo


# --- renditions ------------------------------------------------------------------------------


def encode_master(png_path: Path, dest: Path) -> None:
    """1024 master as WebP q92, metadata stripped (disk is tight: no PNG masters)."""
    from PIL import Image

    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(png_path) as im:
        im.convert("RGB").save(dest, "WEBP", quality=92, method=6, exif=b"", icc_profile=None)


def make_renditions(master: Path) -> tuple[bytes, bytes]:
    """(card 512 WebP q82, thumb 160 WebP q78), Lanczos, method 6."""
    from PIL import Image

    out: list[bytes] = []
    with Image.open(master) as im:
        rgb = im.convert("RGB")
        for px, quality in ((CARD_PX, 82), (THUMB_PX, 78)):
            buf = io.BytesIO()
            rgb.resize((px, px), Image.Resampling.LANCZOS).save(
                buf, "WEBP", quality=quality, method=6
            )
            out.append(buf.getvalue())
    return out[0], out[1]


# --- the pack and its manifest ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AcceptedPicture:
    ident: str
    card: bytes
    thumb: bytes
    attempt: int
    accepted_by: str


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_pack(
    pictures: Sequence[AcceptedPicture], tar_path: Path, *, pack_version: int, url: str
) -> dict[str, Any]:
    """Write the deterministic tar (sorted members, zeroed metadata) and return the manifest
    dict. Identical pictures give an identical tar, so a re-run reproduces the same sha256."""
    objects: dict[str, bytes] = {}
    items: dict[str, dict[str, Any]] = {}
    for pic in sorted(pictures, key=lambda p: p.ident):
        card_sha, thumb_sha = sha256_hex(pic.card), sha256_hex(pic.thumb)
        objects[card_sha] = pic.card
        objects[thumb_sha] = pic.thumb
        items[pic.ident] = {
            "card": card_sha,
            "thumb": thumb_sha,
            "attempt": pic.attempt,
            "acceptedBy": pic.accepted_by,
        }
    tar_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path, "w", format=tarfile.USTAR_FORMAT) as tar:
        for sha in sorted(objects):
            info = tarfile.TarInfo(f"objects/{sha[:2]}/{sha}.webp")
            info.size = len(objects[sha])
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(objects[sha]))
    data = tar_path.read_bytes()
    return {
        "packVersion": pack_version,
        "pack": {
            "url": url,
            "sha256": sha256_hex(data),
            "bytes": len(data),
            "objects": len(objects),
            "installedBytes": sum(len(b) for b in objects.values()),
        },
        "renditions": dict(EMPTY_MANIFEST_RENDITIONS),
        "items": items,
    }


def write_manifest(path: Path, manifest: Mapping[str, Any]) -> None:
    """Same layout as the committed empty manifest: sorted keys, indent 1, LF, newline."""
    path.write_text(
        json.dumps(manifest, sort_keys=True, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def release_url(owner_repo: str, pack_version: int) -> str:
    tag = f"cookout-images-v{pack_version}"
    return f"https://github.com/{owner_repo}/releases/download/{tag}/{tag}.tar"


def history_check(
    manifests: Sequence[Mapping[str, Any]], head_bytes: Callable[[str], int | None]
) -> list[str]:
    """For every manifest ever committed, its pack URL must answer with exactly its `bytes`.
    Returns the problems (empty = the history is intact). Empty-pack manifests are skipped."""
    problems: list[str] = []
    for manifest in manifests:
        pack = manifest.get("pack")
        if not isinstance(pack, dict):
            continue
        url, expected = pack.get("url"), pack.get("bytes")
        got = head_bytes(url) if isinstance(url, str) else None
        if got != expected:
            problems.append(f"{url}: answers {got}, manifest says {expected}")
    return problems


def status_json(
    total: int, state: Mapping[str, Mapping[str, Any]], rate_per_s: float | None
) -> dict[str, Any]:
    by_state: dict[str, int] = {}
    for entry in state.values():
        by_state[entry["state"]] = by_state.get(entry["state"], 0) + 1
    accepted = by_state.get("accepted", 0)
    eta = None if not rate_per_s else (total - accepted) / rate_per_s
    return {"total": total, "byState": by_state, "etaSeconds": eta, "at": time.time()}
