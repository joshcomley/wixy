"""Deterministic draft self-heal (spec/04-server.md §9, decisions/00095).

`POST /api/admin/draft/repair` — the owner's "Fix it for me" button
(`admin-ui/src/publishDrawer.ts`) when the review drawer shows a blocked
state. Entirely deterministic, no AI in the loop:

1. Every op's value is normalized (`draft_validate.normalize_set_ops`, the
   same pass `PATCH /api/admin/draft` already applies going forward — this
   is what fixes historical corruption written before that gate existed).
2. For an op targeting a known collection (`COLLECTION_RULES` — the exact
   shape the 2026-07-28 incident hit, `gallery.sliders`/`gallery.tiles`),
   each item is checked against the FULL schema (unlike the write gate's
   structural-only check, this includes `pattern` — repair aims to produce
   something actually PUBLISHABLE) AND for image refs that actually resolve
   (decisions/00115 — a well-formed src pointing at a file that isn't there
   passes every schema check ever written, yet is precisely what blocks a
   publish): a failing item first tries filling its MISSING required fields
   from the base checkout's same-index item (no overlay applied); if still
   invalid, the whole item is replaced with that base item; an item with no
   base counterpart at all (added beyond the base array's length) is dropped.
   If the repaired array ends up identical to base, the whole op is DISCARDED
   (an overlay entry identical to base is noise — and critically, unlike
   leaving a same-valued SetOp in place, a discard lets a LATER upstream
   change to that key flow through, Inv 6). An op that step 1's normalize
   alone corrected is written back too — never silently dropped on the way
   out because no ITEM needed repairing.
3. A non-collection op (e.g. `meta.ogImage`) whose image ref still doesn't
   resolve to a real file after normalize is discarded outright — the same
   "never invent a reference" rule normalize itself follows for the
   leading-slash rewrite.
4. The repaired overlay is validated with the same full check the publish
   preview/preflight run (`draft_validate.validate_merged_for_publish`) —
   whatever survives goes back to the owner as `validate.errors`, routing
   the UI to the Report path (a template/binding problem from an upstream
   commit isn't overlay-fixable).

Scope: only the flat `COLLECTION_RULES` table gets item-level repair. The
two NESTED special shapes `draft_validate.check_structural` also polices
(`treatments.sections`' `cards`, `_global.footer.*`) are covered by that
gate GOING FORWARD (a bad op can no longer enter the overlay at all) but
not by this repair pass — historical corruption in those specific shapes
needs the owner's Report path, not an auto-heal.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass

from builder.collections import COLLECTION_RULES
from builder.config import ProjectConfig
from builder.content import dotted_get
from builder.errors import ValidationResult
from builder.jsonschema_lite import validate_against_schema
from builder.jsontypes import JsonObject, JsonValue
from wixy_server.checkout import current_sha
from wixy_server.draft_validate import load_schema, normalize_set_ops, validate_merged_for_publish
from wixy_server.merged_content import merge_overlay
from wixy_server.overlay import (
    DiscardOp,
    Overlay,
    PatchOp,
    RevConflictError,
    SetOp,
    apply_patch,
    load_overlay,
    save_overlay,
)
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths
from wixy_server.treelock import tree_lock

_DRAFT_MEDIA_URL_PREFIX = "/admin/draft-media/"

_COLLECTION_SCHEMA_BY_KEY: dict[tuple[str, str], str] = {
    (rule.page, rule.path): rule.schema for rule in COLLECTION_RULES
}


@dataclass(frozen=True, slots=True)
class RepairResult:
    rev: int
    actions: tuple[str, ...]
    validate: ValidationResult


# Mirrors `admin-ui/src/sectionPanelModel.ts`'s `decodeCommonEntities` exactly —
# a content string may carry literal entity text (`meta.navLabel` on the live
# site is stored as "Before &amp; After"), and these action strings are read by
# the SITE OWNER in a toast, where a raw `&amp;` is just wrong. Decode on
# display, never re-encode on save, so both paths converge on the same plain
# form (decisions/00095's contentModel.ts precedent).
_ENTITY_RE = re.compile(r"&(amp|lt|gt|quot|apos|#39|nbsp);")
_ENTITY_MAP = {
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
    "#39": "'",
    "nbsp": " ",
}


def decode_common_entities(text: str) -> str:
    return _ENTITY_RE.sub(lambda m: _ENTITY_MAP.get(m.group(1), m.group(0)), text)


def _page_label(base_page_contents: dict[str, JsonObject], file_key: str) -> str:
    """A plain-English name for an op's `file` key, for owner-readable action
    strings — never a site-specific literal (Inv 1): derived from the base
    checkout's own `meta.navLabel`, generic fallbacks for the non-page keys."""
    if file_key == "_global":
        return "site-wide content"
    if file_key == "theme":
        return "theme"
    page = base_page_contents.get(file_key)
    if isinstance(page, dict):
        meta = page.get("meta")
        if isinstance(meta, dict):
            nav_label = meta.get("navLabel")
            if isinstance(nav_label, str) and nav_label:
                return f"'{decode_common_entities(nav_label)}' page"
    return f"'{file_key}' page"


def _is_fully_valid(item: JsonValue, schema: JsonObject) -> bool:
    return not validate_against_schema(item, schema)


def _fill_missing_required(item: JsonValue, base_item: JsonValue, schema: JsonObject) -> JsonValue:
    if not isinstance(item, dict) or not isinstance(base_item, dict):
        return item
    required = schema.get("required")
    if not isinstance(required, list):
        return item
    patched = dict(item)
    for key in required:
        if isinstance(key, str) and key not in patched and key in base_item:
            patched[key] = copy.deepcopy(base_item[key])
    return patched


def _repair_collection_items(
    current_items: list[JsonValue],
    base_items: list[JsonValue],
    schema: JsonObject,
    paths: ProjectPaths,
) -> tuple[list[JsonValue], bool]:
    """Returns `(repaired_items, any_item_changed)`. An item is "good" only if it
    is BOTH fully schema-valid and free of image refs that don't resolve to a
    real file (decisions/00115) — the second half is what makes repair able to
    clear a blocked draft whose items are structurally perfect but point at
    photos that aren't there."""

    def good(item: JsonValue) -> bool:
        return _is_fully_valid(item, schema) and not _has_unresolvable_image_ref(item, paths)

    repaired: list[JsonValue] = []
    changed = False
    for index, item in enumerate(current_items):
        if good(item):
            repaired.append(item)
            continue
        base_item = base_items[index] if index < len(base_items) else None
        if base_item is None:
            changed = True  # dropped — no base counterpart to fall back to
            continue
        patched = _fill_missing_required(item, base_item, schema)
        if good(patched):
            repaired.append(patched)
        else:
            repaired.append(copy.deepcopy(base_item))
        changed = True
    return repaired, changed


def _image_ref_resolves(src: str, paths: ProjectPaths) -> bool:
    if src == "":
        return True  # not-yet-picked is a valid draft state, not a broken ref
    if src.startswith(_DRAFT_MEDIA_URL_PREFIX):
        name = src[len(_DRAFT_MEDIA_URL_PREFIX) :]
        return (paths.draft_media / name).is_file()
    if src.startswith("/"):
        # normalize_set_ops already rewrote any leading-slash form whose file
        # genuinely exists — a survivor here is definitionally missing.
        return False
    return (paths.repo / src).is_file()


def _has_unresolvable_image_ref(value: JsonValue, paths: ProjectPaths) -> bool:
    if isinstance(value, dict):
        src = value.get("src")
        if isinstance(src, str) and set(value.keys()) <= {"src", "alt"}:
            return not _image_ref_resolves(src, paths)
        return any(_has_unresolvable_image_ref(sub, paths) for sub in value.values())
    if isinstance(value, list):
        return any(_has_unresolvable_image_ref(item, paths) for item in value)
    return False


def _image_srcs(value: JsonValue) -> list[str]:
    """Every `{src, alt}` src inside a value, in traversal order — used only to
    tell WHICH kind of normalize-only correction happened, so the owner-facing
    action sentence says "image link" when an image link is what changed and
    doesn't when it isn't."""
    found: list[str] = []

    def walk(node: JsonValue) -> None:
        if isinstance(node, dict):
            src = node.get("src")
            if isinstance(src, str) and set(node.keys()) <= {"src", "alt"}:
                found.append(src)
                return
            for sub in node.values():
                walk(sub)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(value)
    return found


def _base_container(
    source_page_contents: dict[str, JsonObject], global_content: JsonObject, file_key: str
) -> JsonObject:
    return global_content if file_key == "_global" else source_page_contents.get(file_key, {})


def run_repair(
    project: ProjectConfig, paths: ProjectPaths, *, expected_rev: int, by: str, now: str
) -> RepairResult:
    """Raises `RevConflictError` on a stale `expected_rev` (Inv 9, same
    contract as every other overlay mutation) — never a partial repair."""
    with tree_lock():
        return _run_repair_locked(project, paths, expected_rev=expected_rev, by=by, now=now)


def _run_repair_locked(
    project: ProjectConfig, paths: ProjectPaths, *, expected_rev: int, by: str, now: str
) -> RepairResult:
    base_sha = current_sha(paths.repo) if (paths.repo / ".git").exists() else ""
    overlay = load_overlay(paths.draft_overlay, default_base_sha=base_sha)
    if overlay.rev != expected_rev:
        raise RevConflictError(expected_rev, overlay.rev)

    base_source = build_site_source(project, paths.repo)  # no overlay applied — pure base
    normalized = normalize_set_ops(
        [
            SetOp(file=key.partition(":")[0], path=key.partition(":")[2], value=op.value)
            for key, op in overlay.ops.items()
            if ":" in key
        ],
        paths,
    )

    actions: list[str] = []
    patch_ops: list[PatchOp] = []
    for op in normalized:
        original_value = overlay.ops[f"{op.file}:{op.path}"].value
        label = _page_label(base_source.page_contents, op.file)
        schema_name = _COLLECTION_SCHEMA_BY_KEY.get((op.file, op.path))

        if schema_name is not None:
            schema = load_schema(schema_name)
            base_container = _base_container(
                base_source.page_contents, base_source.global_content, op.file
            )
            _, base_value = dotted_get(base_container, op.path)
            base_items = base_value if isinstance(base_value, list) else []
            current_items = op.value if isinstance(op.value, list) else []
            repaired_items, any_changed = _repair_collection_items(
                current_items, base_items, schema, paths
            )
            # `op.value` is the NORMALIZED value; `original_value` is what's on
            # disk. Normalize alone fixing every problem (the published-upload
            # src rewrite, decisions/00115) still has to be written back — the
            # pre-00115 `if not any_changed: continue` dropped it on the floor
            # and left the draft blocked with nothing left to try.
            normalized_only = op.value != original_value
            if not any_changed and not normalized_only:
                continue  # already fully valid — leave this op untouched
            if repaired_items == base_items:
                patch_ops.append(DiscardOp(file=op.file, path=op.path))
                actions.append(f"Restored the {label} to its last published version.")
            else:
                patch_ops.append(SetOp(file=op.file, path=op.path, value=repaired_items))
                image_link_only = not any_changed and _image_srcs(op.value) != _image_srcs(
                    original_value
                )
                actions.append(
                    f"Fixed a broken image link on the {label}."
                    if image_link_only
                    else f"Fixed some content in the {label}."
                )
            continue

        if _has_unresolvable_image_ref(op.value, paths):
            patch_ops.append(DiscardOp(file=op.file, path=op.path))
            actions.append(f"Removed a change on the {label} that pointed at a missing image.")
        elif op.value != original_value:
            patch_ops.append(SetOp(file=op.file, path=op.path, value=op.value))
            actions.append(f"Fixed a broken image link on the {label}.")
        # else: untouched by normalize and no broken ref — nothing to do.

    new_overlay: Overlay = apply_patch(overlay, expected_rev, patch_ops, by=by, now=now)
    save_overlay(paths.draft_overlay, new_overlay)

    merged = merge_overlay(base_source, new_overlay)
    validate_result = validate_merged_for_publish(merged, paths)

    return RepairResult(rev=new_overlay.rev, actions=tuple(actions), validate=validate_result)
