"""Suite-wide guards for `wixy_server/tests`."""

from __future__ import annotations

import functools
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import pytest

import wixy_server.app as wixy_app_module
from wixy_server.cmdchat import CmdChatClient
from wixy_server.livechat import cookout_pack
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


_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


@pytest.fixture(autouse=True)
def _cookout_pack_never_downloads_from_the_internet(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every app a test starts runs the Cookout picture self-heal, and a fresh tmp storage root
    never holds the pack, so without this EVERY app-starting test downloaded the 44 MB pack from
    GitHub and unpacked its ~7,000 pictures into its own tmp directory: ~38 MB written per test,
    ~50 GiB an hour on a full run, most of the suite's wall time, and a test outcome that depended
    on GitHub (decisions/00217). A download to anything but loopback is refused as `FetchRefused`
    (the self-heal's own "not now" answer), so the app keeps its emoji tiles; the pack tests' local
    test server on loopback still works. Tests that need pictures inject their own small pack."""
    real_download = cookout_pack._download
    real_fetch = cookout_pack.PackStore.fetch

    def _refuse_internet(url: str) -> None:
        parts = urlsplit(url)
        # Only a web download is the guard's business; any other scheme reaches the real
        # downloader, which refuses it itself (and has its own test).
        if parts.scheme in ("http", "https") and parts.hostname not in _LOOPBACK_HOSTS:
            raise cookout_pack.FetchRefused(
                f"the test suite must never download from the internet: {url}"
            )

    def _loopback_only(url: str, part: Path, **kwargs: Any) -> None:
        _refuse_internet(url)
        real_download(url, part, **kwargs)

    def _fetch_loopback_only(
        self: cookout_pack.PackStore,
        manifest: cookout_pack.PackManifest,
        *,
        url: str | None = None,
    ) -> int:
        # Refused BEFORE `fetch` sizes what is already present (a stat of every object) and takes
        # the store lock: a refused fetch costs nothing.
        if manifest.pack is not None:
            _refuse_internet(url or manifest.pack.url)
        return real_fetch(self, manifest, url=url)

    monkeypatch.setattr(cookout_pack, "_download", _loopback_only)
    monkeypatch.setattr(cookout_pack.PackStore, "fetch", _fetch_loopback_only)


@pytest.fixture(autouse=True)
def _no_background_sweep_outlives_its_test(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The Cookout picture sweep's first tick runs on an abandonable worker thread, so a short test
    ended with it still running and it leaked into the next test of the same xdist worker. Count
    sweeps in flight and wait for them as the test ends (this fixture is set up first, so it is torn
    down after every other fixture, including `live_env`'s app shutdown)."""
    leak_guard.install(monkeypatch)
    yield
    assert leak_guard.drain(), "a Cookout picture sweep thread is still running after the test"
