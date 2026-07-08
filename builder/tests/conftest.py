"""Shared pytest fixtures for the builder test suite."""

from __future__ import annotations

from pathlib import Path

import pytest

from builder.config import ProjectConfig, load_project_config
from builder.render import SiteSource, load_site_source
from builder.theme import Theme, load_theme

FIXTURES_DIR = Path(__file__).parent / "fixtures"
MINI_SITE_DIR = FIXTURES_DIR / "mini-site"
PROJECT_JSON = FIXTURES_DIR / "project.json"


@pytest.fixture
def mini_site_root() -> Path:
    return MINI_SITE_DIR


@pytest.fixture
def mini_project() -> ProjectConfig:
    return load_project_config(PROJECT_JSON)


@pytest.fixture
def mini_theme() -> Theme:
    return load_theme(MINI_SITE_DIR / "theme" / "theme.json")


@pytest.fixture
def mini_site_source(mini_project: ProjectConfig, mini_theme: Theme) -> SiteSource:
    return load_site_source(MINI_SITE_DIR, mini_project, mini_theme)
