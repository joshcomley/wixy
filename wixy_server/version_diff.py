"""`GET /api/admin/publishes/{version}/diff`'s computation (decisions/00070):
what a ledger version actually CHANGED on the live site when it went live, as
old→new per content key, in the same `{changes: {file_key: [{key, kind, old,
new}]}}` shape `GET /api/admin/publish/preview` returns for the draft — so the
admin UI renders both with one shared component.

The ledger's own `changed` summary (`publisher._changed_summary`) can't serve
this: it records only the editor-lane overlay ops (never upstream/AI-lane
merges) and only their key NAMES, not values. Diffing the version's own SHA
against the PREVIOUS LEDGER ENTRY's SHA covers both lanes uniformly — the
ledger's append order is the "what was live when" order (a restore appends a
new highest-version entry carrying the restored-to SHA), so the SHA-to-SHA
diff is exactly "what changed on the live site when this version went live".
That also gives restore entries — which record no `changed` at all — a
meaningful diff for free.

Mechanism is `restore.worktree_at_sha` (the same scratch-worktree checkout
`ensure_build` uses) + `build_site_source`: builder's loading functions are
Path-based, so a real worktree is the sanctioned way to read historical
content (restore.py's module docstring, decisions/00024). Binding kinds come
from the NEWER version's own templates, so a key renders with the kind it had
at the time rather than today's.

`binding_kind_lookup`/`container_for` live here (not in routes_admin_api.py)
because both diff producers need them: the publish preview (draft overlay vs
live) and this module (version vs version).
"""

from __future__ import annotations

from builder.bindings_map import extract_bindings_map
from builder.config import ProjectConfig
from builder.content import GLOBAL_CONTENT_NAME
from builder.jsontypes import JsonObject, JsonValue
from builder.render import SiteSource
from builder.theme import theme_to_dict
from wixy_server.ledger import read_ledger
from wixy_server.restore import worktree_at_sha
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths


def binding_kind_lookup(merged: SiteSource) -> dict[str, dict[str, str]]:
    """`{file_key: {dotted_key: kind}}` for every page's own bindings, plus one
    shared `_global` entry. `theme` keys have no bindings-map entry at all
    (spec's theme model is a separate typed thing, never walked via `data-wx-*`
    attributes) — the caller reports `"theme"` directly instead.

    Keys are NORMALIZED: the bindings map keeps the template's `@` global-scope
    marker (`data-wx-list="@hours"` → key `@hours`), but draft ops and content
    JSON paths address the same field without it (`_global:hours`). Stripping a
    leading `@` here reconciles the two — without it every global binding's
    kind misses and falls back to `"text"`, which is how a whole-array global
    list op (opening hours) rendered as a raw JSON dump in the review drawer
    (decisions/00079).

    The `_global` bucket is the UNION of every page's global (`@`-prefixed)
    fields — a global binding is only bound on the pages that use it (the CA
    site binds `@hours` on index + contact but NOT about), so copying any one
    page's map would miss every global that page doesn't bind."""
    lookup: dict[str, dict[str, str]] = {}
    global_fields: dict[str, str] = {}
    for slug in merged.page_contents:
        bindings = extract_bindings_map(merged, slug)
        page_map: dict[str, str] = {}
        for field in bindings.fields:
            if field.key.startswith("@"):
                key = field.key[1:]
                page_map[key] = field.kind
                global_fields.setdefault(key, field.kind)
            else:
                page_map[field.key] = field.kind
        lookup[slug] = page_map
    lookup[GLOBAL_CONTENT_NAME] = global_fields
    return lookup


def container_for(source: SiteSource, file_key: str) -> JsonValue:
    if file_key == "theme":
        return theme_to_dict(source.theme) if source.theme is not None else None
    if file_key == GLOBAL_CONTENT_NAME:
        return source.global_content
    return source.page_contents.get(file_key)


def _diff_entries(
    baseline: JsonValue, target: JsonValue, prefix: str, out: list[tuple[str, JsonValue, JsonValue]]
) -> None:
    """`restore._diff_content`'s recursion, but recording `(dotted_path, old,
    new)` triples instead of just the target value — dicts recurse, everything
    else (strings/numbers/bools/lists/`None`) compares atomically, so
    a list-valued key is ONE whole-array entry, the same "whole-array op"
    granularity spec/04 §5 and the publish preview both use. A dict on only
    one side (a subtree added/removed wholesale, e.g. every leaf of the
    first-ever version) recurses against `{}` so the leaves report
    individually with `None` on the missing side; only a genuine TYPE change
    (scalar/list ↔ dict) reports as one entry at the subtree's root."""
    if isinstance(baseline, dict) and isinstance(target, dict):
        for key in sorted(set(baseline) | set(target)):
            child_prefix = f"{prefix}.{key}" if prefix else key
            _diff_entries(baseline.get(key), target.get(key), child_prefix, out)
        return
    if isinstance(target, dict) and baseline is None:
        _diff_entries({}, target, prefix, out)
        return
    if isinstance(baseline, dict) and target is None:
        _diff_entries(baseline, {}, prefix, out)
        return
    if baseline != target:
        out.append((prefix, baseline, target))


def _diff_group(
    old_source: SiteSource | None,
    new_source: SiteSource,
    file_key: str,
    kinds: dict[str, dict[str, str]],
) -> list[JsonValue]:
    """The `changes` entries for one file_key, or `[]` when the group has no
    differences (the caller omits empty groups). A container absent on one
    side (a page added/removed between the two versions, or a theme file that
    didn't exist yet) diffs as `{}` so every leaf reports individually with
    `None` on the missing side."""
    old_container = container_for(old_source, file_key) if old_source is not None else None
    new_container = container_for(new_source, file_key)
    if old_container is None and new_container is None:
        return []
    old_dict: JsonObject = old_container if isinstance(old_container, dict) else {}
    new_dict: JsonObject = new_container if isinstance(new_container, dict) else {}
    triples: list[tuple[str, JsonValue, JsonValue]] = []
    _diff_entries(old_dict, new_dict, "", triples)
    return [
        {
            "key": dotted_path,
            "kind": (
                "theme" if file_key == "theme" else kinds.get(file_key, {}).get(dotted_path, "text")
            ),
            "old": old_value,
            "new": new_value,
        }
        for dotted_path, old_value, new_value in triples
    ]


def build_version_diff(
    project: ProjectConfig, paths: ProjectPaths, version: int
) -> JsonObject | None:
    """`{version, of, changes}` for the ledger entry `version`, or `None` when
    no such version exists (the route maps that to a 404). `of` is the
    previous ledger entry's version (the baseline the diff is computed
    against), `None` for the first entry ever recorded."""
    entries = read_ledger(paths)
    index = next((i for i, entry in enumerate(entries) if entry.version == version), None)
    if index is None:
        return None
    entry = entries[index]
    previous = entries[index - 1] if index > 0 else None

    with worktree_at_sha(paths, entry.sha) as scratch:
        new_source = build_site_source(project, scratch)
        # Binding kinds must be computed INSIDE the block: content JSONs are
        # read eagerly by `build_site_source`, but templates are only read
        # lazily by `extract_bindings_map` — after the `with` exits the
        # scratch worktree is gone and template reads would fail.
        kinds = binding_kind_lookup(new_source)
    old_source: SiteSource | None = None
    if previous is not None:
        with worktree_at_sha(paths, previous.sha) as scratch:
            old_source = build_site_source(project, scratch)
    old_pages = set(old_source.page_contents) if old_source is not None else set()
    file_keys = sorted(old_pages | set(new_source.page_contents))
    file_keys.append(GLOBAL_CONTENT_NAME)
    if (old_source is not None and old_source.theme is not None) or new_source.theme is not None:
        file_keys.append("theme")

    changes: dict[str, JsonValue] = {}
    for file_key in file_keys:
        group = _diff_group(old_source, new_source, file_key, kinds)
        if group:
            changes[file_key] = group
    return {
        "version": entry.version,
        "of": previous.version if previous is not None else None,
        "changes": changes,
    }
