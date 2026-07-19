"""Process-wide working-tree lock: mutations vs reads on the Storage checkout.

Incident (2026-07-19): the admin's Edit buttons latched disabled — `GET
/api/admin/state` computes `pages[].editable` from `pages/<slug>.html` existence,
and a state read racing a working-tree mutation (the watcher's fast-forward or a
publish's materialize/reset) can observe templates mid-replacement and report
`editable: false`. The shell then cached that snapshot indefinitely.

Every working-tree MUTATION (`ensure_checkout`'s fetch+ff, the publisher's
materialize / commit / reset steps) and every tree READ (`_build_state`,
`_build_content`, preview rendering) runs inside worker threads
(`anyio.to_thread`), so one process-wide re-entrant `threading` lock gives
readers a mutation-consistent snapshot without any async plumbing. Re-entrant
because the publisher holds it across a step that itself calls
`ensure_checkout`. Cross-process coordination is unchanged (`publish.lock` file,
single serving process); this lock closes the intra-process read race only.

Hold discipline: mutations hold it for one step at a time (never across the
multi-second build/verify phases — those read a committed, quiescent tree);
reads hold it just long enough to parse the tree. Worst-case reader wait is one
git fast-forward or one materialize step.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager

_TREE_LOCK = threading.RLock()


@contextmanager
def tree_lock() -> Iterator[None]:
    """Hold the process-wide working-tree lock (re-entrant)."""
    with _TREE_LOCK:
        yield
