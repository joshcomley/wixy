## Symptom

The 2026-08-12 search-indexing audit (Work package 3,
`docs/search-indexing-implementation-brief.md`) found no JSON-LD structured data anywhere on
`cottageaesthetics.co.uk`, and no favicon (`/favicon.ico` returned `404`). The brief asked for
one `WebSite` node, one accurate `LocalBusiness`-family node "source[d] from the site
repository," and a stable favicon — explicitly leaving the mechanism (generic engine vs.
site-authored) and the Schema.org subtype open, with real judgment calls: "do not label the
business a regulated medical clinic unless the visible/legal facts support that
classification."

## What was decided

Ruled by the fable architecture consult (relation `152f1a9f-c20d-4830-8a43-a5df92d533ce`,
confidence 0.85) after live verification of the real deployed `_global.json`/`about.json`/
`theme.json` content and Google's current structured-data documentation:

- **A generic engine mechanism, `builder/structureddata.py`.** `WebSite` (from the registry's
  own `project.name`/`domain`, nothing site-specific) is always emitted on an indexable
  build's homepage. The optional `LocalBusiness`-family node is entirely driven by a new,
  optional `_global.json.business` block (spec/02-content-model.md §7) — absent means no
  `LocalBusiness` node at all (Inv 5), never a fabricated one.
- **Gated exactly like `sitemap.xml` (Inv 35's own precedent): a non-indexable build emits
  NOTHING**, not a noindex-flagged version of the graph. Staging never gets a JSON-LD script
  tag at all.
- **`business.types` is a site-authored dual `@type`:** `["HealthAndBeautyBusiness",
  "MedicalBusiness"]`. `MedicalClinic`, `DaySpa`, and `BeautySalon` alone were each explicitly
  falsified against the real visible facts (Purdi is NMC-registered with medical indemnity
  insurance and describes "nurse-led medical aesthetics," but the actual treatments offered —
  microneedling, skin boosters, dermal fillers — are cosmetic/aesthetic, not diagnostic
  medicine) — Google's own documented array support for `@type` resolves the tension without
  overclaiming either direction.
- **`business.address` is authored once as a structured `PostalAddress`, never
  engine-parsed.** `streetAddress: "8 Walton Road, Hartlebury"`, `addressLocality:
  "Kidderminster"` (Royal Mail post-town convention — not the village the street line also
  names), no invented `addressRegion`. Engine-side parsing of the free-text, `<br>`-bearing
  `_global.json.address` display string was explicitly rejected as **empirically falsified**:
  that display shape has already drifted once in this exact project (an array, in an earlier
  version, per spec/02-content-model.md's own now-corrected illustrative example, to today's
  HTML-joined string) — no parser written against today's shape could be trusted to stay
  correct through the next drift.
- **A build-time substring drift-check is the safety net, not a substitute for correct
  authoring.** `structureddata.py` checks the authored `streetAddress`/`addressLocality`/
  `postalCode` still appear as substrings of the (HTML-stripped) visible `_global.json.address`
  text, and degrades to that plain string — plus a new non-blocking `validate` warning — the
  moment they don't. `addressCountry` is deliberately excluded from the check: a UK-local
  business's on-page address never displays "GB", so requiring it as a substring would fail
  even on genuinely correct data.
- **Opening hours are strict, all-or-nothing**, reusing `_global.json.hours[]` directly (no
  duplicated field): `re.fullmatch` against the exact observed "HH:MM – HH:MM" shape (en dash,
  single surrounding spaces) — the same fullmatch-not-match discipline Inv 36 already
  established for a different module. Any open (non-`closed`) day whose `value` doesn't match
  aborts the WHOLE block, emitting no `openingHoursSpecification` at all: since an absent day
  is read by consumers as closed (the schema.org convention this relies on), silently dropping
  just the unparseable day would assert a false closure.
- **The favicon is site-repo work, not engine-generated.** A simple, path-based mark (not the
  site's `Pinyon Script` wordmark treatment) placed at the site repo's root, with hand-authored
  `<link rel="icon">` tags per page — the same convention `theme.css`'s own
  `<link rel="stylesheet">` already uses, never engine-injected. The only engine-side piece is
  a **tiny, generic root-passthrough allowlist** in `builder/build.py:build_site`
  (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`) that closes the WP0-audited 404 by
  actually copying whatever the site repo places there into the build output — deliberately
  narrow (not "copy every root file") so an unrelated root file is never silently published.
- **A public JSON-response header change needed its own new, small `ValidationResult.warnings`
  channel** (`builder/errors.py`) — reuses `ValidationError`'s own shape rather than a
  near-duplicate class, but never affects `result.ok`; `to_json_dict()`'s new `"warnings"` key
  is additive, every existing consumer (all of which construct their own summary dicts by hand
  rather than calling `to_json_dict()`) is unaffected.

## Why

- Google's current structured-data documentation (fetched live) recommends the **most
  specific** `LocalBusiness` subtype available and wants `address` as a full `PostalAddress`
  object with as many properties as possible — not a plain string — which is why authored
  structure (not a degraded fallback) is the target state, and why the fallback exists only as
  a safety net for drift.
- Keeping the JSON-LD mechanism itself generic (Inv 1) while the classification/address/hours
  **facts** live entirely in site data matches this repo's existing split for every other piece
  of per-project identity (`og:site_name`, `og:image`, the redirect map, the noindex meta) —
  mechanics in the engine, facts in the site repo.
- The activation-timeline asymmetry already documented for Inv 37 applies here too: this is
  baked into the static build at publish/restore time (like `robots.txt`/`sitemap.xml`/the
  per-page `noindex` meta), NOT a live server route — an engine deploy alone does not change
  what `cottageaesthetics.co.uk` serves until the next owner Publish.

## What to watch for

- **Named falsifiers from the ruling** (record explicitly, don't let them go unwritten): if the
  site's own copy ever drops the medical framing (NMC registration, medical indemnity, "nurse-
  led"), the `MedicalBusiness` component of the dual type stops being defensible and should be
  removed. If Purdi's actual Google Business Profile listing ever splits the address
  differently, re-author `business.address` to match that authoritative source, not this
  decision's own choice. Any future hours `value` string that fullmatches the grammar but means
  something other than one continuous interval (a split shift, say) would silently misrepresent
  hours — the grammar's exactness bounds this risk but doesn't eliminate it.
- **The site-repo side is NOT done by this decision.** `_global.json.business` still needs to
  be authored with the ruled values; the favicon image itself still needs to be designed and
  placed at the site repo's root; the `<link rel="icon">` tags still need hand-authoring per
  page; and per the brief's own WP3 acceptance criteria, a visual artifact of the favicon at
  16/32/48/128px still needs producing for owner approval before any Publish — none of that is
  engine work, and none of it is complete yet.
- **This still needs the standard architecture-consult-already-done → implement → graded-audit
  gate** before merge, per this repo's own established rule for a wixy-engine PR touching
  public output — architecture is ruled via `152f1a9f`, not re-litigated; the graded audit is
  still required.
- Don't widen `_ROOT_PASSTHROUGH_FILES` casually — it's deliberately a small, explicit,
  generic (not Cottage-Aesthetics-specific) allowlist, the same posture Inv 37's JSON path
  allowlist takes for exactly the same reason (an unbounded passthrough risks silently
  publishing an unrelated root file).

## Addendum: graded-audit findings, fixed before merge (2026-08-13)

The genuinely fresh opus-tier graded audit (once the audit-infra fault was fixed) found one
critical and two medium/low findings, all fixed in the same PR before merge:

- **CRITICAL — script-tag breakout XSS.** `inject_structured_data` assigned
  `json.dumps(...)` output straight to `script.string`; neither `json.dumps` nor
  BeautifulSoup escapes a `</script>` sequence inside `<script>` content (which is raw
  text, never HTML-entity-escaped on serialization — entities aren't decoded inside
  `<script>`, so escaping `<` as `&lt;` there would be actively wrong). Any `_global.json`
  field feeding the graph (social links, phone, email, `business.address.*` — none
  HTML-sanitized on the way in; only text-kind draft fields are per `draft_sanitize.py`,
  and `is_safe_href`/Inv 29 checks URL *scheme* only) containing a literal `</script>`
  could break out of the tag and inject an executing sibling `<script>`, reachable on both
  the public homepage and the same-origin, authenticated `/admin/preview/*` surface. Fixed
  with `_escape_for_script_tag`: `<`/`>`/`&` become `\uXXXX` JSON string escapes, valid
  JSON that round-trips through `JSON.parse` back to the original character — changes
  nothing about the *parsed* data, only how the raw HTML source tokenizes before any
  script/JS context sees it. Verified red-then-green: a dedicated test
  (`test_script_tag_breakout_payload_cannot_escape_the_script`) confirmed the breakout
  really happened before the fix (reparsing the full document found 2 `<script>`
  elements) and is closed after it (exactly 1).
- **MEDIUM — a correctly-authored address was silently discarded when `_global.json`
  had no visible `address` text at all.** The drift check treated "nothing to compare
  against" (an empty visible string) the same as "every field drifted," which isn't the
  same claim — this is explicitly a generic engine mechanism (Inv 5's partial-migration
  tolerance already established this project can be mid-migration), so an authored
  address with no visible text to check against should be trusted as-is, not discarded.
  Fixed by only running the drift check when `visible_text` is non-empty.
- **LOW — a typo'd or partial address key set (e.g. `street` instead of
  `streetAddress`) silently produced a near-useless, country-only `PostalAddress` with
  no warning.** Fixed: if none of the three geographic drift-checked fields
  (`streetAddress`/`addressLocality`/`postalCode`) are populated, the address is omitted
  entirely with a new warning naming the gap, rather than emitting a minimal node that
  looks superficially valid but carries no real address information.
- Also fixed the sonnet-senior rung's own finding: a stale docstring reference to a
  non-existent `_check_address_drift` function name, corrected to name the actual
  function (`_build_address`'s drift check).

**Round 3, one narrow residual re-found by the re-audit against the round-2 fix:** the
F3 fix (above) sat behind a pre-existing `if not fields: return None, None` early
return — so an address dict with **every** key typo'd (`fields` ends up completely
empty, not just missing the three geographic ones) still returned silently with no
warning, unlike the partial-typo case (e.g. `street` + `addressCountry`) the round-2
fix already covered. Not a regression from round 2, an untouched pre-existing gap the
re-audit's harder variants caught. Fixed by removing that early return — the later
"none of the geographic fields populated" check already covers the fully-empty case
correctly (an empty `fields` trivially satisfies `not any(...)`), so the two checks
collapse into one: `structured` being entirely absent stays silent (nothing was
authored), any authored-but-unrecognized address dict — partial or total — now warns.
New test: `test_address_with_every_key_typo_d_is_omitted_and_warns`, verified
red-then-green.
