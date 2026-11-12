"""Long voice notes, uploaded live (spec/server-chat/06-long-voice-notes.md, decisions/00210),
server side: the 4 h / 512 MiB caps, the live-upload wire contract (`live` init, ordered chunk
PUTs, `complete` with `chunkCount`, `GET /uploads/unsent`), the schema bump and its migration, the
janitor's `last_chunk_at` stale clock, the duration-scaled peaks pass, and the stretch planning
that transcription uses past fifteen minutes.

Real ffmpeg/ffprobe throughout (the hardening suite's rule: a missing binary is a loud failure,
never a skip). The slice-concatenation tests cut a REAL webm recorded with ffmpeg into arbitrary
byte ranges, exactly what a browser's `MediaRecorder` timeslice produces.
"""

from __future__ import annotations

import dataclasses
import json
import shutil
import sqlite3
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat import janitor, processing, transcription, uploads
from wixy_server.livechat.models import AttachmentKind, AttachmentResult, UploadRow
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore
from wixy_server.livechat.transcribe import TranscribeResult
from wixy_server.storage import ProjectPaths
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_PIN = "1234"
TEST_APP_KEY = "test-livechat"
UNLOCK_GUARD_HEADERS = {"X-Wixy-Server-Unlock": "1", "Content-Type": "application/json"}
DEVICE = "device-long-1"
OTHER_DEVICE = "device-other-9"
_DAY_S = 24 * 60 * 60.0
_MiB = 1024 * 1024
UPLOADS = "/api/admin/server/uploads"


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def ffmpeg_bin() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        pytest.fail("ffmpeg not found on PATH; this suite runs real ffmpeg by design")
    return path


@pytest.fixture(scope="module")
def ffprobe_bin() -> str:
    path = shutil.which("ffprobe")
    if path is None:
        pytest.fail("ffprobe not found on PATH; this suite runs real ffprobe by design")
    return path


@pytest.fixture(scope="module")
def webm_40s(tmp_path_factory: pytest.TempPathFactory, ffmpeg_bin: str) -> bytes:
    """A 40 s opus-in-webm recording, the shape a Chrome `MediaRecorder` produces."""
    dest = tmp_path_factory.mktemp("recording") / "note.webm"
    subprocess.run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=300:duration=40",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-f",
            "webm",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
    return dest.read_bytes()


@pytest.fixture(scope="module")
def m4a_35s(tmp_path_factory: pytest.TempPathFactory, ffmpeg_bin: str) -> bytes:
    """A 35 s AAC m4a, standing in for a processed voice rendition (`play.m4a`)."""
    dest = tmp_path_factory.mktemp("rendition") / "play.m4a"
    subprocess.run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=300:duration=35",
            "-c:a",
            "aac",
            "-b:a",
            "32k",
            str(dest),
        ],
        check=True,
        capture_output=True,
    )
    return dest.read_bytes()


def _split(data: bytes, cuts: list[int]) -> list[bytes]:
    """`data` cut at arbitrary byte offsets (not frame or cluster boundaries)."""
    edges = [0, *cuts, len(data)]
    return [data[a:b] for a, b in zip(edges, edges[1:], strict=False)]


def _probe_duration(ffprobe: str, data: bytes, tmp_path: Path) -> float:
    path = tmp_path / "probe.m4a"
    path.write_bytes(data)
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        check=True,
        capture_output=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")


def _ample_disk(_path: str) -> tuple[int, int, int]:
    return 10**12, 0, 10**12


def _init_live(
    store: LiveChatStore,
    paths: ProjectPaths,
    *,
    now: float = 1000.0,
    device_id: str = DEVICE,
    kind: AttachmentKind = "voice",
    mime_type: str = "audio/webm",
    quota_bytes: int = 10**12,
) -> str:
    return uploads.init_upload(
        store=store,
        kind=kind,
        mime_type=mime_type,
        size_bytes=0,
        filename=None,
        by_email=None,
        chunk_bytes=8 * _MiB,
        quota_bytes=quota_bytes,
        min_free_bytes=0,
        media_available=True,
        disk_check_path=paths.root,
        now=now,
        disk_usage=_ample_disk,
        live=True,
        device_id=device_id,
    ).upload_id


def _put_live(
    store: LiveChatStore,
    paths: ProjectPaths,
    upload_id: str,
    index: int,
    data: bytes,
    *,
    now: float = 1001.0,
    duration_ms: int | None = None,
    quota_bytes: int = 10**12,
    min_free_bytes: int = 0,
    disk_usage: uploads.DiskUsage = _ample_disk,
) -> int:
    """What `PUT /uploads/{id}/chunks/{index}` does for a live upload, minus the HTTP."""
    upload = store.get_upload(upload_id)
    assert upload is not None
    upload_dir = paths.server_upload_dir(upload_id)
    size = uploads.prepare_live_chunk(
        store=store,
        upload=upload,
        upload_dir=upload_dir,
        index=index,
        data_len=len(data),
        quota_bytes=quota_bytes,
        min_free_bytes=min_free_bytes,
        disk_check_path=paths.root,
        disk_usage=disk_usage,
    )
    uploads.write_chunk(upload_dir, index, data)
    assert store.record_live_chunk(upload_id, size_bytes=size, duration_ms=duration_ms, now=now)
    return size


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------


class TestLimits:
    def test_voice_caps_are_four_hours_and_512_mib(self) -> None:
        assert uploads.MAX_UPLOAD_BYTES["voice"] == 512 * _MiB
        assert processing.VOICE_DURATION_CAP_S == 4 * 60 * 60.0
        assert processing._VOICE_CEILING_S == 6 * 60 * 60.0

    def test_the_other_kinds_keep_their_caps(self) -> None:
        assert uploads.MAX_UPLOAD_BYTES["photo"] == 30 * _MiB
        assert uploads.MAX_UPLOAD_BYTES["video"] == 1024 * _MiB

    def test_an_ordinary_voice_upload_may_now_declare_up_to_512_mib(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        result = uploads.init_upload(
            store=store,
            kind="voice",
            mime_type="audio/webm",
            size_bytes=100 * _MiB,
            filename=None,
            by_email=None,
            chunk_bytes=8 * _MiB,
            quota_bytes=10**12,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1.0,
            disk_usage=_ample_disk,
        )
        assert result.max_bytes == 512 * _MiB
        with pytest.raises(uploads.TooLargeError):
            uploads.init_upload(
                store=store,
                kind="voice",
                mime_type="audio/webm",
                size_bytes=512 * _MiB + 1,
                filename=None,
                by_email=None,
                chunk_bytes=8 * _MiB,
                quota_bytes=10**13,
                min_free_bytes=0,
                media_available=True,
                disk_check_path=paths.root,
                now=1.0,
                disk_usage=_ample_disk,
            )


# ---------------------------------------------------------------------------
# Schema v22 and its migration
# ---------------------------------------------------------------------------


class TestSchema:
    def test_the_live_upload_columns_exist_and_default_to_ordinary(self, tmp_path: Path) -> None:
        db = tmp_path / "server" / "server.db"
        store = LiveChatStore(db)
        store.pending_upload_bytes()
        assert _LATEST_SCHEMA_VERSION == 22
        conn = sqlite3.connect(str(db))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 22
            info = {row[1]: row for row in conn.execute("PRAGMA table_info(uploads)")}
        finally:
            conn.close()
        assert {"live", "device_id", "last_chunk_at", "duration_ms"} <= info.keys()
        assert info["live"][3] == 1 and info["live"][4] == "0"  # NOT NULL DEFAULT 0

    def test_a_v21_database_migrates_and_keeps_existing_uploads_as_ordinary(
        self, tmp_path: Path
    ) -> None:
        db = tmp_path / "server" / "server.db"
        LiveChatStore(db).pending_upload_bytes()
        conn = sqlite3.connect(str(db))
        try:
            for column in ("live", "device_id", "last_chunk_at", "duration_ms"):
                conn.execute(f"ALTER TABLE uploads DROP COLUMN {column}")
            conn.execute(
                "INSERT INTO uploads (id, kind, mime, size_bytes, filename, by_email, created_at) "
                "VALUES ('a' || hex(zeroblob(15)), 'photo', 'image/jpeg', 10, NULL, NULL, 5.0)"
            )
            conn.execute("PRAGMA user_version = 21")
            conn.commit()
        finally:
            conn.close()

        migrated = LiveChatStore(db)
        assert migrated.pending_upload_bytes() == 10
        [old_id] = migrated.stale_upload_ids(older_than=100.0)
        old = migrated.get_upload(old_id)
        assert old is not None
        assert (old.live, old.device_id, old.last_chunk_at, old.duration_ms) == (
            False,
            None,
            None,
            None,
        )
        conn = sqlite3.connect(str(db))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 22
        finally:
            conn.close()

    def test_migrating_twice_is_harmless(self, tmp_path: Path) -> None:
        db = tmp_path / "server" / "server.db"
        LiveChatStore(db).pending_upload_bytes()
        conn = sqlite3.connect(str(db))
        try:
            conn.execute("PRAGMA user_version = 21")  # columns already present
            conn.commit()
        finally:
            conn.close()
        LiveChatStore(db).pending_upload_bytes()
        conn = sqlite3.connect(str(db))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 22
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# uploads.py — init, chunks, assemble
# ---------------------------------------------------------------------------


class TestLiveInit:
    def test_a_live_upload_starts_empty_and_remembers_its_device(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths, now=1234.0)
        row = store.get_upload(upload_id)
        assert row is not None
        assert (row.kind, row.live, row.device_id, row.size_bytes, row.created_at) == (
            "voice",
            True,
            DEVICE,
            0,
            1234.0,
        )
        assert (row.last_chunk_at, row.duration_ms) == (None, None)

    def test_live_is_voice_only(self, store: LiveChatStore, paths: ProjectPaths) -> None:
        with pytest.raises(ValueError, match="voice only"):
            _init_live(store, paths, kind="photo", mime_type="image/jpeg")
        assert store.pending_upload_bytes() == 0

    def test_live_needs_a_device(self, store: LiveChatStore, paths: ProjectPaths) -> None:
        with pytest.raises(ValueError, match="device"):
            _init_live(store, paths, device_id="")

    def test_init_still_checks_quota_against_zero_bytes(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        store.create_upload(
            UploadRow(
                id="b" * 32,
                kind="photo",
                mime="image/jpeg",
                size_bytes=500,
                filename=None,
                by_email=None,
                created_at=1.0,
            )
        )
        with pytest.raises(uploads.StorageFullError):
            _init_live(store, paths, quota_bytes=499)
        assert _init_live(store, paths, quota_bytes=500)


class TestLiveChunks:
    def test_slices_are_stored_in_order_and_the_row_tracks_size_time_and_duration(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        assert _put_live(store, paths, upload_id, 0, b"aaaa", now=1010.0, duration_ms=15000) == 4
        assert _put_live(store, paths, upload_id, 1, b"bbbbbb", now=1025.0, duration_ms=30000) == 10
        row = store.get_upload(upload_id)
        assert row is not None
        assert (row.size_bytes, row.last_chunk_at, row.duration_ms) == (10, 1025.0, 30000)
        assert store.pending_upload_bytes() == 10

    def test_a_gap_is_out_of_order_and_names_the_next_index(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"aaaa")
        with pytest.raises(uploads.OutOfOrderChunkError) as exc:
            _put_live(store, paths, upload_id, 2, b"cc")
        assert exc.value.next_index == 1
        with pytest.raises(uploads.OutOfOrderChunkError) as first:
            _put_live(store, paths, _init_live(store, paths), 1, b"x")
        assert first.value.next_index == 0

    def test_a_negative_index_is_invalid(self, store: LiveChatStore, paths: ProjectPaths) -> None:
        upload_id = _init_live(store, paths)
        with pytest.raises(uploads.InvalidChunkIndexError):
            _put_live(store, paths, upload_id, -1, b"x")

    def test_re_putting_an_existing_slice_overwrites_it_and_corrects_the_size(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"aaaa")
        _put_live(store, paths, upload_id, 1, b"bbbb")
        assert _put_live(store, paths, upload_id, 0, b"AA") == 6
        chunk0 = paths.server_upload_dir(upload_id) / "chunk-000000"
        assert chunk0.read_bytes() == b"AA"

    def test_the_running_total_over_the_cap_is_too_large_and_nothing_is_stored(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(uploads.MAX_UPLOAD_BYTES, "voice", 10)
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"123456")
        with pytest.raises(uploads.TooLargeError) as exc:
            _put_live(store, paths, upload_id, 1, b"12345")
        assert exc.value.max_bytes == 10
        assert not (paths.server_upload_dir(upload_id) / "chunk-000001").exists()
        assert _put_live(store, paths, upload_id, 1, b"1234") == 10  # exactly the cap is fine

    def test_a_slice_past_the_quota_is_storage_full_and_not_stored(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"a" * 60, quota_bytes=100)
        with pytest.raises(uploads.StorageFullError):
            _put_live(store, paths, upload_id, 1, b"b" * 41, quota_bytes=100)
        assert not (paths.server_upload_dir(upload_id) / "chunk-000001").exists()
        assert _put_live(store, paths, upload_id, 1, b"b" * 40, quota_bytes=100) == 100

    def test_a_slice_under_the_free_space_floor_is_storage_full(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)

        def tight(_path: str) -> tuple[int, int, int]:
            return 10**9, 10**9 - 1000, 1000

        with pytest.raises(uploads.StorageFullError):
            _put_live(store, paths, upload_id, 0, b"x" * 600, min_free_bytes=500, disk_usage=tight)
        assert not (paths.server_upload_dir(upload_id) / "chunk-000000").exists()
        _put_live(store, paths, upload_id, 0, b"x" * 500, min_free_bytes=500, disk_usage=tight)

    def test_an_ordinary_upload_is_not_a_live_upload(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        ordinary = uploads.init_upload(
            store=store,
            kind="voice",
            mime_type="audio/webm",
            size_bytes=10,
            filename=None,
            by_email=None,
            chunk_bytes=100,
            quota_bytes=10**9,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1.0,
            disk_usage=_ample_disk,
        ).upload_id
        with pytest.raises(uploads.NotLiveUploadError):
            _put_live(store, paths, ordinary, 0, b"x")


class TestLiveAssemble:
    def _assemble(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        upload_id: str,
        *,
        chunk_count: int | None = None,
    ) -> bytes:
        attachment = uploads.assemble(
            store=store,
            paths=paths,
            upload_id=upload_id,
            chunk_bytes=8 * _MiB,
            now=2000.0,
            chunk_count=chunk_count,
        )
        assert attachment.status == "processing"
        return (paths.server_upload_dir(upload_id) / "assembled").read_bytes()

    def test_without_a_chunk_count_every_present_contiguous_chunk_is_joined(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        for index, piece in enumerate([b"one-", b"two-", b"three"]):
            _put_live(store, paths, upload_id, index, piece)
        assert self._assemble(store, paths, upload_id) == b"one-two-three"
        row = store.get_upload(upload_id)
        assert row is not None and row.size_bytes == len(b"one-two-three")
        assert not list(paths.server_upload_dir(upload_id).glob("chunk-*"))

    def test_a_chunk_count_takes_exactly_that_many_and_drops_the_rest(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        for index, piece in enumerate([b"AA", b"BB", b"CC"]):
            _put_live(store, paths, upload_id, index, piece)
        assert self._assemble(store, paths, upload_id, chunk_count=2) == b"AABB"
        row = store.get_upload(upload_id)
        assert row is not None and row.size_bytes == 4
        assert not list(paths.server_upload_dir(upload_id).glob("chunk-*"))

    def test_chunks_missing_below_the_chunk_count_are_incomplete(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"AA")
        with pytest.raises(uploads.IncompleteUploadError) as exc:
            uploads.assemble(
                store=store,
                paths=paths,
                upload_id=upload_id,
                chunk_bytes=8 * _MiB,
                now=1.0,
                chunk_count=4,
            )
        assert exc.value.missing == [1, 2, 3]
        assert store.get_attachment(upload_id) is None

    def test_a_recording_with_no_slice_at_all_is_incomplete(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        with pytest.raises(uploads.IncompleteUploadError):
            self._assemble(store, paths, upload_id)

    def test_complete_is_idempotent_like_an_ordinary_upload(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"AA")
        first = uploads.assemble(
            store=store, paths=paths, upload_id=upload_id, chunk_bytes=8 * _MiB, now=1.0
        )
        again = uploads.assemble(
            store=store, paths=paths, upload_id=upload_id, chunk_bytes=8 * _MiB, now=2.0
        )
        assert again.id == first.id

    def test_a_real_webm_cut_at_arbitrary_byte_ranges_concatenates_back_to_forty_seconds(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        webm_40s: bytes,
        ffmpeg_bin: str,
        ffprobe_bin: str,
    ) -> None:
        size = len(webm_40s)
        pieces = _split(webm_40s, [37, size // 7, size // 3 + 11, size // 2, size - 5])
        assert len(pieces) == 6 and b"".join(pieces) == webm_40s
        upload_id = _init_live(store, paths)
        for index, piece in enumerate(pieces):
            _put_live(store, paths, upload_id, index, piece, duration_ms=(index + 1) * 6000)
        assembled = self._assemble(store, paths, upload_id, chunk_count=len(pieces))
        assert assembled == webm_40s

        out_dir = paths.server_attachment_media_dir(upload_id)
        result = processing.process_voice(
            paths.server_upload_dir(upload_id) / "assembled",
            output_dir=out_dir,
            ffmpeg=ffmpeg_bin,
            ffprobe=ffprobe_bin,
        )
        assert result.duration_s == pytest.approx(40.0, abs=1.0)
        assert result.mime == "audio/mp4"
        assert len(result.peaks) == 64


# ---------------------------------------------------------------------------
# Janitor
# ---------------------------------------------------------------------------


class TestJanitorStaleClock:
    def test_an_old_live_upload_with_a_recent_slice_is_not_swept(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 10_000_000.0
        upload_id = _init_live(store, paths, now=now - _DAY_S - 3600)  # started over a day ago
        _put_live(store, paths, upload_id, 0, b"slice", now=now - 60)

        report = janitor.run_once(store=store, paths=paths, now=now)

        assert report.stale_uploads == 0
        assert store.get_upload(upload_id) is not None
        assert (paths.server_upload_dir(upload_id) / "chunk-000000").exists()

    def test_a_live_upload_whose_last_slice_is_over_a_day_old_is_swept(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 10_000_000.0
        upload_id = _init_live(store, paths, now=now - 2 * _DAY_S)
        _put_live(store, paths, upload_id, 0, b"slice", now=now - _DAY_S - 1)

        report = janitor.run_once(store=store, paths=paths, now=now)

        assert report.stale_uploads == 1
        assert store.get_upload(upload_id) is None
        assert not paths.server_upload_dir(upload_id).exists()

    def test_a_live_upload_with_no_slice_ages_from_its_creation(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 10_000_000.0
        upload_id = _init_live(store, paths, now=now - _DAY_S - 1)
        assert janitor.run_once(store=store, paths=paths, now=now).stale_uploads == 1
        assert store.get_upload(upload_id) is None

    def test_a_slice_landing_between_the_scan_and_the_delete_keeps_the_upload(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        now = 10_000_000.0
        upload_id = _init_live(store, paths, now=now - 3 * _DAY_S)
        scan = store.stale_upload_ids

        def scan_then_slice(*, older_than: float) -> list[str]:
            found = scan(older_than=older_than)
            _put_live(store, paths, upload_id, 0, b"late", now=now - 5)
            return found

        monkeypatch.setattr(store, "stale_upload_ids", scan_then_slice)
        report = janitor.run_once(store=store, paths=paths, now=now)
        assert report.stale_uploads == 0
        assert store.get_upload(upload_id) is not None


# ---------------------------------------------------------------------------
# Unsent list (store level)
# ---------------------------------------------------------------------------


class TestUnsentList:
    def test_only_idle_unpromoted_live_uploads_of_this_device_newest_first(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        now = 5000.0
        older = _init_live(store, paths, now=100.0)
        newer = _init_live(store, paths, now=200.0)
        recent = _init_live(store, paths, now=300.0)
        other = _init_live(store, paths, now=400.0, device_id=OTHER_DEVICE)
        _init_live(store, paths, now=500.0)  # no slice yet: nothing to send
        completed = _init_live(store, paths, now=600.0)
        for upload_id in (older, newer, other, completed):
            _put_live(store, paths, upload_id, 0, b"audio", now=now - 60, duration_ms=1000)
        _put_live(store, paths, recent, 0, b"audio", now=now - 5)  # still recording
        uploads.assemble(
            store=store, paths=paths, upload_id=completed, chunk_bytes=8 * _MiB, now=now
        )

        rows = store.unsent_live_uploads(device_id=DEVICE, idle_before=now - uploads.UNSENT_IDLE_S)

        assert [row.id for row in rows] == [newer, older]

    def test_the_idle_boundary_is_inclusive(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        upload_id = _init_live(store, paths)
        _put_live(store, paths, upload_id, 0, b"audio", now=980.0)
        assert [r.id for r in store.unsent_live_uploads(device_id=DEVICE, idle_before=980.0)] == [
            upload_id
        ]
        assert store.unsent_live_uploads(device_id=DEVICE, idle_before=979.9) == []

    def test_an_ordinary_upload_is_never_listed(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        store.create_upload(
            UploadRow(
                id="c" * 32,
                kind="voice",
                mime="audio/webm",
                size_bytes=5,
                filename=None,
                by_email=None,
                created_at=1.0,
                device_id=DEVICE,
                last_chunk_at=1.0,
            )
        )
        assert store.unsent_live_uploads(device_id=DEVICE, idle_before=10**9) == []


# ---------------------------------------------------------------------------
# Peaks rate
# ---------------------------------------------------------------------------


class TestPeaksRate:
    @pytest.mark.parametrize(
        ("duration_s", "rate"),
        [
            (0.0, 8000),
            (2.0, 8000),
            (900.0, 8000),
            (901.0, 7991),  # floor(7_200_000 / 901)
            (3600.0, 2000),
            (4 * 3600.0, 500),
            (6 * 3600.0, 333),
            (10**6, 100),  # the floor
        ],
    )
    def test_rate_is_the_clamped_floor_of_seven_point_two_million_over_the_duration(
        self, duration_s: float, rate: int
    ) -> None:
        assert processing.voice_peak_sample_rate(duration_s) == rate

    def test_total_samples_stay_bounded_for_every_duration_up_to_the_cap(self) -> None:
        for duration_s in (900.0, 1800.0, 7200.0, processing.VOICE_DURATION_CAP_S):
            assert processing.voice_peak_sample_rate(duration_s) * duration_s <= 7_200_000

    def test_the_peaks_pass_decodes_at_the_scaled_rate(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        webm_40s: bytes,
        ffmpeg_bin: str,
        ffprobe_bin: str,
    ) -> None:
        """A 40 s note against a 40 000-sample budget (a stand-in for "a very long note") must
        be decoded at 1000 Hz, not 8000 — read off the ffmpeg command line the pass really ran."""
        monkeypatch.setattr(processing, "_VOICE_PEAK_MAX_SAMPLES", 40_000)
        commands: list[list[str]] = []
        real = processing._run_transcode

        def spy(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
            commands.append(list(argv))
            return real(argv, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(processing, "_run_transcode", spy)
        src = tmp_path / "note.webm"
        src.write_bytes(webm_40s)

        result = processing.process_voice(
            src, output_dir=tmp_path / "out", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin
        )

        [pcm] = [c for c in commands if "s16le" in c]
        rate = int(pcm[pcm.index("-ar") + 1])
        assert rate == int(40_000 // result.duration_s)
        assert 900 <= rate <= 1010
        assert len(result.peaks) == 64 and max(result.peaks) == 1.0


# ---------------------------------------------------------------------------
# Transcription in stretches
# ---------------------------------------------------------------------------


class TestPlanStretches:
    def test_a_note_within_one_stretch_is_a_single_stretch(self) -> None:
        assert transcription.plan_stretches(10.0) == [transcription.Stretch(0.0, None)]
        assert transcription.plan_stretches(900.0) == [transcription.Stretch(0.0, None)]
        assert transcription.plan_stretches(900.4) == [transcription.Stretch(0.0, None)]

    def test_a_note_just_past_fifteen_minutes_is_two_stretches(self) -> None:
        assert transcription.plan_stretches(901.0) == [
            transcription.Stretch(0.0, 900.0),
            transcription.Stretch(900.0, None),
        ]

    def test_a_forty_minute_note(self) -> None:
        plan = transcription.plan_stretches(2400.0)
        assert [(s.start_s, s.length_s) for s in plan] == [
            (0.0, 900.0),
            (900.0, 900.0),
            (1800.0, None),
        ]

    def test_an_exact_multiple_does_not_leave_an_empty_tail(self) -> None:
        plan = transcription.plan_stretches(1800.0)
        assert [(s.start_s, s.length_s) for s in plan] == [(0.0, 900.0), (900.0, None)]

    def test_a_four_hour_note_is_sixteen_consecutive_stretches_covering_all_of_it(self) -> None:
        duration = 4 * 3600.0
        plan = transcription.plan_stretches(duration)
        assert len(plan) == 16
        covered = 0.0
        for stretch in plan:
            assert stretch.start_s == covered
            length = stretch.length_s if stretch.length_s is not None else duration - covered
            assert 0 < length <= 900.5
            covered += length
        assert covered == duration

    def test_the_stretch_length_is_adjustable(self) -> None:
        plan = transcription.plan_stretches(35.0, stretch_s=10.0)
        assert [(s.start_s, s.length_s) for s in plan] == [
            (0.0, 10.0),
            (10.0, 10.0),
            (20.0, 10.0),
            (30.0, None),
        ]

    def test_the_timeout_never_grows_past_one_stretchs_budget(self) -> None:
        assert transcription.transcribe_timeout_s(900.0) == 60.0 + 450.0
        assert transcription.transcribe_timeout_s(4 * 3600.0) == 60.0 + 450.0
        assert transcription.transcribe_timeout_s(10.0) == 65.0


class _RecordingTranscriber:
    """A `Transcriber` that records each stretch it is sent and answers `part-N` (or fails the
    `fail_at`-th with `outcome`)."""

    def __init__(self, paths: ProjectPaths, *, fail_at: int | None = None) -> None:
        self.paths = paths
        self.fail_at = fail_at
        self.audio: list[bytes] = []
        self.timeouts: list[float] = []
        self.tmp_listings: list[list[str]] = []
        self.fresh_probes = 0

    async def available(self, *, fresh: bool = False) -> bool:
        self.fresh_probes += 1 if fresh else 0
        return True

    async def transcribe(
        self, *, audio: bytes, filename: str, content_type: str, timeout_s: float
    ) -> TranscribeResult:
        assert (filename, content_type) == ("play.m4a", "audio/mp4")
        tmp = self.paths.server_dir / transcription.TRANSCRIBE_TMP_DIRNAME
        self.tmp_listings.append(
            sorted(p.name for p in tmp.rglob("*") if p.is_file()) if tmp.exists() else []
        )
        self.audio.append(audio)
        self.timeouts.append(timeout_s)
        number = len(self.audio)
        if self.fail_at == number:
            return TranscribeResult("timeout")
        return TranscribeResult("ok", text=f"part-{number}", engine="fake")

    async def aclose(self) -> None:
        return None


def _runtime(
    store: LiveChatStore,
    paths: ProjectPaths,
    transcriber: _RecordingTranscriber,
    ffmpeg: str | None,
) -> transcription.TranscriptionRuntime:
    return transcription.TranscriptionRuntime(
        store=store,
        paths=paths,
        notifier=LiveChatNotifier(),
        transcriber=transcriber,
        ffmpeg=ffmpeg,
    )


@pytest.fixture
def long_voice(store: LiveChatStore, paths: ProjectPaths, m4a_35s: bytes) -> Iterator[str]:
    """A ready 35 s voice attachment whose `play.m4a` is real AAC audio."""
    att_id = "d" * 32
    store.create_attachment(att_id=att_id, kind="voice", now=1.0)
    store.claim_processing(owner="seed", now=1.0, lease_s=60.0)
    store.finish_attachment(
        att_id=att_id,
        owner="seed",
        result=AttachmentResult(
            status="ready",
            mime="audio/mp4",
            width=None,
            height=None,
            duration_s=35.0,
            peaks=(0.5,),
            renditions=("play",),
            bytes_on_disk=len(m4a_35s),
            failure=None,
        ),
        now=1.0,
    )
    media_dir = paths.server_attachment_media_dir(att_id)
    media_dir.mkdir(parents=True)
    (media_dir / "play.m4a").write_bytes(m4a_35s)
    yield att_id


class TestStretchTranscription:
    def test_a_long_note_is_cut_sent_in_order_and_joined_with_single_spaces(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        long_voice: str,
        ffmpeg_bin: str,
        ffprobe_bin: str,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(transcription, "TRANSCRIBE_STRETCH_S", 10.0)
        transcriber = _RecordingTranscriber(paths)
        runtime = _runtime(store, paths, transcriber, ffmpeg_bin)

        result = anyio.run(runtime._transcribe, long_voice)

        assert result is not None
        assert (result.status, result.text, result.engine) == (
            "done",
            "part-1 part-2 part-3 part-4",
            "fake",
        )
        durations = [_probe_duration(ffprobe_bin, a, tmp_path) for a in transcriber.audio]
        assert durations[:3] == [pytest.approx(10.0, abs=0.3)] * 3
        assert durations[3] == pytest.approx(5.0, abs=0.3)
        # Every stretch was probed fresh before it was sent, and each timeout is that stretch's.
        assert transcriber.fresh_probes == 4
        assert transcriber.timeouts[:3] == [65.0] * 3
        assert transcriber.timeouts[3] == pytest.approx(62.5, abs=0.3)
        # Stretch files live only in the server's private storage, and none outlives the job.
        tmp_root = paths.server_dir / transcription.TRANSCRIBE_TMP_DIRNAME
        assert all(listing == [] for listing in transcriber.tmp_listings)  # deleted once read
        assert not [p for p in tmp_root.rglob("*") if p.is_file()]

    def test_one_failed_stretch_fails_the_transcript_and_stops_sending(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        long_voice: str,
        ffmpeg_bin: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(transcription, "TRANSCRIBE_STRETCH_S", 10.0)
        transcriber = _RecordingTranscriber(paths, fail_at=2)
        runtime = _runtime(store, paths, transcriber, ffmpeg_bin)

        result = anyio.run(runtime._transcribe, long_voice)

        assert result is not None
        assert (result.status, result.failure, result.text) == ("failed", "timeout", None)
        assert len(transcriber.audio) == 2  # nothing after the failed stretch left the server
        tmp_root = paths.server_dir / transcription.TRANSCRIBE_TMP_DIRNAME
        assert not tmp_root.exists() or not [p for p in tmp_root.iterdir()]

    def test_the_stretch_files_are_removed_even_when_cutting_itself_fails(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        long_voice: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(transcription, "TRANSCRIBE_STRETCH_S", 10.0)
        transcriber = _RecordingTranscriber(paths)
        runtime = _runtime(store, paths, transcriber, "ffmpeg-that-does-not-exist")

        result = anyio.run(runtime._transcribe, long_voice)

        assert result is not None and (result.status, result.failure) == ("failed", "error")
        assert transcriber.audio == []
        tmp_root = paths.server_dir / transcription.TRANSCRIBE_TMP_DIRNAME
        assert not tmp_root.exists() or not [p for p in tmp_root.iterdir()]

    def test_a_short_note_is_still_sent_whole_in_one_request(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        long_voice: str,
        m4a_35s: bytes,
        ffmpeg_bin: str,
    ) -> None:
        # 35 s is well within the real 15-minute stretch.
        transcriber = _RecordingTranscriber(paths)
        runtime = _runtime(store, paths, transcriber, ffmpeg_bin)

        result = anyio.run(runtime._transcribe, long_voice)

        assert result is not None and (result.status, result.text) == ("done", "part-1")
        assert transcriber.audio == [m4a_35s]

    def test_startup_clears_stretch_files_a_killed_process_left_behind(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        leftover = paths.server_dir / transcription.TRANSCRIBE_TMP_DIRNAME / "deadbeef"
        leftover.mkdir(parents=True)
        (leftover / "stretch.m4a").write_bytes(b"x")
        _runtime(store, paths, _RecordingTranscriber(paths), None).reset_loop_state()
        assert not (paths.server_dir / transcription.TRANSCRIBE_TMP_DIRNAME).exists()


# ---------------------------------------------------------------------------
# HTTP wire contract
# ---------------------------------------------------------------------------


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def wixy_repo_root(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": str(origin),
                "defaultBranch": "main",
                "cmdProject": "test",
                "domain": "test.example.invalid",
                "locale": "en-GB",
                "indexable": False,
                "media": {"maxLongSidePx": 2000, "jpegQuality": 85},
            }
        ),
        encoding="utf-8",
    )
    _git(["init", "--initial-branch=main"], root)
    _git(["config", "user.email", "test@example.com"], root)
    _git(["config", "user.name", "Test"], root)
    _git(["add", "."], root)
    _git(["commit", "-m", "engine commit"], root)
    return root


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def client(tmp_path: Path, wixy_repo_root: Path) -> Iterator[TestClient]:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    fake_app = create_fake_cmd_app(state)
    app = create_app(
        storage_root=tmp_path / "storage",
        wixy_repo_root=wixy_repo_root,
        pin_verifier=CmdPinVerifier(
            app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app)
        ),
    )
    with TestClient(app, cookies={"CF_Authorization": "dummy"}) as test_client:
        response = test_client.post(
            "/api/admin/server/unlock",
            content=json.dumps({"pin": TEST_PIN}).encode("utf-8"),
            headers={**UNLOCK_GUARD_HEADERS, "Sec-Fetch-Site": "same-origin"},
        )
        assert response.status_code == 200, response.text
        test_client.headers.update({"X-Wixy-Server-Token": response.json()["token"]})
        yield test_client


def _live_init(client: TestClient, **overrides: object) -> Any:
    body: dict[str, object] = {
        "kind": "voice",
        "mimeType": "audio/webm",
        "live": True,
        "deviceId": DEVICE,
        **overrides,
    }
    return client.post(UPLOADS, json=body)


def _put_chunk(
    client: TestClient, upload_id: str, index: int, data: bytes, *, duration_ms: int | None = None
) -> Any:
    suffix = f"?durationMs={duration_ms}" if duration_ms is not None else ""
    return client.put(
        f"{UPLOADS}/{upload_id}/chunks/{index}{suffix}",
        content=data,
        headers={"Content-Type": "application/octet-stream"},
    )


def _row(client: TestClient, upload_id: str) -> UploadRow:
    row = client.app.state.livechat_store.get_upload(upload_id)  # type: ignore[attr-defined]
    assert row is not None
    return row  # type: ignore[no-any-return]


class TestHttpInit:
    def test_live_init_returns_the_ordinary_shape_and_needs_no_size(
        self, client: TestClient
    ) -> None:
        response = _live_init(client)
        assert response.status_code == 201, response.text
        body = response.json()
        assert set(body) == {"uploadId", "chunkBytes", "maxBytes"}
        assert body["maxBytes"] == 512 * _MiB
        row = _row(client, body["uploadId"])
        assert (row.live, row.device_id, row.size_bytes) == (True, DEVICE, 0)

    def test_a_sent_size_is_ignored_for_a_live_upload(self, client: TestClient) -> None:
        response = _live_init(client, sizeBytes=123456)
        assert response.status_code == 201
        assert _row(client, response.json()["uploadId"]).size_bytes == 0

    @pytest.mark.parametrize(("kind", "mime"), [("photo", "image/jpeg"), ("video", "video/mp4")])
    def test_live_for_another_kind_is_422(self, client: TestClient, kind: str, mime: str) -> None:
        assert _live_init(client, kind=kind, mimeType=mime, sizeBytes=10).status_code == 422

    @pytest.mark.parametrize("device", [None, "", "short"])
    def test_live_needs_a_valid_device_id(self, client: TestClient, device: str | None) -> None:
        assert _live_init(client, deviceId=device).status_code == 422

    def test_a_live_upload_still_gets_the_ordinary_type_check(self, client: TestClient) -> None:
        assert _live_init(client, mimeType="application/pdf").status_code == 415

    def test_an_ordinary_upload_still_requires_a_positive_size(self, client: TestClient) -> None:
        base = {"kind": "voice", "mimeType": "audio/webm"}
        assert client.post(UPLOADS, json=base).status_code == 422
        assert client.post(UPLOADS, json={**base, "sizeBytes": 0}).status_code == 422
        ok = client.post(UPLOADS, json={**base, "sizeBytes": 10})
        assert ok.status_code == 201
        assert _row(client, ok.json()["uploadId"]).live is False


class TestHttpChunks:
    def test_in_order_slices_update_the_row_and_a_gap_is_409_with_next(
        self, client: TestClient
    ) -> None:
        upload_id = _live_init(client).json()["uploadId"]
        before = time.time()
        assert _put_chunk(client, upload_id, 0, b"aaaa", duration_ms=15000).status_code == 204
        row = _row(client, upload_id)
        assert (row.size_bytes, row.duration_ms) == (4, 15000)
        assert row.last_chunk_at is not None and row.last_chunk_at >= before

        gap = _put_chunk(client, upload_id, 2, b"cc", duration_ms=45000)
        assert gap.status_code == 409
        assert gap.json() == {"error": "out_of_order", "next": 1}
        assert _row(client, upload_id).size_bytes == 4  # the gapped slice was not stored

        assert _put_chunk(client, upload_id, 1, b"bbbbbb", duration_ms=30000).status_code == 204
        again = _put_chunk(client, upload_id, 0, b"AA")  # idempotent overwrite, no duration
        assert again.status_code == 204
        row = _row(client, upload_id)
        assert (row.size_bytes, row.duration_ms) == (8, 30000)

    def test_a_slice_without_a_duration_still_refreshes_the_arrival_time(
        self, client: TestClient
    ) -> None:
        upload_id = _live_init(client).json()["uploadId"]
        _put_chunk(client, upload_id, 0, b"a", duration_ms=1000)
        store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
        store.record_live_chunk(upload_id, size_bytes=1, duration_ms=None, now=1.0)
        _put_chunk(client, upload_id, 1, b"b")
        row = _row(client, upload_id)
        assert row.duration_ms == 1000 and row.last_chunk_at is not None
        assert row.last_chunk_at > 1.0

    def test_a_negative_duration_is_rejected(self, client: TestClient) -> None:
        upload_id = _live_init(client).json()["uploadId"]
        assert _put_chunk(client, upload_id, 0, b"a", duration_ms=-1).status_code == 422

    def test_a_running_total_over_the_cap_is_413_too_large(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(uploads.MAX_UPLOAD_BYTES, "voice", 8)
        upload_id = _live_init(client).json()["uploadId"]
        assert _put_chunk(client, upload_id, 0, b"12345").status_code == 204
        over = _put_chunk(client, upload_id, 1, b"1234")
        assert over.status_code == 413
        assert over.json() == {"error": "too_large", "maxBytes": 8}
        assert _row(client, upload_id).size_bytes == 5

    def test_a_slice_past_the_quota_is_507_storage_full(self, client: TestClient) -> None:
        settings = client.app.state.settings  # type: ignore[attr-defined]
        client.app.state.settings = dataclasses.replace(  # type: ignore[attr-defined]
            settings, server_media_quota_bytes=100
        )
        upload_id = _live_init(client).json()["uploadId"]
        assert _put_chunk(client, upload_id, 0, b"a" * 60).status_code == 204
        full = _put_chunk(client, upload_id, 1, b"b" * 41)
        assert full.status_code == 507 and full.json() == {"error": "storage_full"}
        assert _row(client, upload_id).size_bytes == 60

    def test_a_slice_bigger_than_the_chunk_size_is_413_as_before(self, client: TestClient) -> None:
        settings = client.app.state.settings  # type: ignore[attr-defined]
        upload_id = _live_init(client).json()["uploadId"]
        too_big = _put_chunk(client, upload_id, 0, b"x" * (settings.server_upload_chunk_bytes + 1))
        assert too_big.status_code == 413

    def test_an_unknown_upload_is_404(self, client: TestClient) -> None:
        assert _put_chunk(client, "e" * 32, 0, b"a").status_code == 404

    def test_a_negative_index_is_422(self, client: TestClient) -> None:
        upload_id = _live_init(client).json()["uploadId"]
        assert _put_chunk(client, upload_id, -1, b"a").status_code == 422


class TestHttpComplete:
    def _live_with_slices(self, client: TestClient, pieces: list[bytes]) -> str:
        upload_id = str(_live_init(client).json()["uploadId"])
        for index, piece in enumerate(pieces):
            assert _put_chunk(client, upload_id, index, piece).status_code == 204
        return upload_id

    def test_complete_without_a_body_uses_every_present_slice(self, client: TestClient) -> None:
        upload_id = self._live_with_slices(client, [b"AA", b"BB", b"CC"])
        response = client.post(f"{UPLOADS}/{upload_id}/complete")
        assert response.status_code == 202, response.text
        attachment = response.json()["attachment"]
        assert (attachment["id"], attachment["kind"], attachment["status"]) == (
            upload_id,
            "voice",
            "processing",
        )
        assembled = client.app.state.paths.server_upload_dir(upload_id) / "assembled"  # type: ignore[attr-defined]
        # The media worker may already have consumed it; if not, it is exactly the joined bytes.
        if assembled.exists():
            assert assembled.read_bytes() == b"AABBCC"

    def test_complete_with_a_chunk_count_takes_exactly_that_many(self, client: TestClient) -> None:
        upload_id = self._live_with_slices(client, [b"AA", b"BB", b"CC"])
        response = client.post(f"{UPLOADS}/{upload_id}/complete", json={"chunkCount": 2})
        assert response.status_code == 202, response.text
        assert _row(client, upload_id).size_bytes == 4

    def test_missing_slices_below_the_chunk_count_are_409_incomplete(
        self, client: TestClient
    ) -> None:
        upload_id = self._live_with_slices(client, [b"AA"])
        response = client.post(f"{UPLOADS}/{upload_id}/complete", json={"chunkCount": 3})
        assert response.status_code == 409
        assert response.json() == {"error": "incomplete", "missing": [1, 2]}

    def test_no_slice_at_all_is_409_incomplete(self, client: TestClient) -> None:
        upload_id = _live_init(client).json()["uploadId"]
        assert client.post(f"{UPLOADS}/{upload_id}/complete").status_code == 409

    @pytest.mark.parametrize(
        "body",
        [
            {"chunkCount": 0},
            {"chunkCount": -3},
            {"chunkCount": "2"},
            {"chunkCount": True},
            {"chunkCount": 10**9},
            [1, 2],
        ],
    )
    def test_a_bad_chunk_count_is_422(self, client: TestClient, body: object) -> None:
        upload_id = self._live_with_slices(client, [b"AA"])
        assert client.post(f"{UPLOADS}/{upload_id}/complete", json=body).status_code == 422

    def test_an_ordinary_upload_ignores_any_complete_body(self, client: TestClient) -> None:
        init = client.post(
            UPLOADS, json={"kind": "voice", "mimeType": "audio/webm", "sizeBytes": 3}
        )
        upload_id = init.json()["uploadId"]
        assert _put_chunk(client, upload_id, 0, b"abc").status_code == 204
        response = client.post(
            f"{UPLOADS}/{upload_id}/complete", content=b"not json at all", headers={}
        )
        assert response.status_code == 202, response.text

    def test_a_live_upload_can_be_discarded(self, client: TestClient) -> None:
        upload_id = self._live_with_slices(client, [b"AA"])
        assert client.delete(f"{UPLOADS}/{upload_id}").status_code == 204
        store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
        assert store.get_upload(upload_id) is None
        assert not client.app.state.paths.server_upload_dir(upload_id).exists()  # type: ignore[attr-defined]

    def test_real_webm_slices_sent_over_http_become_a_ready_forty_second_note(
        self, client: TestClient, webm_40s: bytes
    ) -> None:
        size = len(webm_40s)
        pieces = _split(webm_40s, [123, size // 5, size // 2 + 1, size - 77])
        upload_id = _live_init(client).json()["uploadId"]
        for index, piece in enumerate(pieces):
            assert (
                _put_chunk(client, upload_id, index, piece, duration_ms=index * 10000).status_code
                == 204
            )
        done = client.post(f"{UPLOADS}/{upload_id}/complete", json={"chunkCount": len(pieces)})
        assert done.status_code == 202, done.text

        store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
        # Returns the moment it is ready; the long bound only matters on a saturated host, where
        # the below-normal-priority queue is starved (decisions/00209).
        deadline = time.monotonic() + 240.0
        while time.monotonic() < deadline:
            row = store.get_attachment(upload_id)
            if row is not None and row.status in ("ready", "failed"):
                break
            time.sleep(0.05)
        row = store.get_attachment(upload_id)
        assert row is not None and row.status == "ready", row
        assert row.duration_s == pytest.approx(40.0, abs=1.0)
        assert row.peaks is not None and len(row.peaks) == 64


class TestHttpUnsent:
    def _seed(self, client: TestClient, *, device: str, last_chunk_ago_s: float) -> str:
        upload_id = str(_live_init(client, deviceId=device).json()["uploadId"])
        assert _put_chunk(client, upload_id, 0, b"audio", duration_ms=61000).status_code == 204
        store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
        store.record_live_chunk(
            upload_id, size_bytes=5, duration_ms=61000, now=time.time() - last_chunk_ago_s
        )
        return upload_id

    def test_lists_this_devices_idle_unfinished_recordings_newest_first(
        self, client: TestClient
    ) -> None:
        first = self._seed(client, device=DEVICE, last_chunk_ago_s=300)
        time.sleep(0.01)
        second = self._seed(client, device=DEVICE, last_chunk_ago_s=100)
        self._seed(client, device=DEVICE, last_chunk_ago_s=2)  # recording right now
        self._seed(client, device=OTHER_DEVICE, last_chunk_ago_s=300)  # someone else's
        finished = self._seed(client, device=DEVICE, last_chunk_ago_s=500)
        assert client.post(f"{UPLOADS}/{finished}/complete").status_code == 202

        response = client.get(f"{UPLOADS}/unsent", params={"deviceId": DEVICE})

        assert response.status_code == 200, response.text
        unsent = response.json()["unsent"]
        assert [item["uploadId"] for item in unsent] == [second, first]
        assert set(unsent[0]) == {"uploadId", "durationMs", "sizeBytes", "startedAt", "lastChunkAt"}
        assert unsent[0]["durationMs"] == 61000 and unsent[0]["sizeBytes"] == 5
        assert unsent[0]["lastChunkAt"] == pytest.approx(time.time() - 100, abs=5)

    def test_nothing_unsent_is_an_empty_list_not_an_id_lookup(self, client: TestClient) -> None:
        response = client.get(f"{UPLOADS}/unsent", params={"deviceId": DEVICE})
        assert response.status_code == 200 and response.json() == {"unsent": []}

    def test_the_device_id_is_required(self, client: TestClient) -> None:
        assert client.get(f"{UPLOADS}/unsent").status_code == 422

    def test_a_discarded_recording_leaves_the_list(self, client: TestClient) -> None:
        upload_id = self._seed(client, device=DEVICE, last_chunk_ago_s=300)
        assert client.delete(f"{UPLOADS}/{upload_id}").status_code == 204
        response = client.get(f"{UPLOADS}/unsent", params={"deviceId": DEVICE})
        assert response.json() == {"unsent": []}

    def test_the_route_needs_the_server_token(self, client: TestClient) -> None:
        bare = client.get(
            f"{UPLOADS}/unsent",
            params={"deviceId": DEVICE},
            headers={"X-Wixy-Server-Token": "wrong"},
        )
        assert bare.status_code in (401, 403)
