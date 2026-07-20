"""Restore (spec/04-server.md §5's restore paragraph, §6; spec/05-editor.md §5):
loads a past ledger entry, rebuilds its archived build if pruned, flips the live
pointer instantly, and sets the draft overlay to the binding-map-driven diff
needed to reproduce that version's content — nothing is committed until the
owner's next publish (the restore's own ledger entry, `{action: "restore", of:
version}`, still consumes a new sequential version number, spec's own "recorded
as a new version" language — distinct from any git commit, which never happens
here).

`worktree_at_sha` is the one new mechanism this slice adds: a scratch, detached
`git worktree add` checkout of the Storage repo at an arbitrary historical SHA,
used both to rebuild a build directory `_prune_builds` (publisher.py) already
deleted, and to load an old version's CONTENT for diffing against current main.
`version_diff.py` (decisions/00070) reuses it for the same read-the-past purpose.
This is a deliberate deviation from decisions/00010 decision 4's originally
anticipated per-file `git show` reconstruction — pre-approved in
decisions/00024's "what to watch for" — because `builder`'s own loading
functions (`load_site_source`/`build_site`) are Path-based, not
content-addressable, so a per-file `git show` approach would need its own
scratch-directory materialization anyway; a real worktree gets the exact same
`load_site_source`/`build_site` calls the live pipeline already uses, for free.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from builder.build import build_site
from builder.config import ProjectConfig
from builder.content import GLOBAL_CONTENT_NAME
from builder.jsontypes import JsonObject, JsonValue
from builder.theme import theme_to_dict
from wixy_server.checkout import run_git
from wixy_server.ledger import LedgerEntry, append_ledger, find_version, next_version
from wixy_server.live_pointer import save_live_pointer
from wixy_server.overlay import Overlay, OverlayOp, load_overlay, save_overlay
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths


class RestoreError(Exception):
    """A restore couldn't be completed — the caller maps this to an HTTP error;
    live serving and the current draft are both left exactly as they were,
    since nothing here mutates either until every check above has passed."""


@dataclass(frozen=True, slots=True)
class RestoreResult:
    version: int
    sha: str
    of: int


@contextmanager
def worktree_at_sha(paths: ProjectPaths, sha: str) -> Iterator[Path]:
    """A scratch, detached-HEAD checkout of `paths.repo` at `sha` — never
    touches `paths.repo`'s OWN checked-out branch/index (a `git worktree`
    is a fully independent working tree sharing only the object database),
    so this is safe to run alongside an in-flight fetch/merge on the main
    checkout. Always cleaned up on exit, success or failure."""
    scratch_root = Path(tempfile.mkdtemp(prefix="wixy-restore-"))
    scratch_dir = scratch_root / "checkout"
    try:
        result = run_git(["worktree", "add", "--detach", str(scratch_dir), sha], cwd=paths.repo)
        if result.returncode != 0:
            raise RestoreError(f"git worktree add failed: {result.stderr.strip()}")
        yield scratch_dir
    finally:
        remove_result = run_git(["worktree", "remove", "--force", str(scratch_dir)], cwd=paths.repo)
        shutil.rmtree(scratch_root, ignore_errors=True)
        if remove_result.returncode != 0:
            # Can fail transiently (e.g. a lingering file handle under heavy
            # I/O load) — the directory is already gone via rmtree above, so
            # `git worktree prune` (built for exactly this: reconciling
            # administrative files for worktrees whose directories no longer
            # exist) cleans up the dangling registration instead of leaving it
            # to confuse a later `git worktree add`/list against paths.repo.
            run_git(["worktree", "prune"], cwd=paths.repo)


def ensure_build(project: ProjectConfig, paths: ProjectPaths, sha: str) -> Path:
    """Returns `builds/<sha>/`, rebuilding it first via a scratch worktree if
    `_prune_builds` (publisher.py, spec/04 §5 step 5) already deleted it."""
    build_dir = paths.build_dir(sha)
    if build_dir.is_dir():
        return build_dir
    with worktree_at_sha(paths, sha) as scratch:
        source = build_site_source(project, scratch)
        build_site(scratch, source, build_dir)
    return build_dir


def _diff_content(
    baseline: JsonValue, target: JsonValue, prefix: str, ops: dict[str, JsonValue]
) -> None:
    """Binding-map-driven diff (spec/04 §5), with no bindings-map lookup needed
    at all: recursing only into `dict`s and atomic-comparing everything else
    (strings/numbers/bools/lists/`None`) already satisfies "list-bound keys
    emit ONE whole-array op, scalar/meta/theme keys emit per-dotted-leaf ops" —
    a JSON array is never a `dict`, so it's never descended into, only ever
    compared as one atomic unit via `!=`, which IS the "whole-array op" the
    spec calls for. `baseline` is current main's value at this path (what the
    resulting overlay op will override); `target` is the version being
    restored TO (the op's `value`, once they differ)."""
    if isinstance(baseline, dict) and isinstance(target, dict):
        for key in sorted(set(baseline) | set(target)):
            child_prefix = f"{prefix}.{key}" if prefix else key
            _diff_content(baseline.get(key), target.get(key), child_prefix, ops)
        return
    if baseline != target:
        ops[prefix] = target


def _collect_ops(
    file_key: str,
    baseline: JsonObject,
    target: JsonObject,
    now: str,
    out: dict[str, OverlayOp],
) -> None:
    changed: dict[str, JsonValue] = {}
    _diff_content(baseline, target, "", changed)
    for dotted_path, value in changed.items():
        out[f"{file_key}:{dotted_path}"] = OverlayOp(value=value, ts=now, by="restore")


def run_restore(
    project: ProjectConfig, paths: ProjectPaths, *, version: int, now: str
) -> RestoreResult:
    entry = find_version(paths, version)
    if entry is None:
        raise RestoreError(f"no such version: {version}")

    ensure_build(project, paths, entry.sha)

    current_source = build_site_source(project, paths.repo)
    with worktree_at_sha(paths, entry.sha) as scratch:
        old_source = build_site_source(project, scratch)

    old_pages = set(old_source.page_contents)
    current_pages = set(current_source.page_contents)
    resurrect = sorted(old_pages - current_pages)
    if resurrect:
        # spec/04 §5's "page-set differences ... map to overlay page ops" has
        # no answer for THIS direction: `PageAdd` (overlay.py) only models
        # "duplicate an existing template," and there's no current template to
        # duplicate from for a page deleted entirely since. Refusing cleanly
        # beats silently resurrecting an incomplete/wrong page.
        raise RestoreError(
            f"cannot restore version {version}: page(s) {', '.join(resurrect)} existed then "
            "but have since been removed from the site entirely — resurrecting a fully-deleted "
            "page isn't supported"
        )
    to_delete = tuple(sorted(current_pages - old_pages))

    ops: dict[str, OverlayOp] = {}
    for slug in sorted(old_pages & current_pages):
        _collect_ops(
            slug, current_source.page_contents[slug], old_source.page_contents[slug], now, ops
        )
    _collect_ops(
        GLOBAL_CONTENT_NAME, current_source.global_content, old_source.global_content, now, ops
    )
    if current_source.theme is not None and old_source.theme is not None:
        _collect_ops(
            "theme", theme_to_dict(current_source.theme), theme_to_dict(old_source.theme), now, ops
        )

    current_overlay = load_overlay(paths.draft_overlay, default_base_sha=entry.sha)
    new_overlay = Overlay(
        rev=current_overlay.rev + 1,
        base_sha=current_overlay.base_sha,
        ops=ops,
        pages_added=(),
        pages_deleted=to_delete,
    )
    save_overlay(paths.draft_overlay, new_overlay)

    new_version = next_version(paths)
    save_live_pointer(paths, entry.sha, new_version)
    append_ledger(
        paths,
        LedgerEntry(version=new_version, sha=entry.sha, when=now, action="restore", of=version),
    )
    return RestoreResult(version=new_version, sha=entry.sha, of=version)
