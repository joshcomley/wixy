"""Row types for `LiveChatStore` (spec/server-chat/00-brief.md §4) plus the wire
serializers `message_json`/`attachment_json` (§5.9). Frozen slotted dataclasses — the
store never hands out anything mutable, so a route handler can't accidentally hold a
stale row across an `anyio.to_thread.run_sync` boundary and mutate it in place.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from builder.jsontypes import JsonObject, JsonValue

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
    view_once_renditions: tuple[str, ...] | None = None


@dataclass(frozen=True, slots=True)
class ReactionSummary:
    """One emoji on one message: who reacted, oldest first. `by_email` is deliberately
    absent — it is an audit column and never leaves the store."""

    emoji: str
    senders: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DrawingSummary:
    """spec/server-chat/07-live-drawing.md §4: what a `Message` carries about its
    drawings — enough for a client to notice "there's a drawing here I don't have, or
    it changed" and fetch the body with `GET /messages/{seq}/drawings`. Never the
    strokes themselves: a history page of 50 messages must not carry megabytes of
    points."""

    id: int
    rev: int


@dataclass(frozen=True, slots=True)
class DrawingStrokeRow:
    stroke_id: str
    ord: int
    color: str
    width: int
    points: tuple[tuple[int, int], ...]
    created_at: float


@dataclass(frozen=True, slots=True)
class DrawingRow:
    """One drawing (spec §2: every stroke made in one pen session, from turning the pen
    on to turning it off) anchored to a message. `strokes` is ordered by `ord`."""

    id: int
    client_id: str
    anchor_message_seq: int
    sender: str
    device_id: str
    by_email: str | None
    column_width: float
    rev: int
    created_at: float
    updated_at: float
    strokes: tuple[DrawingStrokeRow, ...] = ()

    def summary(self) -> DrawingSummary:
        return DrawingSummary(id=self.id, rev=self.rev)


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
    drawings: tuple[DrawingSummary, ...] = ()
    reply_to_seq: int | None = None
    """The stored `messages.reply_to_seq` column — the ONLY thing a reply
    persists (round 2 ruling item 10 §(2)). `None` for an ordinary message, or
    for a reply whose target has since been deleted (`ON DELETE SET NULL`)."""
    reply_to: MessageRow | None = None
    """The target row, resolved at READ time in the same transaction as this
    message (never stored, never copied) — `None` when `reply_to_seq` is
    `None`. Loaded ONE LEVEL ONLY: a target's own `reply_to` is always `None`
    here, so a quote never shows the target's own quote."""
    view_once_s: int | None = None
    view_spotlight: int = 0
    view_claim_id: str | None = None
    view_claimed_at: float | None = None
    view_claim_email: str | None = None


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
class DeviceGrantRow:
    """spec/server-chat/03-permanent-unlock.md §3: ids and a hash only — never the
    secret itself, and never chat content."""

    id: str
    secret_hash: str
    email: str
    label: str | None
    created_at: float
    last_used_at: float
    revoked_at: float | None


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


_REPLY_QUOTE_TEXT_MAX_CODEPOINTS = 300
"""Round 2 ruling item 10 §(3): a quote's text snippet is the target's own text
cut to 300 Unicode CODE POINTS — Python `str` indexing is already codepoint-safe
(never splits a surrogate pair), matching the TS side's `Array.from(text).
slice(0, 300).join("")`."""


def _reply_quote_media_json(
    attachments: tuple[AttachmentRow, ...], signer: MediaUrlSigner, *, view_once: bool = False
) -> JsonObject | None:
    """§(3)'s `media` member of a quote — `null` for a text-only target, else a
    summary built from the target's OWN attachment rows (never a copy stored on
    the reply). `thumbUrl` is minted fresh here, per response, exactly like
    `attachment_json`'s own `urls` — never precomputed or stored."""
    if not attachments:
        return None
    kinds = {a.kind for a in attachments}
    kind = next(iter(kinds)) if len(kinds) == 1 else "mixed"
    count = len(attachments)
    first = attachments[0]
    duration_s = first.duration_s if count == 1 else None
    thumb_url: str | None = None
    if not view_once and first.status == "ready":
        rendition: str | None = None
        if first.kind == "photo":
            rendition = "thumb"
        elif first.kind == "video":
            rendition = "poster"
        if rendition is not None and rendition in first.renditions:
            thumb_url = signer.url_for(first.id, rendition)
    res: JsonObject = {
        "kind": kind,
        "count": count,
        "durationS": duration_s,
        "thumbUrl": thumb_url,
    }
    if view_once:
        res["viewOnce"] = True
    return res


def reply_to_json(target: MessageRow | None, signer: MediaUrlSigner) -> JsonObject | None:
    """§(3)'s `replyTo` member of the `Message` wire shape — built fresh from
    the LIVE target row every time (never a stored copy, per Inv 46/Inv 40's
    erasure guarantee: deleting the target makes this `null` everywhere it was
    quoted, with no chat-visible tombstone)."""
    if target is None:
        return None
    text = target.text
    snippet = text
    truncated = False
    if text is not None and len(text) > _REPLY_QUOTE_TEXT_MAX_CODEPOINTS:
        snippet = text[:_REPLY_QUOTE_TEXT_MAX_CODEPOINTS]
        truncated = True
    view_once = target.view_once_s is not None
    return {
        "seq": target.seq,
        "sender": target.sender,
        "text": snippet,
        "truncated": truncated,
        "media": _reply_quote_media_json(target.attachments, signer, view_once=view_once),
    }


def message_json(row: MessageRow, signer: MediaUrlSigner) -> JsonObject:
    """§5.9's `Message` wire shape."""
    view_once: dict[str, JsonValue] | None = (
        None
        if row.view_once_s is None
        else {
            "durationS": None if row.view_once_s == 0 else row.view_once_s,
            "spotlight": bool(row.view_spotlight),
        }
    )
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
        "replyTo": reply_to_json(row.reply_to, signer),
        "viewOnce": view_once,
        "drawings": [{"id": d.id, "rev": d.rev} for d in row.drawings],
    }


def drawing_stroke_json(row: DrawingStrokeRow) -> JsonObject:
    return {
        "strokeId": row.stroke_id,
        "color": row.color,
        "width": row.width,
        "points": [list(point) for point in row.points],
    }


def drawing_json(row: DrawingRow) -> JsonObject:
    """§4's per-drawing shape inside `GET /messages/{seq}/drawings`."""
    return {
        "id": row.id,
        "rev": row.rev,
        "sender": row.sender,
        "columnWidth": row.column_width,
        "strokes": [drawing_stroke_json(s) for s in row.strokes],
    }
