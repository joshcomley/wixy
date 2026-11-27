"""The rate limits on starting public research (workspace 00065, spec/adventure-public/README.md
§2.2): 30 starts per rolling hour overall, 6 per client address per hour, `Retry-After` honest, the
client address taken from `CF-Connecting-IP` else the peer, memory bounded, nothing logged."""

from __future__ import annotations

import logging

import pytest

from wixy_server.adventure_public import limits as limits_module
from wixy_server.adventure_public.limits import (
    MAX_TRACKED_CLIENTS,
    WINDOW_S,
    PublicLimits,
    StartLimiter,
    StartTicket,
    client_key,
)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def limiter(clock: Clock, per_ip: int = 6, overall: int = 30) -> StartLimiter:
    return StartLimiter(PublicLimits(global_per_hour=overall, per_ip_per_hour=per_ip), clock=clock)


class TestDefaults:
    def test_the_spec_numbers(self) -> None:
        assert PublicLimits() == PublicLimits(global_per_hour=30, per_ip_per_hour=6)
        assert WINDOW_S == 3600.0


class TestPerClient:
    def test_the_seventh_start_in_an_hour_is_refused_with_the_honest_wait(self) -> None:
        clock = Clock()
        lim = limiter(clock)
        for _ in range(6):
            assert lim.try_acquire("1.2.3.4") is None
            clock.now += 10
        wait = lim.try_acquire("1.2.3.4")
        # The oldest start was at t=1000 and the clock is at 1060: it ages out at 1000 + 3600.
        assert wait == 3540
        # Another client is not affected.
        assert lim.try_acquire("5.6.7.8") is None

    def test_a_slot_opens_when_the_oldest_start_ages_out(self) -> None:
        clock = Clock()
        lim = limiter(clock)
        for _ in range(6):
            assert lim.try_acquire("a") is None
            clock.now += 1
        assert lim.try_acquire("a") is not None
        clock.now = 1000.0 + WINDOW_S - 0.5
        assert lim.try_acquire("a") == 1  # rounds up, never 0
        clock.now = 1000.0 + WINDOW_S + 0.1
        assert lim.try_acquire("a") is None  # the first start has left the window

    def test_a_refused_start_is_not_counted(self) -> None:
        clock = Clock()
        lim = limiter(clock, per_ip=1)
        assert lim.try_acquire("a") is None
        for _ in range(5):
            assert lim.try_acquire("a") is not None
        clock.now += WINDOW_S + 1
        assert lim.try_acquire("a") is None  # the refusals did not extend the wait


class TestGlobal:
    def test_the_thirty_first_start_in_an_hour_is_refused_whoever_asks(self) -> None:
        clock = Clock()
        lim = limiter(clock)
        for index in range(30):
            assert lim.try_acquire(f"10.0.0.{index}") is None
            clock.now += 1
        wait = lim.try_acquire("brand-new-client")
        assert wait is not None and wait > 0
        clock.now = 1000.0 + WINDOW_S + 0.5
        assert lim.try_acquire("brand-new-client") is None

    def test_the_wait_is_the_longer_of_the_two_limits(self) -> None:
        clock = Clock()
        lim = limiter(clock, per_ip=2, overall=3)
        assert lim.try_acquire("a") is None  # t=1000
        clock.now = 1500
        assert lim.try_acquire("b") is None
        assert lim.try_acquire("b") is None  # global is now full (3); b is also at its own 2
        clock.now = 1600
        # Overall, the oldest start (t=1000) ages out at 4600: 3000 s away. b's own limit needs its
        # oldest (t=1500) to age out at 5100: 3500 s away. The honest wait is the longer.
        assert lim.try_acquire("b") == 3500


class TestRelease:
    def test_a_released_start_frees_both_counters(self) -> None:
        clock = Clock()
        lim = limiter(clock, per_ip=1, overall=1)
        ticket = lim.acquire("a")
        assert isinstance(ticket, StartTicket)
        assert lim.try_acquire("a") is not None
        lim.release(ticket)
        assert lim.try_acquire("a") is None  # the start another request had already begun

    def test_releasing_a_start_that_is_not_counted_is_harmless(self) -> None:
        lim = limiter(Clock())
        lim.release(StartTicket("nobody", 5.0))
        assert lim.try_acquire("nobody") is None

    def test_a_release_removes_the_callers_own_start_not_the_newest(self) -> None:
        """Two clients start; the FIRST gives its start back. The second's start (the newest in the
        overall window) must still count: when the first start's hour has passed, the overall
        budget is still occupied by the second."""
        clock = Clock()
        lim = limiter(clock, per_ip=6, overall=1)
        clock.now = 1000.0
        mine = lim.acquire("a")
        assert isinstance(mine, StartTicket)
        lim.release(mine)  # a gives its start back...
        clock.now = 1010.0
        theirs = lim.acquire("b")  # ...and b takes the one overall slot
        assert isinstance(theirs, StartTicket)
        # A second release of a's already-returned start must not give back b's newer one.
        lim.release(mine)
        clock.now = 1020.0
        wait = lim.acquire("c")
        assert wait == 3590  # b's start (t = 1010) still holds the slot until 4610

    def test_releasing_a_start_twice_never_touches_a_neighbours(self) -> None:
        clock = Clock()
        lim = limiter(clock, per_ip=6, overall=30)
        first = lim.acquire("a")
        clock.now += 1
        second = lim.acquire("a")
        assert isinstance(first, StartTicket) and isinstance(second, StartTicket)
        lim.release(first)
        lim.release(first)
        assert list(lim._clients["a"]) == [second.at]  # noqa: SLF001
        assert list(lim._global) == [second.at]  # noqa: SLF001


class TestClientKey:
    def test_the_cloudflare_header_wins_over_the_peer(self) -> None:
        assert client_key({"cf-connecting-ip": "203.0.113.7"}, "127.0.0.1") == "203.0.113.0/24"

    def test_the_peer_is_used_without_the_header(self) -> None:
        assert client_key({}, "198.51.100.9") == "198.51.100.0/24"

    @pytest.mark.parametrize(
        "junk", ["", "   ", "not-an-ip", "1.2.3", "1.2.3.4.5", "x" * 200, "1.2.3.4,5.6.7.8"]
    )
    def test_a_header_that_is_not_an_address_is_ignored(self, junk: str) -> None:
        assert client_key({"cf-connecting-ip": junk}, "198.51.100.9") == "198.51.100.0/24"

    def test_with_nothing_usable_there_is_still_a_key(self) -> None:
        assert client_key({}, None) == "unknown"
        assert client_key({"cf-connecting-ip": "junk"}, "testclient") == "unknown"

    def test_an_ipv6_client_counts_as_its_slash_48(self) -> None:
        one = client_key({"cf-connecting-ip": "2001:db8:1:2:aaaa:bbbb:cccc:dddd"}, None)
        two = client_key({"cf-connecting-ip": "2001:db8:1:ffff::1"}, None)
        other = client_key({"cf-connecting-ip": "2001:db8:2:2::1"}, None)
        assert one == two == "2001:db8:1::/48"
        assert other != one

    def test_an_ipv4_client_counts_as_its_slash_24(self) -> None:
        one = client_key({"cf-connecting-ip": "203.0.113.7"}, None)
        two = client_key({"cf-connecting-ip": "203.0.113.250"}, None)
        other = client_key({"cf-connecting-ip": "203.0.114.7"}, None)
        assert one == two == "203.0.113.0/24"
        assert other != one

    def test_an_ipv4_mapped_ipv6_address_is_its_ipv4_slash_24(self) -> None:
        assert client_key({"cf-connecting-ip": "::ffff:203.0.113.7"}, None) == "203.0.113.0/24"


class TestBoundedMemory:
    def test_the_per_client_table_never_outgrows_its_bound(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(limits_module, "MAX_TRACKED_CLIENTS", 50)
        clock = Clock()
        lim = StartLimiter(PublicLimits(global_per_hour=10**9, per_ip_per_hour=6), clock=clock)
        for index in range(500):
            assert lim.try_acquire(f"client-{index}") is None
            clock.now += 0.001
        assert len(lim._clients) <= 50  # noqa: SLF001
        assert MAX_TRACKED_CLIENTS == 50_000  # the production bound

    def test_aged_out_clients_are_forgotten(self) -> None:
        clock = Clock()
        lim = limiter(clock)
        for index in range(100):
            lim.try_acquire(f"client-{index}")
        clock.now += WINDOW_S + 120
        lim.try_acquire("fresh")
        assert set(lim._clients) == {"fresh"}  # noqa: SLF001


class TestNothingIsLogged:
    def test_no_address_reaches_a_log(self, caplog: pytest.LogCaptureFixture) -> None:
        clock = Clock()
        lim = limiter(clock, per_ip=1)
        with caplog.at_level(logging.DEBUG):
            lim.try_acquire("203.0.113.7")
            lim.try_acquire("203.0.113.7")
            client_key({"cf-connecting-ip": "203.0.113.7"}, "198.51.100.9")
        assert "203.0.113.7" not in caplog.text and "198.51.100.9" not in caplog.text
