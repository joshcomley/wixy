"""The public Adventure Time pack cache (spec/adventure-public/README.md §2.2, Inv 61).

`Storage/<project>/adventure-public/public.db` — SQLite in WAL mode with the same connection
discipline as `LiveChatStore` (a short-lived connection per operation, `busy_timeout`, every
mutation under `BEGIN IMMEDIATE`, and the clock sampled only AFTER the write lock is held —
decisions/00186).
It is NOT `server.db`: public data never enters the private chat's database, and nothing in the
private chat reads this one.

One row per destination in `packs` — the cache every visitor shares, which is what bounds the
cost of the public game to one research run per bank destination (plus bounded retries).
`pictures` holds the pack's Wikimedia Commons pictures (the files live beside the database
under `pictures/<id>/`).
Everything that decides between processes is a compare-and-set, so a blue/green overlap where both
sides poll one run stores it once.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

_LOGGER = logging.getLogger(__name__)

SCHEMA_VERSION: Final = 1
MAX_PICTURE_TRIES: Final = 3
"""A pack's picture hunt is begun at most this many times before the wait ends as `failed`."""
RETRY_BASE_S: Final = 600.0
"""A failed pack may be asked for again this long after the failure; the wait doubles per try."""
MAX_TRIES_PER_WINDOW: Final = 3
TRIES_WINDOW_S: Final = 24 * 3600.0
UNAVAILABLE_RETRY_S: Final = 60.0
"""When cmd could not be reached, the pack may be asked for again after this (and the try is not
counted: a cmd outage must not lock a destination out for a day)."""

PackState = Literal["pending", "ready", "failed"]
ImagesState = Literal["none", "pending", "done", "failed"]

_JOURNAL_MODE_SWITCH_RETRIES = 40
_JOURNAL_MODE_SWITCH_RETRY_DELAY_S = 0.05

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS packs (
    destination_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
    run_id TEXT,
    pack_json TEXT,
    error TEXT,
    started_at REAL NOT NULL,
    tries INTEGER NOT NULL DEFAULT 1,
    next_try_at REAL,
    images TEXT NOT NULL DEFAULT 'none' CHECK (images IN ('none', 'pending', 'done', 'failed')),
    images_started_at REAL,
    images_tries INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pictures (
    id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL REFERENCES packs(destination_id) ON DELETE CASCADE,
    slot TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    credit TEXT NOT NULL,
    page TEXT NOT NULL,
    caption TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS pictures_by_destination ON pictures (destination_id, ordinal);
"""


@dataclass(frozen=True, slots=True)
class PackRow:
    destination_id: str
    state: PackState
    run_id: str | None
    pack_json: str | None
    error: str | None
    started_at: float
    tries: int
    next_try_at: float | None
    images: ImagesState
    images_started_at: float | None
    images_tries: int
    updated_at: float
    rev: int


@dataclass(frozen=True, slots=True)
class PictureRow:
    id: str
    destination_id: str
    slot: str
    ordinal: int
    width: int
    height: int
    credit: str
    page: str
    caption: str | None
    created_at: float


@dataclass(frozen=True, slots=True)
class NewPicture:
    """A picture whose two files are already staged (`pictures/<id>/full.jpg` + `thumb.jpg`)."""

    id: str
    slot: str
    ordinal: int
    width: int
    height: int
    credit: str
    page: str
    caption: str | None


@dataclass(frozen=True, slots=True)
class StartResult:
    """What `request_start` did. `started`: a new run is due (the row is `pending`, no run yet);
    `exists`: a pack is already `pending` or `ready` (nothing changed); `wait`: a failed pack may
    not be asked for again until `row.next_try_at`."""

    kind: Literal["started", "exists", "wait"]
    row: PackRow


def _row_to_pack(row: sqlite3.Row) -> PackRow:
    return PackRow(
        destination_id=str(row["destination_id"]),
        state=row["state"],
        run_id=row["run_id"],
        pack_json=row["pack_json"],
        error=row["error"],
        started_at=float(row["started_at"]),
        tries=int(row["tries"]),
        next_try_at=None if row["next_try_at"] is None else float(row["next_try_at"]),
        images=row["images"],
        images_started_at=(
            None if row["images_started_at"] is None else float(row["images_started_at"])
        ),
        images_tries=int(row["images_tries"]),
        updated_at=float(row["updated_at"]),
        rev=int(row["rev"]),
    )


def _row_to_picture(row: sqlite3.Row) -> PictureRow:
    return PictureRow(
        id=str(row["id"]),
        destination_id=str(row["destination_id"]),
        slot=str(row["slot"]),
        ordinal=int(row["ordinal"]),
        width=int(row["width"]),
        height=int(row["height"]),
        credit=str(row["credit"]),
        page=str(row["page"]),
        caption=None if row["caption"] is None else str(row["caption"]),
        created_at=float(row["created_at"]),
    )


def retry_delay_s(tries: int) -> float:
    """How long after its `tries`-th failure a pack may be asked for again: 10 minutes, doubling per
    try (10, 20, 40, ...)."""
    return float(RETRY_BASE_S * (2 ** max(0, tries - 1)))


class PublicPackStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._ready = False
        self._ready_lock = threading.Lock()

    @property
    def db_path(self) -> Path:
        return self._db_path

    # -- connections -----------------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path), timeout=5.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout = 5000")
            conn.execute("PRAGMA foreign_keys = ON")
            # The one-time rollback-journal -> WAL switch is not covered by `busy_timeout`
            # (measured on `LiveChatStore`): retry it briefly while a sibling connection is
            # mid-switch. Once any connection has switched, this is an instant no-op.
            for attempt in range(_JOURNAL_MODE_SWITCH_RETRIES):
                try:
                    conn.execute("PRAGMA journal_mode = WAL")
                    break
                except sqlite3.OperationalError:
                    if attempt == _JOURNAL_MODE_SWITCH_RETRIES - 1:
                        raise
                    time.sleep(_JOURNAL_MODE_SWITCH_RETRY_DELAY_S)
            conn.execute("PRAGMA synchronous = NORMAL")
            self._migrate(conn)
        except BaseException:
            conn.close()
            raise
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        if self._ready:
            return
        with self._ready_lock:
            if self._ready:
                return
            # `BEGIN IMMEDIATE` serialises two processes (blue/green) creating the schema at once.
            conn.execute("BEGIN IMMEDIATE")
            try:
                for statement in _SCHEMA_V1.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 1)")
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            self._ready = True

    def initialise(self) -> None:
        """Create the database and its schema now (blocking). Every other call does so lazily."""
        self._connect().close()

    def schema_version(self) -> int:
        with self._read_txn() as conn:
            row = conn.execute("SELECT version FROM schema_version WHERE id = 1").fetchone()
            return int(row["version"]) if row is not None else 0

    @contextmanager
    def _write_txn(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    @contextmanager
    def _read_txn(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- reads -----------------------------------------------------------------------------------

    def get(self, destination_id: str) -> PackRow | None:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT * FROM packs WHERE destination_id = ?", (destination_id,)
            ).fetchone()
            return _row_to_pack(row) if row is not None else None

    def get_with_pictures(self, destination_id: str) -> tuple[PackRow, list[PictureRow]] | None:
        """The pack and its pictures from ONE snapshot (so a reader never sees `images = done`
        without the rows)."""
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT * FROM packs WHERE destination_id = ?", (destination_id,)
            ).fetchone()
            if row is None:
                return None
            pictures = conn.execute(
                "SELECT * FROM pictures WHERE destination_id = ? ORDER BY ordinal",
                (destination_id,),
            ).fetchall()
            return _row_to_pack(row), [_row_to_picture(p) for p in pictures]

    def picture_ids(self) -> set[str]:
        with self._read_txn() as conn:
            return {str(row["id"]) for row in conn.execute("SELECT id FROM pictures").fetchall()}

    def pending_packs(self) -> list[tuple[str, str | None]]:
        """Startup recovery: every pack that is `pending`, as `(destination id, run id or None)` — a
        run id resumes polling that run; none means the process died before the spawn, so a new run
        starts."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT destination_id, run_id FROM packs WHERE state = 'pending' "
                "ORDER BY started_at, destination_id"
            ).fetchall()
            return [(str(row["destination_id"]), row["run_id"]) for row in rows]

    def pending_pictures(self) -> list[str]:
        """Startup recovery: every `ready` pack whose pictures are still `pending` (the previous
        process died mid-hunt; the attach is all-or-nothing, so the hunt is simply redone)."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT destination_id FROM packs WHERE state = 'ready' AND images = 'pending' "
                "ORDER BY destination_id"
            ).fetchall()
            return [str(row["destination_id"]) for row in rows]

    def stale_pictures(self, *, stale_before: float) -> list[str]:
        """Packs whose picture wait looks abandoned: `images = pending` on a `ready` pack whose
        current hunt began before `stale_before` (or never recorded a start)."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT destination_id FROM packs WHERE state = 'ready' AND images = 'pending' "
                "AND (images_started_at IS NULL OR images_started_at < ?) "
                "ORDER BY destination_id",
                (stale_before,),
            ).fetchall()
            return [str(row["destination_id"]) for row in rows]

    # -- starting research -----------------------------------------------------------------------

    def request_start(self, destination_id: str, *, now: float | None = None) -> StartResult:
        """Ask for a destination's pack. No row: a `pending` row is created (`started`). A `failed`
        row whose `next_try_at` has passed goes back to `pending` (`started`; the tries window
        restarts once 24 hours have passed since its first try, else this is one more try); a
        `failed` row that may not yet be asked for again answers `wait`; a `pending` or `ready` row
        answers `exists`. Compare-and-set under the write lock, so two requests start one run."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            row = conn.execute(
                "SELECT * FROM packs WHERE destination_id = ?", (destination_id,)
            ).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO packs (destination_id, state, started_at, tries, updated_at) "
                    "VALUES (?, 'pending', ?, 1, ?)",
                    (destination_id, now_s, now_s),
                )
                return StartResult("started", self._load(conn, destination_id))
            current = _row_to_pack(row)
            if current.state != "failed":
                return StartResult("exists", current)
            if current.next_try_at is not None and now_s < current.next_try_at:
                return StartResult("wait", current)
            if now_s - current.started_at >= TRIES_WINDOW_S:
                started_at, tries = now_s, 1
            else:
                started_at, tries = current.started_at, current.tries + 1
            conn.execute(
                "UPDATE packs SET state = 'pending', run_id = NULL, pack_json = NULL, "
                "error = NULL, started_at = ?, tries = ?, next_try_at = NULL, images = 'none', "
                "images_started_at = NULL, images_tries = 0, rev = rev + 1, updated_at = ? "
                "WHERE destination_id = ? AND state = 'failed'",
                (started_at, tries, now_s, destination_id),
            )
            return StartResult("started", self._load(conn, destination_id))

    @staticmethod
    def _load(conn: sqlite3.Connection, destination_id: str) -> PackRow:
        return _row_to_pack(
            conn.execute(
                "SELECT * FROM packs WHERE destination_id = ?", (destination_id,)
            ).fetchone()
        )

    def set_run(
        self,
        destination_id: str,
        *,
        run_id: str,
        expected_run_id: str | None = None,
        now: float | None = None,
    ) -> bool:
        """Record the research run a `pending` pack is waiting on — a compare-and-set on
        `(state = 'pending' AND run_id = expected_run_id)` (NULL for the first run, the dead run's
        id for the single early retry). `False` means the pack moved on (another process already
        started a run): the caller cancels its run."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            cursor = conn.execute(
                "UPDATE packs SET run_id = ?, updated_at = ? "
                "WHERE destination_id = ? AND state = 'pending' AND run_id IS ?",
                (run_id, now_s, destination_id, expected_run_id),
            )
            return cursor.rowcount == 1

    def finish(
        self,
        destination_id: str,
        *,
        run_id: str | None,
        state: Literal["ready", "failed"],
        pack_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
        transient: bool = False,
        now: float | None = None,
    ) -> bool:
        """Land the research outcome — a compare-and-set on `(state = 'pending' AND run_id =
        run_id)`, so two processes polling one run store it once. `False` = nothing was waiting for
        this run.

        `ready` with `pictures_pending` starts the picture wait in the same write (`images =
        pending`, its first try counted) and the caller then runs the picture job. `failed` sets
        `next_try_at`: 10 minutes after this failure, doubling per try, and once the third try of a
        24 hour window has failed, not before that window ends. `transient` (cmd could not be
        reached) does not count the try and allows another after one minute."""
        hunt = state == "ready" and pictures_pending
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            row = conn.execute(
                "SELECT tries, started_at FROM packs "
                "WHERE destination_id = ? AND state = 'pending' AND run_id IS ?",
                (destination_id, run_id),
            ).fetchone()
            if row is None:
                return False
            tries = int(row["tries"])
            next_try_at: float | None = None
            if state == "failed":
                if transient:
                    tries = max(0, tries - 1)
                    next_try_at = now_s + UNAVAILABLE_RETRY_S
                else:
                    next_try_at = now_s + retry_delay_s(tries)
                    if tries >= MAX_TRIES_PER_WINDOW:
                        next_try_at = max(next_try_at, float(row["started_at"]) + TRIES_WINDOW_S)
            conn.execute(
                "UPDATE packs SET state = ?, pack_json = ?, error = ?, tries = ?, next_try_at = ?, "
                "images = ?, images_started_at = ?, images_tries = ?, rev = rev + 1, "
                "updated_at = ? WHERE destination_id = ?",
                (
                    state,
                    pack_json if state == "ready" else None,
                    error if state == "failed" else None,
                    tries,
                    next_try_at,
                    "pending" if hunt else "none",
                    now_s if hunt else None,
                    1 if hunt else 0,
                    now_s,
                    destination_id,
                ),
            )
            return True

    # -- the picture wait ------------------------------------------------------------------------

    def claim_pictures(
        self,
        destination_id: str,
        *,
        stale_before: float | None,
        now: float,
        max_tries: int = MAX_PICTURE_TRIES,
    ) -> Literal["claimed", "not_due", "gave_up", "gone"]:
        """Begin another picture hunt for a pack still waiting — a compare-and-set, so two
        processes sweeping at once start one. It succeeds only while the pack is `ready` with
        `images = pending` and, when `stale_before` is given, only while the current hunt began
        before it (`None` = unconditionally: the startup redo of a hunt that died with the previous
        process). A claim stamps `images_started_at = now` and counts a try; a pack already at
        `max_tries` ends as `failed` (`gave_up`). `not_due` = another process claimed it or the hunt
        is young; `gone` = the pack no longer waits."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT state, images, images_started_at, images_tries FROM packs "
                "WHERE destination_id = ?",
                (destination_id,),
            ).fetchone()
            if row is None or row["state"] != "ready" or row["images"] != "pending":
                return "gone"
            started = row["images_started_at"]
            if stale_before is not None and started is not None and started >= stale_before:
                return "not_due"
            if int(row["images_tries"]) >= max_tries:
                conn.execute(
                    "UPDATE packs SET images = 'failed', rev = rev + 1, updated_at = ? "
                    "WHERE destination_id = ? AND images = 'pending'",
                    (now, destination_id),
                )
                return "gave_up"
            conn.execute(
                "UPDATE packs SET images_started_at = ?, images_tries = images_tries + 1 "
                "WHERE destination_id = ? AND images = 'pending'",
                (now, destination_id),
            )
            return "claimed"

    def fail_pictures(self, destination_id: str, *, now: float | None = None) -> bool:
        """The pictures are not coming (nothing found, or a failure): the wait ends. A
        compare-and-set on `images = 'pending'`; `False` = nothing was waiting."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            cursor = conn.execute(
                "UPDATE packs SET images = 'failed', rev = rev + 1, updated_at = ? "
                "WHERE destination_id = ? AND images = 'pending'",
                (now_s, destination_id),
            )
            return cursor.rowcount == 1

    def attach_pictures(
        self,
        destination_id: str,
        pictures: Sequence[NewPicture],
        *,
        now: float | None = None,
    ) -> bool:
        """Attach a pack's staged pictures — all of them, or none — in ONE transaction: the rows and
        `images = done`. A compare-and-set: it attaches only while the pack is `ready` with `images
        = pending`; otherwise (another process finished it, the pack is gone) it returns False and
        the caller removes the staged files."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            row = conn.execute(
                "SELECT state, images FROM packs WHERE destination_id = ?", (destination_id,)
            ).fetchone()
            if row is None or row["state"] != "ready" or row["images"] != "pending":
                return False
            for picture in pictures:
                conn.execute(
                    "INSERT INTO pictures (id, destination_id, slot, ordinal, width, height, "
                    "credit, page, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        picture.id,
                        destination_id,
                        picture.slot,
                        picture.ordinal,
                        picture.width,
                        picture.height,
                        picture.credit,
                        picture.page,
                        picture.caption,
                        now_s,
                    ),
                )
            conn.execute(
                "UPDATE packs SET images = 'done', rev = rev + 1, updated_at = ? "
                "WHERE destination_id = ?",
                (now_s, destination_id),
            )
            return True
