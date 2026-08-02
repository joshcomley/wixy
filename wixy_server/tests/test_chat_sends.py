"""decisions/00108: `wixy_server.chat_sends` — the attachment send log that
closes cmd's read-side gap (a stream-json-routed send leaves no trace in the
decoded transcript, so wixy decorates the read-back from its own record of
what it sent)."""

from __future__ import annotations

from pathlib import Path

from wixy_server.chat_attachments import ChatAttachmentRef
from wixy_server.chat_sends import (
    ChatSend,
    ChatSendsCache,
    decorate_messages,
    load_sends,
    record_send,
)
from wixy_server.cmdchat import ChatMessage


def _send(
    text: str,
    *upload_ids: str,
    conv_id: str = "c1",
    sent_at: str = "2026-08-02T00:00:00+00:00",
) -> ChatSend:
    return ChatSend(
        conv_id=conv_id,
        text=text,
        sent_at=sent_at,
        attachments=tuple(ChatAttachmentRef(upload_id=uid) for uid in upload_ids),
    )


def _message(
    index: int,
    text: str | None,
    *,
    role: str = "user",
    kind: str = "text",
    attachments: tuple[ChatAttachmentRef, ...] = (),
) -> ChatMessage:
    return ChatMessage(
        index=index,
        role=role,
        kind=kind,
        text=text,
        timestamp="2026-08-02T00:00:00Z",
        tool_name=None,
        truncated=False,
        attachments=attachments,
    )


class TestPersistence:
    def test_round_trip(self, tmp_path: Path) -> None:
        path = tmp_path / "chat-sends.json"
        record_send(path, _send("look at this", "u1", "u2"))
        record_send(path, _send("and this", "u3", conv_id="c2"))

        sends = load_sends(path)
        assert len(sends) == 2
        assert sends[0].conv_id == "c1"
        assert sends[0].text == "look at this"
        assert [a.upload_id for a in sends[0].attachments] == ["u1", "u2"]
        assert sends[1].conv_id == "c2"

    def test_a_missing_file_reads_as_empty(self, tmp_path: Path) -> None:
        assert load_sends(tmp_path / "nope.json") == []

    def test_oldest_entries_are_pruned_beyond_the_cap(self, tmp_path: Path) -> None:
        path = tmp_path / "chat-sends.json"
        for i in range(210):
            record_send(path, _send(f"message {i}", f"u{i}"))
        sends = load_sends(path)
        assert len(sends) == 200
        # Kept the NEWEST — the first ten fell off.
        assert sends[0].text == "message 10"
        assert sends[-1].text == "message 209"


class TestChatSendsCache:
    def test_record_then_read_includes_the_send(self, tmp_path: Path) -> None:
        cache = ChatSendsCache(tmp_path / "chat-sends.json")
        cache.record(_send("hi", "u1"))
        assert [s.text for s in cache.for_conversation("c1")] == ["hi"]

    def test_note_makes_a_send_visible_without_a_disk_re_read(self, tmp_path: Path) -> None:
        cache = ChatSendsCache(tmp_path / "chat-sends.json")
        cache.for_conversation("c1")  # warm the in-memory list (empty)
        cache.note(_send("not on disk", "u1"))
        assert [s.text for s in cache.for_conversation("c1")] == ["not on disk"]

    def test_note_before_any_read_does_not_short_circuit_the_disk_warm(
        self, tmp_path: Path
    ) -> None:
        cache = ChatSendsCache(tmp_path / "chat-sends.json")
        cache.record(_send("on disk", "u1"))
        # A note for a conversation never read must not create a divergent
        # in-memory-only list — the first read warms from disk.
        cache.note(_send("on disk", "u1"))
        assert [s.text for s in cache.for_conversation("c1")] == ["on disk"]


class TestDecorateMessages:
    def test_attaches_the_send_to_its_matching_message(self) -> None:
        messages = [_message(0, "look at this"), _message(1, "sure", role="assistant")]
        decorated = decorate_messages(messages, [_send("look at this", "u1")])
        assert [a.upload_id for a in decorated[0].attachments] == ["u1"]
        assert decorated[1].attachments == ()

    def test_a_message_with_no_matching_send_passes_through_identically(self) -> None:
        message = _message(0, "plain")
        assert decorate_messages([message], []) == [message]

    def test_an_already_decorated_message_is_never_overwritten(self) -> None:
        # The footer parser got there first (a driver-path send) — the send
        # log must not stomp it, even with matching text.
        existing = (ChatAttachmentRef(upload_id="from-footer"),)
        message = _message(0, "look", attachments=existing)
        decorated = decorate_messages([message], [_send("look", "from-log")])
        assert decorated[0].attachments == existing

    def test_only_user_text_messages_are_considered(self) -> None:
        messages = [
            _message(0, "look", role="assistant"),
            _message(1, "look", kind="thinking"),
        ]
        decorated = decorate_messages(messages, [_send("look", "u1")])
        assert decorated[0].attachments == ()
        assert decorated[1].attachments == ()

    def test_duplicate_texts_pair_from_the_end(self) -> None:
        # "ok" sent twice with different images: the LAST "ok" message pairs
        # with the LAST "ok" send — stable across re-polls and restarts, which
        # is the whole point of the from-the-end rule.
        messages = [_message(0, "ok"), _message(1, "ok")]
        sends = [_send("ok", "first"), _send("ok", "second")]
        decorated = decorate_messages(messages, sends)
        assert [a.upload_id for a in decorated[0].attachments] == ["first"]
        assert [a.upload_id for a in decorated[1].attachments] == ["second"]

    def test_more_messages_than_sends_leaves_the_oldest_undecorated(self) -> None:
        messages = [_message(0, "ok"), _message(1, "ok")]
        decorated = decorate_messages(messages, [_send("ok", "only")])
        assert decorated[0].attachments == ()
        assert [a.upload_id for a in decorated[1].attachments] == ["only"]
