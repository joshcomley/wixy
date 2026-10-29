"""Tests for `guide.linkcheck`: the pure link extraction, and how `check_url`/`run` judge a
response, driven through `httpx.MockTransport` (no real network: the real CI job is what checks
the real internet, spec/independence/07 §3; a unit test hitting real URLs would be exactly the
flaky, network-dependent kind this repo's testing conventions avoid).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from guide.linkcheck import LinkResult, check_url, collect_all_links, external_links, run


class TestExternalLinks:
    def test_finds_http_and_https_links(self) -> None:
        html = '<a href="https://example.com">x</a> <a href="http://example.org">y</a>'
        assert external_links(html) == {"https://example.com", "http://example.org"}

    def test_ignores_relative_links(self) -> None:
        html = '<a href="track-j.html">next</a> <a href="/admin/guide/">root</a>'
        assert external_links(html) == set()

    def test_ignores_non_href_urls_and_mailto(self) -> None:
        html = '<a href="mailto:hi@example.com">email</a>'
        assert external_links(html) == set()

    def test_deduplicates_the_same_url_within_one_page(self) -> None:
        html = '<a href="https://example.com">a</a> <a href="https://example.com">b</a>'
        assert external_links(html) == {"https://example.com"}

    def test_no_links_returns_empty_set(self) -> None:
        assert external_links("<p>no links here</p>") == set()


class TestCollectAllLinks:
    def test_maps_a_url_to_every_referencing_page(self, tmp_path: Path) -> None:
        (tmp_path / "a.html").write_text('<a href="https://shared.example">x</a>', encoding="utf-8")
        (tmp_path / "b.html").write_text('<a href="https://shared.example">y</a>', encoding="utf-8")
        (tmp_path / "c.html").write_text('<a href="https://only-c.example">z</a>', encoding="utf-8")

        by_url = collect_all_links(tmp_path)

        assert {p.name for p in by_url["https://shared.example"]} == {"a.html", "b.html"}
        assert {p.name for p in by_url["https://only-c.example"]} == {"c.html"}

    def test_empty_directory_returns_empty_map(self, tmp_path: Path) -> None:
        assert collect_all_links(tmp_path) == {}

    def test_ignores_non_html_files(self, tmp_path: Path) -> None:
        (tmp_path / "guide.css").write_text("/* not html */", encoding="utf-8")
        assert collect_all_links(tmp_path) == {}


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _no_sleep(_seconds: float) -> None:
    return None


class TestCheckUrl:
    def test_a_200_is_live(self) -> None:
        with _client(lambda r: httpx.Response(200)) as client:
            assert check_url(client, "https://a.example/", sleep=_no_sleep).outcome == "live"

    def test_a_404_is_dead(self) -> None:
        with _client(lambda r: httpx.Response(404)) as client:
            result = check_url(client, "https://a.example/gone", sleep=_no_sleep)
        assert result == LinkResult("dead", "HTTP 404")

    def test_a_410_is_dead(self) -> None:
        with _client(lambda r: httpx.Response(410)) as client:
            assert check_url(client, "https://a.example/gone", sleep=_no_sleep).outcome == "dead"

    def test_a_persistent_500_is_dead(self) -> None:
        with _client(lambda r: httpx.Response(500)) as client:
            assert check_url(client, "https://a.example/", sleep=_no_sleep).outcome == "dead"

    def test_a_network_failure_is_dead(self) -> None:
        def boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        with _client(boom) as client:
            result = check_url(client, "https://a.example/", sleep=_no_sleep)
        assert result.outcome == "dead" and "no route" in result.detail

    def test_a_cloudflare_challenge_is_refused_not_dead(self) -> None:
        # What a bot-protected site (opensource.org, 2026-10-28 CI) answers a datacenter address.
        challenge = httpx.Response(
            403, headers={"server": "cloudflare", "cf-mitigated": "challenge"}
        )
        with _client(lambda r: challenge) as client:
            result = check_url(client, "https://opensource.org/license/mit/", sleep=_no_sleep)
        assert result == LinkResult(
            "refused", "HTTP 403 (server: cloudflare, cf-mitigated: challenge)"
        )

    @pytest.mark.parametrize("status", [403, 429])
    def test_a_plain_refusal_is_refused_not_dead(self, status: int) -> None:
        with _client(lambda r: httpx.Response(status)) as client:
            assert check_url(client, "https://a.example/", sleep=_no_sleep).outcome == "refused"

    def test_a_401_is_dead(self) -> None:
        # A page that needs a login is broken for the guide's reader, not merely shy of robots.
        with _client(lambda r: httpx.Response(401)) as client:
            assert check_url(client, "https://a.example/", sleep=_no_sleep).outcome == "dead"

    def test_a_transient_failure_then_success_is_live(self) -> None:
        answers = iter([httpx.Response(503), httpx.Response(200)])
        with _client(lambda r: next(answers)) as client:
            assert check_url(client, "https://a.example/", sleep=_no_sleep).outcome == "live"

    def test_retries_back_off_between_attempts(self) -> None:
        waits: list[float] = []
        with _client(lambda r: httpx.Response(404)) as client:
            check_url(client, "https://a.example/", sleep=waits.append)
        assert waits == [2.0, 4.0]


class TestRun:
    @staticmethod
    def _guide(tmp_path: Path, *urls: str) -> Path:
        links = " ".join(f'<a href="{u}">x</a>' for u in urls)
        (tmp_path / "a.html").write_text(links, encoding="utf-8")
        return tmp_path

    @staticmethod
    def _by_host(statuses: dict[str, httpx.Response]) -> Callable[[httpx.Request], httpx.Response]:
        return lambda request: statuses[request.url.host]

    def test_only_refusals_pass_with_a_warning(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        handler = self._by_host(
            {
                "live.example": httpx.Response(200),
                "shy.example": httpx.Response(403, headers={"cf-mitigated": "challenge"}),
            }
        )
        code = run(
            self._guide(tmp_path, "https://live.example/", "https://shy.example/"),
            client=_client(handler),
            sleep=_no_sleep,
        )
        out = capsys.readouterr().out
        assert code == 0
        assert "1 live, 1 refused by the site, 0 failing" in out
        assert "::warning title=Guide link not verifiable::https://shy.example/" in out

    def test_a_dead_link_fails_even_beside_refusals(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        handler = self._by_host(
            {"gone.example": httpx.Response(404), "shy.example": httpx.Response(429)}
        )
        code = run(
            self._guide(tmp_path, "https://gone.example/", "https://shy.example/"),
            client=_client(handler),
            sleep=_no_sleep,
        )
        out = capsys.readouterr().out
        assert code == 1
        assert "[FAIL] https://gone.example/ -- HTTP 404 (referenced by: a.html)" in out
        assert "[REFUSED] https://shy.example/ -- HTTP 429 (referenced by: a.html)" in out
