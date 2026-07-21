"""Storage directory layout — runtime state that survives slot swaps (spec/04 §2).

```
Storage/
  .env
  projects/<slug>/
    repo/                 site repo checkout (checkout.py)
    draft/overlay.json    draft overlay store (overlay.py)
    draft/media/          staged uploads
    builds/<sha>/         immutable build outputs
    live.json             {"sha", "version", "buildDir"}
    publishes.jsonl        append-only publish ledger
    chats.json             06 §1
    locks/publish.lock
  logs/
```

This module only computes paths and creates directories — it never touches git or
JSON content (see `checkout.py`, `overlay.py`, `publisher.py` for those). The
Storage tree itself is written ONLY by Wixy's own code (the publisher, the fetch
loop, this module's `ensure_project_dirs`) — never by agents (spec/04 §2).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class ProjectPaths:
    """Every Storage subpath for one project slug."""

    slug: str
    root: Path

    @property
    def repo(self) -> Path:
        return self.root / "repo"

    @property
    def draft_dir(self) -> Path:
        return self.root / "draft"

    @property
    def draft_overlay(self) -> Path:
        return self.draft_dir / "overlay.json"

    @property
    def draft_media(self) -> Path:
        return self.draft_dir / "media"

    @property
    def draft_media_replace(self) -> Path:
        return self.draft_dir / "media-replace"

    @property
    def draft_media_deleted_list(self) -> Path:
        return self.draft_dir / "media-deleted.json"

    @property
    def builds(self) -> Path:
        return self.root / "builds"

    def build_dir(self, sha: str) -> Path:
        return self.builds / sha

    @property
    def live_json(self) -> Path:
        return self.root / "live.json"

    @property
    def publishes_jsonl(self) -> Path:
        return self.root / "publishes.jsonl"

    @property
    def chats_json(self) -> Path:
        return self.root / "chats.json"

    @property
    def locks_dir(self) -> Path:
        return self.root / "locks"

    @property
    def thumbnails_dir(self) -> Path:
        return self.root / "thumbnails"

    @property
    def publish_lock(self) -> Path:
        return self.locks_dir / "publish.lock"


def project_paths(storage_root: Path, slug: str) -> ProjectPaths:
    return ProjectPaths(slug=slug, root=storage_root / "projects" / slug)


def logs_dir(storage_root: Path) -> Path:
    return storage_root / "logs"


def ensure_project_dirs(paths: ProjectPaths) -> None:
    """Create every directory a project's Storage tree needs, idempotently.

    Does NOT create `repo/` itself (that's `checkout.py`'s job, via `git clone`) —
    only its parent, plus every other leaf directory.
    """
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.draft_media.mkdir(parents=True, exist_ok=True)
    paths.draft_media_replace.mkdir(parents=True, exist_ok=True)
    paths.builds.mkdir(parents=True, exist_ok=True)
    paths.locks_dir.mkdir(parents=True, exist_ok=True)
