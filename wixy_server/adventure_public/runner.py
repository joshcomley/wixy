"""The public holiday-pack research job (spec/adventure-public/README.md §2.2).

`PublicPackRunner` mirrors `livechat.adventure_pack.AdventurePackRunner`'s discipline over the
public cache (`PublicPackStore`) and reuses its pieces unchanged: the prompt (`build_prompt`), the
defensive parse (`parse_pack`), the sanitiser, the canonical JSON and the researcher seam
(`CmdAdventureResearcher`, here with its own `caller` and its own empty working folder).

What leaves this server is the destination ONLY (name, region, unit name, coordinates, all from the
static bank): the public game has no accounts and no visitor data to send. cmd keeps its own copy of
each run (the prompt and the final answer); the prompt is a function of the bank destination alone.

Concurrency and recovery, exactly as the private job except where noted:
- ONE research run in flight at a time (its own `CapacityLimiter(1)`: the private game keeps its two
  and the public game must never starve it) and spawns at least `spawn_gap_s` (5 s) apart;
- a poll every 10 s, giving up after 25 minutes (cancelling the run); a cmd `error` within the first
  150 s of a run is retried once; a run is never re-spawned when its answer might have been lost;
- every write is a compare-and-set on `(state = 'pending' AND run_id = <this run>)`, so a blue/green
  overlap where both processes poll one run stores it once;
- at startup `resume` restarts the job for every `pending` pack: with a run id it resumes polling
  that run, without one (the process died before the spawn) it starts a new run. Startup is not
  the only time a job can be lost (a route that could not hand its job over, a job that died with an
  unexpected error), so a SUPERVISED sweep (`supervise_research`, Inv 47) re-claims, by
  compare-and-set, every `pending` pack untouched for longer than the give-up budget plus a margin
  and runs the same job for it — polling its known run, else starting one;
- a failure lands as `failed` with a short generic error and a `next_try_at` (10 minutes, doubling,
  at most 3 tries per 24 hours — `store.PublicPackStore.finish`).
"""

from __future__ import annotations

import functools
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Final

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from wixy_server.adventure_public.pictures import PublicPictureJob
from wixy_server.adventure_public.store import PublicPackStore
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_pack import (
    AdventureResearcher,
    PackTiming,
    ResearchError,
    ResearchRun,
    ResearchUnavailableError,
    build_prompt,
    canonical_pack_json,
    parse_pack,
)

_LOGGER = logging.getLogger(__name__)

PUBLIC_PACK_CALLER: Final = "wixy-adventure-public-pack"
"""The `caller` cmd records a public research run under."""
PUBLIC_RESEARCH_CONCURRENCY: Final = 1
PUBLIC_FAILED_TEXT: Final = "The research didn't finish — try again in a little while"
PUBLIC_UNAVAILABLE_TEXT: Final = "Holiday packs aren't available right now"


class PublicPackRunner:
    """Runs the research job for packs that are `pending`. One instance per app; it keeps no
    per-pack state in memory — the row (and the compare-and-set writes against it) is the truth, so
    a restart or an overlapping process cannot lose or double a result.

    With a `pictures` job configured, a pack that lands `ready` starts its picture wait in the same
    write (`images = pending`) and the job then runs, outside the research slot; without one the
    pack simply has no pictures."""

    def __init__(
        self,
        *,
        store: PublicPackStore,
        bank: AdventureBank,
        researcher: AdventureResearcher | None,
        cwd: Path,
        timing: PackTiming | None = None,
        clock: Callable[[], float] = time.monotonic,
        pictures: PublicPictureJob | None = None,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._bank = bank
        self._researcher = researcher
        self._cwd = cwd
        self._pictures = pictures
        self._timing = timing if timing is not None else PackTiming()
        self._clock = clock
        self._wall_clock = wall_clock
        self._active: set[str] = set()
        """Packs this process has a job for (running or queued behind the research slot): the sweep
        never takes one of those over."""
        self._background: ContainedTaskGroup | None = None
        # Created on first use, inside the running event loop (anyio primitives bind to it).
        self._limiter: CapacityLimiter | None = None
        self._spawn_lock: anyio.Lock | None = None
        self._last_spawn: float | None = None

    @property
    def available(self) -> bool:
        """Whether a researcher is configured (a pack can be researched at all)."""
        return self._researcher is not None

    def prepare_directory(self) -> None:
        """Create the empty working folder cmd runs the research in (blocking; call from a
        thread)."""
        self._cwd.mkdir(parents=True, exist_ok=True)

    def start(self, destination_id: str, refund: Callable[[], None] | None = None) -> bool:
        """Begin the job for a pack whose row was just made `pending` (by
        `store.request_start`). `refund` gives back the start-budget slot the request took; the job
        calls it if cmd turns out to be unreachable (no run was started, so nothing was spent).
        Returns False when no job could be started (the app's background group is not running, or
        there is no researcher): the caller settles the row — it must not be left `pending` with
        nobody to run it (the sweep would heal it, but only after the give-up budget)."""
        background = self._background
        if background is None or self._researcher is None:
            return False
        self._spawn(background, destination_id, refund)
        return True

    def _spawn(
        self,
        background: ContainedTaskGroup,
        destination_id: str,
        refund: Callable[[], None] | None = None,
    ) -> None:
        self._active.add(destination_id)
        background.spawn("adventure-public-pack", self._tracked_job, destination_id, refund)

    async def _tracked_job(
        self, destination_id: str, refund: Callable[[], None] | None = None
    ) -> None:
        try:
            await self.run_job(destination_id, refund)
        finally:
            self._active.discard(destination_id)

    async def resume(self, background: ContainedTaskGroup) -> int:
        """Startup recovery: bind the app's background group, then start the job for every `pending`
        pack (resuming the run it recorded, or starting one if the process died before the spawn).
        Without a researcher those packs can never finish, so they become `failed` (retryable at
        once, the try not counted). Returns how many packs were found."""
        self._background = background
        pending = await anyio.to_thread.run_sync(self._store.pending_packs)
        for destination_id, run_id in pending:
            if self._researcher is None:
                await self._finish_failed(
                    destination_id, run_id, error=PUBLIC_UNAVAILABLE_TEXT, transient=True
                )
            else:
                self._spawn(background, destination_id)
        if self._pictures is not None:
            await self._pictures.resume(background)
        return len(pending)

    async def sweep_stale(self, background: ContainedTaskGroup) -> int:
        """One pass of the research sweep: every `pending` pack untouched for longer than the
        give-up budget plus the margin, and not one of this process's own jobs, is claimed
        (compare-and-set, so a blue/green neighbour's sweep takes it once) and its job is run:
        `run_job` polls the run the row knows, else starts one. Returns how many were claimed."""
        if self._researcher is None:
            return 0  # nothing can be researched here (startup `resume` settled what it found)
        timing = self._timing
        now = self._wall_clock()
        stale_before = now - (timing.give_up_s + timing.stale_margin_s)
        stale = await anyio.to_thread.run_sync(
            lambda: self._store.stale_pending(stale_before=stale_before)
        )
        claimed = 0
        for destination_id in stale:
            if destination_id in self._active:
                continue
            taken = await anyio.to_thread.run_sync(
                functools.partial(
                    self._store.claim_pending,
                    destination_id,
                    stale_before=stale_before,
                    now=self._wall_clock(),
                )
            )
            if not taken:
                continue
            claimed += 1
            _LOGGER.warning(
                "public adventure pack %s was stuck pending; re-running it", destination_id
            )
            self._spawn(background, destination_id)
        return claimed

    async def watch_stale_forever(self, background: ContainedTaskGroup) -> None:
        """The supervised loop: sweep every `stale_sweep_interval_s`. A failed sweep is logged and
        tried again on the next tick, never fatal."""
        while True:
            await anyio.sleep(self._timing.stale_sweep_interval_s)
            try:
                await self.sweep_stale(background)
            except Exception:
                _LOGGER.exception("public adventure research: the sweep for stuck packs failed")

    def supervise_research(self, background: ContainedTaskGroup) -> None:
        """Start the research sweep as a supervised app-lifetime loop (Inv 47), next to the picture
        sweep: a pack stuck `pending` heals within one give-up budget and a margin, with no
        restart."""
        self._background = background

        async def _watch() -> None:
            await self.watch_stale_forever(background)

        background.supervise("adventure-public-research-watch", _watch)

    def supervise_pictures(self, background: ContainedTaskGroup) -> None:
        """Start the picture job's self-healing sweep as a supervised app-lifetime loop (Inv 47). A
        no-op without pictures."""
        pictures = self._pictures
        if pictures is None:
            return

        async def _watch() -> None:
            await pictures.watch_forever(background)

        background.supervise("adventure-public-pictures-watch", _watch)

    async def run_job(self, destination_id: str, refund: Callable[[], None] | None = None) -> None:
        """Research the destination and land the outcome on its row; once the pack is `ready` (and
        pictures are configured) go on to find its pictures. Never raises for an ordinary failure
        (it becomes `failed`); only cancellation (shutdown) propagates, and the pack stays
        `pending` for the next start to resume. `refund` is called (once) if cmd cannot be
        reached to start the run."""
        researcher = self._researcher
        if researcher is None:
            return
        limiter, spawn_lock = self._primitives()
        pictures_due = False
        try:
            async with limiter:
                pictures_due = await self._run(destination_id, researcher, spawn_lock, refund)
        except Exception:
            _LOGGER.exception("public adventure pack job for %s failed", destination_id)
            try:
                row = await anyio.to_thread.run_sync(lambda: self._store.get(destination_id))
                if row is not None:
                    await self._finish_failed(destination_id, row.run_id, error=PUBLIC_FAILED_TEXT)
            except Exception:
                _LOGGER.exception("could not mark %s's public pack failed", destination_id)
        if pictures_due and self._pictures is not None:
            # The text pack is already stored and served; the pictures follow when found.
            await self._pictures.run(destination_id)

    def _primitives(self) -> tuple[CapacityLimiter, anyio.Lock]:
        if self._limiter is None:
            self._limiter = CapacityLimiter(PUBLIC_RESEARCH_CONCURRENCY)
        if self._spawn_lock is None:
            self._spawn_lock = anyio.Lock()
        return self._limiter, self._spawn_lock

    async def _finish_failed(
        self,
        destination_id: str,
        run_id: str | None,
        *,
        error: str,
        transient: bool = False,
    ) -> bool:
        return await anyio.to_thread.run_sync(
            lambda: self._store.finish(
                destination_id, run_id=run_id, state="failed", error=error, transient=transient
            )
        )

    async def _finish_ready(
        self, destination_id: str, run_id: str, pack_json: str, pictures_pending: bool
    ) -> bool:
        return await anyio.to_thread.run_sync(
            functools.partial(
                self._store.finish,
                destination_id,
                run_id=run_id,
                state="ready",
                pack_json=pack_json,
                pictures_pending=pictures_pending,
            )
        )

    async def _still_waiting(self, destination_id: str, run_id: str | None) -> bool:
        """Whether the pack still has a `pending` state waiting on exactly `run_id`."""
        row = await anyio.to_thread.run_sync(lambda: self._store.get(destination_id))
        return row is not None and row.state == "pending" and row.run_id == run_id

    async def _start_run(
        self,
        researcher: AdventureResearcher,
        spawn_lock: anyio.Lock,
        destination_id: str,
        prompt: str,
        expected_run_id: str | None,
        refund: Callable[[], None] | None = None,
    ) -> str | None:
        """Start a run (spawns serialised and at least `spawn_gap_s` apart) and record it on the
        pack. Returns the new run id, or `None` when the job is over: the pack no longer wanted a
        run, cmd could not start one (the outcome is already stored), or another process won the
        compare-and-set (our run is cancelled)."""
        async with spawn_lock:
            if not await self._still_waiting(destination_id, expected_run_id):
                return None
            if self._last_spawn is not None:
                wait = self._last_spawn + self._timing.spawn_gap_s - self._clock()
                if wait > 0:
                    await anyio.sleep(wait)
            self._last_spawn = self._clock()
            try:
                run_id = await researcher.start(prompt=prompt, cwd=self._cwd)
            except ResearchUnavailableError:
                await self._finish_failed(
                    destination_id, expected_run_id, error=PUBLIC_UNAVAILABLE_TEXT, transient=True
                )
                if refund is not None:
                    refund()  # cmd never saw a run: the visitor's start budget is not spent
                return None
            except ResearchError:
                _LOGGER.warning(
                    "cmd refused the public holiday pack research for %s", destination_id
                )
                await self._finish_failed(destination_id, expected_run_id, error=PUBLIC_FAILED_TEXT)
                return None
            finally:
                self._last_spawn = self._clock()
        recorded = await anyio.to_thread.run_sync(
            lambda: self._store.set_run(
                destination_id, run_id=run_id, expected_run_id=expected_run_id
            )
        )
        if not recorded:
            await researcher.cancel(run_id)
            return None
        return run_id

    async def _run(
        self,
        destination_id: str,
        researcher: AdventureResearcher,
        spawn_lock: anyio.Lock,
        refund: Callable[[], None] | None = None,
    ) -> bool:
        """Drive the research to its outcome. Returns True exactly when THIS call stored the pack
        `ready` and its picture wait is pending (the caller then runs the picture job)."""
        row = await anyio.to_thread.run_sync(lambda: self._store.get(destination_id))
        if row is None or row.state != "pending":
            return False
        destination = self._bank.destination(destination_id)
        unit = self._bank.unit_of(destination_id)
        if destination is None or unit is None:
            await self._finish_failed(destination_id, row.run_id, error=PUBLIC_FAILED_TEXT)
            return False
        prompt = build_prompt(destination, unit.name)

        timing = self._timing
        deadline = self._clock() + timing.give_up_s
        run_id = row.run_id
        may_retry = run_id is None  # a resumed run has no known start, so no early retry
        if run_id is None:
            run_id = await self._start_run(
                researcher, spawn_lock, destination_id, prompt, None, refund
            )
            if run_id is None:
                return False
        started = self._clock()
        poll_errors = 0

        while True:
            if not await self._still_waiting(destination_id, run_id):
                # Finished or restarted by another process meanwhile.
                await researcher.cancel(run_id)
                return False
            run: ResearchRun | None = None
            try:
                run = await researcher.poll(run_id)
                poll_errors = 0
            except ResearchError:
                poll_errors += 1
                if poll_errors >= timing.max_consecutive_poll_errors:
                    _LOGGER.warning("giving up on research run %s: cmd keeps failing", run_id)
                    await self._finish_failed(destination_id, run_id, error=PUBLIC_FAILED_TEXT)
                    return False

            if run is not None:
                if run.status == "completed":
                    pack = parse_pack(run.response_text or "")
                    if pack is None:
                        _LOGGER.warning("research run %s returned no usable pack", run_id)
                        await self._finish_failed(destination_id, run_id, error=PUBLIC_FAILED_TEXT)
                        return False
                    pictures_pending = self._pictures is not None
                    stored = await self._finish_ready(
                        destination_id, run_id, canonical_pack_json(pack), pictures_pending
                    )
                    return stored and pictures_pending
                if run.status in ("error", "timeout", "cancelled"):
                    early = self._clock() - started <= timing.early_retry_s
                    if run.status == "error" and may_retry and early:
                        may_retry = False
                        retried = await self._start_run(
                            researcher, spawn_lock, destination_id, prompt, run_id
                        )
                        if retried is None:
                            return False
                        run_id = retried
                        started = self._clock()
                        continue
                    _LOGGER.warning("research run %s ended %s", run_id, run.status)
                    await self._finish_failed(destination_id, run_id, error=PUBLIC_FAILED_TEXT)
                    return False

            if self._clock() >= deadline:
                _LOGGER.warning("research run %s did not finish in time; giving up", run_id)
                await researcher.cancel(run_id)
                await self._finish_failed(destination_id, run_id, error=PUBLIC_FAILED_TEXT)
                return False
            await anyio.sleep(timing.poll_interval_s)
