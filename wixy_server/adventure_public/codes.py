"""The public destination bank and its short codes (spec/adventure-public/README.md §2.2-2.3).

Every bank destination gets a short, stable, lower-case code that names it in a link
(`https://<host>/d/<code>`). The code is computed server-side only, from the destination id alone:
the first 6 characters of the base32 form (alphabet `abcdefghijkmnpqrstuvwxyz23456789`, no `l`, `o`,
`0`, `1`) of `sha256(destination_id)`. Codes are stable for a destination id forever. Uniqueness is
asserted when the public bank is built, and a code in the wild never changes:

- `codes_pinned.json` (next to this module) pins the CURRENT code of every destination in the
  shipped bank. `build_public_bank` uses the pinned code for a pinned id, always;
- a destination that is not pinned (a newcomer in a bank update) gets its 6-character code, and if
  that equals any pinned code (even one whose destination has left the bank) or another
  newcomer's, ONLY the newcomer(s) lengthen to 8, then 10, 12 ... until nothing is shared
  (logged). A pinned destination is never made longer, so a saved link always names the place it
  named;
- a bank update therefore regenerates the table
  (`python -m wixy_server.adventure_public.pin_codes`), which only ever APPENDS the newcomers'
  codes; a test fails until it has been run.

`PublicBank` is also the `GET /api/bank` answer, rendered once at start: the destinations with their
codes, ETag and gzip included.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.livechat.adventure_bank import (
    AdventureBank,
    AdventureDestination,
    AdventureUnit,
)

_LOGGER = logging.getLogger(__name__)

CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
"""32 characters: `a-z` minus `l` and `o`, then `2-9`."""
CODE_LENGTH = 6
LONG_CODE_LENGTH = 8
MAX_CODE_LENGTH = 40
"""No code is ever longer than this (a collision that survives 8 characters lengthens in steps of
two up to here, which is never reached by a real bank)."""

PINNED_CODES_PATH = Path(__file__).parent / "codes_pinned.json"
"""destination id -> code, for every destination in the shipped bank (see the module docstring)."""

CodeFn = Callable[[str, int], str]


def short_code(destination_id: str, length: int = CODE_LENGTH) -> str:
    """The first `length` characters of the base32 (`CODE_ALPHABET`) form of
    `sha256(destination_id)`: every 5 bits of the digest, most significant first, pick one
    character."""
    if not (1 <= length <= MAX_CODE_LENGTH):
        raise ValueError(f"a code is 1-{MAX_CODE_LENGTH} characters, not {length}")
    digest = int.from_bytes(hashlib.sha256(destination_id.encode("utf-8")).digest(), "big")
    return "".join(CODE_ALPHABET[(digest >> (251 - 5 * i)) & 31] for i in range(length))


def is_code(value: str) -> bool:
    """Whether `value` is shaped like a code (the alphabet, 6-40 characters). Shape only: whether
    it names a destination is `PublicBank.by_code`."""
    return CODE_LENGTH <= len(value) <= MAX_CODE_LENGTH and all(
        char in CODE_ALPHABET for char in value
    )


def load_pinned_codes(path: Path = PINNED_CODES_PATH) -> dict[str, str]:
    """The committed pin table: `{destination id: code}`. A missing file is an empty table; a table
    that is not an object of well-shaped codes, or that gives two destinations one code, is refused
    (a corrupt pin table must stop the server starting, not quietly renumber links)."""
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path.name} must be a JSON object of destination id -> code")
    pinned: dict[str, str] = {}
    for dest_id, code in raw.items():
        if not isinstance(dest_id, str) or not isinstance(code, str) or not is_code(code):
            raise ValueError(f"{path.name}: {dest_id!r} is not pinned to a well-formed code")
        pinned[dest_id] = code
    if len(set(pinned.values())) != len(pinned):
        raise ValueError(f"{path.name}: two destinations are pinned to one code")
    return pinned


def assign_codes(
    destination_ids: list[str],
    *,
    code_fn: CodeFn = short_code,
    pinned: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """`{destination id: code}` for every id. A pinned id keeps its pinned code, always. Every other
    id (a newcomer) gets its 6-character code; a newcomer whose code is already a pinned code (of
    any destination, in the bank or not) or another newcomer's is lengthened to 8 (then, were it
    to clash again, in steps of two) until it is unique, and the lengthening is logged. Only
    newcomers move."""
    pins: Mapping[str, str] = pinned if pinned is not None else {}
    reserved = set(pins.values())
    codes: dict[str, str] = {}
    newcomers: list[str] = []
    for dest_id in destination_ids:
        pinned_code = pins.get(dest_id)
        if pinned_code is not None:
            codes[dest_id] = pinned_code
        else:
            newcomers.append(dest_id)
            codes[dest_id] = code_fn(dest_id, CODE_LENGTH)
    length = CODE_LENGTH
    colliding = _colliding_newcomers(codes, newcomers, reserved)
    while colliding:
        length = LONG_CODE_LENGTH if length == CODE_LENGTH else length + 2
        if length > MAX_CODE_LENGTH:
            raise ValueError(f"destinations {sorted(colliding)} share a code of every length")
        _LOGGER.warning(
            "adventure public: %d new destinations share a short code; lengthening them to %d: %s",
            len(colliding),
            length,
            sorted(colliding),
        )
        for dest_id in colliding:
            codes[dest_id] = code_fn(dest_id, length)
        colliding = _colliding_newcomers(codes, newcomers, reserved)
    return codes


def _colliding_newcomers(
    codes: Mapping[str, str], newcomers: list[str], reserved: set[str]
) -> set[str]:
    """The newcomers whose code is a pinned one or is shared with another newcomer."""
    owners: dict[str, list[str]] = defaultdict(list)
    for dest_id in newcomers:
        owners[codes[dest_id]].append(dest_id)
    return {
        dest_id
        for code, ids in owners.items()
        if code in reserved or len(ids) > 1
        for dest_id in ids
    }


@dataclass(frozen=True, slots=True)
class PublicDestination:
    unit: AdventureUnit
    destination: AdventureDestination
    code: str


@dataclass(frozen=True, slots=True)
class PublicBank:
    """The bank as the public game serves it: the source `AdventureBank`, a code for every
    destination, the lookup both ways and the rendered `GET /api/bank` body."""

    bank: AdventureBank
    codes: Mapping[str, str]
    """destination id -> code."""
    by_code: Mapping[str, PublicDestination]
    body: bytes = field(repr=False)
    gzipped: bytes = field(repr=False)
    etag: str
    """The strong ETag of `body` (the gzip form's is `gzip_etag`)."""

    @property
    def gzip_etag(self) -> str:
        return self.etag[:-1] + '-gzip"'

    def code_of(self, destination_id: str) -> str | None:
        return self.codes.get(destination_id)

    def lookup(self, code: str) -> PublicDestination | None:
        return self.by_code.get(code) if is_code(code) else None


def _unit_json(unit: AdventureUnit, codes: Mapping[str, str]) -> JsonObject:
    advice: JsonValue = (
        {"level": unit.advice_level, "checked": unit.advice_checked} if unit.advised else None
    )
    destinations: list[JsonValue] = [
        {
            "id": d.id,
            "code": codes[d.id],
            "name": d.name,
            "region": d.region,
            "lat": d.lat,
            "lng": d.lng,
            "kind": d.kind,
            "blurb": d.blurb,
        }
        for d in unit.destinations
    ]
    return {"name": unit.name, "advice": advice, "destinations": destinations}


def build_public_bank(
    bank: AdventureBank,
    *,
    code_fn: CodeFn = short_code,
    pinned: Mapping[str, str] | None = None,
) -> PublicBank:
    """Assign every destination its code (the pinned one when it has one: `pinned` defaults to the
    committed `codes_pinned.json`) and render the `GET /api/bank` body:
    `{version, countries: {<unit id>: {name, advice, destinations: [{id, code, name, region, lat,
    lng, kind, blurb}]}}}`, destinations in rank order."""
    ids = [d.id for unit in bank.units.values() for d in unit.destinations]
    codes = assign_codes(
        ids, code_fn=code_fn, pinned=load_pinned_codes() if pinned is None else pinned
    )
    by_code: dict[str, PublicDestination] = {}
    for unit in bank.units.values():
        for destination in unit.destinations:
            code = codes[destination.id]
            by_code[code] = PublicDestination(unit=unit, destination=destination, code=code)
    document: JsonObject = {
        "version": bank.version,
        "countries": {unit_id: _unit_json(unit, codes) for unit_id, unit in bank.units.items()},
    }
    body = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(body).hexdigest()[:24]
    return PublicBank(
        bank=bank,
        codes=codes,
        by_code=by_code,
        body=body,
        gzipped=gzip.compress(body, compresslevel=9, mtime=0),
        etag=f'"{digest}"',
    )
