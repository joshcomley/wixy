"""Chat conversation identity store (spec/06-ai-chat.md §1, spec/04-server.md §2):
`Storage/projects/<slug>/chats.json` — durable `{conv_id, session_id, title,
created_at}` records, spec/06 §1's exact words: "Wixy stores {conv_id, session_id,
title, created_at} in chats.json."

Live/pending provisioning status (`ChatRuntimeEntry`) is deliberately NOT persisted
here — it's transient, process-lifetime state (mirrors `wixy_server.publisher.
PublishJob` living on `app.state`, never on disk). A conversation absent from the
runtime map is treated as `"ready"` (see `conversation_summary`): the overwhelming
common case for any conversation not created in THIS process's lifetime is "long
since finished provisioning," and the rare edge case (wixy_server restarts during
a conversation's few-seconds-to-tens-of-seconds provisioning window) self-heals the
first time that conversation is actually opened — slice 3's stream/send routes
re-verify against cmd rather than trusting a stale assumption. Eagerly re-polling
EVERY stored conversation at every startup just to catch that rare window isn't
worth the complexity; see decisions/00032 for the full reasoning.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from builder.content import atomic_write_json, load_json_object
from builder.jsontypes import JsonObject


@dataclass(frozen=True, slots=True)
class ChatConversation:
    conv_id: str
    session_id: str
    title: str
    created_at: str


class ChatNotFoundError(Exception):
    """No stored conversation has this `conv_id`."""


def _conversation_from_dict(data: object) -> ChatConversation | None:
    """Defensive parse — an unrecognized/malformed entry is skipped, not fatal
    (matches `wixy_server.ledger`'s own `_entry_from_dict` convention)."""
    if not isinstance(data, dict):
        return None
    conv_id = data.get("convId")
    if not isinstance(conv_id, str):
        return None
    session_id = data.get("sessionId")
    if not isinstance(session_id, str):
        return None
    title = data.get("title")
    if not isinstance(title, str):
        return None
    created_at = data.get("createdAt")
    if not isinstance(created_at, str):
        return None
    return ChatConversation(
        conv_id=conv_id, session_id=session_id, title=title, created_at=created_at
    )


def _conversation_to_dict(conv: ChatConversation) -> JsonObject:
    return {
        "convId": conv.conv_id,
        "sessionId": conv.session_id,
        "title": conv.title,
        "createdAt": conv.created_at,
    }


def load_chats(path: Path) -> list[ChatConversation]:
    """Every stored conversation, oldest first (the file's own append order) —
    callers that want newest-first (spec/06 §1's conversation list) reverse this
    themselves, mirroring `wixy_server.ledger.read_ledger`'s own convention."""
    if not path.exists():
        return []
    data = load_json_object(path)
    raw = data.get("conversations", [])
    if not isinstance(raw, list):
        return []
    return [c for c in (_conversation_from_dict(item) for item in raw) if c is not None]


def save_chats(path: Path, conversations: list[ChatConversation]) -> None:
    atomic_write_json(path, {"conversations": [_conversation_to_dict(c) for c in conversations]})


def add_chat(path: Path, conversation: ChatConversation) -> None:
    conversations = load_chats(path)
    conversations.append(conversation)
    save_chats(path, conversations)


def rename_chat(path: Path, conv_id: str, title: str) -> ChatConversation:
    conversations = load_chats(path)
    updated: ChatConversation | None = None
    result: list[ChatConversation] = []
    for conv in conversations:
        if conv.conv_id == conv_id:
            updated = ChatConversation(
                conv_id=conv.conv_id,
                session_id=conv.session_id,
                title=title,
                created_at=conv.created_at,
            )
            result.append(updated)
        else:
            result.append(conv)
    if updated is None:
        raise ChatNotFoundError(f"no conversation with id '{conv_id}'")
    save_chats(path, result)
    return updated


ChatStatus = Literal["pending", "ready", "failed"]


@dataclass(frozen=True, slots=True)
class ChatRuntimeEntry:
    """Process-lifetime provisioning status for one conversation (never persisted
    — see this module's own docstring). `failure_reason` is `cmdchat.FailedOutcome
    .reason` verbatim (`"workspace_failed"` / `"cli_failed"` / `"timeout"`) or
    `"unreachable"` for a `CmdChatError` (cmd itself down — spec/06 §3's distinct
    offline-banner case, see decisions/00031 decision 2)."""

    status: ChatStatus
    failure_reason: str | None = None
    failure_message: str | None = None


_READY = ChatRuntimeEntry(status="ready")


def conversation_summary(conv: ChatConversation, runtime: ChatRuntimeEntry | None) -> JsonObject:
    """The wire shape both `routes_chat.py` (dedicated list/create) and
    `routes_admin_api._build_state` (the `chats` snapshot, spec/04 §8) return —
    kept in one place so the two call sites can never drift apart."""
    entry = runtime if runtime is not None else _READY
    return {
        "convId": conv.conv_id,
        "title": conv.title,
        "createdAt": conv.created_at,
        "status": entry.status,
        "failureReason": entry.failure_reason,
        "failureMessage": entry.failure_message,
    }
