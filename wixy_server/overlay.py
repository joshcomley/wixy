"""Draft overlay store — server-side edit state (spec/02-content-model.md §8).

The visual editor never writes content files directly; it maintains a SPARSE
overlay: a dict of `<file>:<dotted.path> -> {value, ts, by}` ops, plus page
add/delete ops, held in one JSON file per project (`Storage/projects/<slug>/
draft/overlay.json`) with optimistic-concurrency (`rev`) and atomic (tmp+rename)
writes. `merged_content.py` is what actually APPLIES these ops onto loaded
content (spec/02 §8's merge rule); this module only owns load/save/PATCH of the
overlay's own state.

Timestamps are threaded in by the caller (`now: str`), never read from the
system clock here — keeps this module purely testable and matches this
project's general avoidance of hidden non-determinism in business logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from builder.content import atomic_write_json, load_json_object
from builder.jsontypes import JsonValue


class RevConflictError(Exception):
    """A PATCH's `expectedRev` doesn't match the overlay's current `rev` (spec/02
    §8: "stale -> 409 and the editor refetches")."""

    def __init__(self, expected: int, actual: int) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(f"expected rev {expected}, overlay is at rev {actual}")


@dataclass(frozen=True, slots=True)
class OverlayOp:
    value: JsonValue
    ts: str
    by: str


@dataclass(frozen=True, slots=True)
class PageAdd:
    slug: str
    from_slug: str


@dataclass(frozen=True, slots=True)
class Overlay:
    rev: int
    base_sha: str
    ops: dict[str, OverlayOp]
    pages_added: tuple[PageAdd, ...]
    pages_deleted: tuple[str, ...]


def empty_overlay(base_sha: str) -> Overlay:
    return Overlay(rev=0, base_sha=base_sha, ops={}, pages_added=(), pages_deleted=())


def load_overlay(path: Path, *, default_base_sha: str) -> Overlay:
    """Load the overlay file, or a fresh empty overlay if none exists yet."""
    if not path.exists():
        return empty_overlay(default_base_sha)

    data = load_json_object(path)
    ops_raw = data.get("ops", {})
    ops: dict[str, OverlayOp] = {}
    if isinstance(ops_raw, dict):
        for key, op_raw in ops_raw.items():
            if isinstance(op_raw, dict):
                ops[key] = OverlayOp(
                    value=op_raw.get("value"),
                    ts=str(op_raw.get("ts", "")),
                    by=str(op_raw.get("by", "")),
                )

    pages_raw = data.get("pages", {})
    pages_added: tuple[PageAdd, ...] = ()
    pages_deleted: tuple[str, ...] = ()
    if isinstance(pages_raw, dict):
        added_raw = pages_raw.get("added", [])
        if isinstance(added_raw, list):
            pages_added = tuple(
                PageAdd(slug=str(p.get("slug", "")), from_slug=str(p.get("fromSlug", "")))
                for p in added_raw
                if isinstance(p, dict)
            )
        deleted_raw = pages_raw.get("deleted", [])
        if isinstance(deleted_raw, list):
            pages_deleted = tuple(str(s) for s in deleted_raw if isinstance(s, str))

    rev = data.get("rev", 0)
    base_sha = data.get("baseSha", default_base_sha)
    return Overlay(
        rev=rev if isinstance(rev, int) else 0,
        base_sha=base_sha if isinstance(base_sha, str) else default_base_sha,
        ops=ops,
        pages_added=pages_added,
        pages_deleted=pages_deleted,
    )


def _overlay_to_dict(overlay: Overlay) -> dict[str, JsonValue]:
    return {
        "rev": overlay.rev,
        "baseSha": overlay.base_sha,
        "ops": {
            key: {"value": op.value, "ts": op.ts, "by": op.by} for key, op in overlay.ops.items()
        },
        "pages": {
            "added": [{"slug": p.slug, "fromSlug": p.from_slug} for p in overlay.pages_added],
            "deleted": list(overlay.pages_deleted),
        },
    }


def save_overlay(path: Path, overlay: Overlay) -> None:
    """Write atomically (spec/02 §8: "written atomically (tmp + rename) on every
    accepted PATCH") — see `builder.content.atomic_write_json`."""
    atomic_write_json(path, _overlay_to_dict(overlay))


@dataclass(frozen=True, slots=True)
class SetOp:
    file: str
    path: str
    value: JsonValue


@dataclass(frozen=True, slots=True)
class DiscardOp:
    file: str
    path: str


PatchOp = SetOp | DiscardOp


def apply_patch(
    overlay: Overlay,
    expected_rev: int,
    ops: list[PatchOp],
    *,
    by: str,
    now: str,
) -> Overlay:
    """Apply a PATCH's ops onto `overlay`, returning the new overlay at `rev + 1`.

    Raises `RevConflictError` if `expected_rev` doesn't match `overlay.rev` — the
    caller (the admin API route, once it exists) maps that to an HTTP 409.
    """
    if expected_rev != overlay.rev:
        raise RevConflictError(expected_rev, overlay.rev)

    new_ops = dict(overlay.ops)
    for op in ops:
        key = f"{op.file}:{op.path}"
        if isinstance(op, DiscardOp):
            new_ops.pop(key, None)
        else:
            new_ops[key] = OverlayOp(value=op.value, ts=now, by=by)

    return Overlay(
        rev=overlay.rev + 1,
        base_sha=overlay.base_sha,
        ops=new_ops,
        pages_added=overlay.pages_added,
        pages_deleted=overlay.pages_deleted,
    )


def add_page(
    overlay: Overlay,
    expected_rev: int,
    *,
    from_slug: str,
    slug: str,
    nav_label: str,
    by: str,
    now: str,
) -> Overlay:
    """Duplicates `from_slug` as `slug` (spec/05 §2: `POST pages/duplicate
    {from, slug, navLabel}`) — records a `PageAdd` (materialized at publish
    time by `publisher._add_page`, which copies the template file) plus an
    ordinary overlay SET op seeding the new page's `meta.navLabel`, the exact
    same per-file application every other page content edit already goes
    through (decisions/00024 decision 4: no new storage convention for the
    new page's content). Existence/slug-format validation is the caller's
    job (routes_admin_api.py) — this function only appends the two records."""
    if expected_rev != overlay.rev:
        raise RevConflictError(expected_rev, overlay.rev)

    new_ops = dict(overlay.ops)
    new_ops[f"{slug}:meta.navLabel"] = OverlayOp(value=nav_label, ts=now, by=by)
    return Overlay(
        rev=overlay.rev + 1,
        base_sha=overlay.base_sha,
        ops=new_ops,
        pages_added=(*overlay.pages_added, PageAdd(slug=slug, from_slug=from_slug)),
        pages_deleted=overlay.pages_deleted,
    )


def delete_page(overlay: Overlay, expected_rev: int, slug: str) -> Overlay:
    """Stages `slug` for deletion (spec/05 §2: takes effect at publish as a
    `git rm`, `publisher._delete_page`). Always bumps `rev` even if `slug` was
    already staged (idempotent in effect, not in rev — consistent with
    `apply_patch`'s own unconditional bump, so a client's rev-tracking never
    needs to special-case "did this call actually change anything")."""
    if expected_rev != overlay.rev:
        raise RevConflictError(expected_rev, overlay.rev)

    pages_deleted = (
        overlay.pages_deleted if slug in overlay.pages_deleted else (*overlay.pages_deleted, slug)
    )
    return Overlay(
        rev=overlay.rev + 1,
        base_sha=overlay.base_sha,
        ops=overlay.ops,
        pages_added=overlay.pages_added,
        pages_deleted=pages_deleted,
    )


def discard_all(overlay: Overlay) -> Overlay:
    """Empty the overlay's ops + page ops WITHOUT committing anything (spec/02 §8:
    "Discard-draft empties it without committing"). Still bumps `rev` — a
    discard is itself a content change, so an in-flight stale PATCH racing it
    must still see a 409, not silently resurrect a discarded op."""
    return Overlay(
        rev=overlay.rev + 1,
        base_sha=overlay.base_sha,
        ops={},
        pages_added=(),
        pages_deleted=(),
    )
