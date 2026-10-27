#!/usr/bin/env python3
"""Adventure Time destination-bank validator (spec/server-chat/08-adventure-time.md section 2.2).

Stdlib only, fully typed (``mypy --strict`` clean). Used three ways:

* CLI    ``python tooling/adventure/validate_bank.py <bank.json> <world.json>``
         prints one problem per line and exits 1 if there are any.
* CLI    ``python tooling/adventure/validate_bank.py --nearest LAT LNG [world.json]``
         shows which units are closest to a point ("Lisbon is 4 km from PRX").
* import ``validate(bank_path, world_path) -> list[str]`` (empty list = valid), used by
         ``wixy_server/tests/test_adventure_bank.py``; also ``World``, ``nearest_units``.

What it checks
--------------
Bank schema (spec 2.2, exactly; any unknown key is a problem):

* top level ``{version: 1, generated: "YYYY-MM-DD", countries: {...}}``;
* ``countries`` keys are unit ids that exist in the world map;
* each unit ``{name, advice, destinations}``: ``name`` non-empty string <= 60 chars; ``advice`` is
  ``null`` or ``{level: "against_all_travel", checked: "YYYY-MM-DD"}``; 1-10 destinations, and at
  least 2 unless the unit is *small* (see ``SMALL_UNIT_KM2``);
* each destination ``{id, name, region, lat, lng, kind, blurb}``: ``id`` is
  ``<unitId>.<ascii lowercase kebab slug>`` with the unit id of the entry it sits in and is unique
  bank-wide; ``name`` and ``region`` non-empty <= 60 chars; names are unique within a unit;
  ``lat``/``lng`` real numbers in range; ``kind`` is one of ``KINDS``; ``blurb`` is non-empty
  plain text <= 120 chars (no markup, no control characters).

Geography: a destination point is accepted when ANY of these holds (``d`` is the distance from the
point to the boundary of the unit it is filed under in the ``detail`` geometry, 0 if inside it):

1. it lies inside its unit (``d == 0``);
2. it is within ``TOLERANCE_KM`` (25 km) of that boundary (coastal resorts, islands that fall just
   off the simplified 1:50m coastline, enclave micro-states drawn a kilometre out);
3. it is within ``OFFSHORE_KM`` (400 km) of that boundary AND its own unit is the NEAREST of all
   the units in the map (inside counts as nearest, distance 0). Natural Earth 50m omits many small
   holiday islands (Praslin, the Maldives' atolls, Fernando de Noronha, Los Roques, Grand Turk,
   Porto Santo, Aitutaki...); this keeps them valid without letting a mis-filed point through.

A point that is inside, or nearer to, a DIFFERENT unit therefore fails rule 3 (the wrong-country
check this validator exists for); the only slack beyond that is rule 2's 25 km around the point's
own unit, which exists for coastline rounding and enclaves (the Vatican's Natural Earth polygon is
about a kilometre from the real Vatican, which the map draws inside Italy). A unit whose polygon
runs round a pole (Antarctica) is never accepted: it is uninhabited and must be absent from the
bank.

Geometry notes
--------------
The world file is the TopoJSON written by ``build_world.mjs``. Natural Earth already splits
polygons at +-180 degrees, so a ring never crosses the antimeridian; the one exception is
Antarctica's coast, which winds round the south pole (its edge from +180 to -180 is a short hop
across the antimeridian) and is tested with a meridian cast towards the pole instead. Otherwise
"inside" is an even-odd ray cast in lng/lat across all the rings of a polygon (holes are enclaves
such as Lesotho), and the
distance to a boundary is a point-to-segment distance on a local equirectangular plane centred on
the query point (east-west offsets wrapped to +-180 degrees and scaled by the cosine of the mean
latitude), which is accurate to well under a kilometre at the 25 km tolerance and to about 1% out
to the 400 km offshore rule (the nearest-unit test is what matters there, not the last km).
"""

import argparse
import datetime
import functools
import json
import math
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeGuard

Point = tuple[float, float]  # (lng, lat), degrees
Ring = tuple[Point, ...]
BBox = tuple[float, float, float, float]  # (min_lng, min_lat, max_lng, max_lat)

# ---------------------------------------------------------------------------------------------
# Rules (one place, so a change of policy is a one-line change)
# ---------------------------------------------------------------------------------------------

BANK_VERSION: Final = 1
KINDS: Final = frozenset(
    (
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
    )
)
ADVICE_LEVEL: Final = "against_all_travel"
MAX_NAME: Final = 60
MAX_REGION: Final = 60
MAX_BLURB: Final = 120
MIN_DESTINATIONS: Final = 2
MAX_DESTINATIONS: Final = 10
#: A unit whose land area (on the ``detail`` map) is below this may have a single destination
#: instead of 2 or more. (The floor is 2, not 3: a big country whose UK travel advice rules out most
#: of it - DR Congo, Chad - or a small one with few real holiday places - Kuwait - gets two honest
#: picks rather than padding; the writer brief says never pad with weak picks.) 1,000 km2 is
#: Malta-and-smaller: Vatican City, Monaco, San Marino, Liechtenstein, Malta, Singapore, Bahrain,
#: Andorra, Nauru, Tuvalu, the Maldives, Seychelles, Barbados, Antigua, St Kitts, Grenada,
#: St Lucia, St Vincent, Dominica... Luxembourg (2,586 km2) is held to 2.
SMALL_UNIT_KM2: Final = 1000.0
#: A destination may sit up to this far outside its unit's simplified boundary.
TOLERANCE_KM: Final = 25.0
#: Natural Earth 1:50m omits many small holiday islands (Praslin, the Maldives' atolls, Fernando
#: de Noronha, Los Roques, Grand Turk, Porto Santo, Aitutaki...). Such a destination may sit up to
#: this far from its unit's boundary PROVIDED its own unit is the nearest of all units (distance 0
#: when a point is inside one). A point inside, or nearer to, a different unit still fails.
OFFSHORE_KM: Final = 400.0

EARTH_RADIUS_KM: Final = 6371.0088
_KM_PER_DEG: Final = EARTH_RADIUS_KM * math.pi / 180.0
_HALF_RAD: Final = math.pi / 360.0  # degrees -> radians, halved (for a mean latitude)
_POLE_EPS: Final = 0.01  # Natural Earth stops 0.001 degrees short of the pole (-89.998926)
# (the simplified `detail` map drops those pole-line vertices; `Polygon.pole` is what finds ATA)

_DATE_RE: Final = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_UNIT_ID_RE: Final = re.compile(r"^[A-Z0-9]{3}$")
_SLUG_RE: Final = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_BANK_KEYS: Final = frozenset(("version", "generated", "countries"))
_UNIT_KEYS: Final = frozenset(("name", "advice", "destinations"))
_ADVICE_KEYS: Final = frozenset(("level", "checked"))
_DEST_KEYS: Final = frozenset(("id", "name", "region", "lat", "lng", "kind", "blurb"))

DEFAULT_WORLD: Final = (
    Path(__file__).resolve().parents[2] / "admin-ui" / "data" / "adventure-world.json"
)


# ---------------------------------------------------------------------------------------------
# World map: TopoJSON decoding
# ---------------------------------------------------------------------------------------------


class WorldError(ValueError):
    """The world file is not the TopoJSON this module understands."""


def _is_num(value: object) -> TypeGuard[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _need_dict(value: object, where: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise WorldError(f"{where}: expected an object")
    return value


def _need_list(value: object, where: str) -> list[object]:
    if not isinstance(value, list):
        raise WorldError(f"{where}: expected an array")
    return value


def _need_int(value: object, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise WorldError(f"{where}: expected an integer")
    return value


@dataclass(frozen=True, slots=True)
class Polygon:
    """One polygon part: ``rings[0]`` is the exterior, the rest are holes.

    ``pole`` is 0 for an ordinary polygon, or -1 / +1 when the exterior ring runs all the way
    round the south / north pole (Antarctica: its coast goes from -180 to +180 degrees and the
    interior is the polar cap). ``bbox`` then spans every longitude and reaches the pole.
    """

    rings: tuple[Ring, ...]
    bbox: BBox
    pole: int = 0

    def contains(self, lng: float, lat: float) -> bool:
        """Even-odd containment across the exterior and every hole."""
        return _polygon_contains(self, lng, lat)


@dataclass(frozen=True, slots=True)
class Unit:
    id: str
    name: str
    polygons: tuple[Polygon, ...]
    bbox: BBox
    area_km2: float
    polar: bool  # a polygon encircles, or a vertex sits on, a pole (Antarctica)


def _wrap(delta_lng: float) -> float:
    """Wrap a longitude difference into [-180, 180)."""
    return (delta_lng + 180.0) % 360.0 - 180.0


def _ring_area_km2(ring: Ring) -> float:
    """Spherical area enclosed by a ring (Chamberlain-Duquette), unsigned."""
    total = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:], strict=False):
        total += math.radians(_wrap(x1 - x0)) * (
            2.0 + math.sin(math.radians(y0)) + math.sin(math.radians(y1))
        )
    return abs(total) * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2.0


def _encircled_pole(ring: Ring) -> int:
    """-1 / +1 if the ring winds once round the south / north pole, else 0."""
    turned = sum(_wrap(b[0] - a[0]) for a, b in zip(ring, ring[1:], strict=False))
    if abs(turned) < 180.0:
        return 0
    return -1 if sum(p[1] for p in ring) < 0 else 1


def _bbox_of(ring: Ring) -> BBox:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def _union_bbox(boxes: Sequence[BBox]) -> BBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _decode_arcs(topo: dict[str, object]) -> list[list[Point]]:
    """Delta-decode every arc and apply the quantization transform (if any)."""
    kx = ky = 1.0
    dx = dy = 0.0
    raw_transform = topo.get("transform")
    if raw_transform is not None:
        transform = _need_dict(raw_transform, "transform")
        scale = _need_list(transform.get("scale"), "transform.scale")
        translate = _need_list(transform.get("translate"), "transform.translate")
        if len(scale) != 2 or len(translate) != 2:
            raise WorldError("transform: scale and translate need two numbers each")
        sx, sy, tx, ty = scale[0], scale[1], translate[0], translate[1]
        if not (_is_num(sx) and _is_num(sy) and _is_num(tx) and _is_num(ty)):
            raise WorldError("transform: scale and translate must be numbers")
        kx, ky, dx, dy = float(sx), float(sy), float(tx), float(ty)
    quantized = raw_transform is not None
    arcs: list[list[Point]] = []
    for ai, raw_arc in enumerate(_need_list(topo.get("arcs"), "arcs")):
        x = y = 0.0
        line: list[Point] = []
        for pi, raw_pt in enumerate(_need_list(raw_arc, f"arcs[{ai}]")):
            pt = _need_list(raw_pt, f"arcs[{ai}][{pi}]")
            if len(pt) < 2:
                raise WorldError(f"arcs[{ai}][{pi}]: expected [x, y]")
            px, py = pt[0], pt[1]
            if not (_is_num(px) and _is_num(py)):
                raise WorldError(f"arcs[{ai}][{pi}]: expected [x, y] numbers")
            if quantized:  # delta encoded
                x += px
                y += py
                line.append((x * kx + dx, y * ky + dy))
            else:
                line.append((float(px), float(py)))
        arcs.append(line)
    return arcs


def _stitch(arcs: list[list[Point]], refs: object, where: str) -> Ring:
    """Join arc references into one ring (a negative reference walks its arc backwards)."""
    points: list[Point] = []
    for raw in _need_list(refs, where):
        ref = _need_int(raw, where)
        index = ~ref if ref < 0 else ref
        if index >= len(arcs):
            raise WorldError(f"{where}: arc {ref} is out of range")
        arc = arcs[index][::-1] if ref < 0 else arcs[index]
        if points:
            points.pop()  # the joint point is the previous arc's last and this arc's first
        points.extend(arc)
    if len(points) < 4:
        raise WorldError(f"{where}: a ring needs at least 4 points")
    return tuple(points)


def _polygon(arcs: list[list[Point]], rings: object, where: str) -> Polygon:
    stitched = tuple(
        _stitch(arcs, ring, f"{where}[{i}]") for i, ring in enumerate(_need_list(rings, where))
    )
    if not stitched:
        raise WorldError(f"{where}: a polygon needs an exterior ring")
    exterior = stitched[0]
    pole = _encircled_pole(exterior)
    min_x, min_y, max_x, max_y = _bbox_of(exterior)
    if pole:
        bbox = (-180.0, -90.0, 180.0, max_y) if pole < 0 else (-180.0, min_y, 180.0, 90.0)
    else:
        bbox = (min_x, min_y, max_x, max_y)
    return Polygon(rings=stitched, bbox=bbox, pole=pole)


def _unit(arcs: list[list[Point]], geom: dict[str, object], where: str) -> Unit:
    uid = geom.get("id")
    if not isinstance(uid, str):
        raise WorldError(f"{where}: missing string id")
    kind = geom.get("type")
    polygons: tuple[Polygon, ...]
    if kind == "Polygon":
        polygons = (_polygon(arcs, geom.get("arcs"), f"{where}.arcs"),)
    elif kind == "MultiPolygon":
        polygons = tuple(
            _polygon(arcs, poly, f"{where}.arcs[{i}]")
            for i, poly in enumerate(_need_list(geom.get("arcs"), f"{where}.arcs"))
        )
    else:
        raise WorldError(f"{where}: unsupported geometry type {kind!r}")
    if not polygons:
        raise WorldError(f"{where}: no polygons")
    props = geom.get("properties")
    name = ""
    if isinstance(props, dict) and isinstance(props.get("name"), str):
        name = str(props["name"])
    area = sum(
        _ring_area_km2(p.rings[0]) - sum(_ring_area_km2(h) for h in p.rings[1:]) for p in polygons
    )
    polar = any(p.pole for p in polygons) or any(
        abs(abs(pt[1]) - 90.0) < _POLE_EPS for p in polygons for pt in p.rings[0]
    )
    return Unit(
        id=uid,
        name=name,
        polygons=polygons,
        bbox=_union_bbox([p.bbox for p in polygons]),
        area_km2=area,
        polar=polar,
    )


# ---------------------------------------------------------------------------------------------
# Geometry: containment and distance
# ---------------------------------------------------------------------------------------------


def _ring_contains(ring: Ring, x: float, y: float) -> bool:
    inside = False
    xj, yj = ring[-1]
    for xi, yi in ring:
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        xj, yj = xi, yi
    return inside


def _pole_ring_contains(ring: Ring, lng: float, lat: float, pole: int) -> bool:
    """Containment for a ring that encircles a pole; its interior is the pole's side.

    Cast the meridian from the point towards the pole: an even number of crossings with the ring
    means the pole, and so the point, is inside.
    """
    crossings = 0
    px, py = ring[-1]
    offset = _wrap(lng - px)
    for qx, qy in ring:
        turn = _wrap(qx - px)
        if turn != 0.0:
            t = offset / turn
            if 0.0 <= t < 1.0 and (py + (qy - py) * t - lat) * pole > 0.0:
                crossings += 1
        px, py = qx, qy
        offset = _wrap(lng - px)
    return crossings % 2 == 0


def _polygon_contains(poly: Polygon, lng: float, lat: float) -> bool:
    min_x, min_y, max_x, max_y = poly.bbox
    if lng < min_x or lng > max_x or lat < min_y or lat > max_y:
        return False
    if poly.pole:
        inside = _pole_ring_contains(poly.rings[0], lng, lat, poly.pole)
        holes = poly.rings[1:]
    else:
        inside = False
        holes = poly.rings
    for ring in holes:  # even-odd across the exterior and every hole
        if _ring_contains(ring, lng, lat):
            inside = not inside
    return inside


def _origin_to_segment(ax: float, ay: float, bx: float, by: float) -> float:
    """Distance from the origin to the segment (a, b), in the plane's own units."""
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return math.hypot(ax, ay)
    t = min(1.0, max(0.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy)


def _ring_distance_km(ring: Ring, lng: float, lat: float, best: float) -> float:
    """Distance from the point to the ring's edges, km, on the point's local plane.

    Each vertex is placed with the standard equirectangular rule (east-west offset scaled by the
    cosine of the mean of the two latitudes), so distances to vertices stay accurate to about 1%
    out to the 400 km offshore rule and exact enough at the 25 km tolerance.
    """
    px, py = ring[-1]
    ax = _wrap(px - lng) * _KM_PER_DEG * math.cos((py + lat) * _HALF_RAD)
    ay = (py - lat) * _KM_PER_DEG
    for qx, qy in ring:
        bx = _wrap(qx - lng) * _KM_PER_DEG * math.cos((qy + lat) * _HALF_RAD)
        by = (qy - lat) * _KM_PER_DEG
        d = _origin_to_segment(ax, ay, bx, by)
        if d < best:
            best = d
        ax, ay = bx, by
    return best


def _bbox_gap_km(box: BBox, lng: float, lat: float) -> float:
    """A lower bound on the distance from the point to anything inside the box, km."""
    min_x, min_y, max_x, max_y = box
    gap_lat = max(min_y - lat, 0.0, lat - max_y)
    if min_x <= lng <= max_x:
        gap_lng = 0.0
    else:
        gap_lng = min(abs(_wrap(min_x - lng)), abs(_wrap(max_x - lng)))
    widest = max(abs(lat), abs(min_y), abs(max_y))
    kx = max(math.cos(math.radians(min(widest, 89.999))), 1e-6) * _KM_PER_DEG
    return 0.9 * math.hypot(gap_lng * kx, gap_lat * _KM_PER_DEG)


@dataclass(frozen=True, slots=True)
class World:
    """The decoded world map: one ``Unit`` per id, geometry taken from one TopoJSON object."""

    units: dict[str, Unit]
    centres: dict[str, tuple[Point, ...]]
    object_name: str

    def contains(self, unit_id: str, lng: float, lat: float) -> bool:
        unit = self.units[unit_id]
        return any(_polygon_contains(p, lng, lat) for p in unit.polygons)

    def locate(self, lng: float, lat: float) -> str | None:
        """The id of the unit whose geometry contains the point (``None`` at sea)."""
        for uid in sorted(self.units):
            if self.contains(uid, lng, lat):
                return uid
        return None

    def distance_km(self, unit_id: str, lng: float, lat: float) -> float:
        """Distance from the point to the unit's boundary, km; 0 when the point is inside."""
        unit = self.units[unit_id]
        if self.contains(unit_id, lng, lat):
            return 0.0
        return self._boundary_km(unit, lng, lat, math.inf)

    def _boundary_km(self, unit: Unit, lng: float, lat: float, cutoff: float) -> float:
        best = math.inf
        for poly in sorted(unit.polygons, key=lambda p: _bbox_gap_km(p.bbox, lng, lat)):
            if _bbox_gap_km(poly.bbox, lng, lat) > min(best, cutoff):
                break
            for ring in poly.rings:
                best = _ring_distance_km(ring, lng, lat, best)
        return best

    def nearest_units(self, lng: float, lat: float, k: int = 3) -> list[tuple[str, float]]:
        """The ``k`` units closest to the point as ``(unit_id, km)``; 0 km means inside."""
        if k < 1:
            return []
        scored: list[tuple[float, str]] = []
        for uid in self.units:
            if self.contains(uid, lng, lat):
                scored.append((0.0, uid))
        if len(scored) >= k:
            return [(uid, d) for d, uid in sorted(scored)[:k]]
        inside = {uid for _, uid in scored}
        order = sorted(
            (uid for uid in self.units if uid not in inside),
            key=lambda u: _bbox_gap_km(self.units[u].bbox, lng, lat),
        )
        for uid in order:
            unit = self.units[uid]
            if len(scored) >= k:
                worst = sorted(scored)[k - 1][0]
                if _bbox_gap_km(unit.bbox, lng, lat) > worst:
                    break
                cutoff = worst
            else:
                cutoff = math.inf
            d = self._boundary_km(unit, lng, lat, cutoff)
            scored.append((d, uid))
        scored.sort()
        return [(uid, d) for d, uid in scored[:k]]


def load_world(path: str | Path, object_name: str = "detail") -> World:
    """Decode ``object_name`` (``detail`` or ``coarse``) of the TopoJSON at ``path``."""
    with open(path, encoding="utf-8") as fh:
        topo = _need_dict(json.load(fh), "world")
    if topo.get("type") != "Topology":
        raise WorldError("world: not a Topology")
    arcs = _decode_arcs(topo)
    objects = _need_dict(topo.get("objects"), "objects")
    collection = _need_dict(objects.get(object_name), f"objects.{object_name}")
    if collection.get("type") != "GeometryCollection":
        raise WorldError(f"objects.{object_name}: expected a GeometryCollection")
    units: dict[str, Unit] = {}
    for i, raw in enumerate(
        _need_list(collection.get("geometries"), f"objects.{object_name}.geometries")
    ):
        unit = _unit(arcs, _need_dict(raw, f"geometries[{i}]"), f"{object_name}[{i}]")
        if unit.id in units:
            raise WorldError(f"{object_name}: duplicate unit id {unit.id}")
        units[unit.id] = unit
    centres: dict[str, tuple[Point, ...]] = {}
    raw_centres = topo.get("centres")
    if raw_centres is not None:
        for uid, parts in _need_dict(raw_centres, "centres").items():
            pts: list[Point] = []
            for part in _need_list(parts, f"centres.{uid}"):
                pair = _need_list(part, f"centres.{uid}[]")
                if len(pair) != 2:
                    raise WorldError(f"centres.{uid}: expected [lng, lat] pairs")
                cx, cy = pair
                if not (_is_num(cx) and _is_num(cy)):
                    raise WorldError(f"centres.{uid}: expected [lng, lat] numbers")
                pts.append((float(cx), float(cy)))
            centres[uid] = tuple(pts)
    return World(units=units, centres=centres, object_name=object_name)


@functools.cache
def _default_world() -> World:
    return load_world(DEFAULT_WORLD)


def nearest_units(
    lng: float, lat: float, k: int = 3, *, world: World | None = None
) -> list[tuple[str, float]]:
    """The ``k`` units nearest to (lng, lat) as ``(unit_id, km to its boundary)``, 0 if inside.

    Defaults to the committed ``admin-ui/data/adventure-world.json`` ``detail`` geometry. Handy
    for diagnosing a failure: ``nearest_units(-9.1393, 38.7223)`` -> ``[("PRX", 0.0), ...]``.
    """
    return (world or _default_world()).nearest_units(lng, lat, k)


# ---------------------------------------------------------------------------------------------
# Bank validation
# ---------------------------------------------------------------------------------------------


def _is_date(value: object) -> bool:
    if not isinstance(value, str) or not _DATE_RE.match(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _plain_text(value: str) -> bool:
    """Printable, trimmed, and free of markup characters."""
    return (
        value == value.strip()
        and value.isprintable()
        and not any(ch in value for ch in "<>`")
        and "](" not in value
    )


def _check_text(
    problems: list[str], where: str, field: str, value: object, limit: int, *, plain: bool = True
) -> str | None:
    if not isinstance(value, str) or not value.strip():
        problems.append(f"{where}: {field} must be a non-empty string")
        return None
    if len(value) > limit:
        problems.append(f"{where}: {field} is {len(value)} characters (max {limit})")
    if plain and not _plain_text(value):
        problems.append(
            f"{where}: {field} must be plain text (no markup, control characters or edge spaces)"
        )
    return value


def _check_destination(
    problems: list[str],
    world: World,
    unit_key: str,
    index: int,
    raw: object,
    seen_ids: dict[str, str],
    names: dict[str, str],
    coords: dict[tuple[float, float], str],
) -> None:
    where = f"countries.{unit_key}.destinations[{index}]"
    if not isinstance(raw, dict):
        problems.append(f"{where}: must be an object")
        return
    dest: dict[str, object] = raw
    extra = sorted(set(dest) - _DEST_KEYS)
    missing = sorted(_DEST_KEYS - set(dest))
    if extra:
        problems.append(f"{where}: unknown key(s) {', '.join(map(repr, extra))}")
    if missing:
        problems.append(f"{where}: missing key(s) {', '.join(map(repr, missing))}")

    dest_id = dest.get("id")
    if isinstance(dest_id, str):
        where = f"{where} ({dest_id})"
        prefix, dot, slug = dest_id.partition(".")
        if not dot or not _SLUG_RE.match(slug):
            problems.append(f"{where}: id must be <unitId>.<lowercase-kebab-slug>")
        elif prefix != unit_key:
            problems.append(f"{where}: id prefix {prefix!r} does not match its unit {unit_key!r}")
        if dest_id in seen_ids:
            problems.append(f"{where}: duplicate id (also at {seen_ids[dest_id]})")
        else:
            seen_ids[dest_id] = f"countries.{unit_key}.destinations[{index}]"
    elif "id" in dest:
        problems.append(f"{where}: id must be a string")

    name = (
        _check_text(problems, where, "name", dest.get("name"), MAX_NAME) if "name" in dest else None
    )
    if name is not None:
        folded = name.casefold()
        if folded in names:
            problems.append(
                f"{where}: name {name!r} is already used in {unit_key} by {names[folded]}"
            )
        else:
            names[folded] = dest_id if isinstance(dest_id, str) else name
    if "region" in dest:
        _check_text(problems, where, "region", dest.get("region"), MAX_REGION)
    if "blurb" in dest:
        _check_text(problems, where, "blurb", dest.get("blurb"), MAX_BLURB)
    if "kind" in dest:
        kind = dest["kind"]
        if not isinstance(kind, str) or kind not in KINDS:
            problems.append(f"{where}: kind {kind!r} is not one of {', '.join(sorted(KINDS))}")

    raw_lat, raw_lng = dest.get("lat"), dest.get("lng")
    lat = float(raw_lat) if _is_num(raw_lat) and -90.0 <= raw_lat <= 90.0 else None
    lng = float(raw_lng) if _is_num(raw_lng) and -180.0 <= raw_lng <= 180.0 else None
    if "lat" in dest and lat is None:
        problems.append(f"{where}: lat must be a number in [-90, 90]")
    if "lng" in dest and lng is None:
        problems.append(f"{where}: lng must be a number in [-180, 180]")
    if lat is None or lng is None:
        return
    key = (round(lat, 4), round(lng, 4))
    label = dest_id if isinstance(dest_id, str) else f"destinations[{index}]"
    if key in coords:
        problems.append(f"{where}: same coordinates as {coords[key]}")
    else:
        coords[key] = label
    _check_position(problems, world, unit_key, where, lng, lat)


def _check_position(
    problems: list[str], world: World, unit_key: str, where: str, lng: float, lat: float
) -> None:
    unit = world.units[unit_key]
    if unit.polar:
        problems.append(
            f"{where}: unit {unit_key} ({unit.name}) touches a pole and must not be in the bank"
        )
        return
    km = world.distance_km(unit_key, lng, lat)
    if km <= TOLERANCE_KM:
        return
    nearest = world.nearest_units(lng, lat, 3)
    if km <= OFFSHORE_KM and nearest[0][0] == unit_key:
        return  # an island the 1:50m map omits: far from its coast, but nobody else is nearer
    near = ", ".join(f"{uid} {'inside' if d == 0 else f'{d:.0f} km'}" for uid, d in nearest)
    problems.append(
        f"{where}: ({lat}, {lng}) is {km:.0f} km from {unit_key} ({unit.name}); allowed: "
        f"within {TOLERANCE_KM:.0f} km, or within {OFFSHORE_KM:.0f} km when {unit_key} is the "
        f"nearest unit. Nearest units: {near}"
    )


def _check_advice(problems: list[str], where: str, advice: object) -> None:
    if advice is None:
        return
    if not isinstance(advice, dict):
        problems.append(f"{where}: advice must be null or an object")
        return
    extra = sorted(set(advice) - _ADVICE_KEYS)
    if extra:
        problems.append(f"{where}: advice has unknown key(s) {', '.join(map(repr, extra))}")
    if advice.get("level") != ADVICE_LEVEL:
        problems.append(f"{where}: advice.level must be {ADVICE_LEVEL!r}")
    if not _is_date(advice.get("checked")):
        problems.append(f"{where}: advice.checked must be a YYYY-MM-DD date")


def validate_data(bank: object, world: World) -> list[str]:
    """Validate an already-parsed bank against ``world``; returns problems (empty = valid)."""
    problems: list[str] = []
    if not isinstance(bank, dict):
        return ["bank: top level must be an object"]
    extra = sorted(set(bank) - _BANK_KEYS)
    missing = sorted(_BANK_KEYS - set(bank))
    if extra:
        problems.append(f"bank: unknown top-level key(s) {', '.join(map(repr, extra))}")
    if missing:
        problems.append(f"bank: missing top-level key(s) {', '.join(map(repr, missing))}")
    version = bank.get("version")
    if "version" in bank and (version != BANK_VERSION or isinstance(version, bool)):
        problems.append(f"bank: version must be {BANK_VERSION}")
    if "generated" in bank and not _is_date(bank.get("generated")):
        problems.append("bank: generated must be a YYYY-MM-DD date")
    countries = bank.get("countries")
    if "countries" not in bank:
        return problems
    if not isinstance(countries, dict):
        problems.append("bank: countries must be an object")
        return problems

    seen_ids: dict[str, str] = {}
    for unit_key in sorted(countries):
        where = f"countries.{unit_key}"
        entry = countries[unit_key]
        if (
            not isinstance(unit_key, str)
            or not _UNIT_ID_RE.match(unit_key)
            or unit_key not in world.units
        ):
            problems.append(f"{where}: {unit_key!r} is not a unit id in the world map")
            continue
        if not isinstance(entry, dict):
            problems.append(f"{where}: must be an object")
            continue
        unit = world.units[unit_key]
        extra = sorted(set(entry) - _UNIT_KEYS)
        missing = sorted(_UNIT_KEYS - set(entry))
        if extra:
            problems.append(f"{where}: unknown key(s) {', '.join(map(repr, extra))}")
        if missing:
            problems.append(f"{where}: missing key(s) {', '.join(map(repr, missing))}")
        if "name" in entry:
            _check_text(problems, where, "name", entry.get("name"), MAX_NAME)
        if "advice" in entry:
            _check_advice(problems, where, entry.get("advice"))
        dests = entry.get("destinations")
        if "destinations" not in entry:
            continue
        if not isinstance(dests, list):
            problems.append(f"{where}: destinations must be an array")
            continue
        floor = 1 if unit.area_km2 < SMALL_UNIT_KM2 else MIN_DESTINATIONS
        if len(dests) > MAX_DESTINATIONS or len(dests) < floor:
            small = f", under the {SMALL_UNIT_KM2:,.0f} km2 small-unit line" if floor == 1 else ""
            problems.append(
                f"{where}: {len(dests)} destination(s); need {floor}-{MAX_DESTINATIONS} for "
                f"{unit.name or unit_key} ({unit.area_km2:,.0f} km2{small})"
            )
        names: dict[str, str] = {}
        coords: dict[tuple[float, float], str] = {}
        for i, raw in enumerate(dests):
            _check_destination(problems, world, unit_key, i, raw, seen_ids, names, coords)
    return problems


def missing_units(bank: object, world: World) -> list[str]:
    """World unit ids that have no entry in the bank (informational: these are 'sea')."""
    countries = bank.get("countries") if isinstance(bank, dict) else None
    present = set(countries) if isinstance(countries, dict) else set()
    return sorted(set(world.units) - present)


def validate(bank_path: str | Path, world_path: str | Path) -> list[str]:
    """Validate the bank file against the world map file; an empty list means valid."""
    try:
        with open(bank_path, encoding="utf-8") as fh:
            bank: object = json.load(fh)
    except (OSError, ValueError) as exc:
        return [f"bank: cannot read {bank_path}: {exc}"]
    return validate_data(bank, load_world(world_path))


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate the Adventure Time destination bank against the world map.",
        epilog=(
            "Usage: validate_bank.py <bank.json> <world.json>"
            "  |  validate_bank.py --nearest LAT LNG [world.json]"
        ),
    )
    parser.add_argument("paths", nargs="*", help="<bank.json> <world.json>")
    parser.add_argument(
        "--nearest",
        nargs=2,
        type=float,
        metavar=("LAT", "LNG"),
        help="list the units nearest a point",
    )
    parser.add_argument(
        "-k", type=int, default=5, help="how many units --nearest lists (default 5)"
    )
    args = parser.parse_args(argv)

    if args.nearest is not None:
        if len(args.paths) > 1:
            parser.error("--nearest takes at most one path (the world file)")
        world = load_world(args.paths[0] if args.paths else DEFAULT_WORLD)
        lat, lng = args.nearest
        for uid, km in world.nearest_units(lng, lat, args.k):
            unit = world.units[uid]
            print(f"{uid:4} {unit.name:30} {'inside' if km == 0 else f'{km:,.1f} km'}")
        return 0

    if len(args.paths) != 2:
        parser.error("need <bank.json> and <world.json>")
    bank_path, world_path = args.paths
    problems = validate(bank_path, world_path)
    if problems:
        for problem in problems:
            print(problem)
        print(f"{len(problems)} problem(s)", file=sys.stderr)
        return 1
    with open(bank_path, encoding="utf-8") as fh:
        bank = json.load(fh)
    world = load_world(world_path)
    countries = bank["countries"]
    total = sum(len(c["destinations"]) for c in countries.values())
    absent = missing_units(bank, world)
    print(f"OK: {len(countries)} units, {total} destinations")
    if absent:
        listed = ", ".join(absent)
        print(f"note: {len(absent)} world unit(s) have no bank entry (treated as sea): {listed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
