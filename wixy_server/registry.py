"""Server-side project registry (spec/04 §1) — loads every `projects/*.json` in the
wixy repo checkout at startup. Thin wrapper over `builder.config`: the loading logic
already lives there (shared with the CLI's `--project` flag); this module just
fixes the convention that the wixy repo checkout's own `projects/` directory (not
a site repo's) is the source, and fails loudly if it's empty or a requested slug
is unknown — a server with no projects loaded is a misconfiguration, not a valid
empty state (unlike the CLI, which always names one project explicitly).

Independence-phase env overrides (spec/independence/01 §2.2): `WIXY_SITE_REPO` (an
SSH URL — `checkout.run_git` disables credential helpers, so HTTPS+token isn't an
option), `WIXY_DOMAIN`, `WIXY_INDEXABLE` layer over the committed `projects/*.json`
so her standalone deployment can point at her own transferred site repo/domain
without forking the registry file itself. Deliberately kept in THIS module rather
than `builder/config.py` — `builder/` has no server imports and must stay importable
standalone by the site repo's own CI (see repo CLAUDE.md); env-var resolution is a
server/deployment concern. Process environment only, same precedent as
`WIXY_STORAGE_ROOT`/`WIXY_SLOT` (settings.py) — this loader has no `.env` access and
none is needed: these are deployment-identity facts fixed for the container's
lifetime, not something hand-edited after install.
"""

from __future__ import annotations

import os
from dataclasses import replace
from pathlib import Path

from builder.config import ProjectConfig, load_all_projects

_TRUTHY = {"1", "true", "True"}


class UnknownProjectError(Exception):
    """A requested project slug isn't in the registry."""


class ProjectRegistry:
    def __init__(self, projects: dict[str, ProjectConfig]) -> None:
        if not projects:
            raise ValueError("project registry is empty — no projects/*.json found")
        self._projects = projects

    def get(self, slug: str) -> ProjectConfig:
        try:
            return self._projects[slug]
        except KeyError:
            raise UnknownProjectError(f"unknown project slug '{slug}'") from None

    def all(self) -> list[ProjectConfig]:
        return list(self._projects.values())

    def __contains__(self, slug: str) -> bool:
        return slug in self._projects


def _apply_env_overrides(cfg: ProjectConfig) -> ProjectConfig:
    repo = os.environ.get("WIXY_SITE_REPO") or cfg.repo
    domain = os.environ.get("WIXY_DOMAIN") or cfg.domain
    indexable_raw = os.environ.get("WIXY_INDEXABLE")
    indexable = cfg.indexable if indexable_raw is None else indexable_raw in _TRUTHY
    return replace(cfg, repo=repo, domain=domain, indexable=indexable)


def load_registry(wixy_repo_root: Path) -> ProjectRegistry:
    projects = load_all_projects(wixy_repo_root / "projects")
    overridden = {slug: _apply_env_overrides(cfg) for slug, cfg in projects.items()}
    return ProjectRegistry(overridden)
