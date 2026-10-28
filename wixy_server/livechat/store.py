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
import secrets
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from wixy_server.livechat.adventure_bank import TOP_DESTINATIONS, AdventureBank
from wixy_server.livechat.drawings import (
    MAX_DRAWINGS_PER_ANCHOR,
    MAX_POINT_X_PAD,
    MAX_STROKES_PER_DRAWING,
)
from wixy_server.livechat.links import text_has_link
from wixy_server.livechat.models import (
    AdventureLanding,
    AdventureRoundRow,
    AdventureSpin,
    AdventureState,
    AdventureSummary,
    AdventureViewData,
    AttachmentKind,
    AttachmentResult,
    AttachmentRow,
    DrawingRow,
    DrawingStrokeRow,
    DrawingSummary,
    EventRow,
    MessageRow,
    PushSubscriptionRow,
    ReactionSummary,
    TranscriptRow,
    UploadRow,
    WyrRoundRow,
    WyrSummary,
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

# Pure rename (decisions/00172): the "Spotlight" view-once mode became "Tease" —
# zero behavior change, only the name. SQLite 3.25+ rewrites the column's own CHECK
# constraint text on RENAME COLUMN, so `CHECK(view_spotlight IN (0, 1))` becomes
# `CHECK(view_tease IN (0, 1))` automatically (verified by
# `test_migrates_v11_database_renames_spotlight_column_to_tease`).
_SCHEMA_V12_RENAME_TEASE_COLUMN = "ALTER TABLE messages RENAME COLUMN view_spotlight TO view_tease"

# `ON DELETE CASCADE` on both tables is load-bearing for the SAME reason as reactions'
# (decisions/00164, `_SCHEMA_V7_REACTIONS` above): an older blue/green-overlap process that
# knows nothing about drawings can still hard-delete a message, and the cascade — not that
# older process — is what removes the drawing and its strokes with it (spec 07 §6). Both FKs
# are index-covered (the reply-to lesson two migrations up: 17.6s vs 0.2s at 20,000 rows) —
# `idx_drawings_anchor` for `drawings.anchor_message_seq`, and `drawing_strokes`'s own primary
# key (which leads with `drawing_id`) for its FK to `drawings.id`.
_SCHEMA_V13_DRAWINGS = """
CREATE TABLE IF NOT EXISTS drawings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  anchor_message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  sender TEXT NOT NULL, device_id TEXT NOT NULL, by_email TEXT,
  column_width REAL NOT NULL CHECK(column_width BETWEEN 200 AND 4000),
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_drawings_anchor ON drawings(anchor_message_seq);
CREATE TABLE IF NOT EXISTS drawing_strokes(
  drawing_id INTEGER NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  stroke_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  color TEXT NOT NULL, width INTEGER NOT NULL,
  points TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY(drawing_id, stroke_id));
"""

# A "canvas" message (the header's ... menu): a text-less, attachment-less message that renders as
# a big blank drawing surface. It exists so the pen (spec 07), whose drawings anchor to a message,
# has reserved space of its own to draw on instead of over other people's words. A flag only —
# the surface's shape is a fixed aspect ratio on the client, so a drawing's uniform scale (spec 07
# §1) stays right at every column width. `DEFAULT 0` keeps every existing row an ordinary message,
# and an older blue/green-overlap process that never names the column still inserts valid rows.
_SCHEMA_V14_CANVAS = (
    "ALTER TABLE messages ADD COLUMN canvas INTEGER NOT NULL DEFAULT 0 CHECK(canvas IN (0, 1))"
)

# The would-you-rather game (workspace 00045). One round per anchor message, exactly two
# player slots. `ON DELETE CASCADE` is load-bearing for the SAME reason as reactions' and
# drawings' (decisions/00164): an older blue/green-overlap process that knows nothing about
# the game can still hard-delete a message, and the cascade — not that older process — is
# what removes the round with it (Inv 46's erasure guarantee). The PRIMARY KEY itself covers
# the FK lookup, so no extra index is needed. There is deliberately NO separate "questions
# played" table: the repeat guard is derived from the rounds that still exist, so deleting a
# round or wiping leaves no dated residue behind (a separate table would survive an older
# process's wipe and per-message deletes). `images` is the picture job's state (the card waits
# only while `pending`); `playerN_email` is the verified sign-in that took the slot.
_SCHEMA_V15_WYR = """
CREATE TABLE IF NOT EXISTS wyr_rounds(
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('voting','answering','revealing','revealed','skipped')),
  images TEXT NOT NULL DEFAULT 'none' CHECK(images IN ('none','pending','done','failed')),
  player1_key TEXT, player1_name TEXT, player1_email TEXT,
  vote1 TEXT CHECK(vote1 IN ('play','skip') OR vote1 IS NULL),
  choice1 TEXT CHECK(choice1 IN ('a','b') OR choice1 IS NULL),
  guess1 TEXT CHECK(guess1 IN ('a','b') OR guess1 IS NULL),
  reveal1 INTEGER NOT NULL DEFAULT 0 CHECK(reveal1 IN (0, 1)),
  player2_key TEXT, player2_name TEXT, player2_email TEXT,
  vote2 TEXT CHECK(vote2 IN ('play','skip') OR vote2 IS NULL),
  choice2 TEXT CHECK(choice2 IN ('a','b') OR choice2 IS NULL),
  guess2 TEXT CHECK(guess2 IN ('a','b') OR guess2 IS NULL),
  reveal2 INTEGER NOT NULL DEFAULT 0 CHECK(reveal2 IN (0, 1)),
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
"""

# The game chat (workspace 00045 follow-on): a message sent from inside a round's game tab is an
# ORDINARY message (it stays in the main chat) plus one row here naming the round it belongs to.
# Table-as-marker, no `messages` column, so no ALTER and no `events` rebuild (the drawings and
# `wyr_rounds` precedent). Both FKs cascade and BOTH are load-bearing for Inv 46's erasure
# guarantee: deleting a message removes its association (an older blue/green-overlap process that
# has never heard of this table still cascades it away), and deleting the round's anchor removes
# the associations while the messages themselves stay in the main chat. No dates are stored.
_SCHEMA_V16_WYR_CHAT = """
CREATE TABLE IF NOT EXISTS wyr_chat(
  message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  anchor_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_wyr_chat_anchor ON wyr_chat(anchor_seq);
"""

_SCHEMA_V17_WYR_REVEAL_DEADLINE = "ALTER TABLE wyr_rounds ADD COLUMN reveal_deadline REAL"
# The "Links" view (workspace 00052): `messages.has_link` is the stored answer to "does this
# message's text contain a web link?" (`links.text_has_link`). It is nullable on purpose — NULL
# means "not indexed yet": a process older than this schema (blue/green overlap) inserts messages
# without setting it, and `index_pending_links` settles those rows before every listing. The
# partial indexes keep both the listing (`= 1`) and the settle pass (`IS NULL`) proportional to
# what they touch, however long the chat grows. Nothing here outlives the message row, so a
# delete or wipe leaves no trace (Inv 46).
_SCHEMA_V18_HAS_LINK_COLUMN = "ALTER TABLE messages ADD COLUMN has_link INTEGER"
_SCHEMA_V18_HAS_LINK_INDEX = """
CREATE INDEX IF NOT EXISTS idx_messages_has_link ON messages(seq) WHERE has_link = 1;
CREATE INDEX IF NOT EXISTS idx_messages_link_pending ON messages(seq) WHERE has_link IS NULL;
"""
_LINK_INDEX_BATCH = 500
# The would-you-rather TOPICS the couple has chosen to play (workspace 00052): one row per chosen
# bank category; NO rows = every topic. It is a shared preference (either player's Next uses it),
# not chat content — it names bank categories only, so nothing here can reveal anything about
# the chat and a wipe leaves it alone (the questions themselves are static repo content).
_SCHEMA_V19_WYR_TOPICS = """
CREATE TABLE IF NOT EXISTS wyr_topics(category TEXT PRIMARY KEY);
"""
# Adventure Time (workspace 00056, spec/server-chat/08-adventure-time.md §4.1). `adv_rounds` follows
# `wyr_rounds` exactly (Inv 54's pattern): keyed by its anchor message, `ON DELETE CASCADE` so an
# older blue/green-overlap process that has never heard of the table still erases a round with its
# message, and an explicit `DELETE` in wipe. The spin/landing/pack columns hold JSON text exactly as
# the model sent/produced it ({by, from, delta, durationMs, at} per spin). `adv_rejected` is the
# NEVER-AGAIN LIST: destination ids only, no dates, no FK, so it survives deleting the round's
# message (that is what "never appears again" means) while a wipe clears it. Banked destinations are
# derived from `adv_rounds.state = 'banked'` — no second table, so deleting a trip's message removes
# it from the bank. The game chat reuses `wyr_chat` (a generic message -> anchor association).
_SCHEMA_V20_ADVENTURE = """
CREATE TABLE IF NOT EXISTS adv_rounds(
  anchor_message_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('spin_lng','spin_lat','country','destination','chosen',
                                      'banked','rejected','abandoned')),
  started_by TEXT NOT NULL,
  spin_lng TEXT, spin_lat TEXT,
  landing TEXT,
  country_candidates TEXT, country_seed INTEGER, country_roulette_at REAL,
  country_id TEXT, country_by TEXT,
  dest_candidates TEXT, dest_seed INTEGER, dest_roulette_at REAL,
  destination_id TEXT, destination_by TEXT,
  pack TEXT NOT NULL DEFAULT 'none'
    CHECK(pack IN ('none','pending','ready','failed','unavailable')),
  pack_run_id TEXT, pack_json TEXT, pack_error TEXT,
  images TEXT NOT NULL DEFAULT 'none' CHECK(images IN ('none','pending','done','failed')),
  pictures TEXT, images_started_at REAL, images_tries INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_adv_rounds_state ON adv_rounds(state);
CREATE TABLE IF NOT EXISTS adv_rejected(destination_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS adv_settings(
  id INTEGER PRIMARY KEY CHECK(id = 1),
  include_advised INTEGER NOT NULL DEFAULT 0 CHECK(include_advised IN (0, 1)));
"""
# `adv_settings` is the game's SHARED PREFERENCE (operator decision #2113): one row, no row =
# defaults (`include_advised` off: places under a whole-country UK "advise against all travel" are
# left out of the draw until the pair switch them back in). Like `wyr_topics` it names no place and
# no person, so a wipe leaves it alone.
#
# The holiday pack's PICTURES (spec §4.3a) live on the same row: `images` is the picture job's state
# (the `wyr_rounds.images` precedent) and `pictures` maps each picture slot to the ordinal of its
# ordinary photo attachment on the anchor message, with its credit, source page and caption.
# `images_started_at` / `images_tries` make a `pending` wait SELF-HEALING (audit round 3, F4): the
# time the current hunt attempt began and how many have begun. A hunt that dies without finishing
# (a blue/green hand-off stops the old process mid-hunt) leaves the round `pending`; a supervised
# sweep re-claims any round pending longer than a hunt can take (compare-and-set on
# `images_started_at`), and after `MAX_PICTURE_TRIES` attempts gives up (`failed`), so the wait can
# never be stuck. The v20 DDL above was amended IN PLACE to carry them (v20 was never deployed);
# `_ensure_adventure_picture_columns` adds whichever are missing to a database that ran an earlier
# v20 text (a developer's), so no version bump is needed.
_ADVENTURE_PICTURE_COLUMNS = {
    "images": (
        "ALTER TABLE adv_rounds ADD COLUMN images TEXT NOT NULL DEFAULT 'none' "
        "CHECK(images IN ('none','pending','done','failed'))"
    ),
    "pictures": "ALTER TABLE adv_rounds ADD COLUMN pictures TEXT",
    "images_started_at": "ALTER TABLE adv_rounds ADD COLUMN images_started_at REAL",
    "images_tries": "ALTER TABLE adv_rounds ADD COLUMN images_tries INTEGER NOT NULL DEFAULT 0",
}
MAX_PICTURE_TRIES = 3
"""How many times a round's picture hunt may begin (the first, then re-claims after a hunt died)
before the wait is ended as `failed`."""
_LATEST_SCHEMA_VERSION = 20
WYR_REVEAL_WINDOW_S = 30.0
ADVENTURE_ROULETTE_SETTLE_S = 5.0
"""Spec §3.4: the country roulette starts this long after the second spin stops (glide + zoom)."""
ADVENTURE_DESTINATION_SETTLE_S = 3.5
"""Spec §3.4: the destination roulette starts this long after the country stop (settle + zoom)."""
ADVENTURE_STOP_TOLERANCE_S = 1.0
"""A stop up to this much before `rouletteAt` is still accepted (clock-sync slack, spec §3.4)."""
ADVENTURE_PACK_FAILED_TEXT = "The research didn't finish — try again"
ADVENTURE_PACK_UNAVAILABLE_TEXT = "Holiday packs aren't available right now"
ADVENTURE_PACK_STOPPED_TEXT = "The research was stopped"
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


class DrawingAnchorNotFoundError(LiveChatStoreError):
    """`POST /drawings` named an `anchorSeq` that does not exist (never did, or was
    hard-deleted between the client loading it and posting). `routes_livechat.py` maps
    this to 404 — spec 07 §4: "An unknown or deleted anchorSeq → 404 (map the FK
    error; never 500)."."""

    def __init__(self, anchor_seq: int) -> None:
        super().__init__(f"message {anchor_seq} does not exist")
        self.anchor_seq = anchor_seq


class DrawingNotFoundError(LiveChatStoreError):
    """The drawing a request targets does not exist (never did, or was deleted — by
    either person, or cascaded away with its anchor message). `routes_livechat.py`
    maps this to 404."""

    def __init__(self, drawing_id: int) -> None:
        super().__init__(f"drawing {drawing_id} does not exist")
        self.drawing_id = drawing_id


class DrawingLimitExceededError(LiveChatStoreError):
    """spec 07 §3: "at most 200 strokes per drawing and 20 drawings per anchor message,
    else 409 full." `routes_livechat.py` maps this to 409 {"error": "full"}."""


class DrawingPointsOutOfBoundsError(LiveChatStoreError):
    """An appended stroke has a point whose x lies beyond THIS drawing's own stored
    `column_width` (+ the 50 px pad) — spec 07 §3's bound, which only the store can apply on
    append, because that route's body carries no columnWidth. `routes_livechat.py` maps this
    to 422 `invalid`. Carries no point value: it is chat content (Inv 53)."""


class WyrRoundNotFoundError(LiveChatStoreError):
    """The game round a request targets does not exist (never did, or cascaded away with its
    anchor message). `routes_livechat.py` maps this to 404. Despite the name it covers EVERY game
    anchor: `create_message(wyr_anchor_seq=)` accepts a would-you-rather round OR an Adventure Time
    round and raises this one error type when it is neither (the wire names `wyrSeq`/`wyrRef` are
    historical — they mean "the game-chat anchor of any game")."""

    def __init__(self, anchor_seq: int) -> None:
        super().__init__(f"no game round on message {anchor_seq}")
        self.anchor_seq = anchor_seq


class AdventureRoundNotFoundError(LiveChatStoreError):
    """The Adventure Time round a request targets does not exist (never did, or cascaded away with
    its anchor message). `routes_livechat_adventure.py` maps this to 404 `not_found`."""

    def __init__(self, anchor_seq: int) -> None:
        super().__init__(f"no Adventure Time round on message {anchor_seq}")
        self.anchor_seq = anchor_seq


class AdventureBadStateError(LiveChatStoreError):
    """The round is not in the state this move needs, or a DIFFERENT move was already made
    (replaying the SAME move is an idempotent success instead). Mapped to 409 `bad_state`."""


class AdventureTooEarlyError(LiveChatStoreError):
    """A roulette Stop arrived before the roulette started (more than the 1 s clock-sync
    tolerance early). Mapped to 409 `too_early`."""


class AdventureExhaustedError(LiveChatStoreError):
    """The chosen country has no destination left in play (all rejected or banked). Mapped to
    409 `exhausted`; the round stays in `country` so the roulette can be stopped on another."""


class AdventureInvalidError(LiveChatStoreError):
    """The move is well formed but names something the round does not offer (a roulette choice
    outside its candidates). Mapped to 422 `invalid`."""


class WyrRoundFullError(LiveChatStoreError):
    """A third identity tried to vote on a round whose two player slots are taken.
    `routes_livechat.py` maps this to 409 {"error": "full"}."""


class WyrBadStateError(LiveChatStoreError):
    """The round is not in the state this mutation needs (e.g. answering while still
    voting, revealing before both answered, voting on a skipped round).
    `routes_livechat.py` maps this to 409 {"error": "bad_state"}. Carries the current
    state only — never answers."""


class WyrNotPlayerError(LiveChatStoreError):
    """An identity with no player slot tried to answer or reveal. `routes_livechat.py`
    maps this to 409 {"error": "not_player"}."""


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
    vo_raw = row["view_once_renditions"]
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
    drawings: tuple[DrawingSummary, ...] = (),
    *,
    reply_to: MessageRow | None = None,
    wyr: WyrSummary | None = None,
    wyr_ref: tuple[int, Literal["wyr", "adventure"]] | None = None,
    adventure: AdventureSummary | None = None,
) -> MessageRow:
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
        drawings=drawings,
        reply_to_seq=row["reply_to_seq"],
        reply_to=reply_to,
        view_once_s=row["view_once_s"],
        view_tease=row["view_tease"],
        view_claim_id=row["view_claim_id"],
        view_claimed_at=row["view_claimed_at"],
        view_claim_email=row["view_claim_email"],
        canvas=row["canvas"],
        wyr=wyr,
        wyr_ref=wyr_ref[0] if wyr_ref is not None else None,
        wyr_ref_kind=wyr_ref[1] if wyr_ref is not None else None,
        adventure=adventure,
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


def _row_to_drawing_stroke(row: sqlite3.Row) -> DrawingStrokeRow:
    points_raw = json.loads(row["points"])
    return DrawingStrokeRow(
        stroke_id=row["stroke_id"],
        ord=row["ord"],
        color=row["color"],
        width=row["width"],
        points=tuple((int(point[0]), int(point[1])) for point in points_raw),
        created_at=row["created_at"],
    )


def _row_to_drawing(row: sqlite3.Row, strokes: tuple[DrawingStrokeRow, ...] = ()) -> DrawingRow:
    return DrawingRow(
        id=row["id"],
        client_id=row["client_id"],
        anchor_message_seq=row["anchor_message_seq"],
        sender=row["sender"],
        device_id=row["device_id"],
        by_email=row["by_email"],
        column_width=row["column_width"],
        rev=row["rev"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        strokes=strokes,
    )


def _load_strokes_for(
    conn: sqlite3.Connection, drawing_ids: Sequence[int]
) -> dict[int, tuple[DrawingStrokeRow, ...]]:
    by_drawing: dict[int, list[DrawingStrokeRow]] = {did: [] for did in drawing_ids}
    if not drawing_ids:
        return {}
    placeholders = ",".join("?" for _ in drawing_ids)
    rows = conn.execute(
        f"SELECT * FROM drawing_strokes WHERE drawing_id IN ({placeholders}) "
        "ORDER BY drawing_id, ord",
        tuple(drawing_ids),
    ).fetchall()
    for row in rows:
        by_drawing[row["drawing_id"]].append(_row_to_drawing_stroke(row))
    return {did: tuple(strokes) for did, strokes in by_drawing.items()}


def _load_drawing_summaries_for(
    conn: sqlite3.Connection, message_seqs: Sequence[int]
) -> dict[int, tuple[DrawingSummary, ...]]:
    """Drawing summaries per anchor message, oldest first — the `Message` wire shape's
    `drawings: [{id, rev}]` (spec/server-chat/07-live-drawing.md §4)."""
    if not message_seqs:
        return {}
    by_message: dict[int, list[DrawingSummary]] = {seq: [] for seq in message_seqs}
    placeholders = ",".join("?" for _ in message_seqs)
    rows = conn.execute(
        "SELECT id, anchor_message_seq, rev FROM drawings "
        f"WHERE anchor_message_seq IN ({placeholders}) ORDER BY id",
        tuple(message_seqs),
    ).fetchall()
    for row in rows:
        by_message[row["anchor_message_seq"]].append(DrawingSummary(id=row["id"], rev=row["rev"]))
    return {seq: tuple(summaries) for seq, summaries in by_message.items()}


def _row_to_wyr_round(row: sqlite3.Row) -> WyrRoundRow:
    return WyrRoundRow(
        anchor_message_seq=row["anchor_message_seq"],
        question_id=row["question_id"],
        state=row["state"],
        images=row["images"],
        player1_key=row["player1_key"],
        player1_name=row["player1_name"],
        player1_email=row["player1_email"],
        vote1=row["vote1"],
        choice1=row["choice1"],
        guess1=row["guess1"],
        reveal1=bool(row["reveal1"]),
        reveal_deadline=row["reveal_deadline"],
        player2_key=row["player2_key"],
        player2_name=row["player2_name"],
        player2_email=row["player2_email"],
        vote2=row["vote2"],
        choice2=row["choice2"],
        guess2=row["guess2"],
        reveal2=bool(row["reveal2"]),
        rev=row["rev"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _load_wyr_summaries_for(
    conn: sqlite3.Connection, message_seqs: Sequence[int]
) -> dict[int, WyrSummary]:
    """Round summary per anchor message — the `Message` wire shape's `wyr` member
    (the `_load_drawing_summaries_for` precedent). At most one round per message
    (`wyr_rounds`'s PRIMARY KEY is the anchor seq)."""
    if not message_seqs:
        return {}
    placeholders = ",".join("?" for _ in message_seqs)
    rows = conn.execute(
        "SELECT anchor_message_seq, state, rev FROM wyr_rounds "
        f"WHERE anchor_message_seq IN ({placeholders})",
        tuple(message_seqs),
    ).fetchall()
    return {
        row["anchor_message_seq"]: WyrSummary(state=row["state"], rev=row["rev"]) for row in rows
    }


def _spin_from_json(text: str | None) -> AdventureSpin | None:
    if text is None:
        return None
    data = json.loads(text)
    return AdventureSpin(
        by=data["by"],
        from_deg=data["from"],
        delta_deg=data["delta"],
        duration_ms=data["durationMs"],
        at=data["at"],
    )


def _landing_from_json(text: str | None) -> AdventureLanding | None:
    if text is None:
        return None
    data = json.loads(text)
    return AdventureLanding(
        point=(data["point"][0], data["point"][1]),
        sea=bool(data["sea"]),
        land=(data["land"][0], data["land"][1]),
        centre=(data["centre"][0], data["centre"][1]),
        land_unit=data["landUnit"],
    )


def _ids_from_json(text: str | None) -> tuple[str, ...] | None:
    if text is None:
        return None
    return tuple(str(item) for item in json.loads(text))


def _row_to_adv_round(row: sqlite3.Row) -> AdventureRoundRow:
    return AdventureRoundRow(
        anchor_message_seq=row["anchor_message_seq"],
        state=row["state"],
        started_by=row["started_by"],
        spin_lng=_spin_from_json(row["spin_lng"]),
        spin_lat=_spin_from_json(row["spin_lat"]),
        landing=_landing_from_json(row["landing"]),
        country_candidates=_ids_from_json(row["country_candidates"]),
        country_seed=row["country_seed"],
        country_roulette_at=row["country_roulette_at"],
        country_id=row["country_id"],
        country_by=row["country_by"],
        dest_candidates=_ids_from_json(row["dest_candidates"]),
        dest_seed=row["dest_seed"],
        dest_roulette_at=row["dest_roulette_at"],
        destination_id=row["destination_id"],
        destination_by=row["destination_by"],
        pack=row["pack"],
        pack_run_id=row["pack_run_id"],
        pack_json=row["pack_json"],
        pack_error=row["pack_error"],
        images=row["images"],
        pictures_json=row["pictures"],
        images_started_at=row["images_started_at"],
        images_tries=row["images_tries"],
        decided_by=row["decided_by"],
        rev=row["rev"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _load_adventure_summaries_for(
    conn: sqlite3.Connection, message_seqs: Sequence[int]
) -> dict[int, AdventureSummary]:
    """Round summary per anchor message — the `Message` wire shape's `adventure` member (the
    `_load_wyr_summaries_for` precedent). At most one round per message."""
    if not message_seqs:
        return {}
    placeholders = ",".join("?" for _ in message_seqs)
    rows = conn.execute(
        "SELECT anchor_message_seq, state, pack, rev FROM adv_rounds "
        f"WHERE anchor_message_seq IN ({placeholders})",
        tuple(message_seqs),
    ).fetchall()
    return {
        row["anchor_message_seq"]: AdventureSummary(
            state=row["state"], pack=row["pack"], rev=row["rev"]
        )
        for row in rows
    }


def _load_wyr_refs_for(
    conn: sqlite3.Connection, message_seqs: Sequence[int]
) -> dict[int, tuple[int, Literal["wyr", "adventure"]]]:
    """The game round (anchor seq) each message was sent in the game chat of, and which game it is
    — the `Message` wire shape's `wyrRef` and `wyrRefKind`. Absent for an ordinary message. The kind
    is resolved here, in the same query, because a client paging history may not have the anchor
    message loaded: an anchor present in `adv_rounds` is `adventure`, any other is `wyr`."""
    if not message_seqs:
        return {}
    placeholders = ",".join("?" for _ in message_seqs)
    rows = conn.execute(
        "SELECT c.message_seq, c.anchor_seq, "
        "EXISTS (SELECT 1 FROM adv_rounds a WHERE a.anchor_message_seq = c.anchor_seq) AS is_adv "
        f"FROM wyr_chat c WHERE c.message_seq IN ({placeholders})",
        tuple(message_seqs),
    ).fetchall()
    return {
        int(row["message_seq"]): (
            int(row["anchor_seq"]),
            "adventure" if row["is_adv"] else "wyr",
        )
        for row in rows
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
    drawings = _load_drawing_summaries_for(conn, [seq])[seq]
    wyr = _load_wyr_summaries_for(conn, [seq]).get(seq)
    wyr_ref = _load_wyr_refs_for(conn, [seq]).get(seq)
    adventure = _load_adventure_summaries_for(conn, [seq]).get(seq)
    reply_to_seq = row["reply_to_seq"]
    reply_targets = _load_reply_targets(conn, [reply_to_seq])
    reply_to = reply_targets.get(reply_to_seq) if reply_to_seq is not None else None
    return _row_to_message(
        row,
        tuple(attachments),
        reactions,
        drawings,
        reply_to=reply_to,
        wyr=wyr,
        wyr_ref=wyr_ref,
        adventure=adventure,
    )


def _hydrate_messages(
    conn: sqlite3.Connection, ascending_rows: list[sqlite3.Row]
) -> list[MessageRow]:
    """Message rows (already ascending by seq) -> full `MessageRow`s with their attachments,
    reactions, drawings, game summaries and quoted reply targets."""
    seqs = [row["seq"] for row in ascending_rows]
    attachments_by_seq = _load_attachments_for(conn, seqs)
    reactions_by_seq = _load_reactions_for(conn, seqs)
    drawings_by_seq = _load_drawing_summaries_for(conn, seqs)
    wyr_by_seq = _load_wyr_summaries_for(conn, seqs)
    wyr_ref_by_seq = _load_wyr_refs_for(conn, seqs)
    adventure_by_seq = _load_adventure_summaries_for(conn, seqs)
    # §(2): targets are resolved by seq, including ones OUTSIDE this page — a reply near the top
    # of a page may quote a message that paged off already.
    reply_targets = _load_reply_targets(conn, [row["reply_to_seq"] for row in ascending_rows])
    return [
        _row_to_message(
            row,
            tuple(attachments_by_seq[row["seq"]]),
            reactions_by_seq[row["seq"]],
            drawings_by_seq[row["seq"]],
            reply_to=reply_targets.get(row["reply_to_seq"]),
            wyr=wyr_by_seq.get(row["seq"]),
            wyr_ref=wyr_ref_by_seq.get(row["seq"]),
            adventure=adventure_by_seq.get(row["seq"]),
        )
        for row in ascending_rows
    ]


def _load_drawing(conn: sqlite3.Connection, drawing_id: int) -> DrawingRow:
    row = conn.execute("SELECT * FROM drawings WHERE id = ?", (drawing_id,)).fetchone()
    if row is None:
        raise DrawingNotFoundError(drawing_id)
    strokes = _load_strokes_for(conn, [drawing_id])[drawing_id]
    return _row_to_drawing(row, strokes)


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
            self._ensure_adventure_picture_columns(conn)
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

            if current < 12:
                existing_msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
                if "view_spotlight" in existing_msg_cols and "view_tease" not in existing_msg_cols:
                    conn.execute(_SCHEMA_V12_RENAME_TEASE_COLUMN)
                conn.execute("PRAGMA user_version = 12")
                current = 12

            if current < 13:
                for statement in _SCHEMA_V13_DRAWINGS.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 13")
                current = 13

            if current < 14:
                existing_msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
                if existing_msg_cols and "canvas" not in existing_msg_cols:
                    conn.execute(_SCHEMA_V14_CANVAS)
                conn.execute("PRAGMA user_version = 14")
                current = 14

            if current < 15:
                for statement in _SCHEMA_V15_WYR.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 15")
                current = 15

            if current < 16:
                for statement in _SCHEMA_V16_WYR_CHAT.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 16")
                current = 16

            if current < 17:
                existing_wyr_cols = {
                    row[1] for row in conn.execute("PRAGMA table_info(wyr_rounds)")
                }
                if existing_wyr_cols and "reveal_deadline" not in existing_wyr_cols:
                    conn.execute(_SCHEMA_V17_WYR_REVEAL_DEADLINE)
                conn.execute("PRAGMA user_version = 17")
                current = 17

            if current < 18:
                existing_msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
                if existing_msg_cols:
                    if "has_link" not in existing_msg_cols:
                        conn.execute(_SCHEMA_V18_HAS_LINK_COLUMN)
                    for statement in _SCHEMA_V18_HAS_LINK_INDEX.split(";"):
                        if statement.strip():
                            conn.execute(statement)
                    # The one-off backfill: settle every existing message.
                    self._index_pending_links(conn)
                conn.execute("PRAGMA user_version = 18")
                current = 18

            if current < 19:
                for statement in _SCHEMA_V19_WYR_TOPICS.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 19")
                current = 19

            if current < 20:
                for statement in _SCHEMA_V20_ADVENTURE.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("PRAGMA user_version = 20")
                current = 20
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        self._ensure_attachment_transcripts_table(conn)
        self._ensure_adventure_picture_columns(conn)

    @staticmethod
    def _ensure_adventure_picture_columns(conn: sqlite3.Connection) -> None:
        """Independent of `PRAGMA user_version`: a database that ran the first text of schema v20
        (before the holiday-pack pictures existed) has `adv_rounds` without `images`/`pictures`.
        Settled here, once, for such a database; a plain column read otherwise (the
        `_ensure_attachment_transcripts_table` precedent)."""
        columns = {row[1] for row in conn.execute("PRAGMA table_info(adv_rounds)")}
        if not columns or _ADVENTURE_PICTURE_COLUMNS.keys() <= columns:
            return
        conn.execute("BEGIN IMMEDIATE")
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(adv_rounds)")}
            for column, statement in _ADVENTURE_PICTURE_COLUMNS.items():
                if column not in columns:
                    conn.execute(statement)
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

    @staticmethod
    def _index_pending_links(conn: sqlite3.Connection) -> int:
        """Settle `has_link` for every message that has none yet (NULL), in bounded batches.
        Returns how many rows were settled. Runs inside the caller's write transaction."""
        settled = 0
        while True:
            rows = conn.execute(
                "SELECT seq, text FROM messages WHERE has_link IS NULL ORDER BY seq LIMIT ?",
                (_LINK_INDEX_BATCH,),
            ).fetchall()
            if not rows:
                return settled
            conn.executemany(
                "UPDATE messages SET has_link = ? WHERE seq = ?",
                [(1 if text_has_link(row["text"]) else 0, row["seq"]) for row in rows],
            )
            settled += len(rows)

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
        wyr_anchor_seq: int | None = None,
        now: float,
    ) -> tuple[MessageRow, bool]:
        """Create an ordinary message. `wyr_anchor_seq` marks it as sent in a game's chat — the
        anchor of a would-you-rather round OR an Adventure Time round: the round must exist
        (`WyrRoundNotFoundError` otherwise, checked in this same transaction so a concurrent delete
        cannot slip between check and insert) and the association row is written in the same
        transaction as the message."""
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False

            if wyr_anchor_seq is not None and (
                conn.execute(
                    "SELECT 1 FROM wyr_rounds WHERE anchor_message_seq = ? "
                    "UNION ALL SELECT 1 FROM adv_rounds WHERE anchor_message_seq = ?",
                    (wyr_anchor_seq, wyr_anchor_seq),
                ).fetchone()
                is None
            ):
                raise WyrRoundNotFoundError(wyr_anchor_seq)

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
                "(client_id, sender, device_id, by_email, text, created_at, reply_to_seq, "
                "has_link) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    client_id,
                    sender,
                    device_id,
                    by_email,
                    text,
                    now,
                    stored_reply_to_seq,
                    1 if text_has_link(text) else 0,
                ),
            )
            seq = cursor.lastrowid
            assert seq is not None
            for ordinal, att_id in enumerate(attachment_ids):
                conn.execute(
                    "UPDATE attachments SET message_seq = ?, ordinal = ? WHERE id = ?",
                    (seq, ordinal, att_id),
                )
            if wyr_anchor_seq is not None:
                conn.execute(
                    "INSERT INTO wyr_chat (message_seq, anchor_seq) VALUES (?, ?)",
                    (seq, wyr_anchor_seq),
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
        tease: bool,
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
                or (tease and candidate["kind"] != "photo")
                or candidate["status"] not in ("processing", "ready")
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
            view_tease = 1 if tease else 0

            cursor = conn.execute(
                "INSERT INTO messages "
                "(client_id, sender, device_id, by_email, text, created_at, "
                "reply_to_seq, view_once_s, view_tease) "
                "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
                (
                    client_id,
                    sender,
                    device_id,
                    by_email,
                    now,
                    stored_reply_to_seq,
                    stored_duration_s,
                    view_tease,
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

    def create_canvas_message(
        self,
        *,
        client_id: str,
        sender: str,
        device_id: str,
        by_email: str | None,
        now: float,
    ) -> tuple[MessageRow, bool]:
        """Creates a canvas message: no text, no attachments, `canvas = 1`. Idempotent on
        `client_id` like every other send."""
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False
            cursor = conn.execute(
                "INSERT INTO messages "
                "(client_id, sender, device_id, by_email, text, created_at, canvas) "
                "VALUES (?, ?, ?, ?, NULL, ?, 1)",
                (client_id, sender, device_id, by_email, now),
            )
            seq = cursor.lastrowid
            assert seq is not None
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
                is_own = reactor_key(sender) == reactor_key(msg_sender)
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
            messages = _hydrate_messages(conn, list(reversed(rows[:limit])))
            cursor_row = conn.execute("SELECT MAX(event_seq) AS m FROM events").fetchone()
            cursor = cursor_row["m"] if cursor_row["m"] is not None else 0
            return messages, has_more, cursor

    def index_pending_links(self) -> int:
        """Settle `has_link` for messages inserted without it (a process older than schema 18
        during a blue/green overlap). Cheap when there is nothing to do: one probe of the
        `has_link IS NULL` partial index, no write transaction."""
        with self._read_txn() as conn:
            pending = conn.execute(
                "SELECT 1 FROM messages WHERE has_link IS NULL LIMIT 1"
            ).fetchone()
        if pending is None:
            return 0
        with self._write_txn() as conn:
            return self._index_pending_links(conn)

    def list_link_messages(
        self, *, before: int | None, limit: int
    ) -> tuple[list[MessageRow], bool]:
        """The "Links" view's page: the messages whose text contains a web link, NEWEST page
        first (`before` is the lowest seq of the page already held), each page ascending like
        history. Returns `(messages, has_more)`."""
        self.index_pending_links()
        with self._read_txn() as conn:
            if before is None:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE has_link = 1 ORDER BY seq DESC LIMIT ?",
                    (limit + 1,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE has_link = 1 AND seq < ? "
                    "ORDER BY seq DESC LIMIT ?",
                    (before, limit + 1),
                ).fetchall()
            has_more = len(rows) > limit
            return _hydrate_messages(conn, list(reversed(rows[:limit]))), has_more

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
            drawings_by_seq = _load_drawing_summaries_for(conn, list(by_seq.keys()))
            wyr_by_seq = _load_wyr_summaries_for(conn, list(by_seq.keys()))
            wyr_ref_by_seq = _load_wyr_refs_for(conn, list(by_seq.keys()))
            adventure_by_seq = _load_adventure_summaries_for(conn, list(by_seq.keys()))
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
                        drawings_by_seq[seq],
                        reply_to=reply_targets.get(row["reply_to_seq"]),
                        wyr=wyr_by_seq.get(seq),
                        wyr_ref=wyr_ref_by_seq.get(seq),
                        adventure=adventure_by_seq.get(seq),
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

    def create_drawing(
        self,
        *,
        client_id: str,
        anchor_seq: int,
        column_width: float,
        sender: str,
        device_id: str,
        by_email: str | None,
        stroke_id: str,
        color: str,
        width: int,
        points: Sequence[tuple[int, int]],
        now: float,
    ) -> tuple[DrawingRow, bool]:
        """Creates a drawing with its first stroke (spec/server-chat/07-live-drawing.md
        §3/§4). `client_id` is the idempotency key, exactly like `create_message`'s own
        `clientId`: a repeat returns the existing drawing unchanged, never a second row."""
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT id FROM drawings WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_drawing(conn, existing["id"]), False

            if (
                conn.execute("SELECT 1 FROM messages WHERE seq = ?", (anchor_seq,)).fetchone()
                is None
            ):
                raise DrawingAnchorNotFoundError(anchor_seq)

            count = conn.execute(
                "SELECT COUNT(*) AS n FROM drawings WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()["n"]
            if count >= MAX_DRAWINGS_PER_ANCHOR:
                raise DrawingLimitExceededError(
                    f"anchor message {anchor_seq} already has {MAX_DRAWINGS_PER_ANCHOR} drawings"
                )

            try:
                cursor = conn.execute(
                    "INSERT INTO drawings (client_id, anchor_message_seq, sender, device_id, "
                    "by_email, column_width, rev, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    (client_id, anchor_seq, sender, device_id, by_email, column_width, now, now),
                )
            except sqlite3.IntegrityError as exc:
                # The anchor was checked above under this write lock, so a FOREIGN KEY
                # failure here is only a backstop: one that vanished mid-transaction is
                # "not found", never a 500 (same shape as set_reaction's own IntegrityError
                # backstop). A CHECK failure (column_width out of range) is a different,
                # genuine caller bug — the route layer already validates this before
                # calling in, so this only fires for a caller that skipped that gate, and
                # must never be misreported as "anchor not found".
                if "FOREIGN KEY" not in str(exc):
                    raise
                raise DrawingAnchorNotFoundError(anchor_seq) from exc
            drawing_id = cursor.lastrowid
            assert drawing_id is not None
            conn.execute(
                "INSERT INTO drawing_strokes "
                "(drawing_id, stroke_id, ord, color, width, points, created_at) "
                "VALUES (?, ?, 0, ?, ?, ?, ?)",
                (drawing_id, stroke_id, color, width, json.dumps([list(p) for p in points]), now),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            return _load_drawing(conn, drawing_id), True

    def append_stroke(
        self,
        *,
        drawing_id: int,
        stroke_id: str,
        color: str,
        width: int,
        points: Sequence[tuple[int, int]],
        now: float,
    ) -> DrawingRow:
        """Appends one stroke to an existing drawing. `stroke_id` is the idempotency key:
        a repeat is a no-op that changes nothing and appends no event (spec §4: "A
        repeated strokeId is a no-op 200"), exactly `set_reaction`'s "only a real change
        appends the event" rule."""
        with self._write_txn() as conn:
            drawing_row = conn.execute(
                "SELECT anchor_message_seq, rev, column_width FROM drawings WHERE id = ?",
                (drawing_id,),
            ).fetchone()
            if drawing_row is None:
                raise DrawingNotFoundError(drawing_id)

            if (
                conn.execute(
                    "SELECT 1 FROM drawing_strokes WHERE drawing_id = ? AND stroke_id = ?",
                    (drawing_id, stroke_id),
                ).fetchone()
                is not None
            ):
                return _load_drawing(conn, drawing_id)

            # spec 07 §3: x is bounded by the drawing's OWN column width (audit F7). The
            # route can only apply the global maximum; the stored width is available here,
            # inside the same transaction, with no wire change.
            x_upper_bound = float(drawing_row["column_width"]) + MAX_POINT_X_PAD
            if any(x > x_upper_bound for x, _y in points):
                raise DrawingPointsOutOfBoundsError(
                    f"a point's x is beyond drawing {drawing_id}'s column width"
                )

            stroke_count = conn.execute(
                "SELECT COUNT(*) AS n FROM drawing_strokes WHERE drawing_id = ?", (drawing_id,)
            ).fetchone()["n"]
            if stroke_count >= MAX_STROKES_PER_DRAWING:
                raise DrawingLimitExceededError(
                    f"drawing {drawing_id} already has {MAX_STROKES_PER_DRAWING} strokes"
                )

            try:
                conn.execute(
                    "INSERT INTO drawing_strokes "
                    "(drawing_id, stroke_id, ord, color, width, points, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        drawing_id,
                        stroke_id,
                        stroke_count,
                        color,
                        width,
                        json.dumps([list(p) for p in points]),
                        now,
                    ),
                )
            except sqlite3.IntegrityError:
                # A racing duplicate append for the same stroke_id (two retries in
                # flight): the (drawing_id, stroke_id) primary key rejects the second;
                # treat it the same as the idempotent no-op checked above.
                return _load_drawing(conn, drawing_id)

            conn.execute(
                "UPDATE drawings SET rev = rev + 1, updated_at = ? WHERE id = ?",
                (now, drawing_id),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (drawing_row["anchor_message_seq"], now),
            )
            return _load_drawing(conn, drawing_id)

    def delete_drawing(self, *, drawing_id: int, now: float) -> bool:
        """Either person may delete any drawing (Inv 46's "Delete for everyone" pattern,
        spec §4). Idempotent: deleting an already-gone drawing is a no-op that returns
        `False` and appends no event. Store-level only: the route uses
        `delete_drawing_for_scrub`, because a delete that is not followed by a WAL scrub
        leaves the strokes' bytes on disk (spec §6, Inv 53)."""
        existed, _ = self._delete_drawing(drawing_id=drawing_id, now=now, mark_scrub_pending=False)
        return existed

    def delete_drawing_for_scrub(self, *, drawing_id: int, now: float) -> tuple[bool, str | None]:
        """`delete_drawing` that, in the SAME transaction as the delete, records that a
        WAL scrub is owed (`delete_message_for_scrub`'s pattern), so a crash between the
        commit and the scrub is finished by the background scrubber instead of leaving a
        deleted drawing's points in `server.db-wal`. Returns `(existed, pending_token)`;
        nothing was erased, so nothing is owed, when the drawing was already gone."""
        return self._delete_drawing(drawing_id=drawing_id, now=now, mark_scrub_pending=True)

    def _delete_drawing(
        self, *, drawing_id: int, now: float, mark_scrub_pending: bool
    ) -> tuple[bool, str | None]:
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT anchor_message_seq FROM drawings WHERE id = ?", (drawing_id,)
            ).fetchone()
            if row is None:
                return False, None
            anchor_seq = row["anchor_message_seq"]
            conn.execute("DELETE FROM drawing_strokes WHERE drawing_id = ?", (drawing_id,))
            conn.execute("DELETE FROM drawings WHERE id = ?", (drawing_id,))
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            pending_token = self._upsert_pending_scrub(conn) if mark_scrub_pending else None
            return True, pending_token

    def get_drawings_for_message(self, *, seq: int) -> list[DrawingRow]:
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT * FROM drawings WHERE anchor_message_seq = ? ORDER BY id", (seq,)
            ).fetchall()
            strokes_by_drawing = _load_strokes_for(conn, [row["id"] for row in rows])
            return [_row_to_drawing(row, strokes_by_drawing[row["id"]]) for row in rows]

    # -- would-you-rather game (schema v15, workspace 00045) ----------------------

    def create_wyr_round(
        self,
        *,
        client_id: str,
        sender: str,
        device_id: str,
        by_email: str | None,
        question_id: str,
        images_pending: bool,
        now: float,
    ) -> tuple[MessageRow, bool]:
        """Create a round: anchor message (no text/attachments) + `wyr_rounds` row in
        `voting`, with the creator slotted as player 1 already voting `play` (starting
        the round IS their play vote). Any still-open round is superseded to `skipped`
        in the same transaction (one live round at a time). Idempotent on `client_id`
        like every other send. `images_pending` marks a round whose pictures are about
        to be painted (the card waits for them; `finish_wyr_images` ends the wait)."""
        key = reactor_key(sender)
        with self._write_txn() as conn:
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False

            superseded = conn.execute(
                "SELECT anchor_message_seq FROM wyr_rounds "
                "WHERE state IN ('voting','answering','revealing')"
            ).fetchall()
            for old in superseded:
                conn.execute(
                    "UPDATE wyr_rounds SET state = 'skipped', rev = rev + 1, updated_at = ? "
                    "WHERE anchor_message_seq = ?",
                    (now, old["anchor_message_seq"]),
                )
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (old["anchor_message_seq"], now),
                )

            cursor = conn.execute(
                "INSERT INTO messages "
                "(client_id, sender, device_id, by_email, text, created_at) "
                "VALUES (?, ?, ?, ?, NULL, ?)",
                (client_id, sender, device_id, by_email, now),
            )
            seq = cursor.lastrowid
            assert seq is not None
            conn.execute(
                "INSERT INTO wyr_rounds "
                "(anchor_message_seq, question_id, state, images, player1_key, player1_name, "
                "player1_email, vote1, rev, created_at, updated_at) "
                "VALUES (?, ?, 'voting', ?, ?, ?, ?, 'play', 1, ?, ?)",
                (
                    seq,
                    question_id,
                    "pending" if images_pending else "none",
                    key,
                    sender,
                    by_email,
                    now,
                    now,
                ),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES ('message', ?, ?)",
                (seq, now),
            )
            return _load_message(conn, seq), True

    def get_wyr_round(self, *, anchor_seq: int) -> WyrRoundRow | None:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            return _row_to_wyr_round(row) if row is not None else None

    def wyr_used_ids(self) -> set[str]:
        """Questions this chat has played — derived from the rounds that still exist, so
        deleting a round (or wiping) leaves no separate record of it behind."""
        with self._read_txn() as conn:
            rows = conn.execute("SELECT DISTINCT question_id FROM wyr_rounds").fetchall()
            return {str(row["question_id"]) for row in rows}

    def wyr_selected_topics(self) -> frozenset[str] | None:
        """The bank categories the couple chose to play, or `None` for every topic."""
        with self._read_txn() as conn:
            rows = conn.execute("SELECT category FROM wyr_topics").fetchall()
        return frozenset(str(row["category"]) for row in rows) or None

    def set_wyr_topics(self, topics: Sequence[str] | None) -> None:
        """Replace the chosen topics (`None`/empty = every topic). The caller validates the ids."""
        with self._write_txn() as conn:
            conn.execute("DELETE FROM wyr_topics")
            conn.executemany(
                "INSERT INTO wyr_topics (category) VALUES (?)",
                [(topic,) for topic in dict.fromkeys(topics or ())],
            )

    @staticmethod
    def _wyr_slot(round_: WyrRoundRow, key: str, email: str | None) -> int | None:
        """Which player slot `key` is, or None for nobody. A name that IS a slot but arrives
        under a different authenticated email than the one that took the slot is someone
        else asserting that name: `WyrNotPlayerError` (the filter keys on a name the caller
        types, so the verified email is what stops one person reading the other's answers).
        An unknown email on either side (dev/no-auth, grant sessions) falls back to the name."""
        slot = 1 if round_.player1_key == key else 2 if round_.player2_key == key else None
        if slot is None:
            return None
        slot_email = round_.player1_email if slot == 1 else round_.player2_email
        if email is not None and slot_email is not None and email != slot_email:
            raise WyrNotPlayerError(f"that name belongs to another sign-in on this round ({slot})")
        return slot

    def vote_wyr(
        self,
        *,
        anchor_seq: int,
        voter_key: str,
        voter_name: str,
        voter_email: str | None,
        vote: Literal["play", "skip"],
        now: float,
    ) -> tuple[WyrRoundRow, bool]:
        """Record one player's skip/play vote. A new voter takes the next free slot;
        a third identity gets `WyrRoundFullError`. Any `skip` skips the round; two
        `play`s move it to `answering`. Re-sending the vote already recorded is an
        idempotent no-op (a retry after a dropped response cannot flip anything)."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            if row is None:
                raise WyrRoundNotFoundError(anchor_seq)
            round_ = _row_to_wyr_round(row)

            slot = self._wyr_slot(round_, voter_key, voter_email)
            if round_.state != "voting":
                already = round_.vote1 if slot == 1 else round_.vote2 if slot == 2 else None
                if slot is not None and already == vote:
                    return round_, False
                raise WyrBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not voting"
                )
            if slot is None:
                if round_.player1_key is None:
                    slot = 1
                elif round_.player2_key is None:
                    slot = 2
                else:
                    raise WyrRoundFullError(
                        f"round on message {anchor_seq} already has two players"
                    )

            current = round_.vote1 if slot == 1 else round_.vote2
            if current == vote and (round_.player1_name if slot == 1 else round_.player2_name):
                return round_, False

            conn.execute(
                f"UPDATE wyr_rounds SET player{slot}_key = ?, player{slot}_name = ?, "
                f"player{slot}_email = COALESCE(player{slot}_email, ?), "
                f"vote{slot} = ?, rev = rev + 1, updated_at = ? WHERE anchor_message_seq = ?",
                (voter_key, voter_name, voter_email, vote, now, anchor_seq),
            )
            new_state: str | None = None
            if vote == "skip":
                new_state = "skipped"
            else:
                other_vote = round_.vote2 if slot == 1 else round_.vote1
                if other_vote == "play":
                    new_state = "answering"
            if new_state is not None:
                conn.execute(
                    "UPDATE wyr_rounds SET state = ?, rev = rev + 1, updated_at = ? "
                    "WHERE anchor_message_seq = ?",
                    (new_state, now, anchor_seq),
                )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            updated = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            return _row_to_wyr_round(updated), True

    def answer_wyr(
        self,
        *,
        anchor_seq: int,
        player_key: str,
        player_email: str | None,
        choice: Literal["a", "b"],
        guess: Literal["a", "b"],
        now: float,
    ) -> tuple[WyrRoundRow, bool]:
        """Record one player's own pick and their guess of the other player's pick.
        Answers lock the moment both are in (`revealing`) — from then on the same
        answer re-sent is an idempotent no-op and a different one is `WyrBadStateError`
        (no re-answering once the reveal is pending)."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            if row is None:
                raise WyrRoundNotFoundError(anchor_seq)
            round_ = _row_to_wyr_round(row)
            slot = self._wyr_slot(round_, player_key, player_email)
            if slot is None:
                raise WyrNotPlayerError(
                    f"identity has no player slot on message {anchor_seq}'s round"
                )
            current_choice = round_.choice1 if slot == 1 else round_.choice2
            current_guess = round_.guess1 if slot == 1 else round_.guess2
            if round_.state != "answering":
                if current_choice == choice and current_guess == guess:
                    return round_, False
                raise WyrBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not answering"
                )
            if current_choice == choice and current_guess == guess:
                return round_, False

            conn.execute(
                f"UPDATE wyr_rounds SET choice{slot} = ?, guess{slot} = ?, "
                f"rev = rev + 1, updated_at = ? WHERE anchor_message_seq = ?",
                (choice, guess, now, anchor_seq),
            )
            other_choice = round_.choice2 if slot == 1 else round_.choice1
            other_guess = round_.guess2 if slot == 1 else round_.guess1
            if other_choice is not None and other_guess is not None:
                conn.execute(
                    "UPDATE wyr_rounds SET state = 'revealing', rev = rev + 1, "
                    "updated_at = ? WHERE anchor_message_seq = ?",
                    (now, anchor_seq),
                )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            updated = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            return _row_to_wyr_round(updated), True

    def reveal_wyr(
        self,
        *,
        anchor_seq: int,
        player_key: str,
        player_email: str | None,
        now: float | None = None,
    ) -> tuple[WyrRoundRow, bool]:
        """Start or join the 30-second two-player Reveal window atomically.

        A repeated press by the first player is an idempotent no-op and never extends the
        deadline. An expired or legacy request is reset before this press starts a fresh
        window. Only the other player joining strictly before the deadline reveals answers.
        """
        with self._write_txn() as conn:
            # If now is omitted, sample only after BEGIN IMMEDIATE has acquired SQLite's
            # cross-connection/process write lock. Queueing behind a competing write must not
            # consume part of the other player's 30-second window.
            now_s = time.time() if now is None else now
            row = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            if row is None:
                raise WyrRoundNotFoundError(anchor_seq)
            round_ = _row_to_wyr_round(row)
            slot = self._wyr_slot(round_, player_key, player_email)
            if slot is None:
                raise WyrNotPlayerError(
                    f"identity has no player slot on message {anchor_seq}'s round"
                )
            already = round_.reveal1 if slot == 1 else round_.reveal2
            if round_.state not in ("revealing", "revealed"):
                raise WyrBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not revealing"
                )
            if round_.state == "revealed":
                return round_, False

            deadline = round_.reveal_deadline
            if deadline is None or now_s >= deadline:
                # Includes old schema-v16 presses, which have no trustworthy deadline.
                conn.execute(
                    "UPDATE wyr_rounds SET reveal1 = ?, reveal2 = ?, reveal_deadline = ?, "
                    "rev = rev + 1, updated_at = ? WHERE anchor_message_seq = ?",
                    (
                        int(slot == 1),
                        int(slot == 2),
                        now_s + WYR_REVEAL_WINDOW_S,
                        now_s,
                        anchor_seq,
                    ),
                )
            elif already:
                return round_, False
            else:
                other_requested = round_.reveal2 if slot == 1 else round_.reveal1
                if other_requested:
                    conn.execute(
                        "UPDATE wyr_rounds SET state = 'revealed', reveal1 = 1, reveal2 = 1, "
                        "reveal_deadline = NULL, rev = rev + 1, updated_at = ? "
                        "WHERE anchor_message_seq = ?",
                        (now_s, anchor_seq),
                    )
                else:
                    # Defensive repair if the deadline survived but its requester flag did not.
                    conn.execute(
                        "UPDATE wyr_rounds SET reveal1 = ?, reveal2 = ?, reveal_deadline = ?, "
                        "rev = rev + 1, updated_at = ? WHERE anchor_message_seq = ?",
                        (
                            int(slot == 1),
                            int(slot == 2),
                            now_s + WYR_REVEAL_WINDOW_S,
                            now_s,
                            anchor_seq,
                        ),
                    )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now_s),
            )
            updated = conn.execute(
                "SELECT * FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            return _row_to_wyr_round(updated), True

    def wyr_round_is_paintable(self, *, anchor_seq: int) -> bool:
        """True while a round still exists and has not been skipped — the image job asks
        before spending GPU time, so a superseded or deleted round costs none."""
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT state FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            return row is not None and row["state"] != "skipped"

    def create_wyr_image_attachments(
        self,
        *,
        anchor_seq: int,
        images: Sequence[tuple[str, int]],
        by_email: str | None,
        now: float,
    ) -> bool:
        """Attach a round's server-generated pictures (`(attachment id, size)` per option, in
        option order) in ONE transaction: upload rows + `processing` photo attachments + the
        links to the anchor message + `images = 'done'`. One transaction means a round never
        keeps just one of its two pictures, and the media queue can never claim an attachment
        before it has a home (its source is `uploads/<id>/assembled`, already on disk).
        Returns False — after journaling the ids for cleanup — when the anchor vanished
        (deleted mid-generation), so the caller removes the staged files."""
        ids = [att_id for att_id, _ in images]
        with self._write_txn() as conn:
            if any(
                self._is_deleted_storage(conn, kind=kind, storage_id=att_id)
                for att_id in ids
                for kind in ("attachment", "upload")
            ):
                return False
            anchor_exists = (
                conn.execute(
                    "SELECT 1 FROM wyr_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
                ).fetchone()
                is not None
            )
            if not anchor_exists:
                self._queue_deleted_storage(conn, kind="attachment", ids=ids, now=now)
                self._queue_deleted_storage(conn, kind="upload", ids=ids, now=now)
                return False
            for ordinal, (att_id, size_bytes) in enumerate(images):
                conn.execute(
                    "INSERT INTO uploads (id, kind, mime, size_bytes, filename, by_email, "
                    "created_at) VALUES (?, 'photo', 'image/png', ?, NULL, ?, ?)",
                    (att_id, size_bytes, by_email, now),
                )
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, message_seq, ordinal, renditions, bytes_on_disk, "
                    "created_at, updated_at) "
                    "VALUES (?, 'photo', 'processing', ?, ?, '[]', 0, ?, ?)",
                    (att_id, anchor_seq, ordinal, now, now),
                )
            conn.execute(
                "UPDATE wyr_rounds SET images = 'done', rev = rev + 1, updated_at = ? "
                "WHERE anchor_message_seq = ?",
                (now, anchor_seq),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            return True

    def fail_wyr_images(self, *, anchor_seq: int, now: float) -> None:
        """The pictures for a round are not coming (generator down/failed/round skipped): the
        card stops waiting and lays out as text. No-op for a round that is gone or not pending."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE wyr_rounds SET images = 'failed', rev = rev + 1, updated_at = ? "
                "WHERE anchor_message_seq = ? AND images = 'pending'",
                (now, anchor_seq),
            )
            if cursor.rowcount:
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (anchor_seq, now),
                )

    def fail_stale_wyr_images(self, *, now: float) -> int:
        """Startup recovery: a round still `pending` at process start belongs to an image job
        that died with its process, so its card stops waiting (the transcription precedent)."""
        with self._write_txn() as conn:
            rows = conn.execute(
                "SELECT anchor_message_seq FROM wyr_rounds WHERE images = 'pending'"
            ).fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE wyr_rounds SET images = 'failed', rev = rev + 1, updated_at = ? "
                    "WHERE anchor_message_seq = ?",
                    (now, row["anchor_message_seq"]),
                )
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (row["anchor_message_seq"], now),
                )
            return len(rows)

    # -- Adventure Time (schema v20, workspace 00056) --------------------------------------------
    #
    # Every mutation runs under `BEGIN IMMEDIATE` and, when `now` is omitted, samples the server
    # clock only AFTER that write lock is held (decisions/00186: queueing behind a competing
    # writer must not eat into a timed window — here, a roulette's `rouletteAt`). Every mutation is
    # idempotent: the SAME move replayed returns the current round unchanged (`False` = nothing
    # changed, no event appended); a DIFFERENT move after the state advanced is
    # `AdventureBadStateError`. A real change bumps `rev` + `updated_at` and appends one
    # `message_updated` event for the anchor (no new event type).

    @staticmethod
    def _adv_load(conn: sqlite3.Connection, anchor_seq: int) -> AdventureRoundRow:
        row = conn.execute(
            "SELECT * FROM adv_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
        ).fetchone()
        if row is None:
            raise AdventureRoundNotFoundError(anchor_seq)
        return _row_to_adv_round(row)

    @staticmethod
    def _adv_excluded(conn: sqlite3.Connection) -> frozenset[str]:
        """Destinations out of play: the never-again list plus every banked trip (bank minus
        rejected minus banked is what a draw may land on)."""
        rows = conn.execute(
            "SELECT destination_id FROM adv_rejected "
            "UNION SELECT destination_id FROM adv_rounds "
            "WHERE state = 'banked' AND destination_id IS NOT NULL"
        ).fetchall()
        return frozenset(str(row["destination_id"]) for row in rows)

    def _adv_update(
        self,
        conn: sqlite3.Connection,
        anchor_seq: int,
        now: float,
        assignments: dict[str, object],
    ) -> AdventureRoundRow:
        """Apply `assignments` (column -> value; column names are internal literals, never user
        input), bump `rev`/`updated_at`, append the `message_updated` event, return the new row."""
        columns = ", ".join(f"{column} = ?" for column in assignments)
        conn.execute(
            f"UPDATE adv_rounds SET {columns}, rev = rev + 1, updated_at = ? "
            "WHERE anchor_message_seq = ?",
            (*assignments.values(), now, anchor_seq),
        )
        conn.execute(
            "INSERT INTO events (type, message_seq, created_at) VALUES ('message_updated', ?, ?)",
            (anchor_seq, now),
        )
        return self._adv_load(conn, anchor_seq)

    def create_adventure_round(
        self,
        *,
        client_id: str,
        sender: str,
        device_id: str,
        by_email: str | None,
        now: float | None = None,
    ) -> tuple[MessageRow, bool]:
        """Create a round: a text-less anchor message + an `adv_rounds` row in `spin_lng`. Every
        round still in `spin_lng|spin_lat|country|destination` is abandoned in the same
        transaction (a `chosen` round never is — it is a real place waiting for a decision).
        Idempotent on `client_id` like every other send."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            existing = conn.execute(
                "SELECT seq FROM messages WHERE client_id = ?", (client_id,)
            ).fetchone()
            if existing is not None:
                return _load_message(conn, existing["seq"]), False

            open_rounds = conn.execute(
                "SELECT anchor_message_seq FROM adv_rounds "
                "WHERE state IN ('spin_lng','spin_lat','country','destination')"
            ).fetchall()
            for old in open_rounds:
                self._adv_update(conn, old["anchor_message_seq"], now_s, {"state": "abandoned"})

            cursor = conn.execute(
                "INSERT INTO messages "
                "(client_id, sender, device_id, by_email, text, created_at) "
                "VALUES (?, ?, ?, ?, NULL, ?)",
                (client_id, sender, device_id, by_email, now_s),
            )
            seq = cursor.lastrowid
            assert seq is not None
            conn.execute(
                "INSERT INTO adv_rounds "
                "(anchor_message_seq, state, started_by, pack, rev, created_at, updated_at) "
                "VALUES (?, 'spin_lng', ?, 'none', 1, ?, ?)",
                (seq, sender, now_s, now_s),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) VALUES ('message', ?, ?)",
                (seq, now_s),
            )
            return _load_message(conn, seq), True

    def get_adventure_round(self, *, anchor_seq: int) -> AdventureRoundRow | None:
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT * FROM adv_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            return _row_to_adv_round(row) if row is not None else None

    def adventure_excluded_ids(self) -> frozenset[str]:
        """The destinations out of play right now: rejected and banked ids."""
        with self._read_txn() as conn:
            return self._adv_excluded(conn)

    @staticmethod
    def _adv_include_advised(conn: sqlite3.Connection) -> bool:
        row = conn.execute("SELECT include_advised FROM adv_settings WHERE id = 1").fetchone()
        return bool(row["include_advised"]) if row is not None else False

    def adventure_include_advised(self) -> bool:
        """The shared preference: whether places under a whole-country UK "advise against all
        travel" are in the draw (default off — no settings row)."""
        with self._read_txn() as conn:
            return self._adv_include_advised(conn)

    def set_adventure_include_advised(self, include: bool, *, now: float | None = None) -> bool:
        """Switch the shared preference. Returns whether it CHANGED. A real change also bumps
        every round still in `spin_lng|spin_lat` (and appends their `message_updated` events),
        because their view's `eligible` is computed at read time from this setting — both screens
        must re-read it. The preference names no place and no person, so a wipe leaves it alone."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            if self._adv_include_advised(conn) == include:
                return False
            conn.execute(
                "INSERT INTO adv_settings (id, include_advised) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET include_advised = excluded.include_advised",
                (int(include),),
            )
            spinning = conn.execute(
                "SELECT anchor_message_seq, state FROM adv_rounds "
                "WHERE state IN ('spin_lng','spin_lat')"
            ).fetchall()
            for round_ in spinning:
                self._adv_update(
                    conn, round_["anchor_message_seq"], now_s, {"state": round_["state"]}
                )
            return True

    def adventure_view_state(
        self, *, anchor_seq: int
    ) -> tuple[AdventureRoundRow, frozenset[str], bool] | None:
        """One consistent read for the round view: the round, and — only while it is still in a
        spin state, the one place the view lists `eligible` — the ids out of play, plus the
        shared `include_advised` preference."""
        data = self.adventure_view_data(anchor_seq=anchor_seq)
        return None if data is None else (data.round, data.excluded, data.include_advised)

    def adventure_view_data(self, *, anchor_seq: int) -> AdventureViewData | None:
        """`adventure_view_state` plus the round's picture attachments, in the SAME read
        transaction — so a view never pairs one `rev` with the ready-state of a later one (a
        picture finishing between two reads would otherwise show up a revision early)."""
        with self._read_txn() as conn:
            row = conn.execute(
                "SELECT * FROM adv_rounds WHERE anchor_message_seq = ?", (anchor_seq,)
            ).fetchone()
            if row is None:
                return None
            round_ = _row_to_adv_round(row)
            excluded = (
                self._adv_excluded(conn)
                if round_.state in ("spin_lng", "spin_lat")
                else frozenset[str]()
            )
            attachments: tuple[AttachmentRow, ...] = (
                tuple(_load_attachments_for(conn, [anchor_seq]).get(anchor_seq, []))
                if round_.pictures_json is not None
                else ()
            )
            return AdventureViewData(
                round=round_,
                excluded=excluded,
                include_advised=self._adv_include_advised(conn),
                attachments=attachments,
            )

    def spin_adventure(
        self,
        *,
        anchor_seq: int,
        sender: str,
        axis: Literal["lng", "lat"],
        from_deg: float,
        delta_deg: float,
        duration_ms: float,
        landing: AdventureLanding | None = None,
        candidates: Sequence[str] | None = None,
        now: float | None = None,
    ) -> tuple[AdventureRoundRow, bool]:
        """Store one committed spin. `lng` is valid in `spin_lng` and moves to `spin_lat`; `lat` is
        valid in `spin_lat`, carries the landing + country candidates (the caller has validated
        them against the bank and the §3.1/§3.2 bounds) and moves to `country`, drawing the
        roulette `seed` and setting `country_roulette_at = now + duration + 5 s`. The SAME spin
        (same axis, `from`, `delta`) replayed after the state moved is an idempotent success."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            round_ = self._adv_load(conn, anchor_seq)
            needed: AdventureState = "spin_lng" if axis == "lng" else "spin_lat"
            if round_.state != needed:
                stored = round_.spin_lng if axis == "lng" else round_.spin_lat
                if (
                    stored is not None
                    and stored.from_deg == from_deg
                    and stored.delta_deg == delta_deg
                ):
                    return round_, False
                raise AdventureBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not {needed}"
                )
            spin = AdventureSpin(
                by=sender,
                from_deg=from_deg,
                delta_deg=delta_deg,
                duration_ms=duration_ms,
                at=now_s,
            )
            if axis == "lng":
                assignments: dict[str, object] = {
                    "spin_lng": json.dumps(spin.to_json()),
                    "state": "spin_lat",
                }
            else:
                assert landing is not None and candidates
                assignments = {
                    "spin_lat": json.dumps(spin.to_json()),
                    "landing": json.dumps(landing.to_json()),
                    "country_candidates": json.dumps(list(candidates)),
                    "country_seed": secrets.randbits(32),
                    "country_roulette_at": now_s
                    + duration_ms / 1000.0
                    + ADVENTURE_ROULETTE_SETTLE_S,
                    "state": "country",
                }
            return self._adv_update(conn, anchor_seq, now_s, assignments), True

    @staticmethod
    def _adv_pack_start(pack_available: bool) -> dict[str, object]:
        """The pack columns for a round entering `chosen`: `pending` (a job will start the run) when
        a researcher exists, else `unavailable` at once."""
        if pack_available:
            return {"pack": "pending", "pack_run_id": None}
        return {"pack": "unavailable", "pack_error": ADVENTURE_PACK_UNAVAILABLE_TEXT}

    def stop_adventure(
        self,
        *,
        anchor_seq: int,
        sender: str,
        stage: Literal["country", "destination"],
        choice: str,
        bank: AdventureBank,
        pack_available: bool,
        now: float | None = None,
    ) -> tuple[AdventureRoundRow, bool]:
        """Press Stop on a roulette: `choice` is the candidate the presser SAW lit (what you see is
        what you get). A stop before the roulette's `rouletteAt` (less the 1 s tolerance) is
        `AdventureTooEarlyError`; a choice outside the stage's candidates is
        `AdventureInvalidError`.

        `country`: the chosen unit's top 5 remaining destinations (`AdventureBank.top_destinations`:
        rank order, spaced at least 40 km apart where the unit allows) become the next roulette —
        none left (or the unit is under a whole-country "advise against all travel" while the
        shared `include_advised` preference is off) is `AdventureExhaustedError` (the round stays
        in `country`), exactly one skips straight to `chosen`, else `destination` with a fresh
        seed and `dest_roulette_at = now + 3.5 s`. `destination`: the round is `chosen`.
        Entering `chosen` sets `pack` to `pending` (or `unavailable` without a researcher) in the
        same transaction — the caller starts the job when the returned round is `pending` with no
        run id."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            round_ = self._adv_load(conn, anchor_seq)
            if stage == "country":
                if round_.state != "country":
                    if round_.country_id is not None and round_.country_id == choice:
                        return round_, False
                    raise AdventureBadStateError(
                        f"round on message {anchor_seq} is {round_.state}, not country"
                    )
                if choice not in (round_.country_candidates or ()):
                    raise AdventureInvalidError("choice is not one of the country candidates")
                self._adv_require_started(
                    now_s, round_.country_roulette_at, "the country roulette has not started"
                )
                # The shared preference is honoured NOW, at the stop: a country under a
                # whole-country "advise against all travel" has nothing in play unless the pair
                # have switched those back in (it can change between the spin and the stop).
                top = (
                    bank.top_destinations(choice, self._adv_excluded(conn), TOP_DESTINATIONS)
                    if bank.is_playable(choice, include_advised=self._adv_include_advised(conn))
                    else ()
                )
                if not top:
                    raise AdventureExhaustedError(f"{choice} has no destination left in play")
                assignments: dict[str, object] = {
                    "country_id": choice,
                    "country_by": sender,
                    "dest_candidates": json.dumps([destination.id for destination in top]),
                }
                if len(top) == 1:
                    assignments.update(
                        {
                            "destination_id": top[0].id,
                            "destination_by": sender,
                            "state": "chosen",
                            **self._adv_pack_start(pack_available),
                        }
                    )
                else:
                    assignments.update(
                        {
                            "dest_seed": secrets.randbits(32),
                            "dest_roulette_at": now_s + ADVENTURE_DESTINATION_SETTLE_S,
                            "state": "destination",
                        }
                    )
                return self._adv_update(conn, anchor_seq, now_s, assignments), True

            if round_.state != "destination":
                if round_.destination_id is not None and round_.destination_id == choice:
                    return round_, False
                raise AdventureBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not destination"
                )
            if choice not in (round_.dest_candidates or ()):
                raise AdventureInvalidError("choice is not one of the destination candidates")
            self._adv_require_started(
                now_s, round_.dest_roulette_at, "the destination roulette has not started"
            )
            assignments = {
                "destination_id": choice,
                "destination_by": sender,
                "state": "chosen",
                **self._adv_pack_start(pack_available),
            }
            return self._adv_update(conn, anchor_seq, now_s, assignments), True

    @staticmethod
    def _adv_require_started(now: float, roulette_at: float | None, detail: str) -> None:
        if roulette_at is not None and now < roulette_at - ADVENTURE_STOP_TOLERANCE_S:
            raise AdventureTooEarlyError(detail)

    def decide_adventure(
        self,
        *,
        anchor_seq: int,
        sender: str,
        decision: Literal["bank", "reject"],
        now: float | None = None,
    ) -> tuple[AdventureRoundRow, bool]:
        """Bank or reject a `chosen` destination. Reject also adds the destination to the
        never-again list in the same transaction, and ends a still-running research (`pending` ->
        `failed`, so the job's compare-and-set finds nothing to land on and cancels its run).
        Replaying the same decision is an idempotent success."""
        target: AdventureState = "banked" if decision == "bank" else "rejected"
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            round_ = self._adv_load(conn, anchor_seq)
            if round_.state != "chosen":
                if round_.state == target:
                    return round_, False
                raise AdventureBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not chosen"
                )
            assignments: dict[str, object] = {"state": target, "decided_by": sender}
            if decision == "reject":
                assert round_.destination_id is not None
                conn.execute(
                    "INSERT OR IGNORE INTO adv_rejected (destination_id) VALUES (?)",
                    (round_.destination_id,),
                )
                if round_.pack == "pending":
                    assignments["pack"] = "failed"
                    assignments["pack_error"] = ADVENTURE_PACK_STOPPED_TEXT
                if round_.images == "pending":
                    # The picture job notices (its attach is a compare-and-set on `pending`) and
                    # attaches nothing; the round stops waiting for pictures that are not coming.
                    assignments["images"] = "failed"
            return self._adv_update(conn, anchor_seq, now_s, assignments), True

    def retry_adventure_pack(
        self,
        *,
        anchor_seq: int,
        researcher_available: bool,
        now: float | None = None,
    ) -> tuple[AdventureRoundRow, bool]:
        """Try the holiday pack again: valid for a `chosen` or `banked` round whose pack is
        `failed` or `unavailable`, while a researcher exists. It goes back to `pending` with no
        run, no data and no error — the returned flag says a job must start. A pack already
        `pending` is an idempotent success (a double tap); anything else is `bad_state`."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            round_ = self._adv_load(conn, anchor_seq)
            if round_.state not in ("chosen", "banked"):
                raise AdventureBadStateError(
                    f"round on message {anchor_seq} is {round_.state}, not chosen or banked"
                )
            if round_.pack == "pending":
                return round_, False
            if round_.pack in ("failed", "unavailable") and researcher_available:
                updated = self._adv_update(
                    conn,
                    anchor_seq,
                    now_s,
                    {
                        "pack": "pending",
                        "pack_run_id": None,
                        "pack_json": None,
                        "pack_error": None,
                        "images": "none",
                        "pictures": None,
                        "images_started_at": None,
                        "images_tries": 0,
                    },
                )
                return updated, True
            raise AdventureBadStateError(
                f"the holiday pack on message {anchor_seq} is {round_.pack}, not failed"
            )

    def set_adventure_pack_run(
        self,
        *,
        anchor_seq: int,
        run_id: str,
        expected_run_id: str | None = None,
        now: float | None = None,
    ) -> bool:
        """Record the research run a `pending` pack is waiting on — a compare-and-set on
        `(pack = 'pending' AND pack_run_id = expected_run_id)` (NULL for the first run, the dead
        run's id for the single early retry). `False` means the round moved on (deleted, rejected,
        or another process already started a run): the caller cancels its run."""
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            cursor = conn.execute(
                "UPDATE adv_rounds SET pack_run_id = ?, updated_at = ? "
                "WHERE anchor_message_seq = ? AND pack = 'pending' AND pack_run_id IS ?",
                (run_id, now_s, anchor_seq, expected_run_id),
            )
            return cursor.rowcount == 1

    def finish_adventure_pack(
        self,
        *,
        anchor_seq: int,
        run_id: str | None,
        state: Literal["ready", "failed", "unavailable"],
        pack_json: str | None = None,
        error: str | None = None,
        pictures_pending: bool = False,
        now: float | None = None,
    ) -> bool:
        """Land the research outcome on the round — a compare-and-set on
        `(pack = 'pending' AND pack_run_id = run_id)`, so a blue/green overlap where two processes
        poll the same run stores it once, and a round rejected or deleted meanwhile is untouched.
        `False` = nothing was waiting for this run. A pack landing on a round already `banked`
        still lands (the trip's pack arrives after the couple saved it). `pictures_pending` (a
        `ready` pack on a server that can fetch pictures) starts the picture wait in the same
        write: `images` becomes `pending` and the caller then runs the picture job."""
        hunt = state == "ready" and pictures_pending
        images = "pending" if hunt else "none"
        with self._write_txn() as conn:
            now_s = time.time() if now is None else now
            # The first hunt begins now, in this same write: its start time and try count are what
            # let a sweep recognise a hunt that died (see `claim_adventure_pictures`).
            cursor = conn.execute(
                "UPDATE adv_rounds SET pack = ?, pack_json = ?, pack_error = ?, images = ?, "
                "images_started_at = ?, images_tries = ?, rev = rev + 1, updated_at = ? "
                "WHERE anchor_message_seq = ? AND pack = 'pending' AND pack_run_id IS ?",
                (
                    state,
                    pack_json,
                    error,
                    images,
                    now_s if hunt else None,
                    1 if hunt else 0,
                    now_s,
                    anchor_seq,
                    run_id,
                ),
            )
            if cursor.rowcount != 1:
                return False
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now_s),
            )
            return True

    def adventure_pending_packs(self) -> list[tuple[int, str | None]]:
        """Startup recovery: every round whose pack is `pending`, as `(anchor seq, run id or
        None)` — a run id resumes polling that run; none means the process died before the spawn,
        so a new run starts."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT anchor_message_seq, pack_run_id FROM adv_rounds "
                "WHERE pack = 'pending' ORDER BY anchor_message_seq"
            ).fetchall()
            return [(int(row["anchor_message_seq"]), row["pack_run_id"]) for row in rows]

    def adventure_pending_pictures(self) -> list[int]:
        """Startup recovery: the anchor seq of every round whose pack is `ready` and whose pictures
        are still `pending` — the previous process died mid-hunt, and since the attach is
        all-or-nothing nothing was stored, so the hunt is simply redone. A rejected round never
        appears (rejecting ends the wait)."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT anchor_message_seq FROM adv_rounds "
                "WHERE pack = 'ready' AND images = 'pending' AND state IN ('chosen', 'banked') "
                "ORDER BY anchor_message_seq"
            ).fetchall()
            return [int(row["anchor_message_seq"]) for row in rows]

    def adventure_stale_pictures(self, *, stale_before: float) -> list[int]:
        """Rounds whose picture wait looks abandoned: `images = pending` on a `ready` pack of a
        `chosen`/`banked` round, whose current hunt began before `stale_before` (or never recorded a
        start). The sweep re-claims these; a hunt still running in some process is far younger."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT anchor_message_seq FROM adv_rounds "
                "WHERE pack = 'ready' AND images = 'pending' AND state IN ('chosen', 'banked') "
                "AND (images_started_at IS NULL OR images_started_at < ?) "
                "ORDER BY anchor_message_seq",
                (stale_before,),
            ).fetchall()
            return [int(row["anchor_message_seq"]) for row in rows]

    def claim_adventure_pictures(
        self,
        *,
        anchor_seq: int,
        stale_before: float | None,
        now: float,
        max_tries: int = MAX_PICTURE_TRIES,
    ) -> Literal["claimed", "not_due", "gave_up", "gone"]:
        """Begin another hunt for a `pending` round — a compare-and-set, so two processes sweeping
        at once start one: it succeeds only while the round still waits (`ready` pack,
        `images = pending`, `chosen`/`banked`) and, when `stale_before` is given, only while the
        current hunt began before it (`None` = unconditionally, the startup redo of a hunt that
        died with the previous process). A claim stamps `images_started_at = now` and counts a try.
        A round already at `max_tries` is not hunted again: the wait ends as `failed` (`gave_up`,
        announced like any other change). `not_due` = another process already claimed it or the
        hunt is young; `gone` = the round no longer waits (done, failed, rejected, deleted)."""
        with self._write_txn() as conn:
            row = conn.execute(
                "SELECT state, pack, images, images_started_at, images_tries FROM adv_rounds "
                "WHERE anchor_message_seq = ?",
                (anchor_seq,),
            ).fetchone()
            if (
                row is None
                or row["state"] not in ("chosen", "banked")
                or row["pack"] != "ready"
                or row["images"] != "pending"
            ):
                return "gone"
            started = row["images_started_at"]
            if stale_before is not None and started is not None and started >= stale_before:
                return "not_due"
            if int(row["images_tries"]) >= max_tries:
                conn.execute(
                    "UPDATE adv_rounds SET images = 'failed', rev = rev + 1, updated_at = ? "
                    "WHERE anchor_message_seq = ? AND images = 'pending'",
                    (now, anchor_seq),
                )
                conn.execute(
                    "INSERT INTO events (type, message_seq, created_at) "
                    "VALUES ('message_updated', ?, ?)",
                    (anchor_seq, now),
                )
                return "gave_up"
            conn.execute(
                "UPDATE adv_rounds SET images_started_at = ?, images_tries = images_tries + 1 "
                "WHERE anchor_message_seq = ? AND images = 'pending'",
                (now, anchor_seq),
            )
            return "claimed"

    def fail_adventure_pictures(self, *, anchor_seq: int, now: float) -> bool:
        """The pictures for a round are not coming (nothing found, a failure, or the round no longer
        wants them): the pane stops waiting. A compare-and-set on `images = 'pending'`; `False` =
        nothing was waiting (gone, already done or failed)."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE adv_rounds SET images = 'failed', rev = rev + 1, updated_at = ? "
                "WHERE anchor_message_seq = ? AND images = 'pending'",
                (now, anchor_seq),
            )
            if cursor.rowcount != 1:
                return False
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            return True

    def create_adventure_picture_attachments(
        self,
        *,
        anchor_seq: int,
        images: Sequence[tuple[str, int]],
        pictures_json: str,
        by_email: str | None,
        now: float,
    ) -> bool:
        """Attach a holiday pack's server-fetched pictures (`(attachment id, size)` in ordinal
        order, already staged at `uploads/<id>/assembled`) to the round's ANCHOR message in ONE
        transaction — the `create_wyr_image_attachments` precedent: upload rows + `processing` photo
        attachments + the slot map + `images = 'done'` + one event. They are ordinary private photo
        attachments, so renditions, signed URLs, quota and delete/wipe erasure are inherited.
        A compare-and-set: it attaches only while the round still exists, is `chosen` or `banked`
        with its pack `ready` and `images = 'pending'`. Otherwise (deleted, rejected, finished by
        another process) it returns False after journaling the ids for cleanup, and the caller
        removes the staged files."""
        ids = [att_id for att_id, _ in images]
        with self._write_txn() as conn:
            if any(
                self._is_deleted_storage(conn, kind=kind, storage_id=att_id)
                for att_id in ids
                for kind in ("attachment", "upload")
            ):
                return False
            row = conn.execute(
                "SELECT state, pack, images FROM adv_rounds WHERE anchor_message_seq = ?",
                (anchor_seq,),
            ).fetchone()
            if (
                row is None
                or row["state"] not in ("chosen", "banked")
                or row["pack"] != "ready"
                or row["images"] != "pending"
            ):
                self._queue_deleted_storage(conn, kind="attachment", ids=ids, now=now)
                self._queue_deleted_storage(conn, kind="upload", ids=ids, now=now)
                return False
            for ordinal, (att_id, size_bytes) in enumerate(images):
                conn.execute(
                    "INSERT INTO uploads (id, kind, mime, size_bytes, filename, by_email, "
                    "created_at) VALUES (?, 'photo', 'image/jpeg', ?, NULL, ?, ?)",
                    (att_id, size_bytes, by_email, now),
                )
                conn.execute(
                    "INSERT INTO attachments "
                    "(id, kind, status, message_seq, ordinal, renditions, bytes_on_disk, "
                    "created_at, updated_at) "
                    "VALUES (?, 'photo', 'processing', ?, ?, '[]', 0, ?, ?)",
                    (att_id, anchor_seq, ordinal, now, now),
                )
            conn.execute(
                "UPDATE adv_rounds SET images = 'done', pictures = ?, rev = rev + 1, "
                "updated_at = ? WHERE anchor_message_seq = ?",
                (pictures_json, now, anchor_seq),
            )
            conn.execute(
                "INSERT INTO events (type, message_seq, created_at) "
                "VALUES ('message_updated', ?, ?)",
                (anchor_seq, now),
            )
            return True

    def adventure_picture_attachments(self, *, anchor_seq: int) -> tuple[AttachmentRow, ...]:
        """The photo attachments on a round's anchor message, in ordinal order (the holiday pack's
        pictures; the slot map in `pictures_json` names them by ordinal)."""
        with self._read_txn() as conn:
            return tuple(_load_attachments_for(conn, [anchor_seq]).get(anchor_seq, []))

    def list_adventure_bank(self) -> list[AdventureRoundRow]:
        """The banked trips, newest first (by anchor seq)."""
        with self._read_txn() as conn:
            rows = conn.execute(
                "SELECT * FROM adv_rounds WHERE state = 'banked' ORDER BY anchor_message_seq DESC"
            ).fetchall()
            return [_row_to_adv_round(row) for row in rows]

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
            # The FK cascade on `drawings.anchor_message_seq` (like reactions' own) already
            # removes these when `messages` rows go; explicit here anyway (spec 07 §6) so the
            # wipe's intent to clear every drawing is not left implicit in a constraint.
            conn.execute("DELETE FROM drawing_strokes")
            conn.execute("DELETE FROM drawings")
            # Same doctrine for the game (schema v15): the cascade on
            # `wyr_rounds.anchor_message_seq` already carries rounds away with their
            # messages; explicit here so wipe's intent is never left implicit.
            conn.execute("DELETE FROM wyr_chat")
            conn.execute("DELETE FROM wyr_rounds")
            # And for Adventure Time (schema v20): the rounds, plus the never-again list — a wipe
            # forgets everything about the two of you (Inv 56), the turned-down places included.
            conn.execute("DELETE FROM adv_rounds")
            conn.execute("DELETE FROM adv_rejected")
            # `adv_settings` (the shared include-advised preference) names no place and no person,
            # so — like `wyr_topics` — a wipe deliberately leaves it alone.
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
                # A holiday-pack picture becoming ready changes the Adventure Time round's view
                # (its pictures list only READY attachments), so the round's `rev` — the signal the
                # client re-fetches on — moves too. A no-op for every other message.
                conn.execute(
                    "UPDATE adv_rounds SET rev = rev + 1, updated_at = ? "
                    "WHERE anchor_message_seq = ?",
                    (now, message_seq),
                )
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

    def list_gallery(
        self, *, before: tuple[int, int] | None, limit: int
    ) -> tuple[list[AttachmentRow], bool]:
        """The gallery's page of the media history, NEWEST first: every `ready` photo and video
        that belongs to a sent message and is not view-once (a view-once picture is never kept
        anywhere a second look could reach it — Inv 52). The would-you-rather round's own
        generated pictures and the Adventure Time holiday pack's pictures are game furniture, not
        sent media, so they are left out. Ordered by
        `(message_seq, ordinal)`; `before` is the last `(seq, ordinal)` of the previous page.
        Returns `(rows, has_more)`."""
        sql = (
            f"{_SELECT_ATTACHMENT} JOIN messages AS m ON m.seq = a.message_seq "
            "WHERE a.status = 'ready' AND a.kind IN ('photo', 'video') "
            "AND a.view_once_renditions IS NULL AND m.view_once_s IS NULL "
            "AND a.renditions != '[]' "
            "AND a.message_seq NOT IN (SELECT anchor_message_seq FROM wyr_rounds) "
            "AND a.message_seq NOT IN (SELECT anchor_message_seq FROM adv_rounds)"
        )
        args: list[int] = []
        if before is not None:
            sql += " AND (a.message_seq < ? OR (a.message_seq = ? AND a.ordinal < ?))"
            args += [before[0], before[0], before[1]]
        sql += " ORDER BY a.message_seq DESC, a.ordinal DESC LIMIT ?"
        args.append(limit + 1)
        with self._read_txn() as conn:
            rows = conn.execute(sql, tuple(args)).fetchall()
            return [_row_to_attachment(row) for row in rows[:limit]], len(rows) > limit

    def thumbless_attachments(self) -> list[AttachmentRow]:
        """Ready, kept photos and videos whose rendition list has no `thumb` — media sent before
        every video got a grid thumbnail. View-once media (renditions moved aside, Inv 52) and
        anything still processing are never in this list."""
        with self._read_txn() as conn:
            rows = conn.execute(
                f"{_SELECT_ATTACHMENT} WHERE a.status = 'ready' "
                "AND a.kind IN ('photo', 'video') AND a.view_once_renditions IS NULL "
                "AND a.renditions != '[]' AND a.renditions NOT LIKE '%\"thumb\"%'"
            ).fetchall()
            return [_row_to_attachment(row) for row in rows]

    def add_thumb_rendition(self, *, att: AttachmentRow, thumb_bytes: int, now: float) -> bool:
        """Append `thumb` to `att`'s rendition list. Compare-and-set on the exact list the caller
        read, so an attachment that went view-once (list cleared) or was deleted in the meantime
        is left untouched — the caller then removes the file it wrote. Raises the quota figure
        by the thumbnail's size. No event: nothing on screen depends on a thumb appearing."""
        with self._write_txn() as conn:
            cursor = conn.execute(
                "UPDATE attachments SET renditions = ?, bytes_on_disk = bytes_on_disk + ?, "
                "updated_at = ? WHERE id = ? AND renditions = ? AND view_once_renditions IS NULL",
                (
                    json.dumps([*att.renditions, "thumb"]),
                    thumb_bytes,
                    now,
                    att.id,
                    json.dumps(list(att.renditions)),
                ),
            )
            return cursor.rowcount > 0

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
        self,
        *,
        att_id: str,
        now: float,
        restart_pending: bool = False,
        restart_done: bool = False,
    ) -> TranscriptBegin:
        """Atomically decide whether a transcription job should start for `att_id`.

        `restart_pending=True` treats an existing `pending` row like a `failed` one and starts
        over: the route passes it only when THIS process has no job in flight for the note, so
        the row belongs to a job that is gone (its outcome could not be recorded, or it was
        started by a process that died) — never to a live one.

        `restart_done=True` allows re-transcribing a completed transcript row, resetting it to
        `pending` in place.

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
            if existing is not None and existing.status == "done" and not restart_done:
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
                    "UPDATE attachment_transcripts SET status = 'pending', "
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
            if status == "done":
                cursor = conn.execute(
                    "UPDATE attachment_transcripts SET status = ?, text = ?, failure = ?, "
                    "engine = ?, updated_at = ? WHERE attachment_id = ?"
                    + (" AND status = 'pending'" if only_if_pending else ""),
                    (status, text, failure, engine, now, att_id),
                )
            else:
                # Failure: preserve existing transcript text (if any) rather than wiping it to NULL
                cursor = conn.execute(
                    "UPDATE attachment_transcripts SET status = ?, failure = ?, "
                    "engine = ?, updated_at = ? WHERE attachment_id = ?"
                    + (" AND status = 'pending'" if only_if_pending else ""),
                    (status, failure, engine, now, att_id),
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
