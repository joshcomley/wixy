"""An SSRF-safe HTTP GET (Adventure Time holiday-pack pictures, spec/server-chat/08 4.3a, Inv 56).

The holiday pack's pictures are fetched BY THIS SERVER, from addresses that an AI and third-party
web pages supplied. That makes the fetch a server-side-request-forgery surface: an address that
points at the host's own loopback, the LAN, a cloud metadata service or anything else that is not
the public internet must never be reached, however it is spelled, redirected to or re-resolved.
Everything that leaves this server for a picture or a page goes through `SafeFetcher.get`, and
nothing else in the engine fetches a URL it did not build itself.

What it guarantees (each one has a test in `test_livechat_safe_fetch.py`):

- **Only `http(s)` on ports 80/443.** The URL is parsed ONCE into its parts (`parse_fetch_url`) and
  the request is built from those parts: no second parser ever sees the string, so a differential
  between two parsers (`http://good.example\\@evil`) cannot smuggle a host past the check. Userinfo,
  control characters, backslashes, IP-literal hosts (including the decimal/hex/octal spellings),
  single-label hosts and IDNA failures are refused.
- **The address is vetted, then connected to, in ONE step.** The host is resolved exactly once,
  inside the network backend's `connect_tcp` (`_VettedBackend`); EVERY address the name resolves to
  must pass `is_public_address` (one bad record refuses the whole host: a rebinding attacker mixing
  a public and a private record gets nothing), and the socket is opened to the vetted address
  literal. There is no second lookup between the check and the connect, so DNS rebinding has no
  window. TLS still verifies the certificate against, and sends the SNI of, the HOSTNAME from the
  URL (httpcore passes the origin's host to `start_tls`, not the address we dialled); the `Host`
  header is the URL's host.
- **Redirects are followed by hand**, each one re-parsed and re-vetted like a fresh request, at
  most 3, never from `https` down to `http`.
- **Bounded:** 15 s from the moment the request actually starts (the wait for a polite turn on a
  host is not counted), the body streamed under a hard byte cap and aborted beyond it,
  `Content-Length` over the cap refused up front, `Accept-Encoding: identity` and any other
  `Content-Encoding` refused (no decompression bombs), the content type checked BEFORE the body is
  read.
- **Nothing ambient:** no cookies, no auth, no proxies from the environment, no connection reuse
  (every request re-resolves and re-vets), HTTP/1.1 only. This module drives `httpcore` directly,
  which reads no environment.
- **Polite:** one request at a time per host, at most four hosts at once, `429`/`503` honours a
  `Retry-After` of at most 10 s once and then gives up, a descriptive User-Agent with a contact URL
  (Wikimedia's policy).

Tests point it at a local fake server through the CONSTRUCTOR (`resolver`, `address_policy`,
`allowed_ports`, `ssl_context`): there is no environment variable, setting or module-level switch
that relaxes any of it; production builds `SafeFetcher()` with the defaults.
"""

from __future__ import annotations

import contextlib
import email.utils
import enum
import ipaddress
import re
import socket
import ssl
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Final
from urllib.parse import quote, urljoin, urlsplit

import anyio
import httpcore
import httpx

ALLOWED_PORTS: Final = frozenset({80, 443})
DEFAULT_PORTS: Final = {"http": 80, "https": 443}
MAX_REDIRECTS: Final = 3
FETCH_TIMEOUT_S: Final = 15.0
"""From the moment a fetch's first request starts (connect, TLS, headers, body and any redirects),
not counting the wait for a polite turn on the host."""
CONNECT_TIMEOUT_S: Final = 6.0
READ_TIMEOUT_S: Final = 10.0
MAX_PARALLEL_HOSTS: Final = 4
MAX_RETRY_AFTER_S: Final = 10.0
MAX_URL_CHARS: Final = 2048
IMAGE_MAX_BYTES: Final = 8 * 1024 * 1024
HTML_MAX_BYTES: Final = 1024 * 1024
JSON_MAX_BYTES: Final = 2 * 1024 * 1024
USER_AGENT: Final = (
    "WixyServer/1.0 (+https://github.com/joshcomley/wixy; holiday-pack picture lookup for a "
    "private household app; low volume, one request at a time per host) httpcore"
)
"""A descriptive name and a contact URL, as Wikimedia's User-Agent policy asks."""

_REDIRECT_STATUSES: Final = frozenset({301, 302, 303, 307, 308})
_RATE_LIMIT_STATUSES: Final = frozenset({429, 503})
_URL_BAD_CHARS_RE = re.compile(r"[\x00-\x20\x7f\\]")
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOST_RE = re.compile(rf"^{_LABEL}(?:\.{_LABEL})+$")
_NUMBER = r"(?:0x[0-9a-f]*|[0-9]+)"
_NUMERIC_HOST_RE = re.compile(rf"^{_NUMBER}(?:\.{_NUMBER})*$", re.IGNORECASE)
"""A host made only of numbers: the decimal / octal / hex spellings of an IPv4 address that the
system resolver would accept (`2130706433`, `0x7f.1`, `127.1`)."""
_PATH_SAFE: Final = "/%:@!$&'()*+,;=-._~"
_QUERY_SAFE: Final = "/?%:@!$&'()*+,;=-._~"

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
AddressPolicy = Callable[[IPAddress], bool]
Resolver = Callable[[str, int], Awaitable[Sequence[str]]]


class FetchFailure(enum.StrEnum):
    """Why a fetch did not produce a response (`SafeFetchError.reason`)."""

    URL = "url"
    SCHEME = "scheme"
    PORT = "port"
    HOST = "host"
    ADDRESS = "address"
    DNS = "dns"
    TLS = "tls"
    NETWORK = "network"
    TIMEOUT = "timeout"
    REDIRECT = "redirect"
    TOO_MANY_REDIRECTS = "too_many_redirects"
    STATUS = "status"
    RATE_LIMITED = "rate_limited"
    CONTENT_TYPE = "content_type"
    ENCODING = "encoding"
    TOO_LARGE = "too_large"


class SafeFetchError(Exception):
    """A fetch was refused or failed. `reason` is machine-readable; `status` is the HTTP status
    for `STATUS`/`RATE_LIMITED`. Messages never carry a response body."""

    def __init__(
        self, reason: FetchFailure, detail: str = "", *, status: int | None = None
    ) -> None:
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)
        self.reason = reason
        self.detail = detail
        self.status = status


# -- the address policy --------------------------------------------------------------------------

_V4_DENY: Final = tuple(
    ipaddress.ip_network(net)
    for net in (
        "0.0.0.0/8",  # "this network"
        "10.0.0.0/8",  # private
        "100.64.0.0/10",  # carrier-grade NAT
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local, incl. the cloud metadata address 169.254.169.254
        "172.16.0.0/12",  # private
        "192.0.0.0/24",  # IETF protocol assignments
        "192.0.2.0/24",  # documentation
        "192.88.99.0/24",  # deprecated 6to4 relay anycast
        "192.168.0.0/16",  # private
        "198.18.0.0/15",  # benchmarking
        "198.51.100.0/24",  # documentation
        "203.0.113.0/24",  # documentation
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved, incl. the broadcast address
    )
)
_V6_ALLOW: Final = ipaddress.ip_network("2000::/3")
"""Global unicast is the only IPv6 space a public host can live in; every other prefix — loopback
and unspecified, unique-local, link-local, multicast, IPv4-mapped (`::ffff:`), IPv4-compatible
(`::/96`), NAT64 (`64:ff9b::/96`), discard — is outside it and so refused by default."""
_V6_DENY: Final = tuple(
    ipaddress.ip_network(net)
    for net in (
        "2001::/23",  # IETF protocol assignments, incl. Teredo (2001::/32) and ORCHID
        "2001:db8::/32",  # documentation
        "2002::/16",  # 6to4 (an embedded IPv4 address we would have to trust)
        "3fff::/20",  # documentation
    )
)


def is_public_address(ip: IPAddress) -> bool:
    """Whether `ip` is an address a PUBLIC internet host can have. Deny by default: IPv4 must be
    globally routable (`ipaddress`'s own verdict) AND outside an explicit list of every
    special-purpose block (so a future change to `ipaddress` cannot loosen it); IPv6 must be inside
    global unicast `2000::/3` and outside the documentation / protocol / transition blocks, which
    by construction refuses IPv4-mapped and IPv4-compatible forms, NAT64, 6to4 and Teredo, whatever
    IPv4 address they embed."""
    if isinstance(ip, ipaddress.IPv4Address):
        return ip.is_global and not ip.is_multicast and not any(ip in net for net in _V4_DENY)
    return (
        ip.ipv4_mapped is None
        and ip in _V6_ALLOW
        and not any(ip in net for net in _V6_DENY)
        and ip.is_global
    )


async def system_resolver(host: str, port: int) -> list[str]:
    """The production resolver: the operating system's, through `getaddrinfo`, as address strings
    in the system's preference order (duplicates removed)."""
    try:
        infos = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as exc:
        raise SafeFetchError(FetchFailure.DNS, f"could not resolve {host}") from exc
    seen: dict[str, None] = {}
    for info in infos:
        seen[str(info[4][0])] = None
    return list(seen)


# -- parsing a URL once --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ParsedUrl:
    """A URL taken apart ONCE and validated; the request is built from these fields alone."""

    scheme: str
    host: str
    port: int
    target: str
    url: str


def parse_fetch_url(raw: str, allowed_ports: Iterable[int] = ALLOWED_PORTS) -> ParsedUrl:
    """Validate `raw` and take it apart. Raises `SafeFetchError` (`URL`/`SCHEME`/`PORT`/`HOST`) and
    nothing else: a `ValueError` from the standard library (a lone surrogate that cannot be
    percent-encoded, a malformed bracket) is a `URL` failure."""
    try:
        return _parse_fetch_url(raw, allowed_ports)
    except SafeFetchError:
        raise
    except ValueError as exc:  # includes UnicodeError
        raise SafeFetchError(FetchFailure.URL, "malformed") from exc


def _refuse_hosts(target: ParsedUrl, suffixes: Sequence[str]) -> None:
    for suffix in suffixes:
        if target.host == suffix or target.host.endswith("." + suffix):
            raise SafeFetchError(FetchFailure.HOST, f"{target.host} is not allowed here")


def _parse_fetch_url(raw: str, allowed_ports: Iterable[int]) -> ParsedUrl:
    if not isinstance(raw, str) or not raw or len(raw) > MAX_URL_CHARS:
        raise SafeFetchError(FetchFailure.URL, "empty or too long")
    if _URL_BAD_CHARS_RE.search(raw):
        raise SafeFetchError(FetchFailure.URL, "whitespace, control or backslash character")
    try:
        parts = urlsplit(raw)
        port = parts.port
        hostname = parts.hostname
    except ValueError as exc:
        raise SafeFetchError(FetchFailure.URL, "malformed") from exc
    scheme = parts.scheme.lower()
    if scheme not in DEFAULT_PORTS:
        raise SafeFetchError(FetchFailure.SCHEME, scheme or "none")
    if "@" in parts.netloc:
        raise SafeFetchError(FetchFailure.HOST, "credentials in the URL")
    if not hostname:
        raise SafeFetchError(FetchFailure.HOST, "no host")
    port_number = DEFAULT_PORTS[scheme] if port is None else port
    if port_number not in set(allowed_ports):
        raise SafeFetchError(FetchFailure.PORT, str(port_number))
    host = _clean_host(hostname)
    path = parts.path or "/"
    target = quote(path, safe=_PATH_SAFE)
    if parts.query:
        target += "?" + quote(parts.query, safe=_QUERY_SAFE)
    shown_port = "" if port_number == DEFAULT_PORTS[scheme] else f":{port_number}"
    return ParsedUrl(
        scheme=scheme,
        host=host,
        port=port_number,
        target=target,
        url=f"{scheme}://{host}{shown_port}{target}",
    )


def _clean_host(hostname: str) -> str:
    """A lower-case ASCII (IDNA) DNS name with at least one dot. IP literals in ANY spelling are
    refused — a name is the only thing worth fetching a picture from, and the resolved address is
    vetted regardless."""
    name = hostname.lower().rstrip(".")
    if not name:
        raise SafeFetchError(FetchFailure.HOST, "empty host")
    if _looks_like_address(name):
        raise SafeFetchError(FetchFailure.HOST, "an IP address, not a name")
    try:
        ascii_name = name.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise SafeFetchError(FetchFailure.HOST, "not a valid name") from exc
    # Checked again AFTER IDNA, which folds full-width digits and dots into ASCII ones.
    if _looks_like_address(ascii_name):
        raise SafeFetchError(FetchFailure.HOST, "an IP address, not a name")
    if len(ascii_name) > 253 or not _HOST_RE.match(ascii_name):
        raise SafeFetchError(FetchFailure.HOST, "not a public-style host name")
    return ascii_name


def _looks_like_address(name: str) -> bool:
    if ":" in name or _NUMERIC_HOST_RE.match(name):
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


# -- the network backend: resolve, vet and connect in one step -----------------------------------


class _VettedBackend(httpcore.AsyncNetworkBackend):
    """httpcore's network backend, with the SSRF check inside `connect_tcp`: it resolves the host,
    refuses unless EVERY address passes the policy, and dials the vetted address literal. httpcore
    still does TLS over the returned stream with `server_hostname` = the URL's host, so the
    certificate and the SNI are those of the hostname, not of the address."""

    def __init__(
        self,
        *,
        resolver: Resolver,
        policy: AddressPolicy,
        allowed_ports: frozenset[int],
    ) -> None:
        self._resolver = resolver
        self._policy = policy
        self._allowed_ports = allowed_ports
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if port not in self._allowed_ports:
            raise SafeFetchError(FetchFailure.PORT, str(port))
        addresses = await self._resolver(host, port)
        vetted: list[str] = []
        for text in addresses:
            try:
                ip = ipaddress.ip_address(text)
            except ValueError as exc:
                raise SafeFetchError(
                    FetchFailure.ADDRESS, f"{host} resolved to an unusable address"
                ) from exc
            if not self._policy(ip):
                raise SafeFetchError(
                    FetchFailure.ADDRESS, f"{host} resolves to a non-public address"
                )
            vetted.append(text)
        if not vetted:
            raise SafeFetchError(FetchFailure.DNS, f"{host} did not resolve")
        last_error: Exception | None = None
        for text in vetted:
            try:
                return await self._inner.connect_tcp(
                    text,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        assert last_error is not None
        raise last_error

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[httpcore.SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise SafeFetchError(FetchFailure.NETWORK, "unix sockets are never used")

    async def sleep(self, seconds: float) -> None:
        await anyio.sleep(seconds)


# -- the fetcher ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FetchResponse:
    """A completed fetch: the FINAL url (after redirects), the status, the media type (lower-case,
    no parameters), its charset if any, and the body (never larger than the cap)."""

    url: str
    status: int
    content_type: str
    charset: str | None
    body: bytes


@dataclass(frozen=True, slots=True)
class _Redirect:
    location: str
    status: int


@dataclass(frozen=True, slots=True)
class _RateLimited:
    wait_s: float | None
    status: int


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """A `Retry-After` header as seconds from now (a delay in seconds or an HTTP date), or `None`
    when it is absent or unreadable."""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if (
        text.isascii() and text.isdigit()
    ):  # `str.isdigit` is also true for "²" and Arabic-Indic digits
        return float(int(text)) if len(text) < 9 else None
    try:
        when = email.utils.parsedate_to_datetime(text)
        seconds = when.timestamp() - (time.time() if now is None else now)
    except TypeError, ValueError, OverflowError, OSError:  # incl. a year the platform cannot hold
        return None
    return max(0.0, seconds)


class _Gate:
    """A host's turn: a lock and how many tasks hold or await it."""

    __slots__ = ("lock", "users")

    def __init__(self) -> None:
        self.lock = anyio.Lock()
        self.users = 0


class _HostGates:
    """One request at a time per host. An entry exists only while someone holds or awaits it, so a
    stream of different hosts never grows the table."""

    def __init__(self) -> None:
        self._gates: dict[str, _Gate] = {}

    @contextlib.asynccontextmanager
    async def hold(self, host: str) -> AsyncIterator[None]:
        gate = self._gates.get(host)
        if gate is None:
            gate = self._gates[host] = _Gate()
        gate.users += 1
        try:
            async with gate.lock:
                yield
        finally:
            gate.users -= 1
            if gate.users == 0 and self._gates.get(host) is gate:
                del self._gates[host]


def _time_left(deadline_at: float) -> float:
    return max(0.0, deadline_at - anyio.current_time())


def _is_tls_failure(exc: BaseException) -> bool:
    """Whether a TLS error (a certificate that does not verify, a failed handshake) sits anywhere
    on `exc`'s cause chain."""
    current: BaseException | None = exc
    for _ in range(6):
        if current is None:
            return False
        if isinstance(current, ssl.SSLError):
            return True
        current = current.__cause__ or current.__context__
    return False


def _accept_header(accept: Sequence[str]) -> str:
    return ", ".join(f"{allowed}*" if allowed.endswith("/") else allowed for allowed in accept)


def _header_map(headers: Sequence[tuple[bytes, bytes]]) -> dict[str, str]:
    """Response headers by lower-case name, FIRST value wins (a second `Content-Type` or `Location`
    is never trusted over the first)."""
    out: dict[str, str] = {}
    for name, value in headers:
        key = name.decode("latin-1").lower()
        if key not in out:
            out[key] = value.decode("latin-1")
    return out


def _media_type(content_type: str) -> tuple[str, str | None]:
    head, _, params = content_type.partition(";")
    charset: str | None = None
    for param in params.split(";"):
        name, _, value = param.strip().partition("=")
        if name.strip().lower() == "charset":
            charset = value.strip().strip('"').lower() or None
    return head.strip().lower(), charset


def _accepts(media_type: str, accept: Sequence[str]) -> bool:
    return any(
        media_type == allowed or (allowed.endswith("/") and media_type.startswith(allowed))
        for allowed in accept
    )


class SafeFetcher:
    """The one way this server fetches a URL it did not build itself. See the module docstring."""

    def __init__(
        self,
        *,
        resolver: Resolver = system_resolver,
        address_policy: AddressPolicy = is_public_address,
        allowed_ports: Iterable[int] = ALLOWED_PORTS,
        ssl_context: ssl.SSLContext | None = None,
        user_agent: str = USER_AGENT,
        timeout_s: float = FETCH_TIMEOUT_S,
        max_parallel_hosts: int = MAX_PARALLEL_HOSTS,
    ) -> None:
        self._allowed_ports = frozenset(allowed_ports)
        self._backend = _VettedBackend(
            resolver=resolver, policy=address_policy, allowed_ports=self._allowed_ports
        )
        self._ssl_context = ssl_context
        self._user_agent = user_agent
        self._timeout_s = timeout_s
        self._max_parallel_hosts = max_parallel_hosts
        self._gates = _HostGates()
        # Created on first use, inside the running event loop.
        self._pool: httpcore.AsyncConnectionPool | None = None
        self._limiter: anyio.CapacityLimiter | None = None

    async def aclose(self) -> None:
        pool, self._pool = self._pool, None
        if pool is not None:
            await pool.aclose()

    def _connection_pool(self) -> httpcore.AsyncConnectionPool:
        if self._pool is None:
            context = (
                self._ssl_context
                if self._ssl_context is not None
                else httpx.create_ssl_context(verify=True, trust_env=False)
            )
            self._pool = httpcore.AsyncConnectionPool(
                ssl_context=context,
                max_connections=self._max_parallel_hosts * 2,
                # No keep-alive: every request opens its own connection, so every request
                # re-resolves and re-vets its host.
                max_keepalive_connections=0,
                keepalive_expiry=0.0,
                http1=True,
                http2=False,
                retries=0,
                network_backend=self._backend,
            )
        return self._pool

    def _host_limiter(self) -> anyio.CapacityLimiter:
        if self._limiter is None:
            self._limiter = anyio.CapacityLimiter(self._max_parallel_hosts)
        return self._limiter

    async def get(
        self,
        url: str,
        *,
        max_bytes: int,
        accept: Sequence[str],
        refuse_host_suffixes: Sequence[str] = (),
    ) -> FetchResponse:
        """GET `url` and return the completed response. `accept` lists the acceptable media types
        (`"image/"` = any image type); anything else is refused BEFORE the body is read.
        `refuse_host_suffixes` names domains no hop may touch — the URL itself or any redirect
        target on (or under) one is refused with `HOST` before a connection is made. Raises
        `SafeFetchError` for every refusal and failure, and nothing else."""
        target = parse_fetch_url(url, self._allowed_ports)
        _refuse_hosts(target, refuse_host_suffixes)
        deadline_at: float | None = None
        redirects = 0
        while True:
            outcome, deadline_at = await self._hop(
                target, max_bytes=max_bytes, accept=accept, deadline_at=deadline_at
            )
            if isinstance(outcome, FetchResponse):
                return outcome
            redirects += 1
            if redirects > MAX_REDIRECTS:
                raise SafeFetchError(FetchFailure.TOO_MANY_REDIRECTS, str(MAX_REDIRECTS))
            try:
                following = parse_fetch_url(
                    urljoin(target.url, outcome.location), self._allowed_ports
                )
            except ValueError as exc:  # urljoin: "Invalid IPv6 URL", a netloc failing NFKC, ...
                raise SafeFetchError(FetchFailure.REDIRECT, "malformed Location") from exc
            if target.scheme == "https" and following.scheme == "http":
                raise SafeFetchError(FetchFailure.REDIRECT, "https to http downgrade")
            _refuse_hosts(following, refuse_host_suffixes)
            target = following

    async def _hop(
        self,
        target: ParsedUrl,
        *,
        max_bytes: int,
        accept: Sequence[str],
        deadline_at: float | None,
    ) -> tuple[FetchResponse | _Redirect, float]:
        """One request to one host, holding that host's turn and one of the four global slots. A
        `429`/`503` with a `Retry-After` of at most 10 s is waited out ONCE (holding only the host's
        turn, not a global slot) and retried; anything else is the caller's."""
        retried = False
        async with self._gates.hold(target.host):
            while True:
                async with self._host_limiter():
                    if deadline_at is None:
                        deadline_at = anyio.current_time() + self._timeout_s
                    try:
                        with anyio.fail_after(_time_left(deadline_at)):
                            result = await self._request(
                                target, max_bytes=max_bytes, accept=accept, deadline_at=deadline_at
                            )
                    except TimeoutError as exc:
                        raise SafeFetchError(FetchFailure.TIMEOUT, target.host) from exc
                if not isinstance(result, _RateLimited):
                    return result, deadline_at
                wait = result.wait_s
                if retried or wait is None or wait > MAX_RETRY_AFTER_S:
                    raise SafeFetchError(
                        FetchFailure.RATE_LIMITED, target.host, status=result.status
                    )
                retried = True
                try:
                    with anyio.fail_after(_time_left(deadline_at)):
                        await anyio.sleep(wait)
                except TimeoutError as exc:
                    raise SafeFetchError(FetchFailure.TIMEOUT, target.host) from exc

    async def _request(
        self,
        target: ParsedUrl,
        *,
        max_bytes: int,
        accept: Sequence[str],
        deadline_at: float,
    ) -> FetchResponse | _Redirect | _RateLimited:
        remaining = max(0.05, _time_left(deadline_at))
        timeouts = {
            "connect": min(CONNECT_TIMEOUT_S, remaining),
            "read": min(READ_TIMEOUT_S, remaining),
            "write": min(5.0, remaining),
            "pool": min(5.0, remaining),
        }
        url = httpcore.URL(
            scheme=target.scheme.encode("ascii"),
            host=target.host.encode("ascii"),
            port=target.port,
            target=target.target.encode("ascii"),
        )
        headers = [
            ("User-Agent", self._user_agent),
            ("Accept", _accept_header(accept)),
            ("Accept-Encoding", "identity"),
        ]
        try:
            async with self._connection_pool().stream(
                "GET", url, headers=headers, extensions={"timeout": timeouts}
            ) as response:
                status = response.status
                fields = _header_map(response.headers)
                if status in _REDIRECT_STATUSES:
                    location = fields.get("location", "").strip()
                    if not location:
                        raise SafeFetchError(FetchFailure.REDIRECT, f"{status} without Location")
                    return _Redirect(location=location, status=status)
                if status in _RATE_LIMIT_STATUSES:
                    return _RateLimited(
                        wait_s=parse_retry_after(fields.get("retry-after")), status=status
                    )
                if not 200 <= status < 300:
                    raise SafeFetchError(FetchFailure.STATUS, target.host, status=status)
                encoding = fields.get("content-encoding", "identity").strip().lower()
                if encoding not in ("", "identity"):
                    raise SafeFetchError(FetchFailure.ENCODING, encoding)
                media_type, charset = _media_type(fields.get("content-type", ""))
                if not _accepts(media_type, accept):
                    raise SafeFetchError(FetchFailure.CONTENT_TYPE, media_type or "none")
                length = fields.get("content-length", "").strip()
                if length.isascii() and length.isdigit():
                    # (more than 15 digits is over any cap, and `int` refuses thousands of them)
                    if len(length) > 15 or int(length) > max_bytes:
                        raise SafeFetchError(FetchFailure.TOO_LARGE, "content-length over the cap")
                body = bytearray()
                async for chunk in response.aiter_stream():
                    body += chunk
                    if len(body) > max_bytes:
                        raise SafeFetchError(FetchFailure.TOO_LARGE, f"more than {max_bytes} bytes")
                return FetchResponse(
                    url=target.url,
                    status=status,
                    content_type=media_type,
                    charset=charset,
                    body=bytes(body),
                )
        except SafeFetchError:
            raise
        except httpcore.TimeoutException as exc:
            raise SafeFetchError(FetchFailure.TIMEOUT, target.host) from exc
        except (httpcore.NetworkError, httpcore.ProtocolError, httpcore.UnsupportedProtocol) as exc:
            if _is_tls_failure(exc):
                raise SafeFetchError(FetchFailure.TLS, target.host) from exc
            raise SafeFetchError(FetchFailure.NETWORK, target.host) from exc
        except OSError as exc:
            raise SafeFetchError(FetchFailure.NETWORK, target.host) from exc
