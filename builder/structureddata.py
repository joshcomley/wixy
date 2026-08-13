"""Homepage JSON-LD structured data (`WebSite` + optional `LocalBusiness`-family node) —
decisions/00139, docs/ai/invariants.md Inv 38. Ruled by the fable architecture consult on
Brief Work package 3 (relation `152f1a9f`): a generic engine mechanism, gated exactly like
`sitemap.xml` (Inv 35's own precedent) — a non-indexable build emits **nothing** here, not
a noindex-flagged version.

`WebSite` needs only the registry (`project.name`/`domain`) and is always emitted on an
indexable build's homepage. The optional `LocalBusiness`-family node is entirely
site-data-driven, from a new `_global.json.business` block (spec/02-content-model.md §7)
this module never invents: an absent/malformed `business` block means no LocalBusiness node
at all (Inv 5's partial-migration tolerance), never a fabricated one.

Two deliberately narrow, ruled decisions this module encodes:

- **Address is authored, never engine-parsed.** The consult explicitly rejected engine-side
  parsing of the free-text, HTML-bearing `_global.json.address` display string as empirically
  falsified — that display shape has already drifted (an array, in an earlier version of this
  project, to today's `<br>`-joined string) in production, so no parser written against
  today's shape could be trusted to stay correct. `business.address`'s structured
  `streetAddress`/`addressLocality`/`postalCode`/`addressCountry` fields are authored once,
  directly, by whoever can actually resolve the real-world addressing ambiguity (this project:
  Royal Mail post-town convention put `addressLocality` at "Kidderminster", not the village
  "Hartlebury" the street line also names). `_build_address`'s drift check is the safety net for
  DIVERGENCE, not a substitute for correct authoring: it checks the authored street/locality/
  postcode still appear as substrings of the (HTML-stripped) visible `_global.json.address`
  text, and degrades to that plain string — plus a non-blocking `validate` warning — the
  moment they don't. `addressCountry` is deliberately excluded from that check: a UK-local
  business's on-page address never displays "GB", so requiring it as a substring would fail
  even on genuinely correct data.
- **Opening hours are strict, all-or-nothing.** `_build_opening_hours` reuses
  `_global.json.hours[]` (never a duplicated field) via `re.fullmatch` against the exact
  observed "HH:MM – HH:MM" shape (en dash, single surrounding spaces) — the same
  fullmatch-not-match discipline Inv 36 already established for a different module. Any open
  (non-`closed`) day whose `value` doesn't match aborts the WHOLE block, emitting no
  `openingHoursSpecification` at all: since an absent day is read by consumers as closed
  (the schema.org convention this module relies on), silently DROPPING just the unparseable
  day would assert a false closure — worse than omitting hours entirely.
"""

from __future__ import annotations

import json
import re

from bs4 import BeautifulSoup, Tag

from builder.config import ProjectConfig
from builder.errors import BuildError
from builder.jsontypes import JsonObject, JsonValue

_SCHEMA_CONTEXT = "https://schema.org"

_ADDRESS_STRUCT_FIELDS = ("streetAddress", "addressLocality", "postalCode", "addressCountry")
# addressCountry is deliberately excluded from the drift check -- see module docstring.
_ADDRESS_DRIFT_CHECKED_FIELDS = ("streetAddress", "addressLocality", "postalCode")

_HOURS_RANGE_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d) – ([01]\d|2[0-3]):([0-5]\d)$")
_SCHEMA_DAY_URLS = {
    "Monday": f"{_SCHEMA_CONTEXT}/Monday",
    "Tuesday": f"{_SCHEMA_CONTEXT}/Tuesday",
    "Wednesday": f"{_SCHEMA_CONTEXT}/Wednesday",
    "Thursday": f"{_SCHEMA_CONTEXT}/Thursday",
    "Friday": f"{_SCHEMA_CONTEXT}/Friday",
    "Saturday": f"{_SCHEMA_CONTEXT}/Saturday",
    "Sunday": f"{_SCHEMA_CONTEXT}/Sunday",
}


def build_structured_data(
    project: ProjectConfig, global_content: JsonObject
) -> tuple[JsonObject | None, list[str]]:
    """The homepage's full JSON-LD graph, or `None` on a non-indexable build (Inv 35's own
    "staging emits nothing" precedent, not a noindex-flagged version of this). Second return
    value is zero or more human-readable drift warnings (currently: address drift) for
    `validate.py` to surface -- never raised, never blocking."""
    if not project.indexable:
        return None, []

    graph: list[JsonValue] = [_build_website(project)]
    warnings: list[str] = []

    business_raw = global_content.get("business")
    if isinstance(business_raw, dict):
        local_business, business_warnings = _build_local_business(
            project, global_content, business_raw
        )
        if local_business is not None:
            graph.append(local_business)
        warnings.extend(business_warnings)

    return {"@context": _SCHEMA_CONTEXT, "@graph": graph}, warnings


def _escape_for_script_tag(json_text: str) -> str:
    """Escape `<`, `>`, and `&` as `\\uXXXX` JSON string escapes so a value sourced from
    `_global.json` (social links, phone, email, business.address.* — none of which are
    HTML-sanitized on the way in; only text-kind draft fields are, per
    `draft_sanitize.py`, and `is_safe_href`/Inv 29 checks URL *scheme* only) can never
    contain a literal `</script>` that breaks the HTML parser out of this CDATA-like tag
    and starts executing injected markup, on the public homepage AND the same-origin,
    authenticated `/admin/preview/*` surface. `json.dumps` and BeautifulSoup do **not**
    escape this on their own — `<script>` content is raw text, never HTML-entity-escaped
    on serialization (escaping `<` as `&lt;` there would be wrong: browsers don't decode
    entities inside `<script>`, so it would print literally instead of being interpreted).
    A `\\uXXXX` escape is valid inside a JSON string and round-trips through `JSON.parse`
    back to the original character — this changes nothing about the *parsed* JSON-LD data,
    only how the raw HTML source can be tokenized before a script/JS context ever sees it."""
    return json_text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def inject_structured_data(soup: BeautifulSoup, graph: JsonObject, *, file_label: str) -> None:
    """Appends the `<script type="application/ld+json">` tag. Caller's job to only call this
    for the homepage and only with a non-`None` graph (`build_structured_data` already
    encodes both those gates in its own return value, this function just serializes)."""
    head = soup.head
    if not isinstance(head, Tag):
        raise BuildError("template has no <head>", location=file_label)
    script = soup.new_tag("script")
    script["type"] = "application/ld+json"
    json_text = json.dumps(graph, indent=2, sort_keys=False, ensure_ascii=False)
    script.string = _escape_for_script_tag(json_text)
    head.append(script)


def _build_website(project: ProjectConfig) -> JsonObject:
    return {"@type": "WebSite", "name": project.name, "url": f"https://{project.domain}/"}


def _build_local_business(
    project: ProjectConfig, global_content: JsonObject, business: JsonObject
) -> tuple[JsonObject | None, list[str]]:
    types = business.get("types")
    if not isinstance(types, list) or not types or not all(_is_nonempty_str(t) for t in types):
        return None, []

    node: JsonObject = {
        "@type": types[0] if len(types) == 1 else list(types),
        "name": project.name,
        "url": f"https://{project.domain}/",
    }

    phone = global_content.get("phone")
    if _is_nonempty_str(phone):
        node["telephone"] = phone

    email = global_content.get("email")
    if _is_nonempty_str(email):
        node["email"] = email

    address_value, address_warning = _build_address(business, global_content)
    warnings: list[str] = [address_warning] if address_warning is not None else []
    if address_value is not None:
        node["address"] = address_value

    same_as = _build_same_as(global_content)
    if same_as:
        node["sameAs"] = same_as

    hours_spec = _build_opening_hours(global_content)
    if hours_spec is not None:
        node["openingHoursSpecification"] = hours_spec

    return node, warnings


def _build_address(
    business: JsonObject, global_content: JsonObject
) -> tuple[JsonValue | None, str | None]:
    structured = business.get("address")
    if not isinstance(structured, dict):
        return None, None

    fields: dict[str, str] = {}
    for key in _ADDRESS_STRUCT_FIELDS:
        value = structured.get(key)
        if isinstance(value, str) and value != "":
            fields[key] = value
    # A structured address with none of the geographic fields populated -- every
    # key typo'd (fields ends up empty), a typo'd key like "street" instead of
    # "streetAddress", or only addressCountry authored -- is not a useful
    # PostalAddress and very likely a mistake; flag it rather than silently doing
    # nothing or emitting a near-empty, country-only node. `structured` being
    # entirely absent (checked above, `not isinstance(structured, dict)`) is the
    # only case that stays silent -- an authored-but-unrecognized address dict
    # always warns.
    if not any(key in fields for key in _ADDRESS_DRIFT_CHECKED_FIELDS):
        warning = (
            "_global.json.business.address has none of "
            f"{', '.join(_ADDRESS_DRIFT_CHECKED_FIELDS)} populated -- check for a "
            "typo'd key; structured address omitted"
        )
        return None, warning

    # No visible `_global.json.address` text to compare against (partial-migration
    # state, Inv 5, or a site that simply hasn't authored one yet) means drift can't
    # be detected either way -- trust the authored structured address as-is rather
    # than treating "nothing to compare against" as if every field had drifted.
    visible_text = _visible_address_text(global_content)
    if visible_text:
        drifted = [
            key
            for key in _ADDRESS_DRIFT_CHECKED_FIELDS
            if key in fields and fields[key] not in visible_text
        ]
        if drifted:
            warning = (
                "_global.json.business.address "
                f"{', '.join(drifted)} not found in the visible _global.json.address text -- "
                "structured data degraded to a plain string address; re-author business.address "
                "(or the visible address) so they agree"
            )
            return visible_text, warning

    return {"@type": "PostalAddress", **fields}, None


def _visible_address_text(global_content: JsonObject) -> str:
    visible = global_content.get("address")
    if not isinstance(visible, str) or not visible:
        return ""
    text = BeautifulSoup(visible, "html.parser").get_text(separator=" ")
    return " ".join(text.split())


def _build_same_as(global_content: JsonObject) -> list[JsonValue]:
    social = global_content.get("social")
    if not isinstance(social, dict):
        return []
    urls: list[JsonValue] = []
    for key in ("instagram", "facebook"):
        url = social.get(key)
        if isinstance(url, str) and url != "":
            urls.append(url)
    return urls


def _build_opening_hours(global_content: JsonObject) -> list[JsonValue] | None:
    hours = global_content.get("hours")
    if not isinstance(hours, list) or not hours:
        return None

    specs: list[JsonValue] = []
    for row in hours:
        if not isinstance(row, dict):
            return None
        day = row.get("day")
        closed = row.get("closed")
        if not isinstance(day, str) or day not in _SCHEMA_DAY_URLS or not isinstance(closed, bool):
            return None
        if closed:
            continue  # absent from the spec == closed, the schema.org convention this relies on
        value = row.get("value")
        if not isinstance(value, str):
            return None
        match = _HOURS_RANGE_RE.fullmatch(value)
        if match is None:
            # ANY open day failing to parse aborts the whole block -- see module docstring.
            return None
        opens_h, opens_m, closes_h, closes_m = match.groups()
        specs.append(
            {
                "@type": "OpeningHoursSpecification",
                "dayOfWeek": _SCHEMA_DAY_URLS[day],
                "opens": f"{opens_h}:{opens_m}",
                "closes": f"{closes_h}:{closes_m}",
            }
        )

    return specs if specs else None


def _is_nonempty_str(value: object) -> bool:
    return isinstance(value, str) and value != ""
