"""`/api/admin/chat/*` — conversations (spec/06-ai-chat.md §1).

Milestone 10 slice 2 built identity + provisioning tracking (create/list).
Slice 3 adds: send w/ idempotency, the SSE message/status stream (poll->fan-out,
spec/06 §1's "Live updates"), rename, and handover-follow.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import anyio
from anyio.abc import TaskGroup
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from builder.config import ProjectConfig
from builder.jsontypes import JsonObject
from wixy_server.chats import (
    ChatConversation,
    ChatNotFoundError,
    ChatRuntimeEntry,
    add_chat,
    conversation_summary,
    find_chat,
    load_chats,
    rename_chat,
    update_session_id,
)
from wixy_server.cmdchat import (
    ChatMessage,
    ChatStatus,
    CmdChatClient,
    CmdChatError,
    FailedOutcome,
    ReadyOutcome,
)
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


# ---------------------------------------------------------------------------
# POST /api/admin/chat/conversations/{id}/messages (send)
# ---------------------------------------------------------------------------


class SendMessageIn(BaseModel):
    text: str
    idempotencyKey: str


@router.post("/conversations/{conv_id}/messages", response_model=None)
async def send_message(conv_id: str, body: SendMessageIn, request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    client: CmdChatClient = request.app.state.cmdchat_client

    def _find() -> ChatConversation | None:
        return find_chat(paths.chats_json, conv_id)

    conversation = await anyio.to_thread.run_sync(_find)
    if conversation is None:
        raise HTTPException(status_code=404, detail=f"no conversation with id '{conv_id}'")

    try:
        result = await client.send_message(conversation.session_id, body.text, body.idempotencyKey)
    except CmdChatError as exc:
        # spec/06 §3: "Send 502 / non-delivery -> Bubble-level error + manual
        # retry with the same idempotency key" — the browser keeps the composer
        # text and reuses the SAME idempotencyKey on its own retry; wixy's job
        # here is just to surface a real 502, never to blind-retry a send itself.
        raise HTTPException(status_code=502, detail=f"couldn't deliver: {exc}") from exc

    return {"accepted": True, "buffered": result.buffered}


# ---------------------------------------------------------------------------
# POST /api/admin/chat/conversations/{id}/rename
# ---------------------------------------------------------------------------


class RenameIn(BaseModel):
    title: str


@router.post("/conversations/{conv_id}/rename", response_model=None)
async def rename_conversation(conv_id: str, body: RenameIn, request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime

    def _rename() -> ChatConversation:
        return rename_chat(paths.chats_json, conv_id, body.title)

    try:
        conversation = await anyio.to_thread.run_sync(_rename)
    except ChatNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return conversation_summary(conversation, runtime.get(conv_id))


# ---------------------------------------------------------------------------
# GET /api/admin/chat/conversations/{id}/stream (spec/06 §1's "Live updates")
# ---------------------------------------------------------------------------

DEFAULT_STREAM_POLL_INTERVAL_S = 1.2
DEFAULT_STREAM_OFFLINE_RETRY_S = 10.0
DEFAULT_TRANSCRIPT_GRACE_S = 15.0
"""`transcript_grace_s`'s meaning: how long after a conversation is first
confirmed ready to treat a cmd-side read failure as "still starting" (quiet
retry at the normal poll cadence) rather than "cmd is down" (an `error` event
+ the slower offline-retry cadence) — spec/06 §3's own row: "Transcript store
temporarily missing (brand-new session) — Treat as 'starting…' until first
messages appear (bounded by the 120s readiness timeout)." Cmd-Chats' own
transcript store (9321) can lag just behind the cmd portal's (9320) readiness
signal right after a session first comes up; this window absorbs that without
alarming the owner over a normal, bounded startup race. Deliberately generous
relative to how long that lag should ever realistically last."""


@dataclass(frozen=True, slots=True)
class StreamTiming:
    """Bundled so `create_app`'s tests/E2E-fixture override story (mirrors
    `watcher_interval_s`'s existing convention) doesn't need three separate
    parameters threaded through every call site — production defaults match
    spec/06 §1's own numbers exactly; tests shrink all three to run fast."""

    poll_interval_s: float = DEFAULT_STREAM_POLL_INTERVAL_S
    offline_retry_s: float = DEFAULT_STREAM_OFFLINE_RETRY_S
    transcript_grace_s: float = DEFAULT_TRANSCRIPT_GRACE_S


def _sse(payload: JsonObject) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _message_event(message: ChatMessage) -> JsonObject:
    return {
        "type": "message",
        "message": {
            "index": message.index,
            "role": message.role,
            "kind": message.kind,
            "text": message.text,
            "timestamp": message.timestamp,
            "toolName": message.tool_name,
            "truncated": message.truncated,
        },
    }


def _status_event(status: ChatStatus) -> JsonObject:
    return {
        "type": "status",
        "status": {
            "activity": status.activity,
            "processKind": status.process_kind,
            "handoverState": status.handover_state,
        },
    }


def _error_event(detail: str) -> JsonObject:
    return {"type": "error", "detail": detail}


async def _wait_until_conversation_ready(
    runtime: dict[str, ChatRuntimeEntry], conv_id: str
) -> ChatRuntimeEntry | None:
    """Waits for slice 2's own background tracker (`_track_readiness` above,
    already polling cmd) to resolve — the stream never polls cmd's readiness
    endpoint itself, avoiding a second redundant poller for the same
    conversation. Returns the entry it settled on if that entry is `"failed"`
    (the caller must stop and report it); `None` otherwise (already ready from
    the start, or resolved to ready while waiting — either way, safe to start
    the normal poll loop)."""
    entry = runtime.get(conv_id)
    if entry is None:
        return None
    while entry.status == "pending":
        await anyio.sleep(0.5)
        entry = runtime.get(conv_id)
        if entry is None:
            return None
    return entry if entry.status == "failed" else None


async def _stream_events(
    client: CmdChatClient,
    chats_path: Path,
    runtime: dict[str, ChatRuntimeEntry],
    conv_id: str,
    session_id: str,
    timing: StreamTiming,
) -> AsyncGenerator[str]:
    """Typed as the more specific `AsyncGenerator` (not just `AsyncIterator`)
    deliberately — `test_routes_chat.py` drives this directly and needs
    `.aclose()` (real `AsyncIterator`s don't guarantee it) to cleanly cancel
    whatever `await anyio.sleep(...)` it's suspended at between test
    assertions, since `TestClient` can't be used to observe an infinite SSE
    generator (see that test file's own note)."""
    failed = await _wait_until_conversation_ready(runtime, conv_id)
    if failed is not None:
        detail = failed.failure_message or f"conversation failed to start ({failed.failure_reason})"
        yield _sse(_error_event(detail))
        return

    current_session_id = session_id
    sent_messages: dict[int, ChatMessage] = {}
    last_status: ChatStatus | None = None
    ready_since = anyio.current_time()

    while True:
        try:
            status = await client.get_status(current_session_id)
        except CmdChatError as exc:
            if anyio.current_time() - ready_since < timing.transcript_grace_s:
                await anyio.sleep(timing.poll_interval_s)
                continue
            yield _sse(_error_event(f"cmd unreachable: {exc}"))
            await anyio.sleep(timing.offline_retry_s)
            continue

        if status.handover_state is not None:
            # spec/06 §1: "Detect + follow: watch .../status for handover_state
            # ... then call .../chain, adopt the LAST element as the live
            # session id, update chats.json, and continue seamlessly."
            try:
                chain = await client.get_chain(current_session_id)
            except CmdChatError:
                chain = []
            leaf = chain[-1] if chain else None
            if leaf is not None and leaf != current_session_id:
                await anyio.to_thread.run_sync(update_session_id, chats_path, conv_id, leaf)
                current_session_id = leaf
                sent_messages = {}
                last_status = None
                continue

        try:
            messages = await client.get_messages(current_session_id, limit=80)
        except CmdChatError as exc:
            if anyio.current_time() - ready_since < timing.transcript_grace_s:
                await anyio.sleep(timing.poll_interval_s)
                continue
            yield _sse(_error_event(f"cmd unreachable: {exc}"))
            await anyio.sleep(timing.offline_retry_s)
            continue

        # "polls /messages (new-since-index)" (spec/06 §1) — cmd's own API has
        # no `since=` filter, so wixy fetches the latest batch every tick and
        # diffs it itself: an unseen index is new, a seen index whose content
        # changed (e.g. a `truncated` preview later arriving in full) is an
        # update, and either way is forwarded — a bare newer-index check alone
        # would miss the latter.
        for message in messages:
            if sent_messages.get(message.index) != message:
                sent_messages[message.index] = message
                yield _sse(_message_event(message))

        if status != last_status:
            last_status = status
            yield _sse(_status_event(status))

        await anyio.sleep(timing.poll_interval_s)


@router.get("/conversations/{conv_id}/stream")
async def conversation_stream(conv_id: str, request: Request) -> StreamingResponse:
    paths: ProjectPaths = request.app.state.paths
    client: CmdChatClient = request.app.state.cmdchat_client
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime
    timing: StreamTiming = request.app.state.chat_stream_timing

    def _find() -> ChatConversation | None:
        return find_chat(paths.chats_json, conv_id)

    conversation = await anyio.to_thread.run_sync(_find)
    if conversation is None:
        raise HTTPException(status_code=404, detail=f"no conversation with id '{conv_id}'")

    async def _events() -> AsyncIterator[str]:
        async for payload in _stream_events(
            client, paths.chats_json, runtime, conv_id, conversation.session_id, timing
        ):
            yield payload

    return StreamingResponse(_events(), media_type="text/event-stream")
