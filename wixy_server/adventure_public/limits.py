"""The rate limits on STARTING public research (spec/adventure-public/README.md §2.2 "Cost bound").

The cache is keyed by destination, so the most research the public game can ever cause is one
run per bank destination plus bounded retries. On top of that, starting research is limited
in two ways, both over a rolling hour:

- globally: at most `global_per_hour` (30) new research runs;
- per client: at most `per_ip_per_hour` (6) research starts per client address.

The client address is the `CF-Connecting-IP` header when it holds a valid address (the host is only
reachable through Cloudflare's tunnel), else the socket peer; an IPv6 address counts as its /64 (one
subscriber holds a whole /64). The counters live in memory ONLY: they are never logged, never
persisted and never sent anywhere (spec §2.6), and the per-client table is bounded.
"""

from __future__ import annotations

import ipaddress
import math
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass

WINDOW_S = 3600.0
SWEEP_EVERY_S = 60.0
MAX_TRACKED_CLIENTS = 50_000
"""The per-client table never holds more than this many keys: once full, the clients whose window
ends soonest are dropped to make room (a table flooded with fake addresses cannot grow memory)."""


@dataclass(frozen=True, slots=True)
class PublicLimits:
    global_per_hour: int = 30
    per_ip_per_hour: int = 6


def client_key(headers: Mapping[str, str], peer: str | None) -> str:
    """The rate-limit key of a request: `CF-Connecting-IP` when it is a valid address, else the
    socket peer, else `"unknown"`. IPv6 is reduced to its /64. Never logged."""
    for candidate in (headers.get("cf-connecting-ip"), peer):
        key = _normalise(candidate)
        if key is not None:
            return key
    return "unknown"


def _normalise(value: str | None) -> str | None:
    if value is None or not value.strip() or len(value) > 64:
        return None
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        return str(ipaddress.ip_network(f"{address}/64", strict=False).network_address) + "/64"
    return str(address)


class StartLimiter:
    """Admits at most `global_per_hour` starts per rolling hour overall and `per_ip_per_hour` per
    client key. `try_acquire` answers `None` (admitted and counted) or the whole seconds the caller
    should wait (`Retry-After`)."""

    def __init__(
        self,
        limits: PublicLimits | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limits = limits if limits is not None else PublicLimits()
        self._clock = clock
        self._lock = threading.Lock()
        self._global: deque[float] = deque()
        self._clients: dict[str, deque[float]] = {}
        self._last_sweep = float("-inf")

    @property
    def limits(self) -> PublicLimits:
        return self._limits

    def try_acquire(self, client: str) -> int | None:
        now = self._clock()
        with self._lock:
            self._prune(now)
            global_wait = self._wait(self._global, self._limits.global_per_hour, now)
            client_hits = self._clients.get(client)
            client_wait = (
                self._wait(client_hits, self._limits.per_ip_per_hour, now)
                if client_hits is not None
                else 0.0
            )
            if global_wait > 0.0 or client_wait > 0.0:
                return max(1, math.ceil(max(global_wait, client_wait)))
            self._global.append(now)
            if client_hits is None:
                if len(self._clients) >= MAX_TRACKED_CLIENTS:
                    self._evict()
                client_hits = self._clients[client] = deque()
            client_hits.append(now)
            return None

    def release(self, client: str) -> None:
        """Give back the start `try_acquire` just counted (another request had already begun the
        same research, so nothing new was started)."""
        with self._lock:
            if self._global:
                self._global.pop()
            hits = self._clients.get(client)
            if hits:
                hits.pop()
                if not hits:
                    del self._clients[client]

    @staticmethod
    def _wait(hits: deque[float], limit: int, now: float) -> float:
        """Seconds until a slot opens: 0 when fewer than `limit` starts are in the window."""
        if len(hits) < limit:
            return 0.0
        return hits[len(hits) - limit] + WINDOW_S - now

    def _prune(self, now: float) -> None:
        """Drop every hit older than the window (the whole table at most once a minute)."""
        if now - self._last_sweep < SWEEP_EVERY_S and self._last_sweep <= now:
            return
        self._last_sweep = now
        horizon = now - WINDOW_S
        while self._global and self._global[0] <= horizon:
            self._global.popleft()
        for key in list(self._clients):
            hits = self._clients[key]
            while hits and hits[0] <= horizon:
                hits.popleft()
            if not hits:
                del self._clients[key]

    def _evict(self) -> None:
        by_expiry = sorted(self._clients, key=lambda k: self._clients[k][-1])
        for key in by_expiry[: max(1, MAX_TRACKED_CLIENTS // 10)]:
            del self._clients[key]
