"""The publish pipeline (spec/04-server.md §5): materialize the draft overlay onto
the site repo checkout, commit + push + tag, build + verify, swap the live pointer,
record a ledger entry, and prune old builds.

Runs as ONE serialized job per spec/04 §5 — this module owns the pipeline itself and
the `locks/publish.lock` FILE lock (created for the pipeline's duration, removed in a
`finally`); `wixy_server.watcher`'s background fetch loop checks that same file
before each tick so it never fast-forwards the checkout out from under an in-flight
publish (decisions/00013's flagged gap, closed here — see `wixy_server/watcher.py`).
The IN-PROCESS "is one already running" check (mapping a concurrent request to a 409)
is the HTTP route's job (milestone 9 slice 2) — a plain `PublishJob.is_running` read
on `app.state`, checked synchronously before any `await`, needs no separate lock
object since asyncio's single-threaded event loop makes that check-then-set atomic
on its own.

Steps 1-5, exactly per spec:
  1. Preflight — overlay rev check (else `RevConflictError`, mapped to 409 by the
     caller, same as `routes_admin_api.patch_draft`), fetch + `--ff-only` merge.
  2. Materialize — apply overlay ops onto content/theme files, stage page ops, copy
     referenced staged media into `images/` (rewriting `src` from the draft-media
     URL to the published `images/<name>` form) — the ORIGINAL staged file is left
     in place until AFTER validate succeeds, so a validate failure never loses data
     even transiently — validate-or-abort (hard reset + clean).
  3. Commit & push — one commit, retry ONCE on a rejected push (fetch, re-merge,
     re-materialize, re-commit, re-push; a second failure resets to origin's tip
     and aborts, overlay untouched); tag `wixy-publish-v<N>` either way (even a
     publish with no new local commit — pure upstream commits riding through —
     still gets tagged, so the tag-based disaster-recovery rebuild works
     uniformly for every ledger entry).
  4. Build & verify — `builder build` into `builds/<sha>/`, its existing post-build
     self-check, plus a NEW lightweight text-diff smoke check against the previous
     build for a couple of pages (spec: "catches catastrophes without blocking
     intentional edits" — a warning in the job log, never a hard abort).
  5. Swap — write `live.json`, clear the overlay, append the ledger entry, prune
     old builds.

Any failure before step 5 leaves the live site + ledger + draft completely
untouched — see this slice's decision entry for the exact abort/reset behavior at
each stage, and for the open design choices this module had to make explicitly
(the "nothing to commit" case, the UI-phase-to-server-step mapping, etc).
"""

from __future__ import annotations

import difflib
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from bs4 import BeautifulSoup

from builder.build import build_site
from builder.config import ProjectConfig
from builder.content import dotted_set, load_json_object, write_json_canonical
from builder.errors import BuildError
from builder.jsontypes import JsonValue
from builder.render import SiteSource
from builder.validate import validate_site
from wixy_server.checkout import CheckoutError, commits_ahead, current_sha, ensure_checkout
from wixy_server.checkout import run_git as run_git  # re-exported: tests patch it via this module
from wixy_server.ledger import LedgerEntry, PublishSource, append_ledger, next_version, read_ledger
from wixy_server.live_pointer import LivePointer, load_live_pointer, save_live_pointer
from wixy_server.overlay import (
    Overlay,
    PageAdd,
    RevConflictError,
    discard_all,
    load_overlay,
    save_overlay,
)
from wixy_server.site_source import build_site_source
from wixy_server.storage import ProjectPaths

PublishStage = Literal[
    "pulling", "merging", "committing", "building", "verifying", "swapping", "done", "failed"
]

_COMMIT_USER_NAME = "Wixy"
_COMMIT_USER_EMAIL = "wixy@cinnamons.uk"
_DRAFT_MEDIA_URL_PREFIX = "/admin/draft-media/"
_MAX_KEPT_VERSIONS = 20
_SMOKE_PAGE_COUNT = 2
_SMOKE_SIMILARITY_FLOOR = 0.5  # a difflib ratio below this on a smoke page logs a warning


class PublishError(Exception):
    """The pipeline failed at some stage — `.stage` names where, `.log` is every
    line logged before the failure (spec/04 §5: "failure -> job state 'failed'
    with the full error log; live site + ledger + draft all unchanged")."""

    def __init__(self, stage: PublishStage, message: str, log: list[str]) -> None:
        self.stage: PublishStage = stage
        self.log: list[str] = [*log, message]
        super().__init__(message)


@dataclass(slots=True)
class PublishJob:
    """Shared, mutable, polled progress record — the same pattern as
    `wixy_server.watcher.WatcherStatus`: a plain dataclass mutated in place from
    the worker thread running the pipeline, read directly by an HTTP route/SSE
    stream (milestone 9 slice 2)."""

    id: str
    stage: PublishStage = "pulling"
    log: list[str] = field(default_factory=list)
    version: int | None = None
    error: str | None = None

    @property
    def is_running(self) -> bool:
        return self.stage not in ("done", "failed")


@dataclass(frozen=True, slots=True)
class PublishResult:
    version: int
    sha: str


def _log(job: PublishJob, line: str) -> None:
    job.log.append(line)


def run_publish(
    project: ProjectConfig,
    paths: ProjectPaths,
    *,
    message: str,
    expected_rev: int,
    now: str,
    job: PublishJob,
) -> PublishResult:
    """The whole pipeline, synchronous — the caller (the admin API route) runs
    this via `anyio.to_thread.run_sync`/a background task. Mutates `job` after
    every stage transition so a concurrent SSE/poll reader sees live progress.

    Raises `RevConflictError` immediately (before touching the lock or the
    checkout at all) if `expected_rev` is stale — the caller maps that straight
    to a 409, same as `routes_admin_api.patch_draft`; the job is never considered
    to have "started" for this case, so `job.stage`/`job.error` are left alone.
    """
    # `default_base_sha` is only ever a fallback for a NEVER-yet-saved overlay's own
    # `base_sha` FIELD (not consulted anywhere else in this pipeline) — guarded the
    # same way `site_source.build_site_source` guards its own first checkout read,
    # since the checkout may not exist at all yet (this project's very first publish).
    default_base_sha = current_sha(paths.repo) if (paths.repo / ".git").exists() else ""
    overlay = load_overlay(paths.draft_overlay, default_base_sha=default_base_sha)
    if overlay.rev != expected_rev:
        raise RevConflictError(expected_rev, overlay.rev)

    paths.locks_dir.mkdir(parents=True, exist_ok=True)
    paths.publish_lock.write_text(now, encoding="utf-8")
    try:
        job.stage = "pulling"
        previous_pointer = load_live_pointer(paths)
        try:
            ensure_checkout(project.repo, project.default_branch, paths.repo)
        except CheckoutError as exc:
            raise PublishError("pulling", f"fetch/merge failed: {exc}", job.log) from exc
        _log(job, f"fetched and fast-forwarded to origin/{project.default_branch}")

        has_upstream_commits = previous_pointer is not None and (
            len(commits_ahead(paths.repo, previous_pointer.sha)) > 0
        )

        job.stage = "merging"
        _materialize(project, paths, overlay)
        _log(job, f"materialized {len(overlay.ops)} draft change(s)")

        job.stage = "committing"
        version = next_version(paths)
        sha = _commit_push_and_tag(
            project, paths, overlay, message=message, version=version, job=job
        )
        _log(job, f"committed and pushed as {sha[:8]}")

        job.stage = "building"
        source = build_site_source(project, paths.repo)
        out_dir = paths.build_dir(sha)
        build_site(paths.repo, source, out_dir)
        _log(job, f"built into {out_dir}")

        job.stage = "verifying"
        _smoke_check(source, out_dir, previous_pointer, job)

        job.stage = "swapping"
        save_live_pointer(paths, sha, version)
        source_kind = _publish_source_kind(
            has_draft_ops=len(overlay.ops) > 0, has_upstream_commits=has_upstream_commits
        )
        entry = LedgerEntry(
            version=version,
            sha=sha,
            when=now,
            message=message,
            source=source_kind,
            changed=_changed_summary(overlay),
        )
        append_ledger(paths, entry)
        save_overlay(paths.draft_overlay, discard_all(overlay))
        _prune_builds(paths)
        _log(job, f"published as version {version}")

        job.stage = "done"
        job.version = version
        return PublishResult(version=version, sha=sha)
    except (PublishError, CheckoutError, BuildError) as exc:
        job.stage = "failed"
        job.error = str(exc)
        raise
    finally:
        paths.publish_lock.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Materialize (step 2)
# ---------------------------------------------------------------------------


def _content_file_for(paths: ProjectPaths, file_key: str) -> Path:
    if file_key == "theme":
        return paths.repo / "theme" / "theme.json"
    return paths.repo / "content" / f"{file_key}.json"


def _rewrite_draft_media_refs(value: JsonValue) -> JsonValue:
    """Recursively rewrites any `{src, alt}`-shaped value whose `src` points at a
    staged draft upload to its published `images/<name>` form — the exact shape
    `scan_image_refs` (builder/content.py) and `scan_media_references`
    (wixy_server/media.py) already key off, walked here to TRANSFORM rather than
    just find."""
    if isinstance(value, dict):
        src = value.get("src")
        if isinstance(src, str) and isinstance(value.get("alt"), str):
            if src.startswith(_DRAFT_MEDIA_URL_PREFIX):
                name = src[len(_DRAFT_MEDIA_URL_PREFIX) :]
                return {**value, "src": f"images/{name}"}
            return value
        return {key: _rewrite_draft_media_refs(sub) for key, sub in value.items()}
    if isinstance(value, list):
        return [_rewrite_draft_media_refs(item) for item in value]
    return value


def _collect_draft_media_names(value: JsonValue, names: set[str]) -> None:
    if isinstance(value, dict):
        src = value.get("src")
        if isinstance(src, str) and isinstance(value.get("alt"), str):
            if src.startswith(_DRAFT_MEDIA_URL_PREFIX):
                names.add(src[len(_DRAFT_MEDIA_URL_PREFIX) :])
            return
        for sub in value.values():
            _collect_draft_media_names(sub, names)
    elif isinstance(value, list):
        for item in value:
            _collect_draft_media_names(item, names)


def _apply_ops_to_file(
    paths: ProjectPaths, file_key: str, path_values: dict[str, JsonValue]
) -> None:
    """`theme.json` is just another JSON object from this function's point of view
    — no `Theme`/`FontSpec` parsing here; a structurally-invalid theme write would
    surface as a `BuildError` from the very next `build_site_source` call in
    `_materialize` (caught there), not silently persisted as something a build
    could never actually load."""
    target = _content_file_for(paths, file_key)
    if file_key == "theme" and not target.exists():
        return  # pre-migration-step-4 project with no theme.json yet (decisions/00004)
    data = load_json_object(target) if target.exists() else {}
    for dotted_path, value in path_values.items():
        dotted_set(data, dotted_path, _rewrite_draft_media_refs(value))
    write_json_canonical(target, data)


def _delete_page(paths: ProjectPaths, slug: str) -> None:
    template = paths.repo / "pages" / f"{slug}.html"
    content = paths.repo / "content" / f"{slug}.json"
    if template.exists():
        run_git(["rm", "-f", "--", str(template)], cwd=paths.repo)
    if content.exists():
        run_git(["rm", "-f", "--", str(content)], cwd=paths.repo)


def _add_page(paths: ProjectPaths, page_add: PageAdd) -> None:
    """Duplicates `from_slug`'s TEMPLATE for the new `slug` — the new page's
    CONTENT is carried as ordinary overlay ops keyed under the new slug (handled
    generically by `_apply_ops_to_file`, exactly like any other page), so the
    template file is the only piece materialize itself must produce."""
    source_template = paths.repo / "pages" / f"{page_add.from_slug}.html"
    target_template = paths.repo / "pages" / f"{page_add.slug}.html"
    if source_template.exists() and not target_template.exists():
        target_template.write_text(source_template.read_text(encoding="utf-8"), encoding="utf-8")
        run_git(["add", "--", str(target_template)], cwd=paths.repo)


def _copy_referenced_media(paths: ProjectPaths, names: set[str]) -> list[str]:
    """Copies each referenced staged upload into `images/`, `git add`-ing it — the
    ORIGINAL in `draft/media/` is deliberately left in place until validate
    succeeds (see `_materialize`)."""
    copied: list[str] = []
    images_dir = paths.repo / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    for name in sorted(names):
        source = paths.draft_media / name
        if not source.exists():
            continue  # already published by an earlier publish, or never actually existed
        target = images_dir / name
        target.write_bytes(source.read_bytes())
        run_git(["add", "--", str(target)], cwd=paths.repo)
        copied.append(name)
    return copied


def _reset_hard(repo: Path, ref: str) -> None:
    run_git(["reset", "--hard", ref], cwd=repo)
    run_git(["clean", "-fd"], cwd=repo)


def _materialize(project: ProjectConfig, paths: ProjectPaths, overlay: Overlay) -> None:
    ops_by_file: dict[str, dict[str, JsonValue]] = {}
    for key, op in overlay.ops.items():
        file_key, sep, dotted_path = key.partition(":")
        if not sep:
            continue
        ops_by_file.setdefault(file_key, {})[dotted_path] = op.value

    referenced_names: set[str] = set()
    for path_values in ops_by_file.values():
        for value in path_values.values():
            _collect_draft_media_names(value, referenced_names)

    for file_key, path_values in ops_by_file.items():
        _apply_ops_to_file(paths, file_key, path_values)

    for slug in overlay.pages_deleted:
        _delete_page(paths, slug)
    for page_add in overlay.pages_added:
        _add_page(paths, page_add)

    copied_names = _copy_referenced_media(paths, referenced_names)

    try:
        source = build_site_source(project, paths.repo)
    except BuildError as exc:
        _reset_hard(paths.repo, "HEAD")
        raise PublishError(
            "merging", f"failed to load the merged site after materializing: {exc}", []
        ) from exc

    result = validate_site(source, paths.repo)
    if not result.ok:
        _reset_hard(paths.repo, "HEAD")
        summary = "; ".join(
            f"{e.file}:{e.key}: {e.message}" if e.key else f"{e.file}: {e.message}"
            for e in result.errors
        )
        raise PublishError("merging", f"builder validate failed: {summary}", [])

    # Only NOW remove the draft-staged originals — past the abort point, so a
    # validate failure above never loses data even transiently.
    for name in copied_names:
        (paths.draft_media / name).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Commit, push, tag (step 3)
# ---------------------------------------------------------------------------


def _stage_all(repo: Path) -> None:
    result = run_git(["add", "-A"], cwd=repo)
    if result.returncode != 0:
        raise PublishError("committing", f"git add failed: {result.stderr.strip()}", [])


def _has_staged_changes(repo: Path) -> bool:
    result = run_git(["diff", "--cached", "--quiet"], cwd=repo)
    return result.returncode != 0  # `--quiet` exits 1 when there IS a diff


def _commit(repo: Path, message: str) -> None:
    result = run_git(
        [
            "-c",
            f"user.name={_COMMIT_USER_NAME}",
            "-c",
            f"user.email={_COMMIT_USER_EMAIL}",
            "commit",
            "-m",
            message,
        ],
        cwd=repo,
    )
    if result.returncode != 0:
        raise PublishError("committing", f"git commit failed: {result.stderr.strip()}", [])


def _stage_commit_push(repo: Path, message: str, branch: str) -> tuple[str, bool, str]:
    """Returns `(sha, pushed_ok, push_stderr)`. Skips creating a commit entirely
    when there's nothing staged (a pure-upstream publish riding through with zero
    draft changes) — `git commit` would otherwise fail outright without
    `--allow-empty`, which would misreport a genuinely-fine "nothing to publish
    beyond what's already on origin" case as a pipeline error."""
    _stage_all(repo)
    if _has_staged_changes(repo):
        _commit(repo, message)
    sha = current_sha(repo)
    push_result = run_git(["push", "origin", branch], cwd=repo)
    return sha, push_result.returncode == 0, push_result.stderr.strip()


def _tag_and_push(repo: Path, version: int, message: str, sha: str) -> None:
    tag_name = f"wixy-publish-v{version}"
    tag_result = run_git(
        [
            "-c",
            f"user.name={_COMMIT_USER_NAME}",
            "-c",
            f"user.email={_COMMIT_USER_EMAIL}",
            "tag",
            "-a",
            tag_name,
            "-m",
            message,
            sha,
        ],
        cwd=repo,
    )
    if tag_result.returncode != 0:
        raise PublishError("committing", f"git tag failed: {tag_result.stderr.strip()}", [])
    push_result = run_git(["push", "origin", tag_name], cwd=repo)
    if push_result.returncode != 0:
        raise PublishError("committing", f"git push (tag) failed: {push_result.stderr.strip()}", [])


def _commit_push_and_tag(
    project: ProjectConfig,
    paths: ProjectPaths,
    overlay: Overlay,
    *,
    message: str,
    version: int,
    job: PublishJob,
) -> str:
    pre_commit_sha = current_sha(paths.repo)
    commit_message = f"wixy: publish v{version} — {message}"
    branch = project.default_branch

    sha, pushed_ok, push_stderr = _stage_commit_push(paths.repo, commit_message, branch)
    if not pushed_ok:
        _log(job, f"push rejected, retrying once after re-fetch: {push_stderr}")
        _reset_hard(paths.repo, pre_commit_sha)
        try:
            ensure_checkout(project.repo, branch, paths.repo)
        except CheckoutError as exc:
            raise PublishError(
                "committing", f"re-fetch after push rejection failed: {exc}", job.log
            ) from exc
        _materialize(project, paths, overlay)
        sha, pushed_ok, push_stderr = _stage_commit_push(paths.repo, commit_message, branch)
        if not pushed_ok:
            _reset_hard(paths.repo, f"origin/{branch}")
            raise PublishError(
                "committing",
                f"push rejected twice; aborted and reset to origin "
                f"(overlay untouched): {push_stderr}",
                job.log,
            )

    _tag_and_push(paths.repo, version, message, sha)
    return sha


# ---------------------------------------------------------------------------
# Build & verify (step 4)
# ---------------------------------------------------------------------------


def _smoke_check(
    source: SiteSource, out_dir: Path, previous_pointer: LivePointer | None, job: PublishJob
) -> None:
    """Text-diff sanity on a couple of pages against the PREVIOUS build (spec/04
    §5 step 4: "catches catastrophes without blocking intentional edits") — logs
    a WARNING on a drastic similarity drop, never a hard abort."""
    if previous_pointer is None or not previous_pointer.build_dir.exists():
        return  # first-ever publish, or the previous build was pruned — nothing to compare
    for slug in sorted(source.page_contents)[:_SMOKE_PAGE_COUNT]:
        out_name = "index.html" if slug == "index" else f"{slug}.html"
        new_path = out_dir / out_name
        old_path = previous_pointer.build_dir / out_name
        if not new_path.exists() or not old_path.exists():
            continue
        new_text = BeautifulSoup(new_path.read_text(encoding="utf-8"), "html5lib").get_text()
        old_text = BeautifulSoup(old_path.read_text(encoding="utf-8"), "html5lib").get_text()
        ratio = difflib.SequenceMatcher(None, old_text, new_text).ratio()
        if ratio < _SMOKE_SIMILARITY_FLOOR:
            _log(
                job,
                f"WARNING: '{slug}' text content changed drastically vs the "
                f"previous build (similarity {ratio:.2f})",
            )


# ---------------------------------------------------------------------------
# Swap (step 5)
# ---------------------------------------------------------------------------


def _publish_source_kind(*, has_draft_ops: bool, has_upstream_commits: bool) -> PublishSource:
    if has_draft_ops and has_upstream_commits:
        return "mixed"
    if has_upstream_commits:
        return "upstream"
    return "editor"


def _changed_summary(overlay: Overlay) -> dict[str, JsonValue]:
    changed: dict[str, list[str]] = {}
    for key in overlay.ops:
        file_key, sep, dotted_path = key.partition(":")
        if not sep:
            continue
        changed.setdefault(file_key, []).append(dotted_path)
    return {
        file_key: [p for p in sorted(dotted_paths)] for file_key, dotted_paths in changed.items()
    }


def _prune_builds(paths: ProjectPaths) -> None:
    """Keep every build referenced by the last `_MAX_KEPT_VERSIONS` ledger entries
    (spec/04 §5 step 5) — delete every other build dir on disk."""
    entries = read_ledger(paths)
    kept_shas = {e.sha for e in entries[-_MAX_KEPT_VERSIONS:]}
    if not paths.builds.exists():
        return
    for entry_dir in paths.builds.iterdir():
        if entry_dir.is_dir() and entry_dir.name not in kept_shas:
            shutil.rmtree(entry_dir, ignore_errors=True)
