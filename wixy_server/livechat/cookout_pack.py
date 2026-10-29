"""Cookout ingredient-picture pack: manifest, content-addressed object store, pins, GC.

Spec: `spec/server-chat/09b-cookout-visual.md` §B.6 (storage) and §B.7 (serving). The pictures
live OUTSIDE git as content-addressed `objects/<2 hex>/<sha256>.webp` files; the committed
manifest (`cookout_ingredient_images.json`) maps each ingredient id to the sha256 of its two
renditions and pins one immutable tar "pack" (a GitHub Release asset) by its own sha256.

This file is **stdlib only** and runnable as a script: the standalone Dockerfile copies just this
file and the manifest, then runs `cookout_pack.py fetch ...` before `pip install`.

Everything that mutates a store (registration, pins, install, self-heal, GC) holds the ONE
cross-process lock `<storage>/cookout-images/.lock`. Downloads happen outside it. Time is epoch
seconds everywhere (never a formatted string).
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import sys
import tarfile
import time
import urllib.request
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import IO, Any

MANIFEST_PATH = Path(__file__).with_name("cookout_ingredient_images.json")

MAX_PACK_BYTES = 400 * 1024 * 1024
MAX_INSTALLED_BYTES = 400 * 1024 * 1024
MAX_OBJECTS = 10_000
MAX_OBJECT_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 5_000
RETIRED_KEEP_S = 72 * 3600
SLOT_LEASE_S = 900
SLOT_REFRESH_S = 300
LOCK_TIMEOUT_S = 120.0
YOUNG_OBJECT_S = 3600
INCOMING_STALE_S = 3600
PENDING_WARN_S = 30 * 24 * 3600
ADMISSION_MARGIN_BYTES = 64 * 1024 * 1024
DOWNLOAD_CONNECT_TIMEOUT_S = 30.0
DOWNLOAD_DEADLINE_S = 15 * 60.0

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
_MEMBER_RE = re.compile(r"^objects/([0-9a-f]{2})/([0-9a-f]{64})\.webp$")
_PIN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# A valid 1x1 WebP, used by `placeholders` (e2e fixtures only check presence).
_PLACEHOLDER_WEBP = base64.b64decode("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")


class PackError(ValueError):
    """A manifest, pack or pack member broke a rule. Never clamped: always refused."""


class StoreBusy(Exception):
    """The lock was not acquired within the timeout, or a live download reservation exists."""


class FetchRefused(Exception):
    """Download admission (the disk floor) refused; nothing changed."""


@dataclass(frozen=True, slots=True)
class ImageRef:
    card: str  # sha256 hex
    thumb: str  # sha256 hex


@dataclass(frozen=True, slots=True)
class PackRef:
    url: str
    sha256: str
    bytes: int
    objects: int
    installed_bytes: int


@dataclass(frozen=True, slots=True)
class PackManifest:
    pack_version: int
    pack: PackRef | None  # None only for the empty manifest
    items: Mapping[str, ImageRef]
    digest: str  # sha256 of the manifest file's bytes

    def shas(self) -> frozenset[str]:
        out: set[str] = set()
        for ref in self.items.values():
            out.add(ref.card)
            out.add(ref.thumb)
        return frozenset(out)


# --- manifest -------------------------------------------------------------------------------


def object_relpath(sha: str) -> PurePosixPath:
    """`ab/ab…ef.webp` for a sha256 hex."""
    if not _SHA_RE.match(sha):
        raise PackError(f"not a sha256 hex: {sha!r}")
    return PurePosixPath(sha[:2]) / f"{sha}.webp"


def _int_field(raw: Mapping[str, Any], key: str, *, maximum: int, what: str) -> int:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise PackError(f"{what}.{key} is mandatory and must be an integer")
    if value < 0 or value > maximum:
        raise PackError(f"{what}.{key}={value} is outside 0..{maximum}")
    return value


def parse_manifest(data: bytes) -> PackManifest:
    """Strict parse of a manifest file's bytes (every hard bound enforced)."""
    digest = hashlib.sha256(data).hexdigest()
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackError(f"manifest is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise PackError("manifest must be a JSON object")
    pack_version = raw.get("packVersion")
    if isinstance(pack_version, bool) or not isinstance(pack_version, int) or pack_version < 0:
        raise PackError("packVersion must be a non-negative integer")
    renditions = raw.get("renditions")
    if not isinstance(renditions, dict):
        raise PackError("renditions must be an object")
    raw_items = raw.get("items")
    if not isinstance(raw_items, dict):
        raise PackError("items must be an object")
    if len(raw_items) > MAX_ITEMS:
        raise PackError(f"{len(raw_items)} items exceeds the {MAX_ITEMS} limit")
    items: dict[str, ImageRef] = {}
    for item_id, entry in raw_items.items():
        if not isinstance(entry, dict):
            raise PackError(f"item {item_id!r} must be an object")
        card, thumb = entry.get("card"), entry.get("thumb")
        if not (isinstance(card, str) and _SHA_RE.match(card)):
            raise PackError(f"item {item_id!r}: card is not a sha256 hex")
        if not (isinstance(thumb, str) and _SHA_RE.match(thumb)):
            raise PackError(f"item {item_id!r}: thumb is not a sha256 hex")
        items[item_id] = ImageRef(card=card, thumb=thumb)

    raw_pack = raw.get("pack")
    pack: PackRef | None
    if raw_pack is None:
        if items:
            raise PackError("a manifest with items must name its pack")
        pack = None
    else:
        if not isinstance(raw_pack, dict):
            raise PackError("pack must be an object or null")
        url = raw_pack.get("url")
        sha = raw_pack.get("sha256")
        if not (isinstance(url, str) and url.startswith(("https://", "http://"))):
            raise PackError("pack.url is mandatory and must be an http(s) URL")
        if not (isinstance(sha, str) and _SHA_RE.match(sha)):
            raise PackError("pack.sha256 is mandatory and must be a sha256 hex")
        size = _int_field(raw_pack, "bytes", maximum=MAX_PACK_BYTES, what="pack")
        objects = _int_field(raw_pack, "objects", maximum=MAX_OBJECTS, what="pack")
        installed = _int_field(raw_pack, "installedBytes", maximum=MAX_INSTALLED_BYTES, what="pack")
        pack = PackRef(url=url, sha256=sha, bytes=size, objects=objects, installed_bytes=installed)
        manifest_shas = {s for ref in items.values() for s in (ref.card, ref.thumb)}
        if objects != len(manifest_shas):
            raise PackError(
                f"pack.objects={objects} but the items name {len(manifest_shas)} distinct objects"
            )
    return PackManifest(pack_version=pack_version, pack=pack, items=items, digest=digest)


def load_manifest(path: Path | None = None) -> PackManifest:
    """Load and validate a manifest file (default: the committed one)."""
    target = path if path is not None else MANIFEST_PATH
    try:
        data = target.read_bytes()
    except OSError as exc:
        raise PackError(f"cannot read manifest {target}: {exc}") from exc
    return parse_manifest(data)


def _canonical_registry_json(manifest: PackManifest) -> str:
    pack = manifest.pack
    body: dict[str, Any] = {
        "digest": manifest.digest,
        "packVersion": manifest.pack_version,
        "pack": None
        if pack is None
        else {
            "url": pack.url,
            "sha256": pack.sha256,
            "bytes": pack.bytes,
            "objects": pack.objects,
            "installedBytes": pack.installed_bytes,
        },
        "items": {k: {"card": v.card, "thumb": v.thumb} for k, v in sorted(manifest.items.items())},
    }
    return json.dumps(body, sort_keys=True, indent=1) + "\n"


# --- helpers --------------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError:
        return None
    return raw if isinstance(raw, dict) else None


@contextlib.contextmanager
def _file_lock(path: Path, timeout_s: float) -> Iterator[None]:
    """Exclusive OS file lock with a bounded blocking acquire. Never proceeds unlocked."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fh: IO[bytes] = path.open("a+b")
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            try:
                if sys.platform == "win32":
                    import msvcrt

                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise StoreBusy(f"could not take {path} within {timeout_s:.0f}s") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            with contextlib.suppress(OSError):
                if sys.platform == "win32":
                    import msvcrt

                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()


def _check_member_header(member: tarfile.TarInfo) -> str:
    """Validate a tar member's name/type/size; return its sha (the file name stem)."""
    if not member.isreg():
        raise PackError(f"member {member.name!r} is not a regular file")
    match = _MEMBER_RE.match(member.name)
    if match is None or match.group(1) != match.group(2)[:2]:
        raise PackError(f"member name {member.name!r} is not objects/<2 hex>/<sha256>.webp")
    if member.size > MAX_OBJECT_BYTES:
        raise PackError(f"member {member.name!r} is {member.size} bytes (limit {MAX_OBJECT_BYTES})")
    return match.group(2)


def _scan_tar(tar_path: Path, manifest: PackManifest) -> list[tuple[str, int]]:
    """Header-only pass: every rule that needs no payload read. -> [(sha, size)]."""
    pack = manifest.pack
    if pack is None:
        raise PackError("the empty manifest has no pack to install")
    want = manifest.shas()
    seen: dict[str, int] = {}
    total = 0
    try:
        with tarfile.open(tar_path, mode="r:") as tar:
            for member in tar:
                sha = _check_member_header(member)
                if sha in seen:
                    raise PackError(f"duplicate member {member.name!r}")
                if sha not in want:
                    raise PackError(f"extra member {member.name!r} is not in the manifest")
                if len(seen) + 1 > pack.objects:
                    raise PackError(f"more than {pack.objects} members")
                total += member.size
                if total > pack.installed_bytes:
                    raise PackError(f"members total over installedBytes={pack.installed_bytes}")
                seen[sha] = member.size
    except tarfile.TarError as exc:
        raise PackError(f"not a readable tar: {exc}") from exc
    missing = want - seen.keys()
    if missing:
        raise PackError(f"{len(missing)} manifest objects are missing from the tar")
    return list(seen.items())


def _extract_objects(
    tar_path: Path, manifest: PackManifest, objects_dir: Path, *, scanned: list[tuple[str, int]]
) -> int:
    """Write each member to `objects_dir` (temp name in its directory, verify, rename)."""
    written = 0
    sizes = dict(scanned)
    with tarfile.open(tar_path, mode="r:") as tar:
        for member in tar:
            sha = _check_member_header(member)
            target = objects_dir / object_relpath(sha)
            if target.is_file() and target.stat().st_size == sizes[sha]:
                continue
            src = tar.extractfile(member)
            if src is None:
                raise PackError(f"cannot read member {member.name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(f".{sha}.{secrets.token_hex(4)}.tmp")
            h = hashlib.sha256()
            try:
                with tmp.open("wb") as out:
                    remaining = member.size
                    while remaining > 0:
                        chunk = src.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        h.update(chunk)
                        out.write(chunk)
                        remaining -= len(chunk)
                if remaining or h.hexdigest() != sha:
                    raise PackError(f"member {member.name!r} does not match its sha256")
                os.replace(tmp, target)
            finally:
                with contextlib.suppress(OSError):
                    tmp.unlink()
            written += 1
    return written


def _download(
    url: str, part: Path, *, max_bytes: int, expected_bytes: int, deadline_s: float
) -> None:
    """Bounded stream to `part`: abort on the first byte beyond `max_bytes`, require exactly
    `expected_bytes` at the end."""
    if not url.startswith(("https://", "http://")):
        raise PackError(f"refusing non-http(s) pack URL {url!r}")
    started = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": "wixy-cookout-pack"})  # noqa: S310
    total = 0
    with (
        urllib.request.urlopen(request, timeout=DOWNLOAD_CONNECT_TIMEOUT_S) as response,  # noqa: S310
        part.open("wb") as out,
    ):
        while True:
            if time.monotonic() - started > deadline_s:
                raise PackError("download exceeded its total deadline")
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise PackError(f"download exceeds the {max_bytes} bytes the manifest pins")
            out.write(chunk)
    if total != expected_bytes:
        raise PackError(f"downloaded {total} bytes, the manifest pins {expected_bytes}")


def _verify_tar_identity(tar_path: Path, pack: PackRef) -> None:
    size = tar_path.stat().st_size
    if size != pack.bytes:
        raise PackError(f"tar is {size} bytes, the manifest pins {pack.bytes}")
    if _sha256_file(tar_path) != pack.sha256:
        raise PackError("tar sha256 does not match the manifest's pack.sha256")


def _need_bytes(manifest: PackManifest, present_bytes: int) -> int:
    pack = manifest.pack
    assert pack is not None
    return pack.bytes + max(0, pack.installed_bytes - present_bytes) + ADMISSION_MARGIN_BYTES


# --- the store ------------------------------------------------------------------------------


class PackStore:
    """`<storage>/cookout-images/`: objects, registry, pins, incoming, the one lock."""

    def __init__(
        self,
        root: Path,
        *,
        min_free_bytes: int,
        clock: Callable[[], float] = time.time,
        free_space: Callable[[Path], int] | None = None,
        lock_timeout_s: float = LOCK_TIMEOUT_S,
    ) -> None:
        self.root = root
        self.objects_dir = root / "objects"
        self._manifests = root / "registry" / "manifests"
        self._pins = root / "registry" / "pins"
        self._incoming = root / "incoming"
        self._lock_path = root / ".lock"
        self._min_free = min_free_bytes
        self._clock = clock
        self._free_space = free_space or (lambda p: shutil.disk_usage(p).free)
        self._lock_timeout_s = lock_timeout_s
        for d in (self.objects_dir, self._manifests, self._pins, self._incoming):
            d.mkdir(parents=True, exist_ok=True)

    def _locked(self) -> contextlib.AbstractContextManager[None]:
        return _file_lock(self._lock_path, self._lock_timeout_s)

    # -- registry / pins (call with the lock held) --

    def _register_manifest(self, manifest: PackManifest) -> None:
        path = self._manifests / f"{manifest.digest}.json"
        if not path.exists():
            _atomic_write_text(path, _canonical_registry_json(manifest))

    def _write_pin(self, pin_id: str, body: dict[str, Any]) -> None:
        _atomic_write_text(self._pins / f"{pin_id}.json", json.dumps(body, sort_keys=True) + "\n")

    def _read_pin(self, pin_id: str) -> dict[str, Any]:
        if not _PIN_ID_RE.match(pin_id):
            raise PackError(f"bad pin id {pin_id!r}")
        pin = _read_json(self._pins / f"{pin_id}.json")
        if pin is None:
            raise PackError(f"unknown pin {pin_id!r}")
        return pin

    def _sweep_incoming(self) -> None:
        cutoff = self._clock() - INCOMING_STALE_S
        for entry in self._incoming.iterdir():
            with contextlib.suppress(OSError):
                if entry.is_file() and entry.stat().st_mtime < cutoff:
                    entry.unlink()

    def register_slot(self, manifest: PackManifest) -> str:
        """Server startup: register the packaged manifest and write a slot pin."""
        with self._locked():
            self._sweep_incoming()
            self._register_manifest(manifest)
            pin_id = f"slot-{secrets.token_hex(8)}"
            now = self._clock()
            self._write_pin(
                pin_id,
                {
                    "digest": manifest.digest,
                    "kind": "slot",
                    "holder": f"pid-{os.getpid()}",
                    "createdAt": now,
                    "leaseUntil": now + SLOT_LEASE_S,
                    "retiredAt": None,
                },
            )
            with contextlib.suppress(OSError):
                (self._pins / f"pending-{manifest.digest}.json").unlink()
            return pin_id

    def refresh_slot(self, pin_id: str) -> None:
        with self._locked():
            pin = self._read_pin(pin_id)
            if pin.get("retiredAt") is None:
                pin["leaseUntil"] = self._clock() + SLOT_LEASE_S
                self._write_pin(pin_id, pin)

    def retire_slot(self, pin_id: str) -> None:
        with self._locked():
            pin = self._read_pin(pin_id)
            pin["retiredAt"] = self._clock()
            self._write_pin(pin_id, pin)

    def cancel_pending(self, digest: str) -> bool:
        with self._locked():
            path = self._pins / f"pending-{digest}.json"
            if not path.exists():
                return False
            path.unlink()
            return True

    # -- install / fetch --

    def _install_locked(self, tar_path: Path, manifest: PackManifest) -> int:
        pack = manifest.pack
        if pack is None:
            raise PackError("the empty manifest has no pack to install")
        _verify_tar_identity(tar_path, pack)
        scanned = _scan_tar(tar_path, manifest)
        self._register_manifest(manifest)
        pending = self._pins / f"pending-{manifest.digest}.json"
        if not pending.exists():
            self._write_pin(
                f"pending-{manifest.digest}",
                {
                    "digest": manifest.digest,
                    "kind": "pending",
                    "holder": "install",
                    "createdAt": self._clock(),
                    "leaseUntil": None,
                    "retiredAt": None,
                },
            )
        written = _extract_objects(tar_path, manifest, self.objects_dir, scanned=scanned)
        self._gc_locked()
        return written

    def install(self, tar_path: Path, manifest: PackManifest) -> int:
        """Tooling install before the manifest PR merges: a pending pin first, then objects."""
        with self._locked():
            return self._install_locked(tar_path, manifest)

    def _present_bytes(self, manifest: PackManifest) -> int:
        total = 0
        for sha in manifest.shas():
            with contextlib.suppress(OSError):
                total += (self.objects_dir / object_relpath(sha)).stat().st_size
        return total

    def fetch(self, manifest: PackManifest, *, url: str | None = None) -> int:
        """Self-heal: admitted, bounded download of the pack, then a locked install."""
        pack = manifest.pack
        if pack is None:
            return 0
        reserve = self._incoming / f"{manifest.digest}.reserve"
        with self._locked():
            self._sweep_incoming()
            for other in self._incoming.glob("*.reserve"):
                with contextlib.suppress(OSError):
                    if self._clock() - other.stat().st_mtime < INCOMING_STALE_S:
                        raise StoreBusy("a pack download is already in progress")
            need = _need_bytes(manifest, self._present_bytes(manifest))
            free = self._free_space(self.root)
            if free - need < self._min_free:
                raise FetchRefused(
                    f"need {need} bytes plus a {self._min_free} floor but only {free} are free"
                )
            _atomic_write_text(reserve, json.dumps({"need": need, "at": self._clock()}) + "\n")
        part = self._incoming / f"{manifest.digest}.{secrets.token_hex(4)}.part"
        try:
            _download(
                url or pack.url,
                part,
                max_bytes=pack.bytes,
                expected_bytes=pack.bytes,
                deadline_s=DOWNLOAD_DEADLINE_S,
            )
            with self._locked():
                return self._install_locked(part, manifest)
        finally:
            for leftover in (part, reserve):
                with contextlib.suppress(OSError):
                    leftover.unlink()

    # -- GC --

    def _keep_digests(self) -> set[str]:
        now = self._clock()
        keep: set[str] = set()
        for path in self._pins.glob("*.json"):
            pin = _read_json(path)
            if pin is None or not isinstance(pin.get("digest"), str):
                continue
            kind, retired, lease = pin.get("kind"), pin.get("retiredAt"), pin.get("leaseUntil")
            if kind == "pending":
                keep.add(pin["digest"])
            elif kind == "slot":
                if retired is None and isinstance(lease, int | float) and lease > now:
                    keep.add(pin["digest"])
                elif isinstance(retired, int | float) and now - retired < RETIRED_KEEP_S:
                    keep.add(pin["digest"])
                elif (
                    retired is None
                    and isinstance(lease, int | float)
                    and now - lease < RETIRED_KEEP_S
                ):
                    keep.add(pin["digest"])  # a crashed process counts as retired at leaseUntil
        return keep

    @staticmethod
    def _retired_at(pin: dict[str, Any]) -> float | None:
        """When a slot pin stopped holding its objects: its `retiredAt`, else (a crashed process)
        its `leaseUntil` once that has lapsed. Pending pins never retire."""
        if pin.get("kind") != "slot":
            return None
        retired = pin.get("retiredAt")
        if isinstance(retired, int | float):
            return float(retired)
        lease = pin.get("leaseUntil")
        return float(lease) if isinstance(lease, int | float) else None

    def _gc_locked(self) -> int:
        now = self._clock()
        keep_digests = self._keep_digests()
        keep_shas: set[str] = set()
        for digest in keep_digests:
            reg = _read_json(self._manifests / f"{digest}.json")
            if reg is None:
                continue
            items = reg.get("items")
            if isinstance(items, dict):
                for ref in items.values():
                    if isinstance(ref, dict):
                        keep_shas.update(s for s in (ref.get("card"), ref.get("thumb")) if s)
        deleted = 0
        for path in self.objects_dir.glob("*/*.webp"):
            if path.stem in keep_shas:
                continue
            try:
                if now - path.stat().st_mtime < YOUNG_OBJECT_S:
                    continue
                path.unlink()
                deleted += 1
            except OSError:
                continue
        for sub in self.objects_dir.iterdir():
            with contextlib.suppress(OSError):
                if sub.is_dir():
                    sub.rmdir()  # only succeeds when empty
        referenced: set[str] = set()
        for path in self._pins.glob("*.json"):
            pin = _read_json(path)
            retired = None if pin is None else self._retired_at(pin)
            if (
                pin is not None
                and isinstance(retired, int | float)
                and now - retired >= RETIRED_KEEP_S
            ):
                path.unlink(missing_ok=True)
                continue
            if pin is not None and isinstance(pin.get("digest"), str):
                referenced.add(pin["digest"])
        for path in self._manifests.glob("*.json"):
            if path.stem not in referenced:
                path.unlink(missing_ok=True)
        return deleted

    def gc(self) -> int:
        with self._locked():
            return self._gc_locked()

    def missing(self, manifest: PackManifest, search: Sequence[Path]) -> frozenset[str]:
        """Manifest shas found in none of the `search` object directories."""
        return frozenset(
            sha
            for sha in manifest.shas()
            if not any((d / object_relpath(sha)).is_file() for d in search)
        )

    def status(self) -> dict[str, Any]:
        now = self._clock()
        pins: list[dict[str, Any]] = []
        for path in sorted(self._pins.glob("*.json")):
            pin = _read_json(path)
            if pin is not None:
                pins.append({"id": path.stem, **pin})
        stale_pending = [
            p["id"]
            for p in pins
            if p.get("kind") == "pending"
            and isinstance(p.get("createdAt"), int | float)
            and now - p["createdAt"] > PENDING_WARN_S
        ]
        objects = list(self.objects_dir.glob("*/*.webp"))
        return {
            "objects": len(objects),
            "objectBytes": sum(p.stat().st_size for p in objects),
            "pins": pins,
            "pendingOlderThan30Days": stale_pending,
            "manifests": sorted(p.stem for p in self._manifests.glob("*.json")),
        }


# --- Docker-build fetch, verify, placeholders -----------------------------------------------


def fetch_to_dir(manifest: PackManifest, dest: Path, *, url: str | None = None) -> int:
    """Docker build: the same bounded steps as `PackStore.fetch`, floor 0, no registry or pins.
    Objects land in `dest/objects/<2 hex>/<sha>.webp`."""
    pack = manifest.pack
    if pack is None:
        return 0
    dest.mkdir(parents=True, exist_ok=True)
    incoming = dest / "incoming"
    incoming.mkdir(exist_ok=True)
    free = shutil.disk_usage(dest).free
    need = _need_bytes(manifest, 0)
    if free < need:
        raise FetchRefused(f"need {need} bytes but only {free} are free")
    part = incoming / f"{manifest.digest}.{secrets.token_hex(4)}.part"
    try:
        _download(
            url or pack.url,
            part,
            max_bytes=pack.bytes,
            expected_bytes=pack.bytes,
            deadline_s=DOWNLOAD_DEADLINE_S,
        )
        _verify_tar_identity(part, pack)
        scanned = _scan_tar(part, manifest)
        return _extract_objects(part, manifest, dest / "objects", scanned=scanned)
    finally:
        shutil.rmtree(incoming, ignore_errors=True)


def verify_dir(manifest: PackManifest, dest: Path) -> list[str]:
    """Problems found in `dest/objects` against the manifest (empty list = all good)."""
    problems: list[str] = []
    for sha in sorted(manifest.shas()):
        path = dest / "objects" / object_relpath(sha)
        if not path.is_file():
            problems.append(f"missing {sha}")
        elif _sha256_file(path) != sha:
            problems.append(f"wrong content {sha}")
    return problems


def write_placeholders(manifest: PackManifest, dest: Path) -> int:
    """One tiny valid WebP per manifest sha at `dest/<2 hex>/<sha>.webp` (e2e fixtures)."""
    count = 0
    for sha in sorted(manifest.shas()):
        target = dest / object_relpath(sha)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_PLACEHOLDER_WEBP)
        count += 1
    return count


# --- CLI ------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cookout_pack.py", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add(name: str, *flags: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name)
        for flag in flags:
            p.add_argument(flag, required=flag in _REQUIRED.get(name, ()))
        return p

    _REQUIRED: dict[str, tuple[str, ...]] = {
        "fetch": ("--dest",),
        "install": ("--tar", "--storage"),
        "cancel": ("--digest", "--storage"),
        "gc": ("--storage",),
        "status": ("--storage",),
        "verify": ("--dest",),
        "placeholders": ("--dest",),
    }
    add("fetch", "--manifest", "--dest", "--url")
    add("install", "--manifest", "--tar", "--storage", "--min-free-bytes")
    add("cancel", "--digest", "--storage")
    add("gc", "--storage")
    add("status", "--storage")
    add("verify", "--manifest", "--dest")
    add("placeholders", "--manifest", "--dest")
    args = parser.parse_args(argv)

    try:
        manifest_path = Path(args.manifest) if getattr(args, "manifest", None) else None
        if args.cmd in ("fetch", "install", "verify", "placeholders"):
            manifest = load_manifest(manifest_path)
        if args.cmd == "fetch":
            written = fetch_to_dir(manifest, Path(args.dest), url=args.url)
            print(f"fetched {written} objects into {args.dest}")
        elif args.cmd == "install":
            store = PackStore(
                Path(args.storage) / "cookout-images",
                min_free_bytes=int(args.min_free_bytes or 0),
            )
            print(f"installed {store.install(Path(args.tar), manifest)} objects")
        elif args.cmd == "cancel":
            store = PackStore(Path(args.storage) / "cookout-images", min_free_bytes=0)
            print("cancelled" if store.cancel_pending(args.digest) else "no such pending pin")
        elif args.cmd == "gc":
            store = PackStore(Path(args.storage) / "cookout-images", min_free_bytes=0)
            print(f"deleted {store.gc()} objects")
        elif args.cmd == "status":
            store = PackStore(Path(args.storage) / "cookout-images", min_free_bytes=0)
            print(json.dumps(store.status(), indent=1, sort_keys=True))
        elif args.cmd == "verify":
            problems = verify_dir(manifest, Path(args.dest))
            for line in problems:
                print(line)
            if problems:
                return 1
            print(f"verified {len(manifest.shas())} objects")
        elif args.cmd == "placeholders":
            print(f"wrote {write_placeholders(manifest, Path(args.dest))} placeholders")
    except (PackError, StoreBusy, FetchRefused, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
