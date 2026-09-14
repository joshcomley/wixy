"""Payloadless Web Push primitives for the private Server panel.

The dispatch loop intentionally lives elsewhere.  This module owns only the
VAPID key file, strict endpoint validation, and one request/response operation
so callers can apply their own concurrency and subscription policy.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from urllib.parse import SplitResult, urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

VAPID_TTL_SECONDS: Final[int] = 12 * 60 * 60
PUSH_TTL_SECONDS: Final[str] = "86400"
PUSH_URGENCY: Final[str] = "high"
PUSH_TOPIC: Final[str] = "wixy-server"
_P256: Final[ec.SECP256R1] = ec.SECP256R1()

_EXACT_PUSH_HOSTS: Final[frozenset[str]] = frozenset(
    {
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
    }
)
_WINDOWS_PUSH_SUFFIX: Final[str] = ".notify.windows.com"


class PushEndpointError(ValueError):
    """Raised when a subscription endpoint is outside the push trust boundary."""


@dataclass(frozen=True, slots=True)
class VapidKeys:
    """A P-256 VAPID key pair and its browser-compatible public encoding."""

    private_key: ec.EllipticCurvePrivateKey
    public_key: bytes

    @property
    def public_key_b64(self) -> str:
        """Return the uncompressed P-256 point in base64url form."""

        return _b64url_encode(self.public_key)


@dataclass(frozen=True, slots=True)
class PushResult:
    """Outcome of one push attempt for the P3b dispatch loop."""

    status_code: int
    ok: bool
    delete_subscription: bool

    @property
    def should_delete(self) -> bool:
        """Compatibility spelling for dispatch callers expressing the action."""

        return self.delete_subscription


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: object) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("invalid VAPID key material")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid VAPID key material") from exc


def _public_bytes(private_key: ec.EllipticCurvePrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )


def _key_document(keys: VapidKeys) -> bytes:
    document = {
        "privateKey": _b64url_encode(
            keys.private_key.private_numbers().private_value.to_bytes(32, "big")
        ),
        "publicKey": keys.public_key_b64,
    }
    return (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def _keys_from_document(raw: bytes) -> VapidKeys:
    try:
        document = json.loads(raw.decode("ascii"))
        private_bytes = _b64url_decode(document["privateKey"])
        public_bytes = _b64url_decode(document["publicKey"])
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid VAPID key file") from exc

    if len(private_bytes) != 32:
        raise ValueError("invalid VAPID private key length")
    try:
        private_key = ec.derive_private_key(int.from_bytes(private_bytes, "big"), _P256)
    except ValueError as exc:
        raise ValueError("invalid VAPID private key") from exc
    derived_public = _public_bytes(private_key)
    if public_bytes != derived_public:
        raise ValueError("VAPID public key does not match private key")
    return VapidKeys(private_key=private_key, public_key=public_bytes)


def _read_key_file(path: Path) -> VapidKeys:
    """Read a key file, tolerating the tiny window of another writer's fsync."""

    deadline = time.monotonic() + 1.0
    while True:
        try:
            return _keys_from_document(path.read_bytes())
        except (OSError, ValueError) as exc:
            if time.monotonic() >= deadline:
                raise ValueError(f"could not read VAPID key file: {path}") from exc
            time.sleep(0.01)


def load_or_create_vapid_keys(path: Path) -> VapidKeys:
    """Load VAPID keys, creating them exactly once with an exclusive file open.

    ``O_EXCL`` protects blue/green processes from replacing each other's key
    material.  A process that loses the race reads the winner's complete file.
    """

    if path.exists():
        return _read_key_file(path)

    path.parent.mkdir(parents=True, exist_ok=True)
    private_key = ec.generate_private_key(_P256)
    keys = VapidKeys(private_key=private_key, public_key=_public_bytes(private_key))
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _read_key_file(path)

    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(_key_document(keys))
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    return keys


def generate_vapid_keys(path: Path) -> VapidKeys:
    """Named alias used by callers that treat key creation as generation."""

    return load_or_create_vapid_keys(path)


def _validated_endpoint(endpoint: str) -> SplitResult:
    try:
        parsed = urlsplit(endpoint)
        host = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise PushEndpointError("invalid push endpoint") from exc

    if parsed.scheme.lower() != "https" or host is None:
        raise PushEndpointError("push endpoint must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise PushEndpointError("push endpoint credentials are not allowed")
    if port not in (None, 443):
        raise PushEndpointError("push endpoint must use HTTPS port 443")

    normalized_host = host.rstrip(".").lower()
    windows_subdomain = normalized_host.endswith(_WINDOWS_PUSH_SUFFIX) and normalized_host not in {
        "",
        _WINDOWS_PUSH_SUFFIX,
    }
    if normalized_host.startswith(".") or (
        normalized_host not in _EXACT_PUSH_HOSTS and not windows_subdomain
    ):
        raise PushEndpointError("push endpoint host is not allowlisted")
    return parsed


def validate_push_endpoint(endpoint: str) -> None:
    """Validate a subscription endpoint without performing network I/O."""

    _validated_endpoint(endpoint)


def _endpoint_origin(parsed: SplitResult) -> str:
    # URL origins use the canonical hostname and omit the default HTTPS port.
    host = parsed.hostname
    if host is None:  # pragma: no cover - _validated_endpoint already rejects it
        raise PushEndpointError("push endpoint must include a host")
    return f"https://{host.rstrip('.').lower()}"


def build_vapid_jwt(
    endpoint: str,
    project_domain: str,
    keys: VapidKeys,
    *,
    now: int | float | None = None,
) -> str:
    """Create the short-lived ES256 VAPID JWT for ``endpoint``."""

    parsed = _validated_endpoint(endpoint)
    issued_at = int(time.time() if now is None else now)
    domain = project_domain.strip().strip("/")
    if not domain or "://" in domain:
        raise ValueError("project domain must be a hostname")
    token = jwt.encode(
        {
            "aud": _endpoint_origin(parsed),
            "exp": issued_at + VAPID_TTL_SECONDS,
            "sub": f"https://{domain}",
        },
        keys.private_key,
        algorithm="ES256",
    )
    return token if isinstance(token, str) else token.decode("ascii")


def build_push_request(
    endpoint: str,
    project_domain: str,
    keys: VapidKeys,
    *,
    now: int | float | None = None,
) -> httpx.Request:
    """Build the payloadless push request after validating its destination."""

    token = build_vapid_jwt(endpoint, project_domain, keys, now=now)
    authorization = f"vapid t={token}, k={keys.public_key_b64}"
    return httpx.Request(
        "POST",
        endpoint,
        headers={
            "Authorization": authorization,
            "TTL": PUSH_TTL_SECONDS,
            "Urgency": PUSH_URGENCY,
            "Topic": PUSH_TOPIC,
            "Content-Length": "0",
        },
        content=b"",
    )


async def send_payloadless_push(
    client: httpx.AsyncClient,
    endpoint: str,
    project_domain: str,
    keys: VapidKeys,
    *,
    now: int | float | None = None,
) -> PushResult:
    """Send one push and return the subscription action for the dispatch loop."""

    request = build_push_request(endpoint, project_domain, keys, now=now)
    response = await client.send(request)
    status = response.status_code
    await response.aclose()
    return PushResult(
        status_code=status,
        ok=status == 201,
        delete_subscription=status in (404, 410),
    )


__all__ = [
    "PUSH_TOPIC",
    "PUSH_TTL_SECONDS",
    "PUSH_URGENCY",
    "PushEndpointError",
    "PushResult",
    "VapidKeys",
    "build_push_request",
    "build_vapid_jwt",
    "generate_vapid_keys",
    "load_or_create_vapid_keys",
    "send_payloadless_push",
    "validate_push_endpoint",
]
