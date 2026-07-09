"""The atomic live-build pointer (spec/04-server.md §2-3): `live.json` names which
build directory is currently served publicly. Written only by the publisher's Swap
step (spec/04 §5 step 5) and by restore (§6) — every OTHER reader (preview, public
serving, `/api/admin/state`) only ever reads it.

Read fresh on every public request rather than cached in-process: there is no
in-process invalidation event worth raising, and a plain small-JSON-file read is
cheap enough that a cache would only add a staleness class of bug for no measured
benefit (see decisions/00014) — this reasoning still holds now that the publisher
exists, re-confirmed rather than assumed stale.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from builder.content import load_json_object, write_json_canonical
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


def save_live_pointer(paths: ProjectPaths, sha: str, version: int) -> None:
    """Atomically write `live.json` (tmp + rename, same pattern as `overlay.
    save_overlay`) — the ONLY moment the publicly-served site actually changes
    (spec/04 §5 step 5's Swap, and restore's §6 pointer flip)."""
    path = paths.live_json
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        write_json_canonical(
            tmp_path, {"sha": sha, "version": version, "buildDir": str(paths.build_dir(sha))}
        )
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
