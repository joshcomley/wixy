"""Shared runner for cmd chat-spawn runs (spec/server-chat/09b §A.3): paced, journalled, resumable.

* at most ``MAX_IN_FLIGHT`` runs per provider, at least ``SPAWN_GAP_S`` between any two spawns;
* every spawn's ``run_id`` is journalled BEFORE polling, so a crashed tool resumes polling the same
  run instead of spawning (and paying for) a second one;
* a run that outlives its ``timeout_secs`` (plus a grace period) is cancelled.

Built on ``wixy_server.cmdchat.CmdChatClient`` (any object with the same three methods works, which
is how the tests drive it with fakes). Offline tooling: no chat content ever reaches a prompt.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from wixy_server.cmdchat import (  # noqa: E402
    CHAT_SPAWN_TERMINAL_STATUSES,
    ChatSpawnRun,
    CmdChatClient,
    CmdChatError,
)

MAX_IN_FLIGHT = 3
SPAWN_GAP_S = 5.0
POLL_S = 10.0
DEADLINE_GRACE_S = 120.0
MAX_POLL_ERRORS = 6
IN_FLIGHT = frozenset({"spawned", "queued", "running"})
RESUMABLE = IN_FLIGHT | {"completed"}
"""A journalled run in one of these states is polled again, never re-spawned (a completed run's
answer is fetched once more: the crash may have come before its result was used)."""

# Tools a "research but never write" run must not have (leaves WebSearch/WebFetch/Read).
READ_ONLY_DISALLOWED = (
    "Bash",
    "PowerShell",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Agent",
    "Task",
)


class RunClient(Protocol):
    async def spawn_run(
        self,
        *,
        caller: str,
        prompt: str,
        model: str,
        effort: str,
        cwd: str,
        timeout_secs: int,
        disallowed_tools: list[str],
        provider: str | None = None,
        tool_profile: str | None = None,
        naked: bool | None = None,
    ) -> ChatSpawnRun: ...

    async def get_run(self, run_id: str) -> ChatSpawnRun: ...

    async def cancel_run(self, run_id: str) -> None: ...


@dataclass(frozen=True, slots=True)
class Model:
    """A cmd chat-spawn model (spec §0.1)."""

    provider: str
    model: str


HAIKU = Model("claude", "claude-haiku-5-5")
LUNA = Model("codex", "gpt-6-luna")
SOL = Model("codex", "gpt-6.1-sol")
OPUS = Model("claude", "claude-opus-5-5")


@dataclass(frozen=True, slots=True)
class RunSpec:
    caller: str
    prompt: str
    model: Model
    effort: str
    cwd: str
    timeout_secs: int
    tool_profile: str | None = None
    disallowed_tools: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RunOutcome:
    run_id: str | None
    status: str  # completed | error | timeout | cancelled | spawn-failed
    text: str | None
    error: str | None
    resumed: bool = False

    @property
    def ok(self) -> bool:
        return self.status == "completed" and self.text is not None


class Journal:
    """Append-only JSON-lines journal; the last record per ``(batch, pass)`` is the state."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def append(self, record: dict[str, object]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, sort_keys=True, ensure_ascii=False)
        with self.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")
            handle.flush()

    def records(self) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        out: list[dict[str, object]] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except ValueError:
                continue  # a torn last line from a crash: the state before it still stands
            if isinstance(value, dict):
                out.append(value)
        return out

    def latest(self, batch: str, pass_name: str) -> dict[str, object] | None:
        found: dict[str, object] | None = None
        for record in self.records():
            if record.get("batch") == batch and record.get("pass") == pass_name:
                found = record
        return found


@dataclass
class RunPool:
    client: RunClient
    journal: Journal
    max_in_flight: int = MAX_IN_FLIGHT
    spawn_gap_s: float = SPAWN_GAP_S
    poll_s: float = POLL_S
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    now: Callable[[], float] = time.time
    _semaphores: dict[str, asyncio.Semaphore] = field(default_factory=dict)
    _spawn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _last_spawn: float | None = None

    def _semaphore(self, provider: str) -> asyncio.Semaphore:
        if provider not in self._semaphores:
            self._semaphores[provider] = asyncio.Semaphore(self.max_in_flight)
        return self._semaphores[provider]

    def _record(
        self,
        batch: str,
        pass_name: str,
        ids: Sequence[str],
        run_id: str | None,
        status: str,
        **extra: object,
    ) -> None:
        self.journal.append(
            {
                "batch": batch,
                "pass": pass_name,
                "ids": list(ids),
                "run_id": run_id,
                "status": status,
                "at": int(self.now()),
                **extra,
            }
        )

    async def run(
        self, batch: str, pass_name: str, ids: Sequence[str], spec: RunSpec
    ) -> RunOutcome:
        """Run one batch to a terminal outcome, resuming a journalled in-flight run if any."""
        async with self._semaphore(spec.model.provider):
            prior = self.journal.latest(batch, pass_name)
            run_id: str | None = None
            started_at = self.now()
            resumed = False
            if prior is not None and prior.get("status") in RESUMABLE:
                prior_id = prior.get("run_id")
                if isinstance(prior_id, str) and prior_id:
                    run_id = prior_id
                    at = prior.get("started_at", prior.get("at"))
                    if isinstance(at, (int, float)):
                        started_at = float(at)
                    resumed = True
            if run_id is None:
                try:
                    run = await self._spawn(spec)
                except CmdChatError as exc:
                    self._record(batch, pass_name, ids, None, "spawn-failed", error=str(exc)[:300])
                    return RunOutcome(None, "spawn-failed", None, str(exc)[:300])
                run_id = run.run_id
                started_at = self.now()
                # Written BEFORE polling: a crash from here on resumes this run, never a second.
                self._record(batch, pass_name, ids, run_id, "spawned", started_at=int(started_at))
            return await self._poll(batch, pass_name, ids, run_id, started_at, spec, resumed)

    async def _spawn(self, spec: RunSpec) -> ChatSpawnRun:
        async with self._spawn_lock:
            if self._last_spawn is not None:
                wait = self.spawn_gap_s - (self.now() - self._last_spawn)
                if wait > 0:
                    await self.sleep(wait)
            try:
                return await self.client.spawn_run(
                    caller=spec.caller,
                    prompt=spec.prompt,
                    model=spec.model.model,
                    effort=spec.effort,
                    cwd=spec.cwd,
                    timeout_secs=spec.timeout_secs,
                    disallowed_tools=list(spec.disallowed_tools),
                    provider=spec.model.provider,
                    tool_profile=spec.tool_profile,
                )
            finally:
                self._last_spawn = self.now()

    async def _poll(
        self,
        batch: str,
        pass_name: str,
        ids: Sequence[str],
        run_id: str,
        started_at: float,
        spec: RunSpec,
        resumed: bool,
    ) -> RunOutcome:
        deadline = started_at + spec.timeout_secs + DEADLINE_GRACE_S
        errors = 0
        while True:
            run: ChatSpawnRun | None
            try:
                run = await self.client.get_run(run_id)
                errors = 0
            except CmdChatError as exc:
                errors += 1
                if errors >= MAX_POLL_ERRORS:
                    self._record(batch, pass_name, ids, run_id, "error", error=str(exc)[:300])
                    message = f"polling failed: {exc}"[:300]
                    return RunOutcome(run_id, "error", None, message, resumed)
                run = None
            if run is not None and run.status in CHAT_SPAWN_TERMINAL_STATUSES:
                self._record(batch, pass_name, ids, run_id, run.status)
                return RunOutcome(run_id, run.status, run.response_text, run.error_text, resumed)
            if self.now() >= deadline:
                try:
                    await self.client.cancel_run(run_id)
                except CmdChatError:
                    pass
                self._record(batch, pass_name, ids, run_id, "timeout")
                return RunOutcome(
                    run_id, "timeout", None, "deadline passed; run cancelled", resumed
                )
            await self.sleep(self.poll_s)


def real_client() -> CmdChatClient:
    return CmdChatClient()
