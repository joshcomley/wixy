"""`/api/admin/server/{uploads,media}/*` (spec/server-chat/00-brief.md §5.5/§5.6,
P2b) — the full upload flow through a real app, quota/type/size rejections,
and the signed media route's signature/expiry/email-binding + Range/nosniff.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat import uploads as uploads_module
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import sign_media_url
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"
_SMALL_CHUNK_BYTES = "65536"  # matches the E2E fixture's own override (§11)


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.fixture
def origin_repo(tmp_path: Path) -> Path:
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    return origin


@pytest.fixture
def wixy_repo_root(tmp_path: Path, origin_repo: Path) -> Path:
    root = tmp_path / "wixy-repo"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "test.json").write_text(
        json.dumps(
            {
                "slug": "test",
                "name": "test",
                "repo": str(origin_repo),
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


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")
    monkeypatch.setenv("WIXY_SERVER_UPLOAD_CHUNK_BYTES", _SMALL_CHUNK_BYTES)


@pytest.fixture
def fake_cmd_state() -> FakeCmdState:
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN, lockout_after=5, lockout_seconds=60.0)
    return state


@pytest.fixture
def pin_verifier(fake_cmd_state: FakeCmdState) -> CmdPinVerifier:
    fake_app = create_fake_cmd_app(fake_cmd_state)
    return CmdPinVerifier(app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app))


def _unlock(client: TestClient, *, pin: str = TEST_PIN) -> Any:
    return client.post("/api/admin/server/unlock", json={"pin": pin})


def _unlocked_client(
    storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
) -> tuple[TestClient, dict[str, str]]:
    app = create_app(
        storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
    )
    client = TestClient(app)
    client.__enter__()
    token = _unlock(client).json()["token"]
    return client, {"X-Wixy-Server-Token": token}


def _init_upload(
    client: TestClient,
    headers: dict[str, str],
    *,
    kind: str = "photo",
    mime_type: str = "image/jpeg",
    size_bytes: int,
    filename: str | None = "a.jpg",
) -> Any:
    return client.post(
        "/api/admin/server/uploads",
        json={"kind": kind, "mimeType": mime_type, "sizeBytes": size_bytes, "filename": filename},
        headers=headers,
    )


class TestUploadInit:
    def test_returns_upload_id_and_the_configured_chunk_size(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _init_upload(client, headers, size_bytes=1000)
            assert response.status_code == 201
            body = response.json()
            assert body["chunkBytes"] == int(_SMALL_CHUNK_BYTES)
            assert body["maxBytes"] == 30 * 1024 * 1024
            assert len(body["uploadId"]) == 32
        finally:
            client.__exit__(None, None, None)

    def test_unsupported_declared_type_is_415(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _init_upload(client, headers, mime_type="application/pdf", size_bytes=1000)
            assert response.status_code == 415
            assert response.json()["error"] == "unsupported_type"
        finally:
            client.__exit__(None, None, None)

    def test_oversized_declared_size_is_413(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _init_upload(client, headers, size_bytes=31 * 1024 * 1024)
            assert response.status_code == 413
            assert response.json() == {"error": "too_large", "maxBytes": 30 * 1024 * 1024}
        finally:
            client.__exit__(None, None, None)

    def test_quota_exceeded_is_507(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_SERVER_MEDIA_QUOTA_MB", "1")  # 1 MiB quota
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _init_upload(client, headers, size_bytes=2 * 1024 * 1024)
            assert response.status_code == 507
            assert response.json() == {"error": "storage_full"}
        finally:
            client.__exit__(None, None, None)

    def test_media_unavailable_is_503(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_FFMPEG", str(storage_root / "no-such-ffmpeg.exe"))
        monkeypatch.setenv("WIXY_FFPROBE", str(storage_root / "no-such-ffprobe.exe"))
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _init_upload(client, headers, size_bytes=1000)
            assert response.status_code == 503
            assert response.json() == {"error": "media_unavailable"}
        finally:
            client.__exit__(None, None, None)

    def test_without_a_token_is_401_locked(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        app = create_app(
            storage_root=storage_root, wixy_repo_root=wixy_repo_root, pin_verifier=pin_verifier
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/admin/server/uploads",
                json={
                    "kind": "photo",
                    "mimeType": "image/jpeg",
                    "sizeBytes": 100,
                    "filename": None,
                },
            )
        assert response.status_code == 401
        assert response.json()["error"] == "locked"


class TestChunkPut:
    def test_chunk_exceeding_the_cap_is_413(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            size = int(_SMALL_CHUNK_BYTES) + 1
            upload_id = _init_upload(client, headers, size_bytes=size).json()["uploadId"]
            response = client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=b"x" * size,
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            assert response.status_code == 413
            assert response.json() == {"error": "too_large", "maxBytes": int(_SMALL_CHUNK_BYTES)}
        finally:
            client.__exit__(None, None, None)

    def test_out_of_range_index_is_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            upload_id = _init_upload(client, headers, size_bytes=10).json()["uploadId"]
            response = client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/5",
                content=b"x" * 10,
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            assert response.status_code == 422
        finally:
            client.__exit__(None, None, None)

    def test_unknown_upload_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.put(
                "/api/admin/server/uploads/" + "0" * 32 + "/chunks/0",
                content=b"x",
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)

    def test_re_putting_the_same_index_overwrites(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            upload_id = _init_upload(client, headers, size_bytes=5).json()["uploadId"]
            first = client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=b"aaaaa",
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            second = client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=b"bbbbb",
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            assert first.status_code == 204
            assert second.status_code == 204
        finally:
            client.__exit__(None, None, None)

    def test_chunk_started_before_wipe_cleans_its_late_directory_and_returns_404(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        app = cast(FastAPI, client.app)
        store: LiveChatStore = app.state.livechat_store
        paths = app.state.paths
        upload_id = _init_upload(client, headers, size_bytes=3).json()["uploadId"]
        write_chunk = uploads_module.write_chunk

        def _write_then_wipe(upload_dir: Path, index: int, data: bytes) -> None:
            write_chunk(upload_dir, index, data)
            store.wipe(now=time.time())

        monkeypatch.setattr(uploads_module, "write_chunk", _write_then_wipe)
        try:
            response = client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=b"abc",
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            assert response.status_code == 404
            assert store.get_upload(upload_id) is None
            assert not paths.server_upload_dir(upload_id).exists()
        finally:
            client.__exit__(None, None, None)


class TestComplete:
    def test_upload_deleted_during_assembly_is_not_promoted_after_wipe(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        app = cast(FastAPI, client.app)
        store: LiveChatStore = app.state.livechat_store
        paths = app.state.paths
        data = b"abc"
        upload_id = _init_upload(client, headers, size_bytes=len(data)).json()["uploadId"]
        assert (
            client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=data,
                headers={**headers, "Content-Type": "application/octet-stream"},
            ).status_code
            == 204
        )
        promote = store.create_attachment_from_upload

        def _wipe_before_promotion(**kwargs: Any) -> Any:
            store.wipe(now=time.time())
            return promote(**kwargs)

        monkeypatch.setattr(store, "create_attachment_from_upload", _wipe_before_promotion)
        try:
            response = client.post(
                f"/api/admin/server/uploads/{upload_id}/complete", headers=headers
            )
            assert response.status_code == 404
            assert store.get_upload(upload_id) is None
            assert store.get_attachment(upload_id) is None
            assert not paths.server_upload_dir(upload_id).exists()
        finally:
            client.__exit__(None, None, None)

    def test_full_flow_succeeds_with_a_processing_attachment(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            data = b"\xff\xd8\xff" + b"0" * 97  # not a decodable jpeg, but that's P2a's job
            upload_id = _init_upload(client, headers, size_bytes=len(data)).json()["uploadId"]
            put = client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=data,
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            assert put.status_code == 204
            complete = client.post(
                f"/api/admin/server/uploads/{upload_id}/complete", headers=headers
            )
            assert complete.status_code == 202
            assert complete.json()["attachment"]["status"] == "processing"
            assert complete.json()["attachment"]["id"] == upload_id
        finally:
            client.__exit__(None, None, None)

    def test_missing_chunks_is_409(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            size = int(_SMALL_CHUNK_BYTES) * 2 + 10
            upload_id = _init_upload(client, headers, size_bytes=size).json()["uploadId"]
            # Only chunk 0 of the 3 required chunks is ever PUT.
            client.put(
                f"/api/admin/server/uploads/{upload_id}/chunks/0",
                content=b"x" * int(_SMALL_CHUNK_BYTES),
                headers={**headers, "Content-Type": "application/octet-stream"},
            )
            response = client.post(
                f"/api/admin/server/uploads/{upload_id}/complete", headers=headers
            )
            assert response.status_code == 409
            assert response.json()["error"] == "incomplete"
            assert response.json()["missing"] == [1, 2]
        finally:
            client.__exit__(None, None, None)

    def test_unknown_upload_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.post(
                "/api/admin/server/uploads/" + "0" * 32 + "/complete", headers=headers
            )
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)


class TestDeleteUpload:
    def test_deletes_a_pending_upload(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            upload_id = _init_upload(client, headers, size_bytes=10).json()["uploadId"]
            response = client.delete(f"/api/admin/server/uploads/{upload_id}", headers=headers)
            assert response.status_code == 204
            # A now-unknown upload's complete correctly reports 404.
            complete = client.post(
                f"/api/admin/server/uploads/{upload_id}/complete", headers=headers
            )
            assert complete.status_code == 404
        finally:
            client.__exit__(None, None, None)


class TestMediaRoute:
    def _ready_attachment(self, client: TestClient, headers: dict[str, str]) -> tuple[str, bytes]:
        """Runs a real (small) JPEG through the full upload flow and waits for
        the background queue to resolve it to `ready`, returning its id and a
        signed `full` rendition URL's query params source (the secret)."""
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (20, 10), "blue").save(buf, format="JPEG")
        data = buf.getvalue()

        upload_id = _init_upload(client, headers, size_bytes=len(data)).json()["uploadId"]
        client.put(
            f"/api/admin/server/uploads/{upload_id}/chunks/0",
            content=data,
            headers={**headers, "Content-Type": "application/octet-stream"},
        )
        complete = client.post(f"/api/admin/server/uploads/{upload_id}/complete", headers=headers)
        assert complete.status_code == 202

        store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            row = store.get_attachment(upload_id)
            if row is not None and row.status == "ready":
                return upload_id, client.app.state.livechat_secret  # type: ignore[attr-defined]
            time.sleep(0.02)
        raise AssertionError("attachment never reached ready within 5s")

    def test_valid_signature_returns_the_rendition_with_correct_headers(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, secret = self._ready_attachment(client, headers)
            exp = int(time.time()) + 3600
            sig = sign_media_url(secret, attachment_id=att_id, rendition="full", exp=exp, email="")
            response = client.get(f"/api/admin/server/media/{att_id}/full?exp={exp}&sig={sig}")
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, no-cache"
            assert response.headers["x-content-type-options"] == "nosniff"
            assert response.headers["content-disposition"] == "inline"
            assert response.headers["content-type"] == "image/jpeg"
        finally:
            client.__exit__(None, None, None)

    def test_range_request_returns_206(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, secret = self._ready_attachment(client, headers)
            exp = int(time.time()) + 3600
            sig = sign_media_url(secret, attachment_id=att_id, rendition="full", exp=exp, email="")
            response = client.get(
                f"/api/admin/server/media/{att_id}/full?exp={exp}&sig={sig}",
                headers={"Range": "bytes=0-3"},
            )
            assert response.status_code == 206
            assert len(response.content) == 4
        finally:
            client.__exit__(None, None, None)

    def test_tampered_signature_is_403(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, _secret = self._ready_attachment(client, headers)
            exp = int(time.time()) + 3600
            response = client.get(f"/api/admin/server/media/{att_id}/full?exp={exp}&sig=deadbeef")
            assert response.status_code == 403
        finally:
            client.__exit__(None, None, None)

    def test_expired_signature_is_403(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, secret = self._ready_attachment(client, headers)
            exp = int(time.time()) - 10  # already expired
            sig = sign_media_url(secret, attachment_id=att_id, rendition="full", exp=exp, email="")
            response = client.get(f"/api/admin/server/media/{att_id}/full?exp={exp}&sig={sig}")
            assert response.status_code == 403
        finally:
            client.__exit__(None, None, None)

    def test_email_mismatch_is_403(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, secret = self._ready_attachment(client, headers)
            exp = int(time.time()) + 3600
            # Signed for a DIFFERENT email than the (dev-no-auth) request's own "".
            sig = sign_media_url(
                secret, attachment_id=att_id, rendition="full", exp=exp, email="someone@else.com"
            )
            response = client.get(f"/api/admin/server/media/{att_id}/full?exp={exp}&sig={sig}")
            assert response.status_code == 403
        finally:
            client.__exit__(None, None, None)

    def test_malformed_attachment_id_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        # A single-segment non-hex id, so it actually reaches this route's own
        # `_ATTACHMENT_ID_RE` check — a `../`-laden value wouldn't even match
        # the single-segment `{att_id}` path parameter in the first place
        # (Starlette's routing rejects it before this handler ever runs, which
        # is its own, separate layer of path-traversal defense).
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = client.get(
                "/api/admin/server/media/not-a-valid-attachment-id/full?exp=9999999999&sig=x"
            )
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)

    def test_unknown_rendition_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, secret = self._ready_attachment(client, headers)
            exp = int(time.time()) + 3600
            sig = sign_media_url(
                secret, attachment_id=att_id, rendition="nonsense", exp=exp, email=""
            )
            response = client.get(f"/api/admin/server/media/{att_id}/nonsense?exp={exp}&sig={sig}")
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)

    def test_missing_rendition_file_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            att_id, secret = self._ready_attachment(client, headers)
            exp = int(time.time()) + 3600
            # "poster" is a valid rendition NAME, but this photo never has one.
            sig = sign_media_url(
                secret, attachment_id=att_id, rendition="poster", exp=exp, email=""
            )
            response = client.get(f"/api/admin/server/media/{att_id}/poster?exp={exp}&sig={sig}")
            assert response.status_code == 404
        finally:
            client.__exit__(None, None, None)
