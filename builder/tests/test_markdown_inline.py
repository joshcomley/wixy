"""`builder.markdown_inline` tests (decisions/00075).

The fixture cases are THE shared contract with the editor twin
(`editor/src/markdownText.ts`) — `editor/tests/markdownText.test.ts` loads this
same JSON file, so any drift between the two halves fails one side's suite
(Inv 20). Add new cases to the fixture, not to ad-hoc tests here, unless one
side genuinely can't express the case.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from builder.markdown_inline import render_markdown_inline

_FIXTURE = Path(__file__).parent / "fixtures" / "markdown-inline.json"


def _cases() -> list[dict[str, str]]:
    data: object = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    return [c for c in data if isinstance(c, dict)]


@pytest.mark.parametrize("case", _cases(), ids=[c["name"] for c in _cases()])
def test_fixture_case(case: dict[str, str]) -> None:
    assert render_markdown_inline(case["source"]) == case["expected"]


def test_output_is_idempotent_over_already_rendered_allowlist_html() -> None:
    """Rendering the OUTPUT again must not double-process: allowlist tags pass
    through verbatim, so a rebuild of rendered content is a fixed point."""
    once = render_markdown_inline("**bold** and *italic* with [a](/x.html)")
    assert render_markdown_inline(once) == once
