from __future__ import annotations

import json
from pathlib import Path

import pytest

from builder.content import write_json_canonical
from wixy_server.live_pointer import LivePointer, load_live_pointer
from wixy_server.storage import ProjectPaths, project_paths


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return project_paths(tmp_path, "test")


class TestLoadLivePointer:
    def test_returns_none_when_no_live_json(self, paths: ProjectPaths) -> None:
        assert load_live_pointer(paths) is None

    def test_reads_sha_version_and_computes_build_dir(self, paths: ProjectPaths) -> None:
        sha = "a" * 40
        write_json_canonical(
            paths.live_json, {"sha": sha, "version": 3, "buildDir": f"builds/{sha}"}
        )
        pointer = load_live_pointer(paths)
        assert pointer == LivePointer(sha=sha, version=3, build_dir=paths.build_dir(sha))

    def test_ignores_a_hand_edited_build_dir_field(self, paths: ProjectPaths) -> None:
        """`build_dir` is always computed from `sha`, never trusted from the file's own
        `buildDir` string (decisions/00014) — a malicious/corrupted value there must
        not be able to redirect serving elsewhere."""
        sha = "b" * 40
        write_json_canonical(
            paths.live_json, {"sha": sha, "version": 1, "buildDir": "../../../etc"}
        )
        pointer = load_live_pointer(paths)
        assert pointer is not None
        assert pointer.build_dir == paths.build_dir(sha)

    def test_malformed_file_treated_as_not_bootstrapped(self, paths: ProjectPaths) -> None:
        paths.root.mkdir(parents=True)
        paths.live_json.write_text(json.dumps({"sha": 12345, "version": "x"}), encoding="utf-8")
        assert load_live_pointer(paths) is None

    def test_boolean_version_is_rejected(self, paths: ProjectPaths) -> None:
        """`isinstance(True, int)` is `True` in Python — guard against a stray boolean
        being accepted as a version number."""
        paths.root.mkdir(parents=True)
        paths.live_json.write_text(json.dumps({"sha": "c" * 40, "version": True}), encoding="utf-8")
        assert load_live_pointer(paths) is None
