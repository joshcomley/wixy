# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as parameters)
"""`create_app` wires the real Cookout runner (workspace 00058, spec §3.5): on the fleet edition a
round that finishes its tenth pick gets three validated concepts from the (fake) cmd, "Bank this"
banks a validated recipe into the Recipe book, and the edition without cmd stays playable with its
dish ideas `unavailable`. Real ingredient bank, real store, real routes; only cmd is faked."""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.cmdchat import CmdChatClient
from wixy_server.livechat.cookout_ai import CmdCookoutRunner, CookoutTiming
from wixy_server.livechat.cookout_game import NullCookoutRunner
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.tests.fake_cmd import FakeCmdState, create_fake_cmd_app
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    TEST_PIN,
    UNLOCK_GUARD_HEADERS,
    _dev_no_auth,
    _form_style_json,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)
from wixy_server.tests.test_routes_livechat_cookout import BASE, create, mv, play, post

FAST = CookoutTiming(poll_interval_s=0.02, spawn_gap_s=0.0, give_up_s=30.0, sweep_interval_s=0.2)


@contextmanager
def wired_client(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    fake_cmd_state: FakeCmdState,
    *,
    with_cmd: bool = True,
    edition: str | None = None,
) -> Iterator[tuple[TestClient, dict[str, str]]]:
    kwargs: dict[str, Any] = {}
    if with_cmd:
        kwargs["cmdchat_client"] = CmdChatClient(
            transport=httpx.ASGITransport(app=create_fake_cmd_app(fake_cmd_state))
        )
    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=AsyncMock(),
        cookout_timing=FAST,
        **kwargs,
    )
    client = TestClient(app, cookies={"CF_Authorization": "dummy"})
    client.__enter__()
    try:
        resp = client.post(
            f"{BASE}/unlock",
            content=_form_style_json(TEST_PIN),
            headers={
                **UNLOCK_GUARD_HEADERS,
                "Sec-Fetch-Site": "same-origin",
                "CF-Access-Authenticated-User-Email": "a@example.com",
            },
        )
        assert resp.status_code == 200, resp.text
        yield (
            client,
            {
                "X-Wixy-Server-Token": resp.json()["token"],
                "CF-Access-Authenticated-User-Email": "a@example.com",
            },
        )
    finally:
        client.__exit__(None, None, None)


def view(client: TestClient, h: dict[str, str], seq: int) -> dict[str, Any]:
    response = client.get(f"{BASE}/cookout/{seq}", params={"as": "Josh"}, headers=h)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def wait_for(
    client: TestClient, h: dict[str, str], seq: int, done: Any, what: str, secs: float = 30.0
) -> dict[str, Any]:
    deadline = time.monotonic() + secs
    while time.monotonic() < deadline:
        current = view(client, h, seq)
        if done(current):
            return current
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}: {view(client, h, seq)}")


def test_the_fleet_edition_wires_the_real_runner(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    fake_cmd_state: FakeCmdState,
) -> None:
    with wired_client(storage_root, wixy_repo_root, pin_verifier, fake_cmd_state) as (client, h):
        runner = client.app.state.livechat_cookout_runner  # type: ignore[attr-defined]
        assert isinstance(runner, CmdCookoutRunner)
        assert runner.available and not runner.images_available  # no ComfyUI configured
        assert (storage_root / "projects").exists()


def test_a_finished_round_gets_concepts_and_a_banked_recipe_through_cmd(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    fake_cmd_state: FakeCmdState,
) -> None:
    with wired_client(storage_root, wixy_repo_root, pin_verifier, fake_cmd_state) as (client, h):
        seq = create(client, h)
        play(client, h, seq)
        ready = wait_for(
            client, h, seq, lambda v: v["concepts"]["state"] in ("ready", "failed"), "concepts"
        )
        assert ready["concepts"]["state"] == "ready", ready["concepts"]
        concepts = ready["concepts"]["data"]
        assert [c["id"] for c in concepts] == ["a", "b", "c"]
        assert ready["images"]["state"] == "none"  # no ComfyUI in this app
        callers = [str(r.body["caller"]) for r in fake_cmd_state.chat_spawn_runs.values()]
        assert callers == ["wixy-cookout-concepts"]

        response = post(client, h, f"/cookout/{seq}/concepts/b/bank", sender="Rose", moveId=mv())
        assert response.status_code == 200, response.text
        banked = wait_for(
            client,
            h,
            seq,
            lambda v: v["recipes"]["b"]["state"] in ("banked", "failed"),
            "the recipe",
        )
        assert banked["recipes"]["b"]["state"] == "banked", banked["recipes"]["b"]
        assert banked["recipes"]["b"]["data"]["serves"] == 2
        book = client.get(f"{BASE}/cookout/bank", headers=h).json()["recipes"]
        assert [(r["seq"], r["conceptId"]) for r in book] == [(seq, "b")]


def test_without_cmd_in_the_standalone_edition_the_game_is_playable_but_unavailable(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    fake_cmd_state: FakeCmdState,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WIXY_EDITION", "standalone")
    with wired_client(
        storage_root, wixy_repo_root, pin_verifier, fake_cmd_state, with_cmd=False
    ) as (client, h):
        assert isinstance(client.app.state.livechat_cookout_runner, NullCookoutRunner)  # type: ignore[attr-defined]
        seq = create(client, h)
        play(client, h, seq)
        done = view(client, h, seq)
        assert done["state"] == "finished"
        assert done["concepts"]["state"] == "unavailable"
        assert done["images"]["state"] == "none"
        assert len(done["players"][0]["picks"]) == 5  # the reveal still works
