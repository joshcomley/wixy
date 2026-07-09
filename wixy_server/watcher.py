"""Upstream watcher (spec/04-server.md §7): keeps the site-repo checkout fast-forwarded
to `origin/<default_branch>` in the background, so request-serving code (the preview
route, the publisher) never pays a network `git fetch` inline — spec/04 §4's <150ms
render budget depends on the checkout already being fresh by the time a preview
request arrives, not on the request itself fetching.

Skips its tick entirely while a publish is in flight (`paths.publish_lock` exists,
written/removed by `wixy_server.publisher.run_publish` for the pipeline's duration) —
spec/04 §7: "fast-forward the working tree to origin/main... (taking the publish
lock; skipped while a publish/materialize is in flight)". This closes
decisions/00013's own flagged gap: a background fetch racing a publish's uncommitted
materialize/commit work could otherwise fast-forward the working tree out from under
it mid-pipeline.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime

import anyio

from builder.config import ProjectConfig
from wixy_server.checkout import CheckoutError, ensure_checkout
from wixy_server.storage import ProjectPaths

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_S = 60.0


@dataclass
class WatcherStatus:
    """Last-fetch outcome, shared between the background loop and `/api/admin/state`
    (spec/04 §7's `fetchedAt`). Uses the real wall clock directly, unlike
    `wixy_server.overlay`'s caller-supplied-`now` convention — this is observability
    state about a background loop, not business logic under test for exact-timestamp
    determinism."""

    fetched_at: datetime | None = None
    last_error: str | None = None


def fetch_once(
    project: ProjectConfig, paths: ProjectPaths, status: WatcherStatus | None = None
) -> None:
    """One fetch-and-fast-forward attempt. Synchronous (git subprocess I/O) — callers
    on the event loop must run it via `anyio.to_thread.run_sync`.

    A no-op while `paths.publish_lock` exists (spec/04 §7) — checked BEFORE calling
    `ensure_checkout` at all, so this tick doesn't even attempt a fetch/merge while
    the publisher owns the working tree; the next tick (after the lock is released)
    picks up wherever the publish's own fetch/merge left the checkout."""
    if paths.publish_lock.exists():
        return
    try:
        ensure_checkout(project.repo, project.default_branch, paths.repo)
    except CheckoutError as exc:
        # spec/04 §7: "Fetch failures degrade gracefully" — the checkout just stays at
        # whatever SHA it last successfully reached; the next tick tries again.
        logger.exception("upstream watcher: fetch failed for project '%s'", project.slug)
        if status is not None:
            status.last_error = str(exc)
        return
    if status is not None:
        status.fetched_at = datetime.now(UTC)
        status.last_error = None


async def watch_upstream(
    project: ProjectConfig,
    paths: ProjectPaths,
    *,
    interval_s: float = DEFAULT_INTERVAL_S,
    sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
    status: WatcherStatus | None = None,
) -> None:
    """Runs until cancelled: `fetch_once` every `interval_s` seconds, off the event
    loop. `sleep` is injectable so tests can drive fast iterations without waiting on
    the real interval."""
    while True:
        await anyio.to_thread.run_sync(fetch_once, project, paths, status)
        await sleep(interval_s)
