"""The merged schema ladder (workspace 00058 main sync): main shipped live voice as v22 (`uploads`
live columns) and v23 (`attachments.live_state`); the Cookout branch had used v22 for
`cookout_rounds.mode`. The mode column is now v24. A database at either line's latest version
must migrate forward to the merged latest with every column present and every row intact."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore

UPLOAD_COLS = {"live", "device_id", "last_chunk_at", "duration_ms"}


def _columns(db: Path, table: str) -> set[str]:
    conn = sqlite3.connect(str(db))
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


def _version(db: Path) -> int:
    conn = sqlite3.connect(str(db))
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    finally:
        conn.close()


def _fresh(tmp_path: Path) -> Path:
    db = tmp_path / "server" / "server.db"
    LiveChatStore(db).pending_upload_bytes()
    return db


def _drop(db: Path, table: str, columns: set[str], version: int) -> None:
    conn = sqlite3.connect(str(db))
    try:
        for column in columns:
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
    finally:
        conn.close()


def test_the_merged_latest_is_24() -> None:
    assert _LATEST_SCHEMA_VERSION == 24


def test_a_database_at_mains_latest_version_23_gains_the_cookout_mode(tmp_path: Path) -> None:
    db = _fresh(tmp_path)
    _drop(db, "cookout_rounds", {"mode"}, 23)
    assert _version(db) == 23 and "mode" not in _columns(db, "cookout_rounds")
    LiveChatStore(db).pending_upload_bytes()
    assert _version(db) == _LATEST_SCHEMA_VERSION
    assert "mode" in _columns(db, "cookout_rounds")
    assert UPLOAD_COLS <= _columns(db, "uploads") and "live_state" in _columns(db, "attachments")


def test_a_database_at_the_cookout_branchs_latest_version_22_gains_live_voice(
    tmp_path: Path,
) -> None:
    db = _fresh(tmp_path)
    _drop(db, "uploads", UPLOAD_COLS, 22)
    _drop(db, "attachments", {"live_state"}, 22)
    assert _version(db) == 22 and "mode" in _columns(db, "cookout_rounds")
    LiveChatStore(db).pending_upload_bytes()
    assert _version(db) == _LATEST_SCHEMA_VERSION
    assert UPLOAD_COLS <= _columns(db, "uploads") and "live_state" in _columns(db, "attachments")
    assert "mode" in _columns(db, "cookout_rounds")


def test_the_migration_is_idempotent(tmp_path: Path) -> None:
    db = _fresh(tmp_path)
    LiveChatStore(db).pending_upload_bytes()
    LiveChatStore(db).pending_upload_bytes()
    assert _version(db) == _LATEST_SCHEMA_VERSION
