"""Dual-gated, ephemeral call sockets; never reuse HTTP-only middleware as WS auth."""

from __future__ import annotations

import asyncio
import math
import time
from typing import Any

import anyio
import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from wixy_server.auth import AccessVerificationError
from wixy_server.livechat.call_broker import CallBroker, Peer
from wixy_server.livechat.call_protocol import COMMAND, PROTOCOL, Authenticate
from wixy_server.livechat.grants import GRANT_IDLE_EXPIRY_S
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import validate_server_token
from wixy_server.settings import Settings

router = APIRouter()


def upgrade_allowed(ws: WebSocket, origins: frozenset[str]) -> bool:
    return (
        not ws.scope.get("query_string")
        and len(ws.headers.getlist("origin")) == 1
        and ws.headers["origin"] in origins
        and len(ws.headers.getlist("cf-access-jwt-assertion")) <= 1
        and ws.headers.get("sec-fetch-site", "same-origin") == "same-origin"
        and ws.scope.get("subprotocols") == [PROTOCOL]
    )


async def access_identity(ws: WebSocket, settings: Settings) -> tuple[str, float]:
    if settings.dev_no_auth:
        # Same explicit development-only bypass as HTTP; never enabled in production.
        return ws.headers.get("cf-access-authenticated-user-email", ""), time.time() + 43200
    token = ws.headers.get("cf-access-jwt-assertion", "")
    if not token:
        raise ValueError("access")
    verify = ws.app.state.call_access_verifier
    claims: dict[str, Any] = await anyio.to_thread.run_sync(lambda: verify(token))
    email, exp = claims.get("email"), claims.get("exp")
    if (
        not isinstance(email, str)
        or not email
        or isinstance(exp, bool)
        or not isinstance(exp, (int, float))
        or not math.isfinite(exp)
        or exp <= time.time()
    ):
        raise ValueError("access claims")
    return email, float(exp)


async def run_peer(ws: WebSocket, broker: CallBroker, peer: Peer, store: LiveChatStore) -> None:
    async def read() -> None:
        while not peer.closed:
            packet = await ws.receive()
            if packet["type"] == "websocket.disconnect":
                return
            data = packet.get("bytes")
            if data is not None:
                broker.frame(peer, data)
            else:
                text = packet.get("text")
                if not isinstance(text, str) or len(text.encode("utf-8")) > 4096:
                    raise ValueError("control size")
                broker.command(peer, COMMAND.validate_json(text))
            peer.wake.set()

    async def write() -> None:
        while not peer.closed:
            # Clear before inspecting queues; no lost wake between empty check and wait.
            peer.wake.clear()
            if not broker.permitted(peer):
                return
            if peer.controls:
                message = peer.controls.popleft()
                async with asyncio.timeout(0.25):
                    await ws.send_json(message)
                continue
            data = broker.next_media(peer)
            if data is not None:
                async with asyncio.timeout(0.25):
                    await ws.send_bytes(data)
                continue
            await peer.wake.wait()

    async def monitor() -> None:
        count = 0
        while not peer.closed:
            broker.tick(peer)
            if count % 20 == 0:
                broker.emit(peer, {"type": "ping"})
            count += 1
            await asyncio.sleep(0.1)

    async def grants() -> None:
        if peer.auth.grant_id is None:
            await asyncio.Future[None]()
        while not peer.closed:
            live = await anyio.to_thread.run_sync(
                lambda: store.is_device_grant_live(
                    grant_id=peer.auth.grant_id or "",
                    email=peer.auth.email,
                    now=time.time(),
                    max_idle_s=GRANT_IDLE_EXPIRY_S,
                )
            )
            if not live:
                peer.grant_until = 0
                return
            peer.grant_until = time.monotonic() + 2.5
            await asyncio.sleep(2)

    # Fixed four workers per admitted connection. Completion/failure of ANY ends all.
    tasks = [asyncio.create_task(fn()) for fn in (read, write, monitor, grants)]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        broker.remove(peer)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket("/api/admin/server/calls/ws")
async def calls_socket(ws: WebSocket) -> None:
    broker: CallBroker = ws.app.state.livechat_call_broker
    origins: frozenset[str] = ws.app.state.call_origins
    if (
        broker.closed
        or broker.pending >= 4
        or broker.connections >= 8
        or not upgrade_allowed(ws, origins)
    ):
        await ws.close(code=4403)
        return
    broker.pending += 1
    pending = True
    peer: Peer | None = None
    accepted = False
    connection_slot = False
    close_code = 4401
    try:
        settings: Settings = ws.app.state.settings
        # The pending admission cap is held until off-thread verification finishes,
        # including cancellation; do not abandon threads and silently free the cap.
        email, access_exp = await access_identity(ws, settings)
        await ws.accept(subprotocol=PROTOCOL)
        accepted = True
        async with asyncio.timeout(5):
            packet = await ws.receive()
            text = packet.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > 4096:
                raise ValueError("auth frame")
            auth_frame = Authenticate.model_validate_json(text)
            store: LiveChatStore = ws.app.state.livechat_store
            auth = await validate_server_token(
                auth_frame.token,
                email=email,
                secret=ws.app.state.livechat_secret,
                store=store,
            )
        peer = Peer(auth, auth_frame.label.strip() or "Device", min(auth.exp, access_exp))
        del auth_frame, packet, text
        if auth.grant_id is not None:
            peer.grant_until = time.monotonic() + 2.5
        if broker.connections >= 8 or not broker.add(peer):
            close_code = 4429
            return
        broker.pending -= 1
        pending = False
        broker.connections += 1
        connection_slot = True
        close_code = 4403
        await run_peer(ws, broker, peer, store)
        close_code = (
            4401 if time.time() >= peer.deadline or time.monotonic() >= peer.grant_until else 1000
        )
    except (
        AccessVerificationError,
        HTTPException,
        ValueError,
        TypeError,
        RuntimeError,
        httpx.HTTPError,
        ValidationError,
        TimeoutError,
        WebSocketDisconnect,
        OSError,
    ):
        # Fixed reason/code only. Never log auth JSON, PCM, labels or validation payloads.
        pass
    finally:
        if pending:
            broker.pending -= 1
        if connection_slot:
            broker.connections -= 1
        if peer:
            broker.remove(peer)
        if accepted:
            try:
                await ws.close(code=close_code)
            except RuntimeError, OSError, WebSocketDisconnect:
                pass
        else:
            await ws.close(code=4403)
