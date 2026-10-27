# Adventure Time - world map and destination-bank tooling

Build and check tooling for the Adventure Time globe game
([`spec/server-chat/08-adventure-time.md`](../../spec/server-chat/08-adventure-time.md) sections
2.1 and 2.2). Nothing here is part of the admin bundle or the server runtime: the only things the
product ships from this folder's work are the generated
[`admin-ui/data/adventure-world.json`](../../admin-ui/data/adventure-world.json) and the destination
bank that `validate_bank.py` checks.

| File | What it is |
|---|---|
| `build_world.mjs` | Node script: Natural Earth 1:50m -> `admin-ui/data/adventure-world.json` + `units.json` |
| `package.json`, `package-lock.json` | Its own devDependencies (`topojson-server`, `topojson-simplify`, `topojson-client`, `polylabel`, exact versions) so the admin bundle's dependencies are untouched |
| `units.json` | `[{id, name, sovereign, subregion}]` for all 256 map units, sorted by id: what the destination writers and the validator work from |
| `validate_bank.py` | Stdlib-only, `mypy --strict`-clean validator + CLI for the destination bank |

## Source and licence

Natural Earth 1:50m cultural vectors, **public domain**
(<https://www.naturalearthdata.com/about/terms-of-use/>), taken from
[`nvkelso/natural-earth-vector`](https://github.com/nvkelso/natural-earth-vector) at the pinned
commit **`ca96624a56bd078437bca8184e78163e5039ad19`** (tip of `master` when looked up on
2026-10-27; the commit is dated 2022-06-02):

* `geojson/ne_50m_admin_0_countries.geojson`  (SHA-256 `3e458fc0...b7fdeb`)
* `geojson/ne_50m_admin_0_map_units.geojson`  (SHA-256 `b8d421ac...8a4db0`)

The full hashes live in the script header and are verified on every run. Downloads are cached in
`<os tmpdir>/wixy-adventure-ne/<commit>/` and never committed.

## Rebuilding the map

```
cd tooling/adventure
npm ci
node build_world.mjs            # writes admin-ui/data/adventure-world.json and units.json
node build_world.mjs --check    # rebuilds in memory; exits 1 if the committed files differ
```

The output is deterministic (no timestamps, stable key order, no randomness): a re-run produces
identical bytes. After rebuilding, `cd admin-ui && npm run build` refreshes the static copy (CI's
bundle-drift check covers it). The pinned commit is the only moving part; bumping it means editing
the commit and both hashes in the script header, rebuilding, and re-running the validator over the
bank.

### What `adventure-world.json` contains

* **256 units** (spec 2.1): every `admin_0_countries` feature except FRA, PRT, NOR, NLD, TZA, GBR,
  which are replaced by their `admin_0_map_units` pieces. Id = `ADM0_A3` (or `GU_A3` for a piece);
  `properties.name` = `NAME_LONG`. The build fails unless there are exactly 256 unique ids.
* **One TopoJSON, two objects sharing ids**: `detail` (every geometry decision and zoomed drawing)
  and `coarse` (the fast-spinning globe). One quantization transform (1e5 steps over the whole
  bbox), one arc table; arcs identical in both objects are stored once.
* **`detail`** is simplified with Visvalingam on *spherical* triangle areas
  (`presimplify(sphericalTriangleArea)`), minimum 25 km2, tuned by rendering Greece and Norway at a
  5 degree view radius. It keeps **every one of Natural Earth's 1,622 polygon parts** (each costs a
  few dozen bytes) so no island the validator measures against disappears.
* **`coarse`** is minimum 800 km2 and keeps each unit's largest polygon (at least 4 vertices) plus
  whatever survives the threshold. Micro-states (Vatican City, Monaco, San Marino, Liechtenstein,
  Malta, Singapore, Bahrain, Maldives, Nauru, Tuvalu...) keep a real polygon in both objects; the
  build verifies that for all 256 units in both objects.
* **`centres`**: `{ [unitId]: [[lng, lat], ...] }`, one pole of inaccessibility per polygon part of
  each `detail` feature, in the order `topojson-client`'s `feature()` yields the parts
  (`Polygon` = one part, `MultiPolygon` = one per polygon), computed with `polylabel` on an
  equirectangular projection scaled by cos(mean latitude), precision about 0.05 degrees, rounded to
  4 dp, and verified to lie inside their own part. (Every part gets one, not only the larger ones,
  so `centres[id][i]` always lines up with part `i`.)
* Rings follow d3-geo's winding (exterior clockwise, holes anticlockwise); the build verifies it.
  Natural Earth already splits polygons at +-180 degrees. Antarctica's coast is one ring running
  -180..+180 closed along the pole line; the build keeps its antimeridian points so it stays a valid
  planar ring (a spherical consumer sees it wind clockwise round the south pole).
* Budgets enforced by the script: file <= 600,000 bytes, `coarse` <= 12,000 vertices. Current
  output: 579,007 bytes, `detail` 42,167 vertices, `coarse` 7,912 vertices (arc points).

## Validating the destination bank

```
python tooling/adventure/validate_bank.py wixy_server/livechat/adventure_destinations.json admin-ui/data/adventure-world.json
python tooling/adventure/validate_bank.py --nearest 38.7223 -9.1393 [world.json] [-k 5]
```

The first form prints one problem per line and exits 1 if there are any (it also notes which map
units have no bank entry: those are "sea"). The second answers "Lisbon is 2 km from PRX": the units
nearest a point and the distance to each boundary (0 if inside). From Python:
`validate(bank_path, world_path) -> list[str]`, `World.nearest_units(lng, lat, k)`,
`nearest_units(lng, lat, k)` (committed map), `load_world(path, "detail" | "coarse")`.

`wixy_server/tests/test_adventure_bank.py` runs the validator over a small fixture bank, a set of
focused negative cases, the world map's own invariants, and (once it exists) the real
`wixy_server/livechat/adventure_destinations.json`.

### Rules checked

**Schema** (spec 2.2, exactly; an unknown key anywhere is a problem): top level
`{version: 1, generated: YYYY-MM-DD, countries}`; `countries` keys are known unit ids; each unit
`{name, advice, destinations}` with `name` non-empty <= 60, `advice` `null` or
`{level: "against_all_travel", checked: YYYY-MM-DD}`; **1-10 destinations, at least 3 unless the
unit is small** (land area under 1,000 km2 on the `detail` map: Vatican City, Monaco, Malta,
Singapore, the Maldives... may have 1-2); each destination
`{id, name, region, lat, lng, kind, blurb}`: `id` = `<unitId>.<ascii-lowercase-kebab-slug>` with the
unit id of the entry it sits in and unique bank-wide, `name` and `region` non-empty <= 60, names
unique within a unit, `lat`/`lng` in range, `kind` one of
`city|beach|island|mountains|countryside|lakes|nature|historic|resort|wine`, `blurb` non-empty plain
text <= 120 chars (no `<`, `>`, backticks, control characters or edge spaces). Two destinations at
the same coordinates in one unit are flagged as a copy-paste slip.

**Geography.** A destination point is accepted when any of these holds, where *d* is its distance
to the boundary of the unit it is filed under (in the `detail` geometry; 0 if inside):

1. it is inside its unit;
2. *d* <= **25 km** (coastal resorts, islands just off the simplified coastline, enclave
   micro-states: the Vatican's polygon is about 1 km from the real Vatican, which the map draws
   inside Italy);
3. *d* <= **400 km** AND the point's own unit is the **nearest of all 256 units** (inside counts
   as nearest). Natural Earth 50m omits many small holiday islands (Praslin, Maldives atolls,
   Fernando de Noronha, Los Roques, Grand Turk, Porto Santo, Aitutaki...); this keeps them valid.

A point that is inside, or nearer to, a *different* unit fails rule 3 (the wrong-country check the
validator exists for): Madrid filed under Portugal fails because it is inside Spain, and open sea
south of Malta filed under Italy fails because Malta is nearer. A unit whose polygon runs round a
pole (Antarctica) is never accepted; it must be absent from the bank. Failure messages name the
nearest units, e.g. `... is 244 km from PRX (Portugal); allowed: within 25 km, or within 400 km
when PRX is the nearest unit. Nearest units: ESP inside, PRX 244 km, FXX 348 km`.

Distances are point-to-segment on a local equirectangular plane centred on the point (east-west
offsets wrapped at the antimeridian and scaled by cos of the mean latitude): well under a
kilometre at the 25 km tolerance, about 1% out to 400 km.
