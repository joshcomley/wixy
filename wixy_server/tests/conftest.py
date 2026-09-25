"""Suite-wide guards for `wixy_server/tests`."""

from __future__ import annotations

import functools

import httpx
import pytest

import wixy_server.app as wixy_app_module
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
