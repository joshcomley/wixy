"""Unit tests for `wixy_server.worker.transcript` (spec/independence/05 §2:
"persists conversations as JSONL compatible with the existing chat panel's
message model")."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NoReturn

import pytest

from wixy_server.worker.state import WorkerMessage
from wixy_server.worker.transcript import transcript_path, write_transcript


def _message(index: int, text: str) -> WorkerMessage:
    return WorkerMessage(
        index=index, role="user", kind="text", text=text, timestamp="2026-07-19T00:00:00Z"
    )


class TestWriteTranscript:
    def test_writes_one_json_line_per_message(self, tmp_path: Path) -> None:
        messages = [_message(0, "hello"), _message(1, "world")]
        write_transcript(tmp_path, "anthropic-1", messages)

        lines = transcript_path(tmp_path, "anthropic-1").read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0])["text"] == "hello"
        assert json.loads(lines[1])["text"] == "world"

    def test_each_line_matches_worker_message_to_json_shape(self, tmp_path: Path) -> None:
        message = _message(0, "hello")
        write_transcript(tmp_path, "anthropic-1", [message])

        lines = transcript_path(tmp_path, "anthropic-1").read_text(encoding="utf-8").splitlines()
        assert json.loads(lines[0]) == message.to_json()

    def test_overwrites_on_a_second_call_rather_than_appending(self, tmp_path: Path) -> None:
        write_transcript(tmp_path, "anthropic-1", [_message(0, "first turn")])
        write_transcript(
            tmp_path, "anthropic-1", [_message(0, "first turn"), _message(1, "second turn")]
        )

        lines = transcript_path(tmp_path, "anthropic-1").read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2

    def test_empty_messages_writes_an_empty_file(self, tmp_path: Path) -> None:
        write_transcript(tmp_path, "anthropic-1", [])
        assert transcript_path(tmp_path, "anthropic-1").read_text(encoding="utf-8") == ""

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        nested_root = tmp_path / "does" / "not" / "exist" / "yet"
        write_transcript(nested_root, "anthropic-1", [_message(0, "hi")])
        assert transcript_path(nested_root, "anthropic-1").exists()

    def test_separate_conversations_get_separate_files(self, tmp_path: Path) -> None:
        write_transcript(tmp_path, "anthropic-1", [_message(0, "conv one")])
        write_transcript(tmp_path, "anthropic-2", [_message(0, "conv two")])

        text_1 = transcript_path(tmp_path, "anthropic-1").read_text(encoding="utf-8")
        text_2 = transcript_path(tmp_path, "anthropic-2").read_text(encoding="utf-8")
        assert "conv one" in text_1
        assert "conv two" not in text_1
        assert "conv two" in text_2

    def test_no_leftover_tmp_file(self, tmp_path: Path) -> None:
        write_transcript(tmp_path, "anthropic-1", [_message(0, "hi")])
        conv_dir = transcript_path(tmp_path, "anthropic-1").parent
        leftovers = [p for p in conv_dir.iterdir() if p.suffix == ".tmp"]
        assert leftovers == []

    def test_survives_transient_permission_denied_on_the_replace(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """On Windows an external reader (Defender real-time scan, Search
        indexer) can briefly hold the freshly written tmp file, failing
        `os.replace` with `PermissionError` (WinError 5) even though the lock
        clears within milliseconds — seen as a real pytest flake taking down
        the whole TestClient lifespan (2026-07-20). The write must ride out a
        few denials, not fail the turn."""
        real_replace = os.replace
        state = {"denials": 0}

        def flaky_replace(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
            if state["denials"] < 3:
                state["denials"] += 1
                raise PermissionError(5, "Access is denied")
            real_replace(src, dst)

        monkeypatch.setattr(os, "replace", flaky_replace)
        write_transcript(tmp_path, "anthropic-1", [_message(0, "hello")])

        assert "hello" in transcript_path(tmp_path, "anthropic-1").read_text(encoding="utf-8")
        assert state["denials"] == 3

    def test_gives_up_after_a_bounded_number_of_denials(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A genuinely un-writable target must still raise — the retry is a
        courtesy for transient scanners, not a swallow-everything loop — and
        the tmp file is cleaned up either way."""

        def always_denied(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> NoReturn:
            raise PermissionError(5, "Access is denied")

        monkeypatch.setattr(os, "replace", always_denied)
        with pytest.raises(PermissionError):
            write_transcript(tmp_path, "anthropic-1", [_message(0, "hello")])

        conv_dir = transcript_path(tmp_path, "anthropic-1").parent
        assert [p for p in conv_dir.iterdir() if p.suffix == ".tmp"] == []
