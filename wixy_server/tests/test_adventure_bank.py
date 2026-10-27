"""Adventure Time destination bank: the validator, the world map it measures against, and the
committed bank (spec/server-chat/08-adventure-time.md sections 2.1 and 2.2).

The validator lives in ``tooling/adventure/validate_bank.py`` (stdlib only, no package) and is
loaded here by path. These tests run entirely offline: ``admin-ui/data/adventure-world.json`` is
the committed output of ``tooling/adventure/build_world.mjs``.
"""

import copy
import importlib.util
import json
import re
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[2]
VALIDATOR = REPO / "tooling" / "adventure" / "validate_bank.py"
WORLD = REPO / "admin-ui" / "data" / "adventure-world.json"
UNITS = REPO / "tooling" / "adventure" / "units.json"
FIXTURE = Path(__file__).parent / "fixtures" / "adventure_bank_fixture.json"
REAL_BANK = REPO / "wixy_server" / "livechat" / "adventure_destinations.json"

# spec 2.1: the six countries replaced by their map-unit pieces, and the ids those pieces carry.
SPLIT_UNIT_IDS = {
    "FXX", "MTQ", "GLP", "GUF", "REU", "MYT", "PRX", "PMD", "PAZ", "NOR",
    "NSV", "NJM", "NLD", "NLY", "TZA", "TZZ", "ENG", "SCT", "WLS", "NIR",
}  # fmt: skip
MICRO_STATES = ["VAT", "MCO", "SMR", "LIE", "MLT", "SGP", "BHR", "MDV", "NRU", "TUV"]


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("adventure_validate_bank", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look their defining module up here
    spec.loader.exec_module(module)
    return module


vb = _load_validator()


@pytest.fixture(scope="module")
def world() -> Any:
    return vb.load_world(WORLD)


@pytest.fixture
def bank() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return data


def _problems(data: object, world: Any) -> list[str]:
    result: list[str] = vb.validate_data(data, world)
    return result


def _single(unit: str, name: str, lat: float, lng: float) -> tuple[dict[str, Any], str]:
    """A one-destination bank, and the destination id (the unit-size rule is not its subject)."""
    dest_id = f"{unit}.{name.lower().replace(' ', '-')}"
    bank = {
        "version": 1,
        "generated": "2026-10-27",
        "countries": {
            unit: {
                "name": unit,
                "advice": None,
                "destinations": [
                    {
                        "id": dest_id,
                        "name": name,
                        "region": "Somewhere",
                        "lat": lat,
                        "lng": lng,
                        "kind": "island",
                        "blurb": "A test place.",
                    }
                ],
            }
        },
    }
    return bank, dest_id


def _position_problems(world: Any, unit: str, name: str, lat: float, lng: float) -> list[str]:
    data, dest_id = _single(unit, name, lat, lng)
    return [p for p in _problems(data, world) if dest_id in p]


# ---------------------------------------------------------------------------------------------
# The fixture bank and the happy path
# ---------------------------------------------------------------------------------------------


def test_fixture_bank_is_valid(world: Any) -> None:
    assert vb.validate(FIXTURE, WORLD) == []
    assert _problems(json.loads(FIXTURE.read_text(encoding="utf-8")), world) == []


def test_fixture_exercises_every_geography_rule(world: Any) -> None:
    inside = world.distance_km("GRC", 25.4318, 36.4167)  # Santorini
    assert inside == 0.0
    lisbon = world.distance_km("PRX", -9.1393, 38.7223)  # a coastal city just off the 1:50m coast
    assert 0.5 < lisbon <= 25.0 and world.locate(-9.1393, 38.7223) is None
    maafushi = world.distance_km("MDV", 73.4903, 3.9417)  # an atoll resort 10-25 km out
    assert 10.0 < maafushi <= 25.0
    aitutaki = world.distance_km("COK", -159.7833, -18.8567)  # an island the map omits entirely
    assert 100.0 < aitutaki <= 400.0
    assert world.nearest_units(-159.7833, -18.8567, 1)[0][0] == "COK"


def test_cli_ok_and_failure(
    capsys: pytest.CaptureFixture[str], tmp_path: Path, bank: dict[str, Any]
) -> None:
    assert vb.main([str(FIXTURE), str(WORLD)]) == 0
    assert "OK: 5 units, 15 destinations" in capsys.readouterr().out

    bank["countries"]["PRX"]["destinations"][0]["kind"] = "spa"
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(bank), encoding="utf-8")
    assert vb.main([str(broken), str(WORLD)]) == 1
    captured = capsys.readouterr()
    assert "kind 'spa'" in captured.out and "1 problem(s)" in captured.err


def test_cli_nearest(capsys: pytest.CaptureFixture[str]) -> None:
    assert vb.main(["--nearest", "38.7223", "-9.1393", str(WORLD), "-k", "2"]) == 0
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 2 and lines[0].startswith("PRX") and lines[1].startswith("ESP")


def test_unreadable_bank_is_a_problem_not_a_crash(tmp_path: Path) -> None:
    missing = vb.validate(tmp_path / "nope.json", WORLD)
    assert len(missing) == 1 and "cannot read" in missing[0]
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert "cannot read" in vb.validate(bad, WORLD)[0]


# ---------------------------------------------------------------------------------------------
# Schema negatives
# ---------------------------------------------------------------------------------------------


def _set(path: str, value: Any) -> Callable[[dict[str, Any]], None]:
    """Set ``path`` in the bank: dotted, integers index lists (``countries.PRX.destinations.0``)."""

    def apply(bank: dict[str, Any]) -> None:
        node: Any = bank
        *head, last = path.split(".")
        for part in head:
            node = node[int(part)] if isinstance(node, list) else node[part]
        if isinstance(node, list):
            node[int(last)] = value
        else:
            node[last] = value

    return apply


def _drop(path: str) -> Callable[[dict[str, Any]], None]:
    def apply(bank: dict[str, Any]) -> None:
        node: Any = bank
        *head, last = path.split(".")
        for part in head:
            node = node[int(part)] if isinstance(node, list) else node[part]
        del node[last]

    return apply


PRX0 = "countries.PRX.destinations.0"

SCHEMA_CASES: list[tuple[str, Callable[[dict[str, Any]], None], str]] = [
    ("version", _set("version", 2), "version must be 1"),
    ("version-bool", _set("version", True), "version must be 1"),
    ("generated-format", _set("generated", "27/10/2026"), "generated must be a YYYY-MM-DD"),
    ("generated-impossible", _set("generated", "2026-13-01"), "generated must be a YYYY-MM-DD"),
    ("generated-compact", _set("generated", "20261027"), "generated must be a YYYY-MM-DD"),
    ("top-level-unknown", _set("extra", 1), "unknown top-level key(s) 'extra'"),
    ("top-level-missing", _drop("generated"), "missing top-level key(s) 'generated'"),
    ("countries-not-object", _set("countries", []), "countries must be an object"),
    (
        "unknown-unit-id",
        _set("countries.XYZ", {"name": "X", "advice": None, "destinations": []}),
        "'XYZ' is not a unit id in the world map",
    ),
    (
        "lowercase-unit-id",
        _set("countries.prx", {"name": "X", "advice": None, "destinations": []}),
        "'prx' is not a unit id",
    ),
    (
        "unit-unknown-key",
        _set("countries.PRX.capital", "Lisbon"),
        "countries.PRX: unknown key(s) 'capital'",
    ),
    ("unit-missing-key", _drop("countries.PRX.advice"), "countries.PRX: missing key(s) 'advice'"),
    ("unit-name-empty", _set("countries.PRX.name", "  "), "name must be a non-empty string"),
    ("unit-name-long", _set("countries.PRX.name", "x" * 61), "name is 61 characters (max 60)"),
    ("advice-not-object", _set("countries.PRX.advice", "yes"), "advice must be null or an object"),
    (
        "advice-level",
        _set("countries.GRC.advice", {"level": "some", "checked": "2026-10-01"}),
        "advice.level must be 'against_all_travel'",
    ),
    (
        "advice-date",
        _set("countries.AFG.advice.checked", "yesterday"),
        "advice.checked must be a YYYY-MM-DD",
    ),
    (
        "advice-unknown-key",
        _set("countries.AFG.advice.note", "x"),
        "advice has unknown key(s) 'note'",
    ),
    (
        "destinations-not-list",
        _set("countries.PRX.destinations", {}),
        "destinations must be an array",
    ),
    ("destination-not-object", _set(PRX0, "Lisbon"), "must be an object"),
    ("destination-unknown-key", _set(f"{PRX0}.rating", 5), "unknown key(s) 'rating'"),
    ("destination-missing-key", _drop(f"{PRX0}.blurb"), "missing key(s) 'blurb'"),
    ("bad-kind", _set(f"{PRX0}.kind", "spa"), "kind 'spa' is not one of"),
    ("kind-not-string", _set(f"{PRX0}.kind", ["city"]), "is not one of"),
    ("name-empty", _set(f"{PRX0}.name", ""), "name must be a non-empty string"),
    ("name-long", _set(f"{PRX0}.name", "L" * 61), "name is 61 characters (max 60)"),
    ("region-empty", _set(f"{PRX0}.region", ""), "region must be a non-empty string"),
    ("region-long", _set(f"{PRX0}.region", "R" * 61), "region is 61 characters (max 60)"),
    ("blurb-long", _set(f"{PRX0}.blurb", "b" * 121), "blurb is 121 characters (max 120)"),
    ("blurb-markup", _set(f"{PRX0}.blurb", "A <b>bold</b> claim."), "blurb must be plain text"),
    ("blurb-newline", _set(f"{PRX0}.blurb", "Two\nlines."), "blurb must be plain text"),
    ("blurb-edge-space", _set(f"{PRX0}.blurb", " padded"), "blurb must be plain text"),
    ("lat-range", _set(f"{PRX0}.lat", 91), "lat must be a number in [-90, 90]"),
    ("lng-range", _set(f"{PRX0}.lng", -181), "lng must be a number in [-180, 180]"),
    ("lat-string", _set(f"{PRX0}.lat", "38.7"), "lat must be a number"),
    ("lat-bool", _set(f"{PRX0}.lat", True), "lat must be a number"),
    ("lng-nan", _set(f"{PRX0}.lng", float("nan")), "lng must be a number"),
    ("id-not-string", _set(f"{PRX0}.id", 7), "id must be a string"),
    (
        "slug-uppercase",
        _set(f"{PRX0}.id", "PRX.Lisbon"),
        "id must be <unitId>.<lowercase-kebab-slug>",
    ),
    ("slug-space", _set(f"{PRX0}.id", "PRX.lis bon"), "id must be <unitId>.<lowercase-kebab-slug>"),
    ("slug-double-hyphen", _set(f"{PRX0}.id", "PRX.lis--bon"), "id must be <unitId>"),
    ("slug-trailing-hyphen", _set(f"{PRX0}.id", "PRX.lisbon-"), "id must be <unitId>"),
    ("slug-non-ascii", _set(f"{PRX0}.id", "PRX.lisbão"), "id must be <unitId>"),
    ("slug-empty", _set(f"{PRX0}.id", "PRX."), "id must be <unitId>"),
    ("slug-no-dot", _set(f"{PRX0}.id", "lisbon"), "id must be <unitId>"),
    (
        "id-wrong-unit-prefix",
        _set(f"{PRX0}.id", "GRC.lisbon"),
        "id prefix 'GRC' does not match its unit 'PRX'",
    ),
    ("duplicate-id-in-unit", _set("countries.PRX.destinations.1.id", "PRX.lisbon"), "duplicate id"),
    (
        "duplicate-id-across-units",
        _set("countries.GRC.destinations.0.id", "PRX.lisbon"),
        "duplicate id",
    ),
    ("duplicate-name", _set("countries.PRX.destinations.1.name", "LISBON"), "already used in PRX"),
    (
        "duplicate-coordinates",
        lambda b: b["countries"]["PRX"]["destinations"][1].update(lat=38.7223, lng=-9.1393),
        "same coordinates as PRX.lisbon",
    ),
]


@pytest.mark.parametrize(
    ("label", "mutate", "expected"), SCHEMA_CASES, ids=[c[0] for c in SCHEMA_CASES]
)
def test_schema_negative(
    world: Any,
    bank: dict[str, Any],
    label: str,
    mutate: Callable[[dict[str, Any]], None],
    expected: str,
) -> None:
    mutate(bank)
    problems = _problems(bank, world)
    assert any(expected in p for p in problems), (label, problems)


def test_bank_must_be_an_object(world: Any) -> None:
    assert _problems([], world) == ["bank: top level must be an object"]


def test_too_many_destinations(world: Any, bank: dict[str, Any]) -> None:
    template = bank["countries"]["PRX"]["destinations"][0]
    bank["countries"]["PRX"]["destinations"] = [
        {**template, "id": f"PRX.spot-{i}", "name": f"Spot {i}", "lat": 38.70 + 0.01 * i}
        for i in range(11)
    ]
    assert any("11 destination(s); need 3-10" in p for p in _problems(bank, world))
    bank["countries"]["PRX"]["destinations"] = bank["countries"]["PRX"]["destinations"][:10]
    assert _problems(bank, world) == []


def test_empty_destinations_fail_even_for_a_small_unit(world: Any, bank: dict[str, Any]) -> None:
    bank["countries"]["MDV"]["destinations"] = []
    assert any("0 destination(s); need 1-10" in p for p in _problems(bank, world))


def test_three_destinations_unless_the_unit_is_small(world: Any, bank: dict[str, Any]) -> None:
    bank["countries"]["PRX"]["destinations"] = bank["countries"]["PRX"]["destinations"][:2]
    assert any("2 destination(s); need 3-10 for" in p for p in _problems(bank, world))
    # The Maldives (about 60 km2 on the map) is under the 1,000 km2 line: one destination is fine.
    bank["countries"]["PRX"]["destinations"] = copy.deepcopy(
        json.loads(FIXTURE.read_text(encoding="utf-8"))["countries"]["PRX"]["destinations"]
    )
    bank["countries"]["MDV"]["destinations"] = bank["countries"]["MDV"]["destinations"][:1]
    assert _problems(bank, world) == []
    assert world.units["MDV"].area_km2 < vb.SMALL_UNIT_KM2 < world.units["PRX"].area_km2


# ---------------------------------------------------------------------------------------------
# Geography
# ---------------------------------------------------------------------------------------------


def test_point_inside_a_different_unit_fails(world: Any) -> None:
    """Madrid is 244 km from Portugal, inside Spain: filed under Portugal it must fail."""
    assert 100.0 < world.distance_km("PRX", -3.7038, 40.4168) < vb.OFFSHORE_KM
    problems = _position_problems(world, "PRX", "Madrid", 40.4168, -3.7038)
    assert len(problems) == 1 and "ESP inside" in problems[0]
    assert _position_problems(world, "ESP", "Madrid", 40.4168, -3.7038) == []


def test_point_nearer_to_another_unit_fails(world: Any) -> None:
    """Open sea south of Malta: 160 km off Italy but 58 km off Malta, so it is not Italy's."""
    lat, lng = 35.30, 14.40
    to_italy = world.distance_km("ITA", lng, lat)
    assert 100.0 < to_italy < vb.OFFSHORE_KM
    assert world.nearest_units(lng, lat, 1)[0][0] == "MLT"
    problems = _position_problems(world, "ITA", "Sea South Of Malta", lat, lng)
    assert len(problems) == 1 and "MLT 58 km" in problems[0]
    # ... while the unit that IS nearest accepts it (the offshore rule).
    assert _position_problems(world, "MLT", "Sea South Of Malta", lat, lng) == []


@pytest.mark.parametrize(
    ("unit", "name", "lat", "lng", "min_km"),
    [
        ("SYC", "Praslin", -4.3167, 55.7333, 25.0),
        ("TCA", "Grand Turk", 21.4675, -71.1389, 25.0),
        ("PMD", "Porto Santo", 33.0728, -16.3415, 25.0),
        ("VEN", "Los Roques", 11.85, -66.75, 100.0),
        ("COK", "Aitutaki", -18.8567, -159.7833, 200.0),
        ("BRA", "Fernando de Noronha", -3.8547, -32.4244, 300.0),
    ],
)
def test_offshore_island_whose_own_unit_is_nearest_passes(
    world: Any, unit: str, name: str, lat: float, lng: float, min_km: float
) -> None:
    km = world.distance_km(unit, lng, lat)
    assert min_km <= km <= vb.OFFSHORE_KM, "the point must sit beyond the 25 km tolerance"
    assert world.nearest_units(lng, lat, 1)[0][0] == unit
    assert _position_problems(world, unit, name, lat, lng) == []


@pytest.mark.parametrize(
    ("unit", "lat", "lng"),
    [
        ("BRA", 0.0, -30.0),  # mid-Atlantic, 837 km from Brazil and nobody else nearer
        ("MDV", -0.6, 73.15),  # Addu atoll: Maldivian, but 427 km from the map's Maldives
    ],
)
def test_beyond_400_km_fails_even_when_the_unit_is_nearest(
    world: Any, unit: str, lat: float, lng: float
) -> None:
    assert world.nearest_units(lng, lat, 1)[0][0] == unit
    assert world.distance_km(unit, lng, lat) > vb.OFFSHORE_KM
    problems = _position_problems(world, unit, "Far Away", lat, lng)
    assert len(problems) == 1 and "within 400 km when" in problems[0]


def test_rule_constants() -> None:
    assert vb.TOLERANCE_KM == 25.0
    assert vb.OFFSHORE_KM == 400.0


def test_a_unit_that_touches_a_pole_is_never_accepted(world: Any) -> None:
    assert world.units["ATA"].polar
    assert [u for u, unit in world.units.items() if unit.polar] == ["ATA"]
    # Its coast winds round the pole: the polar cap is inside, the sea off the coast is not.
    assert world.contains("ATA", 0.0, -80.0) and world.contains("ATA", 100.0, -89.5)
    assert not world.contains("ATA", 0.0, -55.0)
    assert world.nearest_units(100.0, -89.5, 1) == [("ATA", 0.0)]
    assert 11e6 < world.units["ATA"].area_km2 < 15e6
    problems = _position_problems(world, "ATA", "South Pole Station", -80.0, 0.0)
    assert len(problems) == 1 and "touches a pole" in problems[0]


def test_micro_state_enclave_is_accepted_by_the_tolerance(world: Any) -> None:
    """The map draws the real Vatican inside Italy, about a kilometre from its own polygon."""
    assert world.locate(12.4539, 41.9022) == "ITA"
    assert 0.0 < world.distance_km("VAT", 12.4539, 41.9022) <= vb.TOLERANCE_KM
    assert _position_problems(world, "VAT", "Vatican City", 41.9022, 12.4539) == []


# ---------------------------------------------------------------------------------------------
# World helpers
# ---------------------------------------------------------------------------------------------


def test_nearest_units_default_world_and_ordering() -> None:
    near = vb.nearest_units(-9.1393, 38.7223, 3)  # Lisbon, against the committed map
    assert [u for u, _ in near] == ["PRX", "ESP", "MAR"]
    assert 0.5 < near[0][1] < 5.0 and near[0][1] < near[1][1] < near[2][1]
    assert vb.nearest_units(23.7275, 37.9838, 1) == [("GRC", 0.0)]
    assert vb.nearest_units(0.0, 0.0, 0) == []


def test_nearest_units_of_a_point_inside_comes_first(world: Any) -> None:
    result = world.nearest_units(-3.7038, 40.4168, 2)  # Madrid
    assert result[0] == ("ESP", 0.0) and result[1][0] == "PRX"
    assert 200.0 < result[1][1] < 300.0


def test_locate_resolves_the_split_units(world: Any) -> None:
    assert world.locate(2.35, 48.85) == "FXX"  # Paris
    assert world.locate(-0.12, 51.5) == "ENG"  # London
    assert world.locate(-3.19, 55.95) == "SCT"  # Edinburgh
    assert world.locate(-3.18, 51.48) == "WLS"  # Cardiff
    assert world.locate(-5.93, 54.6) == "NIR"  # Belfast
    assert world.locate(-16.92, 32.67) == "PMD"  # Funchal
    assert world.locate(55.45, -21.1) == "REU"  # Saint-Denis area
    assert world.locate(39.2, -6.16) == "TZZ"  # Zanzibar
    assert world.locate(15.63, 78.22) == "NSV"  # Longyearbyen
    assert world.locate(-30.0, 0.0) is None  # mid-Atlantic


def test_distance_wraps_around_the_antimeridian(world: Any) -> None:
    # Taveuni, Fiji lies at 179.99E; a point just east of 180 must still measure to Fiji.
    west = world.distance_km("FJI", 179.9, -16.9)
    east = world.distance_km("FJI", -179.9, -16.9)
    assert west < 25.0 and east < 25.0


# ---------------------------------------------------------------------------------------------
# The committed world map (build_world.mjs output)
# ---------------------------------------------------------------------------------------------


def _ring_area(ring: tuple[tuple[float, float], ...]) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:], strict=False):
        s += x0 * y1 - x1 * y0
    return s / 2


def _arc_vertices(topo: dict[str, Any], obj: str) -> int:
    used: set[int] = set()

    def visit(node: Any) -> None:
        if isinstance(node, int):
            used.add(~node if node < 0 else node)
        else:
            for child in node:
                visit(child)

    for geom in topo["objects"][obj]["geometries"]:
        visit(geom["arcs"])
    return sum(len(topo["arcs"][i]) for i in used)


def test_world_file_size_and_vertex_budgets() -> None:
    assert WORLD.stat().st_size <= 600 * 1000
    topo = json.loads(WORLD.read_text(encoding="utf-8"))
    assert set(topo["objects"]) == {"detail", "coarse"}
    coarse, detail = _arc_vertices(topo, "coarse"), _arc_vertices(topo, "detail")
    assert coarse <= 12_000 and detail > 3 * coarse


def test_world_has_256_units_with_the_same_ids_in_both_objects(world: Any) -> None:
    coarse = vb.load_world(WORLD, "coarse")
    assert len(world.units) == len(coarse.units) == 256
    assert sorted(world.units) == sorted(coarse.units)
    assert all(re.fullmatch(r"[A-Z0-9]{3}", uid) for uid in world.units)
    assert SPLIT_UNIT_IDS <= set(world.units)
    # the pieces that replaced their parents: no FRA / GBR; PRX is mainland Portugal
    assert {"FRA", "PRT", "GBR"}.isdisjoint(world.units)
    assert all(world.units[uid].name for uid in world.units)


@pytest.mark.parametrize("obj", ["detail", "coarse"])
def test_every_unit_keeps_a_real_polygon_in_both_objects(obj: str) -> None:
    loaded = vb.load_world(WORLD, obj)
    for uid, unit in loaded.units.items():
        assert unit.polygons, uid
        real = 0
        for poly in unit.polygons:
            for ring in poly.rings:
                assert ring[0] == ring[-1] and len(ring) >= 4, (obj, uid)
            exterior = poly.rings[0]
            if len({p for p in exterior[:-1]}) >= 3 and _ring_area(exterior) != 0:
                real += 1
        assert real >= 1, (obj, uid)
    for uid in MICRO_STATES:
        assert uid in loaded.units


@pytest.mark.parametrize("obj", ["detail", "coarse"])
def test_rings_follow_the_d3_winding(obj: str) -> None:
    """Exterior rings clockwise, holes anticlockwise (lng/lat, y up): what d3-geo needs."""
    loaded = vb.load_world(WORLD, obj)
    for uid, unit in loaded.units.items():
        for poly in unit.polygons:
            for i, ring in enumerate(poly.rings):
                area = _ring_area(ring)
                assert (area < 0) == (i == 0) and area != 0, (obj, uid, i)


def test_detail_keeps_every_natural_earth_polygon(world: Any) -> None:
    """1,622 parts in Natural Earth 1:50m; the map the validator measures against drops none."""
    assert sum(len(u.polygons) for u in world.units.values()) == 1622
    assert len(world.units["GRC"].polygons) >= 38  # the Aegean islands are there
    assert len(world.units["MDV"].polygons) == 2


def test_centres_are_aligned_with_parts_and_lie_inside_them(world: Any) -> None:
    assert sorted(world.centres) == sorted(world.units)
    for uid, unit in world.units.items():
        centres = world.centres[uid]
        assert len(centres) == len(unit.polygons), uid
        for (lng, lat), poly in zip(centres, unit.polygons, strict=True):
            assert poly.contains(lng, lat), (uid, lng, lat)
            assert round(lng, 4) == lng and round(lat, 4) == lat


def test_units_json_matches_the_map(world: Any) -> None:
    rows = json.loads(UNITS.read_text(encoding="utf-8"))
    assert [r["id"] for r in rows] == sorted(world.units)
    assert all(set(r) == {"id", "name", "sovereign", "subregion"} for r in rows)
    by_id = {r["id"]: r for r in rows}
    assert by_id["PRX"]["name"] == world.units["PRX"].name == "Portugal"
    assert by_id["ENG"]["sovereign"] == "United Kingdom"
    assert all(r["name"] and r["sovereign"] and r["subregion"] for r in rows)


# ---------------------------------------------------------------------------------------------
# The committed destination bank
# ---------------------------------------------------------------------------------------------


# INTEGRATION: the destination bank (wixy_server/livechat/adventure_destinations.json) is written
# by another builder. This test is skipped only while that file does not exist yet; the integrator
# removes the skipif so a missing or invalid bank becomes a failure from then on.
@pytest.mark.skipif(not REAL_BANK.exists(), reason="adventure_destinations.json is not written yet")
def test_committed_bank_is_valid_against_the_map() -> None:
    problems = vb.validate(REAL_BANK, WORLD)
    assert problems == [], "\n".join(problems[:60])
