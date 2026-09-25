"""`/api/admin/server/messages` — round 2 ruling item 10 (spec/server-chat/
04-round2-rulings.md, ITEM 10 — REPLY TO A MESSAGE) §(3)'s wire contract: the
optional `replyToSeq` request field, its validation (an integer >= 1, booleans
rejected), and the `replyTo` member of the `Message` response shape, through a
real app."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat import media_queue as livechat_media_queue
from wixy_server.livechat.models import AttachmentResult
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"


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
    return client.post(
        "/api/admin/server/unlock",
        json={"pin": pin},
        headers={UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE},
    )


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


def _send(
    client: TestClient,
    headers: dict[str, str],
    *,
    client_id: str,
    sender: str = "Josh",
    text: str | None,
    reply_to_seq: Any = None,
) -> Any:
    body: dict[str, Any] = {
        "clientId": client_id,
        "sender": sender,
        "deviceId": "device-aaaaaaaa",
        "text": text,
    }
    if reply_to_seq is not None:
        body["replyToSeq"] = reply_to_seq
    return client.post("/api/admin/server/messages", json=body, headers=headers)


class TestReplyToSendContract:
    def test_reply_to_seq_is_accepted_and_the_response_carries_a_replyto(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            target = _send(
                client, headers, client_id="client-target-aaaa", text="original message"
            ).json()["message"]
            assert target["replyTo"] is None

            reply_response = _send(
                client,
                headers,
                client_id="client-reply-aaaa",
                sender="Purdi",
                text="a reply",
                reply_to_seq=target["seq"],
            )
            assert reply_response.status_code == 201
            reply = reply_response.json()["message"]
            assert reply["replyTo"] == {
                "seq": target["seq"],
                "sender": "Josh",
                "text": "original message",
                "truncated": False,
                "media": None,
            }
        finally:
            client.__exit__(None, None, None)

    def test_a_message_with_no_reply_to_seq_carries_a_null_replyto(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _send(client, headers, client_id="client-plain-aaaa", text="hello")
            assert response.json()["message"]["replyTo"] is None
        finally:
            client.__exit__(None, None, None)

    def test_reply_to_seq_pointing_at_an_unknown_message_sends_as_plain_never_500(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _send(
                client,
                headers,
                client_id="client-dangling-aaaa",
                text="dangling reply",
                reply_to_seq=999999,
            )
            assert response.status_code == 201
            assert response.json()["message"]["replyTo"] is None
        finally:
            client.__exit__(None, None, None)

    @pytest.mark.parametrize(
        "bad_value",
        # audit F7: 2**63 and 10**30 are the boundary/beyond-boundary cases —
        # both raised an unhandled OverflowError (500) at 369292a, since
        # SQLite's INTEGER column tops out at 2**63-1 and nothing here checked
        # an upper bound, only isinstance/positivity.
        [True, False, 0, -1, 1.5, "1", [1], {"seq": 1}, 2**63, 10**30],
    )
    def test_reply_to_seq_rejects_anything_that_is_not_a_positive_int(
        self,
        bad_value: Any,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _send(
                client,
                headers,
                client_id="client-bad-reply-aaaa",
                text="x",
                reply_to_seq=bad_value,
            )
            assert response.status_code == 422
        finally:
            client.__exit__(None, None, None)

    def test_reply_to_seq_at_the_sqlite_integer_ceiling_is_accepted_not_a_500(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """Audit F7's other boundary: 2**63-1 is the largest value SQLite's INTEGER
        column can hold. It's a dangling target (never a real message seq), so this
        sends as plain (201, replyTo null) rather than 422 — proving the fix's upper
        bound is exactly at, not before, the true ceiling."""
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            response = _send(
                client,
                headers,
                client_id="client-ceiling-reply",
                text="at the ceiling",
                reply_to_seq=2**63 - 1,
            )
            assert response.status_code == 201
            assert response.json()["message"]["replyTo"] is None
        finally:
            client.__exit__(None, None, None)

    def test_reply_to_seq_one_is_accepted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            target = _send(client, headers, client_id="client-seq1-target", text="first").json()[
                "message"
            ]
            assert target["seq"] == 1
            response = _send(
                client,
                headers,
                client_id="client-seq1-reply",
                text="reply to the first ever message",
                reply_to_seq=1,
            )
            assert response.status_code == 201
            assert response.json()["message"]["replyTo"]["seq"] == 1
        finally:
            client.__exit__(None, None, None)

    def test_replaying_the_same_client_id_keeps_the_original_reply_to(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            target = _send(client, headers, client_id="client-replay-target", text="target").json()[
                "message"
            ]
            body = {
                "clientId": "client-replay-reply",
                "sender": "Purdi",
                "deviceId": "device-aaaaaaaa",
                "text": "reply",
                "replyToSeq": target["seq"],
            }
            first = client.post("/api/admin/server/messages", json=body, headers=headers)
            second = client.post("/api/admin/server/messages", json=body, headers=headers)
            assert first.status_code == 201
            assert second.status_code == 200
            assert first.json()["message"]["replyTo"] == second.json()["message"]["replyTo"]
        finally:
            client.__exit__(None, None, None)

    def test_history_carries_replyto_for_every_message(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            target = _send(
                client, headers, client_id="client-history-target", text="original"
            ).json()["message"]
            _send(
                client,
                headers,
                client_id="client-history-reply",
                sender="Purdi",
                text="quoting it",
                reply_to_seq=target["seq"],
            )
            history = client.get("/api/admin/server/messages", headers=headers).json()
            by_client_id = {m["clientId"]: m for m in history["messages"]}
            assert by_client_id["client-history-target"]["replyTo"] is None
            assert by_client_id["client-history-reply"]["replyTo"]["seq"] == target["seq"]
        finally:
            client.__exit__(None, None, None)


class TestReplyToSurvivesTargetDeletion:
    def test_deleting_the_target_leaves_the_reply_with_a_null_replyto(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            target = _send(client, headers, client_id="client-delete-target", text="doomed").json()[
                "message"
            ]
            reply = _send(
                client,
                headers,
                client_id="client-delete-reply",
                sender="Purdi",
                text="quoting the doomed one",
                reply_to_seq=target["seq"],
            ).json()["message"]

            delete_response = client.delete(
                f"/api/admin/server/messages/{target['seq']}", headers=headers
            )
            assert delete_response.status_code in (204, 202)

            history = client.get("/api/admin/server/messages", headers=headers).json()
            by_seq = {m["seq"]: m for m in history["messages"]}
            assert target["seq"] not in by_seq
            assert by_seq[reply["seq"]]["replyTo"] is None
            assert by_seq[reply["seq"]]["text"] == "quoting the doomed one"
        finally:
            client.__exit__(None, None, None)


class TestQuoteFreshnessThroughTheStore:
    """§(3)'s cascade is exercised end-to-end at the store the app actually
    uses, mirroring what the SSE loop reads from — the full SSE framing is
    already covered by `test_routes_livechat.py::TestStreamEvents`."""

    def test_finishing_an_attachment_reaches_a_reply_through_the_apps_own_store(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # The real app's own background media queue would otherwise race this
        # test's manual claim_processing/finish_attachment against a
        # nonexistent staged upload file — disable it; this test drives the
        # store directly, on purpose.
        monkeypatch.setattr(livechat_media_queue, "resolve_binaries", lambda *_args: None)
        client, headers = _unlocked_client(storage_root, wixy_repo_root, pin_verifier)
        try:
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            attachment = store.create_attachment(att_id="c" * 32, kind="photo", now=1.0)
            target, _ = store.create_message(
                client_id="client-store-target",
                sender="Josh",
                device_id="device-1",
                by_email=None,
                text=None,
                attachment_ids=(attachment.id,),
                now=2.0,
            )
            reply, _ = store.create_message(
                client_id="client-store-reply",
                sender="Purdi",
                device_id="device-2",
                by_email=None,
                text="quoting the photo",
                attachment_ids=(),
                reply_to_seq=target.seq,
                now=3.0,
            )
            cursor_before = max(e.event_seq for e in store.events_after(0))
            store.claim_processing(owner="w1", now=4.0, lease_s=60.0)
            store.finish_attachment(
                att_id=attachment.id,
                owner="w1",
                result=AttachmentResult(
                    status="ready",
                    mime="image/jpeg",
                    width=10,
                    height=10,
                    duration_s=None,
                    peaks=None,
                    renditions=("full", "thumb"),
                    bytes_on_disk=100,
                    failure=None,
                ),
                now=5.0,
            )
            updated = {
                e.message_seq
                for e in store.events_after(cursor_before)
                if e.type == "message_updated"
            }
            assert updated == {target.seq, reply.seq}

            history = client.get("/api/admin/server/messages", headers=headers).json()
            by_seq = {m["seq"]: m for m in history["messages"]}
            assert by_seq[reply.seq]["replyTo"]["media"]["thumbUrl"] is not None
        finally:
            client.__exit__(None, None, None)
