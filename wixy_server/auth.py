"""CF Access JWT verification (spec/04-server.md §9).

`/admin*` and `/api/admin*` require a verified `CF-Access-Jwt-Assertion` header:
signature against the team's JWKS (cached, refreshed 6-hourly), `aud` == the
configured Access app AUD, `iss` == the team domain, and expiry. `WIXY_DEV_NO_AUTH=1`
bypasses this — `settings.load_settings` already refuses to start with that flag set
under `WIXY_ENV=prod` (spec/04 §9: "dev/test only"), so it isn't re-checked here.

Deliberately does NOT use `jwt.PyJWKClient` (which bundles fetching + caching +
key-selection behind its own internal HTTP client): keeping "fetch a JWKS document"
and "verify a token against an already-fetched JWKS" as two separate, small,
independently-testable pieces (`JwksCache` / `verify_access_jwt`) means tests supply a
hand-crafted JWKS dict with zero network mocking — the same zero-network-dependency
convention `wixy_server.checkout`'s tests already established with a real local git
repo instead of a live remote.
"""

from __future__ import annotations

import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import anyio
import jwt
from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from jwt.algorithms import RSAAlgorithm
from starlette.responses import Response

ADMIN_PATH_PREFIXES = ("/admin", "/api/admin")
CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion"
JWKS_CACHE_TTL_S = 6 * 60 * 60.0  # spec/04 §9: "cached, refreshed 6-hourly"
_ALGORITHMS = ["RS256"]


class AccessVerificationError(Exception):
    """The request's CF Access JWT is missing, malformed, signed by an unknown key, or
    fails the `aud`/`iss`/expiry checks. Callers map this to a 401/302 — never a raw
    PyJWT exception, so they don't need PyJWT's exception hierarchy."""


def is_admin_path(path: str) -> bool:
    """`/admin*` and `/api/admin*` (spec/04 §9) — prefix-matched on path segments, not
    a bare string prefix (`/admin2` must not match `/admin`)."""
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in ADMIN_PATH_PREFIXES)


def jwks_url(team_domain: str) -> str:
    return f"https://{team_domain}/cdn-cgi/access/certs"


FetchJwks = Callable[[], dict[str, Any]]


@dataclass
class JwksCache:
    """Fetch-then-cache wrapper for one team's JWKS document. `fetch` returns the raw
    JWKS response body (`{"keys": [...]}`) — production wires this to a real HTTP GET
    (`jwks_url(team_domain)`); tests wire it to a plain function returning a
    hand-crafted dict, with an injectable `now` so the 6-hour refresh boundary is
    testable without faking the system clock."""

    fetch: FetchJwks
    ttl_s: float = JWKS_CACHE_TTL_S
    _keys_by_kid: dict[str, Any] = field(default_factory=dict, init=False)
    _fetched_at: float = field(default=0.0, init=False)

    def signing_key_for(self, kid: str, *, now: float | None = None) -> Any:  # noqa: ANN401
        current = time.time() if now is None else now
        if not self._keys_by_kid or (current - self._fetched_at) >= self.ttl_s:
            self._refresh(current)
        try:
            return self._keys_by_kid[kid]
        except KeyError:
            raise AccessVerificationError(f"no known signing key for kid {kid!r}") from None

    def _refresh(self, fetched_at: float) -> None:
        data = self.fetch()
        keys: dict[str, Any] = {}
        for jwk in data.get("keys", []):
            if isinstance(jwk, dict) and isinstance(jwk.get("kid"), str):
                keys[jwk["kid"]] = RSAAlgorithm.from_jwk(json.dumps(jwk))
        self._keys_by_kid = keys
        self._fetched_at = fetched_at


def verify_access_jwt(
    token: str,
    *,
    jwks: JwksCache,
    audience: str,
    team_domain: str,
    now: float | None = None,
) -> dict[str, Any]:
    """Verify signature + `aud` + `iss` + expiry, returning the decoded claims on
    success. Signature/aud/iss/expiry are all checked by `jwt.decode` itself once
    given the right signing key — this function's own job is picking that key (by the
    token's `kid` header) and translating every failure into one exception type."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise AccessVerificationError(f"malformed JWT: {exc}") from exc

    kid = header.get("kid")
    if not isinstance(kid, str):
        raise AccessVerificationError("JWT header has no 'kid'")

    signing_key = jwks.signing_key_for(kid, now=now)
    try:
        claims: dict[str, Any] = jwt.decode(
            token,
            signing_key,
            algorithms=_ALGORITHMS,
            audience=audience,
            issuer=f"https://{team_domain}",
        )
    except jwt.PyJWTError as exc:
        raise AccessVerificationError(str(exc)) from exc
    return claims


CallNext = Callable[[Request], Awaitable[Response]]
Middleware = Callable[[Request, CallNext], Awaitable[Response]]


def _unauthorized_response(request: Request, detail: str) -> Response:
    """401 JSON on API paths, 302 to the site root on page paths (spec/04 §9)."""
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=401, content={"error": "unauthorized", "detail": detail})
    return RedirectResponse(url="/", status_code=302)


def build_admin_auth_middleware(
    *, dev_no_auth: bool, jwks: JwksCache, audience: str, team_domain: str
) -> Middleware:
    """The ASGI HTTP middleware enforcing spec/04 §9 on `/admin*` + `/api/admin*` —
    covers mounted static files too (e.g. `/admin/static/*`), since middleware wraps
    the whole ASGI app, not just FastAPI's own route dependency graph. On success,
    stashes the verified identity on `request.state.access_email` so a route handler
    that needs to attribute an edit (the draft PATCH route's `by` field) can use the
    real authenticated user instead of a placeholder."""

    async def middleware(request: Request, call_next: CallNext) -> Response:
        if not is_admin_path(request.url.path):
            return await call_next(request)
        if dev_no_auth:
            return await call_next(request)

        token = request.headers.get(CF_ACCESS_JWT_HEADER)
        if not token:
            return _unauthorized_response(request, "missing CF-Access-Jwt-Assertion header")

        def _verify() -> dict[str, Any]:
            return verify_access_jwt(token, jwks=jwks, audience=audience, team_domain=team_domain)

        try:
            claims = await anyio.to_thread.run_sync(_verify)
        except AccessVerificationError as exc:
            return _unauthorized_response(request, str(exc))

        email = claims.get("email")
        request.state.access_email = email if isinstance(email, str) else claims.get("sub")
        return await call_next(request)

    return middleware
