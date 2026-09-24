"""Contain application background failures so one task cannot cancel its siblings."""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import anyio
from anyio.abc import TaskGroup

_LOGGER = logging.getLogger(__name__)
_MAX_BACKOFF_S = 60.0
_HEALTHY_RESET_S = 300.0


@dataclass(frozen=True)
class TaskFailure:
    consecutive_failures: int
    last_failure_at: float


class BackgroundTaskHealth:
    """Small event-loop-owned health registry for contained background tasks."""

    def __init__(self) -> None:
        self._failures: dict[str, TaskFailure] = {}

    def failed(self, name: str, *, ran_for_s: float) -> None:
        previous = self._failures.get(name)
        count = (
            1
            if previous is None or ran_for_s >= _HEALTHY_RESET_S
            else previous.consecutive_failures + 1
        )
        self._failures[name] = TaskFailure(count, time.time())

    def consecutive_failures(self, name: str) -> int:
        failure = self._failures.get(name)
        if failure is None or time.time() - failure.last_failure_at >= _HEALTHY_RESET_S:
            return 0
        return failure.consecutive_failures

    def last_failure_at(self, name: str) -> float | None:
        failure = self._failures.get(name)
        return failure.last_failure_at if failure is not None else None

    def media_degraded(self) -> bool:
        return any(
            self.consecutive_failures(name) >= 3 for name in ("livechat-media", "livechat-erasure")
        )


class ContainedTaskGroup:
    """Expose only supervised loops and non-propagating one-shot spawns."""

    def __init__(self, task_group: TaskGroup, health: BackgroundTaskHealth | None = None) -> None:
        self._task_group = task_group
        self.health = health if health is not None else BackgroundTaskHealth()

    def supervise(self, name: str, loop_fn: Callable[[], Awaitable[object]]) -> None:
        self._task_group.start_soon(self._supervise, name, loop_fn)

    async def _supervise(self, name: str, loop_fn: Callable[[], Awaitable[object]]) -> None:
        delay = 1.0
        while True:
            started = time.monotonic()
            try:
                await loop_fn()
            except Exception:
                ran_for = time.monotonic() - started
                if ran_for >= _HEALTHY_RESET_S:
                    delay = 1.0
                self.health.failed(name, ran_for_s=ran_for)
                _LOGGER.exception("Background loop %s failed; restarting in %.1fs", name, delay)
            else:
                ran_for = time.monotonic() - started
                if ran_for >= _HEALTHY_RESET_S:
                    delay = 1.0
                self.health.failed(name, ran_for_s=ran_for)
                _LOGGER.error("Background loop %s returned; restarting in %.1fs", name, delay)
            await anyio.sleep(delay)
            delay = min(delay * 2.0, _MAX_BACKOFF_S)

    def spawn(self, name: str, fn: Callable[..., Awaitable[Any]], *args: Any) -> None:
        self._task_group.start_soon(self._run_once, name, fn, args)

    async def _run_once(
        self, name: str, fn: Callable[..., Awaitable[Any]], args: tuple[Any, ...]
    ) -> None:
        try:
            await fn(*args)
        except Exception:
            self.health.failed(name, ran_for_s=0.0)
            _LOGGER.exception("One-shot background task %s failed", name)
