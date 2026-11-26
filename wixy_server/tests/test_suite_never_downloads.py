"""The suite never downloads from the internet (workspace 00065, decisions/00217).

Every app a test starts runs the Cookout picture self-heal, and a fresh test storage root never holds
the pack, so before the guard in `conftest.py` EVERY app-starting test downloaded the 44 MB pack from
GitHub and unpacked its ~7,000 pictures into its own tmp directory (~38 MB a test, ~50 GiB an hour
on a busy run, and most of the suite's wall time). These tests pin the guard: an app's lifespan leaves
no pictures behind, a download to a non-loopback host is refused, and a loopback one (the pack tests'
own local server) still goes through."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.livechat import cookout_pack
from wixy_server.tests import leak_guard
from wixy_server.tests.live_voice_testkit import make_wixy_repo


def test_an_app_lifespan_downloads_no_cookout_pictures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WIXY_DEV_NO_AUTH", "1")
    repo_base = tmp_path / "repo"
    repo_base.mkdir()
    storage = tmp_path / "storage"
    app = create_app(storage_root=storage, wixy_repo_root=make_wixy_repo(repo_base))
    with TestClient(app) as client:
        assert client.get("/api/version").status_code == 200
        assert leak_guard.drain(), "the first picture sweep did not finish"
    objects = storage / "cookout-images" / "objects"
    written = [p for p in objects.rglob("*") if p.is_file()] if objects.exists() else []
    assert written == []


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/joshcomley/wixy/releases/download/cookout-images-v2/cookout-images-v2.tar",
        "http://example.com/pack.tar",
        "http://10.0.0.5/pack.tar",
    ],
)
def test_a_download_to_a_non_loopback_host_is_refused(url: str, tmp_path: Path) -> None:
    with pytest.raises(cookout_pack.FetchRefused, match="never download"):
        cookout_pack._download(
            url, tmp_path / "x.part", max_bytes=10, expected_bytes=10, deadline_s=5.0
        )
    assert not (tmp_path / "x.part").exists()


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]"])
def test_a_loopback_download_is_left_to_the_real_downloader(host: str, tmp_path: Path) -> None:
    """Port 1 refuses the connection: the error is the real downloader's, not the guard's."""
    with pytest.raises(Exception) as caught:
        cookout_pack._download(
            f"http://{host}:1/pack.tar",
            tmp_path / "x.part",
            max_bytes=10,
            expected_bytes=10,
            deadline_s=5.0,
        )
    assert "never download" not in str(caught.value)
