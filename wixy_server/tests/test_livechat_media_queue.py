"""`wixy_server.livechat.media_queue` (spec/server-chat/00-brief.md §7 Queue,
§10 P2b) — binary resolution, end-to-end claim/process/finish via `run_forever`,
lease exclusivity + crash-resume across two `LiveChatStore` instances on the
same file, and the §17.1 delete-race rmtree behavior.

Photo attachments are used throughout (never voice/video): P2a's photo
pipeline is pure Pillow with no ffmpeg dependency, so these queue-mechanics
tests never need a real ffmpeg binary — bogus "unused" paths in `QueueConfig`
are safe as long as nothing here ever claims a video/voice kind.
"""

from __future__ import annotations

import io
import os
import shutil
import threading
from pathlib import Path

import anyio
import pytest
from anyio import CapacityLimiter
from PIL import Image

from wixy_server.livechat import janitor as livechat_janitor
from wixy_server.livechat import media_queue, processing, uploads
from wixy_server.livechat.models import AttachmentResult, AttachmentRow
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

_UNUSED_CONFIG = media_queue.QueueConfig(ffmpeg="unused", ffprobe="unused")


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return ProjectPaths(slug="test", root=tmp_path / "storage" / "projects" / "test")


def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 20), "red").save(buf, format="JPEG")
    return buf.getvalue()


def _ample_disk_usage(_path: str) -> tuple[int, int, int]:
    return 1_000_000_000_000, 0, 1_000_000_000_000


def _seed_processing_photo(
    store: LiveChatStore,
    paths: ProjectPaths,
    *,
    now: float,
    payload: bytes | None = None,
    mime_type: str = "image/jpeg",
) -> str:
    """Runs a real upload through init -> chunk -> complete, landing a
    `processing`-status photo attachment with a genuine JPEG staged at
    `uploads/<id>/assembled` — exactly what `media_queue` expects to find."""
    data = payload if payload is not None else _jpeg_bytes()
    init = uploads.init_upload(
        store=store,
        kind="photo",
        mime_type=mime_type,
        size_bytes=len(data),
        filename=None,
        by_email=None,
        chunk_bytes=len(data),
        quota_bytes=1_000_000_000,
        min_free_bytes=0,
        media_available=True,
        disk_check_path=paths.root,
        now=now,
        disk_usage=_ample_disk_usage,
    )
    uploads.write_chunk(paths.server_upload_dir(init.upload_id), 0, data)
    attachment = uploads.assemble(
        store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=len(data), now=now
    )
    return attachment.id


class TestResolveBinaries:
    def test_explicit_overrides_pointing_at_a_real_file_are_used_verbatim(
        self, tmp_path: Path
    ) -> None:
        ffmpeg = tmp_path / "ffmpeg.exe"
        ffprobe = tmp_path / "ffprobe.exe"
        ffmpeg.write_bytes(b"")
        ffprobe.write_bytes(b"")
        config = media_queue.resolve_binaries(str(ffmpeg), str(ffprobe))
        assert config == media_queue.QueueConfig(ffmpeg=str(ffmpeg), ffprobe=str(ffprobe))

    def test_explicit_override_pointing_at_nothing_resolves_to_none(self, tmp_path: Path) -> None:
        # §7: an operator typo in WIXY_FFMPEG must be caught here (a clean 503
        # at upload time), not silently accepted only to fail later inside the
        # queue against a path that was never real.
        assert media_queue.resolve_binaries(str(tmp_path / "no-such-ffmpeg"), "") is None

    def test_falls_back_to_shutil_which(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(shutil, "which", lambda name: f"/usr/bin/{name}")
        config = media_queue.resolve_binaries("", "")
        assert config == media_queue.QueueConfig(
            ffmpeg="/usr/bin/ffmpeg", ffprobe="/usr/bin/ffprobe"
        )

    def test_missing_binary_resolves_to_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(shutil, "which", lambda _name: None)
        assert media_queue.resolve_binaries("", "") is None

    def test_only_one_missing_still_resolves_to_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            shutil, "which", lambda name: "/usr/bin/ffmpeg" if name == "ffmpeg" else None
        )
        assert media_queue.resolve_binaries("", "") is None


class TestRunForeverEndToEnd:
    def test_palette_photo_renditions_are_verified_before_original_is_deleted(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        source_image = Image.new("P", (40, 20), 1)
        source_image.putpalette([0, 0, 0, 15, 180, 225] + [0, 0, 0] * 254)
        source = io.BytesIO()
        source_image.save(source, format="PNG")
        expected = source_image.convert("RGB").getpixel((20, 10))
        att_id = _seed_processing_photo(
            store, paths, now=1000.0, payload=source.getvalue(), mime_type="image/png"
        )
        attachment = store.get_attachment(att_id)
        assert attachment is not None
        original = paths.server_upload_dir(att_id) / "assembled"
        media_dir = paths.server_attachment_media_dir(att_id)
        original_delete = store.delete_upload

        def delete_only_after_rendering_verified(upload_id: str) -> None:
            assert upload_id == att_id
            assert original.is_file()
            with Image.open(media_dir / "full.png") as full:
                assert full.convert("RGB").getpixel((20, 10)) == expected
            with Image.open(media_dir / "thumb.jpg") as thumb:
                actual = thumb.convert("RGB").getpixel((thumb.width // 2, thumb.height // 2))
                assert all(abs(actual[channel] - expected[channel]) <= 8 for channel in range(3))
            original_delete(upload_id)

        monkeypatch.setattr(store, "delete_upload", delete_only_after_rendering_verified)

        assert media_queue._do_work(
            store=store,
            paths=paths,
            config=_UNUSED_CONFIG,
            owner="owner",
            att=attachment,
        )
        assert store.get_upload(att_id) is None
        assert not original.exists()

    @pytest.mark.asyncio
    async def test_delete_race_pending_writes_run_off_event_loop(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        att = store.get_attachment(att_id)
        assert att is not None
        event_loop_thread = threading.get_ident()
        write_threads: list[int] = []
        original_mark_pending = store.mark_deleted_storage_pending

        def mark_pending(*, kind: str, storage_id: str, now: float) -> None:
            write_threads.append(threading.get_ident())
            original_mark_pending(kind=kind, storage_id=storage_id, now=now)

        async def no_renewal(*_args: object) -> None:
            return None

        monkeypatch.setattr(store, "mark_deleted_storage_pending", mark_pending)
        monkeypatch.setattr(media_queue, "_do_work", lambda **_kwargs: False)
        monkeypatch.setattr(media_queue, "_renew_loop", no_renewal)
        monkeypatch.setattr(media_queue, "_cleanup_deleted_storage", lambda **_kwargs: None)

        await media_queue._handle_claimed(
            store,
            paths,
            LiveChatNotifier(),
            _UNUSED_CONFIG,
            CapacityLimiter(1),
            att,
            "owner",
        )

        assert len(write_threads) == 2
        assert all(thread_id != event_loop_thread for thread_id in write_threads)

    @pytest.mark.asyncio
    async def test_processes_a_claimed_photo_to_ready_and_notifies(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        notifier = LiveChatNotifier()
        published = anyio.Event()

        original_publish = notifier.publish

        def _spy_publish() -> None:
            published.set()
            original_publish()

        notifier.publish = _spy_publish  # type: ignore[method-assign]

        async def _run() -> None:
            await media_queue.run_forever(
                store=store, paths=paths, notifier=notifier, config=_UNUSED_CONFIG
            )

        async with anyio.create_task_group() as tg:
            tg.start_soon(_run)
            with anyio.fail_after(5):
                await published.wait()
            tg.cancel_scope.cancel()

        attachment = store.get_attachment(att_id)
        assert attachment is not None
        assert attachment.status == "ready"
        assert attachment.mime == "image/jpeg"
        assert attachment.renditions == ("full", "thumb")
        # The original upload is gone once processing succeeds (R10).
        assert store.get_upload(att_id) is None
        assert not paths.server_upload_dir(att_id).exists()
        media_dir = paths.server_attachment_media_dir(att_id)
        assert (media_dir / "full.jpg").is_file()
        assert (media_dir / "thumb.jpg").is_file()

    @pytest.mark.asyncio
    async def test_a_corrupt_source_ends_up_failed_and_archived(
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
            quota_bytes=1_000_000_000,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=paths.root,
            now=1000.0,
            disk_usage=_ample_disk_usage,
        )
        uploads.write_chunk(paths.server_upload_dir(init.upload_id), 0, b"nope")  # not a real jpeg
        attachment = uploads.assemble(
            store=store, paths=paths, upload_id=init.upload_id, chunk_bytes=4, now=1000.0
        )

        notifier = LiveChatNotifier()

        async def _run() -> None:
            await media_queue.run_forever(
                store=store, paths=paths, notifier=notifier, config=_UNUSED_CONFIG
            )

        async with anyio.create_task_group() as tg:
            tg.start_soon(_run)
            with anyio.fail_after(5):
                while True:
                    row = await anyio.to_thread.run_sync(store.get_attachment, attachment.id)
                    if row is not None and row.status != "processing":
                        break
                    await anyio.sleep(0.02)
            tg.cancel_scope.cancel()

        assert row is not None
        assert row.status == "failed"
        assert row.failure == "unsupported"
        # Kept for diagnosis, not deleted; the upload bookkeeping is done.
        assert (paths.server_failed_dir(attachment.id) / "original.jpg").is_file()
        assert store.get_upload(attachment.id) is None

    @pytest.mark.asyncio
    async def test_an_unexpected_exception_still_resolves_to_failed(
        self, store: LiveChatStore, paths: ProjectPaths, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A bug in processing.process (or an OS-level surprise) must not
        leave the row `processing` forever — that would poison the queue:
        the lease lapses, the next claim retries the SAME item indefinitely,
        and nothing behind it ever gets a turn."""

        def _boom(*args: object, **kwargs: object) -> object:
            raise RuntimeError("surprise!")

        monkeypatch.setattr(processing, "process", _boom)
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        notifier = LiveChatNotifier()

        async def _run() -> None:
            await media_queue.run_forever(
                store=store, paths=paths, notifier=notifier, config=_UNUSED_CONFIG
            )

        async with anyio.create_task_group() as tg:
            tg.start_soon(_run)
            with anyio.fail_after(5):
                while True:
                    row = await anyio.to_thread.run_sync(store.get_attachment, att_id)
                    if row is not None and row.status != "processing":
                        break
                    await anyio.sleep(0.02)
            tg.cancel_scope.cancel()

        assert row is not None
        assert row.status == "failed"
        assert row.failure == "internal_error"


class TestLeaseExclusivityAndCrashResume:
    def test_a_second_store_instance_cannot_claim_an_active_lease(self, tmp_path: Path) -> None:
        db_path = tmp_path / "server" / "server.db"
        store_a = LiveChatStore(db_path)
        store_b = LiveChatStore(db_path)
        store_a.create_attachment(att_id="a" * 32, kind="photo", now=1000.0)

        claimed_a = store_a.claim_processing(owner="owner-a", now=1000.0, lease_s=120.0)
        claimed_b = store_b.claim_processing(owner="owner-b", now=1000.5, lease_s=120.0)

        assert claimed_a is not None
        assert claimed_b is None

    def test_a_second_store_instance_reclaims_after_the_lease_expires(self, tmp_path: Path) -> None:
        """Crash-resume (§7): a second process (simulated here as a second
        `LiveChatStore` on the same file) needs no special recovery step — the
        expired lease alone makes the row claimable again."""
        db_path = tmp_path / "server" / "server.db"
        store_a = LiveChatStore(db_path)
        store_b = LiveChatStore(db_path)
        store_a.create_attachment(att_id="b" * 32, kind="photo", now=1000.0)
        store_a.claim_processing(owner="owner-a", now=1000.0, lease_s=120.0)

        reclaimed = store_b.claim_processing(owner="owner-b", now=1000.0 + 121.0, lease_s=120.0)

        assert reclaimed is not None
        assert reclaimed.lease_owner == "owner-b"


class TestDeleteRace:
    @pytest.mark.asyncio
    async def test_one_failed_item_does_not_cancel_its_sibling(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        first_id = _seed_processing_photo(store, paths, now=1000.0)
        second_id = _seed_processing_photo(store, paths, now=1000.0)
        first = store.get_attachment(first_id)
        second = store.get_attachment(second_id)
        assert first is not None and second is not None
        sibling_ran = anyio.Event()

        async def fail_one(
            _store: LiveChatStore,
            _paths: ProjectPaths,
            _notifier: LiveChatNotifier,
            _config: media_queue.QueueConfig,
            _limiter: CapacityLimiter,
            att: AttachmentRow,
            _owner: str,
        ) -> None:
            if att.id == first_id:
                raise RuntimeError("simulated isolated item failure")
            sibling_ran.set()

        monkeypatch.setattr(media_queue, "_handle_claimed", fail_one)
        config = media_queue.QueueConfig(ffmpeg="ffmpeg", ffprobe="ffprobe")
        limiter = CapacityLimiter(2)
        async with anyio.create_task_group() as task_group:
            task_group.start_soon(
                media_queue._handle_claimed_isolated,
                store,
                paths,
                LiveChatNotifier(),
                config,
                limiter,
                first,
                "first-owner",
            )
            task_group.start_soon(
                media_queue._handle_claimed_isolated,
                store,
                paths,
                LiveChatNotifier(),
                config,
                limiter,
                second,
                "second-owner",
            )
            with anyio.fail_after(1):
                await sibling_ran.wait()
            task_group.cancel_scope.cancel()

    def test_wipe_removing_source_during_failed_archive_does_not_crash_worker(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        message, _created = store.create_message(
            client_id="client-wipe-archive-race",
            sender="Josh",
            device_id="device-wipe-archive-race",
            by_email=None,
            text="wipe while failure is archived",
            attachment_ids=(att_id,),
            now=1000.0,
        )
        src = paths.server_upload_dir(att_id) / "assembled"
        store.wipe(now=1001.0)

        is_file = Path.is_file

        def _vanish_after_file_check(path: Path) -> bool:
            exists = is_file(path)
            if path == src and exists:
                path.unlink()
            return exists

        monkeypatch.setattr(Path, "is_file", _vanish_after_file_check)
        media_queue._archive_failed_original(store=store, paths=paths, att_id=att_id, src=src)

        assert store.get_attachment(att_id) is None
        assert store.get_upload(att_id) is None
        assert not paths.server_upload_dir(att_id).exists()
        assert not paths.server_failed_dir(att_id).exists()

    def test_wipe_racing_archive_via_windows_sharing_violation_does_not_crash_worker(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Same race as the sibling FileNotFoundError test above, but the OS-level
        signature a concurrent rmtree actually produces on Windows: `os.replace`
        raises `PermissionError` ("Access is denied"), not `FileNotFoundError`,
        when another thread is mid-delete on the same directory. Unlike the
        sibling test, the attachment row must still exist when `os.replace` is
        invoked (otherwise `_archive_failed_original`'s row-gone check at the top
        short-circuits before ever calling `os.replace`) — so the wipe happens
        *inside* the patched `os.replace`, matching the real two-thread timing:
        the concurrent delete commits its DB transaction and starts removing
        files at the exact moment this worker's own replace is in flight."""
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        store.create_message(
            client_id="client-wipe-archive-race-winerror5",
            sender="Josh",
            device_id="device-wipe-archive-race-winerror5",
            by_email=None,
            text="wipe while failure is archived (Windows sharing violation)",
            attachment_ids=(att_id,),
            now=1000.0,
        )
        src = paths.server_upload_dir(att_id) / "assembled"
        assert store.get_attachment(att_id) is not None

        def _replace_raises_access_denied(*args: object, **kwargs: object) -> None:
            store.wipe(now=1001.0)
            raise PermissionError(5, "Access is denied")

        monkeypatch.setattr(os, "replace", _replace_raises_access_denied)
        media_queue._archive_failed_original(store=store, paths=paths, att_id=att_id, src=src)

        assert store.get_attachment(att_id) is None
        assert store.get_upload(att_id) is None
        assert not paths.server_upload_dir(att_id).exists()
        assert not paths.server_failed_dir(att_id).exists()

    def test_wipe_racing_failed_dir_mkdir_via_windows_sharing_violation_does_not_crash_worker(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Sibling of the two tests above, but the race lands one line earlier:
        `failed_dir.mkdir(parents=True, exist_ok=True)` used to run BEFORE the
        `try:` block that guards `os.replace`, so a concurrent wipe racing the
        mkdir itself (Windows: PermissionError) escaped uncaught even though
        the row-gone recheck below would have treated it as benign, exactly
        like the os.replace case."""
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        store.create_message(
            client_id="client-wipe-mkdir-race-winerror5",
            sender="Josh",
            device_id="device-wipe-mkdir-race-winerror5",
            by_email=None,
            text="wipe while failed_dir is being created (Windows sharing violation)",
            attachment_ids=(att_id,),
            now=1000.0,
        )
        src = paths.server_upload_dir(att_id) / "assembled"
        failed_dir = paths.server_failed_dir(att_id)
        assert store.get_attachment(att_id) is not None

        real_mkdir = Path.mkdir

        def _mkdir_raises_access_denied(self: Path, *args: object, **kwargs: object) -> None:
            if self == failed_dir:
                store.wipe(now=1001.0)
                raise PermissionError(5, "Access is denied")
            real_mkdir(self, *args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(Path, "mkdir", _mkdir_raises_access_denied)
        media_queue._archive_failed_original(store=store, paths=paths, att_id=att_id, src=src)

        assert store.get_attachment(att_id) is None
        assert store.get_upload(att_id) is None
        assert not paths.server_upload_dir(att_id).exists()
        assert not paths.server_failed_dir(att_id).exists()

    def test_genuine_archive_failure_preserves_original_and_hourly_retry_archives_it(
        self,
        store: LiveChatStore,
        paths: ProjectPaths,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        claimed = store.claim_processing(owner="owner", now=1000.0, lease_s=120.0)
        assert claimed is not None
        store.finish_attachment(
            att_id=att_id,
            owner="owner",
            result=AttachmentResult(
                status="failed",
                mime=None,
                width=None,
                height=None,
                duration_s=None,
                peaks=None,
                renditions=(),
                bytes_on_disk=0,
                failure="decode_failed",
            ),
            now=1001.0,
        )
        src = paths.server_upload_dir(att_id) / "assembled"
        original_bytes = src.read_bytes()
        real_replace = os.replace

        def deny_archive(source: object, destination: object) -> None:
            raise PermissionError(5, "Access is denied")

        monkeypatch.setattr(os, "replace", deny_archive)
        media_queue._archive_failed_original(store=store, paths=paths, att_id=att_id, src=src)

        assert store.get_attachment(att_id) is not None
        assert store.get_upload(att_id) is not None
        assert src.read_bytes() == original_bytes
        assert not paths.server_failed_dir(att_id).joinpath("original.jpg").exists()

        monkeypatch.setattr(os, "replace", real_replace)
        livechat_janitor.run_once(store=store, paths=paths, now=1002.0)

        assert store.get_attachment(att_id) is not None
        assert store.get_upload(att_id) is None
        assert not paths.server_upload_dir(att_id).exists()
        assert (
            paths.server_failed_dir(att_id).joinpath("original.jpg").read_bytes() == original_bytes
        )

    def test_unarchived_failed_original_expires_after_seven_days(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        failed_at = 101.0
        att_id = _seed_processing_photo(store, paths, now=100.0)
        claimed = store.claim_processing(owner="owner", now=100.0, lease_s=120.0)
        assert claimed is not None
        store.finish_attachment(
            att_id=att_id,
            owner="owner",
            result=AttachmentResult(
                status="failed",
                mime=None,
                width=None,
                height=None,
                duration_s=None,
                peaks=None,
                renditions=(),
                bytes_on_disk=0,
                failure="decode_failed",
            ),
            now=failed_at,
        )
        message, _ = store.create_message(
            client_id="client-failed-original-retention",
            sender="Josh",
            device_id="device-failed-original-retention",
            by_email=None,
            text="failed media remains attached for retention",
            attachment_ids=(),
            now=failed_at,
        )
        with store._write_txn() as conn:
            conn.execute(
                "UPDATE attachments SET message_seq = ?, ordinal = 0 WHERE id = ?",
                (message.seq, att_id),
            )
        source = paths.server_upload_dir(att_id) / "assembled"
        assert source.exists()

        livechat_janitor.run_once(
            store=store,
            paths=paths,
            now=failed_at + livechat_janitor.FAILED_RETENTION_S + 1,
        )

        assert store.get_attachment(att_id) is not None
        assert store.get_upload(att_id) is None
        assert not source.exists()
        assert not paths.server_upload_dir(att_id).exists()

    @pytest.mark.asyncio
    async def test_media_dir_is_rmtreed_when_the_row_is_gone_after_finish(
        self, store: LiveChatStore, paths: ProjectPaths
    ) -> None:
        """§17.1/§17.2 A1's race rule, the queue's own half: after
        `finish_attachment` (itself a silent no-op against a gone row, §17.1),
        the queue re-reads `get_attachment`; `None` means a concurrent
        delete/wipe won the race, and the media bytes this worker just wrote
        must not be left behind."""
        att_id = _seed_processing_photo(store, paths, now=1000.0)
        message, _created = store.create_message(
            client_id="client-delete-race-1",
            sender="Josh",
            device_id="device-delete-race",
            by_email=None,
            text="delete while media is processing",
            attachment_ids=(att_id,),
            now=1000.0,
        )
        claimed = store.claim_processing(owner="owner", now=1000.0, lease_s=120.0)
        assert claimed is not None

        # Simulate P8's delete landing while this worker is mid-flight. A bad
        # source makes the worker create `failed/<id>/` after the delete, too.
        store.delete_message(seq=message.seq, now=1001.0)
        (paths.server_upload_dir(att_id) / "assembled").write_bytes(b"not an image")

        notifier = LiveChatNotifier()
        await media_queue._handle_claimed(
            store, paths, notifier, _UNUSED_CONFIG, CapacityLimiter(2), claimed, "owner"
        )

        assert store.get_attachment(att_id) is None
        assert not paths.server_attachment_media_dir(att_id).exists()
        assert not paths.server_upload_dir(att_id).exists()
        assert not paths.server_failed_dir(att_id).exists()
