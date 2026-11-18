"""The leak guard itself (workspace 00058, main sync): a sweep thread that is still running when a
test body ends is waited for, and one that never ends is reported rather than handed on."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from wixy_server.tests import leak_guard
from wixy_server.tests.live_voice_testkit import live_env, make_wixy_repo


def test_drain_waits_for_a_running_tracked_sweep_and_reports_a_stuck_one() -> None:
    release = threading.Event()
    started = threading.Event()

    def sweep() -> None:
        started.set()
        release.wait(10)

    thread = threading.Thread(target=leak_guard.track(sweep))
    thread.start()
    assert started.wait(5) and leak_guard.inflight() == 1
    assert leak_guard.drain(0.2) is False  # still running: reported, never silently passed on
    release.set()
    assert leak_guard.drain(5.0) is True and leak_guard.inflight() == 0
    thread.join()


def test_an_app_lifespan_leaves_no_picture_sweep_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The first sweep runs on an abandonable worker thread; slow it down so it is certainly still
    running when the app shuts down, then prove the guard waits it out."""
    from wixy_server.livechat.cookout_visuals import CookoutVisualsService

    entered = threading.Event()
    finished = threading.Event()
    real_tick = CookoutVisualsService.tick

    def slow_tick(self: CookoutVisualsService) -> None:
        entered.set()
        finished.wait(0.5)  # the lifespan is long gone by the time this returns
        real_tick(self)

    monkeypatch.setattr(CookoutVisualsService, "tick", slow_tick)
    leak_guard.install(monkeypatch)  # re-wrap the slow tick, as the autouse fixture does
    with live_env(tmp_path, make_wixy_repo(tmp_path / "repo"), monkeypatch):
        assert entered.wait(10)
    assert leak_guard.inflight() == 1, "the abandoned sweep must be observably still running"
    assert leak_guard.drain(30.0) is True
    assert leak_guard.inflight() == 0
