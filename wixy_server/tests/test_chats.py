from __future__ import annotations

import json
from pathlib import Path

import pytest

from wixy_server.chats import (
    ChatConversation,
    ChatNotFoundError,
    ChatRuntimeEntry,
    add_chat,
    conversation_summary,
    load_chats,
    rename_chat,
    save_chats,
)


def _conv(conv_id: str, session_id: str = "sess-1", title: str = "hi") -> ChatConversation:
    return ChatConversation(
        conv_id=conv_id, session_id=session_id, title=title, created_at="2026-07-10T00:00:00Z"
    )


def test_load_chats_missing_file_returns_empty(tmp_path: Path) -> None:
    assert load_chats(tmp_path / "chats.json") == []


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    conversations = [_conv("c1"), _conv("c2", session_id="sess-2", title="second")]
    save_chats(path, conversations)

    loaded = load_chats(path)

    assert loaded == conversations


def test_save_writes_canonical_json(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    save_chats(path, [_conv("c1")])

    data = json.loads(path.read_text(encoding="utf-8"))

    assert data == {
        "conversations": [
            {
                "convId": "c1",
                "sessionId": "sess-1",
                "title": "hi",
                "createdAt": "2026-07-10T00:00:00Z",
            }
        ]
    }
    assert path.read_text(encoding="utf-8").endswith("\n")


def test_save_leaves_no_tmp_file_behind(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    save_chats(path, [_conv("c1")])

    leftovers = list(tmp_path.iterdir())

    assert leftovers == [path]


def test_add_chat_appends(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    add_chat(path, _conv("c1"))
    add_chat(path, _conv("c2", session_id="sess-2"))

    loaded = load_chats(path)

    assert [c.conv_id for c in loaded] == ["c1", "c2"]


def test_rename_chat_updates_title_only(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    add_chat(path, _conv("c1", title="original"))

    updated = rename_chat(path, "c1", "renamed")

    assert updated.title == "renamed"
    assert updated.conv_id == "c1"
    assert updated.session_id == "sess-1"
    loaded = load_chats(path)
    assert loaded[0].title == "renamed"


def test_rename_chat_unknown_id_raises(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    add_chat(path, _conv("c1"))

    with pytest.raises(ChatNotFoundError):
        rename_chat(path, "does-not-exist", "x")


def test_load_chats_skips_malformed_entries(tmp_path: Path) -> None:
    path = tmp_path / "chats.json"
    path.write_text(
        json.dumps(
            {
                "conversations": [
                    {
                        "convId": "c1",
                        "sessionId": "sess-1",
                        "title": "ok",
                        "createdAt": "2026-07-10T00:00:00Z",
                    },
                    {"convId": "c2"},  # missing required fields
                    "not-even-an-object",
                ]
            }
        ),
        encoding="utf-8",
    )

    loaded = load_chats(path)

    assert [c.conv_id for c in loaded] == ["c1"]


def test_conversation_summary_defaults_to_ready_when_untracked() -> None:
    summary = conversation_summary(_conv("c1"), None)

    assert summary["status"] == "ready"
    assert summary["failureReason"] is None
    assert summary["failureMessage"] is None


def test_conversation_summary_reflects_pending_runtime() -> None:
    summary = conversation_summary(_conv("c1"), ChatRuntimeEntry(status="pending"))

    assert summary["status"] == "pending"


def test_conversation_summary_reflects_failure_detail() -> None:
    entry = ChatRuntimeEntry(
        status="failed", failure_reason="workspace_failed", failure_message="disk full"
    )

    summary = conversation_summary(_conv("c1"), entry)

    assert summary["status"] == "failed"
    assert summary["failureReason"] == "workspace_failed"
    assert summary["failureMessage"] == "disk full"
