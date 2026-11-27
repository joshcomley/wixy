"""The public holiday pack's pictures (spec/adventure-public/README.md §2.2, Inv 61).

`PublicPictureJob` mirrors `livechat.adventure_pictures.AdventurePictureJob` over the public cache:
once a pack is stored `ready` its `images` wait is `pending`, and this job finds the pictures
(`plan_pictures`, then the finder's 240 s hunt), writes each as a full-size `full.jpg` (at
most 1600 px, as found) and a `thumb.jpg` (at most 480 px on the long edge) under
`adventure-public/pictures/<id>/`, and attaches them ALL in one transaction that also flips `images`
to `done` — all or nothing per pack. Staged files of a lost race are removed.

The public finder is built with `allow_site_images=False`: ONLY freely-licensed Wikimedia Commons
files, each with its credit and licence, are ever published (no venue page is fetched).

A `pending` wait is self-healing exactly like the private one: when the current hunt began is
recorded with the pack (`images_started_at`) and `watch_forever` — a supervised loop on the
contained group (Inv 47) — re-claims any pack pending longer than a hunt can take; startup
redoes every hunt the previous process left pending; a pack whose hunts keep dying ends as
`failed` after `max_tries`. The sweep also removes staged picture directories no row owns (a
process killed between staging and the attach).
"""

from __future__ import annotations

import io
import json
import logging
import os
import secrets
import shutil
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Final

import anyio
import anyio.to_thread
from PIL import Image

from wixy_server.adventure_public.store import NewPicture, PackRow, PublicPackStore
from wixy_server.background import ContainedTaskGroup
from wixy_server.livechat import processing
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_pictures import (
    AdventurePictureFinder,
    FoundPicture,
    PictureTiming,
    plan_pictures,
)

_LOGGER = logging.getLogger(__name__)

THUMB_LONG_EDGE: Final = 480
THUMB_QUALITY: Final = 82
ORPHAN_AGE_S: Final = 3600.0
"""A picture directory no row owns is removed only once it is this old (a hunt in flight stages
pictures that are not attached yet)."""
ORPHAN_SWEEP_EVERY_S: Final = 3600.0
FULL_NAME: Final = "full.jpg"
THUMB_NAME: Final = "thumb.jpg"


def pictures_wanted(row: PackRow | None) -> bool:
    """Whether a pack still wants its pictures: it exists, its text pack is in and the picture job
    is still pending."""
    return row is not None and row.state == "ready" and row.images == "pending"


def picture_dir(root: Path, picture_id: str) -> Path:
    return root / picture_id


class PublicPictureJob:
    """Finds a ready public pack's pictures, stages them and attaches them in one transaction.
    Idempotent: the attach is a compare-and-set on `images = 'pending'`, so a restart, a blue/green
    overlap or a repeat finds nothing to do or loses the race harmlessly."""

    def __init__(
        self,
        *,
        store: PublicPackStore,
        pictures_dir: Path,
        bank: AdventureBank,
        finder: AdventurePictureFinder,
        space_ok: Callable[[int], bool] | None = None,
        timing: PictureTiming | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._root = pictures_dir
        self._bank = bank
        self._finder = finder
        self._space_ok = space_ok
        self._timing = timing if timing is not None else PictureTiming()
        self._clock = clock
        self._running: set[str] = set()
        """Packs this process is hunting right now (the sweep never starts a second hunt)."""
        self._last_orphan_sweep = float("-inf")

    def prepare_directory(self) -> None:
        """Create the pictures folder (blocking; call from a thread)."""
        self._root.mkdir(parents=True, exist_ok=True)

    async def _claim(self, destination_id: str, *, stale_before: float | None) -> str:
        now = self._clock()
        result: str = await anyio.to_thread.run_sync(
            lambda: self._store.claim_pictures(
                destination_id,
                stale_before=stale_before,
                now=now,
                max_tries=self._timing.max_tries,
            )
        )
        if result == "gave_up":
            _LOGGER.warning(
                "public adventure pictures: %s's hunts keep dying; giving up", destination_id
            )
        return result

    async def resume(self, background: ContainedTaskGroup) -> int:
        """Startup recovery: redo the hunt for every pack whose pictures were still pending when the
        previous process stopped (nothing was attached — the attach is all-or-nothing), and remove
        any staged directory no row owns. Each redo is a claim (it counts as a try and restarts the
        pack's staleness clock). Returns how many hunts were started."""
        await self.sweep_orphans()
        pending = await anyio.to_thread.run_sync(self._store.pending_pictures)
        started = 0
        for destination_id in pending:
            if await self._claim(destination_id, stale_before=None) == "claimed":
                background.spawn("adventure-public-pictures", self.run, destination_id)
                started += 1
        return started

    async def sweep(self, background: ContainedTaskGroup) -> int:
        """One pass of the self-healing check: re-run the hunt for every pack pending longer than
        `stale_after_s` (one this process is already hunting is left alone), and, once an hour,
        remove staged directories nothing owns. Returns how many hunts were started."""
        stale_before = self._clock() - self._timing.stale_after_s
        stale = await anyio.to_thread.run_sync(
            lambda: self._store.stale_pictures(stale_before=stale_before)
        )
        started = 0
        for destination_id in stale:
            if destination_id in self._running:
                continue
            if await self._claim(destination_id, stale_before=stale_before) == "claimed":
                background.spawn("adventure-public-pictures", self.run, destination_id)
                started += 1
        if self._clock() - self._last_orphan_sweep >= ORPHAN_SWEEP_EVERY_S:
            await self.sweep_orphans()
        return started

    async def watch_forever(self, background: ContainedTaskGroup) -> None:
        """The supervised loop (`ContainedTaskGroup.supervise`): sweep every `watch_interval_s`. A
        failed sweep is logged and tried again on the next tick, never fatal."""
        while True:
            await anyio.sleep(self._timing.watch_interval_s)
            try:
                await self.sweep(background)
            except Exception:
                _LOGGER.exception("public adventure pictures: the sweep for abandoned hunts failed")

    async def sweep_orphans(self) -> int:
        """Remove picture directories no row owns that are older than `ORPHAN_AGE_S`. Returns how
        many were removed."""
        self._last_orphan_sweep = self._clock()
        return await anyio.to_thread.run_sync(self._remove_orphans)

    def _remove_orphans(self) -> int:
        if not self._root.is_dir():
            return 0
        owned = self._store.picture_ids()
        horizon = time.time() - ORPHAN_AGE_S
        removed = 0
        for child in self._root.iterdir():
            if child.name in owned or not child.is_dir():
                continue
            try:
                if child.stat().st_mtime > horizon:
                    continue
            except OSError:
                continue
            shutil.rmtree(child, ignore_errors=True)
            removed += 1
        return removed

    async def run(self, destination_id: str) -> None:
        """Find and attach the pictures for `destination_id`. Never raises for an ordinary failure
        (the pack just ends with `images = failed` and no pictures); only cancellation (shutdown)
        propagates, leaving the pack `pending` for the sweep (or the next start) to redo. If even
        ending the wait fails, the pack stays `pending` and the sweep heals it."""
        self._running.add(destination_id)
        try:
            await self._run_and_settle(destination_id)
        finally:
            self._running.discard(destination_id)

    async def _run_and_settle(self, destination_id: str) -> None:
        try:
            attached = await self._run(destination_id)
        except Exception:
            _LOGGER.exception("public adventure picture job for %s failed", destination_id)
            attached = False
        if attached:
            return
        try:
            await anyio.to_thread.run_sync(lambda: self._store.fail_pictures(destination_id))
        except Exception:
            _LOGGER.exception("could not end the picture wait for %s", destination_id)

    async def _row(self, destination_id: str) -> PackRow | None:
        return await anyio.to_thread.run_sync(lambda: self._store.get(destination_id))

    async def _run(self, destination_id: str) -> bool:
        row = await self._row(destination_id)
        if not pictures_wanted(row) or row is None or row.pack_json is None:
            return False
        try:
            pack = json.loads(row.pack_json)
        except json.JSONDecodeError:
            return False
        destination = self._bank.destination(destination_id)
        unit = self._bank.unit_of(destination_id)
        if not isinstance(pack, dict) or destination is None or unit is None:
            return False
        plan = plan_pictures(pack, destination_name=destination.name, unit_name=unit.name)

        async def still_wanted() -> bool:
            return pictures_wanted(await self._row(destination_id))

        found = await self._finder.find(plan, still_wanted=still_wanted)
        if not found or not await still_wanted():
            return False
        if self._space_ok is not None:
            room = self._space_ok
            size = sum(len(p.jpeg) for p in found)
            if not await anyio.to_thread.run_sync(lambda: room(size)):
                _LOGGER.warning(
                    "public adventure pictures: no room for %s's pictures", destination_id
                )
                return False
        return await anyio.to_thread.run_sync(lambda: self._stage_and_attach(destination_id, found))

    def _stage_and_attach(self, destination_id: str, found: Sequence[FoundPicture]) -> bool:
        """Blocking. Write each picture's `full.jpg` and `thumb.jpg` under `pictures/<id>/` and
        attach them all in ONE transaction; staged files of an attach that did not happen are
        removed."""
        staged: list[Path] = []
        try:
            new: list[NewPicture] = []
            for ordinal, picture in enumerate(found):
                picture_id = secrets.token_hex(16)
                directory = picture_dir(self._root, picture_id)
                directory.mkdir(parents=True, exist_ok=True)
                staged.append(directory)
                width, height, thumb = _thumbnail(picture.jpeg)
                _write_atomic(directory / FULL_NAME, picture.jpeg)
                _write_atomic(directory / THUMB_NAME, thumb)
                new.append(
                    NewPicture(
                        id=picture_id,
                        slot=picture.slot,
                        ordinal=ordinal,
                        width=width,
                        height=height,
                        credit=picture.credit,
                        page=picture.page,
                        caption=picture.caption,
                    )
                )
            attached = self._store.attach_pictures(destination_id, new)
            if attached:
                staged = []  # the rows own these directories now
            return attached
        finally:
            for directory in staged:
                shutil.rmtree(directory, ignore_errors=True)


def _thumbnail(jpeg: bytes) -> tuple[int, int, bytes]:
    """`(width, height, thumbnail bytes)` of a finished picture: the thumbnail is a fresh,
    metadata-free JPEG of at most `THUMB_LONG_EDGE` px on its long edge."""
    with Image.open(io.BytesIO(jpeg), formats=("JPEG",)) as image:
        width, height = image.size
        thumb = processing.reencode_still_as_jpeg(
            image, long_edge=THUMB_LONG_EDGE, quality=THUMB_QUALITY
        )
    return width, height, thumb


def _write_atomic(path: Path, data: bytes) -> None:
    part = path.with_name(path.name + ".part")
    part.write_bytes(data)
    os.replace(part, path)
