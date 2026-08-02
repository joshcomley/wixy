"""`/api/admin/chat/*` — conversations (spec/06-ai-chat.md §1).

Milestone 10 slice 2 built identity + provisioning tracking (create/list).
Slice 3 adds: send w/ idempotency, the SSE message/status stream (poll->fan-out,
spec/06 §1's "Live updates"), rename, and handover-follow.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

import anyio
from anyio.abc import TaskGroup
from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from builder.jsontypes import JsonObject
from wixy_server.ai.backend import (
    AIBackend,
    AIBackendError,
    ConversationRef,
    UploadNotFoundError,
)
from wixy_server.chat_attachments import (
    AttachmentError,
    ChatAttachmentRef,
    validate_attachment,
)
from wixy_server.chat_sends import ChatSend, ChatSendsCache, decorate_messages
from wixy_server.chat_tasks import TaskItem, extract_tasks
from wixy_server.chat_working import WorkingCache
from wixy_server.chats import (
    ChatConversation,
    ChatNotFoundError,
    ChatRuntimeEntry,
    add_chat,
    conversation_summary,
    effective_status,
    find_chat,
    load_chats,
    rename_chat,
    update_session_id,
)
from wixy_server.cmdchat import ChatMessage, ChatStatus, FailedOutcome, ReadyOutcome
from wixy_server.preamble import PREAMBLE_TEXT, compose_prompt, strip_preamble
from wixy_server.storage import ProjectPaths

router = APIRouter(prefix="/api/admin/chat")

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


async def _track_readiness(
    client: AIBackend, runtime: dict[str, ChatRuntimeEntry], conv_id: str, session_id: str
) -> None:
    """Runs in the app's own background task group (spawned by `create_conversation`
    below) — drives one conversation's `queued -> ... -> ready`/`failed` transition
    to completion and records the outcome, so `GET .../conversations` (and
    `/api/admin/state`'s `chats` snapshot) can report current status without
    themselves ever talking to cmd."""
    try:
        outcome = await client.wait_until_ready(ConversationRef(id=session_id))
    except AIBackendError as exc:
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
    """decisions/00110: images to attach to the FIRST turn — upload ids staged
    beforehand via `POST /api/admin/chat/uploads` (the session-less variant of
    the per-conversation upload route, since no conversation exists yet).
    cmd's own new-chat route folds them into the first turn as real stream-
    json image blocks (its `_stage_new_chat_attachments` → the workspace
    provisioner's `content_blocks` drain)."""
    attachmentIds: list[str] = []


@router.post("/conversations", response_model=None)
async def create_conversation(body: ConversationCreateIn, request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    client: AIBackend = request.app.state.ai_backend
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime
    background: TaskGroup = request.app.state.background_tasks
    sends: ChatSendsCache = request.app.state.chat_sends

    first_message = body.firstMessage
    if body.attachmentIds and not client.supports_attachments:
        # Same "explicit unsupported, never silently dropped" gate as
        # `send_message` and the upload routes (decisions/00103, 00110).
        raise HTTPException(
            status_code=422, detail="this conversation's backend doesn't support image attachments"
        )
    # spec/06 §1's create-time body ("<PREAMBLE>\n\n---\n\n<first message>", or
    # the preamble alone with no opening message) is now the BACKEND's own job
    # (spec/independence/05 §1: create_conversation takes preamble + first_message
    # separately) — CmdAIBackend combines them identically to what this route used
    # to do itself; a future backend may combine them differently.
    try:
        result = await client.create_conversation(
            PREAMBLE_TEXT, first_message, attachment_ids=body.attachmentIds or None
        )
    except AIBackendError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't reach cmd: {exc}") from exc

    conv_id = uuid.uuid4().hex
    title = (
        _title_from_first_message(first_message)
        if first_message is not None and first_message.strip() != ""
        else "New conversation"
    )
    conversation = ChatConversation(
        conv_id=conv_id,
        session_id=result.id,
        title=title,
        created_at=datetime.now(UTC).isoformat(),
    )

    send_record: ChatSend | None = None
    if body.attachmentIds:
        # decisions/00110: cmd folds the attachments into the first turn as
        # image content blocks, which cmd's decoder DROPS on read-back (no
        # footer, no trace) — log the send so the stream can re-decorate
        # the first message from wixy's own record. The match text is the
        # FULL composed prompt (preamble included): that's the text the
        # first read-back user message carries before `_owner_visible`
        # strips the preamble downstream. STRIPPED, because cmd's decoder
        # strips each text block on read-back — the record must be stored
        # in the exact form the read-back will have.
        send_record = ChatSend(
            conv_id=conv_id,
            text=compose_prompt(PREAMBLE_TEXT, first_message).strip(),
            sent_at=conversation.created_at,
            attachments=tuple(ChatAttachmentRef(upload_id=uid) for uid in body.attachmentIds),
        )

    def _persist() -> None:
        add_chat(paths.chats_json, conversation)
        if send_record is not None:
            sends.record(send_record)

    await anyio.to_thread.run_sync(_persist)
    if send_record is not None:
        sends.note(send_record)
    runtime[conv_id] = ChatRuntimeEntry(status="pending")

    async def _track() -> None:
        await _track_readiness(client, runtime, conv_id, result.id)

    background.start_soon(_track)

    return conversation_summary(conversation, runtime[conv_id])


@router.get("/conversations", response_model=None)
async def list_conversations(request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime
    client: AIBackend = request.app.state.ai_backend
    working_cache: WorkingCache = request.app.state.chat_working_cache

    def _load() -> list[ChatConversation]:
        return load_chats(paths.chats_json)

    conversations = await anyio.to_thread.run_sync(_load)
    newest_first = list(reversed(conversations))
    # "Working" only means anything for a conversation past provisioning —
    # a pending/failed one has no live cmd status worth polling.
    ready = [c for c in newest_first if effective_status(runtime.get(c.conv_id)) == "ready"]
    working = await working_cache.working_for(client, ready)
    return {
        "conversations": [
            conversation_summary(c, runtime.get(c.conv_id), working=working.get(c.conv_id, False))
            for c in newest_first
        ]
    }


# ---------------------------------------------------------------------------
# POST /api/admin/chat/conversations/{id}/messages (send)
# ---------------------------------------------------------------------------


class SendMessageIn(BaseModel):
    text: str
    idempotencyKey: str
    attachmentIds: list[str] = []


@router.post("/conversations/{conv_id}/messages", response_model=None)
async def send_message(conv_id: str, body: SendMessageIn, request: Request) -> JsonObject:
    paths: ProjectPaths = request.app.state.paths
    client: AIBackend = request.app.state.ai_backend
    sends: ChatSendsCache = request.app.state.chat_sends

    def _find() -> ChatConversation | None:
        return find_chat(paths.chats_json, conv_id)

    conversation = await anyio.to_thread.run_sync(_find)
    if conversation is None:
        raise HTTPException(status_code=404, detail=f"no conversation with id '{conv_id}'")

    if body.attachmentIds and not client.supports_attachments:
        # Never silently drop an attachment the owner thinks was sent (the
        # same "explicit unsupported, not a silent gap" posture decisions/
        # 00101 already established for this exact backend/capability split).
        raise HTTPException(
            status_code=422, detail="this conversation's backend doesn't support image attachments"
        )

    try:
        result = await client.send(
            ConversationRef(id=conversation.session_id),
            body.text,
            body.idempotencyKey,
            attachment_ids=body.attachmentIds or None,
        )
    except AIBackendError as exc:
        # spec/06 §3: "Send 502 / non-delivery -> Bubble-level error + manual
        # retry with the same idempotency key" — the browser keeps the composer
        # text and reuses the SAME idempotencyKey on its own retry; wixy's job
        # here is just to surface a real 502, never to blind-retry a send itself.
        raise HTTPException(status_code=502, detail=f"couldn't deliver: {exc}") from exc

    if body.attachmentIds:
        # decisions/00110: if cmd routed this send to stream-json (a real
        # image block, no footer), cmd's read-back carries no trace of the
        # attachment — log it so the stream re-decorates from wixy's own
        # record. A driver-routed send leaves its `Attachments:` footer in
        # the text instead, which the cmd client's footer parser recovers —
        # the log simply never matches (the footer-parsed message already
        # has attachments and is skipped by `decorate_messages`), so logging
        # unconditionally is correct for BOTH routings.
        send_record = ChatSend(
            conv_id=conv_id,
            # Stripped, matching the exact form cmd's decoder produces on
            # read-back (it strips each text block) so the stream's text
            # match hits (see chat_sends.py's contract).
            text=body.text.strip(),
            sent_at=datetime.now(UTC).isoformat(),
            attachments=tuple(ChatAttachmentRef(upload_id=uid) for uid in body.attachmentIds),
        )

        def _persist_send() -> None:
            sends.record(send_record)

        await anyio.to_thread.run_sync(_persist_send)
        sends.note(send_record)

    return {"accepted": True, "buffered": result.buffered}


# ---------------------------------------------------------------------------
# POST /api/admin/chat/conversations/{id}/attachments
# ---------------------------------------------------------------------------


@router.post("/conversations/{conv_id}/attachments", response_model=None)
async def upload_attachment(
    conv_id: str, request: Request, file: Annotated[UploadFile, File()]
) -> JsonObject:
    """Stages one image for a later `send_message(attachmentIds=[...])` call —
    NOT itself part of a send. cmd does the actual resize/re-encode (decisions/
    00103); this route's own job is the size/type/readability guard
    (`chat_attachments.validate_attachment`) that turns a bad upload into an
    immediate, clear 422 instead of a round-trip to cmd for its own 413/400."""
    paths: ProjectPaths = request.app.state.paths
    client: AIBackend = request.app.state.ai_backend

    def _find() -> ChatConversation | None:
        return find_chat(paths.chats_json, conv_id)

    conversation = await anyio.to_thread.run_sync(_find)
    if conversation is None:
        raise HTTPException(status_code=404, detail=f"no conversation with id '{conv_id}'")

    if not client.supports_attachments:
        raise HTTPException(
            status_code=422, detail="this conversation's backend doesn't support image attachments"
        )

    data = await file.read()
    content_type = file.content_type or ""
    try:
        validate_attachment(data, content_type)
    except AttachmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    filename = file.filename or "attachment"
    try:
        result = await client.upload_attachment(
            ConversationRef(id=conversation.session_id), data, filename, content_type
        )
    except AIBackendError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't upload: {exc}") from exc

    return {"attachmentId": result.upload_id, "width": result.width, "height": result.height}


# ---------------------------------------------------------------------------
# POST /api/admin/chat/uploads (session-less stage, decisions/00110)
# GET  /api/admin/chat/uploads/{upload_id}/bytes (thumbnail/full-image proxy)
# ---------------------------------------------------------------------------


@router.post("/uploads", response_model=None)
async def upload_attachment_unscoped(
    request: Request, file: Annotated[UploadFile, File()]
) -> JsonObject:
    """The "New conversation" compose's upload route — identical validation and
    response shape to the per-conversation route above, but unscoped: no
    conversation exists to key the upload to yet (the owner is still composing
    the FIRST message). cmd's own `/api/uploads` treats the session id as an
    optional ownership hint for its janitor (its new-chat compose stages
    uploads the same way), so the id minted here is referenced by a later
    `create_conversation(attachmentIds=[...])` exactly like a scoped one."""
    client: AIBackend = request.app.state.ai_backend
    if not client.supports_attachments:
        raise HTTPException(
            status_code=422, detail="this conversation's backend doesn't support image attachments"
        )

    data = await file.read()
    content_type = file.content_type or ""
    try:
        validate_attachment(data, content_type)
    except AttachmentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    filename = file.filename or "attachment"
    try:
        result = await client.upload_attachment(None, data, filename, content_type)
    except AIBackendError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't upload: {exc}") from exc

    return {"attachmentId": result.upload_id, "width": result.width, "height": result.height}


@router.get("/uploads/{upload_id}/bytes", response_model=None)
async def get_upload_bytes(upload_id: str, request: Request) -> Response:
    """Proxy cmd's own `GET /api/uploads/{id}/bytes` through the admin origin —
    the transcript's attachment thumbnails/lightbox point here (decisions/
    00110); the browser must never see cmd's localhost-only surface. The
    served bytes are immutable (cmd converts once, at upload), so the response
    is cacheable forever; an unknown or janitor-swept id mirrors cmd's own
    404/410 rather than flattening to a 502."""
    client: AIBackend = request.app.state.ai_backend
    if not client.supports_attachments:
        raise HTTPException(
            status_code=422, detail="this conversation's backend doesn't support image attachments"
        )
    try:
        result = await client.fetch_upload_bytes(upload_id)
    except UploadNotFoundError as exc:
        raise HTTPException(
            status_code=404, detail="that upload doesn't exist (or expired)"
        ) from exc
    except AIBackendError as exc:
        raise HTTPException(status_code=502, detail=f"couldn't fetch the upload: {exc}") from exc
    return Response(
        content=result.content,
        media_type=result.media_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


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
    message_payload: JsonObject = {
        "index": message.index,
        "role": message.role,
        "kind": message.kind,
        "text": message.text,
        "timestamp": message.timestamp,
        "toolName": message.tool_name,
        "truncated": message.truncated,
    }
    if message.attachments:
        # decisions/00110: image refs for the transcript's thumbnail grid —
        # present only when non-empty so a plain text message's envelope is
        # byte-identical to before this feature (same convention as
        # `send_message`'s `attachments` field).
        message_payload["attachments"] = [
            {
                "uploadId": ref.upload_id,
                "name": ref.name,
                "width": ref.width,
                "height": ref.height,
            }
            for ref in message.attachments
        ]
    return {"type": "message", "message": message_payload}


def _status_event(status: ChatStatus) -> JsonObject:
    return {
        "type": "status",
        "status": {
            "activity": status.activity,
            "processKind": status.process_kind,
            "handoverState": status.handover_state,
        },
    }


def _tasks_event(tasks: list[TaskItem], message_index: int) -> JsonObject:
    return {
        "type": "tasks",
        "tasks": [{"label": t.label, "status": t.status} for t in tasks],
        "messageIndex": message_index,
    }


def _error_event(detail: str) -> JsonObject:
    return {"type": "error", "detail": detail}


def _owner_visible(message: ChatMessage) -> ChatMessage | None:
    """One transcript message as the site OWNER should see it, or `None` for one
    they should never see at all (decisions/00093).

    The only thing filtered today is the site-assistant preamble, which spec/06 §1
    prepends to the create call's prompt and therefore lives inside the
    conversation's first user message. It is this server's own plumbing — the
    owner didn't write it, it leaks internal instructions and repo paths into a
    non-developer's chat, and at ~1.4 KB it visually swamped the panel (a wall of
    text above their actual message).

    Filtered HERE, at the stream boundary, rather than in the panel: the UI is
    backend-blind by design (spec/independence/05 §1), so "what the owner may see"
    is a server decision, and doing it here covers both backends and any future
    client at once. The transcript cmd/the worker holds is deliberately left
    intact — the model still needs the preamble on every turn; only the rendering
    of it is suppressed.
    """
    if message.role != "user" or message.kind != "text" or message.text is None:
        return message
    visible = strip_preamble(message.text)
    if visible is None:
        # decisions/00110: a preamble-only message that CARRIES attachments
        # (an image-only first message — the owner started the conversation
        # with just a photo) must survive: the prose was all preamble, but
        # the images are the owner's own content. Emit it with `text=None`
        # so the bubble renders as thumbnails-only.
        if message.attachments:
            return replace(message, text=None)
        return None
    if visible == message.text:
        return message
    return replace(message, text=visible)


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
    client: AIBackend,
    chats_path: Path,
    runtime: dict[str, ChatRuntimeEntry],
    conv_id: str,
    session_id: str,
    timing: StreamTiming,
    chat_sends: ChatSendsCache | None = None,
    *,
    include_thinking: bool = False,
) -> AsyncGenerator[str]:
    """Typed as the more specific `AsyncGenerator` (not just `AsyncIterator`)
    deliberately — `test_routes_chat.py` drives this directly and needs
    `.aclose()` (real `AsyncIterator`s don't guarantee it) to cleanly cancel
    whatever `await anyio.sleep(...)` it's suspended at between test
    assertions, since `TestClient` can't be used to observe an infinite SSE
    generator (see that test file's own note).

    `include_thinking` (spec/06 §1: "thinking hidden behind a 'show reasoning'
    toggle default-off... lazily fetched with include_thinking=true only when
    the toggle opens") — cmd's own `/messages` never includes `kind:
    "thinking"` entries unless asked; there's no separate REST endpoint for
    this in spec's own admin API index (04 §8), so the toggle reconnects this
    SAME stream with the query param flipped (`conversation_stream` below)
    rather than adding a new route.
    """
    failed = await _wait_until_conversation_ready(runtime, conv_id)
    if failed is not None:
        detail = failed.failure_message or f"conversation failed to start ({failed.failure_reason})"
        yield _sse(_error_event(detail))
        return

    current_session_id = session_id
    sent_messages: dict[int, ChatMessage] = {}
    last_status: ChatStatus | None = None
    last_tasks_sent: list[TaskItem] | None = None
    ready_since = anyio.current_time()

    while True:
        try:
            status = await client.status(ConversationRef(id=current_session_id))
        except AIBackendError as exc:
            if anyio.current_time() - ready_since < timing.transcript_grace_s:
                await anyio.sleep(timing.poll_interval_s)
                continue
            yield _sse(_error_event(f"cmd unreachable: {exc}"))
            await anyio.sleep(timing.offline_retry_s)
            continue

        if client.supports_handover_chains and status.handover_state is not None:
            # spec/06 §1: "Detect + follow: watch .../status for handover_state
            # ... then call .../chain, adopt the LAST element as the live
            # session id, update chats.json, and continue seamlessly." Only
            # meaningful on a backend that has a fleet handover concept at all
            # (spec/independence/05 §1's supports_handover_chains flag) — the
            # future anthropic backend never sets handover_state in the first
            # place, so this stays dead code for it, not a wrong call.
            try:
                chain = await client.get_chain(ConversationRef(id=current_session_id))
            except AIBackendError:
                chain = []
            leaf = chain[-1] if chain else None
            if leaf is not None and leaf != current_session_id:
                await anyio.to_thread.run_sync(update_session_id, chats_path, conv_id, leaf)
                current_session_id = leaf
                sent_messages = {}
                last_status = None
                continue

        try:
            messages = await client.read(
                ConversationRef(id=current_session_id), limit=80, include_thinking=include_thinking
            )
        except AIBackendError as exc:
            if anyio.current_time() - ready_since < timing.transcript_grace_s:
                await anyio.sleep(timing.poll_interval_s)
                continue
            yield _sse(_error_event(f"cmd unreachable: {exc}"))
            await anyio.sleep(timing.offline_retry_s)
            continue

        # decisions/00110: re-attach anything wixy itself sent that cmd's
        # read-back can't carry (a stream-json-routed send leaves no trace —
        # see chat_sends.py's docstring). Runs on the RAW messages, BEFORE
        # `_owner_visible`: the create-time send record matches on the full
        # composed prompt, preamble included, and a preamble-only message that
        # thereby gains attachments must then SURVIVE the strip (an image-only
        # first message — `_owner_visible` keeps those deliberately).
        # Driver-routed sends need nothing here: the cmd client's footer
        # parser already decorated them, and `decorate_messages` skips any
        # message that already has attachments. `None` (tests that predate
        # the send log and never record) simply decorates nothing — the
        # footer-parse half of the coverage works regardless.
        sends = chat_sends.for_conversation(conv_id) if chat_sends is not None else []
        messages = decorate_messages(messages, sends)

        # "polls /messages (new-since-index)" (spec/06 §1) — cmd's own API has
        # no `since=` filter, so wixy fetches the latest batch every tick and
        # diffs it itself: an unseen index is new, a seen index whose content
        # changed (e.g. a `truncated` preview later arriving in full) is an
        # update, and either way is forwarded — a bare newer-index check alone
        # would miss the latter.
        for raw_message in messages:
            # Filtered before the diff so the cache holds exactly what was sent —
            # comparing raw messages while emitting stripped ones would re-send
            # the first message on every poll.
            message = _owner_visible(raw_message)
            if message is None:
                continue
            # wixy-tasks extraction runs AFTER _owner_visible (that function's
            # own docstring order: strip what must never be seen at all,
            # THEN extract structured protocol from what remains) and BEFORE
            # the sent_messages diff, for the same reason the preamble strip
            # runs before it — the cache must hold exactly the cleaned text
            # that was actually sent, or a re-poll with an unchanged block
            # would look like a content change forever.
            tasks: list[TaskItem] | None = None
            if message.role == "assistant" and message.kind == "text" and message.text is not None:
                cleaned_text, tasks = extract_tasks(message.text)
                if cleaned_text != message.text:
                    message = replace(message, text=cleaned_text)
            if sent_messages.get(message.index) != message:
                sent_messages[message.index] = message
                yield _sse(_message_event(message))
            # Gated on the TASKS changing, not the message changing: a model
            # that re-emits the block with an updated status but byte-
            # identical surrounding prose produces no message-event delta at
            # all (the cleaned text is unchanged either way), so this must be
            # its own independent diff or a real progress update would never
            # reach the owner.
            if tasks is not None and tasks != last_tasks_sent:
                last_tasks_sent = tasks
                yield _sse(_tasks_event(tasks, message.index))

        if status != last_status:
            last_status = status
            yield _sse(_status_event(status))

        await anyio.sleep(timing.poll_interval_s)


@router.get("/conversations/{conv_id}/stream")
async def conversation_stream(
    conv_id: str, request: Request, includeThinking: bool = False
) -> StreamingResponse:
    paths: ProjectPaths = request.app.state.paths
    client: AIBackend = request.app.state.ai_backend
    runtime: dict[str, ChatRuntimeEntry] = request.app.state.chat_runtime
    timing: StreamTiming = request.app.state.chat_stream_timing
    sends: ChatSendsCache = request.app.state.chat_sends

    def _find() -> ChatConversation | None:
        return find_chat(paths.chats_json, conv_id)

    conversation = await anyio.to_thread.run_sync(_find)
    if conversation is None:
        raise HTTPException(status_code=404, detail=f"no conversation with id '{conv_id}'")

    async def _events() -> AsyncIterator[str]:
        async for payload in _stream_events(
            client,
            paths.chats_json,
            runtime,
            conv_id,
            conversation.session_id,
            timing,
            sends,
            include_thinking=includeThinking,
        ):
            yield payload

    return StreamingResponse(_events(), media_type="text/event-stream")
