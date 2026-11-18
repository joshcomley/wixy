"""Adventure Time game runtime (workspace 00056, spec/server-chat/08-adventure-time.md §3-§4): the
validation of a client's move and the wire shapes the server answers with.

There is ONE implementation of the geometry and the motion — the client's TypeScript. The client
that makes a move computes its consequence and posts it; the server validates the SHAPE and BOUNDS
(this module) and stores it once (`LiveChatStore`), and every other client replays the stored
values. The server enforces consistency (one outcome, stored once, replayed everywhere), not
anti-cheating: this is a game between two trusted people (Inv 40's trust model).

`adventure_view_json` is the one place a round leaves the store as the `GET /adventure/{seq}` view.
Names are resolved from the destination bank (the round stores ids only), and `serverNow` lets a
client keep a clock offset so two screens agree on every roulette.
"""

from __future__ import annotations

import json
import math
from collections.abc import Collection, Sequence
from dataclasses import dataclass

from builder.jsontypes import JsonObject, JsonValue
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.models import (
    AdventureLanding,
    AdventureRoundRow,
    AdventureSpin,
    AttachmentRow,
    MediaUrlSigner,
)

# §3.1: a spin's committed consequence.
SPIN_MIN_DELTA_DEG = 720.0
SPIN_MAX_DELTA_DEG = 3960.0  # the flick's own 3600 plus the client's random extra of under one turn
SPIN_MIN_DURATION_MS = 3500.0
SPIN_MAX_DURATION_MS = 7000.0
SPIN_MAX_ABS_FROM_DEG = 1e6
# §3.2: where the second spin landed and who is near it.
MIN_CANDIDATES = 1
MAX_CANDIDATES = 10
# §3.5: a live trail frame.
LIVE_MAX_POINTS = 32
LIVE_MAX_ABS_XY = 3.0
LIVE_MAX_T_MS = 600_000.0
LIVE_MAX_ABS_ROTATION_DEG = 1e6
LIVE_CLIENT_ID_MIN = 8
LIVE_CLIENT_ID_MAX = 64
ADVENTURE_LIVE_EVENT = "adventure_live"
ADVENTURE_LIVE_BATCHES_PER_SECOND = 30
"""§4.2: the live trail's own budget, the same 30 a second as drawing live (but its own limiter)."""

MAX_CHOICE_ID_CHARS = 64


def _num(value: object) -> float | None:
    """`value` as a float when it is a finite JSON number (never a bool), else `None`."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _coordinate(name: str, value: object) -> tuple[float, float] | str:
    """A `[lng, lat]` pair in degrees (the d3-geo convention), or the 422 detail."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return f"{name} must be a [lng, lat] pair"
    lng = _num(value[0])
    lat = _num(value[1])
    if lng is None or lat is None:
        return f"{name} must be a [lng, lat] pair of finite numbers"
    if not (-180.0 <= lng <= 180.0) or not (-90.0 <= lat <= 90.0):
        return f"{name} must have lng within -180..180 and lat within -90..90"
    return lng, lat


@dataclass(frozen=True, slots=True)
class ParsedSpin:
    """A spin request that passed every §3.1/§3.2 bound. `landing` and `candidates` are set for a
    `lat` spin only."""

    from_deg: float
    delta_deg: float
    duration_ms: float
    landing: AdventureLanding | None
    candidates: tuple[str, ...] | None


def parse_spin(
    *,
    axis: str,
    from_deg: object,
    delta_deg: object,
    duration_ms: object,
    result: object,
    bank: AdventureBank,
    include_advised: bool = False,
) -> ParsedSpin | str:
    """Validate a spin request (`POST /adventure/{seq}/spin`). Returns the typed spin or the 422
    `detail` string.

    §3.1: `720 <= |delta| <= 3960`, `3500 <= durationMs <= 7000`, `from` finite with
    `|from| <= 1e6`. `result` is REQUIRED for the `lat` spin and REFUSED for `lng`; it carries
    `{point, sea, land, centre, landUnit, candidates}` (§3.2): each point `[lng, lat]` in range,
    `sea` a boolean, `landUnit` and 1-10 unique `candidates` all playable bank units (a unit
    under a whole-country "advise against all travel" is playable only while the couple's shared
    `include_advised` preference is on), and `landUnit` among the candidates."""
    if axis not in ("lng", "lat"):
        return "axis must be lng or lat"
    parsed_from = _num(from_deg)
    if parsed_from is None or abs(parsed_from) > SPIN_MAX_ABS_FROM_DEG:
        return f"from must be a finite number within ±{SPIN_MAX_ABS_FROM_DEG:.0f}"
    parsed_delta = _num(delta_deg)
    if parsed_delta is None or not (SPIN_MIN_DELTA_DEG <= abs(parsed_delta) <= SPIN_MAX_DELTA_DEG):
        return f"|delta| must be {SPIN_MIN_DELTA_DEG:.0f}-{SPIN_MAX_DELTA_DEG:.0f} degrees"
    parsed_duration = _num(duration_ms)
    if parsed_duration is None or not (
        SPIN_MIN_DURATION_MS <= parsed_duration <= SPIN_MAX_DURATION_MS
    ):
        return f"durationMs must be {SPIN_MIN_DURATION_MS:.0f}-{SPIN_MAX_DURATION_MS:.0f}"

    if axis == "lng":
        if result is not None:
            return "result is only sent with the lat spin"
        return ParsedSpin(parsed_from, parsed_delta, parsed_duration, None, None)

    if not isinstance(result, dict):
        return "the lat spin needs a result"
    unknown = result.keys() - {"point", "sea", "land", "centre", "landUnit", "candidates"}
    if unknown:
        return f"result has unknown keys {sorted(unknown)}"
    point = _coordinate("result.point", result.get("point"))
    if isinstance(point, str):
        return point
    land = _coordinate("result.land", result.get("land"))
    if isinstance(land, str):
        return land
    centre = _coordinate("result.centre", result.get("centre"))
    if isinstance(centre, str):
        return centre
    sea = result.get("sea")
    if not isinstance(sea, bool):
        return "result.sea must be a boolean"
    land_unit = result.get("landUnit")
    candidates_raw = result.get("candidates")
    if not isinstance(land_unit, str) or not bank.is_playable(
        land_unit, include_advised=include_advised
    ):
        return "result.landUnit is not a unit in the destination bank"
    if (
        not isinstance(candidates_raw, list)
        or not (MIN_CANDIDATES <= len(candidates_raw) <= MAX_CANDIDATES)
        or not all(isinstance(c, str) for c in candidates_raw)
    ):
        return f"result.candidates must be {MIN_CANDIDATES}-{MAX_CANDIDATES} unit ids"
    candidates = tuple(candidates_raw)
    if len(set(candidates)) != len(candidates):
        return "result.candidates must be unique"
    if not all(bank.is_playable(c, include_advised=include_advised) for c in candidates):
        return "result.candidates must all be units in the destination bank"
    if land_unit not in candidates:
        return "result.landUnit must be one of the candidates"
    landing = AdventureLanding(point=point, sea=sea, land=land, centre=centre, land_unit=land_unit)
    return ParsedSpin(parsed_from, parsed_delta, parsed_duration, landing, candidates)


def parse_live_frame(
    *,
    anchor_seq: int,
    client_id: str,
    axis: str,
    rotation: Sequence[object],
    points: Sequence[Sequence[object]],
    frame: int,
    max_anchor_seq: int,
    max_frame: int,
) -> JsonObject | str:
    """Validate a live trail frame (`POST /adventure/live`, §3.5) and return the relayed frame
    (`{anchorSeq, clientId, axis, rotation, points, frame, end}` minus `end`, which the caller
    adds) or the 422 `detail`. Every field is copied into up to 64 queued frames per open stream,
    so each is bounded: ids 8-64 characters, `anchorSeq` a real message seq, `frame` a sane
    counter, a finite rotation, at most 32 `[x, y, t]` points with `|x|,|y| <= 3` (globe-radius
    units) and `0 <= t <= 600000` (ms since the drag began)."""
    if not (LIVE_CLIENT_ID_MIN <= len(client_id) <= LIVE_CLIENT_ID_MAX):
        return f"clientId must be {LIVE_CLIENT_ID_MIN}-{LIVE_CLIENT_ID_MAX} characters"
    if not (1 <= anchor_seq <= max_anchor_seq):
        return "anchorSeq must be a message seq"
    if not (0 <= frame <= max_frame):
        return f"frame must be 0-{max_frame}"
    if axis not in ("lng", "lat"):
        return "axis must be lng or lat"
    lam = _num(rotation[0]) if len(rotation) == 2 else None
    phi = _num(rotation[1]) if len(rotation) == 2 else None
    if (
        lam is None
        or phi is None
        or abs(lam) > LIVE_MAX_ABS_ROTATION_DEG
        or abs(phi) > LIVE_MAX_ABS_ROTATION_DEG
    ):
        return "rotation must be a finite [lng, lat] pair"
    if len(points) > LIVE_MAX_POINTS:
        return f"at most {LIVE_MAX_POINTS} points per frame"
    clean_points: list[JsonValue] = []
    for point in points:
        x = _num(point[0]) if len(point) == 3 else None
        y = _num(point[1]) if len(point) == 3 else None
        t = _num(point[2]) if len(point) == 3 else None
        if x is None or y is None or t is None:
            return "each point must be a finite [x, y, t] triple"
        if abs(x) > LIVE_MAX_ABS_XY or abs(y) > LIVE_MAX_ABS_XY:
            return f"a point's x and y must be within ±{LIVE_MAX_ABS_XY:.0f}"
        if not (0.0 <= t <= LIVE_MAX_T_MS):
            return f"a point's t must be 0-{LIVE_MAX_T_MS:.0f} ms"
        clean_points.append([x, y, t])
    return {
        "anchorSeq": anchor_seq,
        "clientId": client_id,
        "axis": axis,
        "rotation": [lam, phi],
        "points": clean_points,
        "frame": frame,
    }


# -- the view --------------------------------------------------------------------------------


def _name_pair(bank: AdventureBank, unit_id: str) -> JsonObject:
    return {"id": unit_id, "name": bank.unit_name(unit_id)}


def _destinations_json(bank: AdventureBank, ids: Collection[str] | None) -> list[JsonValue]:
    """The `Dest` shapes for stored ids, in stored order. Ids are permanent and append-only, so an
    id the bank no longer holds (a retired build) is skipped rather than invented."""
    if not ids:
        return []
    out: list[JsonValue] = []
    for dest_id in ids:
        destination = bank.destination(dest_id)
        if destination is not None:
            out.append(destination.to_json())
    return out


def _destination_json(bank: AdventureBank, dest_id: str | None) -> JsonObject | None:
    if dest_id is None:
        return None
    destination = bank.destination(dest_id)
    return destination.to_json() if destination is not None else None


def settings_json(include_advised: bool, bank: AdventureBank) -> JsonObject:
    """`GET|PUT /adventure/settings` (operator decision #2113): the shared preference and the units
    it governs — those under a whole-country "advise against all travel", by name."""
    return {
        "includeAdvised": include_advised,
        "advisedUnits": [{"id": unit.id, "name": unit.name} for unit in bank.advised_units()],
    }


def pack_data(round_: AdventureRoundRow) -> JsonObject | None:
    """The stored holiday pack as a JSON object, or `None` (not ready, or unreadable)."""
    if round_.pack != "ready" or round_.pack_json is None:
        return None
    try:
        data = json.loads(round_.pack_json)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def pack_can_retry(round_: AdventureRoundRow, *, researcher_available: bool) -> bool:
    """Whether `POST /adventure/{seq}/pack/retry` would be accepted right now."""
    if round_.state not in ("chosen", "banked"):
        return False
    return round_.pack in ("failed", "unavailable") and researcher_available


def _spin_json(spin: AdventureSpin | None) -> JsonObject | None:
    return spin.to_json() if spin is not None else None


def pack_pictures(
    round_: AdventureRoundRow,
    attachments: Sequence[AttachmentRow],
    signer: MediaUrlSigner | None,
) -> tuple[bool, JsonObject]:
    """The holiday pack's pictures for the view (spec §4.3a): `(arriving, {hero, items})`.

    The round's stored slot map (`pictures_json`) names each picture by the ordinal of its ordinary
    photo attachment on the anchor message, with its credit, source page and caption. A `Picture`
    is `{thumbUrl, fullUrl, credit, page, caption | null}` built from that attachment's SIGNED media
    URLs — and only once the attachment is `ready` (a still-processing one is left out until its
    renditions exist; the round's `rev` moves when it finishes, so a client re-fetches). `hero` is
    the hero photos in order; `items` maps `"<section key>:<item index>"` to its picture.
    `arriving` is true while the pictures are not all there yet: the search is still running
    (`images = pending`) or a stored picture is still processing."""
    hero: list[tuple[int, JsonObject]] = []
    items: JsonObject = {}
    processing = False
    slots: list[object] = []
    if round_.pictures_json is not None and signer is not None:
        try:
            stored = json.loads(round_.pictures_json)
        except json.JSONDecodeError:
            stored = None
        raw_slots = stored.get("slots") if isinstance(stored, dict) else None
        slots = raw_slots if isinstance(raw_slots, list) else []
    by_ordinal = {a.ordinal: a for a in attachments if a.ordinal is not None}
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        key = slot.get("slot")
        ordinal = slot.get("ordinal")
        attachment = by_ordinal.get(ordinal) if isinstance(ordinal, int) else None
        if not isinstance(key, str) or attachment is None or signer is None:
            continue
        if attachment.status == "processing":
            processing = True
        if (
            attachment.status != "ready"
            or "thumb" not in attachment.renditions
            or "full" not in attachment.renditions
        ):
            continue
        caption = slot.get("caption")
        picture: JsonObject = {
            "thumbUrl": signer.url_for(attachment.id, "thumb"),
            "fullUrl": signer.url_for(attachment.id, "full"),
            "credit": slot.get("credit") if isinstance(slot.get("credit"), str) else "",
            "page": slot.get("page") if isinstance(slot.get("page"), str) else "",
            "caption": caption if isinstance(caption, str) and caption else None,
        }
        if key.startswith("hero:"):
            index = key.removeprefix("hero:")
            hero.append((int(index) if index.isdigit() else len(hero), picture))
        else:
            items[key] = picture
    hero.sort(key=lambda entry: entry[0])
    arriving = round_.images == "pending" or processing
    return arriving, {"hero": [picture for _, picture in hero], "items": items}


def adventure_view_json(
    round_: AdventureRoundRow,
    bank: AdventureBank,
    excluded: Collection[str],
    *,
    now: float,
    researcher_available: bool,
    include_advised: bool = False,
    attachments: Sequence[AttachmentRow] = (),
    signer: MediaUrlSigner | None = None,
) -> JsonObject:
    """The `GET /adventure/{seq}` body (spec §4.2). `eligible` (the units with at least one
    destination still in play, honouring the couple's shared `include_advised` preference at
    READ time) is listed only while the round is still spinning — afterwards the round's own
    candidates are what matter. `landing.landUnitName`, the candidate names and the
    destinations are resolved from the bank. Everything time-based is absolute epoch seconds on the
    server's clock; `serverNow` lets a client work out its offset."""
    landing: JsonObject | None = None
    if round_.landing is not None:
        landing = {
            **round_.landing.to_json(),
            "landUnitName": bank.unit_name(round_.landing.land_unit),
        }

    country: JsonObject | None = None
    if round_.country_candidates is not None:
        country = {
            "candidates": [_name_pair(bank, unit_id) for unit_id in round_.country_candidates],
            "seed": round_.country_seed,
            "rouletteAt": round_.country_roulette_at,
            "chosen": (
                _name_pair(bank, round_.country_id) if round_.country_id is not None else None
            ),
            "by": round_.country_by,
        }

    destination: JsonObject | None = None
    if round_.dest_candidates is not None:
        destination = {
            "candidates": _destinations_json(bank, round_.dest_candidates),
            "seed": round_.dest_seed,
            "rouletteAt": round_.dest_roulette_at,
            "chosen": _destination_json(bank, round_.destination_id),
            "by": round_.destination_by,
        }

    spinning = round_.state in ("spin_lng", "spin_lat")
    pack_error = round_.pack_error if round_.pack in ("failed", "unavailable") else None
    arriving, pictures = pack_pictures(round_, attachments, signer)
    return {
        "seq": round_.anchor_message_seq,
        "state": round_.state,
        "rev": round_.rev,
        "serverNow": now,
        "startedBy": round_.started_by,
        "eligible": (
            list(bank.eligible_units(excluded, include_advised=include_advised))
            if spinning
            else None
        ),
        "spins": {"lng": _spin_json(round_.spin_lng), "lat": _spin_json(round_.spin_lat)},
        "landing": landing,
        "country": country,
        "destination": destination,
        "pack": {
            "state": round_.pack,
            "data": pack_data(round_),
            "error": pack_error,
            "canRetry": pack_can_retry(round_, researcher_available=researcher_available),
            "images": "pending" if arriving else "done",
            "pictures": pictures,
        },
        "decidedBy": round_.decided_by,
    }


def bank_trip_json(round_: AdventureRoundRow, bank: AdventureBank) -> JsonObject | None:
    """One entry of `GET /adventure/bank`: a banked trip — its destination, its unit, the pack's
    headline once the research is in, and the pack's state. `None` when the destination is no
    longer in the bank (never expected — ids are permanent)."""
    destination = _destination_json(bank, round_.destination_id)
    if destination is None or round_.country_id is None:
        return None
    pack = pack_data(round_)
    headline = pack.get("headline") if pack is not None else None
    return {
        "seq": round_.anchor_message_seq,
        "unitId": round_.country_id,
        "unitName": bank.unit_name(round_.country_id),
        "destination": destination,
        "headline": headline if isinstance(headline, str) and headline else None,
        "pack": round_.pack,
    }
