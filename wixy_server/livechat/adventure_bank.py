"""The Adventure Time destination bank (workspace 00056, spec/server-chat/08-adventure-time §2.2).

The bank ships in the repo as `adventure_destinations.json` beside this module: for every map unit
(a country, or a piece of one such as Madeira or Scotland) the holiday destinations UK
holidaymakers love most, in RANK order. It is STATIC content, like the would-you-rather question
bank: it lives in the repo, not in `server.db`, and names nothing about anyone, so delete/wipe never
touch it. What the couple banked or turned down lives in `adv_rounds`/`adv_rejected` and is erased
with the chat (Inv 56).

`load_bank` is STRICT: a typo in a committed bank is a broken asset, so every key, bound and
identifier rule of §2.2 is checked and an unknown key is refused. `load_bank_or_empty` is what
`create_app` calls: a missing or malformed bank must not stop the whole app starting, so it logs
the reason and returns an empty bank (`POST /adventure` then answers 503 `game_unavailable`). CI's
`test_adventure_bank.py` keeps the shipped file honest.

Data and policy are kept apart: a unit under a UK FCDO "advise against all travel" for the whole
country carries `advice` in the data, and the couple's shared preference
`adv_settings.include_advised` (operator decision #2113: left out by default, and switchable)
decides whether such a unit may be drawn at all — the bank takes it as an `include_advised`
argument, so nothing here holds that policy.
"""

from __future__ import annotations

import datetime
import json
import logging
import math
import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from builder.jsontypes import JsonObject

_LOGGER = logging.getLogger(__name__)

BANK_PATH = Path(__file__).with_name("adventure_destinations.json")
BANK_VERSION = 1

ADVICE_LEVEL = "against_all_travel"
KINDS = frozenset(
    {
        "city",
        "beach",
        "island",
        "mountains",
        "countryside",
        "lakes",
        "nature",
        "historic",
        "resort",
        "wine",
    }
)
TOP_DESTINATIONS = 5
MAX_DESTINATIONS_PER_UNIT = 10
MIN_SPACING_KM = 40.0
"""Two destinations in one unit's top picks are at least this far apart (great-circle), or the
destination roulette would light overlapping dots (Peru: Machu Picchu, Cusco and the Sacred Valley
sit within ~75 km of each other)."""
_EARTH_RADIUS_KM = 6371.0088

_UNIT_ID_RE = re.compile(r"^[A-Z0-9]{3}$")
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_MAX_NAME = 80
_MAX_BLURB = 120
_MAX_SLUG = 60


def distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle (haversine) distance in kilometres between two points in degrees."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


class AdventureBankError(ValueError):
    """The destination bank does not satisfy the §2.2 schema. The message names the entry."""


@dataclass(frozen=True, slots=True)
class AdventureDestination:
    id: str
    name: str
    region: str
    lat: float
    lng: float
    kind: str
    blurb: str

    def to_json(self) -> JsonObject:
        """The `Dest` wire shape (spec §4.2)."""
        return {
            "id": self.id,
            "name": self.name,
            "region": self.region,
            "lat": self.lat,
            "lng": self.lng,
            "kind": self.kind,
            "blurb": self.blurb,
        }


@dataclass(frozen=True, slots=True)
class AdventureUnit:
    """One map unit with its destinations in rank order (most loved first)."""

    id: str
    name: str
    advice_level: str | None
    advice_checked: str | None
    destinations: tuple[AdventureDestination, ...]

    @property
    def advised(self) -> bool:
        return self.advice_level is not None


@dataclass(frozen=True, slots=True)
class AdventureBank:
    version: int
    generated: str
    units: Mapping[str, AdventureUnit]
    _destinations: Mapping[str, tuple[AdventureUnit, AdventureDestination]] = field(
        init=False, repr=False, compare=False
    )

    def __post_init__(self) -> None:
        index = {
            destination.id: (unit, destination)
            for unit in self.units.values()
            for destination in unit.destinations
        }
        object.__setattr__(self, "_destinations", index)

    @staticmethod
    def empty() -> AdventureBank:
        return AdventureBank(version=BANK_VERSION, generated="", units={})

    def unit(self, unit_id: str) -> AdventureUnit | None:
        return self.units.get(unit_id)

    def unit_name(self, unit_id: str) -> str:
        unit = self.units.get(unit_id)
        return unit.name if unit is not None else unit_id

    def destination(self, destination_id: str) -> AdventureDestination | None:
        found = self._destinations.get(destination_id)
        return found[1] if found is not None else None

    def unit_of(self, destination_id: str) -> AdventureUnit | None:
        found = self._destinations.get(destination_id)
        return found[0] if found is not None else None

    def is_playable(self, unit_id: str, *, include_advised: bool = False) -> bool:
        """A unit the game may land on at all: in the bank, and either not under a whole-country
        "advise against all travel" or the couple have switched those back in
        (`include_advised`, the shared preference — off by default)."""
        unit = self.units.get(unit_id)
        return unit is not None and (include_advised or not unit.advised)

    def advised_units(self) -> tuple[AdventureUnit, ...]:
        """The units carrying a whole-country "advise against all travel" mark, by name — what the
        Options sheet explains the switch with."""
        return tuple(
            sorted((u for u in self.units.values() if u.advised), key=lambda u: (u.name, u.id))
        )

    def remaining(
        self, unit_id: str, excluded: Collection[str] = ()
    ) -> tuple[AdventureDestination, ...]:
        """The unit's destinations still in play (bank minus `excluded`: rejected and banked ids),
        in rank order."""
        unit = self.units.get(unit_id)
        if unit is None:
            return ()
        return tuple(d for d in unit.destinations if d.id not in excluded)

    def top_destinations(
        self, unit_id: str, excluded: Collection[str] = (), n: int = TOP_DESTINATIONS
    ) -> tuple[AdventureDestination, ...]:
        """The unit's top `n` remaining destinations — what a country's destination roulette draws
        from — spaced so the roulette's dots never overlap: walk the remaining destinations in
        rank order and take one only if it is at least `MIN_SPACING_KM` (great-circle) from every
        one already taken, until `n`. When fewer than `n` qualify, the rest is filled from the
        skipped ones in rank order. A skipped destination is merely held back, never consumed: it
        is still remaining, so it comes round again once a pick is rejected or banked. The result
        is returned in rank order and always has `min(n, len(remaining))` entries."""
        remaining = self.remaining(unit_id, excluded)
        taken: list[int] = []
        skipped: list[int] = []
        for index, candidate in enumerate(remaining):
            if len(taken) == n:
                break
            if all(
                distance_km(candidate.lat, candidate.lng, remaining[t].lat, remaining[t].lng)
                >= MIN_SPACING_KM
                for t in taken
            ):
                taken.append(index)
            else:
                skipped.append(index)
        for index in skipped:
            if len(taken) == n:
                break
            taken.append(index)
        return tuple(remaining[index] for index in sorted(taken))

    def eligible_units(
        self, excluded: Collection[str] = (), *, include_advised: bool = False
    ) -> tuple[str, ...]:
        """Playable units with at least one remaining destination, by id (stable)."""
        return tuple(
            sorted(
                unit_id
                for unit_id in self.units
                if self.is_playable(unit_id, include_advised=include_advised)
                and self.remaining(unit_id, excluded)
            )
        )


# -- strict loading ----------------------------------------------------------------------------


def _expect_keys(where: str, data: Mapping[str, object], required: set[str]) -> None:
    missing = required - data.keys()
    extra = data.keys() - required
    if missing:
        raise AdventureBankError(f"{where}: missing keys {sorted(missing)}")
    if extra:
        raise AdventureBankError(f"{where}: unknown keys {sorted(extra)}")


def _text(where: str, value: object, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise AdventureBankError(f"{where}: must be a non-empty trimmed string")
    if len(value) > maximum:
        raise AdventureBankError(f"{where}: longer than {maximum} characters")
    if _CONTROL_RE.search(value):
        raise AdventureBankError(f"{where}: contains a control character")
    return value


def _number(where: str, value: object, *, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AdventureBankError(f"{where}: must be a number")
    number = float(value)
    if not math.isfinite(number) or not (low <= number <= high):
        raise AdventureBankError(f"{where}: must be within {low}..{high}")
    return number


def _date(where: str, value: object) -> str:
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise AdventureBankError(f"{where}: must be a YYYY-MM-DD date")
    try:
        datetime.date.fromisoformat(value)
    except ValueError as exc:
        raise AdventureBankError(f"{where}: not a real date") from exc
    return value


def _destination(unit_id: str, index: int, raw: object) -> AdventureDestination:
    where = f"unit {unit_id} destination #{index + 1}"
    if not isinstance(raw, dict):
        raise AdventureBankError(f"{where}: must be an object")
    _expect_keys(where, raw, {"id", "name", "region", "lat", "lng", "kind", "blurb"})
    dest_id = _text(f"{where} id", raw["id"], maximum=_MAX_SLUG + 4)
    prefix, dot, slug = dest_id.partition(".")
    if prefix != unit_id or dot != "." or not slug or not _SLUG_RE.fullmatch(slug):
        raise AdventureBankError(f"{where}: id {dest_id!r} must be '{unit_id}.<ascii-kebab-slug>'")
    if len(slug) > _MAX_SLUG:
        raise AdventureBankError(f"{where}: slug longer than {_MAX_SLUG} characters")
    kind = raw["kind"]
    if not isinstance(kind, str) or kind not in KINDS:
        raise AdventureBankError(f"{where}: kind must be one of {sorted(KINDS)}")
    return AdventureDestination(
        id=dest_id,
        name=_text(f"{where} name", raw["name"], maximum=_MAX_NAME),
        region=_text(f"{where} region", raw["region"], maximum=_MAX_NAME),
        lat=_number(f"{where} lat", raw["lat"], low=-90.0, high=90.0),
        lng=_number(f"{where} lng", raw["lng"], low=-180.0, high=180.0),
        kind=kind,
        blurb=_text(f"{where} blurb", raw["blurb"], maximum=_MAX_BLURB),
    )


def _unit(unit_id: str, raw: object) -> AdventureUnit:
    where = f"unit {unit_id}"
    if not _UNIT_ID_RE.fullmatch(unit_id):
        raise AdventureBankError(f"{where}: id must be three capital letters or digits")
    if not isinstance(raw, dict):
        raise AdventureBankError(f"{where}: must be an object")
    _expect_keys(where, raw, {"name", "advice", "destinations"})
    advice = raw["advice"]
    advice_level: str | None = None
    advice_checked: str | None = None
    if advice is not None:
        if not isinstance(advice, dict):
            raise AdventureBankError(f"{where} advice: must be null or an object")
        _expect_keys(f"{where} advice", advice, {"level", "checked"})
        if advice["level"] != ADVICE_LEVEL:
            raise AdventureBankError(f"{where} advice: level must be {ADVICE_LEVEL!r}")
        advice_level = ADVICE_LEVEL
        advice_checked = _date(f"{where} advice checked", advice["checked"])
    destinations_raw = raw["destinations"]
    if not isinstance(destinations_raw, list) or not (
        1 <= len(destinations_raw) <= MAX_DESTINATIONS_PER_UNIT
    ):
        raise AdventureBankError(
            f"{where}: destinations must be a list of 1-{MAX_DESTINATIONS_PER_UNIT}"
        )
    destinations = tuple(_destination(unit_id, i, d) for i, d in enumerate(destinations_raw))
    return AdventureUnit(
        id=unit_id,
        name=_text(f"{where} name", raw["name"], maximum=_MAX_NAME),
        advice_level=advice_level,
        advice_checked=advice_checked,
        destinations=destinations,
    )


def parse_bank(raw: object) -> AdventureBank:
    """Validate an already-decoded bank document (the §2.2 schema) and build the typed bank."""
    if not isinstance(raw, dict):
        raise AdventureBankError("the bank must be a JSON object")
    _expect_keys("bank", raw, {"version", "generated", "countries"})
    if raw["version"] != BANK_VERSION or isinstance(raw["version"], bool):
        raise AdventureBankError(f"bank version must be {BANK_VERSION}")
    generated = _date("bank generated", raw["generated"])
    countries = raw["countries"]
    if not isinstance(countries, dict) or not countries:
        raise AdventureBankError("bank countries must be a non-empty object")
    units: dict[str, AdventureUnit] = {}
    seen: set[str] = set()
    for unit_id, unit_raw in countries.items():
        unit = _unit(str(unit_id), unit_raw)
        for destination in unit.destinations:
            if destination.id in seen:
                raise AdventureBankError(f"duplicate destination id {destination.id!r}")
            seen.add(destination.id)
        units[unit.id] = unit
    return AdventureBank(version=BANK_VERSION, generated=generated, units=units)


def load_bank(path: Path = BANK_PATH) -> AdventureBank:
    """Load and strictly validate the bank at `path`; raises `AdventureBankError`."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AdventureBankError(f"cannot read the bank {path}: {exc}") from exc
    return parse_bank(raw)


def load_bank_or_empty(path: Path = BANK_PATH) -> AdventureBank:
    """What `create_app` uses: a broken bank is logged and replaced by an empty one so the rest of
    the app (and the rest of Server chat) still starts; the game then answers 503
    `game_unavailable`."""
    try:
        return load_bank(path)
    except AdventureBankError:
        _LOGGER.exception("Adventure Time destination bank unusable — the game is DISABLED")
        return AdventureBank.empty()
