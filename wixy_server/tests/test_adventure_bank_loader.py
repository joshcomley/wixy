"""The server's own view of the Adventure Time destination bank (workspace 00056,
spec/server-chat/08-adventure-time §2.2): the strict loader `adventure_bank.load_bank`, the
committed bank loading cleanly, the exclusion maths (rejected, banked, the advised switch) and
the top-five selection with its 40 km spacing.

The committed bank is ALSO checked against the world MAP (every point inside its unit's geometry or
within 25 km, ids, ranks, advice marks) by `tooling/adventure/validate_bank.py`, run from
`test_adventure_bank.py`; this file proves the loader the app actually starts with accepts what that
validator accepts and refuses what the §2.2 schema does not allow."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat import adventure_bank
from wixy_server.livechat.adventure_bank import (
    BANK_PATH,
    KINDS,
    MIN_SPACING_KM,
    AdventureBank,
    AdventureBankError,
    distance_km,
    load_bank,
    load_bank_or_empty,
    parse_bank,
)
from wixy_server.tests.adventure_testkit import FIXTURE_BANK_PATH, fixture_bank


def _dest(unit: str, slug: str, lat: float, lng: float, /, **over: Any) -> dict[str, Any]:
    dest = {
        "id": f"{unit}.{slug}",
        "name": slug.title(),
        "region": "Region",
        "lat": lat,
        "lng": lng,
        "kind": "city",
        "blurb": f"About {slug}.",
    }
    dest.update(over)
    return dest


def _doc(destinations: list[dict[str, Any]] | None = None, **unit_over: Any) -> dict[str, Any]:
    unit: dict[str, Any] = {
        "name": "Testland",
        "advice": None,
        "destinations": destinations
        if destinations is not None
        else [_dest("TST", "one", 10.0, 10.0)],
    }
    unit.update(unit_over)
    return {"version": 1, "generated": "2026-10-28", "countries": {"TST": unit}}


class TestCommittedBank:
    def test_the_shipped_bank_loads_and_satisfies_the_schema(self) -> None:
        bank = load_bank(BANK_PATH)
        assert bank.units, "the bank must hold at least one unit"
        seen: set[str] = set()
        for unit_id, unit in bank.units.items():
            assert unit.id == unit_id and unit.name
            assert 1 <= len(unit.destinations) <= 10
            assert (unit.advice_level is None) == (unit.advice_checked is None)
            for destination in unit.destinations:
                assert destination.id.startswith(f"{unit_id}.")
                assert destination.id not in seen
                seen.add(destination.id)
                assert destination.kind in KINDS
                assert -90.0 <= destination.lat <= 90.0 and -180.0 <= destination.lng <= 180.0
                assert 0 < len(destination.blurb) <= 120

    def test_the_shipped_bank_is_playable(self) -> None:
        assert load_bank(BANK_PATH).eligible_units()

    def test_the_fixture_bank_loads(self) -> None:
        bank = fixture_bank()
        assert set(bank.units) == {"AAA", "BBB", "CCC", "DDD", "EEE"}
        assert bank.unit("DDD") is not None and bank.unit("DDD").advised  # type: ignore[union-attr]
        assert bank.unit("AAA") is not None and not bank.unit("AAA").advised  # type: ignore[union-attr]


class TestStrictLoader:
    def test_a_minimal_document_is_valid(self) -> None:
        bank = parse_bank(_doc())
        assert bank.version == 1 and bank.generated == "2026-10-28"
        assert bank.destination("TST.one") is not None

    @pytest.mark.parametrize(
        "mutate",
        [
            lambda d: d.update(version=2),
            lambda d: d.update(version=True),
            lambda d: d.update(extra="nope"),
            lambda d: d.update(generated="28/10/2026"),
            lambda d: d.update(generated="2026-13-45"),
            lambda d: d.update(countries={}),
            lambda d: d.update(countries=[]),
            lambda d: d["countries"].update(tst=d["countries"].pop("TST")),
            lambda d: d["countries"].update(TSTX=d["countries"].pop("TST")),
            lambda d: d["countries"]["TST"].update(extra=1),
            lambda d: d["countries"]["TST"].pop("advice"),
            lambda d: d["countries"]["TST"].update(name=""),
            lambda d: d["countries"]["TST"].update(name=" padded "),
            lambda d: d["countries"]["TST"].update(name="x" * 81),
            lambda d: d["countries"]["TST"].update(advice={"level": "against_all_travel"}),
            lambda d: d["countries"]["TST"].update(
                advice={"level": "against_some_travel", "checked": "2026-10-01"}
            ),
            lambda d: d["countries"]["TST"].update(
                advice={"level": "against_all_travel", "checked": "yesterday"}
            ),
            lambda d: d["countries"]["TST"].update(
                advice={"level": "against_all_travel", "checked": "2026-10-01", "x": 1}
            ),
            lambda d: d["countries"]["TST"].update(destinations=[]),
            lambda d: d["countries"]["TST"].update(destinations={}),
            lambda d: d["countries"]["TST"].update(
                destinations=[_dest("TST", f"p{n}", 1.0, 1.0) for n in range(11)]
            ),
        ],
    )
    def test_bad_documents_are_refused(self, mutate: Any) -> None:
        doc = _doc()
        mutate(doc)
        with pytest.raises(AdventureBankError):
            parse_bank(doc)

    @pytest.mark.parametrize(
        "over",
        [
            {"id": "XXX.one"},  # another unit's prefix
            {"id": "TST.One"},  # not lower-case kebab
            {"id": "TST.two words"},
            {"id": "TST."},
            {"id": "TST.-bad"},
            {"id": "TST.bad-"},
            {"id": "TST.a--b"},
            {"id": "TST.café"},
            {"id": "TST." + "a" * 61},
            {"name": ""},
            {"region": ""},
            {"kind": "spa"},
            {"lat": 91.0},
            {"lat": -90.5},
            {"lng": 180.5},
            {"lng": "10"},
            {"lat": True},
            {"lat": float("nan")},
            {"blurb": ""},
            {"blurb": "x" * 121},
            {"blurb": "two\nlines"},
            {"extra": "x"},
        ],
    )
    def test_bad_destinations_are_refused(self, over: dict[str, Any]) -> None:
        with pytest.raises(AdventureBankError):
            parse_bank(_doc([_dest("TST", "one", 10.0, 10.0, **over)]))

    def test_a_missing_destination_key_is_refused(self) -> None:
        broken = _dest("TST", "one", 10.0, 10.0)
        broken.pop("blurb")
        with pytest.raises(AdventureBankError):
            parse_bank(_doc([broken]))

    def test_destination_ids_are_unique_across_the_whole_bank(self) -> None:
        doc = _doc([_dest("TST", "one", 10.0, 10.0), _dest("TST", "one", 20.0, 20.0)])
        with pytest.raises(AdventureBankError):
            parse_bank(doc)

    def test_the_boundary_values_are_accepted(self) -> None:
        doc = _doc(
            [
                _dest("TST", "pole", -90.0, 180.0, blurb="x" * 120, name="n" * 80),
                _dest("TST", "other", 90.0, -180.0, kind="wine"),
            ],
            advice={"level": "against_all_travel", "checked": "2026-02-28"},
        )
        bank = parse_bank(doc)
        assert bank.unit("TST") is not None and bank.unit("TST").advised  # type: ignore[union-attr]

    def test_missing_or_broken_files_raise_but_the_app_loader_degrades_to_empty(
        self, tmp_path: Path
    ) -> None:
        with pytest.raises(AdventureBankError):
            load_bank(tmp_path / "nope.json")
        broken = tmp_path / "broken.json"
        broken.write_text("{not json", encoding="utf-8")
        with pytest.raises(AdventureBankError):
            load_bank(broken)
        assert load_bank_or_empty(tmp_path / "nope.json").units == {}
        assert load_bank_or_empty(broken).eligible_units() == ()
        good = tmp_path / "good.json"
        good.write_text(json.dumps(_doc()), encoding="utf-8")
        assert load_bank_or_empty(good).eligible_units() == ("TST",)


class TestExclusion:
    def test_eligible_units_need_a_remaining_destination_and_no_advice(self) -> None:
        bank = fixture_bank()
        assert bank.eligible_units() == ("AAA", "BBB", "CCC", "EEE")  # DDD is advised
        gone = {"CCC.only"}
        assert "CCC" not in bank.eligible_units(gone)
        assert "BBB" in bank.eligible_units({"BBB.one"})
        assert "BBB" not in bank.eligible_units({"BBB.one", "BBB.two"})

    def test_advised_units_are_left_out_unless_the_shared_preference_switches_them_in(
        self,
    ) -> None:
        bank = fixture_bank()
        assert not bank.is_playable("DDD") and bank.is_playable("DDD", include_advised=True)
        assert "DDD" not in bank.eligible_units()
        assert "DDD" in bank.eligible_units(include_advised=True)
        # The data never changes: only the argument does, and exclusion still applies on top.
        assert "DDD" not in bank.eligible_units({"DDD.one", "DDD.two"}, include_advised=True)
        assert bank.is_playable("AAA") and bank.is_playable("AAA", include_advised=True)
        assert not bank.is_playable("ZZZ", include_advised=True)

    def test_the_units_the_switch_governs_are_listed_by_name(self) -> None:
        assert [(u.id, u.name) for u in fixture_bank().advised_units()] == [("DDD", "Dangerland")]
        assert not hasattr(adventure_bank, "EXCLUDE_ADVISED_UNITS")

    def test_unknown_units_are_not_playable_and_have_nothing_remaining(self) -> None:
        bank = fixture_bank()
        assert not bank.is_playable("ZZZ") and bank.remaining("ZZZ") == ()
        assert bank.top_destinations("ZZZ") == ()

    def test_remaining_keeps_rank_order_minus_the_excluded(self) -> None:
        bank = fixture_bank()
        ids = [d.id for d in bank.remaining("AAA", {"AAA.two", "AAA.four"})]
        assert ids == ["AAA.one", "AAA.three", "AAA.five", "AAA.six"]

    def test_lookups_resolve_destinations_and_their_unit(self) -> None:
        bank = fixture_bank()
        destination = bank.destination("EEE.two")
        assert destination is not None and destination.name == "Echo Two"
        unit = bank.unit_of("EEE.two")
        assert unit is not None and unit.id == "EEE" and bank.unit_name("EEE") == "Echoland"
        assert bank.destination("EEE.nine") is None and bank.unit_of("EEE.nine") is None
        assert bank.unit_name("ZZZ") == "ZZZ"
        assert destination.to_json() == {
            "id": "EEE.two",
            "name": "Echo Two",
            "region": "Bay",
            "lat": -41.0,
            "lng": 101.0,
            "kind": "nature",
            "blurb": "Rank two of Echoland.",
        }


class TestDistance:
    def test_known_distances(self) -> None:
        assert distance_km(10.0, 20.0, 10.0, 20.0) == 0.0
        london_paris = distance_km(51.5072, -0.1276, 48.8566, 2.3522)
        assert 340.0 < london_paris < 348.0
        assert 20_000.0 < distance_km(0.0, 0.0, 0.0, 180.0) < 20_030.0

    def test_it_is_symmetric_and_wraps_the_antimeridian(self) -> None:
        a = distance_km(10.0, 179.5, 10.0, -179.5)
        assert a == distance_km(10.0, -179.5, 10.0, 179.5)
        assert a < 120.0  # one degree of longitude at 10 degrees north, not 359


def _cluster_bank(points: list[tuple[float, float]]) -> AdventureBank:
    return parse_bank(
        _doc([_dest("TST", f"p{n}", lat, lng) for n, (lat, lng) in enumerate(points)])
    )


def _ids(destinations: Any) -> list[str]:
    return [d.id.split(".")[1] for d in destinations]


class TestTopFive:
    def test_without_clusters_it_is_the_first_five_in_rank_order(self) -> None:
        bank = fixture_bank()
        assert _ids(bank.top_destinations("AAA")) == ["one", "two", "three", "four", "five"]
        assert _ids(bank.top_destinations("BBB")) == ["one", "two"]
        assert _ids(bank.top_destinations("CCC")) == ["only"]
        assert bank.top_destinations("AAA", n=2)[-1].id == "AAA.two"

    def test_a_pick_within_40_km_of_one_already_taken_is_held_back(self) -> None:
        # Peru in miniature: p1 and p6 sit on top of p0; the rest are well apart.
        bank = _cluster_bank(
            [(0.0, 0.0), (0.1, 0.1), (1.0, 1.0), (2.0, 2.0), (3.0, 3.0), (4.0, 4.0), (0.2, 0.2)]
        )
        assert _ids(bank.top_destinations("TST")) == ["p0", "p2", "p3", "p4", "p5"]

    def test_held_back_destinations_stay_in_reserve_and_come_round_again(self) -> None:
        bank = _cluster_bank(
            [(0.0, 0.0), (0.1, 0.1), (1.0, 1.0), (2.0, 2.0), (3.0, 3.0), (4.0, 4.0), (0.2, 0.2)]
        )
        # p0 rejected: p1 is now the nearest-to-the-top and nothing else crowds it.
        assert _ids(bank.top_destinations("TST", {"TST.p0"})) == ["p1", "p2", "p3", "p4", "p5"]
        # They were never consumed: still remaining in rank order.
        assert _ids(bank.remaining("TST")) == [f"p{n}" for n in range(7)]
        # p0, p2 and p3 gone: p1 first, then p4, p5; p6 (on top of p1) is held back, then used
        # as the filler because only three spaced ones exist.
        assert _ids(bank.top_destinations("TST", {"TST.p0", "TST.p2", "TST.p3"})) == [
            "p1",
            "p4",
            "p5",
            "p6",
        ]

    def test_when_too_few_qualify_the_rest_is_filled_from_the_skipped_in_rank_order(
        self,
    ) -> None:
        # Seven points: three spaced (p0, p3, p5) and four crowding p0 or p3.
        bank = _cluster_bank(
            [
                (0.0, 0.0),
                (0.05, 0.05),  # p1: crowds p0
                (0.1, 0.1),  # p2: crowds p0
                (3.0, 3.0),  # p3
                (3.05, 3.05),  # p4: crowds p3
                (6.0, 6.0),  # p5
                (6.05, 6.05),  # p6: crowds p5
            ]
        )
        # Spaced first (p0, p3, p5), then the skipped in rank order (p1, p2); returned by rank.
        assert _ids(bank.top_destinations("TST")) == ["p0", "p1", "p2", "p3", "p5"]

    def test_an_entirely_clustered_unit_still_offers_five(self) -> None:
        bank = _cluster_bank([(0.0 + n * 0.01, 0.0) for n in range(8)])
        assert _ids(bank.top_destinations("TST")) == ["p0", "p1", "p2", "p3", "p4"]

    def test_the_count_is_never_reduced_by_the_spacing(self) -> None:
        for count in range(1, 9):
            bank = _cluster_bank([(0.0 + n * 0.01, 0.0) for n in range(count)])
            assert len(bank.top_destinations("TST")) == min(5, count)

    def test_forty_kilometres_is_the_line(self) -> None:
        near, far = (0.35, 0.0), (0.37, 0.0)
        assert distance_km(0.0, 0.0, *near) < MIN_SPACING_KM <= distance_km(0.0, 0.0, *far)
        crowded = _cluster_bank([(0.0, 0.0), near, (5.0, 5.0), (6.0, 6.0), (7.0, 7.0), (8.0, 8.0)])
        assert _ids(crowded.top_destinations("TST")) == ["p0", "p2", "p3", "p4", "p5"]
        spaced = _cluster_bank([(0.0, 0.0), far, (5.0, 5.0), (6.0, 6.0), (7.0, 7.0), (8.0, 8.0)])
        assert _ids(spaced.top_destinations("TST")) == ["p0", "p1", "p2", "p3", "p4"]

    def test_the_fixture_documents_are_not_mutated_by_any_of_this(self) -> None:
        raw = json.loads(FIXTURE_BANK_PATH.read_text(encoding="utf-8"))
        before = copy.deepcopy(raw)
        parse_bank(raw)
        assert raw == before
