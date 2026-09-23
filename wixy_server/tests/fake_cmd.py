"""A fake cmd server (spec/06-ai-chat.md §4: "cmdchat.py is written against an
interface so tests run against a fake cmd server... including the
handover-resolution and mid-provisioning states") — one combined FastAPI app
standing in for BOTH real cmd surfaces `wixy_server.cmdchat` talks to (the cmd
portal on 9320, Cmd-Chats introspection on 9321): since `httpx.ASGITransport`
dispatches purely by path (never by host/port), one app can serve both route
groups for the plain-HTTP endpoints. The `/ws/chat-pending` websocket needs a real
socket (ASGI transports can't do the upgrade), so websocket-exercising tests spin
this same app up via a real ephemeral-port uvicorn instance (`start_fake_cmd_server`
below) instead.

Not a `test_*.py` file — a reusable fixture module, imported by test files, never
collected by pytest itself (mirrors `e2e/fixture_server.py`'s own non-test-prefixed
convention).
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from builder.jsontypes import JsonObject

DEFAULT_UPLOAD_BYTES = (
    b"RIFF8\x00\x00\x00WEBPVP8 ,\x00\x00\x00\x90\x01\x00\x9d\x01*\x08\x00\x08\x00"
    b"\x01@&%\xa0\x02t\xba\x00\x03\x98\x00\xfe\xeev\x7f\xfe\xa0\xcf\xfc\x83?\xf2\x0c"
    b"\xfdT\xbfjQ\x05%l\x00\x00"
)
"""A real 8x8 WEBP (Pillow-generated) served by the fake's
`GET /api/uploads/{id}/bytes` — genuine decodable bytes so a browser `<img>`
pointed at wixy's bytes proxy actually loads in E2E (decisions/00110)."""


@dataclass
class FakeSession:
    session_id: str
    workspace_id: str | None
    prompt: str
    cmd_project: str = ""
    model: str | None = None
    """The `model` the create call asked for (`None` = field omitted) — tests
    assert Wixy pins Sonnet 5 rather than inheriting cmd's own default (Opus).
    """
    spawned_by_session_id: str | None = None
    """The raw `spawned_by_session_id` the create call sent. `""` is cmd's
    "deliberately unparented" sentinel and is what Wixy must send; the handler
    below rejects an omitted/null value with a 400 exactly as cmd does, so this
    is never `None` for a session that actually got created."""
    ready: bool = False
    ready_after_polls: int = 0
    poll_count: int = 0
    chain: list[str] = field(default_factory=list)
    messages: list[JsonObject] = field(default_factory=list)
    status: JsonObject = field(
        default_factory=lambda: {
            "activity": None,
            "process": {"kind": "cli"},
            "handover_state": None,
        }
    )
    send_status_code: int = 202
    send_buffered: bool = False
    idempotency_seen: dict[str, int] = field(default_factory=dict)
    """`idempotency_key -> send call count` — tests assert a retried send with the
    SAME key was only ever accepted once by inspecting this, matching spec/06 §1's
    "Include the idempotency key so a UI retry can't double-send.\""""
    last_send_body: JsonObject | None = None
    """decisions/00103: the exact JSON body the most recent `/send` call carried —
    lets a test assert on the `attachments` field (present with the right
    `{kind, upload_id}` shape, or absent entirely for a plain text send) without
    a bespoke request-capturing middleware."""
    create_attachments: list[JsonObject] | None = None
    """decisions/00110: the `attachments` list the new-chat call carried (None =
    field omitted) — cmd's own new-chat route folds these into the first turn
    (its `_stage_new_chat_attachments`), and tests assert wixy forwards them."""


@dataclass
class FakePinApp:
    """spec/server-chat/00-brief.md §5.1 v1.4: one app-key's registered test PIN
    plus cmd's own per-subject lockout state — mirrors the REAL contract
    (`POST /api/pins/<app_key>/verify` -> `{"ok", "error"?, "attempts_left"?,
    "locked"?, "lock_scope"?, "retry_after_seconds"?}`) closely enough that
    `livechat.pinclient.CmdPinVerifier`'s mapping logic is exercised against
    something that actually behaves like cmd, not a rubber stamp. Only
    per-SUBJECT lockout is modeled — cmd's own app-wide ladder isn't, since
    wixy's client never branches on `lock_scope` (§5.1: "not surfaced to the
    browser")."""

    app_key: str
    pin: str
    lockout_after: int = 5
    """5 wrong attempts -> locked (matches cmd's own stated default ladder,
    §5.1: "5 wrong in a row per subject -> 60s, doubling...")."""
    lockout_seconds: float = 60.0
    attempts: dict[str, int] = field(default_factory=dict)  # subject -> wrong-attempt count
    locked_until: dict[str, float] = field(default_factory=dict)  # subject -> epoch
    simulate_pin_changed_once: bool = False
    """When true, the NEXT `verify` call for this app returns 409 `pin_changed`
    (§5.1 v1.4) instead of evaluating the PIN, then resets itself — a test sets
    this to exercise wixy's 409 mapping without needing a real PIN rotation."""


@dataclass
class FakeCmdState:
    sessions: dict[str, FakeSession] = field(default_factory=dict)
    next_session_n: int = 1
    new_chat_status_code: int = 202
    default_ready_after_polls: int = 0
    uploads: dict[str, JsonObject] = field(default_factory=dict)
    """decisions/00103: staged `POST /api/uploads` bodies, keyed by the fake's
    own issued `id` — recorded (not just accepted) so a test can assert on
    exactly what bytes/media_type a real `upload_attachment` call sent."""
    next_upload_n: int = 1
    upload_status_code: int = 201
    upload_converted_dims: tuple[int, int] = (100, 100)
    """cmd's own resize-to-1568/WEBP pipeline runs on real bytes this fake
    never actually decodes — a canned `(width, height)` a test can override
    when it cares about the specific value threaded back through
    `UploadResult`/`ChatAttachment`."""
    """Applied to every newly-created session's own `ready_after_polls` —
    unit tests default this to 0 (never auto-ready; the test sets `.ready`/
    `.ready_after_polls` explicitly per session, per scenario), while a
    fixture driving a real UI end-to-end (E2E 7) wants every session it never
    otherwise configures to become ready quickly with zero per-session
    wiring."""
    upload_bytes: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    """decisions/00110: the bytes `GET /api/uploads/{id}/bytes` serves per id
    (content, media_type) — overridable per test; an id with no entry but a
    staged upload gets the canned `DEFAULT_UPLOAD_BYTES` (a real 1x1 WEBP, so
    browser `<img>` tags genuinely load in E2E)."""
    pin_apps: dict[str, FakePinApp] = field(default_factory=dict)
    """spec/server-chat/00-brief.md §5.1: the PIN-verify double's app-key
    registry — `register_pin_app` populates it; an unregistered `app_key`
    404s, mirroring cmd's real "unknown app key" answer."""

    def register_pin_app(
        self, app_key: str, pin: str, *, lockout_after: int = 5, lockout_seconds: float = 60.0
    ) -> FakePinApp:
        pin_app = FakePinApp(
            app_key=app_key, pin=pin, lockout_after=lockout_after, lockout_seconds=lockout_seconds
        )
        self.pin_apps[app_key] = pin_app
        return pin_app

    def reset_pin_lockout(self, app_key: str, subject: str | None = None) -> None:
        """Clears wrong-attempt/lockout state for one app key — either one
        `subject` or every subject registered against it. The e2e fixture's own
        `/test/server/reset-pin-lockout` route (added alongside the frontend
        specs that need it) calls straight through to this."""
        pin_app = self.pin_apps.get(app_key)
        if pin_app is None:
            return
        if subject is None:
            pin_app.attempts.clear()
            pin_app.locked_until.clear()
        else:
            pin_app.attempts.pop(subject, None)
            pin_app.locked_until.pop(subject, None)

    def create_session(
        self,
        prompt: str,
        *,
        cmd_project: str = "",
        model: str | None = None,
        spawned_by_session_id: str | None = None,
    ) -> FakeSession:
        n = self.next_session_n
        self.next_session_n += 1
        session = FakeSession(
            session_id=f"sess-{n}",
            workspace_id=f"ws-{n}",
            prompt=prompt,
            cmd_project=cmd_project,
            model=model,
            spawned_by_session_id=spawned_by_session_id,
            ready_after_polls=self.default_ready_after_polls,
        )
        self.sessions[session.session_id] = session
        return session


class _PendingBus:
    """Fan-out for `/ws/chat-pending` transition events — tests call `publish()`
    from outside the request/response cycle (e.g. after a delay, from the test
    body) to simulate cmd reporting a provisioning failure mid-wait."""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[JsonObject]] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    def subscribe(self) -> asyncio.Queue[JsonObject]:
        # Captured here (not at bus-construction time) because this always runs ON
        # the server's own event loop -- the websocket route handler that calls it
        # is necessarily running there, whereas the bus itself is constructed
        # during app setup, which for `FakeCmdServer` happens on the TEST's thread
        # before the uvicorn server thread (and its loop) even exists yet.
        self._loop = asyncio.get_running_loop()
        queue: asyncio.Queue[JsonObject] = asyncio.Queue()
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[JsonObject]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    @property
    def has_subscribers(self) -> bool:
        return bool(self._subscribers)

    def publish(self, event: JsonObject) -> None:
        """Thread-safe: `FakeCmdServer.publish_pending_event` (below) calls this
        from the TEST's own thread/loop, but the queues belong to the uvicorn
        server's background-thread loop — `call_soon_threadsafe` is the correct
        cross-loop handoff (a bare `put_nowait` here would corrupt the queue's
        internal state, since `asyncio.Queue` isn't thread-safe). A no-op if no
        websocket has connected yet (`_loop` still unset) — nothing to publish to."""
        loop = self._loop
        if loop is None:
            return
        for queue in self._subscribers:
            loop.call_soon_threadsafe(queue.put_nowait, event)


def create_fake_cmd_app(state: FakeCmdState | None = None) -> FastAPI:
    state = state if state is not None else FakeCmdState()
    pending_bus = _PendingBus()
    app = FastAPI()
    app.state.fake = state
    app.state.pending_bus = pending_bus

    @app.post("/api/pins/{app_key}/verify")
    async def pin_verify(app_key: str, request: Request) -> Response:
        """spec/server-chat/00-brief.md §5.1 v1.4's double (cmd workspace #875 PR
        #3068's real contract): `{"pin","subject"?}` -> `{"ok", "error"?,
        "attempts_left"?, "locked"?, "lock_scope"?, "retry_after_seconds"?}`, app
        key in the URL PATH. An unknown `app_key` 404s (`CmdPinVerifier` maps
        that to 503 `not_configured`); a non-JSON content-type 415s; a
        malformed-shape PIN 400s `invalid_request` (wixy validates 4-16 digits
        locally and should never actually trigger this in practice)."""
        content_type = request.headers.get("content-type", "")
        if "application/json" not in content_type:
            return Response(status_code=415)

        body = await request.json()
        pin = body.get("pin") if isinstance(body, dict) else None
        subject_raw = body.get("subject") if isinstance(body, dict) else None
        subject = subject_raw if isinstance(subject_raw, str) else ""

        if not isinstance(pin, str) or not (4 <= len(pin) <= 16) or not pin.isdigit():
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": "invalid_request",
                    "message": "pin must be 4-16 digits",
                },
            )
        if app_key not in state.pin_apps:
            return JSONResponse(status_code=404, content={"ok": False, "error": "unknown_app"})

        pin_app = state.pin_apps[app_key]

        if pin_app.simulate_pin_changed_once:
            pin_app.simulate_pin_changed_once = False
            return JSONResponse(status_code=409, content={"ok": False, "error": "pin_changed"})

        now = time.time()
        locked_until = pin_app.locked_until.get(subject)
        if locked_until is not None and locked_until > now:
            retry_after = max(1, int(locked_until - now))
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(retry_after)},
                content={
                    "ok": False,
                    "error": "locked",
                    "lock_scope": "subject",
                    "retry_after_seconds": retry_after,
                },
            )

        if pin == pin_app.pin:
            pin_app.attempts.pop(subject, None)
            pin_app.locked_until.pop(subject, None)
            return JSONResponse(status_code=200, content={"ok": True, "app_key": app_key})

        attempts = pin_app.attempts.get(subject, 0) + 1
        pin_app.attempts[subject] = attempts
        if attempts >= pin_app.lockout_after:
            locked_until = now + pin_app.lockout_seconds
            pin_app.locked_until[subject] = locked_until
            retry_after = int(pin_app.lockout_seconds)
            return JSONResponse(
                status_code=401,
                headers={"Retry-After": str(retry_after)},
                content={
                    "ok": False,
                    "error": "wrong_pin",
                    "attempts_left": 0,
                    "locked": True,
                    "lock_scope": "subject",
                    "retry_after_seconds": retry_after,
                },
            )
        return JSONResponse(
            status_code=401,
            content={
                "ok": False,
                "error": "wrong_pin",
                "attempts_left": max(0, pin_app.lockout_after - attempts),
                "locked": False,
                "lock_scope": None,
                "retry_after_seconds": 0,
            },
        )

    @app.post("/api/project/{project}/new-chat")
    async def new_chat(project: str, request: Request) -> Response:
        if state.new_chat_status_code != 202:
            return Response(status_code=state.new_chat_status_code)
        body = await request.json()
        prompt = body.get("prompt", "") if isinstance(body, dict) else ""
        # cmd REQUIRES `spawned_by_session_id` (its engine/spawn_lineage.py,
        # `required=True` since cmd decisions/00071): omitted or null is a 400,
        # not a default. This fake enforces it because NOT enforcing it is
        # precisely how the real bug shipped — the create call sent `{"prompt"}`
        # alone, cmd 400'd, `routes_chat` turned that into the 502 the owner saw
        # on "Start", and the whole suite stayed green against a fake that
        # accepted anything. A test double that is laxer than the real service
        # cannot catch contract drift, so this one mirrors the contract.
        spawned_by_raw = body.get("spawned_by_session_id") if isinstance(body, dict) else None
        if spawned_by_raw is None:
            return JSONResponse(
                status_code=400,
                content={"error": "spawned_by_session_id is required"},
            )
        model_raw = body.get("model") if isinstance(body, dict) else None
        attachments_raw = body.get("attachments") if isinstance(body, dict) else None
        # cmd's `_stage_new_chat_attachments` 404s an unknown `upload_id` —
        # mirrored here for the same reason the `spawned_by_session_id` 400
        # above is: a double laxer than the real service cannot catch drift.
        if isinstance(attachments_raw, list):
            for idx, entry in enumerate(attachments_raw):
                upload_id = entry.get("upload_id") if isinstance(entry, dict) else None
                if not isinstance(upload_id, str) or upload_id not in state.uploads:
                    return JSONResponse(
                        status_code=404,
                        content={
                            "error": f"unknown upload_id {upload_id!r}",
                            "rejected_index": idx,
                        },
                    )
        session = state.create_session(
            prompt,
            cmd_project=project,
            model=model_raw if isinstance(model_raw, str) else None,
            spawned_by_session_id=spawned_by_raw if isinstance(spawned_by_raw, str) else None,
        )
        if isinstance(attachments_raw, list):
            session.create_attachments = [a for a in attachments_raw if isinstance(a, dict)]
        return JSONResponse(
            status_code=202,
            content={
                "session_id": session.session_id,
                "pending_state": "queued",
                "workspace_id": session.workspace_id,
            },
        )

    @app.get("/api/session/{session_id}")
    async def get_session(session_id: str) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        session.poll_count += 1
        if not session.ready and session.poll_count >= session.ready_after_polls > 0:
            session.ready = True
        if not session.ready:
            return Response(status_code=404)
        return JSONResponse({"session_id": session_id})

    @app.get("/api/session/{session_id}/chain")
    async def get_chain(session_id: str) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        chain = session.chain if session.chain else [session_id]
        return JSONResponse({"chain": chain})

    @app.post("/api/session/{session_id}/send")
    async def send(session_id: str, request: Request) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        if session.send_status_code != 202:
            return Response(status_code=session.send_status_code)
        body = await request.json()
        session.last_send_body = body if isinstance(body, dict) else None
        # cmd's `_resolve_upload_ids_to_blocks` 404s an unknown `upload_id`,
        # same contract as the new-chat staging above.
        attachments_raw = body.get("attachments") if isinstance(body, dict) else None
        if isinstance(attachments_raw, list):
            for idx, entry in enumerate(attachments_raw):
                upload_id = entry.get("upload_id") if isinstance(entry, dict) else None
                if not isinstance(upload_id, str) or upload_id not in state.uploads:
                    return JSONResponse(
                        status_code=404,
                        content={
                            "error": f"unknown upload_id {upload_id!r}",
                            "rejected_index": idx,
                        },
                    )
        idem_key = body.get("idempotency_key") if isinstance(body, dict) else None
        if isinstance(idem_key, str):
            session.idempotency_seen[idem_key] = session.idempotency_seen.get(idem_key, 0) + 1
        return JSONResponse(
            status_code=202, content={"accepted": True, "buffered": session.send_buffered}
        )

    @app.post("/api/uploads")
    async def uploads(request: Request) -> Response:
        if state.upload_status_code != 201:
            return Response(status_code=state.upload_status_code)
        body = await request.json()
        n = state.next_upload_n
        state.next_upload_n += 1
        upload_id = f"upload-{n}"
        state.uploads[upload_id] = body if isinstance(body, dict) else {}
        width, height = state.upload_converted_dims
        media_type = body.get("media_type") if isinstance(body, dict) else None
        return JSONResponse(
            status_code=201,
            content={
                "id": upload_id,
                "kind": body.get("kind") if isinstance(body, dict) else None,
                "original": {"size": 0, "media_type": media_type},
                "converted": {
                    "size": 0,
                    "media_type": "image/webp",
                    "width": width,
                    "height": height,
                },
                "processing_ms": 1,
            },
        )

    @app.get("/api/uploads/{upload_id}/bytes")
    async def upload_bytes_route(upload_id: str) -> Response:
        """decisions/00110: mirrors cmd's own inline-bytes endpoint (the one
        cmd's chat UI uses for previews and wixy's proxy route forwards). 404
        for an id the fake never staged, exactly as cmd's row-lookup does."""
        if upload_id not in state.uploads:
            return Response(status_code=404)
        content, media_type = state.upload_bytes.get(
            upload_id, (DEFAULT_UPLOAD_BYTES, "image/webp")
        )
        return Response(content=content, media_type=media_type)

    @app.get("/sessions/{session_id}/messages")
    async def get_messages(
        session_id: str,
        limit: int = 80,
        before: int | None = None,
        include_tools: bool = True,
        include_thinking: bool = False,
    ) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        messages = session.messages
        if not include_thinking:
            # Mirrors spec/06 §1: cmd never includes kind:"thinking" entries
            # unless explicitly asked — the wixy stream's own "show reasoning"
            # toggle relies on this filtering actually happening somewhere.
            messages = [m for m in messages if m.get("kind") != "thinking"]
        if before is not None:
            messages = [
                m for m in messages if isinstance((idx := m.get("index")), int) and idx < before
            ]
        return JSONResponse({"messages": messages[-limit:]})

    @app.get("/sessions/{session_id}/status")
    async def get_status(session_id: str) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        return JSONResponse(session.status)

    @app.websocket("/ws/chat-pending")
    async def ws_chat_pending(websocket: WebSocket) -> None:
        await websocket.accept()
        queue = pending_bus.subscribe()
        try:
            await websocket.send_json({"type": "hello", "pending": list(state.sessions.keys())})
            while True:
                event = await queue.get()
                await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            pending_bus.unsubscribe(queue)

    return app


class FakeCmdServer:
    """A real uvicorn instance on an ephemeral localhost port, for tests that need
    a genuine socket (the `/ws/chat-pending` websocket — `httpx.ASGITransport`
    can't do the upgrade). Runs the server loop on a background thread, mirroring
    `test_kill_during_publish.py`'s precedent of using a real process/thread for
    what a mocked transport genuinely can't exercise."""

    def __init__(self, state: FakeCmdState | None = None) -> None:
        self.state = state if state is not None else FakeCmdState()
        self._app = create_fake_cmd_app(self.state)
        config = uvicorn.Config(self._app, host="127.0.0.1", port=0, log_level="warning")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    def start(self, *, timeout_s: float = 10.0) -> int:
        self._thread.start()
        deadline = time.monotonic() + timeout_s
        while not self._server.started:
            if time.monotonic() > deadline:
                raise TimeoutError("fake cmd server did not start in time")
            time.sleep(0.01)
        server_socket = self._server.servers[0].sockets[0]
        port: int = server_socket.getsockname()[1]
        return port

    def wait_for_pending_subscriber(self, *, timeout_s: float = 5.0) -> None:
        """Blocks until a `/ws/chat-pending` client has connected — call this
        before `publish_pending_event` to avoid the race where the event is
        published before `cmdchat.CmdChatClient.watch_pending`'s connection has
        actually been accepted (a publish with no subscriber yet is silently
        dropped, matching a real pub/sub's semantics, not queued for later)."""
        bus: _PendingBus = self._app.state.pending_bus
        deadline = time.monotonic() + timeout_s
        while not bus.has_subscribers:
            if time.monotonic() > deadline:
                raise TimeoutError("no /ws/chat-pending subscriber connected in time")
            time.sleep(0.01)

    def publish_pending_event(self, event: JsonObject) -> None:
        bus: _PendingBus = self._app.state.pending_bus
        bus.publish(event)

    def stop(self, *, timeout_s: float = 10.0) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=timeout_s)
