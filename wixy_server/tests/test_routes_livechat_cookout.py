# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""Cookout over HTTP (workspace 00058, spec/server-chat/09-cookout.md §4.2, §6): the unlock gate on
every route (and a revoked grant), the exact view shape, every validation bound and 409 code, Blind
mode's redaction on EVERY response a player receives (mutation responses included) with
`Cache-Control: no-store`, the idempotent replays, the job starts (once per transition, through the
`CookoutRunner` seam), the retries, the Recipe book, the game chat (`wyrSeq`), and the edition
without a runner. The store and the pure view are `test_livechat_cookout.py`."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from wixy_server.app import create_app
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat.cookout_game import NullCookoutRunner
from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.tests.adventure_testkit import run_concurrently
from wixy_server.tests.test_livechat_cookout import FakeBank, canned_concepts
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

BASE = "/api/admin/server"


class FakeRunner:
    """A `CookoutRunner` that records every start and runs nothing."""

    def __init__(self, *, available: bool = True, images: bool = True) -> None:
        self.available = available
        self.images_available = images
        self.concepts: list[int] = []
        self.pictures: list[int] = []
        self.recipes: list[tuple[int, str]] = []
        self.resumed = 0
        self.supervised = 0

    def start_concepts(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        self.concepts.append(anchor_seq)

    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        self.pictures.append(anchor_seq)

    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, concept_id: str
    ) -> None:
        self.recipes.append((anchor_seq, concept_id))

    async def resume(self, background: ContainedTaskGroup) -> None:
        self.resumed += 1

    def supervise(self, background: ContainedTaskGroup) -> None:
        self.supervised += 1


@contextmanager
def cookout_client(
    storage_root: Path,
    wixy_repo_root: Path,
    pin_verifier: CmdPinVerifier,
    *,
    runner: FakeRunner | None = None,
    no_runner: bool = False,
    bank: FakeBank | None = None,
    email: str = "a@example.com",
) -> Iterator[tuple[TestClient, dict[str, str], FakeRunner | None]]:
    """An app with the small fake bank and a recording runner (or none, as the standalone edition
    has) and an unlocked token, closed on exit."""
    resolved = None if no_runner else (runner if runner is not None else FakeRunner())
    app = create_app(
        storage_root=storage_root,
        wixy_repo_root=wixy_repo_root,
        pin_verifier=pin_verifier,
        transcriber=AsyncMock(),
        cookout_bank=bank if bank is not None else FakeBank(),
        # The edition without a runner: `create_app` would otherwise build the real, cmd-backed one.
        cookout_runner=resolved if resolved is not None else NullCookoutRunner(),
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
                "CF-Access-Authenticated-User-Email": email,
            },
        )
        assert resp.status_code == 200, resp.text
        yield (
            client,
            {
                "X-Wixy-Server-Token": resp.json()["token"],
                "CF-Access-Authenticated-User-Email": email,
            },
            resolved,
        )
    finally:
        client.__exit__(None, None, None)


_MOVE = iter(range(1, 10**6))


def mv() -> str:
    return f"route-move-{next(_MOVE):07d}"


def post(client: TestClient, h: dict[str, str], path: str, **body: Any) -> Any:
    return client.post(f"{BASE}{path}", json=body, headers=h)


def create(
    client: TestClient,
    h: dict[str, str],
    cid: str = "cookout-route-0001",
    sender: str = "Josh",
    *,
    blind: bool = False,
) -> int:
    response = post(
        client, h, "/cookout", clientId=cid, deviceId="device-1234", sender=sender, blind=blind
    )
    assert response.status_code == 201, response.text
    return int(response.json()["message"]["seq"])


def view(client: TestClient, h: dict[str, str], seq: int, viewer: str | None) -> dict[str, Any]:
    suffix = f"?as={viewer}" if viewer else ""
    response = client.get(f"{BASE}/cookout/{seq}{suffix}", headers=h)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body: dict[str, Any] = response.json()
    return body


def move_pick(
    client: TestClient, h: dict[str, str], seq: int, sender: str, *, index: int = 0
) -> Any:
    v = view(client, h, seq, sender)
    cur = v["current"]
    assert cur is not None and cur["options"] is not None, v
    return post(
        client,
        h,
        f"/cookout/{seq}/pick",
        sender=sender,
        moveId=mv(),
        turn=cur["turn"],
        offer=cur["offerIndex"],
        ingredientId=cur["options"][index]["id"],
    )


def move_skip(client: TestClient, h: dict[str, str], seq: int, sender: str) -> Any:
    cur = view(client, h, seq, sender)["current"]
    return post(
        client,
        h,
        f"/cookout/{seq}/skip",
        sender=sender,
        moveId=mv(),
        turn=cur["turn"],
        offer=cur["offerIndex"],
    )


def play(client: TestClient, h: dict[str, str], seq: int, *, join: bool = True) -> None:
    if join:
        assert post(client, h, f"/cookout/{seq}/join", sender="Rose").status_code == 200
    for turn in range(1, 11):
        response = move_pick(client, h, seq, "Josh" if turn % 2 == 1 else "Rose")
        assert response.status_code == 200, response.text


def store_of(client: TestClient) -> LiveChatStore:
    store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
    return store


def finish_concepts(client: TestClient, seq: int, *, pictures: bool = False) -> None:
    store = store_of(client)
    picked = store.get_cookout_round(seq)["picked_ids"]  # type: ignore[index]
    assert store.set_cookout_concepts_run(seq, "run-1")
    assert store.finish_cookout_concepts(
        seq, "run-1", "ready", concepts_json=canned_concepts(picked), pictures_pending=pictures
    )


# -- auth -----------------------------------------------------------------------------------------

_SKIP = {"sender": "Josh", "moveId": "move-0000001", "turn": 1, "offer": 0}
_PICK = {**_SKIP, "ingredientId": "base-00"}

ROUTES = [
    (
        "POST",
        "/cookout",
        {"clientId": "c" * 8, "deviceId": "d" * 8, "sender": "Josh", "blind": True},
    ),
    ("GET", "/cookout/bank", None),
    ("GET", "/cookout/1", None),
    ("GET", "/cookout/1?as=Josh", None),
    ("POST", "/cookout/1/join", {"sender": "Rose"}),
    ("POST", "/cookout/1/skip", _SKIP),
    ("POST", "/cookout/1/pick", _PICK),
    ("POST", "/cookout/1/abandon", {"sender": "Josh"}),
    ("POST", "/cookout/1/concepts/retry", {"sender": "Josh"}),
    ("POST", "/cookout/1/pictures/retry", {"sender": "Josh"}),
    ("POST", "/cookout/1/concepts/a/bank", {"sender": "Josh", "moveId": "move-0000001"}),
    ("POST", "/cookout/1/concepts/a/recipe/retry", {"sender": "Josh"}),
    # Invalid bodies on a locked client must still be a 401, never a hint about validation.
    ("POST", "/cookout/1/pick", {**_PICK, "turn": 99, "ingredientId": ""}),
    ("POST", "/cookout/1/skip", {**_SKIP, "offer": 7}),
    ("POST", "/cookout/1/concepts/zz/bank", {"sender": "Josh", "moveId": "x"}),
    ("GET", "/cookout/0", None),
]


class TestAuth:
    @pytest.mark.parametrize(("method", "path", "body"), ROUTES)
    def test_every_route_needs_the_unlock_token(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        method: str,
        path: str,
        body: Any,
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            for bad in ({}, {"X-Wixy-Server-Token": "not-a-token"}):
                response = client.request(method, f"{BASE}{path}", json=body, headers=bad)
                assert response.status_code == 401, (path, response.text)
                assert response.json() == {"error": "locked"}
            ok = client.request(method, f"{BASE}{path}", json=body, headers=h)
            assert ok.status_code != 401

    def test_a_token_bound_to_a_revoked_grant_is_refused_on_every_route(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            enrolled = client.post(
                f"{BASE}/device-grants",
                json={"pin": TEST_PIN},
                headers={**UNLOCK_GUARD_HEADERS, "Sec-Fetch-Site": "same-origin", **h},
            )
            assert enrolled.status_code == 201, enrolled.text
            grant_h = {**h, "X-Wixy-Server-Token": enrolled.json()["token"]}
            assert client.get(f"{BASE}/cookout/{seq}", headers=grant_h).status_code == 200
            assert store_of(client).revoke_device_grant(
                grant_id=enrolled.json()["grantId"], email="a@example.com", now=time.time()
            )
            for method, path, body in ROUTES:
                response = client.request(method, f"{BASE}{path}", json=body, headers=grant_h)
                assert response.status_code == 401, (method, path)


# -- create ---------------------------------------------------------------------------------------


class TestCreate:
    def test_it_creates_the_anchor_binds_slot_one_and_replays_a_client_id(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            created = post(
                client, h, "/cookout", clientId="cookout-route-0001", deviceId="device-1234",
                sender="Bubble", blind=True,
            )  # fmt: skip
            assert created.status_code == 201, created.text
            message = created.json()["message"]
            assert message["cookout"] == {
                "state": "picking",
                "blind": True,
                "pickedCount": 0,
                "concepts": "none",
                "bankedCount": 0,
                "rev": 1,
            }
            assert message["text"] is None and message["sender"] == "Bubble"
            assert message["wyr"] is None and message["adventure"] is None
            v = view(client, h, message["seq"], "Bubble")
            assert v["you"] == {"slot": 1} and v["current"]["turn"] == 1
            assert v["players"][0]["name"] == "Bubble" and v["players"][1]["name"] is None
            names = [o["name"] for o in v["current"]["options"]]
            assert not any(n in json.dumps(message) for n in names)  # broadcast carries no food

            again = post(
                client, h, "/cookout", clientId="cookout-route-0001", deviceId="device-1234",
                sender="Cupcake",
            )  # fmt: skip
            assert again.status_code == 200 and again.json()["message"]["seq"] == message["seq"]
            history = client.get(f"{BASE}/messages", headers=h).json()["messages"]
            [anchor] = [m for m in history if m["seq"] == message["seq"]]
            assert anchor["cookout"] == message["cookout"]

    def test_the_mode_defaults_to_open_and_a_new_round_abandons_the_open_one(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            first = create(client, h, "cookout-route-0001")
            second = create(client, h, "cookout-route-0002", blind=True)
            assert view(client, h, first, "Josh")["state"] == "abandoned"
            assert view(client, h, second, "Josh")["blind"] is True
            assert view(client, h, first, "Josh")["blind"] is False

    @pytest.mark.parametrize(
        "body",
        [
            {"clientId": "short", "deviceId": "device-1234", "sender": "Josh"},
            {"clientId": "c" * 65, "deviceId": "device-1234", "sender": "Josh"},
            {"clientId": "cookout-route-0001", "deviceId": "short", "sender": "Josh"},
            {"clientId": "cookout-route-0001", "deviceId": "device-1234", "sender": ""},
            {"clientId": "cookout-route-0001", "deviceId": "device-1234", "sender": "x" * 33},
            {"clientId": "cookout-route-0001", "deviceId": "device-1234", "sender": "a\nb"},
        ],
    )
    def test_bad_bodies_are_422(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        body: dict[str, Any],
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            response = client.post(f"{BASE}/cookout", json=body, headers=h)
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"

    def test_without_a_bank_the_game_is_unavailable_but_chat_lives(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            client.app.state.livechat_cookout_bank = None  # type: ignore[attr-defined]
            response = post(
                client,
                h,
                "/cookout",
                clientId="cookout-route-0001",
                deviceId="device-1234",
                sender="Josh",
            )
            assert response.status_code == 503 and response.json() == {"error": "game_unavailable"}
            assert client.get(f"{BASE}/messages", headers=h).status_code == 200


# -- view -----------------------------------------------------------------------------------------


class TestView:
    @pytest.mark.parametrize("seq", ["0", "-3", "999", str(2**63)])
    def test_an_unknown_round_is_404(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier, seq: str
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            response = client.get(f"{BASE}/cookout/{seq}", headers=h)
            assert response.status_code == 404 and response.json() == {"error": "not_found"}

    def test_the_as_name_is_validated_and_absent_means_nobody(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h, blind=True)
            assert client.get(f"{BASE}/cookout/{seq}?as=a%0Ab", headers=h).status_code == 422
            nobody = view(client, h, seq, None)
            assert nobody["you"] is None and nobody["current"]["options"] is None

    def test_a_mutation_response_is_the_callers_own_no_store_view(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h, blind=True)
            joined = post(client, h, f"/cookout/{seq}/join", sender="Rose")
            assert joined.status_code == 200 and joined.headers["cache-control"] == "no-store"
            body = joined.json()
            assert body["you"] == {"slot": 2}
            assert body["current"]["player"] == 1 and body["current"]["options"] is None


# -- the game over HTTP ---------------------------------------------------------------------------


class TestGame:
    def test_a_whole_blind_round_leaks_nothing_in_any_response_until_the_reveal(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h, blind=True)
            names: dict[str, set[str]] = {"Josh": set(), "Rose": set()}

            def remember(who: str) -> None:
                current = view(client, h, seq, who)["current"]
                options = current["options"] if current is not None else None
                names[who] |= {o["name"] for o in options or []}

            def assert_blind(response: Any, partner: str) -> None:
                assert response.status_code == 200, response.text
                assert response.headers["cache-control"] == "no-store"
                text = response.text
                assert not any(n in text for n in names[partner]), partner

            remember("Josh")
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            for turn in range(1, 11):
                who, partner = ("Josh", "Rose") if turn % 2 == 1 else ("Rose", "Josh")
                remember(who)
                if turn in (2, 5):
                    remember(who)
                    skipped = move_skip(client, h, seq, who)
                    remember(who)
                    assert_blind(skipped, partner)
                response = move_pick(client, h, seq, who)
                remember(who)
                if turn < 10:
                    assert_blind(response, partner)
                # Every other read is just as quiet.
                for viewer in ("Josh", "Rose", "Cupcake", None):
                    seen = client.get(
                        f"{BASE}/cookout/{seq}" + (f"?as={viewer}" if viewer else ""), headers=h
                    )
                    assert seen.headers["cache-control"] == "no-store"
                    if viewer in names and turn < 10:
                        other = "Rose" if viewer == "Josh" else "Josh"
                        assert not any(n in seen.text for n in names[other]), (viewer, turn)
                    if viewer not in names and turn < 10:
                        assert not any(n in seen.text for n in names["Josh"] | names["Rose"])
            final = view(client, h, seq, "Josh")
            assert final["state"] == "finished" and final["revealed"] is True
            assert [len(p["picks"]) for p in final["players"]] == [5, 5]
            assert runner.concepts == [seq]

    @staticmethod
    def _assert_blind_json(body: dict[str, Any], viewer: str) -> None:
        """The redaction invariants, asserted on the PARSED response body (never a substring): for
        a viewer who is not the active player every turn field is null, the partner's picks are
        null until finished, and history holds only the viewer's own turns."""
        slot = {"Josh": 1, "Rose": 2}[viewer]
        cur = body["current"]
        if cur is not None and cur["player"] != slot:
            for key in ("role", "options", "offerIndex", "skipsRemaining"):
                assert cur[key] is None, (viewer, key, cur)
        if body["state"] == "abandoned":
            assert body["revealed"] is False and body["current"] is None
        if body["state"] != "finished":
            for player in body["players"]:
                if player["slot"] != slot:
                    assert player["picks"] is None, (viewer, player)
        else:
            assert body["revealed"] is True
            assert [len(p["picks"]) for p in body["players"]] == [5, 5]
        assert all(h["player"] == slot for h in body["history"]), (viewer, body["history"])
        assert body["you"] == {"slot": slot}

    def test_blind_redaction_holds_in_every_mutation_response_parsed(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            check = self._assert_blind_json
            seq = create(client, h, blind=True)
            check(post(client, h, f"/cookout/{seq}/join", sender="Rose").json(), "Rose")
            for turn in range(1, 11):
                who = "Josh" if turn % 2 == 1 else "Rose"
                if turn in (2, 3):
                    skipped = move_skip(client, h, seq, who)
                    assert skipped.status_code == 200
                    check(skipped.json(), who)
                response = move_pick(client, h, seq, who)
                assert response.status_code == 200
                check(response.json(), who)
                for viewer in ("Josh", "Rose"):
                    check(view(client, h, seq, viewer), viewer)
            finish_concepts(client, seq)
            banked = post(client, h, f"/cookout/{seq}/concepts/a/bank", sender="Rose", moveId=mv())
            check(banked.json(), "Rose")
            for path in ("/concepts/retry", "/pictures/retry", "/concepts/a/recipe/retry"):
                response = post(client, h, f"/cookout/{seq}{path}", sender="Josh")
                if response.status_code == 200:
                    check(response.json(), "Josh")
            gone = create(client, h, "cookout-route-0009", blind=True)
            post(client, h, f"/cookout/{gone}/join", sender="Rose")
            move_pick(client, h, gone, "Josh")
            move_pick(client, h, gone, "Rose")
            ended = post(client, h, f"/cookout/{gone}/abandon", sender="Josh")
            check(ended.json(), "Josh")
            check(view(client, h, gone, "Rose"), "Rose")

    def test_the_real_committed_bank_plays_a_full_round_through_the_app(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        """No injected bank: `create_app` loads the shipped ~3,000-item bank, which must satisfy
        the game's `BankLike` seam for every create/join/skip/pick."""
        from wixy_server.livechat.cookout_bank import CookoutBank

        app = create_app(
            storage_root=storage_root,
            wixy_repo_root=wixy_repo_root,
            pin_verifier=pin_verifier,
            transcriber=AsyncMock(),
            cookout_runner=FakeRunner(),
        )
        assert isinstance(app.state.livechat_cookout_bank, CookoutBank)
        assert len(app.state.livechat_cookout_bank.ingredients) >= 2500
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
            h = {
                "X-Wixy-Server-Token": resp.json()["token"],
                "CF-Access-Authenticated-User-Email": "a@example.com",
            }
            seq = create(client, h, blind=False)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            seen: set[str] = set()
            for turn in range(1, 11):
                who = "Josh" if turn % 2 == 1 else "Rose"
                assert move_skip(client, h, seq, who).status_code == 200
                options = view(client, h, seq, who)["current"]["options"]
                assert len(options) == 2 and options[0]["category"] != options[1]["category"]
                response = move_pick(client, h, seq, who, index=1)
                assert response.status_code == 200, response.text
            final = view(client, h, seq, "Josh")
            assert final["state"] == "finished" and final["concepts"]["state"] == "pending"
            ids = [p["id"] for pl in final["players"] for p in pl["picks"]]
            assert len(ids) == len(set(ids)) == 10 and not (seen & set(ids))
            assert len(final["staples"]) == 8
        finally:
            client.__exit__(None, None, None)

    def test_409_codes(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            cur = view(client, h, seq, "Josh")["current"]
            body = {"moveId": mv(), "turn": 1, "offer": 0}
            options = cur["options"]

            def code(path: str, status: int, **extra: Any) -> str:
                response = post(client, h, f"/cookout/{seq}{path}", **extra)
                assert response.status_code == status, (path, response.text)
                return str(response.json().get("error"))

            assert (
                code("/pick", 409, sender="Rose", ingredientId=options[0]["id"], **body)
                == "not_your_turn"
            )
            assert code("/skip", 409, sender="Rose", **body) == "not_your_turn"
            assert (
                code("/pick", 409, sender="Cupcake", ingredientId=options[0]["id"], **body)
                == "not_player"
            )
            assert code("/skip", 409, sender="Cupcake", **body) == "not_player"
            assert (
                code("/pick", 422, sender="Josh", ingredientId="not-an-offer", **body) == "invalid"
            )
            assert (
                code(
                    "/pick",
                    409,
                    sender="Josh",
                    ingredientId=options[0]["id"],
                    moveId=mv(),
                    turn=1,
                    offer=1,
                )
                == "bad_state"
            )
            assert code("/skip", 409, sender="Josh", moveId=mv(), turn=2, offer=0) == "bad_state"
            assert code("/join", 409, sender="Cupcake") == "bad_state"
            assert code("/join", 409, sender="Josh") == "bad_state"
            for _ in range(2):
                assert move_skip(client, h, seq, "Josh").status_code == 200
            assert (
                code("/skip", 409, sender="Josh", moveId=mv(), turn=1, offer=2) == "skip_exhausted"
            )
            assert code("/abandon", 409, sender="Cupcake") == "not_player"
            for n in (999, 0):
                response = post(client, h, f"/cookout/{n}/join", sender="Rose")
                assert response.status_code == 404 and response.json() == {"error": "not_found"}

    @pytest.mark.parametrize(
        ("path", "extra"),
        [
            ("/skip", {"moveId": "short", "turn": 1, "offer": 0}),
            ("/skip", {"moveId": "move-0000001", "turn": 0, "offer": 0}),
            ("/skip", {"moveId": "move-0000001", "turn": 11, "offer": 0}),
            ("/skip", {"moveId": "move-0000001", "turn": 1, "offer": 3}),
            ("/skip", {"moveId": "move-0000001", "turn": 1, "offer": -1}),
            ("/pick", {"moveId": "move-0000001", "turn": 1, "offer": 0, "ingredientId": ""}),
            ("/pick", {"moveId": "move-0000001", "turn": 1, "offer": 0, "ingredientId": "x" * 65}),
            ("/pick", {"moveId": "x" * 65, "turn": 1, "offer": 0, "ingredientId": "base-00"}),
        ],
    )
    def test_move_bounds_are_422(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        path: str,
        extra: dict[str, Any],
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            response = post(client, h, f"/cookout/{seq}{path}", sender="Josh", **extra)
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"

    def test_unknown_fields_and_a_bad_sender_are_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            assert post(client, h, f"/cookout/{seq}/join", sender="a\nb").status_code == 422
            assert (
                post(client, h, f"/cookout/{seq}/join", sender="Rose", extra=1).status_code == 422
            )

    def test_replaying_a_move_is_a_200_with_no_second_draw_or_event(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            cur = view(client, h, seq, "Josh")["current"]
            skip_body = {"sender": "Josh", "moveId": mv(), "turn": 1, "offer": 0}
            first = post(client, h, f"/cookout/{seq}/skip", **skip_body)
            again = post(client, h, f"/cookout/{seq}/skip", **skip_body)
            assert first.status_code == again.status_code == 200
            assert again.json() == first.json() and again.json()["current"]["offerIndex"] == 1
            rev = again.json()["rev"]
            pick_body = {
                "sender": "Josh", "moveId": mv(), "turn": 1, "offer": 1,
                "ingredientId": first.json()["current"]["options"][0]["id"],
            }  # fmt: skip
            one = post(client, h, f"/cookout/{seq}/pick", **pick_body)
            two = post(client, h, f"/cookout/{seq}/pick", **pick_body)
            assert one.status_code == two.status_code == 200
            assert one.json()["rev"] == two.json()["rev"] == rev + 1
            assert two.json()["current"]["turn"] == 2 and cur["turn"] == 1

    def test_the_final_pick_from_two_phones_starts_exactly_one_concepts_job(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            for turn in range(1, 10):
                move_pick(client, h, seq, "Josh" if turn % 2 == 1 else "Rose")
            cur = view(client, h, seq, "Rose")["current"]
            body = {
                "sender": "Rose", "moveId": mv(), "turn": 10, "offer": cur["offerIndex"],
                "ingredientId": cur["options"][0]["id"],
            }  # fmt: skip
            results = run_concurrently(
                lambda: post(client, h, f"/cookout/{seq}/pick", **body),
                lambda: post(client, h, f"/cookout/{seq}/pick", **body),
            )
            assert [r.status_code for r in results] == [200, 200]
            assert runner.concepts == [seq]
            v = view(client, h, seq, "Josh")
            assert (v["state"], v["concepts"]["state"]) == ("finished", "pending")

    def test_a_third_player_never_moves_and_a_stale_second_move_is_bad_state(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            cur = view(client, h, seq, "Josh")["current"]
            same = {"turn": 1, "offer": 0}
            a = post(client, h, f"/cookout/{seq}/pick", sender="Josh", moveId=mv(),
                     ingredientId=cur["options"][0]["id"], **same)  # fmt: skip
            b = post(client, h, f"/cookout/{seq}/pick", sender="Josh", moveId=mv(),
                     ingredientId=cur["options"][1]["id"], **same)  # fmt: skip
            assert a.status_code == 200
            assert b.status_code == 409 and b.json() == {"error": "bad_state"}


class TestEditionWithoutARunner:
    def test_the_game_plays_and_concepts_and_recipes_are_unavailable(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, no_runner=True) as (
            client,
            h,
            _,
        ):
            seq = create(client, h)
            play(client, h, seq)
            v = view(client, h, seq, "Josh")
            assert (v["state"], v["revealed"]) == ("finished", True)
            assert v["concepts"]["state"] == "unavailable" and v["concepts"]["error"]
            assert v["images"]["state"] == "none"
            # Nothing is ever started, and there is no concepts job to retry into.
            retry = post(client, h, f"/cookout/{seq}/concepts/retry", sender="Josh")
            assert retry.status_code == 409 and retry.json() == {"error": "bad_state"}
            assert store_of(client).cookout_pending_concepts() == []


# -- concepts, pictures, recipes ------------------------------------------------------------------


class TestConceptsRetry:
    def test_retry_after_failure_starts_a_job_once_and_a_double_tap_is_idempotent(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h)
            play(client, h, seq)
            store = store_of(client)
            store.set_cookout_concepts_run(seq, "run-1")
            store.finish_cookout_concepts(seq, "run-1", "failed", error="nope")
            failed = view(client, h, seq, "Josh")
            assert failed["concepts"] == {"state": "failed", "data": None, "error": "nope"}
            first = post(client, h, f"/cookout/{seq}/concepts/retry", sender="Rose")
            assert first.status_code == 200 and first.json()["concepts"]["state"] == "pending"
            second = post(client, h, f"/cookout/{seq}/concepts/retry", sender="Josh")
            assert second.status_code == 200 and second.json()["concepts"]["state"] == "pending"
            assert runner.concepts == [seq, seq]  # the play's own start + exactly one retry

    def test_it_is_refused_for_strangers_open_rounds_ready_concepts_and_a_missing_round(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h)
            retry = f"/cookout/{seq}/concepts/retry"
            assert post(client, h, retry, sender="Josh").json() == {"error": "bad_state"}  # open
            play(client, h, seq)
            assert post(client, h, retry, sender="Cupcake").json() == {"error": "not_player"}
            assert post(client, h, retry, sender="Josh").status_code == 200  # pending: idempotent
            finish_concepts(client, seq)
            assert post(client, h, retry, sender="Josh").json() == {"error": "bad_state"}  # ready
            assert post(client, h, "/cookout/999/concepts/retry", sender="Josh").status_code == 404

    def test_unavailable_concepts_retry_only_once_a_runner_exists(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        runner = FakeRunner(available=False)
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, runner=runner) as (
            client,
            h,
            _,
        ):
            seq = create(client, h)
            play(client, h, seq)
            assert view(client, h, seq, "Josh")["concepts"]["state"] == "unavailable"
            retry = f"/cookout/{seq}/concepts/retry"
            assert post(client, h, retry, sender="Josh").status_code == 409
            runner.available = True
            ok = post(client, h, retry, sender="Josh")
            assert ok.status_code == 200 and ok.json()["concepts"]["state"] == "pending"
            assert runner.concepts == [seq]


class TestPicturesRetry:
    def _ready_with_partial_pictures(self, client: TestClient, seq: int) -> None:
        finish_concepts(client, seq, pictures=True)
        store = store_of(client)
        _, gen = store.claim_cookout_pictures(seq, stale_before=None, now=time.time())
        assert store.store_cookout_pictures(
            seq, gen, {"a": ("att-a-" + "0" * 20, 10)}, None, all_done=False, now=time.time()
        )

    def test_retry_draws_only_what_is_missing_and_is_idempotent_while_pending(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h)
            play(client, h, seq)
            self._ready_with_partial_pictures(client, seq)
            assert view(client, h, seq, "Josh")["images"]["state"] == "failed"
            path = f"/cookout/{seq}/pictures/retry"
            first = post(client, h, path, sender="Josh")
            assert first.status_code == 200 and first.json()["images"]["state"] == "pending"
            assert post(client, h, path, sender="Rose").status_code == 200
            assert runner.pictures == [seq]
            assert post(client, h, path, sender="Cupcake").json() == {"error": "not_player"}

    def test_refused_when_pictures_are_unavailable_complete_or_concepts_not_ready(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        runner = FakeRunner(images=False)
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, runner=runner) as (
            client,
            h,
            _,
        ):
            seq = create(client, h)
            play(client, h, seq)
            path = f"/cookout/{seq}/pictures/retry"
            assert post(client, h, path, sender="Josh").json() == {
                "error": "bad_state"
            }  # no concepts
            self._ready_with_partial_pictures(client, seq)
            assert post(client, h, path, sender="Josh").json() == {
                "error": "bad_state"
            }  # no ComfyUI
            runner.images_available = True
            assert post(client, h, path, sender="Josh").status_code == 200


class TestRecipes:
    def test_bank_this_starts_one_recipe_job_per_concept_and_taps_are_idempotent(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h)
            play(client, h, seq)
            finish_concepts(client, seq)
            first = post(client, h, f"/cookout/{seq}/concepts/a/bank", sender="Josh", moveId=mv())
            assert first.status_code == 200
            slot = first.json()["recipes"]["a"]
            assert slot["state"] == "pending" and slot["requestedBy"] == "Josh"
            assert first.json()["recipes"]["b"]["state"] == "none"
            again = post(client, h, f"/cookout/{seq}/concepts/a/bank", sender="Rose", moveId=mv())
            assert again.status_code == 200
            assert runner.recipes == [(seq, "a")]
            post(client, h, f"/cookout/{seq}/concepts/c/bank", sender="Rose", moveId=mv())
            assert runner.recipes == [(seq, "a"), (seq, "c")]

    def test_validation_and_state_errors(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            bank = f"/cookout/{seq}/concepts/a/bank"
            assert post(client, h, bank, sender="Josh", moveId=mv()).json() == {
                "error": "bad_state"
            }
            play(client, h, seq)
            assert post(client, h, bank, sender="Josh", moveId=mv()).json() == {
                "error": "bad_state"
            }
            finish_concepts(client, seq)
            assert post(client, h, bank, sender="Josh", moveId="short").status_code == 422
            assert post(client, h, bank, sender="Cupcake", moveId=mv()).json() == {
                "error": "not_player"
            }
            assert (
                post(
                    client, h, f"/cookout/{seq}/concepts/z/bank", sender="Josh", moveId=mv()
                ).status_code
                == 404
            )
            assert (
                post(
                    client, h, "/cookout/999/concepts/a/bank", sender="Josh", moveId=mv()
                ).status_code
                == 404
            )

    def test_without_a_runner_the_recipe_is_unavailable_and_retries_once_one_exists(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        runner = FakeRunner(available=True)
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, runner=runner) as (
            client,
            h,
            _,
        ):
            seq = create(client, h)
            play(client, h, seq)
            finish_concepts(client, seq)
            runner.available = False
            banked = post(client, h, f"/cookout/{seq}/concepts/b/bank", sender="Josh", moveId=mv())
            assert banked.json()["recipes"]["b"]["state"] == "unavailable"
            assert runner.recipes == []
            retry = f"/cookout/{seq}/concepts/b/recipe/retry"
            assert post(client, h, retry, sender="Josh").json() == {"error": "bad_state"}
            runner.available = True
            ok = post(client, h, retry, sender="Josh")
            assert ok.status_code == 200 and ok.json()["recipes"]["b"]["state"] == "pending"
            assert runner.recipes == [(seq, "b")]
            assert post(client, h, retry, sender="Rose").status_code == 200  # pending: idempotent
            assert runner.recipes == [(seq, "b")]
            assert post(
                client, h, f"/cookout/{seq}/concepts/a/recipe/retry", sender="Josh"
            ).json() == {"error": "bad_state"}  # never requested

    def test_a_failed_recipe_retries_and_a_banked_one_reaches_the_recipe_book(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = create(client, h)
            play(client, h, seq)
            finish_concepts(client, seq)
            assert client.get(f"{BASE}/cookout/bank", headers=h).json() == {"recipes": []}
            for concept in ("a", "b"):
                post(
                    client, h, f"/cookout/{seq}/concepts/{concept}/bank", sender="Josh", moveId=mv()
                )
            store = store_of(client)
            store.set_cookout_recipe_run(seq, "a", "ra")
            store.finish_cookout_recipe(seq, "a", "ra", "failed", error="bad")
            failed = view(client, h, seq, "Josh")["recipes"]["a"]
            assert failed["state"] == "failed" and failed["error"] == "bad"
            retried = post(client, h, f"/cookout/{seq}/concepts/a/recipe/retry", sender="Rose")
            assert retried.json()["recipes"]["a"]["state"] == "pending"
            assert runner.recipes == [(seq, "a"), (seq, "b"), (seq, "a")]
            body = json.dumps(
                {
                    "serves": 2,
                    "prepMinutes": 5,
                    "cookMinutes": 25,
                    "ingredients": [],
                    "steps": [],
                    "tips": [],
                }
            )
            store.set_cookout_recipe_run(seq, "a", "ra2")
            store.finish_cookout_recipe(seq, "a", "ra2", "banked", recipe_json=body)
            store.set_cookout_recipe_run(seq, "b", "rb")
            store.finish_cookout_recipe(seq, "b", "rb", "banked", recipe_json=body)
            book = client.get(f"{BASE}/cookout/bank", headers=h)
            assert book.status_code == 200 and book.headers["cache-control"] == "no-store"
            recipes = book.json()["recipes"]
            assert [(r["seq"], r["conceptId"]) for r in recipes] == [(seq, "b"), (seq, "a")]
            first = recipes[0]
            assert set(first) == {
                "seq", "conceptId", "title", "vibe", "description", "serves", "prepMinutes",
                "cookMinutes", "totalMinutes", "bankedAt", "requestedBy", "picture",
            }  # fmt: skip
            assert first["totalMinutes"] == 30 and first["title"] == "Dish B"
            assert first["requestedBy"] == "Josh" and first["picture"] is None
            full = view(client, h, seq, "Rose")["recipes"]["a"]
            assert full["state"] == "banked" and full["data"]["totalMinutes"] == 30
            msg = client.get(f"{BASE}/messages", headers=h).json()["messages"]
            assert next(m for m in msg if m["seq"] == seq)["cookout"]["bankedCount"] == 2

    def test_the_book_route_is_not_shadowed_by_the_round_route(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            response = client.get(f"{BASE}/cookout/bank", headers=h)
            assert response.status_code == 200 and response.json() == {"recipes": []}


# -- abandon, game chat, startup ------------------------------------------------------------------


class TestAbandonAndChat:
    def test_end_game_abandons_an_open_round_but_never_a_finished_one(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h, blind=True)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            move_pick(client, h, seq, "Josh")
            ended = post(client, h, f"/cookout/{seq}/abandon", sender="Rose")
            assert ended.status_code == 200 and ended.json()["state"] == "abandoned"
            assert ended.json()["revealed"] is False and ended.json()["current"] is None
            assert ended.json()["players"][0]["picks"] is None  # the partner's pick stays hidden
            assert post(client, h, f"/cookout/{seq}/abandon", sender="Josh").status_code == 200
            done = create(client, h, "cookout-route-0002")
            play(client, h, done)
            refused = post(client, h, f"/cookout/{done}/abandon", sender="Josh")
            assert refused.status_code == 409 and refused.json() == {"error": "bad_state"}

    def test_the_game_chat_reuses_wyr_seq_and_reports_the_cookout_kind(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            sent = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "cookout-game-chat-01",
                    "sender": "Rose",
                    "deviceId": "device-1234",
                    "text": "Is that cumin?",
                    "wyrSeq": seq,
                },
                headers=h,
            )
            assert sent.status_code == 201, sent.text
            message = sent.json()["message"]
            assert message["wyrRef"] == seq and message["wyrRefKind"] == "cookout"
            assert message["cookout"] is None and message["adventure"] is None
            missing = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "cookout-game-chat-02",
                    "sender": "Rose",
                    "deviceId": "device-1234",
                    "text": "x",
                    "wyrSeq": 4242,
                },
                headers=h,
            )
            assert missing.status_code == 404


class TestStartup:
    def test_the_runner_is_resumed_and_supervised_at_startup(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier) as (_client, _h, runner):
            assert runner is not None and runner.resumed == 1 and runner.supervised == 1
