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

import hmac
import json
import logging
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from wixy_server.livechat.models import (
    AttachmentKind,
    AttachmentResult,
    AttachmentRow,
    EventRow,
    MessageRow,
    PushSubscriptionRow,
    ReactionSummary,
    TranscriptRow,
    UploadRow,
)
from wixy_server.livechat.reactions import reaction_order, reactor_key

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

_SCHEMA_V5_STORAGE_GENERATION = """
ALTER TABLE deleted_storage
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_deleted_storage_completed_age
  ON deleted_storage(deleted_at) WHERE cleanup_pending = 0;
"""

_SCHEMA_V6_PENDING_SCRUB = """
CREATE TABLE IF NOT EXISTS pending_scrub(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  token TEXT NOT NULL);
"""

# `ON DELETE CASCADE` is load-bearing (decisions/00164): every connection runs
# with foreign_keys=ON, and during a blue/green overlap an OLDER process that knows
# nothing about this table can still hard-delete a message. Without the cascade that
# delete would die on a foreign-key error; with it, the reactions go with the message and
# `secure_delete` zeroes them like any other deleted row (Inv 46).
_SCHEMA_V7_REACTIONS = """
CREATE TABLE IF NOT EXISTS reactions(
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  sender_key TEXT NOT NULL,
  sender TEXT NOT NULL,
  emoji TEXT NOT NULL,
  by_email TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY(message_seq, sender_key, emoji));
"""

_SCHEMA_V8_ATTACHMENT_TRANSCRIPTS = """
CREATE TABLE IF NOT EXISTS attachment_transcripts(
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),
  text TEXT, failure TEXT, engine TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
"""

_SCHEMA_V9_DEVICE_GRANTS = """
CREATE TABLE IF NOT EXISTS device_grants(
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  label TEXT,
  created_at REAL NOT NULL,
  last_used_at REAL NOT NULL,
  revoked_at REAL);
"""

# Round 2 ruling item 10 §(1): a nullable self-referencing column, not a
# mapping table — a message quotes at most one message, fixed at send and
# never edited. The index is REQUIRED, not tuning: `DELETE FROM messages`
# (what `wipe()` runs) must search this child column for every deleted row's
# `ON DELETE SET NULL` action, and unindexed that is O(n) per row (measured
# 2026-09-25: 17.6s vs 0.2s at 20,000 messages, one in three a reply).
# SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column add is guarded by
# hand below (`_migrate`) — unlike every other statement here, which is
# already idempotent (`CREATE ... IF NOT EXISTS`) for the same reason this
# file's own cold-start note gives: a racing duplicate migration attempt
# (two blue/green processes, or — as `test_v3_database_gets_pending_storage_
# index_in_v4` proves — a `user_version` that legitimately lags a table that
# already has the column) must be a harmless no-op, not an OperationalError.
_SCHEMA_V10_REPLY_TO_COLUMN = (
    "ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER "
    "REFERENCES messages(seq) ON DELETE SET NULL"
)
_SCHEMA_V10_REPLY_TO_INDEX = """
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON messages(reply_to_seq) WHERE reply_to_seq IS NOT NULL;
"""

_SCHEMA_V11_VIEW_ONCE_MESSAGES = [
    "ALTER TABLE messages ADD COLUMN view_once_s INTEGER "
    "CHECK(view_once_s IS NULL OR view_once_s IN (0, 2, 5, 30))",
    "ALTER TABLE messages ADD COLUMN view_spotlight INTEGER NOT NULL DEFAULT 0 "
    "CHECK(view_spotlight IN (0, 1))",
    "ALTER TABLE messages ADD COLUMN view_claim_id TEXT",
    "ALTER TABLE messages ADD COLUMN view_claimed_at REAL",
    "ALTER TABLE messages ADD COLUMN view_claim_email TEXT",
]
_SCHEMA_V11_VIEW_ONCE_INDEX = """
CREATE INDEX IF NOT EXISTS idx_messages_view_claimed
  ON messages(view_claimed_at) WHERE view_claimed_at IS NOT NULL;
"""
_SCHEMA_V11_VIEW_ONCE_ATTACHMENTS = "ALTER TABLE attachments ADD COLUMN view_once_renditions TEXT"

_LATEST_SCHEMA_VERSION = 11
_UNKNOWN_GRANT_HASH = "0" * 64
_LOGGER = logging.getLogger(__name__)


class LiveChatStoreError(Exception):
    """Base for store-level validation failures the route layer maps to a 4xx."""


class AttachmentNotReadyError(LiveChatStoreError):
    """An attachment is valid and usable, but still processing. `routes_livechat.py`
    maps this to 422 {"error": "not_ready"}."""

    def __init__(self, attachment_id: str) -> None:
        super().__init__(f"attachment {attachment_id!r} is not ready yet")
        self.attachment_id = attachment_id


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


class MessageNotFoundError(LiveChatStoreError):
    """The message a request targets does not exist (never did, or was hard-deleted).
    `routes_livechat.py` maps this to 404, never a 500."""

    def __init__(self, seq: int) -> None:
        super().__init__(f"message {seq} does not exist")
        self.seq = seq


@dataclass(frozen=True, slots=True)
class TranscriptBegin:
    """What `begin_transcript` decided: `started` (a fresh `pending` row — the caller must
    run the job), `pending` (a job already owns it), `done` (nothing to do; `transcript`
    holds the stored text) or `gone` (unknown, not a sent ready voice note, or deleted)."""

    state: Literal["started", "pending", "done", "gone"]
    transcript: TranscriptRow | None = None


_SELECT_ATTACHMENT = (
    "SELECT a.*, t.status AS tr_status, t.text AS tr_text, t.failure AS tr_failure, "
    "t.engine AS tr_engine, t.created_at AS tr_created_at, t.updated_at AS tr_updated_at "
    "FROM attachments AS a LEFT JOIN attachment_transcripts AS t ON t.attachment_id = a.id"
)
"""Every `AttachmentRow` load goes through this one join, so a transcript can never be
missing from an attachment a client is shown (`_row_to_attachment` reads the `tr_*` columns)."""


def _row_to_transcript(row: sqlite3.Row) -> TranscriptRow | None:
    status = row["tr_status"]
    if status is None:
        return None
    return TranscriptRow(
        attachment_id=row["id"],
        status=status,
        text=row["tr_text"],
        failure=row["tr_failure"],
        engine=row["tr_engine"],
        created_at=row["tr_created_at"],
        updated_at=row["tr_updated_at"],
    )


def _row_to_attachment(row: sqlite3.Row) -> AttachmentRow:
    peaks_raw = row["peaks"]
    keys = row.keys()
    vo_raw = row["view_once_renditions"] if "view_once_renditions" in keys else None
    view_once_renditions = tuple(json.loads(vo_raw)) if vo_raw is not None else None
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
        transcript=_row_to_transcript(row),
        view_once_renditions=view_once_renditions,
    )


def _row_to_message(
    row: sqlite3.Row,
    attachments: tuple[AttachmentRow, ...],
    reactions: tuple[ReactionSummary, ...] = (),
    *,
    reply_to: MessageRow | None = None,
) -> MessageRow:
    keys = row.keys()
    return MessageRow(
        seq=row["seq"],
        client_id=row["client_id"],
        sender=row["sender"],
        device_id=row["device_id"],
        by_email=row["by_email"],
        text=row["text"],
        created_at=row["created_at"],
        attachments=attachments,
        reactions=reactions,
        reply_to_seq=row["reply_to_seq"] if "reply_to_seq" in keys else None,
        reply_to=reply_to,
        view_once_s=row["view_once_s"] if "view_once_s" in keys else None,
        view_spotlight=row["view_spotlight"] if "view_spotlight" in keys else 0,
        view_claim_id=row["view_claim_id"] if "view_claim_id" in keys else None,
        view_claimed_at=row["view_claimed_at"] if "view_claimed_at" in keys else None,
        view_claim_email=row["view_claim_email"] if "view_claim_email" in keys else None,
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
    row = conn.execute(f"{_SELECT_ATTACHMENT} WHERE a.id = ?", (att_id,)).fetchone()
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
        f"{_SELECT_ATTACHMENT} WHERE a.message_seq IN ({placeholders}) "
        "ORDER BY a.message_seq, a.ordinal",
        tuple(message_seqs),
    ).fetchall()
    for row in rows:
        by_message[row["message_seq"]].append(_row_to_attachment(row))
    return by_message


def _load_reactions_for(
    conn: sqlite3.Connection, message_seqs: Sequence[int]
) -> dict[int, tuple[ReactionSummary, ...]]:
    """Reactions grouped per message and emoji: allowlist order across emoji, oldest
    reaction first within one emoji."""
    if not message_seqs:
        return {}
    by_message: dict[int, dict[str, list[str]]] = {seq: {} for seq in message_seqs}
    placeholders = ",".join("?" for _ in message_seqs)
    rows = conn.execute(
        "SELECT message_seq, emoji, sender FROM reactions "
        f"WHERE message_seq IN ({placeholders}) ORDER BY created_at, rowid",
        tuple(message_seqs),
    ).fetchall()
    for row in rows:
        by_message[row["message_seq"]].setdefault(row["emoji"], []).append(row["sender"])
    return {
        seq: tuple(
            ReactionSummary(emoji=emoji, senders=tuple(senders))
            for emoji, senders in sorted(emojis.items(), key=lambda item: reaction_order(item[0]))
        )
        for seq, emojis in by_message.items()
    }


def _load_reply_targets(
    conn: sqlite3.Connection, reply_to_seqs: Sequence[int | None]
) -> dict[int, MessageRow]:
    """Round 2 ruling item 10 §(2): resolve reply targets at READ time, in the
    same transaction as the messages that quote them — never a stored copy.
    Loaded ONE LEVEL ONLY (each target's own `reply_to` is left `None`), so a
    quote never shows the target's own quote (§(3))."""
    unique_seqs = sorted({seq for seq in reply_to_seqs if seq is not None})
    if not unique_seqs:
        return {}
    placeholders = ",".join("?" for _ in unique_seqs)
    rows = conn.execute(
        f"SELECT * FROM messages WHERE seq IN ({placeholders})", tuple(unique_seqs)
    ).fetchall()
    by_seq = {row["seq"]: row for row in rows}
    attachments_by_seq = _load_attachments_for(conn, list(by_seq.keys()))
    return {
        seq: _row_to_message(row, tuple(attachments_by_seq[seq])) for seq, row in by_seq.items()
    }


def _load_message(conn: sqlite3.Connection, seq: int) -> MessageRow:
    row = conn.execute("SELECT * FROM messages WHERE seq = ?", (seq,)).fetchone()
    if row is None:
        raise KeyError(seq)
    attachments = _load_attachments_for(conn, [seq])[seq]
    reactions = _load_reactions_for(conn, [seq])[seq]
    reply_to_seq = row["reply_to_seq"]
    reply_targets = _load_reply_targets(conn, [reply_to_seq])
    reply_to = reply_targets.get(reply_to_seq) if reply_to_seq is not None else None
    return _row_to_message(row, tuple(attachments), reactions, reply_to=reply_to)


_JOURNAL_MODE_SWITCH_RETRIES = 50
_JOURNAL_MODE_SWITCH_RETRY_DELAY_S = 0.02


class LiveChatStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._scrub_lock = threading.Lock()

    @contextmanager
    def scrub_guard(self, *, timeout_s: float | None = None) -> Iterator[bool]:
        """Serialize WAL scrubs, optionally bounding a request's lock wait."""
        acquired = (
            self._scrub_lock.acquire()
            if timeout_s is None
            else self._scrub_lock.acquire(timeout=max(0.0, timeout_s))
        )
        try:
            yield acquired
        finally:
            if acquired:
                self._scrub_lock.release()

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
            self._ensure_attachment_transcripts_table(conn)
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
                current = 4

            if current < 5:
                for statement in _SCHEMA_V5_STORAGE_GENERATION.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 5")
                current = 5

            if current < 6:
                for statement in _SCHEMA_V6_PENDING_SCRUB.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 6")
                current = 6

            if current < 7:
                for statement in _SCHEMA_V7_REACTIONS.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 7")
                current = 7

            if current < 8:
                for statement in _SCHEMA_V8_ATTACHMENT_TRANSCRIPTS.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 8")
                current = 8

            if current < 9:
                for statement in _SCHEMA_V9_DEVICE_GRANTS.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 9")
                current = 9

            if current < 10:
                existing_columns = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
                if "reply_to_seq" not in existing_columns:
                    conn.execute(_SCHEMA_V10_REPLY_TO_COLUMN)
                for statement in _SCHEMA_V10_REPLY_TO_INDEX.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 10")
                current = 10

            if current < 11:
                existing_msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
                if existing_msg_cols:
                    col_defs = [
                        ("view_once_s", _SCHEMA_V11_VIEW_ONCE_MESSAGES[0]),
                        ("view_spotlight", _SCHEMA_V11_VIEW_ONCE_MESSAGES[1]),
                        ("view_claim_id", _SCHEMA_V11_VIEW_ONCE_MESSAGES[2]),
                        ("view_claimed_at", _SCHEMA_V11_VIEW_ONCE_MESSAGES[3]),
                        ("view_claim_email", _SCHEMA_V11_VIEW_ONCE_MESSAGES[4]),
                    ]
                    for col_name, stmt in col_defs:
                        if col_name not in existing_msg_cols:
                            conn.execute(stmt)
                    for statement in _SCHEMA_V11_VIEW_ONCE_INDEX.split(";"):
                        if statement.strip():
                            conn.execute(statement)

                existing_att_cols = {
                    row[1] for row in conn.execute("PRAGMA table_info(attachments)")
                }
                if existing_att_cols and "view_once_renditions" not in existing_att_cols:
                    conn.execute(_SCHEMA_V11_VIEW_ONCE_ATTACHMENTS)
                conn.execute("PRAGMA user_version = 11")
                current = 11
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        self._ensure_attachment_transcripts_table(conn)

    @staticmethod
    def _ensure_attachment_transcripts_table(conn: sqlite3.Connection) -> None:
        """Independent of `PRAGMA user_version`. A database that reaches user_version=8
        through a migration path that ran before this table's own v8 step existed (a sibling
        round-2 branch merging first, or an old binary's own partial ladder) must still end up
        with this table. A plain read against `sqlite_master` costs nothing once the table
        exists (the overwhelmingly common case, checked on every connect same as the
        `user_version` read above); only a database that genuinely lacks the table pays for the
        `CREATE TABLE IF NOT EXISTS`, which is itself a no-op if a racing connection's own
        check-then-create won a concurrent race."""
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attachment_transcripts'"
        ).fetchone()
        if exists is not None:
            return
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in _SCHEMA_V8_ATTACHMENT_TRANSCRIPTS.split(";"):
                if statement.strip():
                    conn.execute(statement)
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
        reply_to_seq: int | None = None,
        now: float,
    ) -> tuple[MessageRow, bool]:
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False

            # §(3): resolved inside this IMMEDIATE transaction, so there is no
            # race with a concurrent delete between the check and the insert.
            # A target that no longer exists (deleted a moment earlier, or
            # never existed) silently sends this as a plain message — exactly
            # what would have happened had the delete landed a moment later —
            # rather than ever letting the FK raise `IntegrityError`.
            stored_reply_to_seq: int | None = None
            if reply_to_seq is not None:
                target_exists = (
                    conn.execute("SELECT 1 FROM messages WHERE seq = ?", (reply_to_seq,)).fetchone()
                    is not None
                )
                if target_exists:
                    stored_reply_to_seq = reply_to_seq

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
                "INSERT INTO messages "
                "(client_id, sender, device_id, by_email, text, created_at, reply_to_seq) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (client_id, sender, device_id, by_email, text, now, stored_reply_to_seq),
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

    def create_view_once_message(
        self,
        *,
        client_id: str,
        sender: str,
        device_id: str,
        by_email: str | None,
        attachment_id: str,
        duration_s: int | None,
        spotlight: bool,
        reply_to_seq: int | None = None,
        now: float,
    ) -> tuple[MessageRow, bool]:
        """Creates a view-once message holding exactly one attachment and no text.

        Enforces Inv 52: copies the attachment's renditions list into
        view_once_renditions and clears renditions to '[]' in the SAME transaction.
        """
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False

            stored_reply_to_seq: int | None = None
            if reply_to_seq is not None:
                target_exists = (
                    conn.execute("SELECT 1 FROM messages WHERE seq = ?", (reply_to_seq,)).fetchone()
                    is not None
                )
                if target_exists:
                    stored_reply_to_seq = reply_to_seq

            candidate = conn.execute(
                "SELECT id, message_seq, status, kind, renditions FROM attachments WHERE id = ?",
                (attachment_id,),
            ).fetchone()
            if (
                candidate is None
                or candidate["message_seq"] is not None
                or candidate["kind"] not in ("photo", "video")
                or (spotlight and candidate["kind"] != "photo")
            ):
                raise UnusableAttachmentError(attachment_id)
            if candidate["status"] != "ready":
                raise AttachmentNotReadyError(attachment_id)

            # In the same transaction that creates the message:
            # 1. copies the attachment's renditions list into view_once_renditions;
            # 2. sets renditions = '[]'.
            renditions_raw = candidate["renditions"]
            conn.execute(
                "UPDATE attachments SET renditions = '[]', view_once_renditions = ? WHERE id = ?",
                (renditions_raw, attachment_id),
            )

            # In DB: view_once_s: NULL = ordinary; 0 = no limit; 2, 5, 30.
            stored_duration_s = 0 if duration_s is None else duration_s
            view_spotlight = 1 if spotlight else 0

            cursor = conn.execute(
                "INSERT INTO messages "
                "(client_id, sender, device_id, by_email, text, created_at, "
                "reply_to_seq, view_once_s, view_spotlight) "
                "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
                (
                    client_id,
                    sender,
                    device_id,
                    by_email,
                    now,
                    stored_reply_to_seq,
                    stored_duration_s,
                    view_spotlight,
                ),
            )
            seq = cursor.lastrowid
            assert seq is not None
            conn.execute(
                "UPDATE attachments SET message_seq = ?, ordinal = 0 WHERE id = ?",
                (seq, attachment_id),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES ('message', ?, ?)",
                (seq, now),
            )
            return _load_message(conn, seq), True

    def claim_view_once(
        self,
        *,
        seq: int,
        claim_id: str,
        email: str,
        sender: str,
        now: float,
    ) -> tuple[
        Literal["ok", "own_message", "already_opened", "not_found"],
        MessageRow | None,
        AttachmentRow | None,
    ]:
        """Claims a view-once message atomically inside BEGIN IMMEDIATE.

        Returns:
        - ('not_found', None, None) if message does not exist or is not view-once.
        - ('own_message', msg, None) if requester is the sender.
        - ('ok', msg, att) if claim succeeded or is an idempotent retry with same claim_id & email.
        - ('already_opened', msg, None) if a different claim already holds it.
        """
        with self._write_txn() as conn:
            row = conn.execute("SELECT * FROM messages WHERE seq = ?", (seq,)).fetchone()
            if row is None or row["view_once_s"] is None:
                return "not_found", None, None

            # Own message check: same email when non-empty, else same sender name (R8)
            msg_email = row["by_email"] or ""
            msg_sender = row["sender"] or ""
            if email and msg_email:
                is_own = email == msg_email
            else:
                is_own = sender.strip().casefold() == msg_sender.strip().casefold()
            if is_own:
                return "own_message", _load_message(conn, seq), None

            existing_claim = row["view_claim_id"]
            if existing_claim is not None:
                if (
                    hmac.compare_digest(existing_claim, claim_id)
                    and (row["view_claim_email"] or "") == email
                ):
                    msg = _load_message(conn, seq)
                    att = msg.attachments[0] if msg.attachments else None
                    return "ok", msg, att
                return "already_opened", _load_message(conn, seq), None

            cursor = conn.execute(
                "UPDATE messages SET view_claim_id = ?, view_claimed_at = ?, view_claim_email = ? "
                "WHERE seq = ? AND view_once_s IS NOT NULL AND view_claim_id IS NULL",
                (claim_id, now, email, seq),
            )
            if cursor.rowcount == 1:
                msg = _load_message(conn, seq)
                att = msg.attachments[0] if msg.attachments else None
                return "ok", msg, att

            # Another connection won the race
            refreshed = conn.execute("SELECT * FROM messages WHERE seq = ?", (seq,)).fetchone()
            if refreshed is not None and refreshed["view_claim_id"] is not None:
                if (
                    hmac.compare_digest(refreshed["view_claim_id"], claim_id)
                    and (refreshed["view_claim_email"] or "") == email
                ):
                    msg = _load_message(conn, seq)
                    att = msg.attachments[0] if msg.attachments else None
                    return "ok", msg, att
            return "already_opened", _load_message(conn, seq), None

    def get_view_once_content_info(
        self,
        *,
        seq: int,
        claim_id: str,
        email: str,
        now: float,
    ) -> tuple[
        Literal["ok", "not_found", "forbidden", "expired"],
        MessageRow | None,
        AttachmentRow | None,
    ]:
        with self._read_txn() as conn:
            row = conn.execute("SELECT * FROM messages WHERE seq = ?", (seq,)).fetchone()
            if row is None or row["view_once_s"] is None or row["view_claim_id"] is None:
                return "not_found", None, None
            if not hmac.compare_digest(row["view_claim_id"], claim_id):
                return "forbidden", None, None
            if (row["view_claim_email"] or "") != email:
                return "forbidden", None, None
            claimed_at = row["view_claimed_at"]
            if claimed_at is None or now >= claimed_at + 600.0:
                return "expired", None, None
            msg = _load_message(conn, seq)
            att = msg.attachments[0] if msg.attachments else None
            return "ok", msg, att

    def is_attachment_view_once(self, att_id: str) -> bool:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT a.view_once_renditions, m.view_once_s "
                "FROM attachments a LEFT JOIN messages m ON a.message_seq = m.seq "
                "WHERE a.id = ?",
                (att_id,),
            ).fetchone()
            if row is None:
                return False
            if row["view_once_renditions"] is not None:
                return True
            if row["view_once_s"] is not None:
                return True
            return False

    def expired_claimed_view_once_seqs(self, *, older_than: float) -> list[int]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT seq FROM messages "
                "WHERE view_claimed_at IS NOT NULL AND view_claimed_at < ?",
                (older_than,),
            ).fetchall()
            return [int(row["seq"]) for row in rows]

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
            reactions_by_seq = _load_reactions_for(conn, seqs)
            # §(2): targets are resolved by seq, including ones OUTSIDE this
            # page — a reply near the top of a page may quote a message that
            # paged off already.
            reply_targets = _load_reply_targets(
                conn, [row["reply_to_seq"] for row in ascending_rows]
            )
            messages = [
                _row_to_message(
                    row,
                    tuple(attachments_by_seq[row["seq"]]),
                    reactions_by_seq[row["seq"]],
                    reply_to=reply_targets.get(row["reply_to_seq"]),
                )
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
            reactions_by_seq = _load_reactions_for(conn, list(by_seq.keys()))
            reply_targets = _load_reply_targets(
                conn, [row["reply_to_seq"] for row in by_seq.values()]
            )
            result: list[MessageRow] = []
            for seq in seqs:
                row = by_seq.get(seq)
                if row is None:
                    continue
                result.append(
                    _row_to_message(
                        row,
                        tuple(attachments_by_seq[seq]),
                        reactions_by_seq[seq],
                        reply_to=reply_targets.get(row["reply_to_seq"]),
                    )
                )
            return result

    def set_reaction(
        self,
        *,
        seq: int,
        sender: str,
        by_email: str | None,
        emoji: str,
        reacted: bool,
        now: float,
    ) -> tuple[MessageRow, bool]:
        """Set (not toggle) one reactor's emoji on one message — a retry after a dropped
        response therefore cannot flip it back. Returns the current message and whether
        anything changed; only a real change appends the `message_updated` event. The
        caller has already validated `emoji` (allowlist) and `sender` (POST /messages rules).
        """
        key = reactor_key(sender)
        with self._write_txn() as conn:
            if conn.execute("SELECT 1 FROM messages WHERE seq = ?", (seq,)).fetchone() is None:
                raise MessageNotFoundError(seq)
            try:
                if reacted:
                    changed = (
                        conn.execute(
                            "INSERT OR IGNORE INTO reactions "
                            "(message_seq, sender_key, sender, emoji, by_email, created_at) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            (seq, key, sender.strip(), emoji, by_email, now),
                        ).rowcount
                        > 0
                    )
                else:
                    changed = (
                        conn.execute(
                            "DELETE FROM reactions "
                            "WHERE message_seq = ? AND sender_key = ? AND emoji = ?",
                            (seq, key, emoji),
                        ).rowcount
                        > 0
                    )
            except sqlite3.IntegrityError as exc:
                # The row was checked above under this write lock, so this is only a
                # backstop: a message that vanished is "not found", never a 500.
                raise MessageNotFoundError(seq) from exc
            if changed:
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (seq, now),
                )
            return _load_message(conn, seq), changed

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
                pending_token = self._upsert_pending_scrub(conn)
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
                pending_token = self._upsert_pending_scrub(conn)
        return attachment_ids, upload_ids, pending_token, wipe_token

    def _legacy_scrub_pending_path(self) -> Path:
        return self._db_path.parent / "scrub.pending"

    def scrub_pending(self) -> bool:
        return self.scrub_pending_token() is not None

    def import_legacy_scrub_marker(self) -> str | None:
        """Import the pre-v6 marker once at startup, then remove the legacy file."""
        try:
            legacy_token = self._legacy_scrub_pending_path().read_text(encoding="ascii").strip()
        except FileNotFoundError:
            return self.scrub_pending_token()
        except OSError:
            _LOGGER.exception(
                "Could not read legacy Server chat scrub marker; retrying next startup"
            )
            with self._write_txn() as conn:
                conn.execute(
                    "INSERT INTO pending_scrub(singleton, token) VALUES (1, ?) "
                    "ON CONFLICT(singleton) DO NOTHING",
                    (uuid.uuid4().hex,),
                )
            return self.scrub_pending_token()

        token = legacy_token or uuid.uuid4().hex
        with self._write_txn() as conn:
            row = conn.execute("SELECT token FROM pending_scrub WHERE singleton = 1").fetchone()
            if row is None:
                conn.execute("INSERT INTO pending_scrub(singleton, token) VALUES (1, ?)", (token,))
            else:
                token = str(row["token"])
        try:
            self._legacy_scrub_pending_path().unlink(missing_ok=True)
        except OSError:
            _LOGGER.exception("Could not remove imported legacy Server chat scrub marker")
        return token

    @staticmethod
    def _queue_deleted_storage(
        conn: sqlite3.Connection, *, kind: str, ids: Sequence[str], now: float
    ) -> None:
        for storage_id in set(ids):
            conn.execute(
                "INSERT INTO deleted_storage(kind, id, cleanup_pending, deleted_at, generation) "
                "VALUES (?, ?, 1, ?, 1) "
                "ON CONFLICT(kind, id) DO UPDATE SET "
                "cleanup_pending = 1, deleted_at = excluded.deleted_at, "
                "generation = deleted_storage.generation + 1",
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

    def pending_deleted_storage_items(self) -> list[tuple[str, str, int]]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT kind, id, generation FROM deleted_storage "
                "WHERE cleanup_pending = 1 ORDER BY kind, id"
            ).fetchall()
            return [(str(row["kind"]), str(row["id"]), int(row["generation"])) for row in rows]

    def mark_deleted_storage_pending(self, *, kind: str, storage_id: str, now: float) -> None:
        with self._write_txn() as conn:
            self._queue_deleted_storage(conn, kind=kind, ids=[storage_id], now=now)

    def requeue_deleted_storage_if_exists(self, *, kind: str, storage_id: str) -> bool:
        """Bump the generation so a cleanup pass cannot erase a concurrent requeue."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE deleted_storage SET cleanup_pending = 1, generation = generation + 1 "
                "WHERE kind = ? AND id = ?",
                (kind, storage_id),
            )
            return cursor.rowcount > 0

    def clear_deleted_storage_pending_many(self, items: Sequence[tuple[str, str, int]]) -> None:
        if not items:
            return
        with self._write_txn() as conn:
            conn.executemany(
                "UPDATE deleted_storage SET cleanup_pending = 0 "
                "WHERE kind = ? AND id = ? AND generation = ? AND cleanup_pending = 1",
                items,
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
        with self._read_txn() as conn:
            row = conn.execute("SELECT token FROM pending_scrub WHERE singleton = 1").fetchone()
            return str(row["token"]) if row is not None else None

    def mark_scrub_pending(self) -> str:
        """Durably record unfinished erasure before a 202 can be returned."""
        with self._write_txn() as conn:
            return self._upsert_pending_scrub(conn)

    def _upsert_pending_scrub(self, conn: sqlite3.Connection) -> str:
        """Write the marker atomically with the erasure transaction."""
        if not conn.in_transaction:
            raise RuntimeError("scrub marker must be written inside a SQLite transaction")
        token = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO pending_scrub(singleton, token) VALUES (1, ?) "
            "ON CONFLICT(singleton) DO UPDATE SET token = excluded.token",
            (token,),
        )
        return token

    def clear_scrub_pending(self, *, expected_token: str | None) -> bool:
        """Clear only the marker observed before this successful scrub began."""
        if expected_token is None:
            return False
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.execute(
                "DELETE FROM pending_scrub WHERE singleton = 1 AND token = ?",
                (expected_token,),
            )
            conn.execute("COMMIT")
            return cursor.rowcount == 1
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def scrub(self, *, deadline_s: float) -> bool:
        """TRUNCATE the WAL on a fresh connection until it is physically empty.

        The deadline includes SQLite's busy wait and the explicit retry delay.
        ``False`` means the database-backed pending marker remains for retry.
        """
        deadline = time.monotonic() + max(0.0, deadline_s)
        conn = self._connect()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                busy_timeout_ms = max(1, min(250, int(remaining * 1000)))
                conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
                result_row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                assert result_row is not None
                busy = int(result_row[0])
                wal_path = Path(f"{self._db_path}-wal")
                try:
                    wal_empty = wal_path.stat().st_size == 0
                except FileNotFoundError:
                    wal_empty = True
                except OSError:
                    # SQLite may be deleting the WAL as its last connection
                    # closes; a transient Windows sharing denial means retry.
                    wal_empty = False
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
                # §(3): a quote's media summary is derived from the target's
                # LIVE attachment state, so a reply's rendered quote must
                # refresh too once processing finishes (e.g. it gains a
                # thumbnail). `idx_messages_reply_to` serves this lookup.
                reply_rows = conn.execute(
                    "SELECT seq FROM messages WHERE reply_to_seq = ?", (message_seq,)
                ).fetchall()
                for reply_row in reply_rows:
                    conn.execute(
                        "INSERT INTO events (type, message_seq, created_at) "
                        "VALUES ('message_updated', ?, ?)",
                        (reply_row["seq"], now),
                    )

    def get_attachment(self, att_id: str) -> AttachmentRow | None:
        with self._read_txn() as conn:
            row = conn.execute(f"{_SELECT_ATTACHMENT} WHERE a.id = ?", (att_id,)).fetchone()
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

    def delete_orphan_attachment_if_unclaimed(self, att_id: str, *, now: float) -> bool:
        """Delete and journal an attachment only if no message claimed it meanwhile."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "DELETE FROM attachments WHERE id = ? AND message_seq IS NULL", (att_id,)
            )
            if cursor.rowcount != 1:
                return False
            self._queue_deleted_storage(conn, kind="attachment", ids=[att_id], now=now)
            return True

    # -- voice-note transcripts (spec/server-chat/05-voice-transcription.md) --------

    def _append_message_updated(self, conn: sqlite3.Connection, att_id: str, now: float) -> None:
        row = conn.execute("SELECT message_seq FROM attachments WHERE id = ?", (att_id,)).fetchone()
        if row is not None and row["message_seq"] is not None:
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (row["message_seq"], now),
            )

    def get_transcript(self, att_id: str) -> TranscriptRow | None:
        attachment = self.get_attachment(att_id)
        return attachment.transcript if attachment is not None else None

    def begin_transcript(
        self, *, att_id: str, now: float, restart_pending: bool = False
    ) -> TranscriptBegin:
        """Atomically decide whether a transcription job should start for `att_id`.

        `restart_pending=True` treats an existing `pending` row like a `failed` one and starts
        over: the route passes it only when THIS process has no job in flight for the note, so
        the row belongs to a job that is gone (its outcome could not be recorded, or it was
        started by a process that died) — never to a live one.

        Everything is checked under one write lock, so two racing requests can never both
        get `started`: the loser sees the winner's `pending` row. A missing row and a
        `failed` row both become a fresh `pending` one (a failed row is the retry), and the
        `pending` state is announced as a `message_updated` event so the other device shows
        its spinner too. Because the attachment's existence is verified inside the same
        transaction that inserts the row, the foreign key can never fail here.
        """
        with self._write_txn() as conn:
            attachment = conn.execute(
                "SELECT kind, status, message_seq FROM attachments WHERE id = ?", (att_id,)
            ).fetchone()
            if (
                attachment is None
                or attachment["kind"] != "voice"
                or attachment["status"] != "ready"
                or attachment["message_seq"] is None
            ):
                return TranscriptBegin("gone")
            existing = _load_attachment(conn, att_id).transcript
            if existing is not None and existing.status == "done":
                return TranscriptBegin("done", existing)
            if existing is not None and existing.status == "pending" and not restart_pending:
                return TranscriptBegin("pending", existing)
            if existing is None:
                conn.execute(
                    "INSERT INTO attachment_transcripts "
                    "(attachment_id, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)",
                    (att_id, now, now),
                )
            else:
                conn.execute(
                    "UPDATE attachment_transcripts SET status = 'pending', text = NULL, "
                    "failure = NULL, engine = NULL, updated_at = ? WHERE attachment_id = ?",
                    (now, att_id),
                )
            self._append_message_updated(conn, att_id, now)
            return TranscriptBegin("started", _load_attachment(conn, att_id).transcript)

    def finish_transcript(
        self,
        *,
        att_id: str,
        status: Literal["done", "failed"],
        text: str | None,
        failure: str | None,
        engine: str | None,
        now: float,
        only_if_pending: bool = False,
    ) -> bool:
        """Record a job's outcome. Returns False when the row is gone (the message was
        deleted or the chat wiped while the job ran — `ON DELETE CASCADE` removed it): the
        result is discarded and no event is emitted, so a late transcript can never
        resurrect erased content. Ordinarily not conditional on the row still being
        `pending`, so a live job in another process can still land its result after this
        process's startup marked the row `failed`. `only_if_pending=True` is for the
        "interrupted" record a cancelled job writes on its way out: it must only ever turn a
        still-`pending` row into `failed`, never overwrite a `done` transcript or a newer
        attempt's outcome."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE attachment_transcripts SET status = ?, text = ?, failure = ?, "
                "engine = ?, updated_at = ? WHERE attachment_id = ?"
                + (" AND status = 'pending'" if only_if_pending else ""),
                (status, text if status == "done" else None, failure, engine, now, att_id),
            )
            if cursor.rowcount != 1:
                return False
            self._append_message_updated(conn, att_id, now)
            return True

    def fail_stale_pending_transcripts(self, *, now: float) -> int:
        """Startup recovery: a `pending` row at process start belongs to a job that died with
        its process, so it becomes `failed` (the user can retry) and each affected message
        gets a `message_updated` event so a reconnecting client leaves its spinner."""
        with self._write_txn() as conn:
            rows = conn.execute(
                "SELECT t.attachment_id AS id, a.message_seq AS message_seq "
                "FROM attachment_transcripts AS t JOIN attachments AS a ON a.id = t.attachment_id "
                "WHERE t.status = 'pending'"
            ).fetchall()
            if not rows:
                return 0
            conn.execute(
                "UPDATE attachment_transcripts SET status = 'failed', text = NULL, "
                "failure = 'interrupted', updated_at = ? WHERE status = 'pending'",
                (now,),
            )
            for message_seq in sorted({r["message_seq"] for r in rows if r["message_seq"]}):
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (message_seq, now),
                )
            return len(rows)

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

    def delete_stale_upload_if_unpromoted(self, upload_id: str, *, now: float) -> bool:
        """Delete and journal an upload only if it has not been promoted meanwhile."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "DELETE FROM uploads WHERE id = ? "
                "AND NOT EXISTS (SELECT 1 FROM attachments WHERE id = ?)",
                (upload_id, upload_id),
            )
            if cursor.rowcount != 1:
                return False
            self._queue_deleted_storage(conn, kind="upload", ids=[upload_id], now=now)
            return True

    def prune_completed_deleted_storage(self, *, older_than: float) -> int:
        """Drop old completed tombstones while retaining all active cleanup work."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "DELETE FROM deleted_storage WHERE cleanup_pending = 0 AND deleted_at < ?",
                (older_than,),
            )
            return cursor.rowcount

    def stale_upload_ids(self, *, older_than: float) -> list[str]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT id FROM uploads WHERE created_at < ?", (older_than,)
            ).fetchall()
            return [row["id"] for row in rows]

    def failed_original_archive_candidates(self) -> list[tuple[str, float]]:
        """Failed attachments whose staged original is retained for archive retry."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT a.id, a.updated_at FROM attachments AS a "
                "JOIN uploads AS u ON u.id = a.id "
                "WHERE a.status = 'failed' ORDER BY a.updated_at, a.id"
            ).fetchall()
            return [(str(row["id"]), float(row["updated_at"])) for row in rows]

    def ready_upload_cleanup_candidates(self) -> list[str]:
        """Ready attachments that still retain their raw staged upload files."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT a.id FROM attachments AS a "
                "JOIN uploads AS u ON u.id = a.id "
                "WHERE a.status = 'ready' ORDER BY a.id"
            ).fetchall()
            return [str(row["id"]) for row in rows]

    def expire_failed_original_if_still_unarchived(
        self, att_id: str, *, older_than: float, now: float
    ) -> bool:
        """Drop the staged source only after its seven-day diagnostic window."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "DELETE FROM uploads WHERE id = ? AND EXISTS ("
                "SELECT 1 FROM attachments WHERE id = ? AND status = 'failed' "
                "AND updated_at < ?)",
                (att_id, att_id, older_than),
            )
            if cursor.rowcount != 1:
                return False
            self._queue_deleted_storage(conn, kind="upload", ids=[att_id], now=now)
            return True

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

    # -- device grants (03-permanent-unlock.md §3) -----------------------

    def create_device_grant(
        self,
        *,
        grant_id: str,
        secret_hash: str,
        email: str,
        label: str | None,
        now: float,
        max_live: int,
    ) -> list[str]:
        """Insert one grant, then revoke the identity's OLDEST live grants beyond
        `max_live` — "a sixth creation revokes the oldest". One write transaction, so
        the cap holds even when two devices enroll at once. Returns the revoked ids."""
        with self._write_txn() as conn:
            conn.execute(
                "INSERT INTO device_grants "
                "(id, secret_hash, email, label, created_at, last_used_at, revoked_at) "
                "VALUES (?, ?, ?, ?, ?, ?, NULL)",
                (grant_id, secret_hash, email, label, now, now),
            )
            live = conn.execute(
                "SELECT id FROM device_grants WHERE email = ? AND revoked_at IS NULL "
                "ORDER BY created_at DESC, rowid DESC",
                (email,),
            ).fetchall()
            overflow = [str(row["id"]) for row in live[max_live:]]
            for revoked_id in overflow:
                conn.execute(
                    "UPDATE device_grants SET revoked_at = ? WHERE id = ?", (now, revoked_id)
                )
            return overflow

    def redeem_device_grant(
        self, *, grant_id: str, secret_hash: str, email: str, now: float, max_idle_s: float
    ) -> bool:
        """Check a presented grant and, only if it is valid, stamp `last_used_at`.

        Valid means: the id exists, the hash matches (constant-time), it is not revoked,
        it was used within `max_idle_s`, and it belongs to `email`. Every failure is the
        same `False` — the caller must never learn WHICH check failed. Each check runs
        (no early return) against a fixed dummy hash when the id is unknown, so an
        unknown id and a wrong secret cost the same."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT secret_hash, email, last_used_at, revoked_at FROM device_grants "
                "WHERE id = ?",
                (grant_id,),
            ).fetchone()
            stored_hash = str(row["secret_hash"]) if row is not None else _UNKNOWN_GRANT_HASH
            hash_matches = hmac.compare_digest(
                stored_hash.encode("ascii"), secret_hash.encode("ascii")
            )
            valid = (
                row is not None
                and hash_matches
                and row["revoked_at"] is None
                and row["email"] == email
                and now - float(row["last_used_at"]) <= max_idle_s
            )
            if not valid:
                return False
            conn.execute("UPDATE device_grants SET last_used_at = ? WHERE id = ?", (now, grant_id))
            return True

    def is_device_grant_live(
        self, *, grant_id: str, email: str, now: float, max_idle_s: float
    ) -> bool:
        """Read-only liveness check for a token already bound to `grant_id` (spec §9, Inv 48):
        exists, unrevoked, used within `max_idle_s`, and still belongs to `email`. Unlike
        `redeem_device_grant` this never writes `last_used_at` — it runs on every request a
        bound token makes (and every ~2s on an open stream), and re-stamping activity on a mere
        liveness check would mask an identity mismatch behind a write nobody asked for."""
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT email, last_used_at, revoked_at FROM device_grants WHERE id = ?",
                (grant_id,),
            ).fetchone()
            return (
                row is not None
                and row["revoked_at"] is None
                and row["email"] == email
                and now - float(row["last_used_at"]) <= max_idle_s
            )

    def revoke_device_grant(self, *, grant_id: str, email: str, now: float) -> bool:
        """Revoke one grant, only if it belongs to `email`. True when the grant exists and
        is that identity's — revoking an already-revoked one is a successful no-op, which
        is what makes the DELETE route idempotent. False for an unknown id AND for
        another identity's grant (indistinguishable to the caller)."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT email FROM device_grants WHERE id = ?", (grant_id,)
            ).fetchone()
            if row is None or row["email"] != email:
                return False
            conn.execute(
                "UPDATE device_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                (now, grant_id),
            )
            return True

    def revoke_all_device_grants(
        self, *, email: str, now: float, except_grant_id: str | None = None
    ) -> int:
        """Revoke every live grant for `email` — "Sign out other devices" — except
        `except_grant_id` (spec §9 F4 sub-ruling (ii)): the caller's OWN grant, when its
        session is bound to one, so the button's promise ("other devices") is literally true
        and the caller isn't signed out of the request that clicked it."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE device_grants SET revoked_at = ? "
                "WHERE email = ? AND revoked_at IS NULL AND id IS NOT ?",
                (now, email, except_grant_id),
            )
            return cursor.rowcount

    def revoke_idle_device_grants(self, *, idle_before: float, now: float) -> int:
        """Janitor: revoke every live grant not used since `idle_before`."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE device_grants SET revoked_at = ? "
                "WHERE revoked_at IS NULL AND last_used_at < ?",
                (now, idle_before),
            )
            return cursor.rowcount

    def delete_revoked_device_grants(self, *, revoked_before: float) -> int:
        """Janitor: drop rows revoked before `revoked_before` (secure_delete zeroes them)."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "DELETE FROM device_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?",
                (revoked_before,),
            )
            return cursor.rowcount
