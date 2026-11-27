"""The host gate (spec/adventure-public/README.md §2.1, §2.6, Inv 61) — the security boundary of the
public Adventure Time host.

`AdventurePublicHostGate` is a pure ASGI middleware registered OUTERMOST (after every other
middleware, so it runs before all of them). For each HTTP or WebSocket request it reads the `Host`
header (lower-cased, port and one trailing dot stripped):

- the public host: the request is handed to the SEPARATE public application (`public_app`) and to
  nothing else — not the admin, not `/api/admin/*`, not `/internal/*`, not the site's catch-all, not
  the version routes, not the Server-chat sockets. The main application is structurally out of reach
  from this host; a path the public application does not know is a plain 404. Every response from it
  carries the hardening headers (`X-Robots-Tag: noindex`, the strict CSP, `nosniff`, the referrer
  policy), whatever the status;
- any other host: the request goes to the main application untouched (the public routes do not
  exist there, so they answer 404 like any unknown path).

A request that names the public host in ANY of several `Host` headers is public: ambiguity is
confined, never widened. The gate is only installed when `WIXY_ADVENTURE_PUBLIC_HOST` is
set, so with the feature off it does not exist.
"""

from __future__ import annotations

from typing import Final

from starlette.types import ASGIApp, Message, Receive, Scope, Send

CSP: Final = (
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)
PUBLIC_HEADERS: Final = (
    (b"x-robots-tag", b"noindex"),
    (b"content-security-policy", CSP.encode("latin-1")),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
)


def normalise_host(value: bytes | str) -> str:
    """A `Host` header value as a comparable name: lower-case, any `:port` stripped, one
    trailing dot removed. Whitespace-only or undecodable values become `""`."""
    text = value.decode("latin-1") if isinstance(value, bytes) else value
    host = text.strip().lower()
    if host.startswith("["):  # an IPv6 literal: `[::1]:8000`
        end = host.find("]")
        host = host[: end + 1] if end >= 0 else host
    else:
        host = host.partition(":")[0]
    return host.removesuffix(".")


def request_hosts(scope: Scope) -> list[str]:
    """Every normalised `Host` header of the request (usually exactly one)."""
    return [
        normalise_host(value) for name, value in scope.get("headers", ()) if name.lower() == b"host"
    ]


class AdventurePublicHostGate:
    def __init__(self, app: ASGIApp, *, host: str, public_app: ASGIApp) -> None:
        self.app = app
        self.host = normalise_host(host)
        self.public_app = public_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket") or self.host not in request_hosts(scope):
            await self.app(scope, receive, send)
            return
        if kind == "websocket":
            # No socket of any kind is public: refuse the handshake (the client sees a 403).
            await receive()
            await send({"type": "websocket.close", "code": 1008})
            return

        async def send_hardened(message: Message) -> None:
            if message["type"] == "http.response.start":
                _harden(message)
            await send(message)

        await self.public_app(scope, receive, send_hardened)


def _harden(message: Message) -> None:
    """Set the public hardening headers on a response start, replacing any the application set."""
    ours = {name for name, _ in PUBLIC_HEADERS}
    headers: list[tuple[bytes, bytes]] = [
        (bytes(key), bytes(value))
        for key, value in message.get("headers", [])
        if bytes(key).lower() not in ours
    ]
    headers.extend(PUBLIC_HEADERS)
    message["headers"] = headers
