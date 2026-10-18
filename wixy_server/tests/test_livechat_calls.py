"""Call privacy, consent, lease freshness and isolation against signed real JWTs."""

from __future__ import annotations

import functools
import json
import socket
import threading
import time
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import jwt
import pytest
import uvicorn
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from starlette.websockets import WebSocketDisconnect
from websockets.exceptions import ConnectionClosedError
from websockets.sync.client import connect as connect_socket
from websockets.typing import Origin, Subprotocol

from wixy_server.auth import JwksCache, verify_access_jwt
from wixy_server.livechat.call_broker import CallBroker, Peer
from wixy_server.livechat.call_protocol import (
    HEADER,
    SERVER_OPTIONS,
    Ack,
    CallAction,
    Invite,
    Lease,
)
from wixy_server.livechat.tokens import ServerAuth, mint_unlock_token
from wixy_server.routes_livechat_calls import router

ORIGIN = "https://example.test"
EMAIL = "admin@example.test"
SECRET = b"s" * 32


@pytest.fixture(scope="module")
def signed() -> tuple[Any, dict[str, Any]]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = "calls"
    return key, jwk


def access(key: Any, **overrides: Any) -> str:
    claims = {"email": EMAIL, "exp": time.time() + 300, "aud": "calls", "iss": ORIGIN}
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "calls"})


def app_for(jwk: dict[str, Any]) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.state.settings = SimpleNamespace(dev_no_auth=False)
    app.state.call_origins = frozenset({ORIGIN})
    app.state.livechat_call_broker = CallBroker()
    app.state.livechat_secret = SECRET
    app.state.livechat_store = SimpleNamespace(is_device_grant_live=lambda **_: True)
    app.state.call_access_verifier = functools.partial(
        verify_access_jwt,
        jwks=JwksCache(lambda: {"keys": [jwk]}),
        audience="calls",
        team_domain="example.test",
    )
    return app


@pytest.mark.parametrize("origin", [None, "null", "https://sibling.example.test"])
def test_origin_gate(signed: tuple[Any, dict[str, Any]], origin: str | None) -> None:
    key, jwk = signed
    headers = {"cf-access-jwt-assertion": access(key)}
    if origin is not None:
        headers["origin"] = origin
    with TestClient(app_for(jwk)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/api/admin/server/calls/ws", headers=headers, subprotocols=["wixy-call-v1"]
        ):
            pytest.fail("origin accepted")


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "wrong"},
        {"iss": "https://wrong.test"},
        {"email": None},
        {"exp": None},
        {"exp": time.time() - 1000},
    ],
)
def test_access_gate(signed: tuple[Any, dict[str, Any]], overrides: dict[str, Any]) -> None:
    key, jwk = signed
    with TestClient(app_for(jwk)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/api/admin/server/calls/ws",
            subprotocols=["wixy-call-v1"],
            headers={"origin": ORIGIN, "cf-access-jwt-assertion": access(key, **overrides)},
        ):
            pytest.fail("claims accepted")


@pytest.mark.parametrize(
    "token",
    ["bad", mint_unlock_token(SECRET, email="other@test", now=time.time())[0]],
    ids=["malformed", "wrong-email"],
)
def test_unlock_gate(signed: tuple[Any, dict[str, Any]], token: str) -> None:
    key, jwk = signed
    with TestClient(app_for(jwk)) as client:
        with client.websocket_connect(
            "/api/admin/server/calls/ws",
            subprotocols=["wixy-call-v1"],
            headers={"origin": ORIGIN, "cf-access-jwt-assertion": access(key)},
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": token, "label": "A"})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


def test_live_socket_pair_and_revoked_grant(signed: tuple[Any, dict[str, Any]]) -> None:
    key, jwk = signed
    app = app_for(jwk)
    headers = {"origin": ORIGIN, "cf-access-jwt-assertion": access(key)}
    token = mint_unlock_token(SECRET, email=EMAIL, now=time.time())[0]

    def receive(ws: Any, kind: str) -> dict[str, Any]:
        for _ in range(40):
            message: dict[str, Any] = ws.receive_json()
            if message["type"] == "ping":
                ws.send_json({"type": "pong"})
            if message["type"] == kind:
                return message
        raise AssertionError(f"missing {kind}")

    with TestClient(app) as client:
        with client.websocket_connect(
            "/api/admin/server/calls/ws", headers=headers, subprotocols=["wixy-call-v1"]
        ) as a:
            a.send_json({"type": "auth", "v": 1, "token": token, "label": "A"})
            receive(a, "welcome")
            with client.websocket_connect(
                "/api/admin/server/calls/ws", headers=headers, subprotocols=["wixy-call-v1"]
            ) as b:
                b.send_json({"type": "auth", "v": 1, "token": token, "label": "B"})
                target = receive(b, "welcome")["connectionId"]
                a.send_json({"type": "invite", "requestId": "one", "targetConnectionId": target})
                epoch = receive(b, "incoming")["callId"]
                b.send_json({"type": "accept", "callId": epoch})
                receive(a, "prepare")
                receive(b, "prepare")
                for ws in (a, b):
                    ws.send_json({"type": "ready", "callId": epoch})
                receive(a, "connected")
                receive(b, "connected")
                a.send_json({"type": "end", "callId": epoch})
                assert receive(b, "ended")["reason"] == "ended"
        assert not app.state.livechat_call_broker.peers
        app.state.livechat_store.is_device_grant_live = lambda **_: False
        bound = mint_unlock_token(SECRET, email=EMAIL, now=time.time(), grant_id="a" * 32)[0]
        with client.websocket_connect(
            "/api/admin/server/calls/ws", headers=headers, subprotocols=["wixy-call-v1"]
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": bound, "label": "A"})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


@pytest.mark.parametrize(
    "headers_extra,query",
    [
        ({"sec-fetch-site": "same-site"}, ""),
        ({}, "?token=bad"),
        ({"origin": "null"}, ""),
        ({"cf-access-jwt-assertion": "bad"}, ""),
    ],
)
def test_hostile_upgrade(
    signed: tuple[Any, dict[str, Any]], headers_extra: dict[str, str], query: str
) -> None:
    key, jwk = signed
    headers = {"origin": ORIGIN, "cf-access-jwt-assertion": access(key), **headers_extra}
    with TestClient(app_for(jwk)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/api/admin/server/calls/ws" + query, headers=headers, subprotocols=["wixy-call-v1"]
        ):
            pytest.fail("hostile upgrade accepted")


def test_real_uvicorn_rejects_oversized_fragmented_message(
    signed: tuple[Any, dict[str, Any]],
) -> None:
    key, jwk = signed
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app_for(jwk), log_level="critical", **SERVER_OPTIONS))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    try:
        until = time.monotonic() + 5
        while not server.started and thread.is_alive() and time.monotonic() < until:
            time.sleep(0.01)
        assert server.started
        with connect_socket(
            f"ws://127.0.0.1:{port}/api/admin/server/calls/ws",
            origin=Origin(ORIGIN),
            subprotocols=[Subprotocol("wixy-call-v1")],
            additional_headers={"cf-access-jwt-assertion": access(key)},
        ) as ws:
            with pytest.raises(ConnectionClosedError) as closed:
                ws.send(["x" * 3000, "x" * 3000])
                ws.recv(timeout=2)
            assert closed.value.rcvd and closed.value.rcvd.code == 1009
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
        assert not thread.is_alive()


def peers() -> tuple[CallBroker, Peer, Peer, Peer]:
    broker = CallBroker()
    auth = ServerAuth(EMAIL, int(time.time() + 300))
    a, b, c = [Peer(auth, label, time.time() + 300) for label in "ABC"]
    for peer in (a, b, c):
        assert broker.add(peer)
    return broker, a, b, c


def connect(broker: CallBroker, a: Peer, b: Peer) -> str:
    broker.command(a, Invite(type="invite", requestId="one", targetConnectionId=b.id))
    assert broker.call
    epoch = broker.call.id
    broker.command(b, CallAction(type="accept", callId=epoch))
    broker.command(a, CallAction(type="ready", callId=epoch))
    broker.command(b, CallAction(type="ready", callId=epoch))
    broker.tick(a)
    return epoch


def frame(epoch: str, seq: int, lease: int) -> bytes:
    return HEADER.pack(1, 1, 0, UUID(hex=epoch).bytes, seq, seq * 480, lease, 0, bytes(8)) + bytes(
        960
    )


def test_same_identity_pair_excludes_third_socket() -> None:
    broker, a, b, c = peers()
    epoch = connect(broker, a, b)
    for kind in ("accept", "end", "ready"):
        with pytest.raises(ValueError, match="ownership"):
            broker.command(c, CallAction(type=kind, callId=epoch))
    broker.command(b, Lease(type="lease", callId=epoch, lease=1))
    broker.frame(a, frame(epoch, 0, a.lease_counter))
    assert broker.next_media(b) is not None
    assert not c.media and not c.outstanding
    broker.command(b, Ack(type="ack", callId=epoch, sequence=0))
    assert not b.outstanding


def test_expired_capture_and_playout_do_not_release_old_audio() -> None:
    broker, a, b, _ = peers()
    epoch = connect(broker, a, b)
    broker.command(b, Lease(type="lease", callId=epoch, lease=1))
    a.capture_leases.clear()
    broker.frame(a, frame(epoch, 0, 1))
    assert not b.media
    broker.tick(a)
    b.playout = (1, time.monotonic() - 1)
    broker.frame(a, frame(epoch, 1, a.lease_counter))
    assert not b.media


def test_credits_and_queues_bounded_then_terminal_cleanup() -> None:
    broker, a, b, _ = peers()
    epoch = connect(broker, a, b)
    broker.command(b, Lease(type="lease", callId=epoch, lease=1))
    for seq in range(10):
        broker.frame(a, frame(epoch, seq, a.lease_counter))
    assert len(b.media) == 5
    for _ in range(5):
        assert broker.next_media(b)
    assert len(b.outstanding) == 5
    assert broker.next_media(b) is None
    broker.remove(a)
    assert broker.call is None and not b.media and not b.outstanding
    with pytest.raises(ValueError):
        broker.command(b, CallAction(type="ready", callId=epoch))


def test_expiry_during_silence_and_shutdown() -> None:
    broker, a, b, _ = peers()
    connect(broker, a, b)
    a.deadline = time.time() - 1
    broker.tick(a)
    assert a.closed and broker.call is None
    broker.shutdown()
    assert not broker.peers and b.closed


def test_disconnect_erases_the_removed_receivers_credits_and_leases() -> None:
    broker, a, b, _ = peers()
    epoch = connect(broker, a, b)
    broker.tick(b)
    broker.command(b, Lease(type="lease", callId=epoch, lease=1))
    broker.frame(a, frame(epoch, 0, a.lease_counter))
    assert broker.next_media(b) and b.outstanding and b.capture_leases
    broker.remove(b)
    assert b.closed and not b.outstanding and not b.capture_leases
    assert not b.media and not b.controls and b.playout == (0, 0)


def test_late_terminal_controls_only_ignore_the_former_pair_epoch() -> None:
    broker, a, b, c = peers()
    old = connect(broker, a, b)
    broker.finish("connection_slow")
    broker.command(a, CallAction(type="end", callId=old))
    broker.command(b, Ack(type="ack", callId=old, sequence=0))
    broker.command(a, Lease(type="lease", callId=old, lease=1))
    broker.frame(a, frame(old, 0, 1))
    assert not a.closed and not b.closed and broker.call is None and not b.media
    with pytest.raises(ValueError, match="ownership"):
        broker.command(c, CallAction(type="end", callId=old))
    broker.command(b, Invite(type="invite", requestId="fresh", targetConnectionId=a.id))
    assert broker.call
    new = broker.call.id
    broker.command(a, CallAction(type="end", callId=old))
    broker.frame(a, frame(old, 1, 1))
    with pytest.raises(ValueError):
        broker.frame(c, frame(old, 0, 1))
    assert broker.call and broker.call.id == new
    assert not a.media and not b.media and not c.media


def test_glare_and_delayed_accept_cannot_transfer_pair() -> None:
    broker, a, b, c = peers()
    broker.command(a, Invite(type="invite", requestId="one", targetConnectionId=b.id))
    assert broker.call
    epoch = broker.call.id
    broker.command(b, Invite(type="invite", requestId="crossing", targetConnectionId=a.id))
    broker.command(c, Invite(type="invite", requestId="third", targetConnectionId=a.id))
    assert broker.call and broker.call.id == epoch
    broker.finish("timeout")
    with pytest.raises(ValueError, match="ownership"):
        broker.command(b, CallAction(type="accept", callId=epoch))


def test_slow_receiver_and_control_flood_end_in_bounded_state() -> None:
    broker, a, b, _ = peers()
    epoch = connect(broker, a, b)
    broker.command(b, Lease(type="lease", callId=epoch, lease=1))
    broker.frame(a, frame(epoch, 0, a.lease_counter))
    assert broker.next_media(b)
    b.outstanding[0] = time.monotonic() - 0.6
    broker.tick(b)
    assert broker.call is None
    for _ in range(100):
        broker.emit(a, {"type": "ping"})
    assert a.closed and len(a.controls) <= 16
