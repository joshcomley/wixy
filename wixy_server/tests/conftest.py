"""Suite-wide guards for `wixy_server/tests`."""

from __future__ import annotations

import functools

import httpx
import pytest

import wixy_server.app as wixy_app_module
from wixy_server.cmdchat import CmdChatClient
from wixy_server.livechat.adventure_pack import CmdAdventureResearcher
from wixy_server.livechat.transcribe import CmdTranscriber


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
