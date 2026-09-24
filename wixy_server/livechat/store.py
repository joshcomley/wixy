"""`LiveChatStore` — SQLite (WAL), spec/server-chat/00-brief.md §4. Frozen method
signatures; P1 implements every one of them (P2/P3 only ever call them).

Every method is **synchronous** — callers wrap each call in
`anyio.to_thread.run_sync` (the same convention `routes_chat.py` already uses for
`find_chat`/`update_session_id`). A fresh `sqlite3.Connection` is opened per call
(never held across calls) — simple, safe under `anyio.to_thread.run_sync` handing
different calls to different worker threads, and correct across the blue/green
slot-swap overlap this feature is explicitly designed to survive (§3/§5's "two
processes, one SQLite file"): WAL mode + `busy_timeout` handle cross-connection and
cross-process contention, so there is nothing a long-lived connection would buy here
that a short one doesn't already get from the file itself.

Two transaction shapes:
- `_write_txn` (`BEGIN IMMEDIATE`) — acquires SQLite's write lock up front, so two
  processes racing the SAME conditional write (`claim_processing`'s lease grab,
  `create_message`'s idempotent insert) serialize correctly instead of both reading
  "unclaimed"/"no existing row" and then both writing.
- `_read_txn` (`BEGIN`, deferred) — establishes one consistent snapshot across
  several SELECTs (§4: `list_messages`'s "all in ONE read txn" cursor atomicity),
  without taking a write lock a plain read has no business holding.

The connection is opened with `isolation_level=None` (Python sqlite3's autocommit
mode) specifically so `_write_txn`/`_read_txn` can issue their OWN explicit
`BEGIN`/`COMMIT`/`ROLLBACK` without fighting the module's implicit
transaction-before-DML behavior.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from wixy_server.livechat.models import (
    AttachmentKind,
    AttachmentResult,
    AttachmentRow,
    EventRow,
    MessageRow,
    PushSubscriptionRow,
    UploadRow,
)

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL, device_id TEXT NOT NULL, by_email TEXT,
  text TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('photo','video','voice')),
  status TEXT NOT NULL CHECK(status IN ('processing','ready','failed')),
  message_seq INTEGER REFERENCES messages(seq), ordinal INTEGER,
  mime TEXT, width INTEGER, height INTEGER, duration_s REAL, peaks TEXT,
  renditions TEXT NOT NULL DEFAULT '[]',
  bytes_on_disk INTEGER NOT NULL DEFAULT 0, failure TEXT,
  lease_owner TEXT, lease_expires_at REAL,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('message','message_updated','message_deleted','wiped')),
  message_seq INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS uploads(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  filename TEXT, by_email TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions(
  device_id TEXT PRIMARY KEY, sender TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at REAL NOT NULL,
  last_ok_at REAL, consecutive_failures INTEGER NOT NULL DEFAULT 0);
"""

_SCHEMA_V2_EVENTS = """
CREATE TABLE events_v2(
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('message','message_updated','message_deleted','wiped')),
  message_seq INTEGER, created_at REAL NOT NULL);
INSERT INTO events_v2 (event_seq, type, message_seq, created_at)
  SELECT event_seq, type, message_seq, created_at FROM events ORDER BY event_seq;
DROP TABLE events;
ALTER TABLE events_v2 RENAME TO events;
"""

_SCHEMA_V3_DELETION_TRACKING = """
CREATE TABLE IF NOT EXISTS deleted_storage(
  kind TEXT NOT NULL CHECK(kind IN ('attachment','upload')),
  id TEXT NOT NULL,
  cleanup_pending INTEGER NOT NULL CHECK(cleanup_pending IN (0,1)),
  deleted_at REAL NOT NULL,
  PRIMARY KEY(kind, id));
CREATE TABLE IF NOT EXISTS pending_wipe_cleanup(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  token TEXT NOT NULL);
"""

_SCHEMA_V4_PENDING_STORAGE_INDEX = """
CREATE INDEX IF NOT EXISTS idx_deleted_storage_pending
  ON deleted_storage(kind, id) WHERE cleanup_pending = 1;
"""

_LATEST_SCHEMA_VERSION = 4


class LiveChatStoreError(Exception):
    """Base for store-level validation failures the route layer maps to a 4xx."""


class UnusableAttachmentError(LiveChatStoreError):
    """`create_message` was asked to attach an id that's unknown, already attached
    to another message, or failed processing (§4: "validates attachments
    unreferenced + status in (processing, ready)"). `routes_livechat.py` maps this
    to §5.3's `422 {"error":"invalid", ...}`."""

    def __init__(self, attachment_id: str) -> None:
        super().__init__(
            f"attachment {attachment_id!r} is not usable "
            "(unknown, already attached to a message, or failed processing)"
        )
        self.attachment_id = attachment_id


def _row_to_attachment(row: sqlite3.Row) -> AttachmentRow:
    peaks_raw = row["peaks"]
    return AttachmentRow(
        id=row["id"],
        kind=row["kind"],
        status=row["status"],
        message_seq=row["message_seq"],
        ordinal=row["ordinal"],
        mime=row["mime"],
        width=row["width"],
        height=row["height"],
        duration_s=row["duration_s"],
        peaks=tuple(json.loads(peaks_raw)) if peaks_raw is not None else None,
        renditions=tuple(json.loads(row["renditions"])),
        bytes_on_disk=row["bytes_on_disk"],
        failure=row["failure"],
        lease_owner=row["lease_owner"],
        lease_expires_at=row["lease_expires_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_message(row: sqlite3.Row, attachments: tuple[AttachmentRow, ...]) -> MessageRow:
    return MessageRow(
        seq=row["seq"],
        client_id=row["client_id"],
        sender=row["sender"],
        device_id=row["device_id"],
        by_email=row["by_email"],
        text=row["text"],
        created_at=row["created_at"],
        attachments=attachments,
    )


def _row_to_upload(row: sqlite3.Row) -> UploadRow:
    return UploadRow(
        id=row["id"],
        kind=row["kind"],
        mime=row["mime"],
        size_bytes=row["size_bytes"],
        filename=row["filename"],
        by_email=row["by_email"],
        created_at=row["created_at"],
    )


def _row_to_push_subscription(row: sqlite3.Row) -> PushSubscriptionRow:
    return PushSubscriptionRow(
        device_id=row["device_id"],
        sender=row["sender"],
        endpoint=row["endpoint"],
        p256dh=row["p256dh"],
        auth=row["auth"],
        created_at=row["created_at"],
        last_ok_at=row["last_ok_at"],
        consecutive_failures=row["consecutive_failures"],
    )


def _load_attachment(conn: sqlite3.Connection, att_id: str) -> AttachmentRow:
    row = conn.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if row is None:
        raise KeyError(att_id)
    return _row_to_attachment(row)


def _load_attachments_for(
    conn: sqlite3.Connection, message_seqs: Sequence[int]
) -> dict[int, list[AttachmentRow]]:
    by_message: dict[int, list[AttachmentRow]] = {seq: [] for seq in message_seqs}
    if not message_seqs:
        return by_message
    placeholders = ",".join("?" for _ in message_seqs)
    rows = conn.execute(
        f"SELECT * FROM attachments WHERE message_seq IN ({placeholders}) "
        "ORDER BY message_seq, ordinal",
        tuple(message_seqs),
    ).fetchall()
    for row in rows:
        by_message[row["message_seq"]].append(_row_to_attachment(row))
    return by_message


def _load_message(conn: sqlite3.Connection, seq: int) -> MessageRow:
    row = conn.execute("SELECT * FROM messages WHERE seq = ?", (seq,)).fetchone()
    if row is None:
        raise KeyError(seq)
    attachments = _load_attachments_for(conn, [seq])[seq]
    return _row_to_message(row, tuple(attachments))


_JOURNAL_MODE_SWITCH_RETRIES = 50
_JOURNAL_MODE_SWITCH_RETRY_DELAY_S = 0.02


class LiveChatStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path), timeout=5.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        # `busy_timeout` does NOT cover this specific one-time conversion:
        # measured (2026-09-14, a fresh DB file under concurrent first-ever
        # connections — P2b's media queue polling alongside the first
        # request) as an IMMEDIATE `OperationalError: database is locked`,
        # not a busy-timeout-governed wait, whenever a sibling connection is
        # mid-switch from the default rollback journal to WAL. A short manual
        # retry loop is what actually fixes it (proven: 0/160 failures with
        # this loop vs. 100% without it, across 20 trials x 8 concurrent
        # connections on a fresh file). Once ANY connection has completed the
        # switch, the file itself is WAL — every later connection's own
        # attempt is then an instant no-op, so this only ever loops during
        # the brief cold-start window.
        for attempt in range(_JOURNAL_MODE_SWITCH_RETRIES):
            try:
                conn.execute("PRAGMA journal_mode = WAL")
                break
            except sqlite3.OperationalError:
                if attempt == _JOURNAL_MODE_SWITCH_RETRIES - 1:
                    raise
                time.sleep(_JOURNAL_MODE_SWITCH_RETRY_DELAY_S)
        conn.execute("PRAGMA synchronous = NORMAL")
        # §17.1/17.2 A1: zeroes deleted rows in the main DB file — P8's future
        # `delete_message`/`wipe` rely on this; harmless to set now, before either
        # exists, since nothing is deleted yet.
        conn.execute("PRAGMA secure_delete = ON")
        self._migrate(conn)
        return conn

    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Most requests only need the cheap version read. During an upgrade,
        # serialize the check and every migration under SQLite's write lock so
        # blue/green processes cannot both rebuild the events table.
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        if current >= _LATEST_SCHEMA_VERSION:
            return

        conn.execute("BEGIN IMMEDIATE")
        try:
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            if current < 1:
                # This static schema has no semicolons inside SQL literals, so
                # each statement can be executed inside the migration txn.
                for statement in _SCHEMA_V1.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                current = 1
                conn.execute("PRAGMA user_version = 1")

            if current < 2:
                self._migrate_events_v2(conn)
                conn.execute("PRAGMA user_version = 2")
                current = 2

            if current < 3:
                for statement in _SCHEMA_V3_DELETION_TRACKING.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 3")
                current = 3

            if current < 4:
                for statement in _SCHEMA_V4_PENDING_STORAGE_INDEX.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 4")
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

    @staticmethod
    def _migrate_events_v2(conn: sqlite3.Connection) -> None:
        """Rebuild the event table so old v1 databases accept delete/wipe events.

        Preserve sqlite_sequence's high-water mark even if old events were
        deleted before the upgrade; event IDs must never be reused.
        """
        old_sequence = conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'events'"
        ).fetchone()
        high_water = int(old_sequence["seq"]) if old_sequence is not None else 0
        for statement in _SCHEMA_V2_EVENTS.split(";"):
            if statement.strip():
                conn.execute(statement)

        new_sequence = conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = 'events'"
        ).fetchone()
        high_water = max(high_water, int(new_sequence["seq"]) if new_sequence is not None else 0)
        if new_sequence is None and high_water > 0:
            conn.execute(
                "INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)", (high_water,)
            )
        elif new_sequence is not None:
            conn.execute("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'", (high_water,))

    @contextmanager
    def _write_txn(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
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
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    # -- messages / events ----------------------------------------------------

    def create_message(
        self,
        *,
        client_id: str,
        sender: str,
        device_id: str,
        by_email: str | None,
        text: str | None,
        attachment_ids: Sequence[str],
        now: float,
    ) -> tuple[MessageRow, bool]:
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False

            if attachment_ids:
                placeholders = ",".join("?" for _ in attachment_ids)
                rows = conn.execute(
                    f"SELECT id, message_seq, status FROM attachments WHERE id IN ({placeholders})",
                    tuple(attachment_ids),
                ).fetchall()
                by_id = {row["id"]: row for row in rows}
                for att_id in attachment_ids:
                    candidate = by_id.get(att_id)
                    if (
                        candidate is None
                        or candidate["message_seq"] is not None
                        or candidate["status"] not in ("processing", "ready")
                    ):
                        raise UnusableAttachmentError(att_id)

            cursor = conn.execute(
                "INSERT INTO messages (client_id, sender, device_id, by_email, text, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (client_id, sender, device_id, by_email, text, now),
            )
            seq = cursor.lastrowid
            assert seq is not None
            for ordinal, att_id in enumerate(attachment_ids):
                conn.execute(
                    "UPDATE attachments SET message_seq = ?, ordinal = ? WHERE id = ?",
                    (seq, ordinal, att_id),
                )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES ('message', ?, ?)",
                (seq, now),
            )
            return _load_message(conn, seq), True

    def list_messages(
        self, *, before: int | None, limit: int
    ) -> tuple[list[MessageRow], bool, int]:
        with self._read_txn() as conn:
            if before is None:
                rows = conn.execute(
                    "SELECT * FROM messages ORDER BY seq DESC LIMIT ?", (limit + 1,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?",
                    (before, limit + 1),
                ).fetchall()
            has_more = len(rows) > limit
            ascending_rows = list(reversed(rows[:limit]))
            seqs = [row["seq"] for row in ascending_rows]
            attachments_by_seq = _load_attachments_for(conn, seqs)
            messages = [
                _row_to_message(row, tuple(attachments_by_seq[row["seq"]]))
                for row in ascending_rows
            ]
            cursor_row = conn.execute("SELECT MAX(event_seq) AS m FROM events").fetchone()
            cursor = cursor_row["m"] if cursor_row["m"] is not None else 0
            return messages, has_more, cursor

    def get_messages(self, seqs: Sequence[int]) -> list[MessageRow]:
        if not seqs:
            return []
        with self._read_txn() as conn:
            placeholders = ",".join("?" for _ in seqs)
            rows = conn.execute(
                f"SELECT * FROM messages WHERE seq IN ({placeholders})", tuple(seqs)
            ).fetchall()
            by_seq = {row["seq"]: row for row in rows}
            attachments_by_seq = _load_attachments_for(conn, list(by_seq.keys()))
            result: list[MessageRow] = []
            for seq in seqs:
                row = by_seq.get(seq)
                if row is None:
                    continue
                result.append(_row_to_message(row, tuple(attachments_by_seq[seq])))
            return result

    def events_after(self, cursor: int, limit: int = 200) -> list[EventRow]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT * FROM events WHERE event_seq > ? ORDER BY event_seq ASC LIMIT ?",
                (cursor, limit),
            ).fetchall()
            return [
                EventRow(
                    event_seq=row["event_seq"],
                    type=row["type"],
                    message_seq=row["message_seq"],
                    created_at=row["created_at"],
                )
                for row in rows
            ]

    def delete_message(self, *, seq: int, now: float) -> list[str]:
        attachment_ids, _ = self._delete_message(seq=seq, now=now, mark_scrub_pending=False)
        return attachment_ids

    def delete_message_for_scrub(self, *, seq: int, now: float) -> tuple[list[str], str]:
        attachment_ids, token = self._delete_message(seq=seq, now=now, mark_scrub_pending=True)
        assert token is not None
        return attachment_ids, token

    def _delete_message(
        self, *, seq: int, now: float, mark_scrub_pending: bool
    ) -> tuple[list[str], str | None]:
        """Hard-delete one message and its attachments, then emit its tombstone-free event."""
        pending_token: str | None = None
        with self._write_txn() as conn:
            exists = (
                conn.execute("SELECT 1 FROM messages WHERE seq = ?", (seq,)).fetchone() is not None
            )
            attachment_rows = conn.execute(
                "SELECT id FROM attachments WHERE message_seq = ? ORDER BY id", (seq,)
            ).fetchall()
            attachment_ids = [str(row["id"]) for row in attachment_rows]
            self._queue_deleted_storage(conn, kind="attachment", ids=attachment_ids, now=now)
            self._queue_deleted_storage(conn, kind="upload", ids=attachment_ids, now=now)
            conn.execute(
                "DELETE FROM uploads WHERE id IN ("
                "SELECT id FROM attachments WHERE message_seq = ?)",
                (seq,),
            )
            conn.execute("DELETE FROM attachments WHERE message_seq = ?", (seq,))
            conn.execute(
                "DELETE FROM events WHERE message_seq = ? "
                "AND type IN ('message', 'message_updated')",
                (seq,),
            )
            conn.execute("DELETE FROM messages WHERE seq = ?", (seq,))
            if exists:
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_deleted', ?, ?)",
                    (seq, now),
                )
            if mark_scrub_pending:
                pending_token = self._write_scrub_pending_marker(conn)
        return attachment_ids, pending_token

    def wipe(self, *, now: float) -> tuple[list[str], list[str]]:
        attachment_ids, upload_ids, _, _ = self._wipe(now=now, mark_scrub_pending=False)
        return attachment_ids, upload_ids

    def wipe_for_scrub(self, *, now: float) -> tuple[list[str], list[str], str, str]:
        attachment_ids, upload_ids, token, wipe_token = self._wipe(now=now, mark_scrub_pending=True)
        assert token is not None
        assert wipe_token is not None
        return attachment_ids, upload_ids, token, wipe_token

    def _wipe(
        self, *, now: float, mark_scrub_pending: bool
    ) -> tuple[list[str], list[str], str | None, str | None]:
        """Remove all chat content and append one cursor-preserving wipe event."""
        pending_token: str | None = None
        wipe_token: str | None = None
        with self._write_txn() as conn:
            attachment_ids = [
                str(row["id"])
                for row in conn.execute("SELECT id FROM attachments ORDER BY id").fetchall()
            ]
            upload_ids = [
                str(row["id"])
                for row in conn.execute("SELECT id FROM uploads ORDER BY id").fetchall()
            ]
            self._queue_deleted_storage(conn, kind="attachment", ids=attachment_ids, now=now)
            self._queue_deleted_storage(conn, kind="upload", ids=upload_ids, now=now)
            wipe_token = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO pending_wipe_cleanup(singleton, token) VALUES (1, ?) "
                "ON CONFLICT(singleton) DO UPDATE SET token = excluded.token",
                (wipe_token,),
            )
            conn.execute("DELETE FROM attachments")
            conn.execute("DELETE FROM messages")
            conn.execute("DELETE FROM uploads")
            conn.execute("DELETE FROM events")
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES ('wiped', NULL, ?)",
                (now,),
            )
            if mark_scrub_pending:
                pending_token = self._write_scrub_pending_marker(conn)
        return attachment_ids, upload_ids, pending_token, wipe_token

    @property
    def scrub_pending_path(self) -> Path:
        return self._db_path.parent / "scrub.pending"

    def scrub_pending(self) -> bool:
        return self.scrub_pending_path.exists()

    @staticmethod
    def _queue_deleted_storage(
        conn: sqlite3.Connection, *, kind: str, ids: Sequence[str], now: float
    ) -> None:
        for storage_id in set(ids):
            conn.execute(
                "INSERT INTO deleted_storage(kind, id, cleanup_pending, deleted_at) "
                "VALUES (?, ?, 1, ?) "
                "ON CONFLICT(kind, id) DO UPDATE SET "
                "cleanup_pending = 1, deleted_at = excluded.deleted_at",
                (kind, storage_id, now),
            )

    @staticmethod
    def _is_deleted_storage(conn: sqlite3.Connection, *, kind: str, storage_id: str) -> bool:
        return (
            conn.execute(
                "SELECT 1 FROM deleted_storage WHERE kind = ? AND id = ?",
                (kind, storage_id),
            ).fetchone()
            is not None
        )

    def pending_deleted_storage_items(self) -> list[tuple[str, str]]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT kind, id FROM deleted_storage WHERE cleanup_pending = 1 ORDER BY kind, id"
            ).fetchall()
            return [(str(row["kind"]), str(row["id"])) for row in rows]

    def mark_deleted_storage_pending(self, *, kind: str, storage_id: str, now: float) -> None:
        with self._write_txn() as conn:
            self._queue_deleted_storage(conn, kind=kind, ids=[storage_id], now=now)

    def set_deleted_storage_pending(self, *, kind: str, storage_id: str, pending: bool) -> None:
        self.set_deleted_storage_pending_many([(kind, storage_id, pending)])

    def set_deleted_storage_pending_many(self, items: Sequence[tuple[str, str, bool]]) -> None:
        if not items:
            return
        with self._write_txn() as conn:
            conn.executemany(
                "UPDATE deleted_storage SET cleanup_pending = ? WHERE kind = ? AND id = ?",
                [(int(pending), kind, storage_id) for kind, storage_id, pending in items],
            )

    def has_deleted_storage_pending(self, *, kind: str, storage_id: str) -> bool:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT cleanup_pending FROM deleted_storage WHERE kind = ? AND id = ?",
                (kind, storage_id),
            ).fetchone()
            return row is not None and bool(row["cleanup_pending"])

    def storage_cleanup_pending(self) -> bool:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT 1 FROM deleted_storage WHERE cleanup_pending = 1 LIMIT 1"
            ).fetchone()
            wipe = conn.execute("SELECT 1 FROM pending_wipe_cleanup WHERE singleton = 1").fetchone()
            return row is not None or wipe is not None

    def pending_wipe_cleanup_token(self) -> str | None:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT token FROM pending_wipe_cleanup WHERE singleton = 1"
            ).fetchone()
            return str(row["token"]) if row is not None else None

    def ensure_pending_wipe_cleanup_token(self) -> str:
        """Persist retry work when a startup orphan sweep finds an unlink failure."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT token FROM pending_wipe_cleanup WHERE singleton = 1"
            ).fetchone()
            if row is not None:
                return str(row["token"])
            token = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO pending_wipe_cleanup(singleton, token) VALUES (1, ?)", (token,)
            )
            return token

    def clear_pending_wipe_cleanup(self, *, expected_token: str) -> bool:
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT token FROM pending_wipe_cleanup WHERE singleton = 1"
            ).fetchone()
            if row is None or str(row["token"]) != expected_token:
                return False
            conn.execute("DELETE FROM pending_wipe_cleanup WHERE singleton = 1")
            return True

    def live_storage_ids(self) -> tuple[set[str], set[str]]:
        """Read live attachment/upload IDs in one snapshot for an orphan sweep."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT 'attachment' AS kind, id FROM attachments "
                "UNION SELECT 'upload' AS kind, id FROM uploads"
            ).fetchall()
            attachment_ids = {str(row["id"]) for row in rows if str(row["kind"]) == "attachment"}
            upload_ids = {str(row["id"]) for row in rows if str(row["kind"]) == "upload"}
            return attachment_ids, upload_ids

    def scrub_pending_token(self) -> str | None:
        try:
            return self.scrub_pending_path.read_text(encoding="ascii").strip()
        except FileNotFoundError:
            return None

    def mark_scrub_pending(self) -> str:
        """Durably record unfinished erasure before a 202 can be returned."""
        with self._write_txn() as conn:
            return self._write_scrub_pending_marker(conn)

    def _write_scrub_pending_marker(self, conn: sqlite3.Connection) -> str:
        """Write the marker while holding SQLite's writer lock for this mutation."""
        if not conn.in_transaction:
            raise RuntimeError("scrub marker must be written inside a SQLite transaction")
        path = self.scrub_pending_path
        path.parent.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        temp_path = path.with_name(f".{path.name}.{token}.tmp")
        try:
            with temp_path.open("x", encoding="ascii") as handle:
                handle.write(token)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, path)
            return token
        except BaseException:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)
            raise

    def clear_scrub_pending(self, *, expected_token: str | None) -> bool:
        """Clear only the marker observed before this successful scrub began."""
        if expected_token is None:
            return False
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            current_token = self.scrub_pending_token()
            if current_token != expected_token:
                conn.execute("COMMIT")
                return False
            self.scrub_pending_path.unlink(missing_ok=True)
            conn.execute("COMMIT")
            return True
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def scrub(self, *, deadline_s: float) -> bool:
        """TRUNCATE the WAL on a fresh connection until it is physically empty.

        The deadline includes SQLite's busy wait and the explicit retry delay.
        ``False`` means a caller must persist ``scrub.pending`` before replying.
        """
        deadline = time.monotonic() + max(0.0, deadline_s)
        conn = self._connect()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                conn.execute(f"PRAGMA busy_timeout = {max(1, int(remaining * 1000))}")
                result_row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                assert result_row is not None
                busy = int(result_row[0])
                wal_path = Path(f"{self._db_path}-wal")
                try:
                    wal_empty = wal_path.stat().st_size == 0
                except FileNotFoundError:
                    wal_empty = True
                if busy == 0 and wal_empty:
                    return True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                time.sleep(min(0.05, remaining))
        finally:
            conn.close()

    # -- attachments (P2) -------------------------------------------------------

    def create_attachment(self, *, att_id: str, kind: AttachmentKind, now: float) -> AttachmentRow:
        with self._write_txn() as conn:
            if self._is_deleted_storage(conn, kind="attachment", storage_id=att_id):
                raise LiveChatStoreError("attachment id has already been deleted")
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, renditions, bytes_on_disk, created_at, updated_at) "
                "VALUES (?, ?, 'processing', '[]', 0, ?, ?)",
                (att_id, kind, now, now),
            )
            return _load_attachment(conn, att_id)

    def create_attachment_from_upload(
        self, *, att_id: str, kind: AttachmentKind, now: float
    ) -> AttachmentRow | None:
        """Promote an upload only if it survived a concurrent delete/wipe."""
        with self._write_txn() as conn:
            existing = conn.execute("SELECT id FROM attachments WHERE id = ?", (att_id,)).fetchone()
            if existing is not None:
                return _load_attachment(conn, att_id)
            if self._is_deleted_storage(conn, kind="attachment", storage_id=att_id):
                return None
            upload = conn.execute("SELECT 1 FROM uploads WHERE id = ?", (att_id,)).fetchone()
            if upload is None:
                return None
            conn.execute(
                "INSERT INTO attachments "
                "(id, kind, status, renditions, bytes_on_disk, created_at, updated_at) "
                "VALUES (?, ?, 'processing', '[]', 0, ?, ?)",
                (att_id, kind, now, now),
            )
            return _load_attachment(conn, att_id)

    def claim_processing(self, *, owner: str, now: float, lease_s: float) -> AttachmentRow | None:
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT id FROM attachments WHERE status = 'processing' "
                "AND (lease_owner IS NULL OR lease_expires_at < ?) "
                "ORDER BY created_at ASC LIMIT 1",
                (now,),
            ).fetchone()
            if row is None:
                return None
            att_id = row["id"]
            conn.execute(
                "UPDATE attachments SET lease_owner = ?, lease_expires_at = ?, updated_at = ? "
                "WHERE id = ?",
                (owner, now + lease_s, now, att_id),
            )
            return _load_attachment(conn, att_id)

    def renew_lease(self, *, att_id: str, owner: str, now: float, lease_s: float) -> bool:
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE attachments SET lease_expires_at = ?, updated_at = ? "
                "WHERE id = ? AND lease_owner = ?",
                (now + lease_s, now, att_id, owner),
            )
            return cursor.rowcount > 0

    def finish_attachment(
        self, *, att_id: str, owner: str, result: AttachmentResult, now: float
    ) -> None:
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT message_seq FROM attachments WHERE id = ? AND lease_owner = ?",
                (att_id, owner),
            ).fetchone()
            if row is None:
                # The lease expired and was reclaimed by someone else — this
                # worker's result is stale, so it's discarded rather than
                # clobbering whatever the new claimant is doing.
                exists = conn.execute(
                    "SELECT 1 FROM attachments WHERE id = ?", (att_id,)
                ).fetchone()
                if exists is None:
                    self._queue_deleted_storage(conn, kind="attachment", ids=[att_id], now=now)
                return
            conn.execute(
                "UPDATE attachments SET status = ?, mime = ?, width = ?, height = ?, "
                "duration_s = ?, peaks = ?, renditions = ?, bytes_on_disk = ?, failure = ?, "
                "lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
                (
                    result.status,
                    result.mime,
                    result.width,
                    result.height,
                    result.duration_s,
                    json.dumps(list(result.peaks)) if result.peaks is not None else None,
                    json.dumps(list(result.renditions)),
                    result.bytes_on_disk,
                    result.failure,
                    now,
                    att_id,
                ),
            )
            message_seq = row["message_seq"]
            if message_seq is not None:
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (message_seq, now),
                )

    def get_attachment(self, att_id: str) -> AttachmentRow | None:
        with self._read_txn() as conn:
            row = conn.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
            return _row_to_attachment(row) if row is not None else None

    def media_bytes_used(self) -> int:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(bytes_on_disk), 0) AS total FROM attachments"
            ).fetchone()
            return int(row["total"])

    def orphan_attachment_ids(self, *, older_than: float) -> list[str]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT id FROM attachments WHERE message_seq IS NULL AND created_at < ?",
                (older_than,),
            ).fetchall()
            return [row["id"] for row in rows]

    def delete_attachment(self, att_id: str) -> None:
        with self._write_txn() as conn:
            self._queue_deleted_storage(conn, kind="attachment", ids=[att_id], now=time.time())
            conn.execute("DELETE FROM attachments WHERE id = ?", (att_id,))

    # -- uploads (P2) -------------------------------------------------------

    def create_upload(self, row: UploadRow) -> None:
        with self._write_txn() as conn:
            if self._is_deleted_storage(conn, kind="upload", storage_id=row.id):
                raise LiveChatStoreError("upload id has already been deleted")
            conn.execute(
                "INSERT INTO uploads (id, kind, mime, size_bytes, filename, by_email, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    row.id,
                    row.kind,
                    row.mime,
                    row.size_bytes,
                    row.filename,
                    row.by_email,
                    row.created_at,
                ),
            )

    def get_upload(self, upload_id: str) -> UploadRow | None:
        with self._read_txn() as conn:
            row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
            return _row_to_upload(row) if row is not None else None

    def delete_upload(self, upload_id: str) -> None:
        with self._write_txn() as conn:
            self._queue_deleted_storage(conn, kind="upload", ids=[upload_id], now=time.time())
            conn.execute("DELETE FROM uploads WHERE id = ?", (upload_id,))

    def stale_upload_ids(self, *, older_than: float) -> list[str]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT id FROM uploads WHERE created_at < ?", (older_than,)
            ).fetchall()
            return [row["id"] for row in rows]

    def pending_upload_bytes(self) -> int:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM uploads"
            ).fetchone()
            return int(row["total"])

    # -- push (P3) -------------------------------------------------------

    def upsert_push_subscription(self, row: PushSubscriptionRow) -> None:
        with self._write_txn() as conn:
            conn.execute(
                "INSERT INTO push_subscriptions "
                "(device_id, sender, endpoint, p256dh, auth, created_at, last_ok_at, "
                "consecutive_failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(device_id) DO UPDATE SET "
                "sender = excluded.sender, endpoint = excluded.endpoint, "
                "p256dh = excluded.p256dh, auth = excluded.auth, "
                "created_at = excluded.created_at, last_ok_at = excluded.last_ok_at, "
                "consecutive_failures = excluded.consecutive_failures",
                (
                    row.device_id,
                    row.sender,
                    row.endpoint,
                    row.p256dh,
                    row.auth,
                    row.created_at,
                    row.last_ok_at,
                    row.consecutive_failures,
                ),
            )

    def delete_push_subscription(self, device_id: str) -> None:
        with self._write_txn() as conn:
            conn.execute("DELETE FROM push_subscriptions WHERE device_id = ?", (device_id,))

    def get_push_subscription(self, device_id: str) -> PushSubscriptionRow | None:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT * FROM push_subscriptions WHERE device_id = ?", (device_id,)
            ).fetchone()
            return _row_to_push_subscription(row) if row is not None else None

    def list_push_subscriptions(self) -> list[PushSubscriptionRow]:
        with self._read_txn() as conn:
            rows = conn.execute("SELECT * FROM push_subscriptions").fetchall()
            return [_row_to_push_subscription(row) for row in rows]

    def record_push_result(self, *, device_id: str, ok: bool, now: float) -> int | None:
        """Record one delivery and return the resulting failure streak.

        The count is read inside the same immediate write transaction as the
        increment.  Dispatch can therefore apply the ten-failure removal rule
        without a racy second read when several messages fan out concurrently.
        ``None`` means the subscription disappeared between listing and result.
        """
        with self._write_txn() as conn:
            if ok:
                conn.execute(
                    "UPDATE push_subscriptions SET last_ok_at = ?, consecutive_failures = 0 "
                    "WHERE device_id = ?",
                    (now, device_id),
                )
                return 0
            else:
                conn.execute(
                    "UPDATE push_subscriptions SET consecutive_failures = consecutive_failures + 1 "
                    "WHERE device_id = ?",
                    (device_id,),
                )
                row = conn.execute(
                    "SELECT consecutive_failures FROM push_subscriptions WHERE device_id = ?",
                    (device_id,),
                ).fetchone()
                return int(row["consecutive_failures"]) if row is not None else None
