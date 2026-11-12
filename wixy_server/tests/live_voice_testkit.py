"""Shared helpers for the live-voice tests (spec/server-chat/07-live-voice-notes.md). Not a
`test_*.py` file, so pytest never collects it; the live-voice test modules import from it.

Real ffmpeg throughout (a missing binary is a loud failure, never a skip — the hardening suite's
rule), real local sockets through the app's `TestClient` (the portal the app and its hub run in),
and a scripted `Transcriber` standing in for cmd's private mode.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketTestSession

from wixy_server.app import create_app
from wixy_server.livechat.live_voice import LiveVoiceHub
from wixy_server.livechat.live_voice_protocol import PROTOCOL
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import UNLOCK_GUARD_HEADER, UNLOCK_GUARD_VALUE
from wixy_server.livechat.transcribe import Transcriber, TranscribeResult
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app

TEST_APP_KEY = "wixy-livechat"
TEST_PIN = "482913"
DEVICE = "device-live-1"
UPLOADS = "/api/admin/server/uploads"
WS_PATH = "/api/admin/server/live-voice/ws"
TRANSCRIBE = "/api/admin/server/attachments/{}/transcribe"
NOTE_SECONDS = 12


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def make_wixy_repo(base: Path) -> Path:
    """A throwaway engine checkout + site origin for `create_app` (shared by a module's tests)."""
    origin = base / "origin"
    origin.mkdir()
    _git(["init", "--initial-branch=main"], origin)
    _git(["config", "user.email", "test@example.com"], origin)
    _git(["config", "user.name", "Test"], origin)
    (origin / "README.md").write_text("hi\n", encoding="utf-8")
    _git(["add", "."], origin)
    _git(["commit", "-m", "initial"], origin)
    root = base / "wixy-repo"
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


def ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        pytest.fail("ffmpeg not found on PATH; this suite runs real ffmpeg by design")
    return path


def make_webm(dest: Path, *, seconds: int = NOTE_SECONDS, frequency: int = 300) -> bytes:
    """An opus-in-webm recording, the shape a Chrome `MediaRecorder` produces."""
    subprocess.run(
        [
            ffmpeg_path(),
            "-hide_banner",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:duration={seconds}",
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


def slices_of(data: bytes, count: int = NOTE_SECONDS) -> list[bytes]:
    """`data` cut into `count` arbitrary byte ranges (not frame or cluster boundaries), exactly
    what a `MediaRecorder` timeslice produces: only the first carries the header."""
    size = len(data) // count + 1
    return [data[i : i + size] for i in range(0, len(data), size)]


def wait_for(predicate: Callable[[], bool], *, timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("timed out waiting for the condition")


@dataclass
class Scripted:
    """A `Transcriber` whose answers the test scripts. Live windows (`live.wav`) consume `texts`
    one per request (the last repeats); the full-note pass after Stop (`play.m4a`) answers
    `final_text`; `outcomes` is the transcription outcome per request (the last repeats).
    Everything it was asked is recorded."""

    texts: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=lambda: ["ok"])
    final_text: str = "the final stored transcript"
    requests: list[tuple[str, str, int, float]] = field(default_factory=list)
    fresh_probes: int = 0
    tmp_listings: list[list[str]] = field(default_factory=list)
    tmp_dir: Path | None = None

    async def available(self, *, fresh: bool = False) -> bool:
        self.fresh_probes += 1 if fresh else 0
        return True

    async def transcribe(
        self, *, audio: bytes, filename: str, content_type: str, timeout_s: float
    ) -> TranscribeResult:
        self.requests.append((filename, content_type, len(audio), timeout_s))
        if self.tmp_dir is not None:
            self.tmp_listings.append(
                sorted(p.name for p in self.tmp_dir.rglob("*") if p.is_file())
                if self.tmp_dir.exists()
                else []
            )
        number = len(self.requests)
        outcome = self.outcomes[min(number - 1, len(self.outcomes) - 1)]
        if outcome != "ok":
            return TranscribeResult(outcome)  # type: ignore[arg-type]
        if filename == "play.m4a":
            return TranscribeResult("ok", text=self.final_text, engine="fake")
        live = sum(1 for r in self.requests if r[0] != "play.m4a") - 1
        text = self.texts[min(live, len(self.texts) - 1)] if self.texts else ""
        return TranscribeResult("ok", text=text, engine="fake")

    async def aclose(self) -> None:
        return None

    def live_windows(self) -> list[tuple[str, str, int, float]]:
        return [r for r in self.requests if r[0] == "live.wav"]


class Sock:
    """A test's side of one listener socket: collects JSON messages and binary frames, answers the
    server's pings, and never blocks forever."""

    def __init__(self, ws: WebSocketTestSession) -> None:
        self.ws = ws
        self.messages: list[dict[str, Any]] = []
        self.frames: list[bytes] = []
        self.pings = 0

    def send(self, **message: Any) -> None:
        self.ws.send_json(message)

    def _receive(self, timeout_s: float) -> dict[str, Any]:
        async def go() -> dict[str, Any]:
            with anyio.fail_after(timeout_s):
                message = await self.ws._send_rx.receive()
            return dict(message)

        result: dict[str, Any] = self.ws.portal.call(go)
        return result

    def pump(self, timeout_s: float = 0.5) -> bool:
        """Take one message off the socket (`False` when none came in time)."""
        try:
            message = self._receive(timeout_s)
        except TimeoutError:
            return False
        if message["type"] == "websocket.close":
            raise AssertionError(f"socket closed by the server: {message.get('code')}")
        if "bytes" in message and message["bytes"] is not None:
            self.frames.append(message["bytes"])
            return True
        decoded: dict[str, Any] = json.loads(message["text"])
        if decoded["type"] == "ping":
            self.pings += 1
            self.send(type="pong")
            return True
        self.messages.append(decoded)
        return True

    def until(self, predicate: Callable[[], object], *, timeout_s: float = 30.0) -> None:
        deadline = time.monotonic() + timeout_s
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(f"timed out; messages so far: {self.messages[-6:]}")
            self.pump(0.2)

    def of(self, kind: str, att_id: str | None = None) -> list[dict[str, Any]]:
        return [
            m
            for m in self.messages
            if m["type"] == kind and (att_id is None or m.get("attachmentId") == att_id)
        ]

    def closed_code(self, timeout_s: float = 10.0) -> int:
        """Wait for the server to close the socket and return its close code."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                message = self._receive(0.2)
            except TimeoutError:
                continue
            if message["type"] == "websocket.close":
                return int(message.get("code", 1000))
        raise AssertionError("the server did not close the socket")


@dataclass
class Note:
    upload_id: str
    seq: int
    attachment: dict[str, Any]


@dataclass
class LiveEnv:
    app: FastAPI
    client: TestClient
    headers: dict[str, str]
    store: LiveChatStore
    hub: LiveVoiceHub
    state: FakeCmdState
    origin: str
    secret: bytes

    @property
    def paths(self) -> Any:
        return self.app.state.paths

    def init(self, *, listen: bool = True, device: str = DEVICE) -> Any:
        return self.client.post(
            UPLOADS,
            json={
                "kind": "voice",
                "mimeType": "audio/webm",
                "live": True,
                "deviceId": device,
                "listen": listen,
            },
            headers=self.headers,
        )

    def put(self, upload_id: str, index: int, data: bytes) -> Any:
        return self.client.put(
            f"{UPLOADS}/{upload_id}/chunks/{index}", content=data, headers=self.headers
        )

    def send_message(self, att_id: str) -> int:
        response = self.client.post(
            "/api/admin/server/messages",
            json={
                "clientId": f"client-{uuid.uuid4().hex[:16]}",
                "sender": "Purdy",
                "deviceId": DEVICE,
                "attachmentIds": [att_id],
            },
            headers=self.headers,
        )
        assert response.status_code == 201, response.text
        seq: int = response.json()["message"]["seq"]
        return seq

    def start_note(self, *, send: bool = True) -> Note:
        response = self.init()
        assert response.status_code == 201, response.text
        body = response.json()
        upload_id: str = body["uploadId"]
        seq = self.send_message(upload_id) if send else 0
        return Note(upload_id, seq, body["attachment"])

    def complete(self, upload_id: str, count: int | None = None) -> Any:
        return self.client.post(
            f"{UPLOADS}/{upload_id}/complete",
            json={} if count is None else {"chunkCount": count},
            headers=self.headers,
        )

    def live_state(self, upload_id: str, state: str) -> Any:
        return self.client.post(
            f"{UPLOADS}/{upload_id}/live-state", json={"state": state}, headers=self.headers
        )

    def attachment(self, att_id: str) -> dict[str, Any]:
        body = self.client.get("/api/admin/server/messages", headers=self.headers).json()
        for message in body["messages"]:
            for attachment in message["attachments"]:
                if attachment["id"] == att_id:
                    result: dict[str, Any] = attachment
                    return result
        raise AssertionError(f"attachment {att_id} not in history")

    def updates(self, seq: int) -> int:
        return sum(
            1
            for e in self.store.events_after(0, limit=10_000)
            if e.type == "message_updated" and e.message_seq == seq
        )

    def tick(self) -> None:
        self.client.portal.call(self.hub.tick)  # type: ignore[union-attr]

    def token_for(self, email: str) -> str:
        from wixy_server.livechat.tokens import mint_unlock_token

        return mint_unlock_token(self.secret, email=email, now=time.time())[0]

    @contextmanager
    def socket(self, *, email: str = "") -> Iterator[Sock]:
        token = self.headers["X-Wixy-Server-Token"] if not email else self.token_for(email)
        headers = {"origin": self.origin}
        if email:
            headers["cf-access-authenticated-user-email"] = email
        with self.client.websocket_connect(WS_PATH, headers=headers, subprotocols=[PROTOCOL]) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": token, "label": "Test"})
            sock = Sock(ws)
            sock.until(lambda: sock.of("ready"))
            yield sock

    def wait_status(self, att_id: str, status: str, *, timeout_s: float = 60.0) -> None:
        def check() -> bool:
            att = self.store.get_attachment(att_id)
            return att is not None and att.status == status

        wait_for(check, timeout_s=timeout_s)


@contextmanager
def live_env(
    base: Path,
    wixy_repo_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    transcriber: Transcriber | None = None,
    media_worker: bool = True,
) -> Iterator[LiveEnv]:
    """The app (dev auth bypass, a fake cmd for the PIN and, unless `transcriber` is given, for
    transcription), its lifespan running, unlocked. `base` is the test's own directory."""
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")
    state = FakeCmdState()
    state.register_pin_app(TEST_APP_KEY, TEST_PIN)
    fake_app = create_fake_cmd_app(state)
    if not media_worker:
        from wixy_server.livechat import media_queue as livechat_media_queue

        async def _idle(**_: Any) -> None:
            await anyio.sleep_forever()

        monkeypatch.setattr(livechat_media_queue, "run_forever", _idle)
    from wixy_server.livechat.transcribe import CmdTranscriber

    app = create_app(
        storage_root=base / "storage",
        wixy_repo_root=wixy_repo_root,
        pin_verifier=CmdPinVerifier(
            app_key=TEST_APP_KEY, transport=httpx.ASGITransport(app=fake_app)
        ),
        transcriber=transcriber
        if transcriber is not None
        else CmdTranscriber(transport=httpx.ASGITransport(app=fake_app)),
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/admin/server/unlock",
            json={"pin": TEST_PIN},
            headers={UNLOCK_GUARD_HEADER: UNLOCK_GUARD_VALUE},
        )
        assert response.status_code == 200, response.text
        port = app.state.settings.port
        yield LiveEnv(
            app=app,
            client=client,
            headers={"X-Wixy-Server-Token": response.json()["token"]},
            store=app.state.livechat_store,
            hub=app.state.livechat_live_voice,
            state=state,
            origin=f"http://127.0.0.1:{port}",
            secret=app.state.livechat_secret,
        )
