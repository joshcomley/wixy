"""Building a `SiteSource` from a Storage-managed checkout (spec/04 §3-4) — the one
place server code turns "a project + a checkout on disk" into what `builder` needs.
Shared by every route that needs merged content (preview, `/api/admin/content`,
`/api/admin/state`) so each doesn't reimplement the same two checks.
"""

from __future__ import annotations

from pathlib import Path

from builder.config import ProjectConfig
from builder.render import SiteSource, load_site_source
from builder.theme import Theme, load_theme
from wixy_server.checkout import CheckoutError


def load_theme_if_present(repo_root: Path) -> Theme | None:
    """`theme/theme.json` doesn't exist before migration step 4 (spec/03 §3.4) —
    `SiteSource.theme` is `None` until then; every render/build path already tolerates
    that (decisions/00004)."""
    theme_path = repo_root / "theme" / "theme.json"
    return load_theme(theme_path) if theme_path.exists() else None


def build_site_source(project: ProjectConfig, repo_root: Path) -> SiteSource:
    """Raises `CheckoutError` if the checkout hasn't completed its first clone yet —
    callers map that to a 503 (spec/04 §3's "never a crash" posture applied to every
    server surface that reads the checkout, not just public serving)."""
    if not (repo_root / ".git").exists():
        raise CheckoutError("site repo checkout is not ready yet (initial clone pending)")
    theme = load_theme_if_present(repo_root)
    return load_site_source(repo_root, project, theme)
