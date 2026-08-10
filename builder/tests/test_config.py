from __future__ import annotations

import json
from pathlib import Path

from builder.config import (
    AdminCollection,
    AdminField,
    AdminFieldOption,
    AdminSection,
    load_project_config,
)

_MINIMAL_PROJECT: dict[str, object] = {
    "slug": "ca",
    "name": "Cottage Aesthetics",
    "repo": "https://github.com/example/ca-site.git",
    "defaultBranch": "main",
    "cmdProject": "ca",
    "domain": "ca.cinnamons.uk",
    "locale": "en-GB",
    "indexable": True,
}


def _write(tmp_path: Path, data: dict[str, object]) -> Path:
    path = tmp_path / "project.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


class TestAdminSectionsAbsent:
    def test_no_adminSections_key_defaults_to_empty_tuple(self, tmp_path: Path) -> None:
        config = load_project_config(_write(tmp_path, dict(_MINIMAL_PROJECT)))

        assert config.admin_sections == ()

    def test_a_non_list_adminSections_value_defaults_to_empty_tuple(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = "not a list"

        config = load_project_config(_write(tmp_path, data))

        assert config.admin_sections == ()


class TestAdminSectionsWellFormed:
    def test_a_full_section_parses_every_field(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "before-after",
                "navLabel": "Before & After",
                "title": "Before & After",
                "description": "Drag to reorder.",
                "page": "gallery",
                "collections": [
                    {
                        "path": "gallery.sliders",
                        "label": "Drag-to-compare photos",
                        "itemNoun": "photo pair",
                        "schema": "gallery-slider",
                        "fields": [
                            {"key": "before", "kind": "image", "label": "Before photo"},
                            {"key": "title", "kind": "text", "label": "Treatment name"},
                            {
                                "key": "cat",
                                "kind": "choice",
                                "label": "Category",
                                "options": [
                                    {"value": "lips", "label": "Lips"},
                                    {"value": "cheeks", "label": "Cheeks"},
                                ],
                            },
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        assert config.admin_sections == (
            AdminSection(
                id="before-after",
                nav_label="Before & After",
                title="Before & After",
                description="Drag to reorder.",
                page="gallery",
                collections=(
                    AdminCollection(
                        path="gallery.sliders",
                        label="Drag-to-compare photos",
                        item_noun="photo pair",
                        schema="gallery-slider",
                        fields=(
                            AdminField(key="before", kind="image", label="Before photo"),
                            AdminField(key="title", kind="text", label="Treatment name"),
                            AdminField(
                                key="cat",
                                kind="choice",
                                label="Category",
                                options=(
                                    AdminFieldOption(value="lips", label="Lips"),
                                    AdminFieldOption(value="cheeks", label="Cheeks"),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )

    def test_a_field_with_no_options_key_defaults_to_empty_tuple(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [{"key": "title", "kind": "text", "label": "Title"}],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        field = config.admin_sections[0].collections[0].fields[0]
        assert field.options == ()

    def test_a_section_with_no_collections_key_defaults_to_empty_tuple(
        self, tmp_path: Path
    ) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {"id": "s", "navLabel": "S", "title": "S", "description": "d", "page": "p"}
        ]

        config = load_project_config(_write(tmp_path, data))

        assert config.admin_sections[0].collections == ()

    def test_multiple_sections_all_parse_in_order(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {"id": "a", "navLabel": "A", "title": "A", "description": "d", "page": "p"},
            {"id": "b", "navLabel": "B", "title": "B", "description": "d", "page": "p"},
        ]

        config = load_project_config(_write(tmp_path, data))

        assert [s.id for s in config.admin_sections] == ["a", "b"]


class TestAdminSectionsLenientParsing:
    """Inv 1 / spec 3a: "missing/malformed section -> skip with a warning" —
    one bad entry never takes down the whole project config load."""

    def test_a_section_missing_a_required_field_is_skipped(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {"id": "bad", "navLabel": "Bad", "title": "Bad", "description": "d"},  # no "page"
            {"id": "good", "navLabel": "Good", "title": "Good", "description": "d", "page": "p"},
        ]

        config = load_project_config(_write(tmp_path, data))

        assert [s.id for s in config.admin_sections] == ["good"]

    def test_a_section_that_is_not_an_object_is_skipped(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = ["not an object"]

        config = load_project_config(_write(tmp_path, data))

        assert config.admin_sections == ()

    def test_a_collection_missing_a_required_field_is_skipped_not_the_section(
        self, tmp_path: Path
    ) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {"path": "p.bad", "label": "Bad"},  # no itemNoun/schema
                    {"path": "p.good", "label": "Good", "itemNoun": "item", "schema": "sch"},
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        assert [c.path for c in config.admin_sections[0].collections] == ["p.good"]

    def test_a_field_with_an_unknown_kind_is_skipped_not_the_collection(
        self, tmp_path: Path
    ) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [
                            {"key": "bad", "kind": "video", "label": "Bad"},
                            {"key": "good", "kind": "text", "label": "Good"},
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        keys = [f.key for f in config.admin_sections[0].collections[0].fields]
        assert keys == ["good"]

    def test_an_option_missing_a_required_field_is_skipped_not_the_field(
        self, tmp_path: Path
    ) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [
                            {
                                "key": "cat",
                                "kind": "choice",
                                "label": "Category",
                                "options": [
                                    {"value": "lips"},  # no label
                                    {"value": "cheeks", "label": "Cheeks"},
                                ],
                            }
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        field = config.admin_sections[0].collections[0].fields[0]
        assert [o.value for o in field.options] == ["cheeks"]


class TestFieldKindAndCapabilities:
    def test_a_toggle_kind_field_parses(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [
                            {"key": "visible", "kind": "toggle", "label": "Show on site"},
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        field = config.admin_sections[0].collections[0].fields[0]
        assert field == AdminField(key="visible", kind="toggle", label="Show on site")

    def test_a_url_kind_field_parses(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [
                            {"key": "sourceUrl", "kind": "url", "label": "Original post link"},
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        field = config.admin_sections[0].collections[0].fields[0]
        assert field == AdminField(key="sourceUrl", kind="url", label="Original post link")

    def test_a_choice_field_with_options_from_parses(self, tmp_path: Path) -> None:
        """decisions/00124: a choice field's options can come from another
        collection's live content instead of a static `options` array."""
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [
                            {
                                "key": "cat",
                                "kind": "choice",
                                "label": "Category",
                                "optionsFrom": "p.cats",
                            },
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        field = config.admin_sections[0].collections[0].fields[0]
        assert field == AdminField(
            key="cat", kind="choice", label="Category", options_source="p.cats"
        )

    def test_a_required_field_parses(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [
                            {"key": "title", "kind": "text", "label": "Name", "required": True},
                        ],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        field = config.admin_sections[0].collections[0].fields[0]
        assert field == AdminField(key="title", kind="text", label="Name", required=True)

    def test_required_defaults_false(self, tmp_path: Path) -> None:
        data = dict(_MINIMAL_PROJECT)
        data["adminSections"] = [
            {
                "id": "s",
                "navLabel": "S",
                "title": "S",
                "description": "d",
                "page": "p",
                "collections": [
                    {
                        "path": "p.items",
                        "label": "Items",
                        "itemNoun": "item",
                        "schema": "sch",
                        "fields": [{"key": "sub", "kind": "text", "label": "Sub"}],
                    }
                ],
            }
        ]

        config = load_project_config(_write(tmp_path, data))

        assert config.admin_sections[0].collections[0].fields[0].required is False


def _section_with_collection(collection: dict[str, object]) -> dict[str, object]:
    data = dict(_MINIMAL_PROJECT)
    data["adminSections"] = [
        {
            "id": "s",
            "navLabel": "S",
            "title": "S",
            "description": "d",
            "page": "p",
            "collections": [
                {
                    "path": "p.items",
                    "label": "Items",
                    "itemNoun": "item",
                    "schema": "s",
                    **collection,
                }
            ],
        }
    ]
    return data


class TestAlignAspectParsing:
    """decisions/00111: a collection's optional `alignAspect` "W:H" feeds the
    before/after aligner's frame — absent or malformed must read as None
    (aligner simply not offered), never crash the whole config load."""

    def test_absent_alignAspect_reads_as_none(self, tmp_path: Path) -> None:
        config = load_project_config(_write(tmp_path, _section_with_collection({})))

        assert config.admin_sections[0].collections[0].align_aspect is None

    def test_a_well_formed_aspect_parses_to_a_width_height_tuple(self, tmp_path: Path) -> None:
        config = load_project_config(
            _write(tmp_path, _section_with_collection({"alignAspect": "640:360"}))
        )

        assert config.admin_sections[0].collections[0].align_aspect == (640, 360)

    def test_malformed_aspects_read_as_none(self, tmp_path: Path) -> None:
        for bad in ("640", "640x360", "a:b", "640:", ":360", "640:360:1", "-640:360", "0:360"):
            data = _section_with_collection({"alignAspect": bad})

            config = load_project_config(_write(tmp_path, data))

            assert config.admin_sections[0].collections[0].align_aspect is None, bad

    def test_a_non_string_aspect_reads_as_none(self, tmp_path: Path) -> None:
        config = load_project_config(
            _write(tmp_path, _section_with_collection({"alignAspect": 640}))
        )

        assert config.admin_sections[0].collections[0].align_aspect is None


class TestTabParsing:
    """decisions/00125: a collection's optional `tab` groups it under a named
    tab within its section's panel — absent or malformed must read as None
    (the collection simply joins the section's default, untabbed group)."""

    def test_absent_tab_reads_as_none(self, tmp_path: Path) -> None:
        config = load_project_config(_write(tmp_path, _section_with_collection({})))

        assert config.admin_sections[0].collections[0].tab is None

    def test_a_string_tab_parses_through(self, tmp_path: Path) -> None:
        config = load_project_config(
            _write(tmp_path, _section_with_collection({"tab": "Photos"}))
        )

        assert config.admin_sections[0].collections[0].tab == "Photos"

    def test_a_non_string_tab_reads_as_none(self, tmp_path: Path) -> None:
        config = load_project_config(_write(tmp_path, _section_with_collection({"tab": 640})))

        assert config.admin_sections[0].collections[0].tab is None
