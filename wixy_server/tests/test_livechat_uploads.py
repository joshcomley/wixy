"""`wixy_server.livechat.uploads` (spec/server-chat/00-brief.md §5.5, R11) —
init caps/quota/free-space, chunk index validation + capped streaming read,
assemble (missing chunks, size mismatch, idempotent replay), cancel.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from wixy_server.livechat import uploads
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")


def _ample_disk_usage(_path: str) -> tuple[int, int, int]:
    total = 1_000_000_000_000
    used = 1_000_000
    return total, used, total - used


class TestInitUpload:
    def test_success_creates_upload_row_and_returns_caps(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        result = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=1024,
            filename="a.jpg",
            by_email="a@example.com",
            chunk_bytes=8 * 1024 * 1024,
            quota_bytes=1_000_000_000,
            min_free_bytes=1_000,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        assert result.chunk_bytes == 8 * 1024 * 1024
        assert result.max_bytes == uploads.MAX_UPLOAD_BYTES["photo"]
        row = store.get_upload(result.upload_id)
        assert row is not None
        assert row.kind == "photo"
        assert row.mime == "image/jpeg"
        assert row.size_bytes == 1024

    def test_media_unavailable_rejected_before_anything_else(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        with pytest.raises(uploads.MediaUnavailableError):
            uploads.init_upload(
                store=store,
                kind="photo",
                mime_type="image/jpeg",
                size_bytes=1024,
                filename=None,
                by_email=None,
                chunk_bytes=8 * 1024 * 1024,
                quota_bytes=1_000_000_000,
                min_free_bytes=1_000,
                media_available=False,
                disk_check_path=paths.root,
                now=1000.0,
                disk_usage=_ample_disk_usage,
            )

    def test_unsupported_mime_type_rejected(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        with pytest.raises(uploads.UnsupportedTypeError):
            uploads.init_upload(
                store=store,
                kind="photo",
                mime_type="application/pdf",
                size_bytes=1024,
                filename=None,
                by_email=None,
                chunk_bytes=8 * 1024 * 1024,
                quota_bytes=1_000_000_000,
                min_free_bytes=1_000,
                media_available=True,
                disk_check_path=paths.root,
                now=1000.0,
                disk_usage=_ample_disk_usage,
            )

    def test_oversized_declared_size_rejected(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        with pytest.raises(uploads.TooLargeError) as exc:
            uploads.init_upload(
                store=store,
                kind="photo",
                mime_type="image/jpeg",
                size_bytes=uploads.MAX_UPLOAD_BYTES["photo"] + 1,
                filename=None,
                by_email=None,
                chunk_bytes=8 * 1024 * 1024,
                quota_bytes=1_000_000_000_000,
                min_free_bytes=1_000,
                media_available=True,
                disk_check_path=paths.root,
                now=1000.0,
                disk_usage=_ample_disk_usage,
            )
        assert exc.value.max_bytes == uploads.MAX_UPLOAD_BYTES["photo"]

    def test_quota_exceeded_is_storage_full(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        with pytest.raises(uploads.StorageFullError):
            uploads.init_upload(
                store=store,
                kind="photo",
                mime_type="image/jpeg",
                size_bytes=1_000,
                filename=None,
                by_email=None,
                chunk_bytes=8 * 1024 * 1024,
                quota_bytes=500,  # smaller than the upload itself
                min_free_bytes=0,
                media_available=True,
                disk_check_path=paths.root,
                now=1000.0,
                disk_usage=_ample_disk_usage,
            )

    def test_free_space_floor_breached_is_storage_full(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        def _tight_disk(_path: str) -> tuple[int, int, int]:
            return 1_000_000, 999_500, 500  # only 500 bytes free

        with pytest.raises(uploads.StorageFullError):
            uploads.init_upload(
                store=store,
                kind="photo",
                mime_type="image/jpeg",
                size_bytes=100,
                filename=None,
                by_email=None,
                chunk_bytes=8 * 1024 * 1024,
                quota_bytes=1_000_000_000,
                min_free_bytes=1_000,  # needs 500 - 100 >= 1000, which fails
                media_available=True,
                disk_check_path=paths.root,
                now=1000.0,
                disk_usage=_tight_disk,
            )

    def test_quota_counts_pending_uploads_and_media_bytes(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        # First upload consumes most of the quota...
        uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=900,
            filename=None,
            by_email=None,
            chunk_bytes=8 * 1024 * 1024,
            quota_bytes=1000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        # ...so a second one that would push past the quota is rejected, even
        # though nothing has finished processing yet (pending_upload_bytes).
        with pytest.raises(uploads.StorageFullError):
            uploads.init_upload(
                store=store,
                kind="photo",
                mime_type="image/jpeg",
                size_bytes=200,
                filename=None,
                by_email=None,
                chunk_bytes=8 * 1024 * 1024,
                quota_bytes=1000,
                min_free_bytes=0,
                media_available=True,
                disk_check_path=paths.root,
                now=1000.0,
                disk_usage=_ample_disk_usage,
            )


class TestChunkIndexValidation:
    def test_expected_chunk_count(self) -> None:
        assert uploads.expected_chunk_count(0, 100) == 0
        assert uploads.expected_chunk_count(100, 100) == 1
        assert uploads.expected_chunk_count(101, 100) == 2
        assert uploads.expected_chunk_count(250, 100) == 3

    def test_in_range_index_accepted(self) -> None:
        uploads.validate_chunk_index(0, 250, 100)
        uploads.validate_chunk_index(2, 250, 100)

    def test_out_of_range_index_rejected(self) -> None:
        with pytest.raises(uploads.InvalidChunkIndexError):
            uploads.validate_chunk_index(3, 250, 100)
        with pytest.raises(uploads.InvalidChunkIndexError):
            uploads.validate_chunk_index(-1, 250, 100)


class TestReadCapped:
    async def _chunks(self, *pieces: bytes) -> AsyncIterator[bytes]:
        for piece in pieces:
            yield piece

    @pytest.mark.asyncio
    async def test_reads_within_cap(self) -> None:
        data = await uploads.read_capped(self._chunks(b"abc", b"def"), cap=10)
        assert data == b"abcdef"

    @pytest.mark.asyncio
    async def test_raises_the_moment_cap_is_exceeded(self) -> None:
        with pytest.raises(uploads.ChunkTooLargeError) as exc:
            await uploads.read_capped(self._chunks(b"a" * 5, b"b" * 5, b"c" * 5), cap=8)
        assert exc.value.chunk_bytes == 8


class TestWriteChunk:
    def test_writes_and_is_idempotent_on_replay(self, tmp_path: Path) -> None:
        upload_dir = tmp_path / "upload"
        uploads.write_chunk(upload_dir, 0, b"hello")
        assert (upload_dir / "chunk-000000").read_bytes() == b"hello"
        uploads.write_chunk(upload_dir, 0, b"world!")  # re-PUT overwrites
        assert (upload_dir / "chunk-000000").read_bytes() == b"world!"

    def test_no_leftover_part_file(self, tmp_path: Path) -> None:
        upload_dir = tmp_path / "upload"
        uploads.write_chunk(upload_dir, 0, b"data")
        assert not (upload_dir / "chunk-000000.part").exists()


class TestAssemble:
    def test_assembles_all_chunks_and_creates_the_attachment(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=9,
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 0, b"abcd")
        uploads.write_chunk(upload_dir, 1, b"efgh")
        uploads.write_chunk(upload_dir, 2, b"i")

        attachment = uploads.assemble(
            store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1001.0
        )
        assert attachment.id == init.upload_id
        assert attachment.kind == "photo"
        assert attachment.status == "processing"
        assert (upload_dir / "assembled").read_bytes() == b"abcdefghi"
        # Chunk fragments are cleaned up once assembled.
        assert not (upload_dir / "chunk-000000").exists()

    def test_missing_chunks_reported(self, store: LiveChatStore, paths: ProjectPaths) -> None:
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=9,
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 1, b"efgh")  # chunk 0 and 2 missing

        with pytest.raises(uploads.IncompleteUploadError) as exc:
            uploads.assemble(
                store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1001.0
            )
        assert exc.value.missing == [0, 2]

    def test_size_mismatch_rejected(self, store: LiveChatStore, paths: ProjectPaths) -> None:
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=8,  # declared 8, but chunks below total 9
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 0, b"abcd")
        uploads.write_chunk(upload_dir, 1, b"efghi")  # one byte too many

        with pytest.raises(uploads.SizeMismatchError):
            uploads.assemble(
                store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1001.0
            )

    def test_unknown_upload_rejected(self, store: LiveChatStore, paths: ProjectPaths) -> None:
        with pytest.raises(uploads.UnknownUploadError):
            uploads.assemble(
                store=store, paths=paths, upload_id="deadbeef", chunk_bytes=4, now=1001.0
            )

    def test_retried_complete_is_idempotent(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=4,
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 0, b"abcd")

        first = uploads.assemble(
            store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1001.0
        )
        # A retried /complete after the chunk fragments are already gone must
        # replay the same attachment, not report a spurious "incomplete".
        second = uploads.assemble(
            store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1002.0
        )
        assert second == first

    def test_delete_racing_replace_via_windows_sharing_violation_reports_unknown_upload(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A concurrent delete/wipe racing this assemble's `os.replace` (moving
        `assembled.part` -> `assembled`) can remove `upload_dir` mid-operation.
        On POSIX that surfaces as `FileNotFoundError`; on Windows, a concurrent
        rmtree on the same path surfaces as `PermissionError` ("Access is
        denied") instead — both must be treated the same way (the concurrent
        delete wins, report UnknownUploadError), not crash the request."""
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=4,
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 0, b"abcd")

        def _replace_raises_access_denied(*args: object, **kwargs: object) -> None:
            store.delete_upload(init.upload_id)
            raise PermissionError(5, "Access is denied")

        monkeypatch.setattr(os, "replace", _replace_raises_access_denied)

        with pytest.raises(uploads.UnknownUploadError):
            uploads.assemble(
                store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1001.0
            )


class TestCancelUpload:
    def test_deletes_a_pending_upload_and_its_directory(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=4,
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 0, b"abcd")

        uploads.cancel_upload(store=store, paths=paths, upload_id=init.upload_id)
        assert store.get_upload(init.upload_id) is None
        assert not upload_dir.exists()

    def test_no_op_once_already_promoted_to_an_attachment(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        init = uploads.init_upload(
            store=store,
            kind="photo",
            mime_type="image/jpeg",
            size_bytes=4,
            filename=None,
            by_email=None,
            chunk_bytes=4,
            quota_bytes=1_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        upload_dir = paths.server_upload_dir(init.upload_id)
        uploads.write_chunk(upload_dir, 0, b"abcd")
        uploads.assemble(
            store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1001.0
        )

        # The queue now owns the staged file; cancel must not disturb it.
        uploads.cancel_upload(store=store, paths=paths, upload_id=init.upload_id)
        assert store.get_upload(init.upload_id) is not None
        assert (upload_dir / "assembled").is_file()

    def test_cancel_of_unknown_upload_is_a_no_op(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        uploads.cancel_upload(store=store, paths=paths, upload_id="deadbeef")  # doesn't raise

    def test_cancel_rejects_a_traversal_id_instead_of_deleting_server_dir(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        # `server_upload_dir` is a plain path join with no normalization:
        # `server_uploads / ".."` resolves to `server_dir` itself, which holds
        # the DB, secret.key, vapid.json and every attachment's media. An
        # unvalidated id here would let an authenticated request wipe the
        # whole feature's state via `shutil.rmtree(..., ignore_errors=True)`.
        sentinel = paths.server_dir / "secret.key"
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_bytes(b"not-actually-a-secret")

        uploads.cancel_upload(store=store, paths=paths, upload_id="..")

        assert sentinel.exists()
        assert sentinel.read_bytes() == b"not-actually-a-secret"


class TestFailedExtension:
    def test_known_mime_maps_to_its_extension(self) -> None:
        assert uploads.failed_extension("image/jpeg") == "jpg"
        assert uploads.failed_extension("audio/x-m4a") == "m4a"

    def test_unknown_or_missing_mime_falls_back_to_bin(self) -> None:
        assert uploads.failed_extension("application/x-nonsense") == "bin"
        assert uploads.failed_extension(None) == "bin"
