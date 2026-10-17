"""The would-you-rather picture pool (workspace 00045 follow-on): pictures painted AHEAD of time
for upcoming questions, so starting a round attaches them instantly.

`server/wyr-pool/<question_id>/{a,b}.png` holds one pre-generated pair per question. A pooled
picture is NOT chat content: it is derived from the static question bank and tied to no
conversation, so a chat wipe does not clear it (Inv 54). The moment a round consumes a pair its
PNGs are MOVED into `uploads/<id>/assembled` and become ordinary photo attachments, erased with
their message like any other picture.

Everything on disk is crash- and overlap-safe by construction:
- a pair becomes visible only by an atomic directory rename out of `<id>.tmp`;
- a consumer first renames `<id>` to `<id>.taken-<token>`, so two consumers can never take the
  same pair and a crash leaves a recognisable, sweepable name;
- startup removes `*.tmp` / `*.taken-*` directories only once they are older than every live
  run's budget (a younger one may belong to the OLDER process of a blue/green overlap) and removes
  pooled pairs for questions that have meanwhile been played.

The filler (`run_wyr_pool_forever`) lives in `wyr_game.py` next to the on-demand job it must share
the GPU gate with; this module is only the on-disk store.
"""

from __future__ import annotations

import logging
import os
import random
import shutil
import time
import uuid
from collections.abc import Collection
from dataclasses import dataclass
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

# Longer than any live run (the generator's own budget is 300 s plus downloads), so a directory
# this old belongs to a process that died.
STALE_AFTER_S = 900.0

_TMP_SUFFIX = ".tmp"
_TAKEN_MARK = ".taken-"
POOL_FILES = ("a.png", "b.png")


@dataclass(frozen=True, slots=True)
class PooledPictures:
    """A pair reserved by `WyrPool.take`: the two PNGs, exclusively the taker's until it is
    consumed (`WyrPool.discard`), returned (`WyrPool.restore`) or moved away."""

    question_id: str
    directory: Path
    a: Path
    b: Path


class WyrPool:
    def __init__(self, root: Path) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        return self._root

    # -- reading -----------------------------------------------------------------------------

    def ids(self) -> set[str]:
        """The questions with a complete pooled pair (never a `.tmp` or `.taken-*` entry)."""
        try:
            entries = list(self._root.iterdir())
        except OSError:
            return set()
        ready: set[str] = set()
        for entry in entries:
            name = entry.name
            if name.endswith(_TMP_SUFFIX) or _TAKEN_MARK in name:
                continue
            if all((entry / f).is_file() for f in POOL_FILES):
                ready.add(name)
        return ready

    def size(self) -> int:
        return len(self.ids())

    # -- filling -----------------------------------------------------------------------------

    def begin(self, question_id: str) -> Path:
        """A fresh scratch directory for one pair; the caller writes `a.png`/`b.png` into it and
        then `commit`s (or `abort`s) it."""
        self._root.mkdir(parents=True, exist_ok=True)
        tmp = self._root / f"{question_id}{_TMP_SUFFIX}"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        return tmp

    def commit(self, question_id: str, tmp: Path) -> bool:
        """Publish a complete pair atomically. False (and the scratch removed) when the pair is
        incomplete or the question is already pooled."""
        target = self._root / question_id
        if not all((tmp / f).is_file() for f in POOL_FILES) or target.exists():
            shutil.rmtree(tmp, ignore_errors=True)
            return False
        try:
            tmp.rename(target)
        except OSError:
            shutil.rmtree(tmp, ignore_errors=True)
            return False
        return True

    @staticmethod
    def abort(tmp: Path) -> None:
        shutil.rmtree(tmp, ignore_errors=True)

    # -- consuming ---------------------------------------------------------------------------

    def take(self, candidates: Collection[str], rng: random.Random) -> PooledPictures | None:
        """Reserve a random pooled pair among `candidates` (the unplayed question ids). The
        reservation is an atomic rename, so a pair can be taken once; None when none is ready."""
        available = sorted(self.ids() & set(candidates))
        rng.shuffle(available)
        for question_id in available:
            source = self._root / question_id
            reserved = self._root / f"{question_id}{_TAKEN_MARK}{uuid.uuid4().hex[:8]}"
            try:
                source.rename(reserved)
            except OSError:
                continue  # lost a race for this one; try the next
            try:
                # A rename does not touch the directory's own mtime, which is when the PAIR was
                # painted: stamp the reservation so the stale sweep measures how long it has been
                # held, never how old the pictures are.
                os.utime(reserved, None)
            except OSError:
                _LOGGER.warning("wyr pool: could not stamp reservation %s", reserved)
            return PooledPictures(
                question_id=question_id,
                directory=reserved,
                a=reserved / POOL_FILES[0],
                b=reserved / POOL_FILES[1],
            )
        return None

    def restore(self, pooled: PooledPictures) -> None:
        """Give a reserved pair back untouched (the round that took it turned out to be a replay).
        If the question was re-pooled meanwhile the returned copy is simply discarded."""
        target = self._root / pooled.question_id
        if target.exists():
            self.discard(pooled)
            return
        try:
            pooled.directory.rename(target)
        except OSError:
            self.discard(pooled)

    @staticmethod
    def discard(pooled: PooledPictures) -> None:
        shutil.rmtree(pooled.directory, ignore_errors=True)

    # -- housekeeping ------------------------------------------------------------------------

    def drop(self, question_id: str) -> None:
        shutil.rmtree(self._root / question_id, ignore_errors=True)

    def cleanup(self, played_ids: Collection[str], *, now: float | None = None) -> int:
        """Startup/periodic sweep: remove stale scratch/reserved directories and pooled pairs of
        questions that have been played since. Young scratch/reserved directories are left alone
        (they may belong to a live run of the older blue/green process). Returns the number of
        directories removed."""
        cutoff = (time.time() if now is None else now) - STALE_AFTER_S
        removed = 0
        try:
            entries = list(self._root.iterdir())
        except OSError:
            return 0
        played = set(played_ids)
        for entry in entries:
            name = entry.name
            try:
                if name.endswith(_TMP_SUFFIX) or _TAKEN_MARK in name:
                    if entry.stat().st_mtime < cutoff:
                        shutil.rmtree(entry, ignore_errors=True)
                        removed += 1
                elif name in played:
                    shutil.rmtree(entry, ignore_errors=True)
                    removed += 1
            except OSError:
                _LOGGER.warning("wyr pool: could not inspect %s", entry)
        return removed

    def clear(self) -> None:
        """Remove the whole pool directory (the pool was switched off)."""
        shutil.rmtree(self._root, ignore_errors=True)
