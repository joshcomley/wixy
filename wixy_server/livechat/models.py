"""Row types for `LiveChatStore` (spec/server-chat/00-brief.md §4) plus the wire
serializers `message_json`/`attachment_json` (§5.9). Frozen slotted dataclasses — the
store never hands out anything mutable, so a route handler can't accidentally hold a
stale row across an `anyio.to_thread.run_sync` boundary and mutate it in place.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from builder.jsontypes import JsonObject

AttachmentKind = Literal["photo", "video", "voice"]
AttachmentStatus = Literal["processing", "ready", "failed"]
TranscriptStatus = Literal["pending", "done", "failed"]
EventType = Literal["message", "message_updated", "message_deleted", "wiped"]
"""§17.2 amendment A1: `message_deleted`/`wiped` are P8's future events (delete a
message / wipe the chat) — P1 only widens the schema + stream so v1 never needs a
breaking rebuild migration later. Nothing in P1 actually EMITS these two yet."""


MessageHook = Callable[["MessageRow"], Awaitable[None]]
"""`app.state.livechat_message_hooks`'s element type (§4 "App state"): run on the
background task group after a *created* message commits. P3 appends the push
dispatch hook; P1 just declares the (empty, at P1-land-time) list."""


class MediaUrlSigner(Protocol):
    """What `attachment_json` needs to mint a signed media URL (§5.6) — satisfied
    structurally by `livechat.tokens.MediaSigner`, bound to one request's email +
    token expiry. Kept as a `Protocol` here (rather than importing `tokens.py`) so
    `models.py` stays a leaf module with no dependency on the auth/token layer."""

    def url_for(self, attachment_id: str, rendition: str) -> str: ...


@dataclass(frozen=True, slots=True)
class TranscriptRow:
    """One voice note's opt-in transcript (spec/server-chat/05-voice-transcription.md).
    `text` is message-derived private content: it exists only in this row (erased with
    its attachment by `ON DELETE CASCADE`) and on the wire — never in a log line."""

    attachment_id: str
    status: TranscriptStatus
    text: str | None
    failure: str | None
    engine: str | None
    created_at: float
    updated_at: float


@dataclass(frozen=True, slots=True)
class AttachmentRow:
    id: str
    kind: AttachmentKind
    status: AttachmentStatus
    message_seq: int | None
    ordinal: int | None
    mime: str | None
    width: int | None
    height: int | None
    duration_s: float | None
    peaks: tuple[float, ...] | None
    renditions: tuple[str, ...]
    bytes_on_disk: int
    failure: str | None
    lease_owner: str | None
    lease_expires_at: float | None
    created_at: float
    updated_at: float
    transcript: TranscriptRow | None = None


@dataclass(frozen=True, slots=True)
class MessageRow:
    seq: int
    client_id: str
    sender: str
    device_id: str
    by_email: str | None
    text: str | None
    created_at: float
    attachments: tuple[AttachmentRow, ...] = ()


@dataclass(frozen=True, slots=True)
class EventRow:
    event_seq: int
    type: EventType
    message_seq: int | None  # §17.2 A1: NULL for a 'wiped' event
    created_at: float


@dataclass(frozen=True, slots=True)
class UploadRow:
    id: str
    kind: AttachmentKind
    mime: str
    size_bytes: int
    filename: str | None
    by_email: str | None
    created_at: float


@dataclass(frozen=True, slots=True)
class PushSubscriptionRow:
    device_id: str
    sender: str
    endpoint: str
    p256dh: str
    auth: str
    created_at: float
    last_ok_at: float | None
    consecutive_failures: int


@dataclass(frozen=True, slots=True)
class AttachmentResult:
    """What P2's `processing.py` hands back to `LiveChatStore.finish_attachment` —
    everything a completed (or failed) processing run learned about one attachment."""

    status: Literal["ready", "failed"]
    mime: str | None
    width: int | None
    height: int | None
    duration_s: float | None
    peaks: tuple[float, ...] | None
    renditions: tuple[str, ...]
    bytes_on_disk: int
    failure: str | None


def transcript_json(row: TranscriptRow | None) -> JsonObject | None:
    """The `Attachment.transcript` wire shape: `null` (never asked) or `{status}` with
    `text` only once `done`. A failed row carries no reason on the wire — the machine-readable
    `failure` code stays server-side."""
    if row is None:
        return None
    if row.status == "done":
        return {"status": "done", "text": row.text if row.text is not None else ""}
    return {"status": row.status}


def attachment_json(row: AttachmentRow, signer: MediaUrlSigner) -> JsonObject:
    """§5.9's `Attachment` wire shape. `urls` carries only READY renditions — a
    processing/failed attachment has nothing safe to link to yet (Inv 41: a token in
    a query string is the only auth a `<img>`/`<video>`/`<audio>` tag can carry, so
    it's minted here, per-response, never precomputed and stored)."""
    urls: JsonObject = {}
    if row.status == "ready":
        for rendition in row.renditions:
            urls[rendition] = signer.url_for(row.id, rendition)
    return {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "width": row.width,
        "height": row.height,
        "durationS": row.duration_s,
        "peaks": list(row.peaks) if row.peaks is not None else None,
        "urls": urls,
        "transcript": transcript_json(row.transcript),
    }


def message_json(row: MessageRow, signer: MediaUrlSigner) -> JsonObject:
    """§5.9's `Message` wire shape."""
    return {
        "seq": row.seq,
        "clientId": row.client_id,
        "sender": row.sender,
        "text": row.text,
        "attachments": [attachment_json(a, signer) for a in row.attachments],
        "createdAt": row.created_at,
    }
