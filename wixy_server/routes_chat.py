"""`/api/admin/chat/*` — conversation create + list (spec/06-ai-chat.md §1).

Milestone 10 slice 2: identity + provisioning tracking only. Send, the SSE
message/status stream, rename, and handover-follow are slice 3 — not built here.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import anyio
from anyio.abc import TaskGroup
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from builder.config import ProjectConfig
from builder.jsontypes import JsonObject
from wixy_server.chats import (
    ChatConversation,
    ChatRuntimeEntry,
    add_chat,
    conversation_summary,
    load_chats,
)
from wixy_server.cmdchat import CmdChatClient, CmdChatError, FailedOutcome, ReadyOutcome
from wixy_server.storage import ProjectPaths

router = APIRouter(prefix="/api/admin/chat")

_TEMPLATES_DIR = Path(__file__).parent / "templates"
_PREAMBLE_TEXT = (_TEMPLATES_DIR / "chat_preamble.md").read_text(encoding="utf-8").strip()
_TITLE_MAX_CHARS = 60


def _title_from_first_message(text: str) -> str:
    """spec/06 §1: conversation titles come "from the first user message (≤60
    chars, word-truncated)" — truncate on the last whitespace boundary at-or-
    before the limit, never mid-word."""
    collapsed = " ".join(text.split())
    if len(collapsed) <= _TITLE_MAX_CHARS:
        return collapsed
    truncated = collapsed[:_TITLE_MAX_CHARS]
    boundary = truncated.rfind(" ")
    return (truncated[:boundary] if boundary > 0 else truncated).rstrip() + "…"


def _prompt_for(first_message: str | None) -> str:
    """spec/06 §1's create-time body: `"<PREAMBLE>\\n\\n---\\n\\n<user's first
    message>"` — the preamble alone (no trailing separator) when the owner starts
    a conversation with no opening message (creation without one is explicitly
    supported: "user clicks 'New conversation', optionally with a first
    message")."""
    if first_message is None or first_message.strip() == "":
        return _PREAMBLE_TEXT
    return f"{_PREAMBLE_TEXT}\n\n---\n\n{first_message}"


async def _track_readiness(
    client: CmdChatClient, runtime: dict[str, ChatRuntimeEntry], conv_id: str, session_id: str
) -> None:
    """Runs in the app's own background task group (spawned by `create_conversation`
    below) — drives one conversation's `queued -> ... -> ready`/`failed` transition
    to completion and records the outcome, so `GET .../conversations` (and
    `/api/admin/state`'s `chats` snapshot) can report current status without
    themselves ever talking to cmd."""
    try:
        outcome = await client.wait_until_ready(session_id)
    except CmdChatError as exc:
        # cmd itself unreachable — spec/06 §3's offline-banner case, distinct from
        # a genuine workspace_failed/cli_failed/timeout (decisions/00031 decision 2).
        runtime[conv_id] = ChatRuntimeEntry(
            status="failed", failure_reason="unreachable", failure_message=str(exc)
        )
        return
    if isinstance(outcome, ReadyOutcome):
        runtime[conv_id] = ChatRuntimeEntry(status="ready")
        return
    assert isinstance(outcome, FailedOutcome)
    runtime[conv_id] = ChatRuntimeEntry(
        status="failed", failure_reason=outcome.reason, failure_message=outcome.message
    )


class ConversationCreateIn(BaseModel):
    firstMessage: str | None = None


@router.post("/conversations", response_model=None)
async def create_conversation(body: ConversationCreateIn, request: Request) -> JsonObject:
    project: ProjectConfig = request.app.state.project
    paths: ProjectPaths = request.app.state.paths
    client: CmdChatClient = request.app.state.cmdchat_client
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime
    background: TaskGroup = request.app.state.background_tasks

    first_message = body.firstMessage
    prompt = _prompt_for(first_message)

    try:
        result = await client.new_chat(project.cmd_project, prompt)
    except CmdChatError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach cmd: {exc}") from exc

    conv_id = uuid.uuid4().hex
    title = (
        _title_from_first_message(first_message)
        if first_message is not None and first_message.strip() != ""
        else "New conversation"
    )
    conversation = ChatConversation(
        conv_id=conv_id,
        session_id=result.session_id,
        title=title,
        created_at=datetime.now(UTC).isoformat(),
    )

    def _persist() -> None:
        add_chat(paths.chats_json, conversation)

    await anyio.to_thread.run_sync(_persist)
    runtime[conv_id] = ChatRuntimeEntry(status="pending")

    async def _track() -> None:
        await _track_readiness(client, runtime, conv_id, result.session_id)

    background.start_soon(_track)

    return conversation_summary(conversation, runtime[conv_id])


@router.get("/conversations", response_model=None)
async def list_conversations(request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime

    def _load() -> list[ChatConversation]:
        return load_chats(paths.chats_json)

    conversations = await anyio.to_thread.run_sync(_load)
    newest_first = list(reversed(conversations))
    return {
        "conversations": [conversation_summary(c, runtime.get(c.conv_id)) for c in newest_first]
    }
