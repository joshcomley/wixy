"""Live drawing — the pen tool (spec/server-chat/07-live-drawing.md). Palette allowlist,
the client/server drift guard (§3), `LiveChatStore`'s drawing tables (§2/§3/§6), the
v12->v13 schema migration (§8, decisions/00172's Tease rename took v12 first), and
cascade erasure raw-bytes proofs (§6, Inv 40/46)."""

from __future__ import annotations

import dataclasses
import re
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from wixy_server.livechat.drawings import (
    DRAWING_COLORS,
    DRAWING_WIDTHS,
    MAX_COLUMN_WIDTH,
    MAX_DRAWINGS_PER_ANCHOR,
    MAX_STROKES_PER_DRAWING,
    MIN_COLUMN_WIDTH,
    is_allowed_drawing_color,
    is_allowed_drawing_width,
)
from wixy_server.livechat.store import (
    _LATEST_SCHEMA_VERSION,
    DrawingAnchorNotFoundError,
    DrawingLimitExceededError,
    DrawingNotFoundError,
    LiveChatStore,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_CONSTANTS = _REPO_ROOT / "admin-ui" / "src" / "server" / "drawings.ts"


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "server" / "server.db"


@pytest.fixture
def store(db_path: Path) -> LiveChatStore:
    return LiveChatStore(db_path)


def _raw_bytes(store: LiveChatStore) -> bytes:
    db_path = store._db_path
    wal_path = Path(f"{db_path}-wal")
    return db_path.read_bytes() + (wal_path.read_bytes() if wal_path.exists() else b"")


class TestAllowlists:
    def test_eight_colours_in_the_ruled_order(self) -> None:
        assert DRAWING_COLORS == (
            "#1c1c1e",
            "#ffffff",
            "#ff3b30",
            "#ff9500",
            "#ffcc00",
            "#34c759",
            "#0a84ff",
            "#af52de",
        )
        assert len(set(DRAWING_COLORS)) == len(DRAWING_COLORS)

    def test_four_widths_in_the_ruled_order(self) -> None:
        assert DRAWING_WIDTHS == (2, 4, 8, 14)

    @pytest.mark.parametrize("color", DRAWING_COLORS)
    def test_every_colour_is_allowed(self, color: str) -> None:
        assert is_allowed_drawing_color(color)

    @pytest.mark.parametrize(
        "color", ["", "#1c1c1e ", "#1C1C1E", "1c1c1e", "#000000", "red", "#1c1c1", None]
    )
    def test_anything_else_is_refused(self, color: object) -> None:
        assert not is_allowed_drawing_color(color)  # type: ignore[arg-type]

    @pytest.mark.parametrize("width", DRAWING_WIDTHS)
    def test_every_width_is_allowed(self, width: int) -> None:
        assert is_allowed_drawing_width(width)

    @pytest.mark.parametrize("width", [0, 1, 3, 6, 15, 20, -2])
    def test_anything_else_is_refused_width(self, width: int) -> None:
        assert not is_allowed_drawing_width(width)

    def test_column_width_bounds_match_the_check_constraint(self) -> None:
        assert (MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH) == (200.0, 4000.0)


class TestClientListMatchesServerList:
    """`admin-ui/src/server/drawings.ts` is the browser's copy of both allowlists — the
    reaction-emoji drift guard's own pattern (spec §3: "shared by TS and Python with a
    drift guard"). The client builder (branch cmd/workspace-00035-live-drawing-client)
    is writing this file in parallel on a separate branch; until that branch merges,
    this class is expected to fail here with a clear "file not found" message, not
    silently pass — see the PR description for the cross-branch landing note."""

    @staticmethod
    def _source() -> str:
        assert _TS_CONSTANTS.exists(), (
            f"{_TS_CONSTANTS} does not exist yet — it lives on the live-drawing CLIENT "
            "builder's branch (cmd/workspace-00035-live-drawing-client) and this drift "
            "guard can only pass once both branches share it on main."
        )
        return _TS_CONSTANTS.read_text(encoding="utf-8")

    def test_colours_are_identical_in_content_and_order(self) -> None:
        source = self._source()
        match = re.search(r"export const DRAWING_COLORS = \[(.*?)\] as const;", source, re.DOTALL)
        assert match is not None, "DRAWING_COLORS declaration not found in drawings.ts"
        colors = re.findall(r'"([^"]*)"', match.group(1))
        assert colors == list(DRAWING_COLORS)

    def test_widths_are_identical_in_content_and_order(self) -> None:
        source = self._source()
        match = re.search(r"export const DRAWING_WIDTHS = \[(.*?)\] as const;", source, re.DOTALL)
        assert match is not None, "DRAWING_WIDTHS declaration not found in drawings.ts"
        widths = [int(w) for w in re.findall(r"(\d+)", match.group(1))]
        assert widths == list(DRAWING_WIDTHS)


class TestMigrationV12ToV13:
    def test_fresh_database_lands_directly_on_v13(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            assert _LATEST_SCHEMA_VERSION >= 13
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            assert {"drawings", "drawing_strokes"} <= tables
            indexes = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'index'"
                ).fetchall()
            }
            assert "idx_drawings_anchor" in indexes
        finally:
            conn.close()

    def test_a_database_frozen_at_v12_migrates_cleanly_and_keeps_its_data(
        self, store: LiveChatStore, db_path: Path
    ) -> None:
        """A database already fully migrated to v12 (the Tease rename, decisions/00172,
        the schema version live-drawing's v13 had to be renumbered past) upgrades to
        v13 by ADDING the two new tables — no data loss, no rebuild of `messages`."""
        store.list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("DROP TABLE drawings")
            conn.execute("DROP TABLE drawing_strokes")
            conn.execute(
                "INSERT INTO messages (client_id, sender, device_id, created_at) "
                "VALUES ('client-frozen-at-v12', 'Josh', 'dev1', 1.0)"
            )
            conn.execute("PRAGMA user_version = 12")
            conn.commit()
        finally:
            conn.close()

        upgraded = LiveChatStore(db_path)
        messages, _has_more, _cursor = upgraded.list_messages(before=None, limit=10)
        assert [m.client_id for m in messages] == ["client-frozen-at-v12"]

        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            assert {"drawings", "drawing_strokes"} <= tables
        finally:
            conn.close()

    def test_migrating_twice_is_a_harmless_no_op(self, db_path: Path) -> None:
        """`CREATE TABLE IF NOT EXISTS` (decisions/… P2b cold-start fix): opening the
        store twice against the same file never raises on the second migration pass."""
        LiveChatStore(db_path).list_messages(before=None, limit=1)
        LiveChatStore(db_path).list_messages(before=None, limit=1)
        conn = sqlite3.connect(str(db_path))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == _LATEST_SCHEMA_VERSION
        finally:
            conn.close()


def _seed_message(store: LiveChatStore, *, client_id: str, now: float = 1.0) -> int:
    message, _ = store.create_message(
        client_id=client_id,
        sender="Josh",
        device_id="device-drawing-anchor",
        by_email=None,
        text="anchor message",
        attachment_ids=(),
        now=now,
    )
    return message.seq


class TestCreateDrawing:
    def test_creates_a_drawing_with_its_first_stroke(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-cd-1")
        drawing, created = store.create_drawing(
            client_id="draw-client-1",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email="josh@example.com",
            stroke_id="stroke-1",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=[(1, 2), (3, 4)],
            now=100.0,
        )
        assert created is True
        assert drawing.rev == 1
        assert drawing.anchor_message_seq == seq
        assert drawing.column_width == 390.0
        assert len(drawing.strokes) == 1
        assert drawing.strokes[0].ord == 0
        assert drawing.strokes[0].points == ((1, 2), (3, 4))
        assert drawing.by_email == "josh@example.com"

    def test_a_repeated_client_id_returns_the_same_drawing_and_writes_no_second_event(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-cd-2")
        first, created_first = store.create_drawing(
            client_id="draw-client-repeat",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email=None,
            stroke_id="stroke-1",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=[(1, 2)] * 2,
            now=100.0,
        )
        second, created_second = store.create_drawing(
            client_id="draw-client-repeat",
            anchor_seq=seq,
            column_width=999.0,  # a genuinely different body — still the SAME drawing
            sender="Someone Else",
            device_id="device-2",
            by_email=None,
            stroke_id="stroke-different",
            color=DRAWING_COLORS[1],
            width=DRAWING_WIDTHS[1],
            points=[(9, 9)] * 2,
            now=200.0,
        )
        assert created_first is True
        assert created_second is False
        assert first.id == second.id
        assert first.rev == second.rev == 1
        assert [e.type for e in store.events_after(0)] == ["message", "message_updated"]

    def test_an_unknown_anchor_seq_raises_not_found(self, store: LiveChatStore) -> None:
        with pytest.raises(DrawingAnchorNotFoundError):
            store.create_drawing(
                client_id="draw-client-orphan",
                anchor_seq=999999,
                column_width=390.0,
                sender="Josh",
                device_id="device-1",
                by_email=None,
                stroke_id="stroke-1",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=100.0,
            )
        assert store.events_after(0) == []

    def test_a_deleted_anchor_also_raises_not_found(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-cd-deleted")
        store.delete_message(seq=seq, now=101.0)
        with pytest.raises(DrawingAnchorNotFoundError):
            store.create_drawing(
                client_id="draw-client-deleted-anchor",
                anchor_seq=seq,
                column_width=390.0,
                sender="Josh",
                device_id="device-1",
                by_email=None,
                stroke_id="stroke-1",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=100.0,
            )

    def test_the_twentieth_drawing_succeeds_and_the_twenty_first_is_full(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-cd-limit")
        for i in range(MAX_DRAWINGS_PER_ANCHOR):
            _, created = store.create_drawing(
                client_id=f"draw-client-limit-{i}",
                anchor_seq=seq,
                column_width=390.0,
                sender="Josh",
                device_id="device-1",
                by_email=None,
                stroke_id="stroke-1",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=100.0 + i,
            )
            assert created is True
        with pytest.raises(DrawingLimitExceededError):
            store.create_drawing(
                client_id="draw-client-limit-overflow",
                anchor_seq=seq,
                column_width=390.0,
                sender="Josh",
                device_id="device-1",
                by_email=None,
                stroke_id="stroke-1",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=999.0,
            )

    def test_column_width_out_of_bounds_hits_the_check_constraint(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-cd-check")
        with pytest.raises(sqlite3.IntegrityError):
            store.create_drawing(
                client_id="draw-client-bad-width",
                anchor_seq=seq,
                column_width=199.0,
                sender="Josh",
                device_id="device-1",
                by_email=None,
                stroke_id="stroke-1",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=100.0,
            )


class TestAppendStroke:
    def _drawing_id(self, store: LiveChatStore, seq: int) -> int:
        drawing, _ = store.create_drawing(
            client_id="draw-client-append-base",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email=None,
            stroke_id="stroke-0",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=[(1, 2)] * 2,
            now=100.0,
        )
        return drawing.id

    def test_appends_a_stroke_bumping_rev_and_ord(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-append-1")
        drawing_id = self._drawing_id(store, seq)
        updated = store.append_stroke(
            drawing_id=drawing_id,
            stroke_id="stroke-1",
            color=DRAWING_COLORS[1],
            width=DRAWING_WIDTHS[1],
            points=[(5, 6), (7, 8)],
            now=200.0,
        )
        assert updated.rev == 2
        assert [s.ord for s in updated.strokes] == [0, 1]
        assert updated.strokes[1].color == DRAWING_COLORS[1]
        # One "message_updated" from `_drawing_id`'s own create_drawing, one more here.
        assert [e.type for e in store.events_after(0)] == [
            "message",
            "message_updated",
            "message_updated",
        ]

    def test_a_repeated_stroke_id_is_a_no_op_and_writes_no_second_event(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-append-2")
        drawing_id = self._drawing_id(store, seq)
        store.append_stroke(
            drawing_id=drawing_id,
            stroke_id="stroke-1",
            color=DRAWING_COLORS[1],
            width=DRAWING_WIDTHS[1],
            points=[(5, 6)] * 2,
            now=200.0,
        )
        again = store.append_stroke(
            drawing_id=drawing_id,
            stroke_id="stroke-1",
            color=DRAWING_COLORS[2],  # different body — the repeat still changes nothing
            width=DRAWING_WIDTHS[2],
            points=[(9, 9)] * 2,
            now=300.0,
        )
        assert again.rev == 2
        assert len(again.strokes) == 2
        assert again.strokes[1].color == DRAWING_COLORS[1]  # the FIRST write wins
        # "message" (seed) + "message_updated" (create_drawing) + "message_updated" (the
        # first, real append) — the repeat itself adds no third.
        assert [e.type for e in store.events_after(0)] == [
            "message",
            "message_updated",
            "message_updated",
        ]

    def test_an_unknown_drawing_id_raises_not_found(self, store: LiveChatStore) -> None:
        with pytest.raises(DrawingNotFoundError):
            store.append_stroke(
                drawing_id=999999,
                stroke_id="stroke-1",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=100.0,
            )

    def test_the_two_hundredth_stroke_succeeds_and_the_next_is_full(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-append-limit")
        drawing_id = self._drawing_id(store, seq)  # stroke 0 already exists
        for i in range(1, MAX_STROKES_PER_DRAWING):
            store.append_stroke(
                drawing_id=drawing_id,
                stroke_id=f"stroke-{i}",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=100.0 + i,
            )
        with pytest.raises(DrawingLimitExceededError):
            store.append_stroke(
                drawing_id=drawing_id,
                stroke_id="stroke-overflow",
                color=DRAWING_COLORS[0],
                width=DRAWING_WIDTHS[0],
                points=[(1, 2)] * 2,
                now=999.0,
            )

    def test_concurrent_appends_from_two_connections_both_persist_with_distinct_ord(
        self, db_path: Path
    ) -> None:
        """spec §7: "Add a concurrency test where two connections draw on the same
        anchor." `_write_txn`'s `BEGIN IMMEDIATE` serializes the two threads at the
        SQLite level — neither append is lost, and `ord`/`stroke_id` stay distinct."""
        store_a = LiveChatStore(db_path)
        store_b = LiveChatStore(db_path)
        seq = _seed_message(store_a, client_id="client-concurrent-anchor")
        drawing_id = self._drawing_id(store_a, seq)

        barrier = threading.Barrier(2)
        errors: list[BaseException] = []

        def _append(which_store: LiveChatStore, stroke_id: str, ordinal_hint: int) -> None:
            try:
                barrier.wait(timeout=5)
                which_store.append_stroke(
                    drawing_id=drawing_id,
                    stroke_id=stroke_id,
                    color=DRAWING_COLORS[0],
                    width=DRAWING_WIDTHS[0],
                    points=[(ordinal_hint, ordinal_hint)] * 2,
                    now=time.time(),
                )
            except BaseException as exc:  # noqa: BLE001 - surfaced via `errors` below
                errors.append(exc)

        t1 = threading.Thread(target=_append, args=(store_a, "stroke-concurrent-a", 1))
        t2 = threading.Thread(target=_append, args=(store_b, "stroke-concurrent-b", 2))
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert errors == []
        final = store_a.get_drawings_for_message(seq=seq)[0]
        stroke_ids = {s.stroke_id for s in final.strokes}
        assert {"stroke-concurrent-a", "stroke-concurrent-b"} <= stroke_ids
        ords = [s.ord for s in final.strokes]
        assert len(ords) == len(set(ords)), "ord must stay distinct under concurrent append"
        assert final.rev == 3  # base stroke (rev 1) + two concurrent appends


class TestDeleteDrawing:
    def _drawing_id(self, store: LiveChatStore, seq: int) -> int:
        drawing, _ = store.create_drawing(
            client_id="draw-client-delete-base",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email=None,
            stroke_id="stroke-0",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=[(1, 2)] * 2,
            now=100.0,
        )
        return drawing.id

    def test_deletes_the_drawing_and_its_strokes(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-delete-1")
        drawing_id = self._drawing_id(store, seq)
        assert store.delete_drawing(drawing_id=drawing_id, now=200.0) is True
        assert store.get_drawings_for_message(seq=seq) == []
        conn = sqlite3.connect(str(store._db_path))
        try:
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM drawing_strokes WHERE drawing_id = ?", (drawing_id,)
                ).fetchone()[0]
                == 0
            )
        finally:
            conn.close()
        # "message" (seed) + "message_updated" (create_drawing) + "message_updated" (delete).
        assert [e.type for e in store.events_after(0)] == [
            "message",
            "message_updated",
            "message_updated",
        ]

    def test_deleting_twice_is_idempotent_and_writes_no_second_event(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-delete-2")
        drawing_id = self._drawing_id(store, seq)
        assert store.delete_drawing(drawing_id=drawing_id, now=200.0) is True
        assert store.delete_drawing(drawing_id=drawing_id, now=300.0) is False
        assert [e.type for e in store.events_after(0)] == [
            "message",
            "message_updated",
            "message_updated",
        ]

    def test_deleting_an_unknown_drawing_is_a_no_op(self, store: LiveChatStore) -> None:
        assert store.delete_drawing(drawing_id=999999, now=100.0) is False
        assert store.events_after(0) == []


class TestGetDrawingsForMessage:
    def test_orders_drawings_by_id_and_strokes_by_ord(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-order")
        first, _ = store.create_drawing(
            client_id="draw-order-1",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email=None,
            stroke_id="s0",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=[(1, 1)] * 2,
            now=100.0,
        )
        second, _ = store.create_drawing(
            client_id="draw-order-2",
            anchor_seq=seq,
            column_width=390.0,
            sender="Purdy",
            device_id="device-2",
            by_email=None,
            stroke_id="s0",
            color=DRAWING_COLORS[1],
            width=DRAWING_WIDTHS[1],
            points=[(2, 2)] * 2,
            now=101.0,
        )
        store.append_stroke(
            drawing_id=first.id,
            stroke_id="s1",
            color=DRAWING_COLORS[2],
            width=DRAWING_WIDTHS[2],
            points=[(3, 3)] * 2,
            now=102.0,
        )
        drawings = store.get_drawings_for_message(seq=seq)
        assert [d.id for d in drawings] == [first.id, second.id]
        assert [s.ord for s in drawings[0].strokes] == [0, 1]

    def test_a_message_with_no_drawings_returns_an_empty_list(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-no-drawings")
        assert store.get_drawings_for_message(seq=seq) == []


class TestMessageJsonCarriesOnlyTheSummary:
    def test_the_message_row_and_wire_shape_carry_id_and_rev_only(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-summary")
        drawing, _ = store.create_drawing(
            client_id="draw-summary-1",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email=None,
            stroke_id="s0",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=[(1234, 5678), (2345, 6789)],
            now=100.0,
        )
        message = store.get_messages([seq])[0]
        assert len(message.drawings) == 1
        assert message.drawings[0].id == drawing.id
        assert message.drawings[0].rev == drawing.rev
        # DrawingSummary is a frozen, slotted 2-field dataclass — there is no attribute
        # to carry a stroke or a point onto the Message wire shape at all.
        field_names = {f.name for f in dataclasses.fields(message.drawings[0])}
        assert field_names == {"id", "rev"}


class TestCascadeErasure:
    """spec §6: deleting the anchor message, deleting the drawing directly, and a wipe
    must all remove strokes/drawings, and the raw bytes of a stroke's points must be
    gone from `server.db` and its WAL afterward (Inv 40/46)."""

    _SENTINEL_POINTS: list[tuple[int, int]] = [(1234, 5678), (2345, 6789), (3456, 7890)]

    def _seed_drawing(self, store: LiveChatStore, seq: int) -> int:
        drawing, _ = store.create_drawing(
            client_id="draw-erasure-1",
            anchor_seq=seq,
            column_width=390.0,
            sender="Josh",
            device_id="device-1",
            by_email=None,
            stroke_id="stroke-sentinel",
            color=DRAWING_COLORS[0],
            width=DRAWING_WIDTHS[0],
            points=self._SENTINEL_POINTS,
            now=100.0,
        )
        return drawing.id

    def test_deleting_the_drawing_directly_removes_the_raw_bytes(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-erasure-drawing")
        drawing_id = self._seed_drawing(store, seq)
        assert b"5678" in _raw_bytes(store)
        store.delete_drawing(drawing_id=drawing_id, now=200.0)
        store.scrub(deadline_s=30.0)
        assert b"1234" not in _raw_bytes(store)
        assert b"5678" not in _raw_bytes(store)
        assert b"6789" not in _raw_bytes(store)

    def test_deleting_the_anchor_message_cascades_and_removes_the_raw_bytes(
        self, store: LiveChatStore
    ) -> None:
        seq = _seed_message(store, client_id="client-erasure-anchor")
        self._seed_drawing(store, seq)
        store.delete_message(seq=seq, now=200.0)
        store.scrub(deadline_s=30.0)
        assert store.get_drawings_for_message(seq=seq) == []
        raw = _raw_bytes(store)
        assert b"1234" not in raw
        assert b"5678" not in raw
        assert b"6789" not in raw

    def test_an_older_process_that_never_heard_of_drawings_still_cascades_them(
        self, db_path: Path
    ) -> None:
        """The FK is enforced by SQLite itself with `foreign_keys=ON` (Inv 49's own
        reactions precedent) — a raw `DELETE FROM messages` issued by a connection
        that has never imported `models.DrawingRow`/`store.py`'s drawing methods at
        all still removes the drawing and its strokes, because the cascade lives in
        the schema, not in application code."""
        store = LiveChatStore(db_path)
        seq = _seed_message(store, client_id="client-erasure-older-process")
        self._seed_drawing(store, seq)

        raw_conn = sqlite3.connect(str(db_path))
        try:
            raw_conn.execute("PRAGMA foreign_keys = ON")
            raw_conn.execute("DELETE FROM messages WHERE seq = ?", (seq,))
            raw_conn.commit()
        finally:
            raw_conn.close()

        assert (
            sqlite3.connect(str(db_path)).execute("SELECT COUNT(*) FROM drawings").fetchone()[0]
            == 0
        )
        assert (
            sqlite3.connect(str(db_path))
            .execute("SELECT COUNT(*) FROM drawing_strokes")
            .fetchone()[0]
            == 0
        )

    def test_wipe_removes_the_raw_bytes(self, store: LiveChatStore) -> None:
        seq = _seed_message(store, client_id="client-erasure-wipe")
        self._seed_drawing(store, seq)
        store.wipe(now=200.0)
        store.scrub(deadline_s=30.0)
        raw = _raw_bytes(store)
        assert b"1234" not in raw
        assert b"5678" not in raw
        assert b"6789" not in raw
        assert [e.type for e in store.events_after(0)][-1] == "wiped"
