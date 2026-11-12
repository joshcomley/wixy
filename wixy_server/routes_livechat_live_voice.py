"""`/api/admin/server/live-voice/ws` — the live-voice listener socket
(spec/server-chat/07-live-voice-notes.md §6.2, Inv 58).

Authorised exactly as the call socket (`routes_livechat_calls.py`, Inv 55): the upgrade's origin /
subprotocol gate, the Cloudflare Access assertion verified before the socket is accepted, then the
unlock token (and its device grant, re-checked every two seconds) in the first frame. Every page
uses ONE socket and multiplexes the live notes it shows. Audio, peaks and state are ephemeral:
nothing here writes to the database or logs a label, token or payload.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from wixy_server.auth import AccessVerificationError
from wixy_server.livechat.call_broker import CallCapacityError
from wixy_server.livechat.call_protocol import Authenticate
from wixy_server.livechat.grants import GRANT_IDLE_EXPIRY_S
from wixy_server.livechat.live_voice import (
    MAX_LISTENERS,
    MAX_PENDING_LISTENERS,
    Listener,
    LiveVoiceHub,
)
from wixy_server.livechat.live_voice_protocol import COMMAND, PROTOCOL
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import validate_server_token
from wixy_server.routes_livechat_calls import access_identity, upgrade_allowed
from wixy_server.settings import Settings

router = APIRouter()

_MAX_CONTROL_BYTES = 4096
_SEND_TIMEOUT_S = 0.5


async def run_listener(
    ws: WebSocket, hub: LiveVoiceHub, listener: Listener, store: LiveChatStore
) -> None:
    async def read() -> None:
        while not listener.closed:
            packet = await ws.receive()
            if packet["type"] == "websocket.disconnect":
                return
            text = packet.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > _MAX_CONTROL_BYTES:
                raise ValueError("control size")  # binary or oversized: never legitimate
            try:
                command = COMMAND.validate_json(text)
            except ValidationError:
                hub.report_bad_request(listener)
                continue
            await hub.command(listener, command)
            listener.wake.set()

    async def write() -> None:
        while not listener.closed:
            # Clear before inspecting the queues: no lost wake between the empty check and the wait.
            listener.wake.clear()
            if not hub.permitted(listener):
                return
            message = hub.next_message(listener)
            if message is None:
                await listener.wake.wait()
                continue
            async with asyncio.timeout(_SEND_TIMEOUT_S):
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                else:
                    await ws.send_json(message)

    async def monitor() -> None:
        while not listener.closed:
            hub.tick_listener(listener)
            await asyncio.sleep(0.1)

    async def grants() -> None:
        if listener.auth.grant_id is None:
            await asyncio.Future[None]()
        while not listener.closed:
            live = await hub.refresh_work.run(
                lambda: store.is_device_grant_live(
                    grant_id=listener.auth.grant_id or "",
                    email=listener.auth.email,
                    now=time.time(),
                    max_idle_s=GRANT_IDLE_EXPIRY_S,
                )
            )
            if not live:
                listener.grant_until = 0
                return
            listener.grant_until = time.monotonic() + 2.5
            await asyncio.sleep(2)

    tasks = [asyncio.create_task(fn()) for fn in (read, write, monitor, grants)]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        hub.remove_listener(listener)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@router.websocket("/api/admin/server/live-voice/ws")
async def live_voice_socket(ws: WebSocket) -> None:
    hub: LiveVoiceHub = ws.app.state.livechat_live_voice
    origins: frozenset[str] = ws.app.state.call_origins
    if (
        hub.closed
        or hub.pending >= MAX_PENDING_LISTENERS
        or hub.connections >= MAX_LISTENERS
        or not upgrade_allowed(ws, origins, PROTOCOL)
    ):
        await ws.close(code=4403)
        return
    hub.pending += 1
    pending = True
    listener: Listener | None = None
    accepted = False
    connection_slot = False
    # The call socket's close codes: 4401 locks the browser (only a refused/revoked/expired
    # credential earns it), 4429 is capacity, 4408 a missed deadline, 1001 shutdown.
    close_code = 1001
    try:
        settings: Settings = ws.app.state.settings
        email, access_exp = await access_identity(ws, settings, hub.admission_work)
        await ws.accept(subprotocol=PROTOCOL)
        accepted = True
        async with asyncio.timeout(5):
            packet = await ws.receive()
            text = packet.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > _MAX_CONTROL_BYTES:
                raise ValueError("auth frame")
            auth_frame = Authenticate.model_validate_json(text)
            store: LiveChatStore = ws.app.state.livechat_store
            auth = await validate_server_token(
                auth_frame.token,
                email=email,
                secret=ws.app.state.livechat_secret,
                store=store,
                offload=hub.admission_work.run,
            )
        listener = Listener(auth, auth_frame.label.strip() or "Device", min(auth.exp, access_exp))
        del auth_frame, packet, text
        if auth.grant_id is not None:
            listener.grant_until = time.monotonic() + 2.5
        if (
            hub.connections >= MAX_LISTENERS
            or not hub.add_listener(listener)
            or not hub.permitted(listener)
        ):
            close_code = 4429
            return
        hub.pending -= 1
        pending = False
        hub.connections += 1
        connection_slot = True
        close_code = 4403
        await run_listener(ws, hub, listener, store)
        if time.time() >= listener.deadline or listener.grant_until == 0:
            close_code = 4401  # Expired session or a store-confirmed revoked grant.
        elif time.monotonic() >= listener.grant_until:
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
        # Fixed code only. Never log auth JSON, PCM, labels or validation payloads.
        close_code = 4403
    finally:
        if pending:
            hub.pending -= 1
        if connection_slot:
            hub.connections -= 1
        if listener:
            hub.remove_listener(listener)
            if close_code != 1001:
                if time.time() >= listener.deadline or listener.grant_until == 0:
                    close_code = 4401
                elif time.monotonic() >= listener.grant_until:
                    close_code = 4408
        if accepted:
            try:
                async with asyncio.timeout(0.25):
                    await ws.close(code=close_code)
            except RuntimeError, OSError, WebSocketDisconnect, TimeoutError:
                pass
        else:
            await ws.close(code=4403)
