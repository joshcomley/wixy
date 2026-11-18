"""Live transcription of a voice note while it is recorded (spec/server-chat/07-live-voice-notes.md
§3, Inv 50 and Inv 58): opt-in only, private mode only, finalised text stored and the provisional
tail kept in memory, the 90 s no-sentence rule, the full-note pass after Stop, failures, deletion.
"""

from __future__ import annotations

import io
import wave
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat import live_transcription, live_voice
from wixy_server.livechat.live_transcription import Accumulator, split_sentences, wav_bytes
from wixy_server.livechat.transcription import TRANSCRIBE_TMP_DIRNAME
from wixy_server.tests.live_voice_testkit import (
    TRANSCRIBE,
    LiveEnv,
    Scripted,
    live_env,
    make_webm,
    make_wixy_repo,
    slices_of,
    wait_for,
)

SENTINEL_TAIL = "tail-sentinel-5f3c9a"


@pytest.fixture(scope="module")
def repo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return make_wixy_repo(tmp_path_factory.mktemp("repo"))


@pytest.fixture(scope="module")
def note_slices(tmp_path_factory: pytest.TempPathFactory) -> list[bytes]:
    return slices_of(make_webm(tmp_path_factory.mktemp("audio") / "note.webm"))


@pytest.fixture(autouse=True)
def _fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live_voice, "STATE_INTERVAL_S", 0.05)
    monkeypatch.setattr(live_transcription, "RETRY_DELAY_S", 0.01)


@contextmanager
def scripted_env(
    tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, scripted: Scripted
) -> Iterator[LiveEnv]:
    with live_env(tmp_path, repo, monkeypatch, transcriber=scripted) as env:
        scripted.tmp_dir = env.paths.server_dir / TRANSCRIBE_TMP_DIRNAME
        # One second of new audio (not eight) between passes, so a 12 s note has many of them.
        assert env.hub.transcriber is not None
        env.hub.transcriber.step_frames = 50
        yield env


def transcript(env: LiveEnv, att_id: str) -> Any:
    return env.attachment(att_id)["transcript"]


def put_all(env: LiveEnv, upload_id: str, slices: list[bytes], *, upto: int | None = None) -> None:
    for index, piece in enumerate(slices[: len(slices) if upto is None else upto]):
        assert env.put(upload_id, index, piece).status_code == 204


def raw_db(env: LiveEnv) -> bytes:
    db = env.store._db_path
    wal = Path(f"{db}-wal")
    return db.read_bytes() + (wal.read_bytes() if wal.exists() else b"")


# ---------------------------------------------------------------------------
# The pure pieces
# ---------------------------------------------------------------------------


class TestSplitSentences:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("", ("", "")),
            ("no sentence end here", ("", "no sentence end here")),
            ("Hello there.", ("Hello there.", "")),
            ("Hello there. And then", ("Hello there.", "And then")),
            ("One. Two! Three? Four", ("One. Two! Three?", "Four")),
            ("Wait... what", ("Wait...", "what")),
            ('He said "stop." Then left', ('He said "stop."', "Then left")),
            ("It cost 3.5 pounds", ("", "It cost 3.5 pounds")),  # a decimal is not an end
            ("Really?  Yes", ("Really?", "Yes")),
            ("  spaced out.  ", ("spaced out.", "")),
        ],
    )
    def test_the_text_up_to_the_last_sentence_end_is_finalised(
        self, text: str, expected: tuple[str, str]
    ) -> None:
        assert split_sentences(text) == expected


class TestAccumulator:
    def frame(self, value: int) -> bytes:
        return value.to_bytes(2, "little", signed=True) * 480

    def test_frames_are_kept_in_order_and_the_oldest_dropped_past_the_cap(self) -> None:
        acc = Accumulator(start=10, cap_frames=3)
        for index in range(10, 15):
            acc.add(index, self.frame(index))
        assert (acc.start, acc.end) == (12, 15)
        assert acc.pcm(12, 15) == b"".join(self.frame(i) for i in (12, 13, 14))
        assert acc.pcm(0, 13) == self.frame(12)  # clipped to what is held

    def test_a_duplicate_or_a_gap_is_never_spliced_in(self) -> None:
        acc = Accumulator(start=0, cap_frames=10)
        acc.add(0, self.frame(1))
        acc.add(0, self.frame(2))  # a restarted decoder re-delivering
        acc.add(5, self.frame(3))  # a gap
        assert acc.end == 1 and acc.pcm(0, 10) == self.frame(1)

    def test_advance_drops_what_was_finalised(self) -> None:
        acc = Accumulator(start=0, cap_frames=100)
        for index in range(10):
            acc.add(index, self.frame(index))
        acc.advance(4)
        assert (acc.start, acc.end) == (4, 10)
        acc.advance(2)  # never backwards
        acc.advance(99)  # never past the end
        assert (acc.start, acc.end) == (10, 10)

    def test_the_cut_settles_on_the_quietest_moment_near_the_estimate(self) -> None:
        acc = Accumulator(start=0, cap_frames=1000)
        for index in range(400):
            acc.add(index, self.frame(0 if index == 237 else 8000))
        assert acc.quietest_frame(around=200, low=1, high=400) == 237
        assert acc.quietest_frame(around=390, low=1, high=400) in range(240, 400)  # not in reach

    def test_wav_bytes_is_a_real_24k_mono_wav(self) -> None:
        pcm = self.frame(1234) * 10
        with wave.open(io.BytesIO(wav_bytes(pcm)), "rb") as reader:
            assert (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) == (
                1,
                2,
                24000,
            )
            assert reader.readframes(reader.getnframes()) == pcm


# ---------------------------------------------------------------------------
# The loop, against a scripted private-mode transcriber
# ---------------------------------------------------------------------------


class TestLiveTranscript:
    def test_nothing_is_transcribed_until_someone_asks(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["anything."])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=6)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 250)
            assert scripted.requests == []
            assert transcript(env, note.upload_id) is None

    def test_the_text_follows_the_recording_finalised_sentences_stored_and_the_tail_in_memory(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(
            texts=[
                "Hello there. And then we",
                "And then we went home. " + SENTINEL_TAIL,
                "Safe now. Goodbye",
                "Goodbye",
            ]
        )
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=4)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 150)
            before = env.updates(note.seq)

            response = env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            assert response.status_code == 202
            assert response.json() == {"transcript": {"status": "live", "text": "", "tail": ""}}

            # The tail of an unfinished sentence is shown, then rewritten by the next pass.
            wait_for(lambda: transcript(env, note.upload_id)["tail"] == "And then we")
            first = transcript(env, note.upload_id)
            assert first == {"status": "live", "text": "Hello there.", "tail": "And then we"}

            put_all_from(env, note.upload_id, note_slices, start=4, stop=12)
            wait_for(
                lambda: (
                    transcript(env, note.upload_id)
                    == {
                        "status": "live",
                        "text": "Hello there. And then we went home. Safe now.",
                        "tail": "Goodbye",
                    }
                )
            )
            # Only what is finalised is ever stored: the tail lives in memory.
            assert b"Safe now." in raw_db(env)
            assert b"Goodbye" not in raw_db(env)
            assert SENTINEL_TAIL.encode() not in raw_db(env)  # a tail that was replaced
            assert env.store.get_transcript(note.upload_id).text == (  # type: ignore[union-attr]
                "Hello there. And then we went home. Safe now."
            )
            # Each pass that changed what people see was one persistent event.
            assert env.updates(note.seq) >= before + 3

        windows = scripted.live_windows()
        assert len(windows) >= 4
        assert {(f, c) for f, c, _s, _t in windows} == {("live.wav", "audio/wav")}
        assert scripted.fresh_probes == len(scripted.requests)  # cmd asked afresh before each send
        assert all(listing == [] for listing in scripted.tmp_listings)  # the private file was gone

    def test_the_private_file_is_deleted_after_every_pass(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["One."])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=5)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 200)
            assert (
                env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers).status_code
                == 202
            )
            wait_for(lambda: len(scripted.live_windows()) >= 1)
            put_all_from(env, note.upload_id, note_slices, start=5, stop=12)
            wait_for(lambda: len(scripted.live_windows()) >= 2)
            tmp_root = env.paths.server_dir / TRANSCRIBE_TMP_DIRNAME
            wait_for(lambda: not tmp_root.exists() or not list(tmp_root.rglob("*.wav")))

    def test_the_first_window_starts_at_the_beginning_of_a_note_that_is_already_long(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["Already said."])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=6)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 280)
            edge = env.hub.notes[note.upload_id].ring_end
            env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            wait_for(lambda: len(scripted.live_windows()) >= 1)
            _name, _type, size, _timeout = scripted.live_windows()[0]
            assert (size - 44) % 960 == 0  # a WAV header, then whole 20 ms frames
            assert (size - 44) // 960 >= edge  # everything said so far, from the first second

    def test_a_window_with_no_sentence_end_is_finalised_whole_at_the_cap(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["no sentence end here"])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            assert env.hub.transcriber is not None
            env.hub.transcriber.window_max_frames = 100  # a 2 s cap stands in for 90 s
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=8)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 300)
            env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            wait_for(
                lambda: (
                    (transcript(env, note.upload_id) or {})
                    .get("text", "")
                    .startswith("no sentence end here")
                )
            )
            # No window ever carried more than the cap.
            assert all((size - 44) // 960 <= 100 for _f, _c, size, _t in scripted.live_windows())
            # Below the cap, with no sentence end, nothing was finalised: it stayed the tail.
            # (The same text repeats each pass, so a finalised window is followed by new tails.)
            assert transcript(env, note.upload_id)["status"] == "live"

    def test_the_final_pass_after_stop_replaces_the_live_text_with_the_stored_transcript(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["Live words. And a tail", ""], final_text="The finished note.")
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=6)
            env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            wait_for(lambda: transcript(env, note.upload_id)["text"] == "Live words.")
            assert env.complete(note.upload_id, 6).status_code == 202
            # Between Stop and ready the stored live text stays (a `pending` transcript with text),
            # then the one full-note pass makes it the normal `done` transcript.
            wait_for(
                lambda: (
                    transcript(env, note.upload_id)
                    == {"status": "done", "text": "The finished note."}
                )
            )
            assert env.attachment(note.upload_id)["status"] == "ready"
            final = [r for r in scripted.requests if r[0] == "play.m4a"]
            assert len(final) == 1 and final[0][1] == "audio/mp4"  # spec 06's note-wide request
            row = env.store.get_transcript(note.upload_id)
            assert row is not None and row.engine == "fake"
            assert env.hub.transcriber is not None and not env.hub.transcriber.active

    def test_three_failed_windows_in_a_row_fail_the_transcript_and_keep_what_was_finalised(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["First sentence. Then more"], outcomes=["ok", "timeout"])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=4)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 150)
            env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            wait_for(lambda: transcript(env, note.upload_id)["text"] == "First sentence.")
            # More audio arrives; every window after the first is refused by cmd.
            put_all_from(env, note.upload_id, note_slices, start=4, stop=12)
            wait_for(
                lambda: (transcript(env, note.upload_id) or {}).get("status") == "failed",
                timeout_s=60.0,
            )
            assert transcript(env, note.upload_id) == {
                "status": "failed",
                "text": "First sentence.",
            }
            assert len(scripted.requests) == 4  # one answer, then three failures, then it stops
            assert env.hub.transcriber is not None and not env.hub.transcriber.active

    def test_deleting_the_message_ends_the_transcription_and_erases_the_text(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["Erase this sentence. Tail"])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=6)
            env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            wait_for(lambda: transcript(env, note.upload_id)["text"] == "Erase this sentence.")
            assert (
                env.client.delete(
                    f"/api/admin/server/messages/{note.seq}", headers=env.headers
                ).status_code
                == 204
            )
            live = env.hub.transcriber
            assert live is not None
            wait_for(lambda: not live.active)
            assert env.store.get_transcript(note.upload_id) is None
            sent = len(scripted.requests)
            assert sent >= 1
            wait_for(lambda: b"Erase this sentence." not in raw_db(env))

    def test_a_second_request_while_one_is_running_is_the_same_live_transcript(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        scripted = Scripted(texts=["Only once. Tail"])
        with scripted_env(tmp_path, repo, monkeypatch, scripted) as env:
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=5)
            wait_for(lambda: env.hub.notes[note.upload_id].ring_end >= 240)  # all of it decoded
            first = env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            wait_for(lambda: transcript(env, note.upload_id)["text"] == "Only once.")
            again = env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            assert first.status_code == again.status_code == 202
            assert again.json()["transcript"]["status"] == "live"
            assert again.json()["transcript"]["text"] == "Only once."
            assert env.hub.transcriber is not None and len(env.hub.transcriber.active) == 1


class TestThroughCmdPrivateMode:
    def test_every_window_and_the_final_pass_use_private_mode_and_nothing_is_retained(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        with live_env(tmp_path, repo, monkeypatch) as env:
            env.state.transcribe_text = "A fake sentence. And a tail"
            assert env.hub.transcriber is not None
            env.hub.transcriber.step_frames = 50
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=4)
            assert (
                env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers).status_code
                == 202
            )
            wait_for(lambda: len(env.state.transcribe_requests) >= 1)
            put_all_from(env, note.upload_id, note_slices, start=4, stop=12)
            wait_for(lambda: len(env.state.transcribe_requests) >= 2)
            assert env.complete(note.upload_id, 12).status_code == 202
            wait_for(lambda: transcript(env, note.upload_id).get("status") == "done", timeout_s=60)
            requests = env.state.transcribe_requests
            assert requests[0].filename == "live.wav" and requests[0].audio[:4] == b"RIFF"
            assert requests[-1].filename == "play.m4a"
            assert all(r.fields == {"private": "1", "cleanup": "0"} for r in requests)
            assert env.state.transcribe_retained == []

    def test_without_private_mode_the_request_is_refused_and_no_audio_leaves(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch, note_slices: list[bytes]
    ) -> None:
        with live_env(tmp_path, repo, monkeypatch) as env:
            env.state.transcribe_private_supported = False
            note = env.start_note()
            put_all(env, note.upload_id, note_slices, upto=3)
            response = env.client.post(TRANSCRIBE.format(note.upload_id), headers=env.headers)
            assert response.status_code == 503 and response.json() == {"error": "not_configured"}
            assert env.state.transcribe_requests == [] and env.state.transcribe_retained == []
            assert transcript(env, note.upload_id) is None

    def test_an_unsent_or_unknown_note_is_404(
        self, tmp_path: Path, repo: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with live_env(tmp_path, repo, monkeypatch) as env:
            unsent = env.start_note(send=False)
            assert (
                env.client.post(
                    TRANSCRIBE.format(unsent.upload_id), headers=env.headers
                ).status_code
                == 404
            )
            assert (
                env.client.post(TRANSCRIBE.format("0" * 32), headers=env.headers).status_code == 404
            )


def put_all_from(
    env: LiveEnv, upload_id: str, slices: list[bytes], *, start: int, stop: int
) -> None:
    for index in range(start, stop):
        assert env.put(upload_id, index, slices[index]).status_code == 204
