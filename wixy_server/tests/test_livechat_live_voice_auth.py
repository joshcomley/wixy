"""The live-voice listener socket's authorisation, against signed real JWTs: the same two gates as
the call socket (Inv 55) — the upgrade's origin / subprotocol rules, the Cloudflare Access assertion
before the socket is accepted, the unlock token (and its device grant) in the first frame — and the
same close codes (4401 locks the browser, 4403 a refusal, 4429 capacity), plus the ping the server
sends and the 4401 on expiry or revocation.
"""

from __future__ import annotations

import functools
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from starlette.websockets import WebSocketDisconnect

from wixy_server.auth import JwksCache, verify_access_jwt
from wixy_server.livechat.live_voice import LiveVoiceHub
from wixy_server.livechat.notifier import LiveChatNotifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.livechat.tokens import mint_unlock_token
from wixy_server.routes_livechat_live_voice import router
from wixy_server.storage import ProjectPaths

ORIGIN = "https://example.test"
EMAIL = "admin@example.test"
SECRET = b"s" * 32
PATH = "/api/admin/server/live-voice/ws"
PROTOCOL = "wixy-live-voice-v1"


@pytest.fixture(scope="module")
def signed() -> tuple[Any, dict[str, Any]]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk["kid"] = "live"
    return key, jwk


def access(key: Any, **overrides: Any) -> str:
    claims = {"email": EMAIL, "exp": time.time() + 300, "aud": "live", "iss": ORIGIN}
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "live"})


def app_for(jwk: dict[str, Any], tmp_path: Path) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    store = LiveChatStore(tmp_path / "server" / "server.db")
    app.state.settings = SimpleNamespace(dev_no_auth=False)
    app.state.call_origins = frozenset({ORIGIN})
    app.state.livechat_live_voice = LiveVoiceHub(
        store=store,
        paths=ProjectPaths(slug="t", root=tmp_path / "storage"),
        notifier=LiveChatNotifier(),
        ffmpeg=None,
        chunk_bytes=1 << 20,
    )
    app.state.livechat_secret = SECRET
    app.state.livechat_store = SimpleNamespace(is_device_grant_live=lambda **_: True)
    app.state.call_access_verifier = functools.partial(
        verify_access_jwt,
        jwks=JwksCache(lambda: {"keys": [jwk]}),
        audience="live",
        team_domain="example.test",
    )
    return app


def token(**kwargs: Any) -> str:
    return mint_unlock_token(SECRET, email=EMAIL, now=time.time(), **kwargs)[0]


def headers_for(key: Any, **extra: str) -> dict[str, str]:
    return {"origin": ORIGIN, "cf-access-jwt-assertion": access(key), **extra}


def receive_until(ws: Any, kind: str, *, pings: list[int] | None = None) -> dict[str, Any]:
    for _ in range(80):
        message: dict[str, Any] = ws.receive_json()
        if message["type"] == "ping":
            if pings is not None:
                pings.append(1)
            ws.send_json({"type": "pong"})
        if message["type"] == kind:
            return message
    raise AssertionError(f"no {kind}")


@pytest.mark.parametrize("origin", [None, "null", "https://sibling.example.test"])
def test_origin_gate(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path, origin: str | None
) -> None:
    key, jwk = signed
    headers = {"cf-access-jwt-assertion": access(key)}
    if origin is not None:
        headers["origin"] = origin
    with TestClient(app_for(jwk, tmp_path)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(PATH, headers=headers, subprotocols=[PROTOCOL]):
            pytest.fail("origin accepted")


def test_the_calls_subprotocol_is_not_this_socket(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path
) -> None:
    key, jwk = signed
    with TestClient(app_for(jwk, tmp_path)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=["wixy-call-v1"]
        ):
            pytest.fail("wrong subprotocol accepted")


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
def test_access_gate(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path, overrides: dict[str, Any]
) -> None:
    key, jwk = signed
    headers = {"origin": ORIGIN, "cf-access-jwt-assertion": access(key, **overrides)}
    with TestClient(app_for(jwk, tmp_path)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(PATH, headers=headers, subprotocols=[PROTOCOL]):
            pytest.fail("claims accepted")


@pytest.mark.parametrize(
    "bad",
    [
        "bad",
        mint_unlock_token(SECRET, email="other@test", now=time.time())[0],
        mint_unlock_token(SECRET, email=EMAIL, now=time.time() - 10_000, ttl_s=60)[0],
    ],
    ids=["malformed", "wrong-email", "expired"],
)
def test_unlock_gate_refuses_with_4401_so_the_browser_locks(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path, bad: str
) -> None:
    key, jwk = signed
    with TestClient(app_for(jwk, tmp_path)) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": bad, "label": "A"})
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4401


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "auth", "v": 2, "token": "x", "label": "A"},
        {"type": "auth", "v": 1, "token": "x", "label": ""},
        {"type": "auth", "v": 1, "token": "x", "label": "A", "extra": 1},
        {"type": "watch", "attachmentId": "a" * 32},
    ],
)
def test_a_malformed_first_frame_is_refused_with_4403(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path, frame: dict[str, Any]
) -> None:
    key, jwk = signed
    with TestClient(app_for(jwk, tmp_path)) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json(frame)
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4403


@pytest.mark.parametrize(
    ("extra", "query"),
    [
        ({"sec-fetch-site": "same-site"}, ""),
        ({}, "?token=bad"),
        ({"origin": "null"}, ""),
        ({"cf-access-jwt-assertion": "bad"}, ""),
    ],
)
def test_hostile_upgrade(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path, extra: dict[str, str], query: str
) -> None:
    key, jwk = signed
    with TestClient(app_for(jwk, tmp_path)) as client, pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            PATH + query, headers=headers_for(key, **extra), subprotocols=[PROTOCOL]
        ):
            pytest.fail("hostile upgrade accepted")


def test_an_authorised_socket_is_told_ready_and_is_pinged_until_it_pongs(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path
) -> None:
    key, jwk = signed
    app = app_for(jwk, tmp_path)
    pings: list[int] = []
    with TestClient(app) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": token(), "label": "Phone"})
            assert receive_until(ws, "ready", pings=pings) == {"type": "ready"}
            receive_until(ws, "ping", pings=pings)  # the server pings, as the call socket does
            assert pings
        assert not app.state.livechat_live_voice.listeners


def test_a_listener_that_never_pongs_is_dropped(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path
) -> None:
    key, jwk = signed
    app = app_for(jwk, tmp_path)
    with TestClient(app) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": token(), "label": "Phone"})
            receive_until(ws, "ready")
            (listener,) = app.state.livechat_live_voice.listeners.values()
            listener.pong_at -= 10  # the last pong was long ago
            with pytest.raises(WebSocketDisconnect):
                for _ in range(40):
                    ws.receive_json()


def test_an_expired_session_closes_the_socket_with_4401(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path
) -> None:
    key, jwk = signed
    app = app_for(jwk, tmp_path)
    with TestClient(app) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": token(), "label": "Phone"})
            receive_until(ws, "ready")
            (listener,) = app.state.livechat_live_voice.listeners.values()
            listener.deadline = time.time() - 1  # the token (or Access session) has run out
            with pytest.raises(WebSocketDisconnect) as closed:
                for _ in range(40):
                    receive_until(ws, "never")
            assert closed.value.code == 4401


def test_a_revoked_device_grant_closes_the_socket_with_4401(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path
) -> None:
    key, jwk = signed
    app = app_for(jwk, tmp_path)
    bound = token(grant_id="a" * 32)
    with TestClient(app) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json({"type": "auth", "v": 1, "token": bound, "label": "Phone"})
            receive_until(ws, "ready")
            app.state.livechat_store.is_device_grant_live = lambda **_: False
            with pytest.raises(WebSocketDisconnect) as closed:
                for _ in range(60):
                    receive_until(ws, "never")
            assert closed.value.code == 4401


def test_a_grant_revoked_before_the_first_frame_is_refused_with_4401(
    signed: tuple[Any, dict[str, Any]], tmp_path: Path
) -> None:
    key, jwk = signed
    app = app_for(jwk, tmp_path)
    app.state.livechat_store.is_device_grant_live = lambda **_: False
    with TestClient(app) as client:
        with client.websocket_connect(
            PATH, headers=headers_for(key), subprotocols=[PROTOCOL]
        ) as ws:
            ws.send_json(
                {"type": "auth", "v": 1, "token": token(grant_id="a" * 32), "label": "Phone"}
            )
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 4401
