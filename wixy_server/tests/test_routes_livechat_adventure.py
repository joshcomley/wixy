# ruff: noqa: F811  (pytest fixtures re-used from test_livechat_view_once are rebound as test parameters)
"""Adventure Time over HTTP (workspace 00056, spec/server-chat/08-adventure-time.md §4.2): auth on
every route, the exact view shape, every validation bound, the whole game through the routes, the
idempotency / 409 rules, the never-again list and the bank screen, the shared advised-places
preference, the game chat (`wyrSeq`/`wyrRef`/`wyrRefKind`), the edition without a researcher, and
erasure through the routes (delete and wipe, with the raw bytes proven gone).

The live swipe trail is `test_livechat_adventure_live.py`, the research job
`test_livechat_adventure_pack.py`."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat.pinclient import CmdPinVerifier
from wixy_server.livechat.store import LiveChatStore
from wixy_server.tests.adventure_testkit import (
    BASE,
    SPIN_DELTA,
    SPIN_DURATION_MS,
    SPIN_FROM,
    FakeResearcher,
    FakeRunPlan,
    create_round,
    fixture_bank,
    get_view,
    open_roulette,
    post,
    result_body,
    route_to_chosen,
    route_to_country,
    spin_body,
    unlocked_client,
    wait_for,
    wait_for_pack,
)
from wixy_server.tests.fake_cmd import CANNED_ADVENTURE_PACK
from wixy_server.tests.test_livechat_view_once import (  # noqa: F401 - fixtures re-exported
    _dev_no_auth,
    fake_cmd_state,
    origin_repo,
    pin_verifier,
    storage_root,
    wixy_repo_root,
)


def _raw_db(client: Any) -> bytes:
    store: LiveChatStore = client.app.state.livechat_store
    db = store._db_path
    wal = Path(f"{db}-wal")
    return db.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


class TestAuth:
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("POST", "/adventure", {"clientId": "c" * 8, "deviceId": "d" * 8, "sender": "Josh"}),
            ("GET", "/adventure/bank", None),
            ("GET", "/adventure/settings", None),
            ("PUT", "/adventure/settings", {"includeAdvised": True}),
            ("GET", "/adventure/1", None),
            ("POST", "/adventure/1/spin", spin_body()),
            ("POST", "/adventure/1/stop", {"sender": "Josh", "stage": "country", "choice": "AAA"}),
            ("POST", "/adventure/1/decide", {"sender": "Josh", "decision": "bank"}),
            ("POST", "/adventure/1/pack/retry", {"sender": "Josh"}),
            (
                "POST",
                "/adventure/live",
                {
                    "anchorSeq": 1,
                    "clientId": "c" * 8,
                    "axis": "lng",
                    "rotation": [0, 0],
                    "points": [],
                    "frame": 0,
                    "end": False,
                },
            ),
        ],
    )
    def test_every_route_needs_the_unlock_token(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        method: str,
        path: str,
        body: Any,
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, headers):
            for bad in ({}, {"X-Wixy-Server-Token": "not-a-token"}):
                response = client.request(method, f"{BASE}{path}", json=body, headers=bad)
                assert response.status_code == 401, (path, response.text)
                assert response.json() == {"error": "locked"}
            # ...and the real token is accepted by the same request shape (not a 401).
            ok = client.request(method, f"{BASE}{path}", json=body, headers=headers)
            assert ok.status_code != 401


class TestCreate:
    def test_it_creates_the_anchor_message_and_replays_a_client_id(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            created = create_round(client, h, "adv-route-0001", "Bubble")
            assert created.status_code == 201, created.text
            message = created.json()["message"]
            assert message["adventure"] == {"state": "spin_lng", "pack": "none", "rev": 1}
            assert message["text"] is None and message["attachments"] == []
            assert message["wyr"] is None and message["wyrRef"] is None
            assert message["wyrRefKind"] is None and message["sender"] == "Bubble"

            again = create_round(client, h, "adv-route-0001", "Cupcake")
            assert again.status_code == 200 and again.json()["message"]["seq"] == message["seq"]

            history = client.get(f"{BASE}/messages", headers=h).json()["messages"]
            [anchor] = [m for m in history if m["seq"] == message["seq"]]
            assert anchor["adventure"] == message["adventure"]

    @pytest.mark.parametrize(
        "body",
        [
            {"clientId": "short", "deviceId": "device-1234", "sender": "Josh"},
            {"clientId": "c" * 65, "deviceId": "device-1234", "sender": "Josh"},
            {"clientId": "adv-route-0002", "deviceId": "short", "sender": "Josh"},
            {"clientId": "adv-route-0002", "deviceId": "device-1234", "sender": ""},
            {"clientId": "adv-route-0002", "deviceId": "device-1234", "sender": "x" * 33},
            {"clientId": "adv-route-0002", "deviceId": "device-1234", "sender": "bad\nname"},
        ],
    )
    def test_it_validates_the_ids_and_the_sender(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        body: dict[str, Any],
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            response = post(client, h, "/adventure", **body)
            assert response.status_code == 422
            assert response.json()["error"] == "invalid"

    def test_unknown_body_keys_are_refused(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            response = post(
                client,
                h,
                "/adventure",
                clientId="adv-route-0003",
                deviceId="device-1234",
                sender="Josh",
                extra=1,
            )
            assert response.status_code == 422

    def test_an_empty_bank_answers_game_unavailable(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        from wixy_server.livechat.adventure_bank import AdventureBank

        with unlocked_client(
            storage_root, wixy_repo_root, pin_verifier, bank=AdventureBank.empty()
        ) as (client, h):
            response = create_round(client, h)
            assert response.status_code == 503
            assert response.json() == {"error": "game_unavailable"}

    def test_a_new_adventure_abandons_the_old_one_but_not_a_chosen_one(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            first = create_round(client, h, "adv-route-a0001").json()["message"]["seq"]
            second = create_round(client, h, "adv-route-a0002").json()["message"]["seq"]
            assert get_view(client, h, first)["state"] == "abandoned"
            route_to_chosen(client, h, second)
            third = create_round(client, h, "adv-route-a0003").json()["message"]["seq"]
            assert get_view(client, h, second)["state"] == "chosen"
            assert get_view(client, h, third)["state"] == "spin_lng"

    def test_the_message_hooks_run_on_create_only(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        seen: list[int] = []

        async def hook(message: Any) -> None:
            seen.append(message.seq)

        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            client.app.state.livechat_message_hooks.append(hook)  # type: ignore[attr-defined]
            created = create_round(client, h, "adv-route-hook01")
            seq = created.json()["message"]["seq"]
            create_round(client, h, "adv-route-hook01")  # a replay
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            wait_for(lambda: seen == [seq], timeout_s=3.0, what="the push hook")
            assert seen == [seq]


class TestView:
    def test_the_fresh_round_view_has_exactly_the_documented_shape(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h, sender="Bubble").json()["message"]["seq"]
            view = get_view(client, h, seq)
            assert set(view) == {
                "seq",
                "state",
                "rev",
                "serverNow",
                "startedBy",
                "eligible",
                "spins",
                "landing",
                "country",
                "destination",
                "pack",
                "decidedBy",
            }
            assert view["seq"] == seq and view["state"] == "spin_lng" and view["rev"] == 1
            assert view["startedBy"] == "Bubble" and view["decidedBy"] is None
            assert view["eligible"] == ["AAA", "BBB", "CCC", "EEE"]  # DDD is advised
            assert view["spins"] == {"lng": None, "lat": None}
            assert view["landing"] is None
            assert view["country"] is None and view["destination"] is None
            assert view["pack"] == {
                "state": "none",
                "data": None,
                "error": None,
                "canRetry": False,
                "images": "done",
                "pictures": {"hero": [], "items": {}},
            }
            assert isinstance(view["serverNow"], float)

    def test_the_view_through_the_whole_game(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        researcher = FakeResearcher([FakeRunPlan(statuses=["running", "completed"])])
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            seq = create_round(client, h, sender="Bubble").json()["message"]["seq"]

            lng = post(client, h, f"/adventure/{seq}/spin", **spin_body("Bubble", "lng"))
            assert lng.status_code == 200
            view = lng.json()
            assert view["state"] == "spin_lat" and view["rev"] == 2
            assert view["eligible"] == ["AAA", "BBB", "CCC", "EEE"]
            spin = view["spins"]["lng"]
            assert set(spin) == {"by", "from", "delta", "durationMs", "at"}
            assert (spin["by"], spin["from"], spin["delta"], spin["durationMs"]) == (
                "Bubble",
                SPIN_FROM,
                SPIN_DELTA,
                SPIN_DURATION_MS,
            )

            lat = post(
                client,
                h,
                f"/adventure/{seq}/spin",
                **spin_body(
                    "Cupcake", "lat", frm=-15.0, delta=-SPIN_DELTA, result=result_body("AAA")
                ),
            )
            assert lat.status_code == 200
            view = lat.json()
            assert view["state"] == "country" and view["eligible"] is None
            assert view["landing"] == {
                "point": [5.0, 6.0],
                "sea": False,
                "land": [7.0, 8.0],
                "centre": [9.0, 10.0],
                "landUnit": "AAA",
                "landUnitName": "Alphaland",
            }
            country = view["country"]
            assert [c["id"] for c in country["candidates"]] == ["AAA", "BBB", "CCC", "EEE"]
            assert country["candidates"][0] == {"id": "AAA", "name": "Alphaland"}
            assert 0 <= country["seed"] < 2**32 and country["chosen"] is None
            assert country["by"] is None
            assert country["rouletteAt"] == pytest.approx(
                view["spins"]["lat"]["at"] + SPIN_DURATION_MS / 1000 + 5.0
            )
            assert view["destination"] is None

            # Stopping before the roulette starts is refused.
            early = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Bubble",
                stage="country",
                choice="AAA",
            )
            assert early.status_code == 409 and early.json() == {"error": "too_early"}

            open_roulette(client, seq, "country")
            stopped = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Bubble",
                stage="country",
                choice="AAA",
            )
            assert stopped.status_code == 200
            view = stopped.json()
            assert view["state"] == "destination"
            assert view["country"]["chosen"] == {"id": "AAA", "name": "Alphaland"}
            assert view["country"]["by"] == "Bubble"
            destination = view["destination"]
            assert [d["id"] for d in destination["candidates"]] == [
                "AAA.one",
                "AAA.two",
                "AAA.three",
                "AAA.four",
                "AAA.five",
            ]
            assert destination["candidates"][0] == {
                "id": "AAA.one",
                "name": "Alpha One",
                "region": "North",
                "lat": 10.0,
                "lng": 20.0,
                "kind": "city",
                "blurb": "Rank one of Alphaland.",
            }
            assert destination["chosen"] is None and destination["by"] is None
            assert destination["rouletteAt"] > view["serverNow"]

            open_roulette(client, seq, "destination")
            chosen = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Cupcake",
                stage="destination",
                choice="AAA.two",
            )
            assert chosen.status_code == 200
            view = chosen.json()
            assert view["state"] == "chosen" and view["destination"]["by"] == "Cupcake"
            assert view["destination"]["chosen"]["id"] == "AAA.two"
            assert view["pack"]["state"] == "pending" and view["pack"]["data"] is None

            ready = wait_for_pack(client, h, seq, "ready")
            assert ready["pack"]["error"] is None and ready["pack"]["canRetry"] is False
            assert ready["pack"]["data"]["headline"] == CANNED_ADVENTURE_PACK["headline"]
            assert [s["key"] for s in ready["pack"]["data"]["sections"]] == [
                "food",
                "stay",
                "sights",
            ]

            decided = post(client, h, f"/adventure/{seq}/decide", sender="Bubble", decision="bank")
            assert decided.status_code == 200
            final = decided.json()
            assert final["state"] == "banked" and final["decidedBy"] == "Bubble"
            assert final["pack"]["state"] == "ready"
            # The research prompt named only the destination.
            [(prompt, cwd)] = researcher.started
            assert "Alpha Two" in prompt and "Alphaland" in prompt
            assert "Bubble" not in prompt and "Cupcake" not in prompt
            assert cwd.name == "adventure-research" and cwd.is_dir()

    def test_an_unknown_or_out_of_range_round_is_not_found(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            for seq in (999, 2**63, 0):
                response = client.get(f"{BASE}/adventure/{seq}", headers=h)
                assert response.status_code == 404, seq
                assert response.json() == {"error": "not_found"}
            plain = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "plain-msg-0001",
                    "sender": "Josh",
                    "deviceId": "dev-12345",
                    "text": "hello",
                },
                headers=h,
            ).json()["message"]["seq"]
            assert client.get(f"{BASE}/adventure/{plain}", headers=h).status_code == 404
            for path in ("spin", "stop", "decide", "pack/retry"):
                body = {
                    "spin": spin_body(),
                    "stop": {"sender": "Josh", "stage": "country", "choice": "AAA"},
                    "decide": {"sender": "Josh", "decision": "bank"},
                    "pack/retry": {"sender": "Josh"},
                }[path]
                response = post(client, h, f"/adventure/999/{path}", **body)
                assert response.status_code == 404, path

    def test_literal_paths_win_over_the_seq_route(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            assert client.get(f"{BASE}/adventure/bank", headers=h).json() == {"trips": []}
            assert "includeAdvised" in client.get(f"{BASE}/adventure/settings", headers=h).json()


class TestSpinValidation:
    def _round(self, client: Any, h: dict[str, str]) -> int:
        return int(create_round(client, h).json()["message"]["seq"])

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("delta", 719.9),
            ("delta", -719.9),
            ("delta", 3960.1),
            ("delta", -3960.1),
            ("delta", 0),
            ("durationMs", 3499),
            ("durationMs", 7001),
            ("from", 1e6 + 1),
            ("from", -1e6 - 1),
        ],
    )
    def test_the_motion_bounds(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        field: str,
        value: float,
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            body = spin_body()
            body[field] = value
            response = post(client, h, f"/adventure/{seq}/spin", **body)
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"
            assert get_view(client, h, seq)["state"] == "spin_lng"

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("delta", 720),
            ("delta", -3960),
            ("delta", 3700),
            ("durationMs", 3500),
            ("durationMs", 7000),
            ("from", 1e6),
            ("from", -1e6),
            ("from", 0),
        ],
    )
    def test_the_bounds_are_inclusive(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        field: str,
        value: float,
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            body = spin_body()
            body[field] = value
            assert post(client, h, f"/adventure/{seq}/spin", **body).status_code == 200

    @pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
    def test_non_finite_numbers_are_refused(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        literal: str,
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            for field in ("from", "delta", "durationMs"):
                numbers = {"from": "1.0", "delta": "1800.0", "durationMs": "4000.0"}
                numbers[field] = literal
                raw = (
                    '{"sender":"Josh","axis":"lng",'
                    f'"from":{numbers["from"]},"delta":{numbers["delta"]},'
                    f'"durationMs":{numbers["durationMs"]}}}'
                )
                response = client.post(
                    f"{BASE}/adventure/{seq}/spin",
                    content=raw,
                    headers={**h, "Content-Type": "application/json"},
                )
                assert response.status_code == 422, (field, literal)

    @pytest.mark.parametrize(
        "mutation",
        [
            {"from": "12"},
            {"delta": "1800"},
            {"durationMs": None},
            {"from": True},
            {"axis": "up"},
            {"extra": 1},
            {"sender": ""},
            {"sender": "bad\tname"},
        ],
    )
    def test_types_axis_sender_and_unknown_keys(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        mutation: dict[str, Any],
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            body = {**spin_body(), **mutation}
            response = post(client, h, f"/adventure/{seq}/spin", **body)
            assert response.status_code == 422

    def test_the_result_belongs_to_the_up_down_spin_only(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            refused = post(
                client, h, f"/adventure/{seq}/spin", **spin_body(result=result_body("AAA"))
            )
            assert refused.status_code == 422 and refused.json()["error"] == "invalid"
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            missing = post(
                client, h, f"/adventure/{seq}/spin", **spin_body(axis="lat", delta=-SPIN_DELTA)
            )
            assert missing.status_code == 422 and missing.json()["error"] == "invalid"

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda r: r.pop("point"),
            lambda r: r.pop("sea"),
            lambda r: r.pop("land"),
            lambda r: r.pop("centre"),
            lambda r: r.pop("landUnit"),
            lambda r: r.pop("candidates"),
            lambda r: r.update(extra=1),
            lambda r: r.update(point=[181.0, 0.0]),
            lambda r: r.update(point=[-181.0, 0.0]),
            lambda r: r.update(point=[0.0, 90.5]),
            lambda r: r.update(land=[0.0, -90.5]),
            lambda r: r.update(centre=[200.0, 0.0]),
            lambda r: r.update(point=[1.0]),
            lambda r: r.update(point=[1.0, 2.0, 3.0]),
            lambda r: r.update(point=["1", "2"]),
            lambda r: r.update(point={"lng": 1.0, "lat": 2.0}),
            lambda r: r.update(sea="no"),
            lambda r: r.update(sea=0),
            lambda r: r.update(landUnit="ZZZ"),
            lambda r: r.update(landUnit="DDD", candidates=["DDD", "AAA"]),  # advised
            lambda r: r.update(candidates=["BBB", "CCC"]),  # landUnit AAA not among them
            lambda r: r.update(candidates=[]),
            lambda r: r.update(candidates=["AAA"] * 2),
            lambda r: r.update(candidates=["AAA", "BBB", "ZZZ"]),
            lambda r: r.update(candidates=["AAA", "DDD"]),
            lambda r: r.update(candidates=["AAA", 7]),
            lambda r: r.update(candidates="AAA"),
        ],
    )
    def test_the_landing_result_rules(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        mutate: Any,
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            result = result_body("AAA")
            mutate(result)
            response = post(
                client,
                h,
                f"/adventure/{seq}/spin",
                **spin_body(axis="lat", delta=-SPIN_DELTA, result=result),
            )
            assert response.status_code == 422, response.text
            assert response.json()["error"] == "invalid"
            assert get_view(client, h, seq)["state"] == "spin_lat"

    def test_one_to_ten_unique_candidates_are_accepted(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            result = {**result_body("AAA"), "candidates": ["AAA"]}
            response = post(
                client,
                h,
                f"/adventure/{seq}/spin",
                **spin_body(axis="lat", delta=-SPIN_DELTA, result=result),
            )
            assert response.status_code == 200
            assert response.json()["country"]["candidates"] == [{"id": "AAA", "name": "Alphaland"}]

    def test_a_sea_landing_is_stored_as_given(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = self._round(client, h)
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            response = post(
                client,
                h,
                f"/adventure/{seq}/spin",
                **spin_body(axis="lat", delta=-SPIN_DELTA, result=result_body("EEE", sea=True)),
            )
            landing = response.json()["landing"]
            assert landing["sea"] is True and landing["landUnitName"] == "Echoland"


class TestIdempotencyAndConflicts:
    def test_replaying_every_move_answers_200_with_the_current_view(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            moves: list[tuple[str, dict[str, Any]]] = [
                ("spin", spin_body("Josh", "lng")),
                (
                    "spin",
                    spin_body(
                        "Rose", "lat", frm=-15.0, delta=-SPIN_DELTA, result=result_body("AAA")
                    ),
                ),
            ]
            for path, body in moves:
                assert post(client, h, f"/adventure/{seq}/{path}", **body).status_code == 200
            open_roulette(client, seq, "country")
            stop_c = {"sender": "Josh", "stage": "country", "choice": "AAA"}
            assert post(client, h, f"/adventure/{seq}/stop", **stop_c).status_code == 200
            open_roulette(client, seq, "destination")
            stop_d = {"sender": "Rose", "stage": "destination", "choice": "AAA.three"}
            assert post(client, h, f"/adventure/{seq}/stop", **stop_d).status_code == 200
            decide = {"sender": "Josh", "decision": "bank"}
            assert post(client, h, f"/adventure/{seq}/decide", **decide).status_code == 200
            wait_for_pack(client, h, seq, "ready")
            before = get_view(client, h, seq)

            replays = [
                ("spin", moves[0][1]),
                ("spin", moves[1][1]),
                ("stop", stop_c),
                ("stop", stop_d),
                ("decide", decide),
            ]
            for path, body in replays:
                response = post(client, h, f"/adventure/{seq}/{path}", **body)
                assert response.status_code == 200, (path, response.text)
                view = response.json()
                assert view["rev"] == before["rev"] and view["state"] == "banked"
            after = get_view(client, h, seq)
            assert {k: v for k, v in after.items() if k != "serverNow"} == {
                k: v for k, v in before.items() if k != "serverNow"
            }

    def test_a_different_move_after_the_state_advanced_is_bad_state(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            post(client, h, f"/adventure/{seq}/spin", **spin_body("Josh", "lng"))
            other = post(client, h, f"/adventure/{seq}/spin", **spin_body("Rose", "lng", frm=99.0))
            assert other.status_code == 409 and other.json() == {"error": "bad_state"}

            # Moves that belong to a later state.
            stop = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Josh",
                stage="country",
                choice="AAA",
            )
            assert stop.status_code == 409 and stop.json() == {"error": "bad_state"}
            decide = post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="bank")
            assert decide.status_code == 409 and decide.json() == {"error": "bad_state"}
            retry = post(client, h, f"/adventure/{seq}/pack/retry", sender="Josh")
            assert retry.status_code == 409 and retry.json() == {"error": "bad_state"}

            route_to_chosen(client, h, seq)
            other_decision = post(
                client, h, f"/adventure/{seq}/decide", sender="Josh", decision="bank"
            )
            assert other_decision.status_code == 200
            flipped = post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="reject")
            assert flipped.status_code == 409 and flipped.json() == {"error": "bad_state"}

    def test_stop_rules_over_the_wire(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_country(client, h, seq)
            base = f"/adventure/{seq}/stop"
            assert (
                post(client, h, base, sender="J", stage="country", choice="ZZZ").status_code == 422
            )
            invalid = post(client, h, base, sender="J", stage="country", choice="DDD")
            assert invalid.json()["error"] == "invalid"
            assert post(client, h, base, sender="J", stage="country", choice="").status_code == 422
            long_choice = post(client, h, base, sender="J", stage="country", choice="x" * 65)
            assert long_choice.status_code == 422
            assert (
                post(client, h, base, sender="J", stage="sideways", choice="AAA").status_code == 422
            )
            assert post(client, h, base, sender="J", stage="country").status_code == 422
            wrong_stage = post(client, h, base, sender="J", stage="destination", choice="AAA.one")
            assert wrong_stage.status_code == 409 and wrong_stage.json() == {"error": "bad_state"}
            assert get_view(client, h, seq)["state"] == "country"

    def test_the_single_destination_unit_skips_the_destination_roulette(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        # A research run that stays `running`: the default fake finishes on its first poll (~20 ms),
        # so on a loaded machine the stop's response can be built after the pack is already
        # `ready` — this test is about the skipped roulette, not about that race.
        researcher = FakeResearcher([FakeRunPlan(statuses=["running"])])
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_country(client, h, seq, "CCC")
            view = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Rose",
                stage="country",
                choice="CCC",
            ).json()
            assert view["state"] == "chosen"
            destination = view["destination"]
            assert destination["seed"] is None and destination["rouletteAt"] is None
            assert destination["chosen"]["id"] == "CCC.only" and destination["by"] == "Rose"
            assert [d["id"] for d in destination["candidates"]] == ["CCC.only"]
            assert view["pack"]["state"] == "pending"

    def test_an_exhausted_unit_is_a_409_and_the_roulette_carries_on(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            for n, dest in enumerate(("BBB.one", "BBB.two")):
                seq = create_round(client, h, f"adv-route-ex{n:04d}").json()["message"]["seq"]
                route_to_chosen(client, h, seq, "BBB", dest)
                post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="reject")
            seq = create_round(client, h, "adv-route-exfinal").json()["message"]["seq"]
            assert "BBB" not in get_view(client, h, seq)["eligible"]
            route_to_country(client, h, seq, "BBB")
            exhausted = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Josh",
                stage="country",
                choice="BBB",
            )
            assert exhausted.status_code == 409 and exhausted.json() == {"error": "exhausted"}
            assert get_view(client, h, seq)["state"] == "country"
            again = post(
                client,
                h,
                f"/adventure/{seq}/stop",
                sender="Josh",
                stage="country",
                choice="AAA",
            )
            assert again.status_code == 200 and again.json()["state"] == "destination"


class TestNeverAgainAndBank:
    def test_a_rejected_place_never_comes_up_again_and_a_banked_one_leaves_the_draw(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            rejected = create_round(client, h, "adv-route-nr0001").json()["message"]["seq"]
            route_to_chosen(client, h, rejected, "AAA", "AAA.one")
            post(client, h, f"/adventure/{rejected}/decide", sender="Josh", decision="reject")
            banked = create_round(client, h, "adv-route-nr0002").json()["message"]["seq"]
            route_to_chosen(client, h, banked, "AAA", "AAA.two")
            post(client, h, f"/adventure/{banked}/decide", sender="Josh", decision="bank")

            seq = create_round(client, h, "adv-route-nr0003").json()["message"]["seq"]
            view = route_to_country(client, h, seq)
            assert view["state"] == "country"
            stopped = post(
                client, h, f"/adventure/{seq}/stop", sender="J", stage="country", choice="AAA"
            ).json()
            assert [d["id"] for d in stopped["destination"]["candidates"]] == [
                "AAA.three",
                "AAA.four",
                "AAA.five",
                "AAA.six",
            ]

    def test_the_bank_lists_banked_trips_newest_first_with_their_headline(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            first = create_round(client, h, "adv-route-bk0001").json()["message"]["seq"]
            route_to_chosen(client, h, first, "EEE", "EEE.one")
            wait_for_pack(client, h, first, "ready")
            post(client, h, f"/adventure/{first}/decide", sender="Josh", decision="bank")
            skipped = create_round(client, h, "adv-route-bk0002").json()["message"]["seq"]
            route_to_chosen(client, h, skipped, "BBB", "BBB.one")
            post(client, h, f"/adventure/{skipped}/decide", sender="Josh", decision="reject")
            second = create_round(client, h, "adv-route-bk0003").json()["message"]["seq"]
            route_to_chosen(client, h, second, "CCC")
            post(client, h, f"/adventure/{second}/decide", sender="Josh", decision="bank")

            trips = client.get(f"{BASE}/adventure/bank", headers=h).json()["trips"]
            assert [t["seq"] for t in trips] == [second, first]
            newest, oldest = trips
            assert set(newest) == {"seq", "unitId", "unitName", "destination", "headline", "pack"}
            assert (newest["unitId"], newest["unitName"]) == ("CCC", "Singleton")
            assert newest["destination"]["id"] == "CCC.only"
            assert oldest["destination"]["name"] == "Echo One"
            assert oldest["headline"] == CANNED_ADVENTURE_PACK["headline"]
            assert oldest["pack"] == "ready"

    def test_deleting_a_trips_message_removes_it_from_the_bank_and_returns_it_to_the_draw(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq, "CCC")
            post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="bank")
            probe = create_round(client, h, "adv-route-probe01").json()["message"]["seq"]
            assert "CCC" not in get_view(client, h, probe)["eligible"]
            assert client.delete(f"{BASE}/messages/{seq}", headers=h).status_code in (202, 204)
            assert client.get(f"{BASE}/adventure/bank", headers=h).json() == {"trips": []}
            assert "CCC" in get_view(client, h, probe)["eligible"]

    def test_a_rejection_outlives_deleting_the_message_but_not_a_wipe(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq, "CCC")
            post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="reject")
            assert client.delete(f"{BASE}/messages/{seq}", headers=h).status_code in (202, 204)
            probe = create_round(client, h, "adv-route-probe02").json()["message"]["seq"]
            assert "CCC" not in get_view(client, h, probe)["eligible"]
            wiped = client.post(f"{BASE}/wipe", json={"confirm": "WIPE"}, headers=h)
            assert wiped.status_code in (202, 204)
            fresh = create_round(client, h, "adv-route-probe03").json()["message"]["seq"]
            assert "CCC" in get_view(client, h, fresh)["eligible"]


class TestAdvisedPreferenceRoutes:
    def test_the_default_excludes_advised_units(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            settings = client.get(f"{BASE}/adventure/settings", headers=h).json()
            assert settings == {
                "includeAdvised": False,
                "advisedUnits": [{"id": "DDD", "name": "Dangerland"}],
            }
            seq = create_round(client, h).json()["message"]["seq"]
            assert "DDD" not in get_view(client, h, seq)["eligible"]

    def test_switching_it_on_adds_them_to_eligible_for_an_open_spin_round(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            before = get_view(client, h, seq)
            assert before["eligible"] == ["AAA", "BBB", "CCC", "EEE"]

            switched = client.put(
                f"{BASE}/adventure/settings", json={"includeAdvised": True}, headers=h
            )
            assert switched.status_code == 200
            assert switched.json() == {
                "includeAdvised": True,
                "advisedUnits": [{"id": "DDD", "name": "Dangerland"}],
            }
            after = get_view(client, h, seq)
            assert after["eligible"] == ["AAA", "BBB", "CCC", "DDD", "EEE"]
            assert after["rev"] == before["rev"] + 1  # both screens notice and re-read

            # The advised country is now a valid landing, and its destinations are drawn.
            first = post(client, h, f"/adventure/{seq}/spin", **spin_body())
            assert first.status_code == 200
            lat = post(
                client,
                h,
                f"/adventure/{seq}/spin",
                **spin_body(axis="lat", delta=-SPIN_DELTA, result=result_body("DDD")),
            )
            assert lat.status_code == 200
            open_roulette(client, seq, "country")
            stop = post(
                client, h, f"/adventure/{seq}/stop", sender="J", stage="country", choice="DDD"
            )
            assert stop.status_code == 200
            assert [d["id"] for d in stop.json()["destination"]["candidates"]] == [
                "DDD.one",
                "DDD.two",
            ]

    def test_switching_it_off_again_and_the_landing_rule_follows_it(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            client.put(f"{BASE}/adventure/settings", json={"includeAdvised": True}, headers=h)
            client.put(f"{BASE}/adventure/settings", json={"includeAdvised": False}, headers=h)
            assert (
                client.get(f"{BASE}/adventure/settings", headers=h).json()["includeAdvised"]
                is False
            )
            seq = create_round(client, h).json()["message"]["seq"]
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            refused = post(
                client,
                h,
                f"/adventure/{seq}/spin",
                **spin_body(axis="lat", delta=-SPIN_DELTA, result=result_body("DDD")),
            )
            assert refused.status_code == 422 and refused.json()["error"] == "invalid"

    def test_an_unchanged_put_changes_nothing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            rev = get_view(client, h, seq)["rev"]
            for _ in range(2):
                response = client.put(
                    f"{BASE}/adventure/settings", json={"includeAdvised": False}, headers=h
                )
                assert response.status_code == 200
            assert get_view(client, h, seq)["rev"] == rev

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"includeAdvised": "yes"},
            {"includeAdvised": 1},
            {"includeAdvised": None},
            {"includeAdvised": True, "extra": 1},
        ],
    )
    def test_the_put_validates_its_body(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        body: dict[str, Any],
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            assert client.put(f"{BASE}/adventure/settings", json=body, headers=h).status_code == 422
            assert (
                client.get(f"{BASE}/adventure/settings", headers=h).json()["includeAdvised"]
                is False
            )

    def test_it_survives_a_wipe(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            client.put(f"{BASE}/adventure/settings", json={"includeAdvised": True}, headers=h)
            wiped = client.post(f"{BASE}/wipe", json={"confirm": "WIPE"}, headers=h)
            assert wiped.status_code in (202, 204)
            settings = client.get(f"{BASE}/adventure/settings", headers=h).json()
            assert settings["includeAdvised"] is True
            seq = create_round(client, h, "adv-route-afterwipe").json()["message"]["seq"]
            assert "DDD" in get_view(client, h, seq)["eligible"]


class TestPackRoutes:
    def test_without_a_researcher_the_pack_is_unavailable_at_once_and_decisions_still_work(
        self,
        storage_root: Path,
        wixy_repo_root: Path,
        pin_verifier: CmdPinVerifier,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("WIXY_EDITION", "standalone")
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, no_researcher=True) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            view = route_to_chosen(client, h, seq)
            assert view["pack"]["state"] == "unavailable"
            assert view["pack"]["data"] is None and view["pack"]["canRetry"] is False
            assert view["pack"]["error"]
            retry = post(client, h, f"/adventure/{seq}/pack/retry", sender="Josh")
            assert retry.status_code == 409 and retry.json() == {"error": "bad_state"}
            banked = post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="bank")
            assert banked.status_code == 200 and banked.json()["state"] == "banked"
            trips = client.get(f"{BASE}/adventure/bank", headers=h).json()["trips"]
            assert trips[0]["pack"] == "unavailable" and trips[0]["headline"] is None

    def test_a_failed_pack_can_be_retried_and_then_arrives(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        researcher = FakeResearcher([FakeRunPlan(statuses=["error"]), FakeRunPlan()])
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            failed = wait_for_pack(client, h, seq, "failed")
            assert failed["pack"]["error"] == "The research didn't finish — try again"
            assert failed["pack"]["canRetry"] is True and failed["pack"]["data"] is None

            retried = post(client, h, f"/adventure/{seq}/pack/retry", sender="Rose")
            assert retried.status_code == 200
            assert retried.json()["pack"]["state"] in ("pending", "ready")
            ready = wait_for_pack(client, h, seq, "ready")
            assert ready["pack"]["data"]["headline"] == CANNED_ADVENTURE_PACK["headline"]
            assert len(researcher.started) == 2

            # Retrying a ready pack is a conflict.
            late = post(client, h, f"/adventure/{seq}/pack/retry", sender="Rose")
            assert late.status_code == 409

    def test_rejecting_while_the_research_runs_stops_it(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        researcher = FakeResearcher([FakeRunPlan(statuses=["running"])])
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for(lambda: bool(researcher.started), what="the research run to start")
            post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="reject")
            wait_for(lambda: bool(researcher.cancelled), what="the run to be cancelled")
            assert researcher.cancelled == ["fake-run-1"]
            view = get_view(client, h, seq)
            assert view["state"] == "rejected" and view["pack"]["state"] == "failed"
            assert view["pack"]["canRetry"] is False


class TestGameChat:
    def test_wyr_seq_accepts_an_adventure_anchor_and_names_its_kind(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            sent = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "adv-game-chat-0001",
                    "sender": "Rose",
                    "deviceId": "device-1234",
                    "text": "Ooh, Lisbon!",
                    "wyrSeq": seq,
                },
                headers=h,
            )
            assert sent.status_code == 201, sent.text
            message = sent.json()["message"]
            assert message["wyrRef"] == seq and message["wyrRefKind"] == "adventure"
            assert message["adventure"] is None and message["wyr"] is None

            plain = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "adv-plain-chat-001",
                    "sender": "Rose",
                    "deviceId": "device-1234",
                    "text": "hi",
                },
                headers=h,
            ).json()["message"]
            assert plain["wyrRef"] is None and plain["wyrRefKind"] is None

            wyr = client.post(
                f"{BASE}/wyr",
                json={
                    "clientId": "adv-wyr-anchor-001",
                    "sender": "Josh",
                    "deviceId": "device-1234",
                },
                headers=h,
            ).json()["message"]["seq"]
            in_wyr = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "adv-wyr-chat-00001",
                    "sender": "Rose",
                    "deviceId": "device-1234",
                    "text": "wyr chat",
                    "wyrSeq": wyr,
                },
                headers=h,
            ).json()["message"]
            assert in_wyr["wyrRef"] == wyr and in_wyr["wyrRefKind"] == "wyr"

            history = client.get(f"{BASE}/messages", headers=h).json()["messages"]
            kinds = {m["seq"]: (m["wyrRef"], m["wyrRefKind"]) for m in history}
            assert kinds[message["seq"]] == (seq, "adventure")
            assert kinds[in_wyr["seq"]] == (wyr, "wyr")
            assert kinds[plain["seq"]] == (None, None)

    def test_a_missing_anchor_is_404_and_creates_nothing(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            sent = client.post(
                f"{BASE}/messages",
                json={
                    "clientId": "adv-nowhere-0001",
                    "sender": "Rose",
                    "deviceId": "device-1234",
                    "text": "x",
                    "wyrSeq": 4242,
                },
                headers=h,
            )
            assert sent.status_code == 404 and sent.json() == {"error": "not_found"}

    def test_the_summary_streams_with_each_mutation(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier) as (client, h):
            seq = create_round(client, h).json()["message"]["seq"]
            store: LiveChatStore = client.app.state.livechat_store  # type: ignore[attr-defined]
            post(client, h, f"/adventure/{seq}/spin", **spin_body())
            [message] = store.get_messages([seq])
            assert message.adventure is not None
            assert (message.adventure.state, message.adventure.rev) == ("spin_lat", 2)
            events = store.events_after(0)
            assert [e.type for e in events if e.message_seq == seq] == [
                "message",
                "message_updated",
            ]


class TestErasure:
    def test_deleting_the_message_erases_the_round_and_its_pack_from_the_raw_bytes(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sentinel = "ZZ-ROUTE-PACK-SENTINEL-4417"
        pack = {**CANNED_ADVENTURE_PACK, "headline": sentinel}
        researcher = FakeResearcher([FakeRunPlan(response_text=json.dumps(pack))])
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for_pack(client, h, seq, "ready")
            assert sentinel.encode() in _raw_db(client)
            deleted = client.delete(f"{BASE}/messages/{seq}", headers=h)
            assert deleted.status_code in (202, 204)
            assert sentinel.encode() not in _raw_db(client)
            assert client.get(f"{BASE}/adventure/{seq}", headers=h).status_code == 404

    def test_a_wipe_erases_every_round_and_the_never_again_list(
        self, storage_root: Path, wixy_repo_root: Path, pin_verifier: CmdPinVerifier
    ) -> None:
        sentinel = "ZZ-WIPE-PACK-SENTINEL-9031"
        pack = {**CANNED_ADVENTURE_PACK, "headline": sentinel}
        researcher = FakeResearcher([FakeRunPlan(response_text=json.dumps(pack))])
        with unlocked_client(storage_root, wixy_repo_root, pin_verifier, researcher=researcher) as (
            client,
            h,
        ):
            seq = create_round(client, h).json()["message"]["seq"]
            route_to_chosen(client, h, seq)
            wait_for_pack(client, h, seq, "ready")
            post(client, h, f"/adventure/{seq}/decide", sender="Josh", decision="bank")
            assert sentinel.encode() in _raw_db(client)
            wiped = client.post(f"{BASE}/wipe", json={"confirm": "WIPE"}, headers=h)
            assert wiped.status_code in (202, 204)
            assert sentinel.encode() not in _raw_db(client)
            assert client.get(f"{BASE}/adventure/bank", headers=h).json() == {"trips": []}
            assert client.get(f"{BASE}/adventure/{seq}", headers=h).status_code == 404

    def test_the_bank_fixture_is_not_the_shipped_bank(self) -> None:
        assert set(fixture_bank().units) == {"AAA", "BBB", "CCC", "DDD", "EEE"}
