"""The public bank and its short codes (workspace 00065, spec/adventure-public/README.md §2.3):
the code algorithm (checked against an independent RFC 4648 base32 implementation), the collision
rule, no collision in the shipped bank, and the `GET /api/bank` document."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import logging
from pathlib import Path

import pytest

from wixy_server.adventure_public.codes import (
    CODE_ALPHABET,
    CODE_LENGTH,
    LONG_CODE_LENGTH,
    PINNED_CODES_PATH,
    PublicBank,
    assign_codes,
    build_public_bank,
    is_code,
    load_pinned_codes,
    short_code,
)
from wixy_server.adventure_public.pin_codes import main as pin_codes_main
from wixy_server.adventure_public.pin_codes import pin_missing
from wixy_server.livechat.adventure_bank import load_bank
from wixy_server.tests.adventure_testkit import fixture_bank

RFC_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def reference_code(destination_id: str, length: int) -> str:
    """The spec's words, done a different way: RFC 4648 base32 of the sha256 digest, with the
    standard alphabet swapped for ours position by position, lower-case, first `length`."""
    encoded = base64.b32encode(hashlib.sha256(destination_id.encode("utf-8")).digest()).decode()
    return encoded.translate(str.maketrans(RFC_BASE32, CODE_ALPHABET))[:length]


class TestAlphabet:
    def test_it_is_the_32_lower_case_characters_without_l_and_o(self) -> None:
        assert CODE_ALPHABET == "abcdefghijkmnpqrstuvwxyz23456789"
        assert len(CODE_ALPHABET) == 32 == len(set(CODE_ALPHABET))
        assert not {"l", "o", "0", "1"} & set(CODE_ALPHABET)


class TestShortCode:
    @pytest.mark.parametrize("destination_id", ["AAA.one", "PRT.lisbon", "ESP.barcelona", "x", ""])
    @pytest.mark.parametrize("length", [1, 6, 8, 13, 40])
    def test_it_is_the_base32_of_the_sha256_digest(self, destination_id: str, length: int) -> None:
        assert short_code(destination_id, length) == reference_code(destination_id, length)

    def test_a_code_is_six_lower_case_characters_by_default_and_stable(self) -> None:
        code = short_code("PRT.lisbon")
        assert len(code) == CODE_LENGTH == 6
        assert set(code) <= set(CODE_ALPHABET)
        assert code == short_code("PRT.lisbon")  # forever the same for the same id
        assert short_code("PRT.lisbon", 8).startswith(code)  # a longer code extends the short one

    def test_pinned_values_never_change(self) -> None:
        # Codes are in people's bookmarks: these must never move (a failure here is a breaking
        # change to every shared link, not a test to update).
        assert short_code("AAA.one") == "259fiy"
        assert short_code("AAA.one", 8) == "259fiyxv"
        assert short_code("PRT.lisbon") == "c9za9p"
        assert short_code("ESP.barcelona") == "35r6p6"

    @pytest.mark.parametrize("length", [0, -1, 41])
    def test_an_impossible_length_is_refused(self, length: int) -> None:
        with pytest.raises(ValueError):
            short_code("AAA.one", length)

    def test_is_code_checks_the_shape_only(self) -> None:
        assert is_code("abcdef") and is_code("a2c4e6g8")
        assert not is_code("abcde")  # too short
        assert not is_code("abcdefl")  # `l` is not in the alphabet
        assert not is_code("ABCDEF")  # lower case only
        assert not is_code("abc-ef")
        assert not is_code("a" * 41)
        assert not is_code("")


class TestCollisions:
    def test_the_shipped_bank_has_no_collision(self) -> None:
        bank = load_bank()
        ids = [d.id for unit in bank.units.values() for d in unit.destinations]
        assert len(ids) > 1000
        codes = {dest_id: short_code(dest_id) for dest_id in ids}
        assert len(set(codes.values())) == len(ids), "two shipped destinations share a 6-char code"
        # ...so the built bank keeps every code at 6 characters.
        built = build_public_bank(bank)
        assert {len(code) for code in built.codes.values()} == {6}
        assert set(built.codes) == set(ids)

    def test_a_collision_lengthens_both_colliding_codes_to_eight_and_is_logged(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        def clash(destination_id: str, length: int) -> str:
            if destination_id in ("X.one", "X.two") and length == CODE_LENGTH:
                return "aaaaaa"  # a forced 6-character collision between exactly these two
            return short_code(destination_id, length)

        with caplog.at_level(logging.WARNING, logger="wixy_server.adventure_public.codes"):
            codes = assign_codes(["X.one", "X.two", "X.three"], code_fn=clash)
        assert len(codes["X.one"]) == len(codes["X.two"]) == LONG_CODE_LENGTH == 8
        assert codes["X.one"] == short_code("X.one", 8) != codes["X.two"]
        assert codes["X.three"] == short_code("X.three")  # the bystander keeps its 6
        assert "X.one" in caplog.text and "X.two" in caplog.text

    def test_a_collision_that_survives_eight_characters_lengthens_again(self) -> None:
        def clash(destination_id: str, length: int) -> str:
            if destination_id in ("X.one", "X.two") and length <= 8:
                return "b" * length
            return short_code(destination_id, length)

        codes = assign_codes(["X.one", "X.two"], code_fn=clash)
        assert len(codes["X.one"]) == len(codes["X.two"]) == 10

    def test_a_code_that_can_never_be_made_unique_is_refused(self) -> None:
        with pytest.raises(ValueError, match="share a code"):
            assign_codes(["X.one", "X.two"], code_fn=lambda _id, length: "c" * length)

    def test_the_built_bank_resolves_a_lengthened_code_both_ways(self) -> None:
        def clash(destination_id: str, length: int) -> str:
            if destination_id in ("AAA.one", "AAA.two") and length == CODE_LENGTH:
                return "dddddd"
            return short_code(destination_id, length)

        bank = build_public_bank(fixture_bank(), code_fn=clash)
        one, two = bank.codes["AAA.one"], bank.codes["AAA.two"]
        assert len(one) == len(two) == 8 and one != two
        assert bank.lookup(one) is not None and bank.lookup(one).destination.id == "AAA.one"  # type: ignore[union-attr]
        assert bank.lookup(two) is not None and bank.lookup(two).destination.id == "AAA.two"  # type: ignore[union-attr]
        assert bank.lookup("dddddd") is None  # the old shared code names nothing


@pytest.fixture(scope="module")
def built() -> PublicBank:
    return build_public_bank(fixture_bank())


class TestPublicBank:
    def test_the_document_has_the_documented_shape(self, built: PublicBank) -> None:
        document = json.loads(built.body)
        assert set(document) == {"version", "countries"}
        assert document["version"] == 1
        alpha = document["countries"]["AAA"]
        assert set(alpha) == {"name", "advice", "destinations"}
        assert alpha["name"] == "Alphaland" and alpha["advice"] is None
        first = alpha["destinations"][0]
        assert first == {
            "id": "AAA.one",
            "code": built.codes["AAA.one"],
            "name": "Alpha One",
            "region": "North",
            "lat": 10.0,
            "lng": 20.0,
            "kind": "city",
            "blurb": "Rank one of Alphaland.",
        }
        assert [d["id"] for d in alpha["destinations"]][:3] == ["AAA.one", "AAA.two", "AAA.three"]
        assert document["countries"]["DDD"]["advice"] == {
            "level": "against_all_travel",
            "checked": "2026-10-01",
        }

    def test_every_destination_is_there_exactly_once_in_rank_order(self, built: PublicBank) -> None:
        document = json.loads(built.body)
        bank = fixture_bank()
        for unit_id, unit in bank.units.items():
            served = [d["id"] for d in document["countries"][unit_id]["destinations"]]
            assert served == [d.id for d in unit.destinations]

    def test_the_gzip_body_is_the_same_document_and_the_etags_differ(
        self, built: PublicBank
    ) -> None:
        assert gzip.decompress(built.gzipped) == built.body
        assert built.etag.startswith('"') and built.etag.endswith('"')
        assert built.gzip_etag != built.etag and built.gzip_etag.endswith('-gzip"')

    def test_the_etag_follows_the_content(self) -> None:
        first = build_public_bank(fixture_bank())
        again = build_public_bank(fixture_bank())
        assert first.etag == again.etag and first.body == again.body  # deterministic
        shipped = build_public_bank(load_bank())
        assert shipped.etag != first.etag

    def test_lookup_finds_a_place_by_its_code_only(self, built: PublicBank) -> None:
        code = built.codes["EEE.two"]
        found = built.lookup(code)
        assert found is not None
        assert found.destination.id == "EEE.two" and found.unit.id == "EEE" and found.code == code
        assert built.lookup("zzzzzz") is None
        assert built.lookup("EEE.two") is None
        assert built.lookup("") is None
        assert built.code_of("EEE.two") == code and built.code_of("nope") is None


class TestPinnedCodes:
    """A code is in people's bookmarks, so a bank update must never change one that exists: the
    committed table `codes_pinned.json` holds every shipped destination's code, and only a NEWCOMER
    is ever made longer to avoid a clash."""

    def test_every_shipped_destination_is_pinned_to_the_code_it_has_today(self) -> None:
        pinned = load_pinned_codes()
        bank = load_bank()
        ids = [d.id for unit in bank.units.values() for d in unit.destinations]
        missing = [dest_id for dest_id in ids if dest_id not in pinned]
        assert missing == [], (
            "a destination is not in wixy_server/adventure_public/codes_pinned.json; run "
            "`python -m wixy_server.adventure_public.pin_codes` and commit the result"
        )
        for dest_id in ids:
            assert pinned[dest_id] == short_code(dest_id), dest_id
        assert len(set(pinned.values())) == len(pinned)  # no two destinations share a code
        assert all(is_code(code) for code in pinned.values())
        built = build_public_bank(bank)
        assert {dest_id: built.codes[dest_id] for dest_id in ids} == {i: pinned[i] for i in ids}

    def test_the_table_is_a_flat_id_to_code_object(self) -> None:
        raw = json.loads(PINNED_CODES_PATH.read_text(encoding="utf-8"))
        assert isinstance(raw, dict) and raw
        assert all(isinstance(k, str) and isinstance(v, str) for k, v in raw.items())

    def test_a_pinned_destination_keeps_its_code_whatever_the_algorithm_says(self) -> None:
        def other(destination_id: str, length: int) -> str:
            return (
                ("z" * length)
                if destination_id == "AAA.one"
                else short_code(destination_id, length)
            )

        codes = assign_codes(["AAA.one", "AAA.two"], code_fn=other, pinned={"AAA.one": "abcdef"})
        assert codes["AAA.one"] == "abcdef"
        assert codes["AAA.two"] == short_code("AAA.two")

    def test_a_newcomer_that_clashes_with_a_pinned_code_is_lengthened_and_the_pinned_one_is_not(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        def clash(destination_id: str, length: int) -> str:
            if destination_id == "NEW.one" and length == CODE_LENGTH:
                return "qqqqqq"  # exactly the code `OLD.one` already has
            return short_code(destination_id, length)

        with caplog.at_level(logging.WARNING, logger="wixy_server.adventure_public.codes"):
            codes = assign_codes(
                ["OLD.one", "NEW.one"], code_fn=clash, pinned={"OLD.one": "qqqqqq"}
            )
        assert codes["OLD.one"] == "qqqqqq"  # the old code never moves
        assert codes["NEW.one"] == short_code("NEW.one", LONG_CODE_LENGTH)
        assert "NEW.one" in caplog.text and "OLD.one" not in caplog.text

    def test_a_newcomer_never_takes_the_code_of_a_destination_that_left_the_bank(self) -> None:
        def clash(destination_id: str, length: int) -> str:
            return (
                "rrrrrr"
                if (destination_id == "NEW.one" and length == CODE_LENGTH)
                else (short_code(destination_id, length))
            )

        codes = assign_codes(["NEW.one"], code_fn=clash, pinned={"GONE.one": "rrrrrr"})
        assert codes == {"NEW.one": short_code("NEW.one", LONG_CODE_LENGTH)}

    def test_a_newcomer_lengthens_again_until_it_clashes_with_nothing(self) -> None:
        def clash(destination_id: str, length: int) -> str:
            if destination_id == "NEW.one" and length <= 8:
                return "s" * length
            return short_code(destination_id, length)

        codes = assign_codes(
            ["NEW.one"], code_fn=clash, pinned={"OLD.a": "s" * 6, "OLD.b": "s" * 8}
        )
        assert len(codes["NEW.one"]) == 10 and codes["NEW.one"] == short_code("NEW.one", 10)

    def test_two_newcomers_that_clash_with_each_other_both_lengthen(self) -> None:
        def clash(destination_id: str, length: int) -> str:
            if destination_id in ("NEW.one", "NEW.two") and length == CODE_LENGTH:
                return "tttttt"
            return short_code(destination_id, length)

        codes = assign_codes(["NEW.one", "NEW.two"], code_fn=clash, pinned={})
        assert len(codes["NEW.one"]) == len(codes["NEW.two"]) == LONG_CODE_LENGTH

    def test_the_public_bank_uses_the_pins(self) -> None:
        pinned = {"AAA.one": "mmmmmm"}
        built = build_public_bank(fixture_bank(), pinned=pinned)
        assert built.codes["AAA.one"] == pinned["AAA.one"]
        assert built.lookup(pinned["AAA.one"]) is not None
        assert built.codes["AAA.two"] == short_code("AAA.two")


class TestPinGenerator:
    def test_the_committed_table_is_complete_so_the_generator_has_nothing_to_add(self) -> None:
        pinned = load_pinned_codes()
        assert pin_missing(load_bank(), pinned) == pinned

    def test_it_only_ever_appends_and_never_changes_an_existing_entry(self) -> None:
        pinned = {"AAA.one": "abcdef"}
        table = pin_missing(fixture_bank(), pinned)
        assert table["AAA.one"] == "abcdef"
        assert set(table) == {d.id for u in fixture_bank().units.values() for d in u.destinations}
        assert table["AAA.two"] == short_code("AAA.two")
        again = pin_missing(fixture_bank(), table)
        assert again == table

    def test_the_command_writes_the_table_and_check_mode_reports_a_gap(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        target = tmp_path / "pins.json"
        target.write_text(json.dumps({"AAA.one": "abcdef"}), encoding="utf-8")
        assert pin_codes_main(["--check", "--table", str(target)], bank=fixture_bank()) == 1
        assert json.loads(target.read_text(encoding="utf-8")) == {"AAA.one": "abcdef"}  # untouched
        assert pin_codes_main(["--table", str(target)], bank=fixture_bank()) == 0
        written = json.loads(target.read_text(encoding="utf-8"))
        assert written["AAA.one"] == "abcdef" and len(written) > 1
        assert pin_codes_main(["--check", "--table", str(target)], bank=fixture_bank()) == 0
        assert "added" in capsys.readouterr().out
