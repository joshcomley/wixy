"""`python -m wixy_server.backup` — two invocation shapes, same underlying
`wixy_server.backup.snapshot.run_backup_once` logic (spec/independence/06
§2):

1. **The droplet's `backup` compose service** (default; `WIXY_BACKUP_RUN_ONCE`
   unset) — runs one backup immediately (her backup custody starts the moment
   the stack comes up, spec's own "starts BEFORE her hosting does"), then
   loops forever, sleeping until the next `WIXY_BACKUP_HOUR_UTC` (default
   03:00 UTC) before running again. Never exits on a failed run — logs it,
   sleeps, tries again the next scheduled time, exactly the same "one bad
   night degrades, never crashes the process" posture `run_backup_once`
   itself documents.
2. **A one-shot invocation** (`WIXY_BACKUP_RUN_ONCE=1`) — runs exactly once
   and exits (0 on success, 1 on failure), for the pre-cutover hub-side
   mirror (a Windows Scheduled Task invoking this same module against the
   fleet's own Storage tree — see `deploy/standalone/hub_mirror.md`) or a
   manual/drill-time run. A perpetual loop is the wrong shape for a process
   an external scheduler (Task Scheduler, `docker compose run --rm`) already
   invokes on its own cadence.
"""

from __future__ import annotations

import logging
import sys
import time
from datetime import UTC, datetime, timedelta

from wixy_server.backup.settings import load_backup_settings
from wixy_server.backup.snapshot import run_backup_once

logger = logging.getLogger(__name__)


def _seconds_until_next_run(hour_utc: int, now: datetime) -> float:
    target = now.replace(hour=hour_utc, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = load_backup_settings()

    if settings.run_once:
        result = run_backup_once(settings, now=datetime.now(UTC))
        if not result.status.ok:
            logger.error("backup run failed: %s", result.status.error)
            sys.exit(1)
        logger.info("backup run succeeded: %s", result.status.commit_sha)
        return

    while True:
        result = run_backup_once(settings, now=datetime.now(UTC))
        if result.status.ok:
            logger.info("backup run succeeded: %s", result.status.commit_sha)
        else:
            logger.error("backup run failed: %s", result.status.error)
        wait_s = _seconds_until_next_run(settings.hour_utc, datetime.now(UTC))
        logger.info("next backup run in %.0fs", wait_s)
        time.sleep(wait_s)


if __name__ == "__main__":
    main()
