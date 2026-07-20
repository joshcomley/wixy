"""Backup-process settings (spec/independence/06 §2) — a separate, smaller
settings surface from `wixy_server.settings.Settings`, mirroring
`wixy_server.worker.settings`'s own precedent: this process never touches
most of the main server's config (CF Access, publish pipeline), and reuses
`WIXY_STORAGE_ROOT` (the SAME env var name `wixy_server.settings.
resolve_storage_root` reads) so the identical backup logic runs unmodified
in two shapes — the droplet's `backup` compose service (`WIXY_STORAGE_ROOT=
/data`, looping) and, pre-cutover, a one-shot invocation via a hub-side
scheduled task against the fleet's own Storage tree (`WIXY_STORAGE_ROOT=
D:\\Servers\\Wixy\\Storage`, `WIXY_BACKUP_RUN_ONCE=1`) — see
`wixy_server.backup.__main__`'s own docstring.

`worker_transcripts_root` is separately configurable (not derived from
`storage_root`) because on the droplet it's a WHOLLY SEPARATE compose volume
from `wixy-storage` (decisions/00062: transcripts must never live inside a
conversation's git clone, which is why they're not inside `storage_root` in
the first place) — `None` on the fleet/hub-mirror case, which runs no
`worker` service and has no anthropic-backend transcripts to back up at all.

`GIT_SSH_COMMAND` (pointed at the state-backup-only deploy key,
decisions/00061's own naming precedent — a `WIXY_STATE_BACKUP_*` key, never
the site-repo or engine-fork key) is deliberately NOT modeled here: it is
read directly by `git` itself from the process environment (`wixy_server.
checkout.run_git` passes no explicit `env=`, so it inherits it automatically)
— the exact same "the SDK reads it, not us" pattern
`wixy_server.worker.settings`'s own docstring documents for
`ANTHROPIC_API_KEY`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _bool_env(name: str, default: str) -> bool:
    return os.environ.get(name, default) in ("1", "true", "True")


@dataclass(frozen=True, slots=True)
class BackupSettings:
    storage_root: Path
    backup_repo_url: str
    # `None` = no worker-transcripts source to back up (the fleet/hub-mirror
    # case — see module docstring); set to the mounted volume path on the
    # droplet (`/worker-transcripts`, docker-compose.yml).
    worker_transcripts_root: Path | None
    # Where this process records its own last-run outcome (spec/06 §3's "last
    # backup age" — `wixy_server.routes_system` reads this file). No default:
    # a real filesystem path a test forgetting to override could silently
    # write outside its own tmp_path (same reasoning as `WorkerSettings.
    # scratch_root`'s own no-default choice).
    status_path: Path
    # UTC hour-of-day the compose service's nightly loop targets (spec's own
    # word "nightly" — no exact hour specified, so a quiet default is picked
    # here rather than left to whatever moment the container first started).
    # Irrelevant when `run_once` is set.
    hour_utc: int = 3
    # One-shot mode (the hub-side scheduled-task invocation, or a manual
    # drill run) — run once and exit, rather than the compose service's own
    # perpetual nightly loop (`wixy_server.backup.__main__`'s own docstring).
    run_once: bool = False


def load_backup_settings(
    *, storage_root: Path | None = None, status_path: Path | None = None
) -> BackupSettings:
    transcripts_env = os.environ.get("WIXY_WORKER_TRANSCRIPTS_ROOT", "")
    return BackupSettings(
        storage_root=(
            storage_root if storage_root is not None else Path(os.environ["WIXY_STORAGE_ROOT"])
        ),
        backup_repo_url=os.environ.get("WIXY_STATE_BACKUP_REPO", ""),
        worker_transcripts_root=Path(transcripts_env) if transcripts_env else None,
        status_path=(
            status_path
            if status_path is not None
            else Path(os.environ.get("WIXY_BACKUP_STATUS_PATH", "/backup-status/status.json"))
        ),
        hour_utc=int(os.environ.get("WIXY_BACKUP_HOUR_UTC", "3")),
        run_once=_bool_env("WIXY_BACKUP_RUN_ONCE", "0"),
    )
