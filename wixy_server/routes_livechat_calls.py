"""Dual-gated, ephemeral call sockets; never reuse HTTP-only middleware as WS auth."""

from __future__ import annotations

import asyncio
import math
import sqlite3
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from wixy_server.auth import AccessVerificationError
from wixy_server.livechat.call_broker import CallBroker, CallCapacityError, Peer
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


async def access_identity(
    ws: WebSocket, settings: Settings, broker: CallBroker
) -> tuple[str, float]:
    if settings.dev_no_auth:
        # Same explicit development-only bypass as HTTP; never enabled in production.
        return ws.headers.get("cf-access-authenticated-user-email", ""), time.time() + 43200
    token = ws.headers.get("cf-access-jwt-assertion", "")
    if not token:
        raise ValueError("access")
    verify = ws.app.state.call_access_verifier
    # Bounded wait so a hung JWKS fetch cannot hold a pre-accept socket forever; the
    # job itself keeps its admission permit until it actually returns.
    async with asyncio.timeout(10):
        claims: dict[str, Any] = await broker.admission_work.run(lambda: verify(token))
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
            live = await broker.refresh_work.run(
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
    # 4401 tells the browser to lock: only a refused/revoked/expired credential earns it.
    # Cancellation/shutdown is 1001; a missed deadline is 4408; capacity is 4429.
    close_code = 1001
    try:
        settings: Settings = ws.app.state.settings
        # Socket slots bound sockets; broker's CallWork owners separately bound the
        # synchronous verifier/grant jobs, which outlive a cancelled or timed-out awaiter.
        email, access_exp = await access_identity(ws, settings, broker)
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
                offload=broker.admission_work.run,
            )
        peer = Peer(auth, auth_frame.label.strip() or "Device", min(auth.exp, access_exp))
        del auth_frame, packet, text
        if auth.grant_id is not None:
            peer.grant_until = time.monotonic() + 2.5
        if broker.connections >= 8 or not broker.add(peer) or not broker.permitted(peer):
            close_code = 4429
            return
        broker.pending -= 1
        pending = False
        broker.connections += 1
        connection_slot = True
        close_code = 4403
        await run_peer(ws, broker, peer, store)
        if time.time() >= peer.deadline or peer.grant_until == 0:
            close_code = 4401  # Expired session or a store-confirmed revoked grant.
        elif time.monotonic() >= peer.grant_until:
            close_code = 4408  # Refresh too slow: fail closed, but unproven revocation.
        else:
            close_code = 1000
    except CallCapacityError:
        close_code = 4429  # Server busy, not an authorization failure: never lock.
    except HTTPException:
        close_code = 4401  # The shared token/grant validator refused the credential.
    except TimeoutError:
        close_code = 4408
    except asyncio.CancelledError:
        close_code = 1001
        raise
    except httpx.HTTPError, OSError, sqlite3.Error:
        close_code = 4408
    except (
        AccessVerificationError,
        ValueError,
        TypeError,
        RuntimeError,
        ValidationError,
        WebSocketDisconnect,
    ):
        # Fixed reason/code only. Never log auth JSON, PCM, labels or validation payloads.
        close_code = 4403
    finally:
        if pending:
            broker.pending -= 1
        if connection_slot:
            broker.connections -= 1
        if peer:
            broker.remove(peer)
            if close_code != 1001:
                if time.time() >= peer.deadline or peer.grant_until == 0:
                    close_code = 4401
                elif time.monotonic() >= peer.grant_until:
                    close_code = 4408
        if accepted:
            try:
                async with asyncio.timeout(0.25):
                    await ws.close(code=close_code)
            except RuntimeError, OSError, WebSocketDisconnect, TimeoutError:
                pass
        else:
            await ws.close(code=4403)
