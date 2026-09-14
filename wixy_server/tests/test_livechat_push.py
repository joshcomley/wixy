"""Tests for the P3a payloadless push primitives."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization

from wixy_server.livechat.push import (
    PUSH_TOPIC,
    PUSH_TTL_SECONDS,
    PUSH_URGENCY,
    PushEndpointError,
    PushResult,
    build_push_request,
    build_vapid_jwt,
    load_or_create_vapid_keys,
    send_payloadless_push,
    validate_push_endpoint,
)
from wixy_server.livechat.sw import server_sw_response

ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-token"
DOMAIN = "example.test"


def test_vapid_keys_are_persisted_and_jwt_verifies(tmp_path: Path) -> None:
    path = tmp_path / "vapid.json"
    keys = load_or_create_vapid_keys(path)
    loaded = load_or_create_vapid_keys(path)

    assert loaded.public_key == keys.public_key
    assert loaded.public_key_b64 == keys.public_key_b64
    document = json.loads(path.read_text(encoding="ascii"))
    assert set(document) == {"privateKeyPkcs8B64", "publicKeyB64url"}
    private_der = base64.urlsafe_b64decode(document["privateKeyPkcs8B64"] + "==")
    assert serialization.load_der_private_key(private_der, password=None) is not None
    token = build_vapid_jwt(ENDPOINT, DOMAIN, keys, now=1_700_000_000)
    claims = jwt.decode(
        token,
        keys.private_key.public_key(),
        algorithms=["ES256"],
        audience="https://fcm.googleapis.com",
        options={"verify_exp": False},
    )
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert claims["exp"] == 1_700_000_000 + 12 * 60 * 60
    assert claims["sub"] == "https://example.test"


def test_push_request_has_exact_payloadless_headers(tmp_path: Path) -> None:
    keys = load_or_create_vapid_keys(tmp_path / "vapid.json")
    request = build_push_request(ENDPOINT, DOMAIN, keys, now=1_700_000_000)

    assert request.method == "POST"
    assert request.url == httpx.URL(ENDPOINT)
    assert request.content == b""
    assert request.headers["Authorization"].startswith("vapid t=")
    assert ", k=" + keys.public_key_b64 in request.headers["Authorization"]
    assert request.headers["TTL"] == PUSH_TTL_SECONDS
    assert request.headers["Urgency"] == PUSH_URGENCY
    assert request.headers["Topic"] == PUSH_TOPIC
    assert request.headers["Content-Length"] == "0"


@pytest.mark.asyncio
async def test_sender_sends_exact_payloadless_request(tmp_path: Path) -> None:
    keys = load_or_create_vapid_keys(tmp_path / "vapid.json")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await send_payloadless_push(client, ENDPOINT, DOMAIN, keys, now=1_700_000_000)

    assert result == PushResult(status_code=201, ok=True, delete_subscription=False)
    assert len(seen) == 1
    request = seen[0]
    assert request.method == "POST"
    assert request.headers["Authorization"].startswith("vapid t=")
    assert request.headers["Authorization"].endswith(", k=" + keys.public_key_b64)
    assert request.headers["TTL"] == "86400"
    assert request.headers["Urgency"] == "high"
    assert request.headers["Topic"] == "wixy-server"
    assert request.headers["Content-Length"] == "0"
    assert request.content == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 410])
async def test_gone_response_signals_subscription_deletion(tmp_path: Path, status: int) -> None:
    keys = load_or_create_vapid_keys(tmp_path / "vapid.json")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = await send_payloadless_push(client, ENDPOINT, DOMAIN, keys, now=1_700_000_000)

    assert result.status_code == status
    assert result.ok is False
    assert result.delete_subscription is True
    assert len(seen) == 1
    assert seen[0].content == b""


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/test-token",
        "https://foreign.example.test/push",
        "https://notify.windows.com/push",
        "https://user:password@fcm.googleapis.com/push",
        "https://fcm.googleapis.com:8443/push",
    ],
)
def test_push_allowlist_rejects_unsafe_endpoints(endpoint: str) -> None:
    with pytest.raises(PushEndpointError):
        validate_push_endpoint(endpoint)


def test_windows_push_subdomain_is_allowed() -> None:
    validate_push_endpoint("https://foo.notify.windows.com/push")


def test_mozilla_push_host_is_allowed() -> None:
    validate_push_endpoint("https://updates.push.services.mozilla.com/push")


def test_public_key_is_uncompressed_p256(tmp_path: Path) -> None:
    keys = load_or_create_vapid_keys(tmp_path / "vapid.json")
    raw = base64.urlsafe_b64decode(keys.public_key_b64 + "==")
    assert len(raw) == 65
    assert raw[0] == 4


def test_service_worker_route_response_has_required_headers() -> None:
    response = server_sw_response()

    assert response.media_type == "text/javascript"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["service-worker-allowed"] == "/admin/"
