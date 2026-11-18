"""Suite-wide guards for `wixy_server/tests`."""

from __future__ import annotations

import functools
from collections.abc import Iterator

import httpx
import pytest

import wixy_server.app as wixy_app_module
from wixy_server.cmdchat import CmdChatClient
from wixy_server.livechat.adventure_pack import CmdAdventureResearcher
from wixy_server.livechat.transcribe import CmdTranscriber
from wixy_server.tests import leak_guard


@pytest.fixture(autouse=True)
def _default_transcriber_never_reaches_a_real_cmd(monkeypatch: pytest.MonkeyPatch) -> None:
    """`create_app` builds a real `CmdTranscriber` on the fleet edition when a test does not
    inject one, and `GET /usage` probes it. On the hub box a real cmd listens on 9320, so such a
    test would talk to (and, once cmd's private mode ships, be answered by) production. Every
    un-injected transcriber gets a transport that answers 404, so the default is "unavailable"
    and nothing here ever leaves the process."""

    def _inert(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    monkeypatch.setattr(
        wixy_app_module,
        "CmdTranscriber",
        functools.partial(CmdTranscriber, transport=httpx.MockTransport(_inert)),
    )


@pytest.fixture(autouse=True)
def _default_adventure_researcher_never_reaches_a_real_cmd(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """On the fleet edition `create_app` builds a `CmdAdventureResearcher` over the app's own
    `CmdChatClient` when a test does not inject a researcher, and choosing an Adventure Time place
    starts a real cmd chat-spawn run with it. On the hub box a real cmd listens on 9320, so such a
    test would start a real (subscription-billed) research chat. Every un-injected researcher gets
    a client whose transport answers 404, so a run is simply refused and nothing leaves the
    process (the Adventure Time tests inject a `FakeResearcher` or a fake-cmd-pointed client)."""

    def _inert(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    def _inert_researcher(_client: CmdChatClient) -> CmdAdventureResearcher:
        return CmdAdventureResearcher(CmdChatClient(transport=httpx.MockTransport(_inert)))

    monkeypatch.setattr(wixy_app_module, "CmdAdventureResearcher", _inert_researcher)


@pytest.fixture(autouse=True)
def _no_background_sweep_outlives_its_test(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The Cookout picture sweep's first tick runs on an abandonable worker thread, so a short test
    ended with it still running and it leaked into the next test of the same xdist worker. Count
    sweeps in flight and wait for them as the test ends (this fixture is set up first, so it is torn
    down after every other fixture, including `live_env`'s app shutdown)."""
    leak_guard.install(monkeypatch)
    yield
    assert leak_guard.drain(), "a Cookout picture sweep thread is still running after the test"
