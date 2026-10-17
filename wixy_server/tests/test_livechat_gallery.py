"""The Server chat gallery (workspace 00046): the store's media-history query, the grid
thumbnail every photo/video gets (new media and the backfill of old media), the
`GET /gallery` route and the `dl=1` save disposition on the signed media route."""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from wixy_server.app import create_app
from wixy_server.livechat import processing, thumbnails
from wixy_server.livechat.models import AttachmentRow
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE, sign_media_url
from wixy_server.storage import ProjectPaths
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


def _add_attachment(
    store: LiveChatStore,
    att_id: str,
    *,
    kind: str = "photo",
    status: str = "ready",
    renditions: tuple[str, ...] = ("full", "thumb"),
    mime: str = "image/jpeg",
    now: float = 1000.0,
) -> None:
    store.list_messages(before=None, limit=1)  # force the lazy migration
    with store._write_txn() as conn:
        conn.execute(
            "INSERT INTO attachments (id, kind, status, mime, width, height, renditions, "
            "bytes_on_disk, created_at, updated_at) VALUES (?, ?, ?, ?, 40, 30, ?, 100, ?, ?)",
            (att_id, kind, status, mime, json.dumps(list(renditions)), now, now),
        )


def _send(store: LiveChatStore, client_id: str, att_ids: tuple[str, ...], now: float) -> int:
    row, _ = store.create_message(
        client_id=client_id,
        sender="Josh",
        device_id="device-aaaaaaaa",
        by_email=None,
        text=None,
        attachment_ids=att_ids,
        now=now,
    )
    return row.seq


def _ids(rows: list[AttachmentRow]) -> list[str]:
    return [r.id for r in rows]


# ---------------------------------------------------------------------------
# list_gallery
# ---------------------------------------------------------------------------


class TestListGallery:
    def test_newest_first_by_message_then_ordinal(self, store: LiveChatStore) -> None:
        for att in ("a1", "a2", "a3"):
            _add_attachment(store, att)
        _send(store, "client-00000001", ("a1",), 1001.0)
        _send(store, "client-00000002", ("a2", "a3"), 1002.0)

        rows, has_more = store.list_gallery(before=None, limit=10)

        assert _ids(rows) == ["a3", "a2", "a1"]
        assert has_more is False

    def test_pages_with_the_seq_ordinal_cursor(self, store: LiveChatStore) -> None:
        for att in ("a1", "a2", "a3", "a4"):
            _add_attachment(store, att)
        _send(store, "client-00000001", ("a1", "a2"), 1001.0)
        _send(store, "client-00000002", ("a3", "a4"), 1002.0)

        first, more = store.list_gallery(before=None, limit=3)
        assert _ids(first) == ["a4", "a3", "a2"]
        assert more is True
        last = first[-1]
        assert last.message_seq is not None and last.ordinal is not None
        second, more2 = store.list_gallery(before=(last.message_seq, last.ordinal), limit=3)

        assert _ids(second) == ["a1"]
        assert more2 is False

    def test_only_ready_photos_and_videos_on_sent_messages(self, store: LiveChatStore) -> None:
        _add_attachment(store, "photo-ok")
        _add_attachment(store, "video-ok", kind="video", renditions=("play", "poster", "thumb"))
        _add_attachment(store, "voice", kind="voice", renditions=("play",))
        _add_attachment(store, "still-processing", status="processing", renditions=())
        _add_attachment(store, "unsent")
        _send(
            store, "client-00000001", ("photo-ok", "video-ok", "voice", "still-processing"), 1001.0
        )

        rows, _ = store.list_gallery(before=None, limit=10)

        assert _ids(rows) == ["video-ok", "photo-ok"]

    def test_view_once_media_never_appears(self, store: LiveChatStore) -> None:
        _add_attachment(store, "kept")
        _add_attachment(store, "secret")
        _send(store, "client-00000001", ("kept",), 1001.0)
        store.create_view_once_message(
            client_id="client-00000002",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            attachment_id="secret",
            duration_s=5,
            tease=False,
            now=1002.0,
        )

        rows, _ = store.list_gallery(before=None, limit=10)

        assert _ids(rows) == ["kept"]

    def test_would_you_rather_pictures_are_not_sent_media(self, store: LiveChatStore) -> None:
        _add_attachment(store, "mine")
        _send(store, "client-00000001", ("mine",), 1001.0)
        anchor, _ = store.create_wyr_round(
            client_id="client-wyr-0001",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            question_id="q-1",
            images_pending=True,
            now=1002.0,
        )
        for att in ("game-a", "game-b"):
            _add_attachment(store, att)
        with store._write_txn() as conn:
            conn.execute(
                "UPDATE attachments SET message_seq = ?, ordinal = 0 "
                "WHERE id IN ('game-a', 'game-b')",
                (anchor.seq,),
            )

        rows, _ = store.list_gallery(before=None, limit=10)

        assert _ids(rows) == ["mine"]


# ---------------------------------------------------------------------------
# Thumbnails: new media + backfill
# ---------------------------------------------------------------------------


def _jpeg(path: Path, size: tuple[int, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, "red").save(path, format="JPEG")


class TestMakeThumbnail:
    def test_caps_the_long_edge_and_keeps_the_aspect_ratio(self, tmp_path: Path) -> None:
        poster = tmp_path / "poster.jpg"
        _jpeg(poster, (960, 540))

        thumb = processing.make_thumbnail(poster, output_dir=tmp_path)

        assert thumb == tmp_path / "thumb.jpg"
        with Image.open(thumb) as image:
            assert image.format == "JPEG"
            assert image.size == (480, 270)

    def test_never_upscales(self, tmp_path: Path) -> None:
        small = tmp_path / "poster.jpg"
        _jpeg(small, (100, 60))

        with Image.open(processing.make_thumbnail(small, output_dir=tmp_path)) as image:
            assert image.size == (100, 60)

    def test_an_image_with_alpha_gets_a_png(self, tmp_path: Path) -> None:
        full = tmp_path / "full.png"
        Image.new("RGBA", (800, 400), (0, 0, 255, 128)).save(full, format="PNG")

        thumb = processing.make_thumbnail(full, output_dir=tmp_path)

        assert thumb.name == "thumb.png"
        with Image.open(thumb) as image:
            assert image.mode == "RGBA"
            assert image.size == (480, 240)

    def test_unreadable_source_is_a_corrupt_error(self, tmp_path: Path) -> None:
        broken = tmp_path / "poster.jpg"
        broken.write_bytes(b"not an image")

        with pytest.raises(processing.MediaProcessingError) as exc:
            processing.make_thumbnail(broken, output_dir=tmp_path)

        assert exc.value.reason == "corrupt"


class TestBackfill:
    def _store_with_old_video(
        self, tmp_path: Path, store: LiveChatStore
    ) -> tuple[str, ProjectPaths]:
        paths = ProjectPaths(slug="test", root=tmp_path / "storage")
        att_id = "ab" + "0" * 30
        _add_attachment(
            store, att_id, kind="video", renditions=("play", "poster"), mime="video/mp4"
        )
        _send(store, "client-00000001", (att_id,), 1001.0)
        media_dir = paths.server_attachment_media_dir(att_id)
        _jpeg(media_dir / "poster.jpg", (960, 540))
        (media_dir / "play.mp4").write_bytes(b"x")
        return att_id, paths

    def test_adds_a_thumb_to_media_sent_before_video_thumbnails_existed(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        att_id, paths = self._store_with_old_video(tmp_path, store)

        made = thumbnails.backfill_thumbnails(store=store, paths=paths)

        assert made == 1
        att = store.get_attachment(att_id)
        assert att is not None
        assert att.renditions == ("play", "poster", "thumb")
        thumb = paths.server_attachment_media_dir(att_id) / "thumb.jpg"
        assert thumb.is_file()
        assert att.bytes_on_disk == 100 + thumb.stat().st_size

    def test_is_idempotent(self, tmp_path: Path, store: LiveChatStore) -> None:
        _, paths = self._store_with_old_video(tmp_path, store)
        thumbnails.backfill_thumbnails(store=store, paths=paths)

        assert thumbnails.backfill_thumbnails(store=store, paths=paths) == 0

    def test_makes_a_thumb_for_a_photo_that_lost_its_listing(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        paths = ProjectPaths(slug="test", root=tmp_path / "storage")
        att_id = "cd" + "1" * 30
        _add_attachment(store, att_id, renditions=("full",))
        _jpeg(paths.server_attachment_media_dir(att_id) / "full.jpg", (900, 600))

        assert thumbnails.backfill_thumbnails(store=store, paths=paths) == 1

        att = store.get_attachment(att_id)
        assert att is not None and att.renditions == ("full", "thumb")

    def test_a_missing_source_is_skipped_and_the_rest_still_get_theirs(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        orphan = "ef" + "2" * 30
        _add_attachment(store, orphan, kind="video", renditions=("play", "poster"))
        att_id, paths = self._store_with_old_video(tmp_path, store)

        assert thumbnails.backfill_thumbnails(store=store, paths=paths) == 1

        with_thumb = store.get_attachment(att_id)
        assert with_thumb is not None and "thumb" in with_thumb.renditions
        skipped = store.get_attachment(orphan)
        assert skipped is not None and "thumb" not in skipped.renditions

    def test_view_once_media_is_left_alone(self, tmp_path: Path, store: LiveChatStore) -> None:
        paths = ProjectPaths(slug="test", root=tmp_path / "storage")
        att_id = "01" + "3" * 30
        _add_attachment(store, att_id, renditions=("full",))
        _jpeg(paths.server_attachment_media_dir(att_id) / "full.jpg", (900, 600))
        store.create_view_once_message(
            client_id="client-00000009",
            sender="Josh",
            device_id="device-aaaaaaaa",
            by_email=None,
            attachment_id=att_id,
            duration_s=5,
            tease=False,
            now=1002.0,
        )

        assert thumbnails.backfill_thumbnails(store=store, paths=paths) == 0
        assert not (paths.server_attachment_media_dir(att_id) / "thumb.jpg").exists()

    def test_a_row_that_changed_mid_write_loses_its_orphan_file(
        self, tmp_path: Path, store: LiveChatStore
    ) -> None:
        att_id, paths = self._store_with_old_video(tmp_path, store)
        stale = store.get_attachment(att_id)
        assert stale is not None
        with store._write_txn() as conn:
            conn.execute("UPDATE attachments SET renditions = '[\"play\"]' WHERE id = ?", (att_id,))

        assert store.add_thumb_rendition(att=stale, thumb_bytes=10, now=2000.0) is False


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def pin_verifier() -> CmdPinVerifier:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    return CmdPinVerifier(
        app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=create_fake_cmd_app(state))
    )


@pytest.fixture
def wixy_repo_root(tmp_path: Path) -> Path:
    # Same minimal engine checkout the media-route tests use.
    from wixy_server.tests.test_routes_livechat_media import _git

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


def _client(
    tmp_path: Path, wixy_repo_root: Path, verifier: CmdPinVerifier
) -> tuple[TestClient, dict[str, str]]:
    app = create_app(
        storage_root=tmp_path / "storage", wixy_repo_root=wixy_repo_root, pin_verifier=verifier
    )
    client = TestClient(app)
    client.__enter__()
    token = client.post(
        "/api/admin/server/unlock",
        json={"pin": TEST_PIN},
        headers={UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE},
    ).json()["token"]
    return client, {"X-Wixy-Server-Token": token}


def _seed_photo(client: TestClient, att_id: str, *, now: float, send: str) -> None:
    app: Any = client.app
    store: LiveChatStore = app.state.livechat_store
    paths: ProjectPaths = app.state.paths
    # Seeded with the real clock so the running app's orphan sweep leaves it alone for the
    # instant before it is attached; the fixed time the assertions rely on is set afterwards.
    _add_attachment(store, att_id, now=time.time())
    media_dir = paths.server_attachment_media_dir(att_id)
    media_dir.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "blue").save(buf, format="JPEG")
    (media_dir / "full.jpg").write_bytes(buf.getvalue())
    (media_dir / "thumb.jpg").write_bytes(buf.getvalue())
    _send(store, send, (att_id,), now)
    with store._write_txn() as conn:
        conn.execute("UPDATE attachments SET created_at = ? WHERE id = ?", (now, att_id))


class TestGalleryRoute:
    def test_requires_the_unlock_token(
        self, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _ = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            assert client.get("/api/admin/server/gallery").status_code == 401
        finally:
            client.__exit__(None, None, None)

    def test_lists_signed_items_newest_first_with_a_download_link(
        self, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            _seed_photo(client, "a" * 32, now=1_700_000_000.0, send="client-00000001")
            _seed_photo(client, "b" * 32, now=1_700_000_100.0, send="client-00000002")

            body = client.get("/api/admin/server/gallery", headers=headers).json()

            assert [i["id"] for i in body["items"]] == ["b" * 32, "a" * 32]
            assert body["hasMore"] is False
            newest = body["items"][0]
            assert newest["kind"] == "photo"
            assert newest["urls"]["thumb"].startswith(f"/api/admin/server/media/{'b' * 32}/thumb?")
            assert newest["downloadUrl"].startswith(f"/api/admin/server/media/{'b' * 32}/full?")
            assert newest["downloadUrl"].endswith("&dl=1")
            assert newest["filename"] == "wixy-20231114-221500-bbbbbbbb.jpg"
            assert (newest["seq"], newest["ordinal"]) == (2, 0)
        finally:
            client.__exit__(None, None, None)

    def test_cursor_and_limit_page_the_history(
        self, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            for index, letter in enumerate("abc"):
                _seed_photo(client, letter * 32, now=1000.0 + index, send=f"client-0000000{index}")

            first = client.get("/api/admin/server/gallery?limit=2", headers=headers).json()
            last = first["items"][-1]
            second = client.get(
                f"/api/admin/server/gallery?limit=2&before={last['seq']}.{last['ordinal']}",
                headers=headers,
            ).json()

            assert first["hasMore"] is True
            assert [i["id"] for i in first["items"]] == ["c" * 32, "b" * 32]
            assert [i["id"] for i in second["items"]] == ["a" * 32]
            assert second["hasMore"] is False
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        "query", ["limit=0", "limit=201", "before=abc", "before=1", "before=1.x"]
    )
    def test_rejects_a_bad_limit_or_cursor(
        self, query: str, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            assert (
                client.get(f"/api/admin/server/gallery?{query}", headers=headers).status_code == 422
            )
        finally:
            client.__exit__(None, None, None)


class TestDownloadDisposition:
    def _url(self, client: TestClient, att_id: str, rendition: str, extra: str = "") -> str:
        app: Any = client.app
        exp = int(time.time()) + 3600
        sig = sign_media_url(
            app.state.livechat_secret, attachment_id=att_id, rendition=rendition, exp=exp, email=""
        )
        return f"/api/admin/server/media/{att_id}/{rendition}?exp={exp}&sig={sig}{extra}"

    def test_dl_1_serves_the_original_as_an_attachment_with_a_clean_name(
        self, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _ = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            _seed_photo(client, "c" * 32, now=1_700_000_000.0, send="client-00000001")

            response = client.get(self._url(client, "c" * 32, "full", "&dl=1"))

            assert response.status_code == 200
            assert (
                response.headers["content-disposition"]
                == 'attachment; filename="wixy-20231114-221320-cccccccc.jpg"'
            )
            assert response.headers["content-type"] == "image/jpeg"
        finally:
            client.__exit__(None, None, None)

    def test_without_dl_it_is_still_inline(
        self, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _ = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            _seed_photo(client, "d" * 32, now=1_700_000_000.0, send="client-00000001")

            response = client.get(self._url(client, "d" * 32, "full"))

            assert response.headers["content-disposition"] == "inline"
        finally:
            client.__exit__(None, None, None)

    def test_dl_does_not_bypass_the_signature(
        self, tmp_path: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, _ = _client(tmp_path, wixy_repo_root, pin_verifier)
        try:
            _seed_photo(client, "e" * 32, now=1_700_000_000.0, send="client-00000001")
            url = self._url(client, "e" * 32, "full", "&dl=1").replace("sig=", "sig=x")

            assert client.get(url).status_code == 403
        finally:
            client.__exit__(None, None, None)
