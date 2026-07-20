"""The backup process's own last-run status file (spec/independence/06 §3's
"last backup age" — `wixy_server.routes_system` reads this; `wixy_server.
backup.snapshot` writes it after every run, success or failure, never only on
success — a silently-stopped backup process must show as increasingly stale,
not simply vanish from view).

A plain JSON file on its OWN small compose volume (`backup-status`), separate
from `wixy-storage` — the `backup` service mounts it read-write, `wixy`
mounts it read-only (docker-compose.yml) — so a bug anywhere in this
process's own code structurally cannot touch the site's actual state, only
ever this one small status file. Same camelCase-keyed, atomic tmp+rename
convention as every other runtime-state JSON file in this codebase
(`wixy_server.live_pointer`'s `live.json`, `wixy_server.overlay`'s
`overlay.json`) — reuses `builder.content`'s shared helpers rather than
hand-rolling a third copy of that convention.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from builder.content import atomic_write_json, load_json_object
from builder.jsontypes import JsonObject


@dataclass(frozen=True, slots=True)
class BackupStatus:
    ok: bool
    attempted_at: str
    commit_sha: str | None
    verified: bool
    monthly_tag_pushed: str | None
    error: str | None

    def to_dict(self) -> JsonObject:
        return {
            "ok": self.ok,
            "attemptedAt": self.attempted_at,
            "commitSha": self.commit_sha,
            "verified": self.verified,
            "monthlyTagPushed": self.monthly_tag_pushed,
            "error": self.error,
        }


def _status_from_dict(data: JsonObject) -> BackupStatus | None:
    ok = data.get("ok")
    attempted_at = data.get("attemptedAt")
    verified = data.get("verified")
    if (
        not isinstance(ok, bool)
        or not isinstance(attempted_at, str)
        or not isinstance(verified, bool)
    ):
        return None
    commit_sha = data.get("commitSha")
    monthly_tag_pushed = data.get("monthlyTagPushed")
    error = data.get("error")
    return BackupStatus(
        ok=ok,
        attempted_at=attempted_at,
        commit_sha=commit_sha if isinstance(commit_sha, str) else None,
        verified=verified,
        monthly_tag_pushed=monthly_tag_pushed if isinstance(monthly_tag_pushed, str) else None,
        error=error if isinstance(error, str) else None,
    )


def write_status(path: Path, status: BackupStatus) -> None:
    atomic_write_json(path, status.to_dict())


def read_status(path: Path) -> BackupStatus | None:
    """`None` when no backup has ever run yet (pre-first-night, or the
    `backup-status` volume just hasn't been mounted at all — a fleet-edition
    deployment runs no `backup` service, so this is the everyday case there)
    — callers must render a "no backup yet" state, never crash or 500."""
    if not path.exists():
        return None
    try:
        data = load_json_object(path)
    except ValueError, OSError:
        return None
    return _status_from_dict(data)
