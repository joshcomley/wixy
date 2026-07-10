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


@dataclass
class FakeSession:
    session_id: str
    workspace_id: str | None
    prompt: str
    cmd_project: str = ""
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


@dataclass
class FakeCmdState:
    sessions: dict[str, FakeSession] = field(default_factory=dict)
    next_session_n: int = 1
    new_chat_status_code: int = 202
    default_ready_after_polls: int = 0
    """Applied to every newly-created session's own `ready_after_polls` —
    unit tests default this to 0 (never auto-ready; the test sets `.ready`/
    `.ready_after_polls` explicitly per session, per scenario), while a
    fixture driving a real UI end-to-end (E2E 7) wants every session it never
    otherwise configures to become ready quickly with zero per-session
    wiring."""

    def create_session(self, prompt: str, *, cmd_project: str = "") -> FakeSession:
        n = self.next_session_n
        self.next_session_n += 1
        session = FakeSession(
            session_id=f"sess-{n}",
            workspace_id=f"ws-{n}",
            prompt=prompt,
            cmd_project=cmd_project,
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

    @app.post("/api/project/{project}/new-chat")
    async def new_chat(project: str, request: Request) -> Response:
        if state.new_chat_status_code != 202:
            return Response(status_code=state.new_chat_status_code)
        body = await request.json()
        prompt = body.get("prompt", "") if isinstance(body, dict) else ""
        session = state.create_session(prompt, cmd_project=project)
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
        idem_key = body.get("idempotency_key") if isinstance(body, dict) else None
        if isinstance(idem_key, str):
            session.idempotency_seen[idem_key] = session.idempotency_seen.get(idem_key, 0) + 1
        return JSONResponse(
            status_code=202, content={"accepted": True, "buffered": session.send_buffered}
        )

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
