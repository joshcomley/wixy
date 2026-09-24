"""Unlock tokens + signed media URLs (spec/server-chat/00-brief.md §5.1/§5.6, R4).

wixy holds **zero PIN state** (Inv 41) — this module never sees a PIN. What it DOES
own is the per-app HMAC secret (`secret.key`, 32 random bytes, created race-safely
across slot-swap processes) and everything derived from it once cmd's PIN service
has already said yes:

- an **unlock token**, minted after a successful `POST /unlock`, held only in the
  browser's JS memory (never localStorage/sessionStorage/cookies/URLs) and required
  as the `X-Wixy-Server-Token` header on every other server-chat route;
- **signed media URLs** (`GET /media/{attId}/{rendition}?exp=&sig=`), because an
  `<img>`/`<video>`/`<audio>` element can't send a custom header.

Both are bound to the CF Access email (`request.state.access_email`) so a token
minted for one admin can't be replayed by a different one who somehow obtained it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request

SERVER_TOKEN_HEADER = "X-Wixy-Server-Token"
UNLOCK_TOKEN_TTL_S = 12 * 60 * 60.0  # §5.1: "The TTL is 12 h absolute."
_SECRET_BYTES = 32


def _locked_401() -> HTTPException:
    # A fresh instance per raise — HTTPException carries no request-specific state,
    # but reusing one module-level object across concurrent requests is still the
    # kind of shared-mutable-exception footgun not worth introducing for a cached
    # constant that saves nothing measurable.
    return HTTPException(status_code=401, detail={"error": "locked"})


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except (ValueError, TypeError) as exc:
        raise InvalidTokenError("malformed base64url") from exc


class InvalidTokenError(Exception):
    """The token/signature is malformed, tampered, expired, or bound to a different
    email than the requesting one. Callers map this to `_locked_401()`, never a raw
    exception — a locked chat and a garbage token must look identical to a bystander
    poking at devtools (§2 threat model)."""


@dataclass(frozen=True, slots=True)
class ServerAuth:
    """What `require_server_token` hands a route handler once a token checks out."""

    email: str
    exp: int


def load_or_create_secret(path: Path) -> bytes:
    """32 random bytes, created `O_EXCL` (§4: "race-safe across slot processes") —
    two blue/green processes starting near-simultaneously both attempt the create;
    exactly one wins, and the loser reads back what the winner wrote. Small
    poll-until-complete window covers the (vanishingly unlikely, but real) case
    where the loser's read races the winner's own write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as handle:
            handle.write(os.urandom(_SECRET_BYTES))
    deadline = time.monotonic() + 5.0
    while True:
        data = path.read_bytes()
        if len(data) == _SECRET_BYTES:
            return data
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"server-chat secret at {path} never reached {_SECRET_BYTES} bytes "
                "(a concurrent writer crashed mid-write?)"
            )
        time.sleep(0.01)


def mint_unlock_token(
    secret: bytes, *, email: str, now: float, ttl_s: float = UNLOCK_TOKEN_TTL_S
) -> tuple[str, float]:
    """§5.1 token format: `b64url(json{v,e,iat,exp,n}) + "." + b64url(HMAC-SHA256(
    secret, b"unlock|" + payload_b64))`. Returns `(token, expiresAt)` — the response
    body's own two fields (§5.1's `200 {"token": str, "expiresAt": float}`)."""
    iat = int(now)
    exp = int(now + ttl_s)
    payload = {"v": 1, "e": email, "iat": iat, "exp": exp, "n": secrets.token_hex(8)}
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(secret, b"unlock|" + payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url_encode(signature)}", float(exp)


def verify_unlock_token(secret: bytes, token: str, *, email: str, now: float) -> ServerAuth:
    """§5.1 "Verify: use `hmac.compare_digest`, require `exp > now`, and require
    `e == request email`." Raises `InvalidTokenError` on any of: malformed shape,
    signature mismatch, expiry, or an email that doesn't match the CURRENT request's
    CF Access identity (so a token can't outlive a change of admin on the device)."""
    try:
        token.encode("ascii")
    except UnicodeEncodeError:
        raise InvalidTokenError("malformed token encoding") from None
    try:
        payload_b64, signature_b64 = token.split(".", 1)
    except ValueError:
        raise InvalidTokenError("malformed token: no '.' separator") from None

    try:
        payload_bytes = payload_b64.encode("ascii")
    except UnicodeEncodeError:
        raise InvalidTokenError("malformed token encoding") from None
    expected_signature = hmac.new(secret, b"unlock|" + payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(_b64url_decode_signature(signature_b64), expected_signature):
        raise InvalidTokenError("signature mismatch")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidTokenError("malformed payload JSON") from exc
    if not isinstance(payload, dict):
        raise InvalidTokenError("payload is not a JSON object")

    exp = payload.get("exp")
    token_email = payload.get("e")
    if not isinstance(exp, int) or not isinstance(token_email, str):
        raise InvalidTokenError("payload missing 'exp'/'e'")
    if exp <= now:
        raise InvalidTokenError("token expired")
    if token_email != email:
        raise InvalidTokenError("token bound to a different email")
    return ServerAuth(email=token_email, exp=exp)


def _b64url_decode_signature(value: str) -> bytes:
    try:
        return _b64url_decode(value)
    except InvalidTokenError:
        # A tampered/garbage signature that isn't even valid base64url must still
        # compare-fail rather than raise a DIFFERENT exception type here — an
        # empty digest can never equal a real HMAC, so `compare_digest` against it
        # correctly falls through to "signature mismatch" above.
        return b""


def require_server_token(request: Request) -> ServerAuth:
    """The auth gate every server-chat route (except `POST /unlock` and
    `GET /media/*`, which use a signed query-string instead) calls first. Reads
    ONLY the `X-Wixy-Server-Token` header — a token passed as a query parameter is
    never looked at here, which is how §5's "a token passed as a query parameter is
    rejected" is satisfied (there's nowhere for it to be accepted from).

    Not wired through FastAPI's `Depends()` — this codebase's existing routes
    (`routes_chat.py`, `routes_admin_api.py`) all pull collaborators off
    `request.app.state`/`request.state` directly rather than via the DI graph, and
    this follows the same convention: call it explicitly as the first line of each
    handler that needs it.
    """
    token = request.headers.get(SERVER_TOKEN_HEADER)
    if not token:
        raise _locked_401()
    secret: bytes = request.app.state.livechat_secret
    email = getattr(request.state, "access_email", None) or ""
    try:
        return verify_unlock_token(secret, token, email=email, now=time.time())
    except InvalidTokenError:
        raise _locked_401() from None


@dataclass(frozen=True, slots=True)
class MediaSigner:
    """§5.6: `sig = b64url(HMAC(secret, f"media|{attId}|{rendition}|{exp}|{email}"))`,
    with `exp` fixed to the REQUESTING token's own expiry — bound once per request via
    `for_auth`, then handed to `models.message_json`/`attachment_json` so every
    attachment in a response mints its URLs against the same (email, exp) pair."""

    secret: bytes
    email: str
    exp: int

    @classmethod
    def for_auth(cls, secret: bytes, auth: ServerAuth) -> MediaSigner:
        return cls(secret=secret, email=auth.email, exp=auth.exp)

    def url_for(self, attachment_id: str, rendition: str) -> str:
        signature = sign_media_url(
            self.secret,
            attachment_id=attachment_id,
            rendition=rendition,
            exp=self.exp,
            email=self.email,
        )
        return f"/api/admin/server/media/{attachment_id}/{rendition}?exp={self.exp}&sig={signature}"


def sign_media_url(
    secret: bytes, *, attachment_id: str, rendition: str, exp: int, email: str
) -> str:
    message = f"media|{attachment_id}|{rendition}|{exp}|{email}".encode()
    return _b64url_encode(hmac.new(secret, message, hashlib.sha256).digest())


def verify_media_signature(
    secret: bytes,
    *,
    attachment_id: str,
    rendition: str,
    exp: int,
    email: str,
    signature: str,
    now: float,
) -> bool:
    """§5.6: "403 for a bad or expired signature or an email mismatch." `email` here
    is the CURRENT request's CF Access identity — the signature was minted bound to
    the email that requested it, so this call re-derives the expected signature for
    THAT SAME email and only accepts a match. Used by P2b's `GET /media/*` route."""
    if exp <= now:
        return False
    expected = sign_media_url(
        secret, attachment_id=attachment_id, rendition=rendition, exp=exp, email=email
    )
    try:
        provided = _b64url_decode(signature)
    except InvalidTokenError:
        return False
    return hmac.compare_digest(provided, _b64url_decode(expected))
