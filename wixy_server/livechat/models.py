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


@dataclass(frozen=True, slots=True)
class ReactionSummary:
    """One emoji on one message: who reacted, oldest first. `by_email` is deliberately
    absent — it is an audit column and never leaves the store."""

    emoji: str
    senders: tuple[str, ...]


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
    reactions: tuple[ReactionSummary, ...] = ()


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
    }


def message_json(row: MessageRow, signer: MediaUrlSigner) -> JsonObject:
    """§5.9's `Message` wire shape."""
    return {
        "seq": row.seq,
        "clientId": row.client_id,
        "sender": row.sender,
        "text": row.text,
        "attachments": [attachment_json(a, signer) for a in row.attachments],
        "reactions": [
            {"emoji": r.emoji, "count": len(r.senders), "senders": list(r.senders)}
            for r in row.reactions
        ],
        "createdAt": row.created_at,
    }
