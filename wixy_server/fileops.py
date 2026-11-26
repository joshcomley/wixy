"""Atomic file replacement that survives Windows' transient file locks.

On Windows a file another handle has open cannot be the target (or source) of a rename: `os.replace`
fails with WinError 5 even though nothing is wrong. Defender's real-time scan and the Search indexer
open freshly written files for milliseconds, and our own readers (the live voice decoder reading a
chunk) do the same. `replace_riding_out_scanners` retries such a rename briefly with a linear
backoff; the last attempt, and any other error, raises as before. First written for the worker
transcript (2026-07-20), shared with the chat uploads' chunk writes (decisions/00217).
"""

from __future__ import annotations

import os
import time
from pathlib import Path

# Five attempts with a linear 50 ms backoff: at most 500 ms of courtesy waiting before raising.
REPLACE_ATTEMPTS = 5
REPLACE_RETRY_BASE_S = 0.05


def replace_riding_out_scanners(source: Path, target: Path) -> None:
    """`os.replace(source, target)` with a bounded retry on `PermissionError`."""
    for attempt in range(REPLACE_ATTEMPTS):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(REPLACE_RETRY_BASE_S * (attempt + 1))
