"""Merged-content service — `content = repo files @ origin/main ⊕ overlay`
(spec/02-content-model.md §8's merge rule, spec/04-server.md §3-4).

Both the draft preview renderer and the publisher's materialize step need this
same merge; it lives here rather than duplicated in either. Overlay ops win
per key over whatever the checkout currently has loaded — an upstream (AI-lane)
edit to a key nobody has drafted flows straight through untouched.
"""

from __future__ import annotations

import copy
import dataclasses

from builder.content import GLOBAL_CONTENT_NAME, dotted_set
from builder.jsontypes import JsonObject
from builder.render import SiteSource
from builder.theme import theme_from_dict, theme_to_dict
from wixy_server.overlay import Overlay


def merge_overlay(source: SiteSource, overlay: Overlay) -> SiteSource:
    """Apply every op in `overlay.ops` onto a copy of `source`'s content.

    Op keys are `<file>:<dotted.path>` (spec/02 §8) — `<file>` is a page slug,
    `_global`, or `theme`. An op targeting a page slug that doesn't exist in
    `source.page_contents` (e.g. the page was deleted upstream since the draft
    was made) is skipped rather than raising — the same "tolerate a partially
    stale draft" posture as everywhere else content is merged; the editor's own
    UI is what surfaces a dangling reference to the owner, this layer just
    doesn't crash on it.

    A page staged in `overlay.pages_added` (milestone 9 slice 4's page
    duplicate) is seeded here by copying `from_slug`'s CONTENT (not its
    template — that only gets copied at publish-time materialize,
    decisions/00024 decision 4/decisions/00029) so the new slug is a real key
    ops can target and the pages list can show it (meta/navLabel) before it's
    ever published. `pages_deleted` is deliberately NOT filtered out here —
    spec/04 §5's restore paragraph and this feature's own contract both say
    deletion "takes effect at publish," so a staged-for-deletion page keeps
    rendering normally in the draft until then.
    """
    page_contents: dict[str, JsonObject] = {
        slug: copy.deepcopy(content) for slug, content in source.page_contents.items()
    }
    for page_add in overlay.pages_added:
        if page_add.slug not in page_contents and page_add.from_slug in page_contents:
            page_contents[page_add.slug] = copy.deepcopy(page_contents[page_add.from_slug])
    global_content: JsonObject = copy.deepcopy(source.global_content)
    theme_dict: JsonObject | None = (
        theme_to_dict(source.theme) if source.theme is not None else None
    )

    for key, op in overlay.ops.items():
        file_key, sep, dotted_path = key.partition(":")
        if not sep:
            continue  # malformed key (no ':') — ignore rather than crash on a hand-edited overlay

        if file_key == GLOBAL_CONTENT_NAME:
            dotted_set(global_content, dotted_path, op.value)
        elif file_key == "theme":
            if theme_dict is not None:
                dotted_set(theme_dict, dotted_path, op.value)
        elif file_key in page_contents:
            dotted_set(page_contents[file_key], dotted_path, op.value)
        # else: op targets an unknown page slug — skip (see docstring)

    theme = theme_from_dict(theme_dict) if theme_dict is not None else None
    return dataclasses.replace(
        source,
        page_contents=page_contents,
        global_content=global_content,
        theme=theme,
    )
