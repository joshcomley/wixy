"""Lock behaviour of the live-chat store under a stale reader (workspace 00058 extra M2 task).

Two defects seen once under box load in
`test_stale_reader_does_not_block_a_concurrent_message_send`:
1. `scrub()` ran `wal_checkpoint(TRUNCATE)` with a busy wait. TRUNCATE takes the WAL writer lock
   BEFORE it waits for readers, so with a stale reader pinning the WAL it held the lock for up to
   the whole busy slice, again and again, and a concurrent send's `BEGIN IMMEDIATE` timed out.
2. `_write_txn`/`_read_txn` ran `ROLLBACK` unconditionally; when `BEGIN IMMEDIATE` itself failed no
   transaction was open, and "cannot rollback - no transaction is active" replaced the real error.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

import pytest

from wixy_server.livechat.store import LiveChatStore


def make_store(tmp_path: Path) -> LiveChatStore:
    return LiveChatStore(tmp_path / "server" / "server.db")


def seed(store: LiveChatStore, n: int = 1) -> int:
    seq = 0
    for i in range(n):
        message, _ = store.create_message(
            client_id=f"lock-client-{i:04d}",
            sender="Josh",
            device_id="device-lock-0001",
            by_email=None,
            text=f"row {i}",
            attachment_ids=(),
            now=1.0 + i,
        )
        seq = message.seq
    return seq


def test_a_failed_begin_surfaces_the_real_lock_error_not_a_rollback_error(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    seed(store)
    holder = sqlite3.connect(str(store._db_path), isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    original = store._connect

    def short_wait() -> sqlite3.Connection:
        conn = original()
        conn.execute("PRAGMA busy_timeout = 50")
        return conn

    store._connect = short_wait  # type: ignore[method-assign]
    try:
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            with store._write_txn():
                pass
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            with store._read_txn() as conn:
                conn.execute("BEGIN IMMEDIATE")  # a second BEGIN would be a different error
    finally:
        holder.execute("ROLLBACK")
        holder.close()


def test_a_scrub_waiting_on_a_stale_reader_does_not_starve_writers(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    seq = seed(store, 3)
    reader = sqlite3.connect(str(store._db_path), isolation_level=None)
    reader.execute("BEGIN")
    assert reader.execute("SELECT text FROM messages WHERE seq = ?", (seq,)).fetchone()
    # new WAL frames the stale reader cannot let a checkpoint recycle
    store.create_message(
        client_id="lock-client-wal",
        sender="Josh",
        device_id="device-lock-0001",
        by_email=None,
        text="wal frame",
        attachment_ids=(),
        now=50.0,
    )
    original = store._connect

    def short_wait() -> sqlite3.Connection:
        conn = original()
        conn.execute("PRAGMA busy_timeout = 100")
        return conn

    store._connect = short_wait  # type: ignore[method-assign]
    stop = threading.Event()
    scrubbed: list[bool] = []

    def scrubber() -> None:
        scrubbed.append(store.scrub(deadline_s=2.0))
        stop.set()

    thread = threading.Thread(target=scrubber)
    thread.start()
    try:
        failures: list[str] = []
        sends = 0
        while not stop.is_set():
            try:
                store.create_message(
                    client_id=f"lock-send-{sends:05d}",
                    sender="Josh",
                    device_id="device-lock-0001",
                    by_email=None,
                    text="during scrub",
                    attachment_ids=(),
                    now=100.0 + sends,
                )
                sends += 1
            except sqlite3.OperationalError as exc:
                failures.append(str(exc))
            time.sleep(0.005)
        assert sends > 5
        assert failures == []
    finally:
        thread.join()
        reader.execute("COMMIT")
        reader.close()
    assert scrubbed == [False]  # the stale reader kept the WAL, so the scrub gave up honestly


def test_the_scrub_still_empties_the_wal_once_readers_are_gone(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    seed(store, 5)
    assert store.scrub(deadline_s=5.0) is True
    wal = Path(f"{store._db_path}-wal")
    assert not wal.exists() or wal.stat().st_size == 0
