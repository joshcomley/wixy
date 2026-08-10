# Decision: Contact promoted to a main tab, real address wording, and a real map

## Symptom

The operator, via the planner, after decisions/00127 shipped: "Move this to a main tab, not
buried in settings." Two follow-on asks in the same round: the address hint read as if
multiple addresses were expected ("One address line per line") when it's ONE address shown
over several lines; and "it should update the map" — `pages/contact.html`'s Google Maps
iframe had the address HARD-CODED in its `src`, so editing the address (or, after
decisions/00127, the phone/email) changed the text everywhere but left the map pointing at
the old place forever — the exact desync class `phoneHref`/`emailHref` closed for links,
now found in the map. His explicit clarification: "Without coordinates, the map should use
the address to show where to go" — the address is the default map source; coordinates are
an optional precision override, placed via a pin on a real map in the admin.

## What was decided — Contact becomes a main tab, not a Settings tab

New route `{kind: "contact"}` (`router.ts`) at `/admin/contact`, alongside `pages`/`theme`/
`media`/`chat`/`history` — NOT nested under `{kind:"settings", page:...}` anymore. The whole
`renderContact` implementation (fields, derived-pair logic, Reset-then-reload) MOVED out of
`settingsPanel.ts` into a new `contactPanel.ts` with its own `mountContactPanel(deps)`,
mirroring `themePanel.ts`'s shape (`{api, opQueue, win}` deps, `opQueue` NON-nullable since
`shell.ts` now gates the whole route on it being ready — matching `theme`'s own gate — rather
than the nullable `opQueue: OpQueueLike | null` decisions/00127 needed to let every OTHER
settings tab render before it resolved). `SettingsPage` shrinks by one variant (`"contact"`
removed); a legacy `/admin/settings/contact` deep link degrades gracefully to `general`
(`routeFromSegments`'s settings case simply no longer recognizes it as a second segment) —
matching the SAME graceful-degradation shape `parsePath`'s own unrecognized-route fallback
already uses, rather than a dead-end blank panel.

The main-nav placement — "after the section nav items, before Theme" — needed no special-
casing: `NAV_ROUTES` gained `{kind:"contact"}` as the entry right before `{kind:"theme"}`
(the first STATIC item after Edit). The dynamic registry-configured section buttons are
ALWAYS inserted via `editNavItem.after(...)` (decisions/00098), which lands them immediately
after Edit regardless of what static items already follow — so Contact, being the next static
item in DOM order, is automatically pushed to sit right after them. Nothing about that
insertion logic changed.

## What was decided — the address wording fix

Label: "Address" (was "Contact address"). Hint: "Your address, exactly as it should appear
on your site — press Enter to start a new line." (was "Shown on the Contact page and
homepage. One address line per line.", which read as if multiple DIFFERENT addresses were
expected). The underlying `\n <-> <br>` textarea conversion (decisions/00127) was already
correct — wording only, no behavior change.

## What was decided — the phone/email <-> href precedent, generalized to the map

`_global.json` gains two keys: `mapCoords` (optional `"lat,lng"`, `""` when unset) and
`mapSrc` (the DERIVED Google Maps embed URL — `deriveMapSrc`, `contactPanel.ts`, exported
pure function). A placed pin wins when present; otherwise the address IS the map source,
matching the operator's own clarification exactly:
- `mapCoords` valid -> `mapSrc = "https://www.google.com/maps?q=<lat>,<lng>&output=embed"`
  (coordinates rounded to 6dp — `roundCoord`, `mapPickerModel.ts` — ~11cm precision, far
  tighter than a hand-placed pin needs, short enough to stay a readable stored string).
- `mapCoords` empty -> `mapSrc` derived from the address: split on `<br>`, each line's OWN
  trailing comma stripped (a naive `<br>` -> `", "` replacement would double the comma the
  real seeded address already ends its first line with — "Walton Road,<br>Hartlebury" ->
  "Walton Road,, Hartlebury" — the strip avoids that), lines joined with `", "`, the result
  URL-encoded via `encodeURIComponent`.

**Reproduction-invariant test, and where it's NOT byte-exact (deliberately, documented).**
`contactPanel.test.ts`'s `deriveMapSrc` test derives from the real seeded address and
compares against the site's actual former hard-coded URL's QUERY SEMANTICS, not its exact
bytes — the original hand-typed URL happens to drop the comma between town and postcode
("Kidderminster DY10 4JA" vs the stored address's "Kidderminster, DY10 4JA") and uses
`+`-for-space encoding rather than `encodeURIComponent`'s `%20`/`%2C`. Neither is a rule
this derivation could generalize from without hard-coding one address's own historical
authoring quirk, and Google's `q=` geocoder is comma/encoding-insensitive (both forms
resolve to the identical pin) — the test asserts the decoded, comma-normalized query text
matches exactly, which IS the semantic-equivalence proof, not a hand-wave.

Wiring, mirroring decisions/00127's `hrefKey`/`hrefKind` pattern: `ContactFieldConfig` gains
`alsoDiscardsOnReset?: readonly string[]` — `address`'s entry lists `["mapCoords", "mapSrc"]`
so Resetting the address row always returns the WHOLE map section to its true published
state too (a harmless no-op discard when nothing was staged for those two keys). Editing the
address ALSO re-derives+enqueues `mapSrc`, but ONLY when the loaded snapshot's `mapCoords` is
empty — a placed pin must never be silently overridden by an address edit. The map section
gets its OWN "Reset map to published" link-button (discards `mapCoords`+`mapSrc`, flushes,
reloads) — deliberately SEPARATE from "Clear pin" (which always sets `mapCoords` to `""` and
re-derives `mapSrc` from the CURRENT address, regardless of what's published): Clear is an
editing action with one fixed outcome; Reset undoes back to whatever's actually live
(which could itself be a previously-published pin).

## What was decided — the map picker: hand-rolled, no CDN, in the house style

`mapPickerModel.ts` (pure, DOM-free — mirrors `alignerModel.ts`'s "framework-free core"
convention) holds the Web Mercator projection math (`lonLatToWorldPixel`/
`worldPixelToLonLat`, continuous WORLD-PIXEL coordinates rather than floored tile indices, so
panning is a plain pixel subtraction), the visible-tile-grid computation
(`tilesForViewport`, one tile of padding on every edge, X wrapped mod `2^zoom` for the
antimeridian, Y clamped — never wrapped — at the poles), and coordinate parsing/formatting/
rounding. `mapPicker.ts` wires this to a small, dependency-free slippy map: OSM raster tiles
(`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `(c) OpenStreetMap contributors`
attribution linking to their copyright page, per their tile usage policy), drag-to-pan (a
CSS `transform: translate()` on the tile layer DURING the drag — cheap, no image churn — the
actual tile SET only recomputes on drag release/zoom/mount), zoom buttons, and an ARMED
click-to-pin mode (a plain click does nothing; "Click to pin coordinates" arms it, Escape or
re-pressing disarms, an armed click places the pin — rounded to 6dp — and disarms itself).
Click vs. drag is distinguished by total pointer-travel distance (<4px = a click), not by
which handler fired first. Never vendored Leaflet or any other CDN dependency — came in well
under the "~300 lines of fiddly pan/zoom code" ceiling the operator's own guidance set as the
trigger for that fallback (the pure math is 150 lines, the DOM wiring ~300, both comfortably
scoped and unit-tested directly).

One real bug caught by writing the tests, not shipped: the click-to-pin math and the marker's
own screen placement used a DIFFERENT viewport-width fallback than tile rendering
(`renderTiles` already had `viewport.clientWidth || 320` for jsdom/pre-layout/hidden-panel
safety; the marker and the click handler used raw `viewport.clientWidth`, which is 0 in
exactly those same situations) — would have silently misplaced a placed pin any time the
panel rendered before real layout existed. Unified into one `viewportWidth()` helper used
everywhere the viewport's width feeds pixel math, before any test ever ran against it.

## What was decided — generalizing the href scheme-injection guard (Inv 29)

Binding an iframe's `src` from content (`data-wx-attr="src:@mapSrc"`) opens the EXACT
injection class decisions/00121/00123 already closed for `data-wx-href` — `_apply_attrs`
(`builder/bindings.py`) set attribute values verbatim, with no scheme check at all, for ANY
`data-wx-attr` pair. Fixed generically, not as a one-off for `src`: any `data-wx-attr` pair
whose TARGET ATTRIBUTE is `href`/`src`/`action`/`formaction`/`xlink:href` now runs through the
SAME `is_safe_href` (`builder/sanitize.py`) the href binding already uses, build-mode
fail / validate-mode collect, identical semantics to `_apply_href`. Keyed on the attribute
NAME, not the binding kind — a `data-wx-attr` pair targeting anything else (`data-cat`,
`data-booking-url`, …) is free text and untouched; only attribute names a BROWSER ITSELF
navigates/fetches/submits to are covered (a `data-*` attribute a script later reads is a
separate, JS-mediated path outside this guard's scope). Checked every EXISTING
`data-wx-attr` usage in the site repo before shipping (all target `data-booking-url`/
`data-cat` — confirmed via `grep`, not assumed) — zero risk of breaking anything live.
Sequenced deliberately before the site-repo PR that adds the `src:@mapSrc` binding, so the
guard exists before anything could depend on its absence.

## What to watch for

- The phone/email <-> href AND address/pin <-> mapSrc derived-pair pattern (decisions/00127,
  this entry) is now used twice — any FUTURE field with a real link-target companion should
  follow the same `hrefKey`/`hrefKind`-or-equivalent config shape, not a one-off `if`.
- `mapPickerModel.ts`'s tile math assumes a NON-retina-aware 256px tile size (no
  `devicePixelRatio` scaling) — acceptable for this single-admin, occasional-use tool; revisit
  only if the picker ever needs to look sharp on a very high-DPI display.
- OSM's tile usage policy is aimed at high-volume/automated use; a single admin's occasional
  map-picker use is well within it, but this should never be pointed at from anything
  high-traffic or automated (e.g. never render the picker server-side or in a crawler).
- e2e (`contact-panel.spec.ts`) blocks `https://tile.openstreetmap.org/**` the same way
  `theme-change.spec.ts` blocks Google Fonts — tile-load success is irrelevant to every
  assertion (click math is computed from click position + view state, never from whether a
  tile image decoded), so this keeps the suite fast and network-independent, not a workaround
  for a real dependency.
