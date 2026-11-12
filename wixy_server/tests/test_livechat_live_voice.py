"""Live voice notes, server side (spec/server-chat/07-live-voice-notes.md, decisions/00211, Inv 58):
the `listen` upload and its `live` attachment, the pause/resume state, the decoder and the listener
socket over real local sockets with real ffmpeg, credit-limited audio from the start / the live edge
/ a sample, the end of a note (eof, then the normal pipeline to `ready`), delete-for-everyone, the
auto-end rules under an injected clock, restart recovery, and the wire contract's exact shapes.
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from pydantic import ValidationError

from wixy_server.livechat import live_voice, uploads
from wixy_server.livechat.call_protocol import HEADER
from wixy_server.livechat.live_voice import PeakTracker, StallClock, frame_peak
from wixy_server.livechat.live_voice_protocol import COMMAND, KIND_LIVE_VOICE, pack_frame
from wixy_server.livechat.models import UploadRow
from wixy_server.livechat.store import _LATEST_SCHEMA_VERSION, LiveChatStore
from wixy_server.tests.live_voice_testkit import (
    DEVICE,
    UPLOADS,
    LiveEnv,
    live_env,
    make_webm,
    make_wixy_repo,
    slices_of,
    wait_for,
)


@pytest.fixture(scope="module")
def repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_wixy_repo(tmp_path_factory.mktemp("repo"))


@pytest.fixture(scope="module")
def note_slices(tmp_path_factory: pytest.TempPathFactory) -> list[bytes]:
    """A 12 s opus-in-webm recording cut into 12 byte-range slices."""
    return slices_of(make_webm(tmp_path_factory.mktemp("audio") / "note.webm"))


@pytest.fixture(autouse=True)
def _fast_state_cadence(monkeypatch: pytest.MonkeyPatch) -> None:
    """The once-a-second state cadence, shortened so tests wait for it in milliseconds."""
    monkeypatch.setattr(live_voice, "STATE_INTERVAL_S", 0.05)


@pytest.fixture
def env(tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[LiveEnv]:
    with live_env(tmp_path, repo, monkeypatch) as live:
        yield live


class ManualClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def parse_frame(data: bytes) -> dict[str, Any]:
    version, kind, reserved, att, seq, sample, capture, playout, padding = HEADER.unpack_from(data)
    return {
        "version": version,
        "kind": kind,
        "reserved": reserved,
        "id": UUID(bytes=att).hex,
        "seq": seq,
        "sample": sample,
        "capture": capture,
        "playout": playout,
        "padding": padding,
        "pcm": data[HEADER.size :],
    }


def put_all(env: LiveEnv, upload_id: str, slices: list[bytes], *, upto: int | None = None) -> None:
    for index, piece in enumerate(slices[: len(slices) if upto is None else upto]):
        assert env.put(upload_id, index, piece).status_code == 204


def put_all_from(
    env: LiveEnv, upload_id: str, slices: list[bytes], *, start: int, stop: int
) -> None:
    for index in range(start, stop):
        assert env.put(upload_id, index, slices[index]).status_code == 204


def decoded_frames(env: LiveEnv, att_id: str) -> int:
    note = env.hub.notes.get(att_id)
    return note.ring_end if note is not None else 0


def watch(sock: Any, att_id: str) -> None:
    sock.send(type="watch", attachmentId=att_id)


def play(sock: Any, att_id: str, start: Any) -> None:
    sock.send(**{"type": "play", "attachmentId": att_id, "from": start})


# ---------------------------------------------------------------------------
# The pure pieces
# ---------------------------------------------------------------------------


class TestWireContract:
    def test_a_frame_is_the_calls_header_with_kind_two_and_the_attachment_id(self) -> None:
        att_id = "ab" * 16
        pcm = bytes(range(240)) * 4
        frame = pack_frame(att_id, seq=7, sample=480 * 9, pcm=pcm)
        assert len(frame) == 1008 == HEADER.size + 960
        assert frame[0] == 1 and frame[1] == KIND_LIVE_VOICE == 2 and frame[2:4] == b"\x00\x00"
        assert frame[4:20] == bytes.fromhex(att_id)
        assert int.from_bytes(frame[20:24], "big") == 7
        assert int.from_bytes(frame[24:32], "big") == 4320
        assert frame[32:40] == bytes(8) and frame[40:48] == bytes(8)
        assert frame[48:] == pcm

    @pytest.mark.parametrize(
        "text",
        [
            '{"type":"watch","attachmentId":"' + "a" * 32 + '"}',
            '{"type":"unwatch","attachmentId":"' + "a" * 32 + '"}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":"start"}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":"live"}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":0}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":48000}',
            '{"type":"stop","attachmentId":"' + "a" * 32 + '"}',
            '{"type":"credit","attachmentId":"' + "a" * 32 + '","frames":1}',
            '{"type":"credit","attachmentId":"' + "a" * 32 + '","frames":500}',
            '{"type":"pong"}',
        ],
    )
    def test_every_documented_command_parses(self, text: str) -> None:
        COMMAND.validate_json(text)

    @pytest.mark.parametrize(
        "text",
        [
            '{"type":"watch"}',
            '{"type":"watch","attachmentId":"short"}',
            '{"type":"watch","attachmentId":"' + "A" * 32 + '"}',  # upper case is not an id
            '{"type":"watch","attachmentId":"' + "a" * 32 + '","extra":1}',  # unknown field
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":-1}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":"middle"}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":1.5}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '","from":true}',
            '{"type":"play","attachmentId":"' + "a" * 32 + '"}',
            '{"type":"credit","attachmentId":"' + "a" * 32 + '","frames":0}',
            '{"type":"credit","attachmentId":"' + "a" * 32 + '","frames":501}',
            '{"type":"credit","attachmentId":"' + "a" * 32 + '","frames":"5"}',
            '{"type":"pong","x":1}',
            '{"type":"ping"}',
            "[]",
            "not json",
        ],
    )
    def test_strict_json_rejects_everything_else(self, text: str) -> None:
        with pytest.raises(ValidationError):
            COMMAND.validate_json(text)


class TestPeaksAndStallClock:
    def test_a_frames_peak_is_its_loudest_sample_on_a_0_to_255_scale(self) -> None:
        silent = bytes(960)
        loud = (32767).to_bytes(2, "little", signed=True) * 480
        negative = (-32768).to_bytes(2, "little", signed=True) * 480
        half = (16384).to_bytes(2, "little", signed=True) * 480
        assert frame_peak(silent) == 0
        assert frame_peak(loud) == 255
        assert frame_peak(negative) == 255
        assert frame_peak(half) == 128

    def test_one_bucket_a_second_the_last_partial_one_only_when_flushed(self) -> None:
        tracker = PeakTracker()
        quiet = (1000).to_bytes(2, "little", signed=True) * 480
        loud = (20000).to_bytes(2, "little", signed=True) * 480
        for index in range(50):
            tracker.add(loud if index == 20 else quiet)
        assert tracker.peaks == [frame_peak(loud)]
        for _ in range(10):
            tracker.add(quiet)
        assert len(tracker.peaks) == 1  # the second is not complete yet
        tracker.flush()
        assert tracker.peaks == [frame_peak(loud), frame_peak(quiet)]
        tracker.flush()
        assert len(tracker.peaks) == 2  # nothing left to flush

    def test_stall_counts_only_while_input_is_pending_and_resets_on_output(self) -> None:
        clock = StallClock(stall_s=120.0, ceiling_s=10_000.0, now=0.0)
        assert clock.tick(500.0, frozen=False) is None  # nothing fed: idle is not a stall
        clock.fed()
        assert clock.tick(600.0, frozen=False) is None  # 100 s pending
        clock.progressed()
        assert clock.tick(700.0, frozen=False) is None  # output arrived: reset
        clock.fed()
        assert clock.tick(819.0, frozen=False) is None
        assert clock.tick(821.0, frozen=False) == "stall"

    def test_the_stall_clock_is_frozen_while_the_sender_is_paused(self) -> None:
        clock = StallClock(stall_s=120.0, ceiling_s=10_000.0, now=0.0)
        clock.fed()
        assert clock.tick(100.0, frozen=False) is None
        # A half-hour pause adds nothing, however long it lasts...
        assert clock.tick(100.0 + 1800.0, frozen=True) is None
        assert clock.tick(100.0 + 1800.0 + 10.0, frozen=False) is None
        # ...and the 10 s still owed before the 120 s rule fires are the ones that count.
        assert clock.tick(100.0 + 1800.0 + 10.0 + 9.0, frozen=False) is None
        assert clock.tick(100.0 + 1800.0 + 10.0 + 9.0 + 2.0, frozen=False) == "stall"

    def test_the_ceiling_bounds_a_run_that_keeps_making_progress_but_never_ends(self) -> None:
        clock = StallClock(stall_s=120.0, ceiling_s=1000.0, now=0.0)
        now = 0.0
        verdict = None
        while verdict is None and now < 5000.0:
            now += 50.0
            clock.fed()
            clock.progressed()
            verdict = clock.tick(now, frozen=False)
        assert verdict == "ceiling" and now == 1050.0


# ---------------------------------------------------------------------------
# Schema v23 and the store
# ---------------------------------------------------------------------------


class TestStore:
    def test_the_live_state_column_exists_and_defaults_to_not_live(self, tmp_path: Path) -> None:
        db = tmp_path / "server" / "server.db"
        store = LiveChatStore(db)
        store.pending_upload_bytes()
        assert _LATEST_SCHEMA_VERSION == 23
        conn = sqlite3.connect(str(db))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 23
            info = {row[1]: row for row in conn.execute("PRAGMA table_info(attachments)")}
        finally:
            conn.close()
        assert "live_state" in info and info["live_state"][4] is None

    def test_a_v22_database_migrates_and_its_attachments_stay_ordinary(
        self, tmp_path: Path
    ) -> None:
        db = tmp_path / "server" / "server.db"
        store = LiveChatStore(db)
        store.create_attachment(att_id="a" * 32, kind="voice", now=1.0)
        conn = sqlite3.connect(str(db))
        try:
            conn.execute("ALTER TABLE attachments DROP COLUMN live_state")
            conn.execute("PRAGMA user_version = 22")
            conn.commit()
        finally:
            conn.close()
        migrated = LiveChatStore(db)
        old = migrated.get_attachment("a" * 32)
        assert old is not None and (old.status, old.live_state) == ("processing", None)
        conn = sqlite3.connect(str(db))
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 23
        finally:
            conn.close()

    def test_a_live_note_is_never_claimed_nor_swept_as_an_orphan(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server" / "server.db")
        row = uploads.init_upload(
            store=store,
            kind="voice",
            mime_type="audio/webm",
            size_bytes=0,
            filename=None,
            by_email=None,
            chunk_bytes=1 << 20,
            quota_bytes=10**12,
            min_free_bytes=0,
            media_available=True,
            disk_check_path=tmp_path,
            now=5.0,
            disk_usage=lambda _p: (10**12, 0, 10**12),
            live=True,
            device_id=DEVICE,
            listen=True,
        )
        assert row.attachment is not None and row.attachment.status == "live"
        assert store.claim_processing(owner="w", now=100.0, lease_s=60.0) is None
        assert store.orphan_attachment_ids(older_than=10**9) == []
        ended = store.end_live(row.upload_id, now=6.0)
        assert ended is not None and (ended.status, ended.live_state) == ("processing", None)
        claimed = store.claim_processing(owner="w", now=100.0, lease_s=60.0)
        assert claimed is not None and claimed.id == row.upload_id

    def test_the_drain_lease_holds_the_queue_off_until_released(self, tmp_path: Path) -> None:
        store = LiveChatStore(tmp_path / "server" / "server.db")
        store.create_live_upload(
            UploadRow(
                id="b" * 32,
                kind="voice",
                mime="audio/webm",
                size_bytes=0,
                filename=None,
                by_email=None,
                created_at=1.0,
                live=True,
                device_id=DEVICE,
            ),
            now=1.0,
            max_live=2,
        )
        store.end_live("b" * 32, now=2.0, lease_owner="live-drain", lease_s=120.0)
        assert store.claim_processing(owner="w", now=3.0, lease_s=60.0) is None
        assert store.release_lease("b" * 32, owner="someone-else") is False
        assert store.release_lease("b" * 32, owner="live-drain") is True
        assert store.claim_processing(owner="w", now=3.0, lease_s=60.0) is not None


# ---------------------------------------------------------------------------
# The sender's HTTP side
# ---------------------------------------------------------------------------


class TestListenUpload:
    def test_listen_creates_the_attachment_row_in_status_live(self, env: LiveEnv) -> None:
        response = env.init()
        assert response.status_code == 201
        body = response.json()
        assert set(body) == {"uploadId", "chunkBytes", "maxBytes", "attachment"}
        attachment = body["attachment"]
        assert attachment["id"] == body["uploadId"]
        assert attachment["status"] == "live" and attachment["liveState"] == "recording"
        assert attachment["durationS"] == 0 and attachment["peaks"] == []
        assert attachment["kind"] == "voice" and attachment["urls"] == {}
        assert attachment["transcript"] is None and attachment["retryable"] is False
        upload = env.store.get_upload(body["uploadId"])
        assert upload is not None and upload.live and upload.device_id == DEVICE

    def test_listen_needs_live(self, env: LiveEnv) -> None:
        response = env.client.post(
            UPLOADS,
            json={
                "kind": "voice",
                "mimeType": "audio/webm",
                "sizeBytes": 100,
                "listen": True,
            },
            headers=env.headers,
        )
        assert response.status_code == 422

    def test_a_plain_live_upload_creates_no_attachment_and_has_no_live_state(
        self, env: LiveEnv
    ) -> None:
        body = env.init(listen=False).json()
        assert "attachment" not in body
        assert env.store.get_attachment(body["uploadId"]) is None

    def test_a_chat_records_two_live_notes_at_most(self, env: LiveEnv) -> None:
        first, second = env.init(), env.init()
        assert (first.status_code, second.status_code) == (201, 201)
        third = env.init()
        assert third.status_code == 409 and third.json() == {"error": "too_many_live"}
        # The client falls back to an ordinary (spec 06) live recording, which is not limited.
        assert env.init(listen=False).status_code == 201
        # Discarding an unsent live note frees its place.
        assert (
            env.client.delete(f"{UPLOADS}/{first.json()['uploadId']}", headers=env.headers)
        ).status_code == 204
        assert env.store.get_attachment(first.json()["uploadId"]) is None
        assert env.init().status_code == 201

    def test_the_message_is_sent_at_once_with_the_live_attachment(self, env: LiveEnv) -> None:
        hooked: list[int] = []

        async def hook(message: Any) -> None:
            hooked.append(message.seq)

        env.app.state.livechat_message_hooks.append(hook)
        note = env.start_note()
        wait_for(lambda: hooked == [note.seq])  # the push hook runs as for any message
        attachment = env.attachment(note.upload_id)
        assert attachment["status"] == "live" and attachment["liveState"] == "recording"
        row = env.store.get_attachment(note.upload_id)
        assert row is not None and row.message_seq == note.seq

    def test_a_late_slice_after_the_recording_ended_is_refused_and_not_stored(
        self, tmp_path: Path, repo: Path, note_slices: list[bytes], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The media worker is parked so the note is still `processing` when the late slice comes.
        with live_env(tmp_path, repo, monkeypatch, media_worker=False) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=3)
            assert env.complete(note.upload_id, 3).status_code == 202
            late = env.put(note.upload_id, 3, note_slices[3])
            assert late.status_code == 409 and late.json() == {"error": "not_live"}
            assert not (env.paths.server_upload_dir(note.upload_id) / "chunk-000003").exists()

    def test_slices_keep_the_spec_06_ordering_rules(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        assert env.put(note.upload_id, 0, note_slices[0]).status_code == 204
        gap = env.put(note.upload_id, 2, note_slices[2])
        assert gap.status_code == 409 and gap.json() == {"error": "out_of_order", "next": 1}
        assert env.put(note.upload_id, 0, note_slices[0]).status_code == 204  # idempotent


class TestLiveState:
    def test_pause_and_resume_are_idempotent_and_each_real_change_is_one_event(
        self, env: LiveEnv
    ) -> None:
        note = env.start_note()
        before = env.updates(note.seq)
        assert env.live_state(note.upload_id, "paused").status_code == 204
        assert env.attachment(note.upload_id)["liveState"] == "paused"
        assert env.updates(note.seq) == before + 1
        assert env.live_state(note.upload_id, "paused").status_code == 204  # a repeat
        assert env.updates(note.seq) == before + 1
        assert env.live_state(note.upload_id, "recording").status_code == 204
        assert env.attachment(note.upload_id)["liveState"] == "recording"
        assert env.updates(note.seq) == before + 2

    def test_unknown_and_non_live_uploads_are_404_and_bad_bodies_are_422(
        self, env: LiveEnv
    ) -> None:
        assert env.live_state("0" * 32, "paused").status_code == 404
        assert env.live_state("not-an-id", "paused").status_code == 404
        plain = env.init(listen=False).json()["uploadId"]  # a live upload nobody can hear
        assert env.live_state(plain, "paused").status_code == 404
        note = env.start_note()
        bad = env.client.post(
            f"{UPLOADS}/{note.upload_id}/live-state", json={"state": "ended"}, headers=env.headers
        )
        assert bad.status_code == 422
        extra = env.client.post(
            f"{UPLOADS}/{note.upload_id}/live-state",
            json={"state": "paused", "x": 1},
            headers=env.headers,
        )
        assert extra.status_code == 422

    def test_once_the_recording_ended_a_state_change_is_409_not_live(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=2)
        assert env.complete(note.upload_id, 2).status_code == 202
        ended = env.live_state(note.upload_id, "paused")
        assert ended.status_code == 409 and ended.json() == {"error": "not_live"}


# ---------------------------------------------------------------------------
# The listener socket, real ffmpeg
# ---------------------------------------------------------------------------


class TestWatching:
    def test_state_and_peaks_grow_as_slices_arrive(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        with env.socket() as sock:
            watch(sock, note.upload_id)
            sock.until(lambda: sock.of("state", note.upload_id))
            first = sock.of("state", note.upload_id)[0]
            assert first == {
                "type": "state",
                "attachmentId": note.upload_id,
                "state": "recording",
                "durationMs": 0,
                "peaksFrom": 0,
                "peaks": [],
            }
            put_all(env, note.upload_id, note_slices)
            peaks: list[int] = []

            def collect() -> bool:
                for message in sock.of("state", note.upload_id):
                    assert message["peaksFrom"] <= len(peaks)  # never a gap
                    peaks[message["peaksFrom"] :] = message["peaks"]
                sock.messages.clear()
                return len(peaks) >= 11

            sock.until(collect)
            assert all(20 <= p <= 45 for p in peaks)  # a steady tone, loudness 0..255
        assert 11_000 <= env.hub.notes[note.upload_id].duration_ms <= 12_100

    def test_nothing_about_the_growth_goes_through_the_events_table(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        before = env.updates(note.seq)
        with env.socket() as sock:
            watch(sock, note.upload_id)
            put_all(env, note.upload_id, note_slices, upto=6)
            sock.until(lambda: any(m["durationMs"] >= 3000 for m in sock.of("state")))
        assert env.updates(note.seq) == before  # only status / liveState / transcript passes

    def test_pause_and_resume_reach_the_listener_at_once(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        with env.socket() as sock:
            watch(sock, note.upload_id)
            sock.until(lambda: sock.of("state"))
            env.live_state(note.upload_id, "paused")
            sock.until(lambda: any(m["state"] == "paused" for m in sock.of("state")))
            env.live_state(note.upload_id, "recording")
            sock.until(lambda: sock.of("state")[-1]["state"] == "recording")

    def test_a_late_watcher_gets_the_whole_peaks_array_from_zero(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 5 * 50)
        with env.socket() as sock:
            watch(sock, note.upload_id)
            sock.until(lambda: sock.of("state"))
            first = sock.of("state")[0]
            assert first["peaksFrom"] == 0 and len(first["peaks"]) >= 4
            assert first["durationMs"] >= 4000

    def test_unwatch_stops_the_state_messages(self, env: LiveEnv, note_slices: list[bytes]) -> None:
        note = env.start_note()
        with env.socket() as sock:
            watch(sock, note.upload_id)
            sock.until(lambda: sock.of("state"))
            sock.send(type="unwatch", attachmentId=note.upload_id)
            wait_for(lambda: not any(env.hub.listeners[k].watches for k in env.hub.listeners))


class TestPlaying:
    def test_play_from_the_start_sends_exactly_the_credit_and_numbers_the_frames(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 200)
        with env.socket() as sock:
            play(sock, note.upload_id, "start")
            sock.until(lambda: sock.of("state"))  # play implies watch
            assert sock.frames == []  # nothing without credit
            sock.send(type="credit", attachmentId=note.upload_id, frames=5)
            sock.until(lambda: len(sock.frames) == 5)
            frames = [parse_frame(f) for f in sock.frames]
            assert [f["seq"] for f in frames] == [0, 1, 2, 3, 4]
            assert [f["sample"] for f in frames] == [0, 480, 960, 1440, 1920]
            for f in frames:
                assert (f["version"], f["kind"], f["reserved"]) == (1, 2, 0)
                assert f["id"] == note.upload_id
                assert (f["capture"], f["playout"], f["padding"]) == (0, 0, bytes(8))
                assert len(f["pcm"]) == 960
            (listener,) = env.hub.listeners.values()
            assert listener.stream is not None
            assert (listener.stream.credit, listener.stream.seq) == (0, 5)  # never over credit
            sock.send(type="credit", attachmentId=note.upload_id, frames=3)
            sock.until(lambda: len(sock.frames) == 8)
            assert [parse_frame(f)["sample"] for f in sock.frames[5:]] == [2400, 2880, 3360]
            assert listener.stream.credit == 0

    def test_the_audio_is_the_recorded_tone_not_silence(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 200)
        with env.socket() as sock:
            play(sock, note.upload_id, "start")
            sock.send(type="credit", attachmentId=note.upload_id, frames=100)
            sock.until(lambda: len(sock.frames) == 100)
        loud = [frame_peak(parse_frame(f)["pcm"]) for f in sock.frames[10:]]
        assert all(20 <= p <= 45 for p in loud)

    def test_play_from_the_live_edge_starts_at_the_newest_audio(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 200)
        edge_before = decoded_frames(env, note.upload_id)
        with env.socket() as sock:
            play(sock, note.upload_id, "live")
            sock.send(type="credit", attachmentId=note.upload_id, frames=2)
            put_all_from(env, note.upload_id, note_slices, start=6, stop=8)
            sock.until(lambda: len(sock.frames) == 2)
            first = parse_frame(sock.frames[0])
            assert first["sample"] >= edge_before * 480 and first["sample"] % 480 == 0
            assert first["seq"] == 0

    @pytest.mark.parametrize(
        ("start", "expected"), [(24000, 24000), (24100, 24000), (479, 0), (480 * 7, 480 * 7)]
    )
    def test_play_from_a_sample_index_is_aligned_down_to_a_frame(
        self, env: LiveEnv, note_slices: list[bytes], start: int, expected: int
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 200)
        with env.socket() as sock:
            play(sock, note.upload_id, start)
            sock.send(type="credit", attachmentId=note.upload_id, frames=1)
            sock.until(lambda: len(sock.frames) == 1)
            assert parse_frame(sock.frames[0])["sample"] == expected

    def test_a_sample_beyond_the_live_edge_joins_at_the_edge(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=4)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 100)
        edge = decoded_frames(env, note.upload_id)
        with env.socket() as sock:
            play(sock, note.upload_id, 10**9)
            sock.send(type="credit", attachmentId=note.upload_id, frames=1)
            put_all_from(env, note.upload_id, note_slices, start=4, stop=6)
            sock.until(lambda: len(sock.frames) == 1)
            assert parse_frame(sock.frames[0])["sample"] >= edge * 480

    def test_a_new_play_replaces_the_old_stream_and_stop_ends_it(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 200)
        with env.socket() as sock:
            play(sock, note.upload_id, "start")
            sock.send(type="credit", attachmentId=note.upload_id, frames=2)
            sock.until(lambda: len(sock.frames) == 2)
            play(sock, note.upload_id, 480 * 100)
            sock.send(type="credit", attachmentId=note.upload_id, frames=1)
            sock.until(lambda: len(sock.frames) == 3)
            third = parse_frame(sock.frames[2])
            assert (third["seq"], third["sample"]) == (0, 480 * 100)  # sequence is per `play`
            sock.send(type="stop", attachmentId=note.upload_id)
            wait_for(lambda: all(lst.stream is None for lst in env.hub.listeners.values()))
            sock.send(type="credit", attachmentId=note.upload_id, frames=5)  # a late top-up
            assert len(sock.frames) == 3

    def test_a_listener_behind_the_ring_is_fed_from_the_stored_slices_without_a_gap(
        self, env: LiveEnv, note_slices: list[bytes], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(live_voice, "RING_FRAMES", 100)  # two seconds of ring
        note = env.start_note()
        put_all(env, note.upload_id, note_slices)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 590)
        live = env.hub.notes[note.upload_id]
        assert live.ring_start > 400  # the start of the note is long out of the ring
        with env.socket() as sock:
            play(sock, note.upload_id, "start")
            (listener,) = env.hub.listeners.values()
            sock.send(type="credit", attachmentId=note.upload_id, frames=500)
            sock.until(lambda: len(sock.frames) == 500)
            assert listener.stream is not None and listener.stream.mode in ("backfill", "ring")
            sock.send(type="credit", attachmentId=note.upload_id, frames=500)
            end = live.ring_end
            sock.until(lambda: len(sock.frames) >= end)
            samples = [parse_frame(f)["sample"] for f in sock.frames]
            assert samples == [i * 480 for i in range(len(samples))]  # contiguous, none twice
            assert listener.stream is not None and listener.stream.mode == "ring"  # caught up


class TestEndOfANote:
    def test_complete_ends_the_stream_with_eof_and_the_note_becomes_the_finished_file(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 590)
        with env.socket() as sock:
            play(sock, note.upload_id, "start")
            sock.send(type="credit", attachmentId=note.upload_id, frames=500)
            sock.until(lambda: len(sock.frames) == 500)
            response = env.complete(note.upload_id, len(note_slices))
            assert response.status_code == 202
            assert response.json()["attachment"]["status"] in ("processing", "ready")
            sock.send(type="credit", attachmentId=note.upload_id, frames=500)
            sock.until(lambda: sock.of("eof", note.upload_id))
            eof = sock.of("eof", note.upload_id)[0]
            states = [m["state"] for m in sock.of("state", note.upload_id)]
            assert states[-1] == "ended"
            ended = sock.of("state", note.upload_id)[-1]
            assert 11_000 <= ended["durationMs"] <= 12_100
            assert 11 <= ended["peaksFrom"] + len(ended["peaks"]) <= 13
            # The last frame sent is the one that holds the end of the audio.
            last = parse_frame(sock.frames[-1])
            assert last["sample"] // 480 == (eof["sampleIndex"] - 1) // 480
            assert eof["sampleIndex"] == pytest.approx(ended["durationMs"] * 24, abs=24)
        env.wait_status(note.upload_id, "ready")
        finished = env.attachment(note.upload_id)
        assert finished["status"] == "ready" and "play" in finished["urls"]
        assert finished["durationS"] == pytest.approx(eof["sampleIndex"] / 24000, abs=0.5)
        assert "liveState" not in finished

    def test_the_live_phase_ends_with_one_event_and_a_drain_lease_is_released(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=5)
        before = env.updates(note.seq)
        assert env.complete(note.upload_id, 5).status_code == 202
        assert env.updates(note.seq) >= before + 1  # live -> processing is announced
        env.wait_status(note.upload_id, "ready")
        row = env.store.get_attachment(note.upload_id)
        assert row is not None and row.lease_owner is None
        assert "liveState" not in env.attachment(note.upload_id)

    def test_a_completed_note_with_no_listener_is_processed_like_any_voice_note(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices)
        assert env.complete(note.upload_id, len(note_slices)).status_code == 202
        env.wait_status(note.upload_id, "ready")
        attachment = env.attachment(note.upload_id)
        assert attachment["durationS"] == pytest.approx(12.0, abs=0.5)
        assert len(attachment["peaks"]) == 64  # the ordinary 64-bucket peaks
        # A second complete is the usual idempotent replay.
        assert env.complete(note.upload_id, len(note_slices)).status_code == 202

    def test_complete_with_a_missing_slice_is_409_and_the_note_stays_live(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=2)
        response = env.complete(note.upload_id, 4)
        assert response.status_code == 409 and response.json()["missing"] == [2, 3]
        row = env.store.get_attachment(note.upload_id)
        assert row is not None and row.status == "live"
        assert env.put(note.upload_id, 2, note_slices[2]).status_code == 204  # still recording


class TestDeleteForEveryone:
    def test_deleting_the_message_ends_the_decoder_and_tells_every_listener(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 200)
        live = env.hub.notes[note.upload_id]
        with env.socket() as sock:
            play(sock, note.upload_id, "start")
            sock.until(lambda: sock.of("state"))
            response = env.client.delete(
                f"/api/admin/server/messages/{note.seq}", headers=env.headers
            )
            assert response.status_code == 204
            sock.until(lambda: any(m["state"] == "ended" for m in sock.of("state")))
            wait_for(lambda: note.upload_id not in env.hub.notes)
            wait_for(live.decoder_done.is_set)
            (listener,) = env.hub.listeners.values()
            assert listener.stream is None and note.upload_id not in listener.watches
        assert env.store.get_attachment(note.upload_id) is None
        assert env.store.get_upload(note.upload_id) is None
        late = env.put(note.upload_id, 6, note_slices[6])
        assert late.status_code == 404
        wait_for(lambda: not env.paths.server_upload_dir(note.upload_id).exists())

    def test_wiping_the_chat_ends_every_live_note(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        first, second = env.start_note(), env.start_note()
        put_all(env, first.upload_id, note_slices, upto=3)
        with env.socket() as sock:
            watch(sock, first.upload_id)
            watch(sock, second.upload_id)
            sock.until(lambda: len(sock.of("state")) >= 2)
            response = env.client.post(
                "/api/admin/server/wipe", json={"confirm": "WIPE"}, headers=env.headers
            )
            assert response.status_code in (202, 204)
            sock.until(lambda: len([m for m in sock.of("state") if m["state"] == "ended"]) >= 2)
        assert env.hub.notes == {}
        assert env.store.live_attachment_ids() == []

    def test_discarding_an_unsent_live_note_ends_it_too(self, env: LiveEnv) -> None:
        note = env.start_note(send=False)
        assert note.seq == 0
        assert (
            env.client.delete(f"{UPLOADS}/{note.upload_id}", headers=env.headers).status_code == 204
        )
        assert env.store.get_attachment(note.upload_id) is None
        assert note.upload_id not in env.hub.notes


class TestSocketErrors:
    def test_every_error_code_in_the_contract(self, env: LiveEnv, note_slices: list[bytes]) -> None:
        done = env.start_note()
        put_all(env, done.upload_id, note_slices, upto=2)
        env.complete(done.upload_id, 2)
        sent = env.start_note()
        unsent = env.start_note(send=False)
        with env.socket() as sock:
            watch(sock, "0" * 32)
            sock.until(lambda: sock.of("error"))
            assert sock.of("error")[-1] == {
                "type": "error",
                "attachmentId": "0" * 32,
                "code": "not_found",
            }
            watch(sock, unsent.upload_id)  # unsent audio is not shared
            sock.until(lambda: len(sock.of("error")) == 2)
            assert sock.of("error")[-1]["code"] == "forbidden"
            play(sock, done.upload_id, "start")
            sock.until(lambda: len(sock.of("error")) == 3)
            assert sock.of("error")[-1] == {
                "type": "error",
                "attachmentId": done.upload_id,
                "code": "not_live",
            }
            sock.ws.send_text("not json")
            sock.ws.send_json({"type": "credit", "attachmentId": sent.upload_id, "frames": 501})
            sock.ws.send_json({"type": "watch", "attachmentId": sent.upload_id, "x": 1})
            sock.until(lambda: len(sock.of("error")) == 6)
            assert [e["code"] for e in sock.of("error")[3:]] == ["bad_request"] * 3
            assert all("attachmentId" not in e for e in sock.of("error")[3:])

    def test_a_note_that_is_not_a_voice_note_is_forbidden(self, env: LiveEnv) -> None:
        env.store.create_attachment(att_id="c" * 32, kind="photo", now=time.time())
        env.store.claim_processing(owner="x", now=time.time(), lease_s=60.0)
        with env.socket() as sock:
            watch(sock, "c" * 32)
            sock.until(lambda: sock.of("error"))
            assert sock.of("error")[0]["code"] == "forbidden"

    def test_more_than_four_listeners_of_one_note_is_too_many(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=2)
        with ExitStack() as stack:
            socks = [stack.enter_context(env.socket()) for _ in range(4)]
            fifth = stack.enter_context(env.socket(email="other@example.test"))
            for sock in socks:
                play(sock, note.upload_id, "live")
            wait_for(lambda: sum(1 for x in env.hub.listeners.values() if x.stream) == 4)
            play(fifth, note.upload_id, "live")
            fifth.until(lambda: fifth.of("error"))
            assert fifth.of("error")[0] == {
                "type": "error",
                "attachmentId": note.upload_id,
                "code": "too_many_listeners",
            }
            # A stopped stream frees a place.
            socks[0].send(type="stop", attachmentId=note.upload_id)
            wait_for(lambda: sum(1 for x in env.hub.listeners.values() if x.stream) == 3)
            play(fifth, note.upload_id, "live")
            wait_for(lambda: sum(1 for x in env.hub.listeners.values() if x.stream) == 4)

    def test_a_binary_frame_from_a_client_closes_the_socket(self, env: LiveEnv) -> None:
        with env.socket() as sock:
            sock.ws.send_bytes(b"\x00" * 16)
            assert sock.closed_code() == 4403

    def test_ten_bad_requests_close_the_socket(self, env: LiveEnv) -> None:
        with env.socket() as sock:
            for _ in range(11):
                sock.ws.send_text("{}")
            assert sock.closed_code() == 4403


# ---------------------------------------------------------------------------
# Auto-end under an injected clock
# ---------------------------------------------------------------------------


class TestAutoEnd:
    def test_no_slice_for_sixty_seconds_while_recording_ends_the_note_and_it_is_processed(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        clock = ManualClock()
        env.hub.clock = clock
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=6)
        clock.now += 59.9
        env.tick()
        assert env.store.get_attachment(note.upload_id).status == "live"  # type: ignore[union-attr]
        clock.now += 0.2
        env.tick()
        env.wait_status(note.upload_id, "ready")
        attachment = env.attachment(note.upload_id)
        assert attachment["durationS"] == pytest.approx(6.0, abs=0.7)  # all six slices were kept
        # Once processed the upload is gone altogether: a straggler finds nothing.
        assert env.put(note.upload_id, 6, note_slices[6]).status_code in (404, 409)

    def test_a_slice_resets_the_sixty_second_clock(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        clock = ManualClock()
        env.hub.clock = clock
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=2)
        clock.now += 50.0
        put_all_from(env, note.upload_id, note_slices, start=2, stop=3)
        clock.now += 50.0
        env.tick()
        assert env.store.get_attachment(note.upload_id).status == "live"  # type: ignore[union-attr]
        clock.now += 11.0
        env.tick()
        env.wait_status(note.upload_id, "ready")

    def test_a_paused_note_is_not_ended_by_silence_only_by_thirty_minutes_of_it(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        clock = ManualClock()
        env.hub.clock = clock
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=4)
        assert env.live_state(note.upload_id, "paused").status_code == 204
        clock.now += 29 * 60.0
        env.tick()
        assert env.store.get_attachment(note.upload_id).status == "live"  # type: ignore[union-attr]
        # Resuming restarts both rules from now.
        assert env.live_state(note.upload_id, "recording").status_code == 204
        clock.now += 30.0
        assert env.live_state(note.upload_id, "paused").status_code == 204
        clock.now += 29 * 60.0 + 59.0
        env.tick()
        assert env.store.get_attachment(note.upload_id).status == "live"  # type: ignore[union-attr]
        clock.now += 2.0
        env.tick()
        env.wait_status(note.upload_id, "ready")
        assert env.attachment(note.upload_id)["durationS"] == pytest.approx(4.0, abs=0.7)

    def test_a_note_that_never_stored_a_slice_is_failed_not_left_hanging(
        self, env: LiveEnv
    ) -> None:
        clock = ManualClock()
        env.hub.clock = clock
        note = env.start_note()
        clock.now += 61.0
        env.tick()
        row = env.store.get_attachment(note.upload_id)
        assert row is not None and (row.status, row.failure) == ("failed", "empty_recording")
        assert env.store.get_upload(note.upload_id) is None
        assert note.upload_id not in env.hub.notes
        assert env.store.live_attachment_ids() == []

    def test_a_note_ended_by_the_sender_is_not_ended_again(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        clock = ManualClock()
        env.hub.clock = clock
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=3)
        assert env.complete(note.upload_id, 3).status_code == 202
        clock.now += 3600.0
        env.tick()
        env.wait_status(note.upload_id, "ready")


# ---------------------------------------------------------------------------
# Restart recovery
# ---------------------------------------------------------------------------


class TestRestartRecovery:
    def test_a_note_left_live_by_a_dead_server_is_processed_from_its_stored_slices(
        self, tmp_path: Path, repo: Path, note_slices: list[bytes], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with live_env(tmp_path, repo, monkeypatch) as first:
            note = first.start_note()
            put_all(first, note.upload_id, note_slices, upto=5)
            wait_for(lambda: decoded_frames(first, note.upload_id) >= 100)
            assert first.store.get_attachment(note.upload_id).status == "live"  # type: ignore[union-attr]
        # The first process is gone mid-recording; a new one starts on the same storage.
        with live_env(tmp_path, repo, monkeypatch) as second:
            second.wait_status(note.upload_id, "ready")
            attachment = second.attachment(note.upload_id)
            assert attachment["durationS"] == pytest.approx(5.0, abs=0.7)
            assert second.store.live_attachment_ids() == []
            assert second.hub.notes == {}
            row = second.store.get_attachment(note.upload_id)
            assert row is not None and row.message_seq == note.seq  # the message is still there

    def test_a_note_that_stored_nothing_is_failed_at_startup(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with live_env(tmp_path, repo, monkeypatch) as first:
            note = first.start_note()
        with live_env(tmp_path, repo, monkeypatch) as second:
            row = second.store.get_attachment(note.upload_id)
            assert row is not None and (row.status, row.failure) == ("failed", "empty_recording")
            assert second.store.live_attachment_ids() == []

    def test_recovery_leaves_ordinary_attachments_alone(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with live_env(tmp_path, repo, monkeypatch, media_worker=False) as first:
            # Created NOW: an unlinked attachment older than a day is the janitor's to sweep at
            # startup (ORPHAN_ATTACHMENT_AGE_S), which made a 1970 timestamp race the assertion.
            first.store.create_attachment(att_id="d" * 32, kind="voice", now=time.time())
        with live_env(tmp_path, repo, monkeypatch, media_worker=False) as second:
            row = second.store.get_attachment("d" * 32)
            assert row is not None and (row.status, row.live_state) == ("processing", None)


# ---------------------------------------------------------------------------
# What the client relies on beyond the wire contract
# ---------------------------------------------------------------------------


class TestClientContract:
    def test_unsent_offers_a_plain_live_upload_but_never_a_listen_upload(
        self, env: LiveEnv, note_slices: list[bytes], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(uploads, "UNSENT_IDLE_S", -100.0)  # every slice counts as idle
        listened = env.start_note()  # linked to its message, as a lock would leave it
        unsent_listen = env.start_note(send=False)
        plain = env.init(listen=False).json()["uploadId"]
        for upload_id in (listened.upload_id, unsent_listen.upload_id, plain):
            assert env.put(upload_id, 0, note_slices[0]).status_code == 204
        response = env.client.get(f"{UPLOADS}/unsent?deviceId={DEVICE}", headers=env.headers)
        assert response.status_code == 200
        assert [u["uploadId"] for u in response.json()["unsent"]] == [plain]

    def test_after_an_auto_end_complete_slices_and_live_state_all_get_a_definite_4xx(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        clock = ManualClock()
        env.hub.clock = clock
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=3)
        clock.now += 61.0
        env.tick()
        late_complete = env.complete(note.upload_id, 3)
        assert late_complete.status_code == 409 and late_complete.json() == {"error": "not_live"}
        env.wait_status(note.upload_id, "ready")
        # Still definite once the note is finished and its upload is gone.
        assert env.complete(note.upload_id, 3).status_code == 409
        assert env.put(note.upload_id, 3, note_slices[3]).status_code in (404, 409)
        state = env.live_state(note.upload_id, "paused")
        assert state.status_code == 409 and state.json() == {"error": "not_live"}

    def test_a_senders_own_complete_is_still_an_idempotent_replay(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=3)
        assert env.complete(note.upload_id, 3).status_code == 202
        assert env.complete(note.upload_id, 3).status_code == 202

    def test_a_finished_notes_state_and_slices_are_refused(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=3)
        env.complete(note.upload_id, 3)
        env.wait_status(note.upload_id, "ready")
        assert env.live_state(note.upload_id, "paused").status_code == 409
        assert env.put(note.upload_id, 3, note_slices[3]).status_code in (404, 409)

    def test_deleting_the_message_alone_removes_the_upload_and_the_decoder(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        note = env.start_note()
        put_all(env, note.upload_id, note_slices, upto=4)
        wait_for(lambda: decoded_frames(env, note.upload_id) >= 100)
        live = env.hub.notes[note.upload_id]
        deleted = env.client.delete(f"/api/admin/server/messages/{note.seq}", headers=env.headers)
        assert deleted.status_code == 204  # no separate DELETE /uploads/{id}
        assert env.store.get_upload(note.upload_id) is None
        wait_for(live.decoder_done.is_set)
        wait_for(lambda: not env.paths.server_upload_dir(note.upload_id).exists())

    def test_the_server_pings_the_listener_socket_periodically(self, env: LiveEnv) -> None:
        with env.socket() as sock:
            sock.until(lambda: sock.pings >= 2, timeout_s=15.0)  # answered with pong each time

    def test_an_expired_listener_is_closed_with_4401(self, env: LiveEnv) -> None:
        with env.socket() as sock:
            (listener,) = env.hub.listeners.values()
            listener.deadline = time.time() - 1
            assert sock.closed_code() == 4401

    def test_attachment_keys_keep_their_order_and_stored_peaks_stay_0_to_1_floats(
        self, env: LiveEnv, note_slices: list[bytes]
    ) -> None:
        base = [
            "id", "kind", "status", "width", "height", "durationS", "peaks", "urls", "animated",
            "retryable", "transcript",
        ]  # fmt: skip
        note = env.start_note()
        assert list(env.attachment(note.upload_id)) == [*base, "liveState"]  # appended last
        assert list(note.attachment) == [*base, "liveState"]  # init and history agree
        put_all(env, note.upload_id, note_slices)
        env.complete(note.upload_id, len(note_slices))
        env.wait_status(note.upload_id, "ready")
        done = env.attachment(note.upload_id)
        assert list(done) == base  # the ordinary shape, as before
        assert len(done["peaks"]) == 64
        assert all(isinstance(p, float) and 0.0 <= p <= 1.0 for p in done["peaks"])
