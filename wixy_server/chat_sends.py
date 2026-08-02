"""Chat attachment SEND LOG (decisions/00108) — `Storage/projects/<slug>/chat-sends.json`.

Why this exists: cmd's decoded-messages read API has no structured attachment
field (decisions/00103's accepted limitation). A send that resolved to a
DRIVER method leaves its `Attachments:` footer in the message text, which
`cmdchat`'s footer parser recovers — but a send that resolved to STREAM-JSON
(a real image content block, no footer) leaves NO trace in the read-back text
at all: the decoder drops image blocks, so the message reloads with no sign an
image was ever attached. cmd's own UI has the same gap and builds around
nothing — wixy instead records what IT sent, and uses the log to decorate the
read-back messages itself.

Coverage split, deliberately redundant:
  - footer parse (`chat_attachments.extract_attachment_footer`, runs inside
    the cmd client) — recovers driver-path sends, INCLUDING history from
    before this feature existed;
  - this log — recovers stream-json sends (the new-chat first-message flow
    always lands here, as does any `/send` cmd routed to stream-json), for
    sends made from this deployment going forward.

The log is small by construction: one entry per send that CARRIED attachments
(text-only sends never appear), pruned to a cap on every write.

Matching is DETERMINISTIC, not heuristic: the read-back text of a user message
equals what was sent (the cmd decoder strips each text block; the footer
parser removes any driver footer; the preamble strip runs after decoration —
see `routes_chat._stream_events`), so a send matches a message by EXACT text.
Duplicate texts ("ok" sent twice with different images) resolve by ordinal
counted FROM THE END of both sequences — the last message with a given text
pairs with the last send with that text — which is stable across re-polls,
stream reconnects, and server restarts alike (both sequences only ever grow).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from builder.content import atomic_write_json, load_json_object
from builder.jsontypes import JsonObject
from wixy_server.chat_attachments import ChatAttachmentRef
from wixy_server.cmdchat import ChatMessage

_MAX_SENDS = 200
"""Upper bound on retained sends — the stream reads the transcript in an
80-message window, so sends older than the cap can never match anything
visible anyway; pruning keeps the file (and every write of it) tiny."""


@dataclass(frozen=True, slots=True)
class ChatSend:
    """One attachment-carrying send from this deployment (a `/send` call or a
    conversation created with attachments). `text` is the matching key: for
    `/send` the exact sent text; for a create, the FULL composed prompt
    (preamble included), because that's what the first read-back user message
    carries before `_owner_visible` strips the preamble downstream."""

    conv_id: str
    text: str
    sent_at: str
    attachments: tuple[ChatAttachmentRef, ...]


def _ref_from_dict(data: object) -> ChatAttachmentRef | None:
    if not isinstance(data, dict):
        return None
    upload_id = data.get("uploadId")
    if not isinstance(upload_id, str):
        return None
    name = data.get("name")
    width = data.get("width")
    height = data.get("height")
    return ChatAttachmentRef(
        upload_id=upload_id,
        name=name if isinstance(name, str) else None,
        width=width if isinstance(width, int) and not isinstance(width, bool) else None,
        height=height if isinstance(height, int) and not isinstance(height, bool) else None,
    )


def _send_from_dict(data: object) -> ChatSend | None:
    """Defensive parse — the same convention as `chats._conversation_from_dict`:
    one malformed entry is skipped, never fatal to the whole file."""
    if not isinstance(data, dict):
        return None
    conv_id = data.get("convId")
    text = data.get("text")
    sent_at = data.get("sentAt")
    raw_attachments = data.get("attachments")
    if (
        not isinstance(conv_id, str)
        or not isinstance(text, str)
        or not isinstance(sent_at, str)
        or not isinstance(raw_attachments, list)
    ):
        return None
    attachments = tuple(r for r in (_ref_from_dict(a) for a in raw_attachments) if r is not None)
    if not attachments:
        return None
    return ChatSend(conv_id=conv_id, text=text, sent_at=sent_at, attachments=attachments)


def _ref_to_dict(ref: ChatAttachmentRef) -> JsonObject:
    return {
        "uploadId": ref.upload_id,
        "name": ref.name,
        "width": ref.width,
        "height": ref.height,
    }


def _send_to_dict(send: ChatSend) -> JsonObject:
    return {
        "convId": send.conv_id,
        "text": send.text,
        "sentAt": send.sent_at,
        "attachments": [_ref_to_dict(a) for a in send.attachments],
    }


def load_sends(path: Path) -> list[ChatSend]:
    """Every stored send, oldest first (the file's own append order — mirrors
    `chats.load_chats`'s convention)."""
    if not path.exists():
        return []
    data = load_json_object(path)
    raw = data.get("sends", [])
    if not isinstance(raw, list):
        return []
    return [s for s in (_send_from_dict(item) for item in raw) if s is not None]


def record_send(path: Path, send: ChatSend) -> None:
    """Append one send atomically (same `atomic_write_json` convention as
    `chats.save_chats`), pruning the oldest beyond `_MAX_SENDS`."""
    sends = [*load_sends(path), send][-_MAX_SENDS:]
    atomic_write_json(path, {"sends": [_send_to_dict(s) for s in sends]})


class ChatSendsCache:
    """Process-lifetime view over the send log, held on `app.state.chat_sends`.

    Deliberately split into two steps because routes persist inside
    `anyio.to_thread` workers while the stream reads on the event loop:
      - `record(send)` — file I/O only, safe to call from a worker thread;
      - `note(send)` — in-memory append, called BACK on the event loop once
        the persist lands, so a conversation's own open stream sees the send
        on its very next poll tick without re-reading the file, and no dict is
        ever mutated from two threads at once.
    Reads warm from disk once per conversation (covers restarts — the file is
    the durable record, this is only a fast path)."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._by_conv: dict[str, list[ChatSend]] = {}

    def for_conversation(self, conv_id: str) -> list[ChatSend]:
        cached = self._by_conv.get(conv_id)
        if cached is None:
            cached = [s for s in load_sends(self._path) if s.conv_id == conv_id]
            self._by_conv[conv_id] = cached
        return cached

    def record(self, send: ChatSend) -> None:
        """Persist to disk (call via `anyio.to_thread.run_sync`)."""
        record_send(self._path, send)

    def note(self, send: ChatSend) -> None:
        """Append in-memory (call on the event loop only). The conversation
        may never have been read through this cache — append only when a list
        already exists, else leave the first read to warm it (which will then
        include this send from disk)."""
        cached = self._by_conv.get(send.conv_id)
        if cached is not None:
            cached.append(send)


def decorate_messages(messages: list[ChatMessage], sends: list[ChatSend]) -> list[ChatMessage]:
    """Attach each send's refs to its matching read-back message (see this
    module's docstring for the contract). A message that already carries
    attachments (the footer parser got there first — a driver-path send) is
    never touched. Input order is preserved; a message with no matching send
    passes through as the identical object."""
    # Single pass from the END: within one exact-text group, the last
    # undecorated message pairs with the last send, the second-to-last with
    # the second-to-last, and so on. Grouping is by text, so the group
    # membership itself is computed per text rather than pre-bucketed.
    ordinal_from_end: dict[str, int] = {}
    result: list[ChatMessage] = list(messages)
    for i in range(len(result) - 1, -1, -1):
        message = result[i]
        if (
            message.role != "user"
            or message.kind != "text"
            or message.text is None
            or message.attachments
        ):
            continue
        ordinal = ordinal_from_end.get(message.text, 0)
        ordinal_from_end[message.text] = ordinal + 1
        candidates = [s for s in sends if s.text == message.text]
        if ordinal < len(candidates):
            send = candidates[len(candidates) - 1 - ordinal]
            result[i] = replace(message, attachments=send.attachments)
    return result
