"""The committed Cookout catalogue (`wixy_server/livechat/cookout_catalogue.json`) is valid.

Until the full catalogue lands the file may be partial; the test then asserts it is well-formed
(every entry that is there passes every rule). Once it holds an entry for every bank ingredient and
free seasoning it must pass the validator with no `--allow-partial` (spec/server-chat/09b §F.1).
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from wixy_server.livechat.cookout_catalogue import CATALOGUE_PATH, load_cookout_catalogue

REPO = Path(__file__).resolve().parents[2]
VALIDATOR = REPO / "tooling" / "cookout" / "visual" / "validate_catalogue.py"


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cookout_validate_catalogue_data", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


vc: Any = _load_validator()


def _entry_count() -> int:
    raw = json.loads(CATALOGUE_PATH.read_text(encoding="utf-8"))
    return len(raw["items"])


def test_committed_catalogue_passes_the_validator() -> None:
    complete = _entry_count() == len(vc.load_bank_items())
    problems = vc.validate(CATALOGUE_PATH, allow_partial=not complete)
    assert problems == [], "\n".join(problems[:20])


def test_committed_catalogue_loads_through_the_runtime_loader() -> None:
    catalogue = load_cookout_catalogue()
    assert len(catalogue) == _entry_count()


def test_committed_file_is_canonically_formatted() -> None:
    """Sorted keys, one-space indent, LF, trailing newline: a re-run diffs cleanly."""
    text = CATALOGUE_PATH.read_bytes().decode("utf-8")
    assert "\r" not in text
    assert text.endswith("}\n")
    raw = json.loads(text)
    assert text == json.dumps(raw, sort_keys=True, indent=1, ensure_ascii=False) + "\n"
