"""Homepage JSON-LD tests (decisions/00139, Inv 38). `TestRealProductionShape` uses the
actual `cottage-aesthetics-preview` `_global.json` values (fetched live 2026-08-13) as one
scenario, so a change here is checked against the real deployment, not just synthetic data.
"""

from __future__ import annotations

import dataclasses
import json

import pytest
from bs4 import BeautifulSoup, Tag

from builder.config import MediaConfig, ProjectConfig
from builder.jsontypes import JsonObject, JsonValue
from builder.structureddata import build_structured_data, inject_structured_data


def _graph_nodes(graph: JsonObject) -> list[JsonValue]:
    """Narrows `graph["@graph"]` (typed `JsonValue`) down to a real list -- same
    isinstance-narrow-don't-guess idiom `builder/` itself uses throughout."""
    nodes = graph["@graph"]
    assert isinstance(nodes, list)
    return nodes


def _local_business(graph: JsonObject) -> JsonObject:
    """The second `@graph` entry, narrowed to a real `JsonObject` via `isinstance`, once,
    so every test below can index into the result without mypy losing the plot at each
    `[...]` step."""
    node = _graph_nodes(graph)[1]
    assert isinstance(node, dict)
    return node


def _rendered_ld_json(soup: BeautifulSoup) -> JsonObject:
    """The `<script type="application/ld+json">` `inject_structured_data` appended,
    parsed back from its raw text -- always a JSON object (`{"@context":..., "@graph":
    ...}`), same isinstance-narrow `builder/content.py:load_json_object` already uses for
    the exact same "json.loads returns Any" reason."""
    head = soup.head
    assert head is not None
    script = head.find("script", attrs={"type": "application/ld+json"})
    assert isinstance(script, Tag)
    assert script.string is not None
    parsed = json.loads(script.string)
    assert isinstance(parsed, dict)
    return parsed


@pytest.fixture
def indexable_project() -> ProjectConfig:
    return ProjectConfig(
        slug="test",
        name="Test Business",
        repo="https://example.invalid/test.git",
        default_branch="main",
        cmd_project="test",
        domain="test.example.invalid",
        locale="en-GB",
        indexable=True,
        media=MediaConfig(max_long_side_px=2000, jpeg_quality=85),
    )


@pytest.fixture
def non_indexable_project(indexable_project: ProjectConfig) -> ProjectConfig:
    return dataclasses.replace(indexable_project, indexable=False)


class TestIndexableGate:
    """Inv 35's own precedent: a non-indexable build emits NOTHING, not a noindex-flagged
    version of the graph."""

    def test_non_indexable_returns_none(self, non_indexable_project: ProjectConfig) -> None:
        graph, warnings = build_structured_data(non_indexable_project, {})
        assert graph is None
        assert warnings == []

    def test_non_indexable_ignores_a_present_business_block(
        self, non_indexable_project: ProjectConfig
    ) -> None:
        graph, _ = build_structured_data(non_indexable_project, {"business": {"types": ["DaySpa"]}})
        assert graph is None

    def test_indexable_with_no_business_block_emits_website_only(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, warnings = build_structured_data(indexable_project, {})
        assert graph is not None
        assert graph["@context"] == "https://schema.org"
        assert graph["@graph"] == [
            {"@type": "WebSite", "name": "Test Business", "url": "https://test.example.invalid/"}
        ]
        assert warnings == []


class TestLocalBusinessTypes:
    def test_single_type_is_a_bare_string(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(indexable_project, {"business": {"types": ["DaySpa"]}})
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["@type"] == "DaySpa"

    def test_multiple_types_is_a_list(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(
            indexable_project,
            {"business": {"types": ["HealthAndBeautyBusiness", "MedicalBusiness"]}},
        )
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["@type"] == ["HealthAndBeautyBusiness", "MedicalBusiness"]

    @pytest.mark.parametrize(
        "business",
        [
            {},
            {"types": []},
            {"types": "DaySpa"},
            {"types": [""]},
            {"types": [123]},
            {"types": None},
        ],
    )
    def test_malformed_or_missing_types_emits_no_local_business_node(
        self, indexable_project: ProjectConfig, business: JsonObject
    ) -> None:
        graph, warnings = build_structured_data(indexable_project, {"business": business})
        assert graph is not None
        assert len(_graph_nodes(graph)) == 1  # WebSite only
        assert warnings == []

    def test_business_not_a_dict_is_ignored(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(indexable_project, {"business": "not a dict"})
        assert graph is not None
        assert len(_graph_nodes(graph)) == 1


class TestContactFields:
    def test_phone_and_email_included_when_present(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(
            indexable_project,
            {
                "business": {"types": ["DaySpa"]},
                "phone": "07401 562 462",
                "email": "hello@example.invalid",
            },
        )
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["telephone"] == "07401 562 462"
        assert local_business["email"] == "hello@example.invalid"

    def test_absent_phone_and_email_are_simply_omitted(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, _ = build_structured_data(indexable_project, {"business": {"types": ["DaySpa"]}})
        assert graph is not None
        local_business = _local_business(graph)
        assert "telephone" not in local_business
        assert "email" not in local_business


class TestSameAs:
    def test_both_social_urls_included(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(
            indexable_project,
            {
                "business": {"types": ["DaySpa"]},
                "social": {
                    "instagram": "https://www.instagram.com/x",
                    "facebook": "https://www.facebook.com/x",
                },
            },
        )
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["sameAs"] == [
            "https://www.instagram.com/x",
            "https://www.facebook.com/x",
        ]

    def test_no_social_block_omits_same_as(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(indexable_project, {"business": {"types": ["DaySpa"]}})
        assert graph is not None
        assert "sameAs" not in _local_business(graph)


class TestAddress:
    def test_matching_structured_address_used_as_is_no_warning(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {
                    "types": ["DaySpa"],
                    "address": {
                        "streetAddress": "1 Test Street",
                        "addressLocality": "Testville",
                        "postalCode": "TE1 1ST",
                        "addressCountry": "GB",
                    },
                },
                "address": "1 Test Street,<br>Testville,<br>TE1 1ST",
            },
        )
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["address"] == {
            "@type": "PostalAddress",
            "streetAddress": "1 Test Street",
            "addressLocality": "Testville",
            "postalCode": "TE1 1ST",
            "addressCountry": "GB",
        }
        assert warnings == []

    def test_drifted_field_degrades_to_plain_string_and_warns(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {
                    "types": ["DaySpa"],
                    "address": {
                        "streetAddress": "1 Test Street",
                        "addressLocality": "Wrongtown",  # doesn't match visible text below
                        "postalCode": "TE1 1ST",
                        "addressCountry": "GB",
                    },
                },
                "address": "1 Test Street,<br>Testville,<br>TE1 1ST",
            },
        )
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["address"] == "1 Test Street, Testville, TE1 1ST"
        assert len(warnings) == 1
        assert "addressLocality" in warnings[0]

    def test_address_country_never_checked_against_visible_text(
        self, indexable_project: ProjectConfig
    ) -> None:
        """A UK-local business's on-page address never displays "GB" -- requiring it as a
        substring would fail even on genuinely correct data (module docstring)."""
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {
                    "types": ["DaySpa"],
                    "address": {
                        "streetAddress": "1 Test Street",
                        "addressLocality": "Testville",
                        "postalCode": "TE1 1ST",
                        "addressCountry": "GB",
                    },
                },
                "address": "1 Test Street,<br>Testville,<br>TE1 1ST",  # no "GB" anywhere
            },
        )
        assert graph is not None
        assert warnings == []
        address = _local_business(graph)["address"]
        assert isinstance(address, dict)
        assert address["addressCountry"] == "GB"

    def test_no_structured_address_and_no_visible_address_omits_the_field(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, warnings = build_structured_data(
            indexable_project, {"business": {"types": ["DaySpa"]}}
        )
        assert graph is not None
        assert "address" not in _local_business(graph)
        assert warnings == []

    def test_authored_address_used_as_is_when_no_visible_address_text_exists(
        self, indexable_project: ProjectConfig
    ) -> None:
        """A genuinely authored `business.address` must not be discarded just because
        `_global.json.address` is empty/absent (partial-migration state, Inv 5, or a
        site that simply hasn't authored the visible text yet) -- there is nothing to
        compare against, which is not the same as every field having drifted."""
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {
                    "types": ["DaySpa"],
                    "address": {
                        "streetAddress": "1 Test Street",
                        "addressLocality": "Testville",
                        "postalCode": "TE1 1ST",
                        "addressCountry": "GB",
                    },
                },
                # no "address" key at all in _global.json
            },
        )
        assert graph is not None
        local_business = _local_business(graph)
        assert local_business["address"] == {
            "@type": "PostalAddress",
            "streetAddress": "1 Test Street",
            "addressLocality": "Testville",
            "postalCode": "TE1 1ST",
            "addressCountry": "GB",
        }
        assert warnings == []

    def test_address_with_no_geographic_fields_is_omitted_and_warns(
        self, indexable_project: ProjectConfig
    ) -> None:
        """A typo'd key (e.g. "street" instead of "streetAddress") or an address block
        with only addressCountry authored must never silently emit a near-useless,
        country-only PostalAddress -- it's flagged instead, same as any other malformed
        authoring (never fabricated, per the module's own governing philosophy)."""
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {
                    "types": ["DaySpa"],
                    "address": {"street": "1 Test Street", "addressCountry": "GB"},
                },
                "address": "1 Test Street,<br>Testville,<br>TE1 1ST",
            },
        )
        assert graph is not None
        assert "address" not in _local_business(graph)
        assert len(warnings) == 1
        assert "streetAddress" in warnings[0]

    def test_visible_address_html_is_stripped_to_plain_text_on_degrade(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {
                    "types": ["DaySpa"],
                    "address": {"streetAddress": "does not appear anywhere"},
                },
                "address": "Line one,<br>Line two,<br>Line three",
            },
        )
        assert graph is not None
        assert _local_business(graph)["address"] == "Line one, Line two, Line three"
        assert len(warnings) == 1


class TestOpeningHours:
    _OPEN_MONDAY: JsonObject = {"day": "Monday", "value": "10:00 – 17:00", "closed": False}
    _CLOSED_WEDNESDAY: JsonObject = {"day": "Wednesday", "value": "Closed", "closed": True}

    def test_valid_hours_produce_a_full_specification(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, _ = build_structured_data(
            indexable_project,
            {
                "business": {"types": ["DaySpa"]},
                "hours": [self._OPEN_MONDAY, self._CLOSED_WEDNESDAY],
            },
        )
        assert graph is not None
        spec = _local_business(graph)["openingHoursSpecification"]
        assert spec == [
            {
                "@type": "OpeningHoursSpecification",
                "dayOfWeek": "https://schema.org/Monday",
                "opens": "10:00",
                "closes": "17:00",
            }
        ]

    def test_closed_days_are_simply_absent_not_zero_length(
        self, indexable_project: ProjectConfig
    ) -> None:
        graph, _ = build_structured_data(
            indexable_project,
            {"business": {"types": ["DaySpa"]}, "hours": [self._CLOSED_WEDNESDAY]},
        )
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)

    def test_one_unparseable_open_day_drops_the_whole_specification(
        self, indexable_project: ProjectConfig
    ) -> None:
        """All-or-nothing (module docstring): partial emission would assert a false
        closure for the day that failed to parse."""
        bad_row: JsonObject = {"day": "Tuesday", "value": "By appointment", "closed": False}
        graph, _ = build_structured_data(
            indexable_project,
            {"business": {"types": ["DaySpa"]}, "hours": [self._OPEN_MONDAY, bad_row]},
        )
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)

    @pytest.mark.parametrize(
        "value",
        [
            "10:00-17:00",  # hyphen, not en dash -- grammar is exact
            "10:00 - 17:00",  # hyphen with spaces
            "10:00–17:00",  # en dash, no surrounding spaces
            "10:00  –  17:00",  # double spaces
            "10am – 5pm",
            "24:00 – 25:00",  # out of range
            "",
        ],
    )
    def test_near_miss_formats_are_rejected_not_fuzzy_matched(
        self, indexable_project: ProjectConfig, value: str
    ) -> None:
        row: JsonObject = {"day": "Monday", "value": value, "closed": False}
        graph, _ = build_structured_data(
            indexable_project, {"business": {"types": ["DaySpa"]}, "hours": [row]}
        )
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)

    def test_unknown_day_name_drops_the_whole_specification(
        self, indexable_project: ProjectConfig
    ) -> None:
        row: JsonObject = {"day": "Someday", "value": "10:00 – 17:00", "closed": False}
        graph, _ = build_structured_data(
            indexable_project, {"business": {"types": ["DaySpa"]}, "hours": [row]}
        )
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)

    def test_non_bool_closed_drops_the_whole_specification(
        self, indexable_project: ProjectConfig
    ) -> None:
        row: JsonObject = {"day": "Monday", "value": "10:00 – 17:00", "closed": "false"}
        graph, _ = build_structured_data(
            indexable_project, {"business": {"types": ["DaySpa"]}, "hours": [row]}
        )
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)

    def test_absent_hours_field_omits_the_key(self, indexable_project: ProjectConfig) -> None:
        graph, _ = build_structured_data(indexable_project, {"business": {"types": ["DaySpa"]}})
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)

    def test_all_seven_days_closed_omits_the_key_not_an_empty_list(
        self, indexable_project: ProjectConfig
    ) -> None:
        all_closed: list[JsonValue] = [
            {"day": d, "value": "Closed", "closed": True}
            for d in (
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
            )
        ]
        graph, _ = build_structured_data(
            indexable_project, {"business": {"types": ["DaySpa"]}, "hours": all_closed}
        )
        assert graph is not None
        assert "openingHoursSpecification" not in _local_business(graph)


class TestInjectStructuredData:
    def test_script_tag_is_appended_with_valid_round_trippable_json(self) -> None:
        soup = BeautifulSoup("<html><head></head><body></body></html>", "html5lib")
        graph: JsonObject = {"@context": "https://schema.org", "@graph": [{"@type": "WebSite"}]}
        inject_structured_data(soup, graph, file_label="pages/index.html")
        assert _rendered_ld_json(soup) == graph

    def test_special_characters_are_not_html_escaped(self) -> None:
        """A `<`/`&`/`"` inside a JSON string value must stay valid JSON, not be turned
        into HTML entities the way ordinary bs4 text content would be."""
        soup = BeautifulSoup("<html><head></head><body></body></html>", "html5lib")
        graph: JsonObject = {
            "@context": "https://schema.org",
            "@graph": [{"name": '<Tom & "Jerry">'}],
        }
        inject_structured_data(soup, graph, file_label="pages/index.html")
        assert _rendered_ld_json(soup) == graph

    def test_script_tag_breakout_payload_cannot_escape_the_script(self) -> None:
        """decisions/00139's registered follow-up: a value sourced from `_global.json`
        (social links, phone, email, business.address.* -- none HTML-sanitized on the
        way in, per `draft_sanitize.py`) containing a literal `</script>` must never be
        able to break out of this `<script>` tag and inject an executing sibling
        element -- on the public homepage AND the same-origin, authenticated
        `/admin/preview/*` surface. `json.dumps`/BeautifulSoup do not escape this on
        their own (`<script>` content is raw text, never HTML-entity-escaped on
        serialization)."""
        soup = BeautifulSoup("<html><head></head><body></body></html>", "html5lib")
        payload = "</script><script>window.pwned=1</script>"
        graph: JsonObject = {"@context": "https://schema.org", "@graph": [{"name": payload}]}
        inject_structured_data(soup, graph, file_label="pages/index.html")

        rendered = str(soup)
        # The rendered HTML must contain exactly one <script type=ld+json> element and
        # no injected sibling <script> -- reparsing the FULL document (not just this
        # tag's own .string) is what actually proves the breakout never happened.
        reparsed = BeautifulSoup(rendered, "html5lib")
        scripts = reparsed.find_all("script")
        assert len(scripts) == 1
        assert scripts[0].get("type") == "application/ld+json"
        # The value still round-trips to the exact original string once genuinely
        # parsed as JSON -- the escaping is purely a serialization-safety measure,
        # not a data-mangling one.
        assert _rendered_ld_json(soup) == graph


class TestRealProductionShape:
    """The actual `cottage-aesthetics-preview` `_global.json` values as of 2026-08-13
    (fetched live from `main`), proving the address/hours shapes this module was designed
    against really do parse cleanly -- not just synthetic test data."""

    def test_real_hours_all_parse(self, indexable_project: ProjectConfig) -> None:
        real_hours: list[JsonValue] = [
            {"closed": False, "day": "Monday", "value": "10:00 – 17:00"},
            {"closed": False, "day": "Tuesday", "value": "11:00 – 19:00"},
            {"closed": True, "day": "Wednesday", "value": "Closed"},
            {"closed": False, "day": "Thursday", "value": "11:00 – 19:00"},
            {"closed": False, "day": "Friday", "value": "10:00 – 16:00"},
            {"closed": False, "day": "Saturday", "value": "11:00 – 16:00"},
            {"closed": True, "day": "Sunday", "value": "Closed"},
        ]
        graph, warnings = build_structured_data(
            indexable_project, {"business": {"types": ["DaySpa"]}, "hours": real_hours}
        )
        assert graph is not None
        spec = _local_business(graph)["openingHoursSpecification"]
        assert isinstance(spec, list)
        assert len(spec) == 5  # 7 days minus 2 closed
        assert warnings == []

    def test_real_address_matches_the_ruled_structured_fields(
        self, indexable_project: ProjectConfig
    ) -> None:
        real_visible_address = (
            "Cottage Aesthetics,<br>8 Walton Road,<br>Hartlebury,<br>Kidderminster,<br>DY10 4JA"
        )
        ruled_structured_address: JsonObject = {
            "streetAddress": "8 Walton Road, Hartlebury",
            "addressLocality": "Kidderminster",
            "postalCode": "DY10 4JA",
            "addressCountry": "GB",
        }
        graph, warnings = build_structured_data(
            indexable_project,
            {
                "business": {"types": ["DaySpa"], "address": ruled_structured_address},
                "address": real_visible_address,
            },
        )
        assert graph is not None
        assert _local_business(graph)["address"] == {
            "@type": "PostalAddress",
            **ruled_structured_address,
        }
        assert warnings == []
