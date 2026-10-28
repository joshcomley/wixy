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
        self.concept_generations: list[tuple[int, int]] = []
        self.pictures: list[int] = []
        self.recipes: list[tuple[int, str]] = []
        self.recipe_generations: list[tuple[int, int, str]] = []
        self.resumed = 0
        self.supervised = 0

    def start_concepts(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int
    ) -> None:
        self.concepts.append(anchor_seq)
        self.concept_generations.append((anchor_seq, generation))

    def start_pictures(self, background: ContainedTaskGroup, anchor_seq: int) -> None:
        self.pictures.append(anchor_seq)

    def start_recipe(
        self, background: ContainedTaskGroup, anchor_seq: int, generation: int, concept_id: str
    ) -> None:
        self.recipes.append((anchor_seq, concept_id))
        self.recipe_generations.append((anchor_seq, generation, concept_id))

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
    assert store.set_cookout_concepts_run(seq, "run-1", expected_generation=1)
    assert store.finish_cookout_concepts(
        seq,
        "run-1",
        "ready",
        concepts_json=canned_concepts(picked),
        pictures_pending=pictures,
        expected_generation=1,
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
    # The twists (spec 09a §4.2): every new route, including the literal GETs.
    ("GET", "/cookout/options", None),
    ("GET", "/cookout/ingredients?q=ze", None),
    ("GET", "/cookout/1/photos?as=Josh", None),
    ("POST", "/cookout/1/lucky", {**_SKIP, "optionIds": ["a1", "b2"]}),
    ("POST", "/cookout/1/chaos", {**_SKIP, "optionIds": ["a1", "b2"]}),
    ("POST", "/cookout/1/veto", {**_SKIP, "ingredientId": "base-00"}),
    ("POST", "/cookout/1/star", {"sender": "Josh", "ingredientId": "base-00"}),
    ("POST", "/cookout/1/wildcard", {"sender": "Josh", "moveId": "move-0000001", "lift": True}),
    ("POST", "/cookout/1/vote", {"sender": "Josh", "generation": 1, "conceptId": "a"}),
    (
        "POST",
        "/cookout/1/swap/propose",
        {"sender": "Josh", "moveId": "move-0000001", "ingredientId": "base-00"},
    ),
    (
        "POST",
        "/cookout/1/swap/choose",
        {"sender": "Josh", "moveId": "move-0000001", "ingredientId": "base-00"},
    ),
    ("POST", "/cookout/1/swap/cancel", {"sender": "Josh"}),
    ("POST", "/cookout/1/recipes/1/a/cooked", {"sender": "Josh", "cooked": True}),
    ("POST", "/cookout/1/recipes/1/a/rating", {"sender": "Josh", "rating": 3}),
    (
        "POST",
        "/cookout/1/recipes/1/a/photo",
        {"sender": "Josh", "messageSeq": None, "attachmentId": None},
    ),
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
                "generation": 1,
                "waiting": [],
                "swap": "none",
                "dinnerDecided": False,
                "cookedCount": 0,
            }
            assert message["text"] is None and message["sender"] == "Bubble"
            assert message["wyr"] is None and message["adventure"] is None
            v = view(client, h, message["seq"], "Bubble")
            assert v["you"]["slot"] == 1 and v["current"]["turn"] == 1
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
            assert body["you"]["slot"] == 2
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
            for key in (
                "role",
                "options",
                "offerIndex",
                "skipsRemaining",
                "chaosPair",
                "vetoed",
                "canChaos",
                "canLucky",
            ):
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
        assert body["you"]["slot"] == slot

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
            store.set_cookout_concepts_run(seq, "run-1", expected_generation=1)
            store.finish_cookout_concepts(
                seq, "run-1", "failed", error="nope", expected_generation=1
            )
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
            store.set_cookout_recipe_run(seq, "a", "ra", expected_generation=1)
            store.finish_cookout_recipe(
                seq, "a", "ra", "failed", error="bad", expected_generation=1
            )
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
            store.set_cookout_recipe_run(seq, "a", "ra2", expected_generation=1)
            store.finish_cookout_recipe(
                seq, "a", "ra2", "banked", recipe_json=body, expected_generation=1
            )
            store.set_cookout_recipe_run(seq, "b", "rb", expected_generation=1)
            store.finish_cookout_recipe(
                seq, "b", "rb", "banked", recipe_json=body, expected_generation=1
            )
            book = client.get(f"{BASE}/cookout/bank", headers=h)
            assert book.status_code == 200 and book.headers["cache-control"] == "no-store"
            recipes = book.json()["recipes"]
            assert [(r["seq"], r["conceptId"]) for r in recipes] == [(seq, "b"), (seq, "a")]
            first = recipes[0]
            assert set(first) == {
                "seq", "conceptId", "title", "vibe", "description", "serves", "prepMinutes",
                "cookMinutes", "totalMinutes", "bankedAt", "requestedBy", "picture",
                "generation", "cooked", "dinnerPick", "style", "challenge", "ingredients",
                "leftovers",
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


# -- the twists (spec 09a §4) ---------------------------------------------------------------------


def cx(storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier) -> Any:
    return cookout_client(storage_root, wixy_repo_root, pin_verifier, runner=FakeRunner())


def create_with(client: TestClient, h: dict[str, str], cid: str, **extra: Any) -> Any:
    return post(client, h, "/cookout", clientId=cid, deviceId="device-1234", sender="Josh", **extra)


def table(client: TestClient, h: dict[str, str], seq: int, who: str) -> dict[str, Any]:
    cur = view(client, h, seq, who)["current"]
    return {
        "sender": who,
        "moveId": mv(),
        "turn": cur["turn"],
        "offer": cur["offerIndex"],
        "optionIds": [o["id"] for o in cur["options"]],
    }


class TestTwistCatalogueRoutes:
    def test_options_lists_labels_only_and_reports_the_chef(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            response = client.get(f"{BASE}/cookout/options", headers=h)
            assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
            body = response.json()
            assert len(body["styles"]) == 8 and len(body["challenges"]) == 4
            assert set(body["styles"][0]) == {"id", "label", "emoji", "blurb"}
            assert body["chef"] is True and body["pictures"] is True
            assert "cosy country pub" not in json.dumps(body)

    def test_options_report_no_chef_without_a_runner(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, no_runner=True) as (
            client,
            h,
            _,
        ):
            body = client.get(f"{BASE}/cookout/options", headers=h).json()
            assert body["chef"] is False and body["pictures"] is False

    def test_ingredient_search_is_bounded_and_bank_only(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            found = client.get(f"{BASE}/cookout/ingredients?q=zedbase0", headers=h)
            assert found.status_code == 200 and found.headers["cache-control"] == "no-store"
            items = found.json()["ingredients"]
            assert items and len(items) <= 20 and all(i["id"].startswith("base-0") for i in items)
            assert set(items[0]) == {"id", "name", "category", "emoji", "blurb"}
            assert client.get(f"{BASE}/cookout/ingredients?q=z", headers=h).status_code == 422
            long_q = "x" * 41
            assert (
                client.get(f"{BASE}/cookout/ingredients?q={long_q}", headers=h).status_code == 422
            )
            assert client.get(f"{BASE}/cookout/ingredients", headers=h).status_code == 422
            nothing = client.get(f"{BASE}/cookout/ingredients?q=qqqq", headers=h)
            assert nothing.json() == {"ingredients": []}


_ENCORE = {"fromSeq": 1, "generation": 1, "conceptId": "a", "kind": "leftovers"}


class TestTwistCreate:
    def test_every_start_sheet_option_is_stored_and_shown_in_the_view(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            response = create_with(
                client,
                h,
                "twist-create-0001",
                style="picnic",
                challenge="one-pan",
                wildcard=True,
                stars=True,
                fridgeSeedId="base-04",
            )
            assert response.status_code == 201, response.text
            seq = response.json()["message"]["seq"]
            v = view(client, h, seq, "Josh")
            assert v["setup"]["style"]["id"] == "picnic" and v["setup"]["styleSpun"] is False
            assert v["setup"]["challenge"]["label"] == "One pan only"
            assert v["setup"]["wildcard"] is True and v["setup"]["stars"] is True
            assert v["setup"]["fridgeRaid"] is True and v["starters"][0]["id"] == "base-04"
            assert v["current"]["waitingForJoin"] is True

    def test_spin_is_resolved_by_the_server_and_marked_spun(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create_with(client, h, "twist-spin-00001", style="spin").json()["message"]["seq"]
            v = view(client, h, seq, "Josh")["setup"]
            assert v["styleSpun"] is True and v["style"]["id"] != "spin" and v["style"]["emoji"]

    @pytest.mark.parametrize(
        "extra",
        [
            {"style": "gothic"},
            {"challenge": "no-heat"},
            {"fridgeSeedId": "not-in-the-bank"},
            {"encore": {**_ENCORE, "fromSeq": 9999, "seedIds": ["base-01"]}},
            {"encore": {**_ENCORE, "conceptId": "q", "seedIds": ["base-01"]}},
            {"encore": {**_ENCORE, "seedIds": []}},
        ],
    )
    def test_unknown_values_are_invalid(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        extra: dict[str, Any],
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            response = create_with(client, h, "twist-bad-000001", **extra)
            assert response.status_code == 422 and response.json()["error"] == "invalid"
            assert client.get(f"{BASE}/cookout/1", headers=h).status_code == 404

    def test_chef_only_options_need_a_chef_but_fridge_raid_does_not(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cookout_client(storage_root, wixy_repo_root, pin_verifier, no_runner=True) as (
            client,
            h,
            _,
        ):
            for extra in (
                {"style": "picnic"},
                {"challenge": "no-oven"},
                {"wildcard": True},
                {"stars": True},
            ):
                response = create_with(client, h, "twist-nochef-0001", **extra)
                assert response.status_code == 422, extra
            ok = create_with(client, h, "twist-nochef-0002", fridgeSeedId="base-01")
            assert ok.status_code == 201

    def test_a_replay_answers_200_with_the_same_message(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            first = create_with(client, h, "twist-replay-0001", style="campfire")
            again = create_with(client, h, "twist-replay-0001", style="campfire")
            assert (first.status_code, again.status_code) == (201, 200)
            assert first.json()["message"]["seq"] == again.json()["message"]["seq"]


class TestDraftingRoutes:
    def test_lucky_chaos_and_veto_flow_through_the_routes(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            chaos = post(client, h, f"/cookout/{seq}/chaos", **table(client, h, seq, "Josh"))
            assert chaos.status_code == 200 and chaos.headers["cache-control"] == "no-store"
            assert chaos.json()["current"]["chaosPair"] is True
            again = post(client, h, f"/cookout/{seq}/chaos", **table(client, h, seq, "Josh"))
            assert again.status_code == 409 and again.json() == {"error": "token_used"}
            swept_id = view(client, h, seq, "Rose")["current"]["options"][0]["id"]
            veto = {"sender": "Rose", "turn": 1, "offer": 0, "ingredientId": swept_id}
            swept = post(client, h, f"/cookout/{seq}/veto", moveId=mv(), **veto)
            assert swept.status_code == 200 and swept.json()["you"]["vetoUsed"] is True
            fresh = view(client, h, seq, "Rose")["current"]["options"][0]["id"]
            second = post(
                client, h, f"/cookout/{seq}/veto", moveId=mv(), **{**veto, "ingredientId": fresh}
            )
            assert second.status_code == 409 and second.json() == {"error": "token_used"}
            dip = post(client, h, f"/cookout/{seq}/lucky", **table(client, h, seq, "Josh"))
            assert dip.status_code == 200 and dip.json()["players"][0]["pickCount"] == 1
            mine = table(client, h, seq, "Rose")
            wrong = post(client, h, f"/cookout/{seq}/lucky", **{**mine, "sender": "Josh"})
            assert wrong.status_code == 409 and wrong.json() == {"error": "not_your_turn"}

    def test_a_blind_veto_is_bad_state_and_a_stale_table_is_bad_state(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h, blind=True)
            post(client, h, f"/cookout/{seq}/join", sender="Rose")
            ingredient = view(client, h, seq, "Josh")["current"]["options"][0]["id"]
            blind = post(
                client,
                h,
                f"/cookout/{seq}/veto",
                sender="Rose",
                moveId=mv(),
                turn=1,
                offer=0,
                ingredientId=ingredient,
            )
            assert blind.status_code == 409 and blind.json() == {"error": "bad_state"}
            old = table(client, h, seq, "Josh")
            move_pick(client, h, seq, "Josh")
            stale = post(client, h, f"/cookout/{seq}/lucky", **{**old, "moveId": mv()})
            assert stale.status_code == 409 and stale.json() == {"error": "bad_state"}

    def test_validation_errors_are_422(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = create(client, h)
            good = table(client, h, seq, "Josh")
            for bad in (
                {**good, "moveId": "short"},
                {**good, "turn": 11},
                {**good, "offer": 3},
                {**good, "optionIds": ["only-one"]},
            ):
                assert post(client, h, f"/cookout/{seq}/chaos", **bad).status_code == 422
                assert post(client, h, f"/cookout/{seq}/lucky", **bad).status_code == 422


class TestGateRoutes:
    def gated(self, client: TestClient, h: dict[str, str], cid: str, **extra: Any) -> int:
        seq = int(create_with(client, h, cid, **extra).json()["message"]["seq"])
        play(client, h, seq)
        return seq

    def test_a_cloche_lift_starts_exactly_one_concepts_job_for_the_generation(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = self.gated(client, h, "twist-cloche-0001", wildcard=True)
            assert runner.concept_generations == []
            assert view(client, h, seq, "Josh")["gate"] == {"waitingFor": ["wildcard"]}
            path = f"/cookout/{seq}/wildcard"
            lift = post(client, h, path, sender="Josh", moveId=mv(), lift=True)
            assert lift.status_code == 200 and lift.json()["wildcard"]["state"] == "lifted"
            assert runner.concept_generations == [(seq, 1)]
            again = post(client, h, path, sender="Rose", moveId=mv(), lift=True)
            assert again.status_code == 200 and runner.concept_generations == [(seq, 1)]
            nope = post(client, h, path, sender="Rose", moveId=mv(), lift=False)
            assert nope.status_code == 409 and nope.json() == {"error": "bad_state"}

    def test_stars_open_the_gate_and_blind_stars_stay_private_on_the_wire(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = self.gated(client, h, "twist-stars-0001", stars=True, blind=True)
            mine = view(client, h, seq, "Josh")["players"][0]["picks"][0]["id"]
            hers = view(client, h, seq, "Rose")["players"][1]["picks"][0]["id"]
            first = post(client, h, f"/cookout/{seq}/star", sender="Josh", ingredientId=mine)
            assert first.status_code == 200 and runner.concept_generations == []
            seen_by_rose = view(client, h, seq, "Rose")["stars"]
            assert seen_by_rose["partnerChosen"] is True and seen_by_rose["partner"] is None
            second = post(client, h, f"/cookout/{seq}/star", sender="Rose", ingredientId=hers)
            assert second.json()["stars"]["revealed"] is True
            assert runner.concept_generations == [(seq, 1)]
            bad = post(client, h, f"/cookout/{seq}/star", sender="Josh", ingredientId=hers)
            assert bad.status_code == 409 and bad.json() == {"error": "bad_state"}


class TestVoteAndSwapRoutes:
    def ready(self, client: TestClient, h: dict[str, str], cid: str) -> int:
        seq = create(client, h, cid)
        play(client, h, seq)
        finish_concepts(client, seq)
        return seq

    def basket(self, client: TestClient, seq: int) -> list[str]:
        return list(store_of(client).get_cookout_round(seq)["basket_ids"])  # type: ignore[index]

    def test_vote_is_secret_until_both_have_voted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = self.ready(client, h, "twist-vote-00001")
            path = f"/cookout/{seq}/vote"
            mine = post(client, h, path, sender="Josh", generation=1, conceptId="b")
            assert mine.status_code == 200 and mine.json()["vote"]["you"] == "b"
            theirs = view(client, h, seq, "Rose")["vote"]
            assert theirs["partnerVoted"] is True and theirs["votes"] is None
            stale = post(client, h, path, sender="Rose", generation=2, conceptId="b")
            assert stale.status_code == 409 and stale.json() == {"error": "bad_state"}
            done = post(client, h, path, sender="Rose", generation=1, conceptId="b")
            assert done.json()["vote"]["match"] == "b"
            card = client.get(f"{BASE}/messages", headers=h).json()["messages"]
            assert next(m for m in card if m["seq"] == seq)["cookout"]["dinnerDecided"] is True

    def test_the_swap_runs_through_the_routes_and_starts_generation_two(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = self.ready(client, h, "twist-swap-00001")
            target = self.basket(client, seq)[0]
            propose = f"/cookout/{seq}/swap/propose"
            proposed = post(client, h, propose, sender="Josh", moveId=mv(), ingredientId=target)
            assert proposed.status_code == 200 and proposed.json()["swap"]["state"] == "proposed"
            pair = proposed.json()["swap"]["pair"]
            choose = f"/cookout/{seq}/swap/choose"
            own = post(client, h, choose, sender="Josh", moveId=mv(), ingredientId=pair[0]["id"])
            assert own.status_code == 409 and own.json() == {"error": "not_your_turn"}
            bank = f"/cookout/{seq}/concepts/a/bank"
            blocked = post(client, h, bank, sender="Rose", moveId=mv(), generation=1)
            assert blocked.status_code == 409 and blocked.json() == {"error": "bad_state"}
            assert runner.recipes == []
            chosen = post(client, h, choose, sender="Rose", moveId=mv(), ingredientId=pair[1]["id"])
            assert chosen.status_code == 200
            body = chosen.json()
            assert body["generation"] == 2 and body["swap"]["in"]["id"] == pair[1]["id"]
            assert len(body["generations"]) == 1
            assert runner.concept_generations == [(seq, 1), (seq, 2)]

    def test_a_pending_recipe_is_recipe_pending_and_cancel_keeps_the_dishes(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = self.ready(client, h, "twist-pend-00001")
            target = self.basket(client, seq)[0]
            bank = f"/cookout/{seq}/concepts/a/bank"
            banked = post(client, h, bank, sender="Josh", moveId=mv(), generation=1)
            assert banked.status_code == 200 and runner.recipe_generations == [(seq, 1, "a")]
            propose = f"/cookout/{seq}/swap/propose"
            pending = post(client, h, propose, sender="Josh", moveId=mv(), ingredientId=target)
            assert pending.status_code == 409 and pending.json() == {"error": "recipe_pending"}
            noop = post(client, h, f"/cookout/{seq}/swap/cancel", sender="Josh")
            assert noop.status_code == 200 and noop.json()["swap"]["state"] == "none"

    def test_a_stale_generation_on_bank_and_retries_is_bad_state_without_a_job(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, runner):
            assert runner is not None
            seq = self.ready(client, h, "twist-gen-000001")
            target = self.basket(client, seq)[0]
            propose = f"/cookout/{seq}/swap/propose"
            proposed = post(client, h, propose, sender="Josh", moveId=mv(), ingredientId=target)
            pair = proposed.json()["swap"]["pair"]
            choose = f"/cookout/{seq}/swap/choose"
            post(client, h, choose, sender="Rose", moveId=mv(), ingredientId=pair[0]["id"])
            store = store_of(client)
            assert store.set_cookout_concepts_run(seq, "g2", expected_generation=2)
            assert store.finish_cookout_concepts(
                seq,
                "g2",
                "ready",
                expected_generation=2,
                concepts_json=canned_concepts(self.basket(client, seq)),
            )
            jobs = (len(runner.recipes), len(runner.concepts))
            for path, extra in (
                ("/concepts/a/bank", {"moveId": mv()}),
                ("/concepts/retry", {}),
                ("/pictures/retry", {}),
                ("/concepts/a/recipe/retry", {}),
            ):
                for generation in ({"generation": 1}, {}):
                    body = {**extra, **generation}
                    response = post(client, h, f"/cookout/{seq}{path}", sender="Josh", **body)
                    assert response.status_code == 409, (path, generation, response.text)
                    assert response.json() == {"error": "bad_state"}
            assert (len(runner.recipes), len(runner.concepts)) == jobs
            bank = f"/cookout/{seq}/concepts/a/bank"
            ok = post(client, h, bank, sender="Josh", moveId=mv(), generation=2)
            assert ok.status_code == 200 and runner.recipe_generations[-1] == (seq, 2, "a")


class TestCookedRoutes:
    def banked(self, client: TestClient, h: dict[str, str], cid: str) -> int:
        seq = create(client, h, cid)
        play(client, h, seq)
        finish_concepts(client, seq)
        store = store_of(client)
        bank = f"/cookout/{seq}/concepts/a/bank"
        post(client, h, bank, sender="Josh", moveId=mv(), generation=1)
        assert store.set_cookout_recipe_run(seq, "a", "r1", expected_generation=1)
        body = json.dumps(
            {"serves": 2, "prepMinutes": 10, "cookMinutes": 20, "ingredients": [], "steps": ["x"]}
        )
        assert store.finish_cookout_recipe(
            seq, "a", "r1", "banked", expected_generation=1, recipe_json=body
        )
        return seq

    def test_cooked_rating_and_the_recipe_book(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = self.banked(client, h, "twist-cook-00001")
            path = f"/cookout/{seq}/recipes/1/a"
            early = post(client, h, f"{path}/rating", sender="Josh", rating=4)
            assert early.status_code == 409 and early.json() == {"error": "bad_state"}
            marked = post(client, h, f"{path}/cooked", sender="Rose", cooked=True)
            assert marked.status_code == 200
            assert marked.json()["recipes"]["a"]["cooked"]["cookedBy"] == "Rose"
            rated = post(client, h, f"{path}/rating", sender="Josh", rating=4)
            assert rated.json()["recipes"]["a"]["cooked"]["ratings"] == {"1": 4, "2": None}
            assert post(client, h, f"{path}/rating", sender="Josh", rating=9).status_code == 422
            entry = client.get(f"{BASE}/cookout/bank", headers=h).json()["recipes"][0]
            assert entry["cooked"]["ratings"] == [
                {"name": "Josh", "rating": 4},
                {"name": "Rose", "rating": None},
            ]
            assert entry["generation"] == 1 and entry["dinnerPick"] is False
            assert entry["leftovers"]  # feeds the Leftovers encore button
            other = f"/cookout/{seq}/recipes/1/b/cooked"
            gone = post(client, h, other, sender="Josh", cooked=True)
            assert gone.status_code == 409 and gone.json() == {"error": "bad_state"}
            unmarked = post(client, h, f"{path}/cooked", sender="Josh", cooked=False)
            assert unmarked.json()["recipes"]["a"]["cooked"] is None

    def test_the_photo_chooser_and_link_use_the_exact_attachment(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with cx(storage_root, wixy_repo_root, pin_verifier) as (client, h, _):
            seq = self.banked(client, h, "twist-photo-0001")
            store = store_of(client)
            post(client, h, f"/cookout/{seq}/recipes/1/a/cooked", sender="Josh", cooked=True)
            for att in ("att-route-1", "att-route-2"):
                store.create_attachment(att_id=att, kind="photo", now=5.0)
            message, _ = store.create_message(
                client_id="route-photo-msg-001",
                sender="Rose",
                device_id="device-1234",
                by_email=None,
                text=None,
                attachment_ids=["att-route-1", "att-route-2"],
                wyr_anchor_seq=seq,
                now=6.0,
            )
            # The media worker is not running here: mark both photos ready directly.
            with store._write_txn() as conn:  # noqa: SLF001
                conn.execute(
                    "UPDATE attachments SET status = 'ready', renditions = ? WHERE message_seq = ?",
                    (json.dumps(["thumb", "full"]), message.seq),
                )
            listing = client.get(f"{BASE}/cookout/{seq}/photos?as=Josh", headers=h)
            assert listing.status_code == 200 and listing.headers["cache-control"] == "no-store"
            [entry] = listing.json()["photos"]
            assert entry["messageSeq"] == message.seq and entry["attachmentId"] == "att-route-1"
            assert entry["sender"] == "Rose" and "thumbUrl" in entry["picture"]
            stranger = client.get(f"{BASE}/cookout/{seq}/photos?as=Nobody", headers=h)
            assert stranger.status_code == 409 and stranger.json() == {"error": "not_player"}
            assert client.get(f"{BASE}/cookout/{seq}/photos", headers=h).status_code == 422
            path = f"/cookout/{seq}/recipes/1/a/photo"
            half = post(client, h, path, sender="Josh", messageSeq=message.seq)
            assert half.status_code == 422
            wrong = post(client, h, path, sender="Josh", messageSeq=message.seq, attachmentId="x1")
            assert wrong.status_code == 409 and wrong.json() == {"error": "bad_state"}
            linked = post(
                client,
                h,
                path,
                sender="Josh",
                messageSeq=message.seq,
                attachmentId=entry["attachmentId"],
            )
            photo = linked.json()["recipes"]["a"]["cooked"]
            assert photo["photoMessageSeq"] == message.seq
            assert photo["photo"]["attachmentId"] == "att-route-1"
            unlinked = post(client, h, path, sender="Josh", messageSeq=None, attachmentId=None)
            assert unlinked.json()["recipes"]["a"]["cooked"]["photo"] is None
