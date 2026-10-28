"""`livechat/safe_fetch.py` (workspace 00056, spec/server-chat/08-adventure-time.md §4.3a, Inv 56):
the SSRF-safe GET behind every holiday-pack picture and page fetch.

Hermetic: a local `FakeWeb` answers for many host names (the fetcher's INJECTED resolver maps every
name to 127.0.0.1 and its INJECTED address policy lets loopback through — production has neither).
The refusal tests mostly use the PRODUCTION policy with a resolver that answers a hostile address,
and prove two things: the fetch is refused, and the fake server never saw a connection."""

from __future__ import annotations

import functools
import ipaddress
import time
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any

import anyio
import pytest

from wixy_server.livechat.safe_fetch import (
    HTML_MAX_BYTES,
    IMAGE_MAX_BYTES,
    MAX_REDIRECTS,
    USER_AGENT,
    FetchFailure,
    FetchResponse,
    SafeFetcher,
    SafeFetchError,
    is_public_address,
    parse_fetch_url,
    parse_retry_after,
    system_resolver,
)
from wixy_server.tests.fake_web import (
    FakeWeb,
    Reply,
    SeenRequest,
    loopback_only,
    make_test_certificates,
    resolve_to,
    url,
    with_web,
)

IMAGE = ("image/",)
HTML = ("text/html",)


# -- the address policy --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        # IPv4: loopback, private, link-local (incl. the cloud metadata address), CGNAT, "this
        # network", multicast, reserved, broadcast, documentation, benchmarking, protocol blocks.
        "127.0.0.1",
        "127.255.255.254",
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "192.168.255.255",
        "169.254.169.254",
        "169.254.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "0.0.0.0",
        "0.1.2.3",
        "224.0.0.1",
        "239.255.255.255",
        "240.0.0.1",
        "255.255.255.255",
        "192.0.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.1",
        "203.0.113.1",
        "192.88.99.1",
        # IPv6: loopback, unspecified, unique-local, link-local, multicast.
        "::1",
        "::",
        "fc00::1",
        "fd12:3456:789a::1",
        "fe80::1",
        "fe80::1%eth0",
        "fec0::1",
        "ff02::1",
        "ff00::",
        # IPv6 forms that embed an IPv4 address: mapped, compatible, NAT64, 6to4, Teredo.
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "::ffff:93.184.216.34",
        "::127.0.0.1",
        "::10.0.0.1",
        "::ffff:0:127.0.0.1",
        "64:ff9b::7f00:1",
        "64:ff9b::a00:1",
        "64:ff9b:1::1",
        "2002:7f00:1::1",
        "2002:a00:1::1",
        "2002:5db8:d822::1",
        "2001:0:4136:e378:8000:63bf:3fff:fdd2",
        "2001::1",
        # IPv6 documentation, discard, and other non-global space.
        "2001:db8::1",
        "3fff::1",
        "100::1",
        "5f00::1",
        "1::1",
    ],
)
def test_policy_refuses_every_non_public_address(text: str) -> None:
    assert is_public_address(ipaddress.ip_address(text)) is False


@pytest.mark.parametrize(
    "text",
    [
        "93.184.216.34",
        "8.8.8.8",
        "1.1.1.1",
        "185.15.59.224",
        "11.0.0.1",
        "100.63.255.255",
        "100.128.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "192.169.0.1",
        "223.255.255.255",
        "2606:2800:220:1:248:1893:25c8:1946",
        "2620:0:862:ed1a::1",
        "2a00:1450:4009:81f::200e",
        "2001:4860:4860::8888",
    ],
)
def test_policy_allows_public_addresses(text: str) -> None:
    assert is_public_address(ipaddress.ip_address(text)) is True


# -- parsing a URL once --------------------------------------------------------------------------


class TestParseUrl:
    def test_a_plain_url_is_taken_apart(self) -> None:
        parsed = parse_fetch_url("HTTPS://En.Wikipedia.ORG/api/rest_v1/page/summary/Kotor?x=1#frag")
        assert (parsed.scheme, parsed.host, parsed.port) == ("https", "en.wikipedia.org", 443)
        assert parsed.target == "/api/rest_v1/page/summary/Kotor?x=1"
        assert parsed.url == "https://en.wikipedia.org/api/rest_v1/page/summary/Kotor?x=1"

    def test_default_and_explicit_ports(self) -> None:
        assert parse_fetch_url("http://example.com").port == 80
        assert parse_fetch_url("http://example.com").target == "/"
        assert parse_fetch_url("http://example.com:80/x").url == "http://example.com/x"
        assert parse_fetch_url("https://example.com:443/x").port == 443

    def test_non_ascii_names_and_paths_are_encoded_not_trusted(self) -> None:
        parsed = parse_fetch_url("https://bücher.example/straße ä".replace(" ", "%20"))
        assert parsed.host == "xn--bcher-kva.example"
        assert parsed.target == "/stra%C3%9Fe%20%C3%A4"
        assert parse_fetch_url("https://example.com/a%0d%0aX:y").target == "/a%0d%0aX:y"

    def test_a_trailing_dot_is_dropped(self) -> None:
        assert parse_fetch_url("http://example.com./").host == "example.com"

    @pytest.mark.parametrize(
        "raw",
        [
            "http://example.com/\ud800",  # a lone surrogate cannot be percent-encoded
            "http://example.com/?q=\udfff",
            "http://exa℀mple.com/",  # NFKC-normalises to something containing "/"
            "http://example.com:99999999999999999999/",
            "http://[::1/",
        ],
    )
    def test_the_standard_librarys_value_errors_become_url_failures(self, raw: str) -> None:
        with pytest.raises(SafeFetchError) as caught:
            parse_fetch_url(raw)  # SafeFetchError and nothing else
        assert caught.value.reason in (FetchFailure.URL, FetchFailure.HOST, FetchFailure.PORT)

    @pytest.mark.parametrize(
        ("raw", "reason"),
        [
            ("", FetchFailure.URL),
            ("   ", FetchFailure.URL),
            ("http://example.com/a b", FetchFailure.URL),
            ("http://example.com/a\tb", FetchFailure.URL),
            ("http://example.com/a\r\nHost: evil", FetchFailure.URL),
            ("http://example.com/\x00", FetchFailure.URL),
            ("http://good.example\\@evil.example/", FetchFailure.URL),
            ("http://example.com/" + "a" * 3000, FetchFailure.URL),
            ("ftp://example.com/x", FetchFailure.SCHEME),
            ("file:///etc/passwd", FetchFailure.SCHEME),
            ("gopher://example.com/", FetchFailure.SCHEME),
            ("javascript:alert(1)", FetchFailure.SCHEME),
            ("data:text/html,hi", FetchFailure.SCHEME),
            ("//example.com/x", FetchFailure.SCHEME),
            ("example.com/x", FetchFailure.SCHEME),
            ("http://user:pass@example.com/", FetchFailure.HOST),
            ("http://user@example.com/", FetchFailure.HOST),
            ("http://good.example%5c@evil.example/", FetchFailure.HOST),
            ("http://127.0.0.1/", FetchFailure.HOST),
            ("http://[::1]/", FetchFailure.HOST),
            ("http://[::ffff:127.0.0.1]/", FetchFailure.HOST),
            ("http://2130706433/", FetchFailure.HOST),
            ("http://0x7f.0.0.1/", FetchFailure.HOST),
            ("http://0177.0.0.1/", FetchFailure.HOST),
            ("http://127.1/", FetchFailure.HOST),
            ("http://１２７.０.０.１/", FetchFailure.HOST),
            ("http://169.254.169.254/latest/meta-data", FetchFailure.HOST),
            ("http://localhost/", FetchFailure.HOST),
            ("http://intranet/", FetchFailure.HOST),
            ("http://exa mple.com/", FetchFailure.URL),
            ("http://-bad-.example/", FetchFailure.HOST),
            ("http://bad_name.example/", FetchFailure.HOST),
            ("http:///path", FetchFailure.HOST),
            ("http://example.com:8080/", FetchFailure.PORT),
            ("http://example.com:22/", FetchFailure.PORT),
            ("http://example.com:0/", FetchFailure.PORT),
            ("http://example.com:99999/", FetchFailure.URL),
            ("http://example.com:abc/", FetchFailure.URL),
        ],
    )
    def test_refused(self, raw: str, reason: FetchFailure) -> None:
        with pytest.raises(SafeFetchError) as caught:
            parse_fetch_url(raw)
        assert caught.value.reason == reason


class TestRetryAfter:
    def test_seconds_and_dates(self) -> None:
        assert parse_retry_after("3") == 3.0
        assert parse_retry_after(" 0 ") == 0.0
        assert parse_retry_after("Wed, 21 Oct 2015 07:28:05 GMT", now=1445412481) == 4.0
        assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=1445412580) == 0.0

    @pytest.mark.parametrize(
        "value",
        [
            None,
            "",
            "soon",
            "-5",
            "1.5",
            "99999999999999",
            "²",  # U+00B2: str.isdigit() is True for it, int() raises ValueError
            "³4",
            "٣",  # Arabic-Indic digit three
            "１２",  # full-width digits
            "Mon, 01 Jan 0001 00:00:00 GMT",  # a year the platform cannot take a timestamp of
            "Fri, 31 Dec 9999 23:59:59 GMT",
            "Mon, 99 Foo 2020 99:99:99 GMT",
        ],
    )
    def test_unreadable_values_are_none_and_never_raise(self, value: str | None) -> None:
        result = parse_retry_after(value)
        assert result is None or result >= 0.0

    @pytest.mark.parametrize("value", ["²", "٣", "１２", "³4"])
    def test_non_ascii_digits_are_not_a_delay(self, value: str) -> None:
        assert parse_retry_after(value) is None

    def test_a_429_with_a_non_ascii_digit_retry_after_is_a_clean_rate_limit(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:  # SafeFetchError, never ValueError
                await fetcher.get(url(web, "rl.test", "/"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.RATE_LIMITED
            assert len(web.requests) == 1  # an unreadable Retry-After is not retried

        with_web(
            body,
            setup=lambda web: web.add(
                "rl.test", "/", Reply(status=429, headers={"Retry-After": "²"})
            ),
        )


def test_system_resolver_resolves_a_literal_without_the_network() -> None:
    assert anyio.run(system_resolver, "127.0.0.1", 80) == ["127.0.0.1"]
    with pytest.raises(SafeFetchError) as caught:
        anyio.run(system_resolver, "no-such-host.invalid", 80)
    assert caught.value.reason == FetchFailure.DNS


# -- refusals: nothing connects ------------------------------------------------------------------


HOSTILE = [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.9",
    "0.0.0.0",
    "224.0.0.251",
    "240.0.0.1",
    "::1",
    "::",
    "fc00::5",
    "fe80::1",
    "ff02::fb",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
]


class TestNothingHostileIsEverReached:
    @pytest.mark.parametrize("address", HOSTILE)
    def test_a_name_resolving_to_a_non_public_address_is_refused_with_no_connection(
        self, address: str
    ) -> None:
        """The PRODUCTION policy (the default) over a resolver answering `address`. The fake server
        listens on loopback; if the fetcher dialled anything it would show up in `requests`."""

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "evil.test", "/x"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ADDRESS
            assert web.requests == []

        with_web(
            body,
            setup=lambda web: web.add("evil.test", "/x", Reply(body=b"secret")),
            resolver=resolve_to(address),
            address_policy=is_public_address,
        )

    def test_one_bad_record_refuses_the_whole_host(self) -> None:
        """A rebinding attacker mixing a public record with a private one gets nothing: not even
        the public address is dialled."""
        dialled: list[str] = []

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "mixed.test", "/x"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ADDRESS
            assert web.requests == [] and dialled == []

        def policy(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
            dialled.append("checked")
            dialled.clear()  # only a dial matters; the policy runs per address
            return is_public_address(ip)

        with_web(
            body,
            resolver=resolve_to("93.184.216.34", "127.0.0.1"),
            address_policy=policy,
        )

    def test_an_unparseable_address_from_the_resolver_is_refused(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "odd.test", "/x"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ADDRESS
            assert web.requests == []

        with_web(body, resolver=resolve_to("not-an-address"))

    def test_a_name_that_does_not_resolve_is_a_dns_failure(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "void.test", "/x"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.DNS

        with_web(body, resolver=resolve_to())

    def test_the_default_ports_refuse_the_fake_servers_port(self) -> None:
        """No injected `allowed_ports`: only 80/443 exist, so a random port is refused before any
        resolution or connection."""
        resolved: list[str] = []

        async def go() -> None:
            web = FakeWeb()
            await web.start()
            fetcher = SafeFetcher(resolver=resolve_to("127.0.0.1", calls=resolved))
            try:
                with pytest.raises(SafeFetchError) as caught:
                    await fetcher.get(url(web, "x.test", "/"), max_bytes=100, accept=IMAGE)
                assert caught.value.reason == FetchFailure.PORT
                assert resolved == [] and web.requests == []
            finally:
                await fetcher.aclose()
                await web.stop()

        anyio.run(go)

    def test_the_default_policy_refuses_loopback_even_for_a_name_that_resolves_to_it(self) -> None:
        resolved: list[str] = []

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "x.test", "/"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ADDRESS
            assert web.requests == [] and resolved == ["x.test"]

        with_web(
            body,
            resolver=resolve_to("127.0.0.1", calls=resolved),
            address_policy=is_public_address,
        )

    def test_the_host_is_resolved_once_per_connection_and_dialled_by_address(self) -> None:
        """No second lookup between the vetting and the connect: one resolution for one request,
        and the connection goes to the vetted address (the fake name has no DNS at all)."""
        resolved: list[str] = []

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "once.test", "/x"), max_bytes=100, accept=IMAGE)
            assert response.body == b"ok"
            assert resolved == ["once.test"]

        with_web(
            body,
            setup=lambda web: web.add(
                "once.test", "/x", Reply(body=b"ok", content_type="image/png")
            ),
            resolver=resolve_to("127.0.0.1", calls=resolved),
        )

    def test_a_rebinding_resolver_gets_only_the_one_answer_it_gave(self) -> None:
        """First answer public-looking (here: loopback, allowed by the test policy), every later
        answer hostile. Each CONNECTION resolves once and is vetted; the first request succeeds and
        a second one, which resolves again, is refused — there is no cached or reused vetting."""
        answers = iter([["127.0.0.1"], ["10.0.0.5"]])

        async def resolver(host: str, port: int) -> Sequence[str]:
            return next(answers)

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            first = await fetcher.get(url(web, "flip.test", "/x"), max_bytes=100, accept=IMAGE)
            assert first.body == b"ok"
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "flip.test", "/x"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ADDRESS
            assert len(web.requests) == 1

        with_web(
            body,
            setup=lambda web: web.add(
                "flip.test", "/x", Reply(body=b"ok", content_type="image/png")
            ),
            resolver=resolver,
        )


# -- redirects -----------------------------------------------------------------------------------


class TestRedirects:
    def test_a_redirect_is_followed_and_the_final_url_reported(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "a.test", "/start"), max_bytes=100, accept=IMAGE)
            assert response.body == b"png"
            assert response.url == url(web, "b.test", "/final")
            assert [r.host for r in web.requests] == ["a.test", "b.test"]

        def setup(web: FakeWeb) -> None:
            web.add(
                "a.test",
                "/start",
                Reply(status=302, headers={"Location": url(web, "b.test", "/final")}),
            )
            web.add("b.test", "/final", Reply(body=b"png", content_type="image/png"))

        with_web(body, setup=setup)

    def test_a_relative_location_stays_on_the_host(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "a.test", "/start"), max_bytes=100, accept=IMAGE)
            assert response.url == url(web, "a.test", "/there")

        def setup(web: FakeWeb) -> None:
            web.add("a.test", "/start", Reply(status=301, headers={"Location": "/there"}))
            web.add("a.test", "/there", Reply(body=b"x", content_type="image/png"))

        with_web(body, setup=setup)

    def test_three_redirects_are_followed_a_fourth_is_not(self) -> None:
        def setup_chain(length: int) -> Callable[[FakeWeb], None]:
            def setup(web: FakeWeb) -> None:
                for i in range(length):
                    web.add(
                        "chain.test",
                        f"/{i}",
                        Reply(status=302, headers={"Location": f"/{i + 1}"}),
                    )
                web.add("chain.test", f"/{length}", Reply(body=b"x", content_type="image/png"))

            return setup

        async def reaches(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "chain.test", "/0"), max_bytes=10, accept=IMAGE)
            assert response.url.endswith("/3")

        async def gives_up(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "chain.test", "/0"), max_bytes=10, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TOO_MANY_REDIRECTS
            assert len(web.requests) == MAX_REDIRECTS + 1

        assert MAX_REDIRECTS == 3
        with_web(reaches, setup=setup_chain(3))
        with_web(gives_up, setup=setup_chain(4))

    def test_a_redirect_loop_is_cut_off(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "loop.test", "/a"), max_bytes=10, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TOO_MANY_REDIRECTS

        def setup(web: FakeWeb) -> None:
            web.add("loop.test", "/a", Reply(status=302, headers={"Location": "/b"}))
            web.add("loop.test", "/b", Reply(status=302, headers={"Location": "/a"}))

        with_web(body, setup=setup)

    def test_a_redirect_to_a_private_address_is_refused_and_never_dialled(self) -> None:
        """The first hop is a vetted public-looking host; its redirect names a host that resolves to
        a private address. The second hop is vetted like a fresh request and refused."""
        resolved: list[str] = []

        async def resolver(host: str, port: int) -> Sequence[str]:
            resolved.append(host)
            return ["127.0.0.1"] if host == "ok.test" else ["10.0.0.5"]

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "ok.test", "/go"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ADDRESS
            assert [r.host for r in web.requests] == ["ok.test"]
            assert resolved == ["ok.test", "internal.test"]

        def setup(web: FakeWeb) -> None:
            web.add(
                "ok.test",
                "/go",
                Reply(status=302, headers={"Location": url(web, "internal.test", "/s")}),
            )
            web.add("internal.test", "/s", Reply(body=b"metadata", content_type="image/png"))

        with_web(body, setup=setup, resolver=resolver)

    @pytest.mark.parametrize(
        ("location", "reason"),
        [
            ("http://127.0.0.1:{port}/secret", FetchFailure.HOST),
            ("http://169.254.169.254:{port}/latest/meta-data/", FetchFailure.HOST),
            ("http://[::1]:{port}/", FetchFailure.HOST),
            ("http://2130706433:{port}/", FetchFailure.HOST),
            ("http://localhost:{port}/", FetchFailure.HOST),
            ("file:///etc/passwd", FetchFailure.SCHEME),
            ("gopher://x.test/_GET", FetchFailure.SCHEME),
            ("http://x.test:22/", FetchFailure.PORT),
            ("http://x.test:6379/", FetchFailure.PORT),
            ("http://user:pw@x.test:{port}/", FetchFailure.HOST),
            ("http://x.test:{port}\\@evil.test/", FetchFailure.URL),
            ("http://x.test:{port}/a b", FetchFailure.URL),
        ],
    )
    def test_hostile_locations_are_refused(self, location: str, reason: FetchFailure) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "r.test", "/go"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == reason
            assert [r.host for r in web.requests] == ["r.test"]

        def setup(web: FakeWeb) -> None:
            target = location.replace("{port}", str(web.port))
            web.add("r.test", "/go", Reply(status=302, headers={"Location": target}))

        with_web(body, setup=setup)

    def test_a_redirect_without_a_location_is_an_error(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "r.test", "/go"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.REDIRECT

        with_web(body, setup=lambda web: web.add("r.test", "/go", Reply(status=302)))

    @pytest.mark.parametrize(
        "location",
        ["http://[x", "http://[::1", "http://[evil/x", "//[x/y", "http://exa]mple.test/"],
    )
    def test_a_malformed_location_is_a_clean_redirect_failure(self, location: str) -> None:
        """`urljoin` raises a plain `ValueError` for these; `get()` must still raise only
        `SafeFetchError`."""

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "r.test", "/go"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason in (FetchFailure.REDIRECT, FetchFailure.URL)
            assert [r.host for r in web.requests] == ["r.test"]

        with_web(
            body,
            setup=lambda web: web.add(
                "r.test", "/go", Reply(status=302, headers={"Location": location})
            ),
        )


class TestRefusedHosts:
    """`get(refuse_host_suffixes=...)`: domains no hop may touch (the picture finder keeps Wikimedia
    originals out of a venue's image fetch with it)."""

    def test_the_url_itself_on_a_refused_domain_is_refused_with_no_connection(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            for host in ("upload.wikimedia.test", "wikimedia.test", "A.B.Wikimedia.test"):
                with pytest.raises(SafeFetchError) as caught:
                    await fetcher.get(
                        url(web, host, "/x"),
                        max_bytes=100,
                        accept=IMAGE,
                        refuse_host_suffixes=("wikimedia.test",),
                    )
                assert caught.value.reason == FetchFailure.HOST
            assert web.requests == []

        with_web(body)

    def test_a_redirect_onto_a_refused_domain_is_refused_before_it_is_followed(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(
                    url(web, "cdn.test", "/img"),
                    max_bytes=100,
                    accept=IMAGE,
                    refuse_host_suffixes=("wikimedia.test",),
                )
            assert caught.value.reason == FetchFailure.HOST
            assert [r.host for r in web.requests] == ["cdn.test"]

        def setup(web: FakeWeb) -> None:
            target = url(web, "upload.wikimedia.test", "/original.jpg")
            web.add("cdn.test", "/img", Reply(status=301, headers={"Location": target}))
            web.add("upload.wikimedia.test", "/original.jpg", Reply(body=b"x"))

        with_web(body, setup=setup)

    def test_a_lookalike_domain_is_not_refused(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(
                url(web, "notwikimedia.test", "/x"),
                max_bytes=100,
                accept=IMAGE,
                refuse_host_suffixes=("wikimedia.test",),
            )
            assert response.body == b"ok"

        with_web(
            body,
            setup=lambda web: web.add(
                "notwikimedia.test", "/x", Reply(body=b"ok", content_type="image/png")
            ),
        )

    def test_nothing_is_refused_by_default(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(
                url(web, "upload.wikimedia.test", "/x"), max_bytes=100, accept=IMAGE
            )
            assert response.body == b"ok"

        with_web(
            body,
            setup=lambda web: web.add(
                "upload.wikimedia.test", "/x", Reply(body=b"ok", content_type="image/png")
            ),
        )


# -- what comes back -----------------------------------------------------------------------------


class TestResponses:
    def test_the_request_is_plain_and_polite(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            await fetcher.get(url(web, "polite.test", "/p?q=1"), max_bytes=100, accept=IMAGE)
            (seen,) = web.requests
            assert seen.host == "polite.test"
            assert seen.host_header == f"polite.test:{web.port}"
            assert seen.path == "/p" and seen.query == {"q": ["1"]}
            assert seen.headers["user-agent"] == USER_AGENT
            assert "github.com/joshcomley/wixy" in USER_AGENT
            assert seen.headers["accept-encoding"] == "identity"
            assert seen.headers["accept"] == "image/*"
            for forbidden in ("cookie", "authorization", "referer", "proxy-authorization"):
                assert forbidden not in seen.headers

        with_web(
            body,
            setup=lambda web: web.add(
                "polite.test", "/p", Reply(body=b"x", content_type="image/png")
            ),
        )

    def test_media_type_charset_and_body(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "h.test", "/"), max_bytes=1000, accept=HTML)
            assert response == FetchResponse(
                url=url(web, "h.test", "/"),
                status=200,
                content_type="text/html",
                charset="utf-8",
                body=b"<p>hi</p>",
            )

        with_web(
            body,
            setup=lambda web: web.add(
                "h.test", "/", Reply(body=b"<p>hi</p>", content_type='Text/HTML; Charset="UTF-8"')
            ),
        )

    def test_the_first_content_type_header_wins(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "h.test", "/"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.CONTENT_TYPE

        with_web(
            body,
            setup=lambda web: web.add("h.test", "/", Reply(body=b"x", content_type="text/html")),
        )

    @pytest.mark.parametrize("content_type", ["text/html", "application/json", "text/plain", None])
    def test_a_non_image_is_refused_before_its_body_is_read(self, content_type: str | None) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            started = time.monotonic()
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "n.test", "/"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.CONTENT_TYPE
            assert time.monotonic() - started < 3.0  # the endless body was never read

        with_web(
            body,
            setup=lambda web: web.add(
                "n.test", "/", Reply(endless=True, content_type=content_type)
            ),
        )

    @pytest.mark.parametrize("status", [403, 404, 410, 500])
    def test_error_statuses_carry_the_status(self, status: int) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "s.test", "/"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.STATUS
            assert caught.value.status == status

        with_web(body, setup=lambda web: web.add("s.test", "/", Reply(status=status)))

    def test_a_declared_length_over_the_cap_is_refused_before_any_body(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "big.test", "/"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TOO_LARGE
            assert "content-length" in caught.value.detail

        with_web(
            body,
            setup=lambda web: web.add(
                "big.test", "/", Reply(body=b"", content_type="image/png", content_length=5_000_000)
            ),
        )

    def test_a_body_over_the_cap_is_aborted_even_with_no_length_at_all(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            started = time.monotonic()
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "end.test", "/"), max_bytes=100_000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TOO_LARGE
            assert time.monotonic() - started < 5.0
            await anyio.sleep(0.2)
            assert web.max_in_flight == 1  # and the server's endless writer was cut off

        with_web(
            body,
            setup=lambda web: web.add(
                "end.test", "/", Reply(endless=True, content_type="image/png")
            ),
        )

    def test_a_chunked_body_over_the_cap_is_aborted(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "ch.test", "/"), max_bytes=5000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TOO_LARGE

        with_web(
            body,
            setup=lambda web: web.add(
                "ch.test", "/", Reply(body=b"x" * 20000, content_type="image/png", chunked=True)
            ),
        )

    def test_the_documented_caps(self) -> None:
        assert IMAGE_MAX_BYTES == 8 * 1024 * 1024 and HTML_MAX_BYTES == 1024 * 1024

    def test_a_compressed_response_is_refused(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "gz.test", "/"), max_bytes=1000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.ENCODING

        with_web(
            body,
            setup=lambda web: web.add(
                "gz.test",
                "/",
                Reply(
                    body=b"\x1f\x8b", content_type="image/png", headers={"Content-Encoding": "gzip"}
                ),
            ),
        )

    def test_a_slow_server_is_cut_off_by_the_total_deadline(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            started = time.monotonic()
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "slow.test", "/"), max_bytes=10_000_000, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TIMEOUT
            assert time.monotonic() - started < 3.0

        # Each 1 KiB piece arrives well inside the read timeout, but the whole body would take 50 s.
        with_web(
            body,
            setup=lambda web: web.add(
                "slow.test",
                "/",
                Reply(body=b"x" * 50_000, content_type="image/png", trickle_s=0.5),
            ),
            timeout_s=1.0,
        )

    def test_a_silent_server_times_out(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "mute.test", "/"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TIMEOUT

        with_web(
            body,
            setup=lambda web: web.add(
                "mute.test", "/", Reply(delay_s=10.0, content_type="image/png")
            ),
            timeout_s=0.5,
        )

    def test_nothing_is_kept_between_requests_no_cookies(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            await fetcher.get(url(web, "c.test", "/"), max_bytes=100, accept=IMAGE)
            await fetcher.get(url(web, "c.test", "/"), max_bytes=100, accept=IMAGE)
            assert all("cookie" not in r.headers for r in web.requests)
            assert len(web.requests) == 2

        with_web(
            body,
            setup=lambda web: web.add(
                "c.test",
                "/",
                Reply(body=b"x", content_type="image/png", headers={"Set-Cookie": "sid=1; Path=/"}),
            ),
        )

    def test_proxies_in_the_environment_are_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
            monkeypatch.setenv(name, "http://127.0.0.1:9")

        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "p.test", "/"), max_bytes=100, accept=IMAGE)
            assert response.body == b"x"
            assert len(web.requests) == 1

        with_web(
            body,
            setup=lambda web: web.add("p.test", "/", Reply(body=b"x", content_type="image/png")),
        )

    def test_a_failed_fetch_releases_the_hosts_turn(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            for _ in range(3):
                with pytest.raises(SafeFetchError):
                    await fetcher.get(url(web, "f.test", "/boom"), max_bytes=100, accept=IMAGE)
            ok = await fetcher.get(url(web, "f.test", "/ok"), max_bytes=100, accept=IMAGE)
            assert ok.body == b"fine"
            assert fetcher._gates._gates == {}

        def setup(web: FakeWeb) -> None:
            web.add("f.test", "/boom", Reply(status=500))
            web.add("f.test", "/ok", Reply(body=b"fine", content_type="image/png"))

        with_web(body, setup=setup)


# -- politeness: Retry-After, one request per host, four hosts at a time -------------------------


class TestPoliteness:
    def test_a_429_with_a_short_retry_after_is_waited_out_once(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            started = time.monotonic()
            response = await fetcher.get(url(web, "rl.test", "/"), max_bytes=100, accept=IMAGE)
            assert response.body == b"later"
            assert time.monotonic() - started >= 0.9
            assert len(web.requests) == 2

        calls = {"n": 0}

        def handler(request: SeenRequest) -> Reply:
            calls["n"] += 1
            if calls["n"] == 1:
                return Reply(status=429, headers={"Retry-After": "1"})
            return Reply(body=b"later", content_type="image/png")

        with_web(body, setup=lambda web: web.add("rl.test", "/", handler))

    def test_a_503_is_handled_the_same_way(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            response = await fetcher.get(url(web, "rl.test", "/"), max_bytes=100, accept=IMAGE)
            assert response.body == b"ok"
            assert len(web.requests) == 2

        calls = {"n": 0}

        def handler(request: SeenRequest) -> Reply:
            calls["n"] += 1
            if calls["n"] == 1:
                return Reply(status=503, headers={"Retry-After": "0"})
            return Reply(body=b"ok", content_type="image/png")

        with_web(body, setup=lambda web: web.add("rl.test", "/", handler))

    def test_a_second_429_gives_up(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "rl.test", "/"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.RATE_LIMITED
            assert caught.value.status == 429
            assert len(web.requests) == 2  # one retry, never more

        with_web(
            body,
            setup=lambda web: web.add(
                "rl.test", "/", Reply(status=429, headers={"Retry-After": "0"})
            ),
        )

    @pytest.mark.parametrize("header", ["30", "11", None, "soon"])
    def test_a_long_or_missing_retry_after_gives_up_at_once(self, header: str | None) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            started = time.monotonic()
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(url(web, "rl.test", "/"), max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.RATE_LIMITED
            assert len(web.requests) == 1
            assert time.monotonic() - started < 2.0

        headers = {} if header is None else {"Retry-After": header}
        with_web(
            body,
            setup=lambda web: web.add("rl.test", "/", Reply(status=429, headers=headers)),
        )

    def test_one_request_at_a_time_per_host(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            started = time.monotonic()
            async with anyio.create_task_group() as tg:
                for i in range(4):
                    tg.start_soon(
                        functools.partial(
                            fetcher.get, url(web, "one.test", f"/{i}"), max_bytes=100, accept=IMAGE
                        )
                    )
            assert web.max_in_flight_by_host["one.test"] == 1
            assert time.monotonic() - started >= 0.7  # four 0.2 s requests, back to back

        def setup(web: FakeWeb) -> None:
            for i in range(4):
                web.add(
                    "one.test", f"/{i}", Reply(body=b"x", content_type="image/png", delay_s=0.2)
                )

        with_web(body, setup=setup)

    def test_at_most_four_hosts_at_once(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            async with anyio.create_task_group() as tg:
                for i in range(8):
                    tg.start_soon(
                        functools.partial(
                            fetcher.get, url(web, f"host{i}.test", "/"), max_bytes=100, accept=IMAGE
                        )
                    )
            assert web.max_in_flight == 4
            assert all(v == 1 for v in web.max_in_flight_by_host.values())

        def setup(web: FakeWeb) -> None:
            for i in range(8):
                web.add(
                    f"host{i}.test", "/", Reply(body=b"x", content_type="image/png", delay_s=0.3)
                )

        with_web(body, setup=setup)

    def test_the_host_table_does_not_grow(self) -> None:
        async def body(web: FakeWeb, fetcher: SafeFetcher) -> None:
            for i in range(6):
                await fetcher.get(url(web, f"t{i}.test", "/"), max_bytes=100, accept=IMAGE)
            assert fetcher._gates._gates == {}

        def setup(web: FakeWeb) -> None:
            for i in range(6):
                web.add(f"t{i}.test", "/", Reply(body=b"x", content_type="image/png"))

        with_web(body, setup=setup)


# -- TLS: the certificate and the server name are the HOSTNAME's ---------------------------------


class TestTls:
    def _run(
        self,
        tmp_path: Path,
        check: Callable[[FakeWeb, SafeFetcher, Any], Awaitable[None]],
        *,
        names: list[str],
        trust_ca: bool = True,
        production_context: bool = False,
    ) -> None:
        certs = make_test_certificates(tmp_path, names)

        async def go() -> None:
            web = FakeWeb()
            port = await web.start(certs.server_context())
            web.add("tls.fake.test", "/pic", Reply(body=b"tls-ok", content_type="image/png"))
            web.add(
                "tls.fake.test",
                "/downgrade",
                Reply(status=302, headers={"Location": f"http://tls.fake.test:{port}/pic"}),
            )
            fetcher = SafeFetcher(
                resolver=resolve_to("127.0.0.1"),
                address_policy=loopback_only,
                allowed_ports={port},
                ssl_context=None if production_context else certs.client_context(),
            )
            try:
                await check(web, fetcher, port)
            finally:
                await fetcher.aclose()
                await web.stop()

        anyio.run(go)

    def test_the_certificate_is_verified_against_the_hostname_and_the_sni_is_sent(
        self, tmp_path: Path
    ) -> None:
        async def check(web: FakeWeb, fetcher: SafeFetcher, port: int) -> None:
            response = await fetcher.get(
                f"https://tls.fake.test:{port}/pic", max_bytes=100, accept=IMAGE
            )
            assert response.body == b"tls-ok"
            (seen,) = web.requests
            assert seen.sni == "tls.fake.test"  # the NAME, though we dialled 127.0.0.1
            assert seen.host_header == f"tls.fake.test:{port}"

        self._run(tmp_path, check, names=["tls.fake.test"])

    def test_a_certificate_for_another_name_is_refused(self, tmp_path: Path) -> None:
        async def check(web: FakeWeb, fetcher: SafeFetcher, port: int) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(f"https://tls.fake.test:{port}/pic", max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TLS
            assert web.requests == []

        self._run(tmp_path, check, names=["somebody-else.test"])

    def test_an_untrusted_certificate_is_refused_by_the_default_context(
        self, tmp_path: Path
    ) -> None:
        async def check(web: FakeWeb, fetcher: SafeFetcher, port: int) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(f"https://tls.fake.test:{port}/pic", max_bytes=100, accept=IMAGE)
            assert caught.value.reason == FetchFailure.TLS
            assert web.requests == []

        self._run(tmp_path, check, names=["tls.fake.test"], production_context=True)

    def test_a_redirect_from_https_down_to_http_is_refused(self, tmp_path: Path) -> None:
        async def check(web: FakeWeb, fetcher: SafeFetcher, port: int) -> None:
            with pytest.raises(SafeFetchError) as caught:
                await fetcher.get(
                    f"https://tls.fake.test:{port}/downgrade", max_bytes=100, accept=IMAGE
                )
            assert caught.value.reason == FetchFailure.REDIRECT
            assert [r.path for r in web.requests] == ["/downgrade"]

        self._run(tmp_path, check, names=["tls.fake.test"])
