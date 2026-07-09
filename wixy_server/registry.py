"""Server-side project registry (spec/04 §1) — loads every `projects/*.json` in the
wixy repo checkout at startup. Thin wrapper over `builder.config`: the loading logic
already lives there (shared with the CLI's `--project` flag); this module just
fixes the convention that the wixy repo checkout's own `projects/` directory (not
a site repo's) is the source, and fails loudly if it's empty or a requested slug
is unknown — a server with no projects loaded is a misconfiguration, not a valid
empty state (unlike the CLI, which always names one project explicitly).
"""

from __future__ import annotations

from pathlib import Path

from builder.config import ProjectConfig, load_all_projects


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


def load_registry(wixy_repo_root: Path) -> ProjectRegistry:
    projects = load_all_projects(wixy_repo_root / "projects")
    return ProjectRegistry(projects)
