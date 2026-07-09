"""Wixy builder: pure library for building/validating/serving the site (no server imports).

See spec/02-content-model.md (normative content contract) and spec/04-server.md §3-4
(how wixy_server consumes this). CLI: `python -m builder build|validate|serve`.
"""

from builder.build import build_site, hash_output_tree
from builder.config import ProjectConfig, load_project_config
from builder.errors import BuildError, ValidationError, ValidationResult
from builder.render import SiteSource, load_site_source, render_page
from builder.theme import Theme, load_theme
from builder.validate import validate_site

__all__ = [
    "BuildError",
    "ProjectConfig",
    "SiteSource",
    "Theme",
    "ValidationError",
    "ValidationResult",
    "build_site",
    "hash_output_tree",
    "load_project_config",
    "load_site_source",
    "load_theme",
    "render_page",
    "validate_site",
]
