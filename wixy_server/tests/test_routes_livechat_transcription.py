"""`POST /api/admin/server/attachments/{id}/transcribe` and everything around it
(spec/server-chat/05-voice-transcription.md) against a fake cmd that implements the private-mode
contract: the asynchronous 202 -> job -> `message_updated` flow, "nothing is ever sent to a cmd
that cannot promise private mode", single-flight / one-at-a-time / 6-a-minute limits, erasure
with the message (raw database bytes), startup recovery and that no transcript text is logged.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import subprocess
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat.models import AttachmentResult
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.processing import VOICE_DURATION_CAP_S
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import (
    UNLOCK_GUARD_HEADER,
    UNLOCK_GUARD_VALUE,
    ServerAuth,
)
from wixy_server.livechat.transcribe import CmdTranscriber
from wixy_server.routes_livechat import _stream_events
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"
AUDIO = b"FAKE-M4A-AUDIO-BYTES"
SENTINEL = "transcript-sentinel-7b3d51e2"
TRANSCRIBE = "/api/admin/server/attachments/{}/transcribe"


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


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


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    return tmp_path / "storage"


@pytest.fixture(autouse=True)
def _dev_no_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")


@pytest.fixture
def cmd_state() -> FakeCmdState:
    state = FakeCmdState(transcribe_text=SENTINEL)
    state.register_pin_app(TEST_APP_KEY, TEST_PIN)
    return state


@dataclass
class Env:
    app: Any
    state: FakeCmdState
    store: LiveChatStore

    @property
    def paths(self) -> Any:
        return self.app.state.paths


@pytest.fixture
def make_env(
    storage_root: Path, wixy_repo_root: Path, cmd_state: FakeCmdState
) -> Callable[..., Env]:
    def build(**overrides: Any) -> Env:
        fake_app = create_fake_cmd_app(cmd_state)
        kwargs: dict[str, Any] = {
            "storage_root": storage_root,
            "wixy_repo_root": wixy_repo_root,
            "pin_verifier": CmdPinVerifier(
                app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app)
            ),
            "transcriber": CmdTranscriber(transport=httpx.ASGITransport(app=fake_app)),
        }
        kwargs.update(overrides)
        app = create_app(**kwargs)
        return Env(app=app, state=cmd_state, store=app.state.livechat_store)

    return build


@dataclass(frozen=True)
class Voice:
    att_id: str
    seq: int | None


def _seed_voice(
    env: Env,
    *,
    duration_s: float = 3.0,
    ready: bool = True,
    send: bool = True,
    kind: str = "voice",
    audio: bytes | None = AUDIO,
) -> Voice:
    """A voice (or other) attachment, optionally ready and sent. Real-clock stamps: the app's
    janitor reaps anything older than a day (decisions/00157)."""
    att_id = uuid.uuid4().hex
    now = time.time()
    env.store.create_attachment(att_id=att_id, kind=kind, now=now)  # type: ignore[arg-type]
    if ready:
        env.store.claim_processing(owner="seed", now=now, lease_s=60.0)
        env.store.finish_attachment(
            att_id=att_id,
            owner="seed",
            result=AttachmentResult(
                status="ready",
                mime="audio/mp4",
                width=None,
                height=None,
                duration_s=duration_s,
                peaks=(0.1, 0.5),
                renditions=("play",),
                bytes_on_disk=len(audio or b""),
                failure=None,
            ),
            now=now,
        )
    if audio is not None:
        media_dir = env.paths.server_attachment_media_dir(att_id)
        media_dir.mkdir(parents=True, exist_ok=True)
        (media_dir / "play.m4a").write_bytes(audio)
    seq: int | None = None
    if send:
        message, _ = env.store.create_message(
            client_id=f"client-{att_id[:12]}",
            sender="Purdy",
            device_id="device-test-1",
            by_email=None,
            text=None,
            attachment_ids=(att_id,),
            now=now + 0.001,
        )
        seq = message.seq
    return Voice(att_id, seq)


def _unlock(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/admin/server/unlock",
        json={"pin": TEST_PIN},
        headers={UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE},
    )
    assert response.status_code == 200, response.text
    return {"X-Wixy-Server-Token": response.json()["token"]}


def _wait_for(predicate: Callable[[], bool], *, timeout_s: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("timed out waiting for the condition")


def _finished(env: Env, att_id: str) -> Callable[[], bool]:
    def check() -> bool:
        row = env.store.get_transcript(att_id)
        return row is not None and row.status != "pending"

    return check


def _raw_db(store: LiveChatStore) -> bytes:
    db = store._db_path
    wal = Path(f"{db}-wal")
    return db.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


def _message_attachment(client: TestClient, headers: dict[str, str], att_id: str) -> Any:
    body = client.get("/api/admin/server/messages", headers=headers).json()
    for message in body["messages"]:
        for attachment in message["attachments"]:
            if attachment["id"] == att_id:
                return attachment
    raise AssertionError(f"attachment {att_id} not in history")


class TestTranscribeFlow:
    def test_accepts_asynchronously_then_stores_and_serves_the_transcript(
        self, make_env: Callable[..., Env], caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.DEBUG)
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert _message_attachment(client, headers, voice.att_id)["transcript"] is None

            response = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            assert response.status_code == 202
            assert response.json() == {"transcript": {"status": "pending"}}
            _wait_for(_finished(env, voice.att_id))

            attachment = _message_attachment(client, headers, voice.att_id)
            assert attachment["transcript"] == {"status": "done", "text": SENTINEL}

            # A stored transcript is served straight back: 200, and cmd is not asked again.
            again = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            assert again.status_code == 200
            assert again.json() == {"transcript": {"status": "done", "text": SENTINEL}}

        [request] = env.state.transcribe_requests
        assert request.fields == {"private": "1", "cleanup": "0"}
        assert request.audio == AUDIO
        assert request.filename == "play.m4a"
        assert request.content_type == "audio/mp4"
        assert env.state.transcribe_retained == []
        assert SENTINEL not in caplog.text
        row = env.store.get_transcript(voice.att_id)
        assert row is not None and row.engine == "parakeet"

    def test_both_devices_are_told_pending_then_done_through_events(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        voice = _seed_voice(env)
        assert voice.seq is not None
        cursor = env.store.events_after(0)[-1].event_seq
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
        events = env.store.events_after(cursor)
        assert [(e.type, e.message_seq) for e in events] == [
            ("message_updated", voice.seq),
            ("message_updated", voice.seq),
        ]

    @pytest.mark.asyncio
    async def test_the_stream_carries_the_transcript_in_the_attachment(
        self, tmp_path: Path
    ) -> None:
        store = LiveChatStore(tmp_path / "server.db")
        now = time.time()
        store.create_attachment(att_id="voice-stream", kind="voice", now=now)
        store.claim_processing(owner="w", now=now, lease_s=60.0)
        store.finish_attachment(
            att_id="voice-stream",
            owner="w",
            result=AttachmentResult(
                "ready", "audio/mp4", None, None, 2.0, (0.2,), ("play",), 1, None
            ),
            now=now,
        )
        message, _ = store.create_message(
            client_id="client-stream-1",
            sender="Josh",
            device_id="device-stream-1",
            by_email=None,
            text=None,
            attachment_ids=("voice-stream",),
            now=now,
        )
        cursor = store.events_after(0)[-1].event_seq
        store.begin_transcript(att_id="voice-stream", now=now)
        store.finish_transcript(
            att_id="voice-stream",
            status="done",
            text="streamed",
            failure=None,
            engine=None,
            now=now,
        )

        gen = _stream_events(
            store, LiveChatNotifier(), b"s" * 32, ServerAuth("", int(now) + 600), cursor
        )
        try:
            chunk = await anext(gen)
        finally:
            await gen.aclose()
        data = json.loads(chunk.split("data: ", 1)[1])
        assert chunk.startswith("id: ") and "event: message_updated" in chunk
        assert data["seq"] == message.seq
        assert data["attachments"][0]["transcript"] == {"status": "done", "text": "streamed"}

    def test_a_failure_is_recorded_without_text_and_retry_runs_again(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        env = make_env()
        voice = _seed_voice(env)
        cmd_state.transcribe_status_code = 502
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
            _wait_for(_finished(env, voice.att_id))
            failed = _message_attachment(client, headers, voice.att_id)["transcript"]
            assert failed == {"status": "failed"}
            row = env.store.get_transcript(voice.att_id)
            assert row is not None and row.failure == "unavailable"

            cmd_state.transcribe_status_code = 200
            retry = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            assert retry.status_code == 202
            _wait_for(_finished(env, voice.att_id))
            done = _message_attachment(client, headers, voice.att_id)["transcript"]
            assert done == {"status": "done", "text": SENTINEL}
        assert len(cmd_state.transcribe_requests) == 2

    def test_an_empty_transcript_is_done_not_failed(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        cmd_state.transcribe_text = ""
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
            assert _message_attachment(client, headers, voice.att_id)["transcript"] == {
                "status": "done",
                "text": "",
            }

    def test_the_timeout_scales_with_the_note_length(
        self, make_env: Callable[..., Env], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[float] = []
        real = CmdTranscriber.transcribe

        async def spy(self: CmdTranscriber, **kwargs: Any) -> Any:
            seen.append(kwargs["timeout_s"])
            return await real(self, **kwargs)

        monkeypatch.setattr(CmdTranscriber, "transcribe", spy)
        env = make_env()
        voice = _seed_voice(env, duration_s=600.0)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
        assert seen == [60.0 + 0.5 * 600.0]

    def test_a_missing_audio_file_fails_the_job(self, make_env: Callable[..., Env]) -> None:
        env = make_env()
        voice = _seed_voice(env, audio=None)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
        row = env.store.get_transcript(voice.att_id)
        assert row is not None and (row.status, row.failure) == ("failed", "media_missing")
        assert env.state.transcribe_requests == []


class TestPrivateModeGate:
    @pytest.mark.parametrize("why", ["not-private", "no-probe-route", "unreachable"])
    def test_nothing_is_sent_to_a_cmd_that_cannot_promise_private_mode(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState, why: str
    ) -> None:
        overrides: dict[str, Any] = {}
        if why == "not-private":
            cmd_state.transcribe_private_supported = False
        elif why == "no-probe-route":
            cmd_state.transcribe_capabilities_status = 404
        else:

            def refuse(request: httpx.Request) -> httpx.Response:
                raise httpx.ConnectError("refused", request=request)

            overrides["transcriber"] = CmdTranscriber(transport=httpx.MockTransport(refuse))
        env = make_env(**overrides)
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            response = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            assert response.status_code == 503
            assert response.json() == {"error": "not_configured"}
            assert (
                client.get("/api/admin/server/usage", headers=headers).json()[
                    "transcriptionAvailable"
                ]
                is False
            )
        assert env.store.get_transcript(voice.att_id) is None
        assert cmd_state.transcribe_requests == []
        assert cmd_state.transcribe_retained == []

    def test_the_standalone_edition_is_always_unavailable(
        self, make_env: Callable[..., Env], monkeypatch: pytest.MonkeyPatch, cmd_state: FakeCmdState
    ) -> None:
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        fake_app = create_fake_cmd_app(cmd_state)
        env = make_env(
            pin_verifier=CmdPinVerifier(
                app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app)
            ),
            transcriber=None,
        )
        assert env.app.state.livechat_transcription.transcriber is None
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 503
            usage = client.get("/api/admin/server/usage", headers=headers).json()
            assert usage["transcriptionAvailable"] is False
        assert cmd_state.transcribe_requests == []

    def test_usage_reports_availability_when_cmd_promises_private_mode(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        with TestClient(env.app) as client:
            headers = _unlock(client)
            usage = client.get("/api/admin/server/usage", headers=headers).json()
        assert usage["transcriptionAvailable"] is True

    def test_a_stored_transcript_is_readable_even_when_cmd_later_goes_away(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
            cmd_state.transcribe_private_supported = False
            cmd_state.transcribe_capabilities_status = 500
            env.app.state.livechat_transcription.transcriber.invalidate_probe()
            again = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
        assert again.status_code == 200
        assert again.json()["transcript"]["text"] == SENTINEL

    def test_the_probe_is_rechecked_right_before_audio_leaves(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        """cmd promised private mode when the request was ACCEPTED but not any more by the time
        the job runs: the audio must not be sent, and the job fails. A second note is parked
        behind a gated first one (one job at a time), so the flip lands between its acceptance
        and its start."""
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        first, second = _seed_voice(env), _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert client.post(TRANSCRIBE.format(first.att_id), headers=headers).status_code == 202
            _wait_for(lambda: len(cmd_state.transcribe_requests) == 1)
            assert client.post(TRANSCRIBE.format(second.att_id), headers=headers).status_code == 202

            # A rollback of cmd to a retaining build, INSIDE the 60 s probe-cache window: the
            # cached answer is still `true`, so only a fresh probe at send time can catch it.
            cmd_state.transcribe_private_supported = False
            gate.set()
            _wait_for(_finished(env, first.att_id))
            _wait_for(_finished(env, second.att_id))

        assert len(cmd_state.transcribe_requests) == 1  # only the first ever left
        assert cmd_state.transcribe_retained == []
        row = env.store.get_transcript(second.att_id)
        assert row is not None and (row.status, row.failure) == ("failed", "unavailable")

    def test_a_note_longer_than_the_voice_cap_is_refused_without_sending_it(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        voice = _seed_voice(env, duration_s=VOICE_DURATION_CAP_S + 60.0)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
        row = env.store.get_transcript(voice.att_id)
        assert row is not None and (row.status, row.failure) == ("failed", "too_long")
        assert env.state.transcribe_requests == []

    @pytest.mark.parametrize(
        ("status", "error", "failure"),
        [
            (503, "asr_warming", "warming"),
            (503, "boom", "unavailable"),
            (500, "boom", "unavailable"),
            (400, "empty audio", "rejected"),
            (413, "audio too large", "rejected"),
        ],
    )
    def test_cmd_failures_are_recorded_with_a_code_and_no_detail_on_the_wire(
        self,
        make_env: Callable[..., Env],
        cmd_state: FakeCmdState,
        status: int,
        error: str,
        failure: str,
    ) -> None:
        cmd_state.transcribe_status_code = status
        cmd_state.transcribe_error = error
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(_finished(env, voice.att_id))
            wire = _message_attachment(client, headers, voice.att_id)["transcript"]
        row = env.store.get_transcript(voice.att_id)
        assert row is not None and (row.status, row.failure) == ("failed", failure)
        assert wire == {"status": "failed"}


class TestValidation:
    def test_requires_the_unlock_token(self, make_env: Callable[..., Env]) -> None:
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            response = client.post(TRANSCRIBE.format(voice.att_id))
            assert response.status_code == 401
            assert response.json() == {"error": "locked"}
        assert env.state.transcribe_requests == []

    @pytest.mark.parametrize("case", ["malformed-id", "unknown", "photo", "video", "unsent"])
    def test_only_a_sent_voice_note_is_found(self, make_env: Callable[..., Env], case: str) -> None:
        env = make_env()
        if case == "malformed-id":
            att_id = "not-a-32-hex-id"
        elif case == "unknown":
            att_id = uuid.uuid4().hex
        elif case == "unsent":
            att_id = _seed_voice(env, send=False).att_id
        else:
            att_id = _seed_voice(env, kind=case).att_id
        with TestClient(env.app) as client:
            headers = _unlock(client)
            response = client.post(TRANSCRIBE.format(att_id), headers=headers)
        assert response.status_code == 404
        assert response.json() == {"error": "not_found"}
        assert env.state.transcribe_requests == []

    def test_a_note_still_processing_is_not_ready(self, make_env: Callable[..., Env]) -> None:
        env = make_env()
        voice = _seed_voice(env, ready=False)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            response = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
        assert response.status_code == 409
        assert response.json() == {"error": "not_ready"}
        assert env.store.get_transcript(voice.att_id) is None


class TestLimits:
    def test_single_flight_per_note(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            first = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            _wait_for(lambda: len(cmd_state.transcribe_requests) == 1)
            second = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            third = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            assert [first.status_code, second.status_code, third.status_code] == [202, 202, 202]
            assert second.json() == {"transcript": {"status": "pending"}}
            gate.set()
            _wait_for(_finished(env, voice.att_id))
        assert len(cmd_state.transcribe_requests) == 1

    def test_two_simultaneous_requests_start_one_job(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        """The note is claimed before anything is awaited, so racing requests (two devices, a
        double tap) cannot both start a job."""
        import threading
        from concurrent.futures import ThreadPoolExecutor

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            barrier = threading.Barrier(6)

            def post() -> int:
                barrier.wait()
                return int(
                    client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code
                )

            with ThreadPoolExecutor(max_workers=6) as pool:
                codes = list(pool.map(lambda _i: post(), range(6)))
            assert codes == [202] * 6
            _wait_for(lambda: len(cmd_state.transcribe_requests) >= 1)
            time.sleep(0.3)
            gate.set()
            _wait_for(_finished(env, voice.att_id))
        assert len(cmd_state.transcribe_requests) == 1

    def test_a_pending_row_with_no_job_behind_it_is_restarted_not_left_spinning(
        self, make_env: Callable[..., Env]
    ) -> None:
        """If a job's outcome could not be recorded (a locked database) the row is `pending`
        with nothing running. The next request must start over rather than answer 202 forever."""
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            begun = env.store.begin_transcript(att_id=voice.att_id, now=time.time())
            assert begun.state == "started"  # a row, but no job in this process
            assert env.app.state.livechat_transcription.inflight == set()

            response = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            assert response.status_code == 202
            _wait_for(_finished(env, voice.att_id))
            assert _message_attachment(client, headers, voice.att_id)["transcript"] == {
                "status": "done",
                "text": SENTINEL,
            }
        assert len(env.state.transcribe_requests) == 1

    def test_a_failed_spawn_releases_the_claim(
        self, make_env: Callable[..., Env], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app, raise_server_exceptions=False) as client:
            headers = _unlock(client)
            background = env.app.state.background_tasks
            real_spawn = background.spawn
            calls = {"n": 0}

            def failing_spawn(name: str, fn: Any, *args: Any) -> None:
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("task group is closing")
                real_spawn(name, fn, *args)

            monkeypatch.setattr(background, "spawn", failing_spawn)
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 500
            assert env.app.state.livechat_transcription.inflight == set()
            # the row is `pending` with no job, and the next request restarts it
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
            _wait_for(_finished(env, voice.att_id))

    def test_only_one_transcription_runs_at_a_time(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voices = [_seed_voice(env) for _ in range(3)]
        with TestClient(env.app) as client:
            headers = _unlock(client)
            for voice in voices:
                assert (
                    client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
                )
            _wait_for(lambda: len(cmd_state.transcribe_requests) >= 1)
            time.sleep(0.3)  # the others must be waiting, not running
            assert len(cmd_state.transcribe_requests) == 1
            assert all(
                (env.store.get_transcript(v.att_id) or None) is not None
                and env.store.get_transcript(v.att_id).status == "pending"  # type: ignore[union-attr]
                for v in voices
            )
            gate.set()
            for voice in voices:
                _wait_for(_finished(env, voice.att_id))
        assert len(cmd_state.transcribe_requests) == 3
        assert cmd_state.transcribe_max_in_flight == 1

    def test_six_new_jobs_a_minute_per_identity(self, make_env: Callable[..., Env]) -> None:
        env = make_env()
        voices = [_seed_voice(env) for _ in range(7)]
        with TestClient(env.app) as client:
            headers = _unlock(client)
            codes = [
                client.post(TRANSCRIBE.format(v.att_id), headers=headers).status_code
                for v in voices[:6]
            ]
            assert codes == [202] * 6
            refused = client.post(TRANSCRIBE.format(voices[6].att_id), headers=headers)
            assert refused.status_code == 429
            body = refused.json()
            assert body["error"] == "rate_limited"
            assert 1 <= body["retryAfterS"] <= 60
            assert refused.headers["Retry-After"] == str(body["retryAfterS"])
            assert env.store.get_transcript(voices[6].att_id) is None

            for voice in voices[:6]:
                _wait_for(_finished(env, voice.att_id))
            # Reading a transcript that already exists does not spend the budget or need cmd.
            assert (
                client.post(TRANSCRIBE.format(voices[0].att_id), headers=headers).status_code == 200
            )


class TestErasure:
    def _transcribed(self, env: Env, client: TestClient, headers: dict[str, str]) -> Voice:
        voice = _seed_voice(env)
        client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
        _wait_for(_finished(env, voice.att_id))
        assert SENTINEL.encode() in _raw_db(env.store)
        return voice

    def test_deleting_the_message_erases_the_transcript_bytes(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        with TestClient(env.app) as client:
            headers = _unlock(client)
            voice = self._transcribed(env, client, headers)
            response = client.delete(f"/api/admin/server/messages/{voice.seq}", headers=headers)
            assert response.status_code == 204
        assert env.store.get_transcript(voice.att_id) is None
        assert SENTINEL.encode() not in _raw_db(env.store)

    def test_wiping_the_chat_erases_the_transcript_bytes(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        with TestClient(env.app) as client:
            headers = _unlock(client)
            voice = self._transcribed(env, client, headers)
            response = client.post(
                "/api/admin/server/wipe", headers=headers, json={"confirm": "WIPE"}
            )
            assert response.status_code == 204
        assert env.store.get_transcript(voice.att_id) is None
        assert SENTINEL.encode() not in _raw_db(env.store)

    def test_a_result_arriving_after_the_message_was_deleted_is_discarded(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
            _wait_for(lambda: len(cmd_state.transcribe_requests) == 1)

            assert (
                client.delete(
                    f"/api/admin/server/messages/{voice.seq}", headers=headers
                ).status_code
                == 204
            )
            events_after_delete = env.store.events_after(0)
            gate.set()
            _wait_for(lambda: not env.app.state.livechat_transcription.inflight)
            time.sleep(0.2)

        assert env.store.get_transcript(voice.att_id) is None
        assert env.store.get_attachment(voice.att_id) is None
        assert env.store.events_after(0) == events_after_delete  # no resurrected update
        assert SENTINEL.encode() not in _raw_db(env.store)

    def test_deleting_a_message_mid_job_never_returns_a_server_error(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
            client.delete(f"/api/admin/server/messages/{voice.seq}", headers=headers)
            gate.set()
            gone = client.post(TRANSCRIBE.format(voice.att_id), headers=headers)
        assert gone.status_code == 404


class TestStartupRecovery:
    def test_a_pending_row_left_by_a_dead_process_becomes_failed_and_is_announced(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        voice = _seed_voice(env)
        assert env.store.begin_transcript(att_id=voice.att_id, now=time.time()).state == "started"
        cursor = env.store.events_after(0)[-1].event_seq

        with TestClient(env.app) as client:  # startup recovery runs in the lifespan
            headers = _unlock(client)
            assert _message_attachment(client, headers, voice.att_id)["transcript"] == {
                "status": "failed"
            }
            row = env.store.get_transcript(voice.att_id)
            assert row is not None and row.failure == "interrupted"
            assert [(e.type, e.message_seq) for e in env.store.events_after(cursor)] == [
                ("message_updated", voice.seq)
            ]
            # ...and the owner can retry it.
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
            _wait_for(_finished(env, voice.att_id))

    def test_a_job_cancelled_by_shutdown_leaves_no_spinner_behind(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        """A process stopped mid-job (a slot swap, a deploy) marks the note failed on its way
        out, rather than leaving `pending` for some later startup to sweep."""
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
            _wait_for(lambda: len(cmd_state.transcribe_requests) == 1)
            # Leaving the block cancels the app's task group while the job waits on cmd.
        gate.set()

        row = env.store.get_transcript(voice.att_id)
        assert row is not None and (row.status, row.failure) == ("failed", "interrupted")
        assert env.app.state.livechat_transcription.inflight == set()

    def test_the_shutdown_record_never_overwrites_a_finished_transcript(
        self, make_env: Callable[..., Env], cmd_state: FakeCmdState
    ) -> None:
        """A cancelled job only turns a still-`pending` row into `failed`: if another process's
        result already landed, that transcript is not erased on the way out."""
        import threading

        gate = threading.Event()
        cmd_state.transcribe_gate = gate
        env = make_env()
        voice = _seed_voice(env)
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert client.post(TRANSCRIBE.format(voice.att_id), headers=headers).status_code == 202
            _wait_for(lambda: len(cmd_state.transcribe_requests) == 1)
            assert env.store.finish_transcript(
                att_id=voice.att_id,
                status="done",
                text="landed from elsewhere",
                failure=None,
                engine=None,
                now=time.time(),
            )
        gate.set()

        row = env.store.get_transcript(voice.att_id)
        assert row is not None and (row.status, row.text) == ("done", "landed from elsewhere")

    def test_an_old_database_is_upgraded_when_the_app_starts(
        self, make_env: Callable[..., Env]
    ) -> None:
        env = make_env()
        voice = _seed_voice(env)
        conn = sqlite3.connect(str(env.store._db_path))
        try:
            conn.execute("DROP TABLE attachment_transcripts")
            conn.execute("PRAGMA user_version = 6")
            conn.commit()
        finally:
            conn.close()
        with TestClient(env.app) as client:
            headers = _unlock(client)
            assert _message_attachment(client, headers, voice.att_id)["transcript"] is None
