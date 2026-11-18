"""No background sweep outlives its test (workspace 00058, main sync).

`CookoutVisualsService.run` runs its first sweep (`tick`: slot pin, picture self-heal) on a worker
thread with `abandon_on_cancel=True`, deliberately, so production shutdown never waits on a slow
download. A fast test therefore ended with that thread still running, and in the same xdist worker
it kept looking up files while the next test had patched `Path.is_file` process-wide (the
`test_no_per_picture_file_lookup_runs_with_or_without_a_pack` failure).

`track()` counts the sweeps in flight; `drain()` waits for them at the end of the test (the autouse
fixture in `conftest.py`), so a test never hands a running thread to its successor."""

from __future__ import annotations

import functools
import threading
from collections.abc import Callable
from typing import Any

from wixy_server.livechat.cookout_visuals import CookoutVisualsService

_idle = threading.Condition()
_inflight = 0


def inflight() -> int:
    with _idle:
        return _inflight


def track(original: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a sweep step so its execution is counted while it runs (on whatever thread)."""

    @functools.wraps(original)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        global _inflight
        with _idle:
            _inflight += 1
        try:
            return original(*args, **kwargs)
        finally:
            with _idle:
                _inflight -= 1
                _idle.notify_all()

    return wrapper


def drain(timeout_s: float = 30.0) -> bool:
    """Wait until no tracked sweep is running. False when one is still running at the deadline."""
    with _idle:
        return _idle.wait_for(lambda: _inflight == 0, timeout=timeout_s)


def install(monkeypatch: Any) -> None:
    monkeypatch.setattr(CookoutVisualsService, "tick", track(CookoutVisualsService.tick))
