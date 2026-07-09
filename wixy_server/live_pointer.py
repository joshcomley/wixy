"""The atomic live-build pointer (spec/04-server.md §2-3): `live.json` names which
build directory is currently served publicly. Written only by the publisher (milestone
9) and install's first-bootstrap (milestone 11) — this module only reads it.

Read fresh on every public request rather than cached in-process: there is no publish
pipeline yet to raise an in-process invalidation event, and a plain small-JSON-file
read is cheap enough that a cache would only add a staleness class of bug for no
measured benefit (see decisions/00014).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from builder.content import load_json_object
from wixy_server.storage import ProjectPaths


@dataclass(frozen=True, slots=True)
class LivePointer:
    sha: str
    version: int
    build_dir: Path


def load_live_pointer(paths: ProjectPaths) -> LivePointer | None:
    """`None` when no build has ever been published yet (pre-bootstrap, spec/04 §3) —
    callers must serve a plain 503, never crash. `build_dir` is computed from `sha` via
    `ProjectPaths.build_dir` rather than trusting `live.json`'s own `buildDir` string —
    one less path to validate against traversal, since the two are equivalent by
    construction (`paths.build_dir(sha) == paths.root / f"builds/{sha}"`, exactly what
    the publisher itself writes as `buildDir`)."""
    if not paths.live_json.exists():
        return None
    data = load_json_object(paths.live_json)
    sha = data.get("sha")
    version = data.get("version")
    if not isinstance(sha, str) or not isinstance(version, int) or isinstance(version, bool):
        return None
    return LivePointer(sha=sha, version=version, build_dir=paths.build_dir(sha))
