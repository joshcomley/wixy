"""Cookout picture pack (spec/server-chat/09b §B.6): manifest, tar install, pins, lock, GC,
download admission. Stdlib-only module, no network beyond a loopback test server."""

from __future__ import annotations

import hashlib
import http.server
import io
import json
import os
import tarfile
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

from wixy_server.livechat import cookout_pack as cp

GB = 1024 * 1024 * 1024


def _blob(tag: str) -> bytes:
    return (tag * 40).encode()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _build(
    tmp_path: Path,
    tags: list[str],
    *,
    name: str = "pack",
    member_name: Callable[[str], str] | None = None,
    extra: list[tuple[str, bytes]] | None = None,
    drop: str | None = None,
    corrupt: str | None = None,
    installed_slack: int = 0,
    object_slack: int = 0,
) -> tuple[Path, cp.PackManifest, Path]:
    """Build a tar + manifest file for ingredients named after `tags` (card=tag, thumb=tag+'t')."""
    blobs: dict[str, bytes] = {}
    items: dict[str, dict[str, str]] = {}
    for tag in tags:
        card, thumb = _blob(tag), _blob(tag + "t")
        blobs[_sha(card)] = card
        blobs[_sha(thumb)] = thumb
        items[tag] = {"card": _sha(card), "thumb": _sha(thumb)}
    tar_path = tmp_path / f"{name}.tar"
    with tarfile.open(tar_path, "w") as tar:
        for sha, data in blobs.items():
            if sha == drop:
                continue
            payload = b"x" * len(data) if sha == corrupt else data
            info = tarfile.TarInfo((member_name or (lambda s: f"objects/{s[:2]}/{s}.webp"))(sha))
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
        for ename, edata in extra or []:
            info = tarfile.TarInfo(ename)
            info.size = len(edata)
            tar.addfile(info, io.BytesIO(edata))
    manifest_path = tmp_path / f"{name}.json"
    manifest_path.write_text(
        json.dumps(
            {
                "packVersion": 1,
                "pack": {
                    "url": "http://127.0.0.1:1/pack.tar",
                    "sha256": _sha(tar_path.read_bytes()),
                    "bytes": tar_path.stat().st_size,
                    "objects": len(blobs) + object_slack,
                    "installedBytes": sum(len(b) for b in blobs.values()) + installed_slack,
                },
                "renditions": {"card": 512, "thumb": 160},
                "items": items,
            }
        ),
        encoding="utf-8",
    )
    return tar_path, cp.load_manifest(manifest_path), manifest_path


class Clock:
    def __init__(self, now: float | None = None) -> None:
        self.now = time.time() if now is None else now

    def __call__(self) -> float:
        return self.now


def _store(tmp_path: Path, clock: Clock | None = None, **kw: object) -> cp.PackStore:
    kw.setdefault("min_free_bytes", 0)
    return cp.PackStore(tmp_path / "store", clock=clock or Clock(), **kw)  # type: ignore[arg-type]


def _has(store: cp.PackStore, sha: str) -> bool:
    return (store.objects_dir / cp.object_relpath(sha)).is_file()


def _age(store: cp.PackStore, seconds: int) -> None:
    for p in store.objects_dir.glob("*/*.webp"):
        t = p.stat().st_mtime - seconds
        os.utime(p, (t, t))


# --- manifest ---------------------------------------------------------------------------------


def test_committed_manifest_is_valid() -> None:
    m = cp.load_manifest()
    assert m.pack is None or m.pack.bytes <= cp.MAX_PACK_BYTES
    if m.pack_version == 0:
        assert m.pack is None and not m.items


def test_empty_manifest_valid() -> None:
    data = json.dumps({"packVersion": 0, "pack": None, "renditions": {}, "items": {}}).encode()
    m = cp.parse_manifest(data)
    assert m.pack is None and m.shas() == frozenset() and m.digest == _sha(data)


def _manifest_dict(tmp_path: Path) -> dict[str, object]:
    _, _, mp = _build(tmp_path, ["a", "b"])
    return json.loads(mp.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


@pytest.mark.parametrize("field", ["bytes", "objects", "installedBytes", "url", "sha256"])
def test_manifest_missing_pack_field(tmp_path: Path, field: str) -> None:
    d = _manifest_dict(tmp_path)
    pack = d["pack"]
    assert isinstance(pack, dict)
    del pack[field]
    with pytest.raises(cp.PackError):
        cp.parse_manifest(json.dumps(d).encode())


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("bytes", cp.MAX_PACK_BYTES + 1),
        ("installedBytes", cp.MAX_INSTALLED_BYTES + 1),
        ("objects", cp.MAX_OBJECTS + 1),
        ("bytes", -1),
        ("bytes", "12"),
    ],
)
def test_manifest_over_limit(tmp_path: Path, field: str, value: object) -> None:
    d = _manifest_dict(tmp_path)
    d["pack"][field] = value  # type: ignore[index]
    with pytest.raises(cp.PackError):
        cp.parse_manifest(json.dumps(d).encode())


def test_manifest_objects_must_equal_sha_set(tmp_path: Path) -> None:
    d = _manifest_dict(tmp_path)
    d["pack"]["objects"] += 1  # type: ignore[index]
    with pytest.raises(cp.PackError, match="distinct"):
        cp.parse_manifest(json.dumps(d).encode())


def test_manifest_items_without_pack_and_bad_sha(tmp_path: Path) -> None:
    d = _manifest_dict(tmp_path)
    d["pack"] = None
    with pytest.raises(cp.PackError):
        cp.parse_manifest(json.dumps(d).encode())
    d = _manifest_dict(tmp_path)
    d["items"]["a"]["card"] = "XYZ"  # type: ignore[index]
    with pytest.raises(cp.PackError):
        cp.parse_manifest(json.dumps(d).encode())
    with pytest.raises(cp.PackError):
        cp.parse_manifest(b"[]")


def test_manifest_item_limit(tmp_path: Path) -> None:
    sha = "a" * 64
    items = {f"i{n}": {"card": sha, "thumb": sha} for n in range(cp.MAX_ITEMS + 1)}
    with pytest.raises(cp.PackError, match="limit"):
        cp.parse_manifest(json.dumps({"packVersion": 1, "renditions": {}, "items": items}).encode())


def test_digest_distinguishes_same_pack_version(tmp_path: Path) -> None:
    _, m1, _ = _build(tmp_path, ["a"], name="one")
    _, m2, _ = _build(tmp_path, ["b"], name="two")
    assert m1.pack_version == m2.pack_version and m1.digest != m2.digest


def test_object_relpath() -> None:
    sha = "ab" + "c" * 62
    assert str(cp.object_relpath(sha)) == f"ab/{sha}.webp"
    with pytest.raises(cp.PackError):
        cp.object_relpath("../x")


# --- tar install ------------------------------------------------------------------------------


def test_install_writes_objects_and_pending_pin(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a", "b"])
    store = _store(tmp_path)
    assert store.install(tar, m) == 4
    assert all(_has(store, s) for s in m.shas())
    assert store.install(tar, m) == 0  # idempotent: content-addressed
    assert (store.root / "registry" / "pins" / f"pending-{m.digest}.json").exists()
    assert store.missing(m, [store.objects_dir]) == frozenset()


def test_install_rejects_bad_member_sha(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"], corrupt=_sha(_blob("a")))
    with pytest.raises(cp.PackError, match="sha256"):
        # tar identity must match, so rebuild the manifest over the corrupted tar
        _store(tmp_path).install(tar, m)


def test_install_rejects_extra_and_missing_members(tmp_path: Path) -> None:
    junk = b"junk"
    jsha = _sha(junk)
    tar, m, _ = _build(tmp_path, ["a"], extra=[(f"objects/{jsha[:2]}/{jsha}.webp", junk)])
    with pytest.raises(cp.PackError, match="extra"):
        _store(tmp_path).install(tar, m)
    tar, m, _ = _build(tmp_path, ["a"], name="m", drop=_sha(_blob("at")))
    with pytest.raises(cp.PackError, match="missing"):
        _store(tmp_path).install(tar, m)


@pytest.mark.parametrize(
    "name", ["../evil.webp", "/abs/x.webp", "objects/zz/zz.webp", "objects/ab/short.webp", "x.txt"]
)
def test_install_rejects_bad_names(tmp_path: Path, name: str) -> None:
    tar, m, _ = _build(tmp_path, ["a"], extra=[(name, b"x")])
    with pytest.raises(cp.PackError):
        _store(tmp_path).install(tar, m)


def test_install_rejects_non_regular_members(tmp_path: Path) -> None:
    tar_path, m, _ = _build(tmp_path, ["a"], name="base")
    for kind in (tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE):
        bad = tmp_path / f"bad{kind.decode()}.tar"
        with tarfile.open(bad, "w") as tar:
            info = tarfile.TarInfo("objects/ab")
            info.type = kind
            info.linkname = "objects/zz"
            tar.addfile(info)
        pack = m.pack
        assert pack is not None
        forged = cp.PackManifest(
            m.pack_version,
            cp.PackRef(pack.url, _sha(bad.read_bytes()), bad.stat().st_size, 2, 100),
            m.items,
            m.digest,
        )
        with pytest.raises(cp.PackError, match="regular"):
            _store(tmp_path).install(bad, forged)


def test_install_rejects_oversize_member_and_total(tmp_path: Path) -> None:
    big = b"b" * (cp.MAX_OBJECT_BYTES + 1)
    bsha = _sha(big)
    tar_path = tmp_path / "big.tar"
    with tarfile.open(tar_path, "w") as tar:
        info = tarfile.TarInfo(f"objects/{bsha[:2]}/{bsha}.webp")
        info.size = len(big)
        tar.addfile(info, io.BytesIO(big))
    ref = cp.ImageRef(bsha, bsha)
    pack = cp.PackRef("http://x/y", _sha(tar_path.read_bytes()), tar_path.stat().st_size, 1, 10**8)
    with pytest.raises(cp.PackError, match="limit"):
        _store(tmp_path).install(tar_path, cp.PackManifest(1, pack, {"x": ref}, "d" * 64))
    # running total over installedBytes
    tar2, m2, _ = _build(tmp_path, ["a", "b"], name="tot", installed_slack=-5)
    with pytest.raises(cp.PackError, match="installedBytes"):
        _store(tmp_path).install(tar2, m2)


def test_install_rejects_tampered_tar(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    tar.write_bytes(tar.read_bytes() + b"\0" * 512)
    with pytest.raises(cp.PackError, match="tar"):
        _store(tmp_path).install(tar, m)


def test_install_atomic_per_object_leaves_no_temp(tmp_path: Path) -> None:
    # corrupt member sha: install fails, only valid objects remain, no stray temp files
    sha_t = _sha(_blob("at"))
    tar, m, _ = _build(tmp_path, ["a"], corrupt=sha_t)
    store = _store(tmp_path)
    with pytest.raises(cp.PackError):
        store.install(tar, m)
    assert not _has(store, sha_t)
    assert not list(store.objects_dir.rglob(".*.tmp"))


# --- pins, GC, lock ---------------------------------------------------------------------------


def test_install_before_merge_then_gc_keeps_pending_objects(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    clock = Clock()
    store = _store(tmp_path, clock)
    store.install(tar, m)
    clock.now += 100 * 24 * 3600
    _age(store, 100 * 24 * 3600)
    assert store.gc() == 0 and all(_has(store, s) for s in m.shas())
    assert store.cancel_pending(m.digest) is True and store.cancel_pending(m.digest) is False
    assert store.gc() == len(m.shas())


def test_refreshed_slot_keeps_objects_for_months(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    clock = Clock()
    store = _store(tmp_path, clock)
    store.install(tar, m)
    pin = store.register_slot(m)  # activation removes the pending pin
    assert not (store.root / "registry" / "pins" / f"pending-{m.digest}.json").exists()
    for _ in range(15 * 24 * 12):  # 15 days of 5-minute refreshes
        clock.now += cp.SLOT_REFRESH_S
        store.refresh_slot(pin)
    _age(store, 16 * 24 * 3600)
    assert store.gc() == 0 and all(_has(store, s) for s in m.shas())


def test_overlapping_slots_keep_both_manifests(tmp_path: Path) -> None:
    ta, ma, _ = _build(tmp_path, ["a"], name="old")
    tb, mb, _ = _build(tmp_path, ["b"], name="new")
    clock = Clock()
    store = _store(tmp_path, clock)
    store.install(ta, ma)
    store.install(tb, mb)
    store.register_slot(ma)
    new_pin = store.register_slot(mb)
    _age(store, 7200)
    assert store.gc() == 0
    store.retire_slot(new_pin)
    assert store.gc() == 0  # rollback window
    assert all(_has(store, s) for s in ma.shas() | mb.shas())


def test_expired_lease_kept_72h_then_collected(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    clock = Clock()
    store = _store(tmp_path, clock)
    store.install(tar, m)
    store.register_slot(m)
    store.cancel_pending(m.digest)
    _age(store, 10 * 24 * 3600)
    clock.now += cp.SLOT_LEASE_S + 3600  # crashed: lease lapsed an hour ago
    assert store.gc() == 0
    clock.now += cp.RETIRED_KEEP_S + 1
    assert store.gc() == len(m.shas())
    assert not list((store.root / "registry" / "manifests").glob("*.json"))


def test_gc_skips_young_objects(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    store = _store(tmp_path)
    store.install(tar, m)
    store.cancel_pending(m.digest)
    assert store.gc() == 0  # younger than an hour
    _age(store, 7200)
    assert store.gc() == len(m.shas())


def test_retire_sets_retired_at_epoch_seconds(tmp_path: Path) -> None:
    _, m, _ = _build(tmp_path, ["a"])
    clock = Clock()
    store = _store(tmp_path, clock)
    pin = store.register_slot(m)
    store.retire_slot(pin)
    body = json.loads((store.root / "registry" / "pins" / f"{pin}.json").read_text("utf-8"))
    assert body["retiredAt"] == clock.now and isinstance(body["leaseUntil"], float)
    with pytest.raises(cp.PackError):
        store.refresh_slot("nope")


def test_lock_is_exclusive_and_times_out(tmp_path: Path) -> None:
    store = _store(tmp_path, lock_timeout_s=0.3)
    with store._locked(), pytest.raises(cp.StoreBusy):
        with cp._file_lock(store.root / ".lock", 0.2):
            pass
    with store._locked():  # released cleanly afterwards
        pass


def test_install_and_gc_serialise_across_threads(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a", "b", "c"])
    store = _store(tmp_path)
    errors: list[BaseException] = []

    def gc_loop() -> None:
        try:
            for _ in range(20):
                store.gc()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t = threading.Thread(target=gc_loop)
    t.start()
    store.install(tar, m)
    t.join()
    assert not errors and all(_has(store, s) for s in m.shas())


def test_status_lists_old_pending(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    clock = Clock()
    store = _store(tmp_path, clock)
    store.install(tar, m)
    clock.now += 31 * 24 * 3600
    assert store.status()["pendingOlderThan30Days"] == [f"pending-{m.digest}"]


# --- download admission and byte ceiling -----------------------------------------------------


@contextmanager
def _serve(body: bytes, *, chunked: bool = False, claim: int | None = None) -> Iterator[str]:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for i in range(0, len(body), 100):
                    part = body[i : i + 100]
                    self.wfile.write(f"{len(part):x}\r\n".encode() + part + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
            else:
                self.send_header("Content-Length", str(claim if claim is not None else len(body)))
                self.end_headers()
                self.wfile.write(body)

        def log_message(self, *a: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/pack.tar"
    finally:
        server.shutdown()
        server.server_close()


def test_fetch_installs_and_cleans_up(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a", "b"])
    store = _store(tmp_path)
    with _serve(tar.read_bytes()) as url:
        assert store.fetch(m, url=url) == 4
    assert all(_has(store, s) for s in m.shas())
    assert not list((store.root / "incoming").iterdir())


def test_fetch_oversized_response_aborted(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    store = _store(tmp_path)
    with _serve(tar.read_bytes() + b"\0" * 4096) as url, pytest.raises(cp.PackError):
        store.fetch(m, url=url)
    assert not list(store.objects_dir.rglob("*.webp"))
    assert not list((store.root / "incoming").iterdir())


def test_fetch_short_and_chunked_without_length(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    data = tar.read_bytes()
    store = _store(tmp_path)
    with _serve(data[:-512], chunked=True) as url, pytest.raises(cp.PackError, match="pins"):
        store.fetch(m, url=url)
    with _serve(data, chunked=True) as url:  # exactly the pinned size, no Content-Length
        assert store.fetch(m, url=url) == 2


def test_fetch_low_free_space_refused_before_download(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    store = _store(tmp_path, min_free_bytes=GB, free_space=lambda _p: GB)
    with pytest.raises(cp.FetchRefused):
        store.fetch(m, url="http://127.0.0.1:1/never-called")
    assert not list((store.root / "incoming").iterdir())


def test_refusal_leaves_existing_objects_served(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    store = _store(tmp_path)
    store.install(tar, m)
    tight = _store(tmp_path, min_free_bytes=GB, free_space=lambda _p: 0)
    with pytest.raises(cp.FetchRefused):
        tight.fetch(m)
    assert all(_has(store, s) for s in m.shas())


def test_second_fetch_refuses_on_live_reservation(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    clock = Clock(now=0)  # compare mtime against the real clock below
    store = _store(tmp_path)
    (store.root / "incoming" / f"{'f' * 64}.reserve").write_text("{}", encoding="utf-8")
    with pytest.raises(cp.StoreBusy):
        store.fetch(m, url="http://127.0.0.1:1/x")
    del clock


def test_interrupted_fetch_leftovers_reclaimed_at_startup(tmp_path: Path) -> None:
    _, m, _ = _build(tmp_path, ["a"])
    store = _store(tmp_path)
    old = store.root / "incoming" / "x.part"
    old.write_bytes(b"partial")
    t = old.stat().st_mtime - 2 * 3600
    os.utime(old, (t, t))
    fresh = store.root / "incoming" / "y.part"
    fresh.write_bytes(b"live")
    store.register_slot(m)
    assert not old.exists() and fresh.exists()


def test_fetch_empty_manifest_is_noop(tmp_path: Path) -> None:
    empty = cp.load_manifest()
    if empty.pack is None:
        assert _store(tmp_path).fetch(empty) == 0
        assert cp.fetch_to_dir(empty, tmp_path / "d") == 0


def test_fetch_to_dir_and_verify(tmp_path: Path) -> None:
    tar, m, mp = _build(tmp_path, ["a", "b"])
    with _serve(tar.read_bytes()) as url:
        assert cp.fetch_to_dir(m, tmp_path / "baked", url=url) == 4
    assert cp.verify_dir(m, tmp_path / "baked") == []
    assert not (tmp_path / "baked" / "incoming").exists()
    victim = tmp_path / "baked" / "objects" / cp.object_relpath(next(iter(m.shas())))
    victim.write_bytes(b"bad")
    assert cp.verify_dir(m, tmp_path / "baked")
    with _serve(tar.read_bytes() + b"x") as url, pytest.raises(cp.PackError):
        cp.fetch_to_dir(m, tmp_path / "baked2", url=url)


def test_non_http_url_refused(tmp_path: Path) -> None:
    tar, m, _ = _build(tmp_path, ["a"])
    with pytest.raises(cp.PackError, match="http"):
        cp.fetch_to_dir(m, tmp_path / "d", url="file:///etc/passwd")


def test_placeholders_and_missing(tmp_path: Path) -> None:
    _, m, _ = _build(tmp_path, ["a", "b"])
    assert cp.write_placeholders(m, tmp_path / "ph") == 4
    store = _store(tmp_path)
    assert store.missing(m, [tmp_path / "ph"]) == frozenset()
    assert store.missing(m, [tmp_path / "nowhere"]) == m.shas()
    from PIL import Image

    Image.open(tmp_path / "ph" / cp.object_relpath(next(iter(m.shas())))).load()


def test_cli_roundtrip(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    tar, m, mp = _build(tmp_path, ["a"])
    storage = str(tmp_path / "st")
    assert cp.main(["install", "--manifest", str(mp), "--tar", str(tar), "--storage", storage]) == 0
    assert cp.main(["status", "--storage", storage]) == 0
    assert cp.main(["cancel", "--digest", m.digest, "--storage", storage]) == 0
    assert cp.main(["gc", "--storage", storage]) == 0
    assert cp.main(["placeholders", "--manifest", str(mp), "--dest", str(tmp_path / "p")]) == 0
    assert cp.main(["verify", "--manifest", str(mp), "--dest", str(tmp_path / "nope")]) == 1
    assert "installed 2 objects" in capsys.readouterr().out
