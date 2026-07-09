"""Draft preview rendering + editor-asset injection (spec/04-server.md §4).

`render_preview_page` takes a `SiteSource` that already has the draft overlay merged
onto it (`wixy_server.merged_content.merge_overlay`, slice 2) — merging is the caller's
job (the route handler: checkout -> load overlay -> load_site_source -> merge_overlay
-> this module), so this module only does two things: render in preview mode, then
inject the editor's script/CSS + the page's bindings-map blob into the returned HTML
STRING. Kept out of `builder/`, which has zero server imports by design (spec/04 §1).
"""

from __future__ import annotations

import json

from bs4 import BeautifulSoup, Tag

from builder.bindings_map import PageBindings, bindings_map_to_dict, extract_bindings_map
from builder.errors import BuildError
from builder.jsontypes import JsonObject
from builder.render import SiteSource, render_page

EDITOR_SCRIPT_PATH = "/admin/static/editor/editor.js"
EDITOR_STYLESHEET_PATH = "/admin/static/editor/editor.css"
BINDINGS_SCRIPT_ID = "wx-bindings"

# Escape the characters that are significant to an HTML parser (not to JSON) before
# embedding JSON inside a <script> element — a content value containing a literal
# "</script" would otherwise prematurely close the tag when a browser parses it,
# regardless of JSON-string quoting (the HTML tokenizer doesn't know about JSON
# escaping). Same technique as Django's `json_script` filter.
_JSON_SCRIPT_ESCAPES = (("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"))


def _json_for_script_tag(data: JsonObject) -> str:
    text = json.dumps(data)
    for char, escaped in _JSON_SCRIPT_ESCAPES:
        text = text.replace(char, escaped)
    return text


def _inject_editor_assets(html: str, bindings: PageBindings) -> str:
    soup = BeautifulSoup(html, "html5lib")
    head = soup.head
    body = soup.body
    if not isinstance(head, Tag) or not isinstance(body, Tag):
        # render_page always produces a <head> and <body> (it raises BuildError itself
        # otherwise) — this is a defensive invariant check, not an expected path.
        raise BuildError("rendered preview HTML is missing <head> or <body>")

    css_link = soup.new_tag("link")
    css_link["rel"] = "stylesheet"
    css_link["href"] = EDITOR_STYLESHEET_PATH
    head.append(css_link)

    # Bindings blob before editor.js, in document order: a plain (non-deferred)
    # <script src=...> executes synchronously as the parser reaches it, so editor.js's
    # top-level code can rely on #wx-bindings already being in the DOM only if it's
    # the earlier sibling.
    bindings_tag = soup.new_tag(
        "script", attrs={"type": "application/json", "id": BINDINGS_SCRIPT_ID}
    )
    bindings_tag.string = _json_for_script_tag(bindings_map_to_dict(bindings))
    body.append(bindings_tag)

    editor_tag = soup.new_tag("script", attrs={"src": EDITOR_SCRIPT_PATH})
    body.append(editor_tag)

    return str(soup)


def render_preview_page(source: SiteSource, slug: str) -> str:
    """The full `GET /admin/preview/{page}.html` render (spec/04 §4): `source` must
    already be the overlay-merged content (see module docstring). Renders in preview
    mode (falsy `data-wx-if` retained, hidden — 02 §2) and injects the editor's
    script/CSS + this page's bindings-map blob."""
    html = render_page(source, slug, mode="preview")
    bindings = extract_bindings_map(source, slug)
    return _inject_editor_assets(html, bindings)
