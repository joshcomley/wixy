"""A programmable local web server for the holiday-pack picture tests and the e2e fixture
(workspace 00056, spec/server-chat/08-adventure-time.md §4.3a).

One server answers for MANY host names (it routes on the request's `Host` header), so a test can
make `en.wikipedia.org`, `commons.wikimedia.org`, `thumb.wikimedia.org` and a venue's own site all
resolve to it through the `SafeFetcher`'s injected resolver — no real network, and no production
code path that relaxes the SSRF policy (the policy is injected through the fetcher's constructor).

It is deliberately raw (`asyncio.start_server`, hand-written HTTP/1.1) rather than a framework app:
the tests need responses that misbehave on purpose — an endless body, a trickling body, a lying
`Content-Length`, a redirect loop, a `Retry-After` — and a recording of exactly what was sent
(the `Host` header, the `User-Agent`, the TLS server name).
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime
import ssl
import threading
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


@dataclass
class Reply:
    """What the server sends for one request."""

    status: int = 200
    body: bytes = b""
    content_type: str | None = "text/plain"
    headers: dict[str, str] = field(default_factory=dict)
    delay_s: float = 0.0
    """Wait this long before answering at all."""
    trickle_s: float = 0.0
    """Sleep this long between 1 KiB pieces of the body (a slow server)."""
    endless: bool = False
    """Send zeros until the client hangs up (a body with no end)."""
    content_length: int | None = None
    """Override the `Content-Length` header (a lying server); `-1` omits it."""
    chunked: bool = False


@dataclass
class SeenRequest:
    host: str
    """The `Host` header, port stripped, lower-case."""
    host_header: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    """Request headers by lower-case name."""
    sni: str | None
    """The TLS server name the client sent, when the server was started with TLS."""
    at: float
    """`time.monotonic()` when the request head arrived."""
    done_at: float = 0.0


Handler = Callable[[SeenRequest], Reply | Awaitable[Reply]]
Route = Reply | Handler

_REASONS = {
    200: "OK",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    403: "Forbidden",
    404: "Not Found",
    429: "Too Many Requests",
    500: "Internal Server Error",
    503: "Service Unavailable",
}


class FakeWeb:
    """The server. `add(host, path, route)` registers an exact `(host, path)` (query ignored); an
    unknown route is a `404`. `requests` records every request in arrival order."""

    def __init__(self) -> None:
        self._routes: dict[tuple[str, str], Route] = {}
        self.requests: list[SeenRequest] = []
        self.port = 0
        self._server: asyncio.Server | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._in_flight = 0
        self.max_in_flight = 0
        self._in_flight_by_host: dict[str, int] = {}
        self.max_in_flight_by_host: dict[str, int] = {}
        self._snis: weakref.WeakKeyDictionary[ssl.SSLObject, str | None] = (
            weakref.WeakKeyDictionary()
        )

    def add(self, host: str, path: str, route: Route) -> None:
        self._routes[(host.lower(), path)] = route

    def seen(self, host: str | None = None, path: str | None = None) -> list[SeenRequest]:
        return [
            r
            for r in self.requests
            if (host is None or r.host == host.lower()) and (path is None or r.path == path)
        ]

    # -- lifecycle -----------------------------------------------------------------------------

    async def start(self, ssl_context: ssl.SSLContext | None = None) -> int:
        """Listen on an ephemeral loopback port (call from the running event loop)."""
        if ssl_context is not None:
            ssl_context.sni_callback = self._record_sni
        self._server = await asyncio.start_server(
            self._handle, host="127.0.0.1", port=0, ssl=ssl_context
        )
        sockets = self._server.sockets
        assert sockets
        self.port = int(sockets[0].getsockname()[1])
        return self.port

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            self._server.abort_clients()  # a deliberately stuck handler must not hold the test up
            # On Windows (Proactor) a connection the client reset can fail inside asyncio's
            # `_call_connection_lost` before the server is told it detached, and `wait_closed`
            # would then never return; the listener is closed either way, so bound the wait.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._server.wait_closed(), 1.0)
            self._server = None

    def start_threaded(self, ssl_context: ssl.SSLContext | None = None) -> int:
        """Run the server in its own thread + event loop (the e2e fixture), returning the port."""
        ready = threading.Event()
        failure: list[BaseException] = []

        def _run() -> None:
            loop = asyncio.new_event_loop()
            self._loop = loop
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(self.start(ssl_context))
            except BaseException as exc:
                failure.append(exc)
                ready.set()
                return
            ready.set()
            loop.run_forever()

        self._thread = threading.Thread(target=_run, name="fake-web", daemon=True)
        self._thread.start()
        assert ready.wait(10.0), "the fake web server did not start"
        if failure:
            raise failure[0]
        return self.port

    def stop_threaded(self) -> None:
        loop = self._loop
        if loop is None:
            return
        asyncio.run_coroutine_threadsafe(self.stop(), loop).result(10.0)
        loop.call_soon_threadsafe(loop.stop)
        if self._thread is not None:
            self._thread.join(10.0)

    # -- serving -------------------------------------------------------------------------------

    def _record_sni(
        self, ssl_object: ssl.SSLObject, server_name: str | None, context: ssl.SSLContext
    ) -> None:
        """Remember the TLS server name the client sent (asyncio hands the handler the same
        `SSLObject`, so it reads it back through `get_extra_info("ssl_object")`)."""
        self._snis[ssl_object] = server_name

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        method, target, _version = lines[0].split(" ", 2)
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, _, value = line.partition(":")
                headers.setdefault(name.strip().lower(), value.strip())
        host_header = headers.get("host", "")
        host = host_header.rsplit(":", 1)[0].lower() if ":" in host_header else host_header.lower()
        parts = urlsplit(target)
        ssl_object = writer.get_extra_info("ssl_object")
        sni = self._snis.get(ssl_object) if ssl_object is not None else None
        loop = asyncio.get_running_loop()
        request = SeenRequest(
            host=host,
            host_header=host_header,
            path=parts.path,
            query=parse_qs(parts.query),
            headers=headers,
            sni=sni,
            at=loop.time(),
        )
        self.requests.append(request)
        self._in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self._in_flight)
        by_host = self._in_flight_by_host.get(host, 0) + 1
        self._in_flight_by_host[host] = by_host
        self.max_in_flight_by_host[host] = max(self.max_in_flight_by_host.get(host, 0), by_host)
        try:
            route = self._routes.get((host, parts.path))
            if route is None:
                reply = Reply(status=404, body=b"not found", content_type="text/plain")
            elif isinstance(route, Reply):
                reply = route
            else:
                produced = route(request)
                reply = await produced if isinstance(produced, Awaitable) else produced
            if method != "GET":
                reply = Reply(status=405, body=b"", content_type=None)
            await self._send(writer, reply)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            request.done_at = loop.time()
            self._in_flight -= 1
            self._in_flight_by_host[host] -= 1
            try:
                writer.close()
            except OSError:
                pass

    async def _send(self, writer: asyncio.StreamWriter, reply: Reply) -> None:
        if reply.delay_s:
            await asyncio.sleep(reply.delay_s)
        out = [f"HTTP/1.1 {reply.status} {_REASONS.get(reply.status, 'Status')}"]
        headers = {k.lower(): v for k, v in reply.headers.items()}
        if reply.content_type is not None and "content-type" not in headers:
            headers["content-type"] = reply.content_type
        headers["connection"] = "close"
        if reply.chunked:
            headers["transfer-encoding"] = "chunked"
        elif reply.endless:
            pass
        elif reply.content_length == -1:
            pass
        else:
            length = len(reply.body) if reply.content_length is None else reply.content_length
            headers["content-length"] = str(length)
        out.extend(f"{name}: {value}" for name, value in headers.items())
        writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
        await writer.drain()
        if reply.endless:
            piece = b"\0" * 65536
            while True:
                writer.write(piece)
                await writer.drain()
        pieces = (
            [reply.body[i : i + 1024] for i in range(0, len(reply.body), 1024)]
            if reply.trickle_s
            else [reply.body]
        )
        for piece in pieces:
            if reply.chunked:
                writer.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
            else:
                writer.write(piece)
            await writer.drain()
            if reply.trickle_s:
                await asyncio.sleep(reply.trickle_s)
        if reply.chunked:
            writer.write(b"0\r\n\r\n")
            await writer.drain()


# -- a throwaway certificate authority, for the TLS tests ------------------------------------------


@dataclass(frozen=True)
class TestCertificates:
    """A throwaway CA and a server certificate for `names`, as files, plus client/server contexts."""

    __test__ = False  # not a pytest class

    ca_file: Path
    cert_file: Path
    key_file: Path

    def server_context(self) -> ssl.SSLContext:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.cert_file), str(self.key_file))
        return context

    def client_context(self) -> ssl.SSLContext:
        """A normal VERIFYING client context that trusts only the throwaway CA."""
        context = ssl.create_default_context(cafile=str(self.ca_file))
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
        return context


def make_test_certificates(directory: Path, names: list[str]) -> TestCertificates:
    """Create a CA and a leaf certificate valid for `names` under `directory`."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    now = datetime.datetime.now(datetime.UTC)

    def _name(common_name: str) -> x509.Name:
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])

    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(_name("wixy test CA"))
        .issuer_name(_name("wixy test CA"))
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(_name(names[0]))
        .issuer_name(ca_cert.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(name) for name in names]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .add_extension(x509.ExtendedKeyUsage([x509.OID_SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    directory.mkdir(parents=True, exist_ok=True)
    ca_file = directory / "ca.pem"
    cert_file = directory / "leaf.pem"
    key_file = directory / "leaf.key"
    ca_file.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    cert_file.write_bytes(leaf_cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return TestCertificates(ca_file=ca_file, cert_file=cert_file, key_file=key_file)
