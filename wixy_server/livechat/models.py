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

WyrState = Literal["voting", "answering", "revealing", "revealed", "skipped"]
"""The would-you-rather round's states: both players vote skip/play (`voting`),
both answer privately (`answering`), both press Reveal (`revealing`), results
visible (`revealed`), or the round was skipped/superseded (`skipped`)."""

AdventureState = Literal[
    "spin_lng",
    "spin_lat",
    "country",
    "destination",
    "chosen",
    "banked",
    "rejected",
    "abandoned",
]
"""The Adventure Time round's states (spec/server-chat/08-adventure-time.md §1): the sideways spin,
the up/down spin, the country roulette, the destination roulette, a destination waiting for the
couple's decision (`chosen`), then `banked` / `rejected`; or `abandoned` when a newer adventure
started before this one reached `chosen`."""

AdventurePackState = Literal["none", "pending", "ready", "failed", "unavailable"]
"""The holiday pack's state: `none` until a destination is chosen, `pending` while the research
runs, then `ready` / `failed`; `unavailable` when no researcher is configured (or cmd could not be
reached to start one)."""

AdventureImagesState = Literal["none", "pending", "done", "failed"]
"""The holiday pack's PICTURE job (spec §4.3a): `none` until the text pack is in (or when pictures
are not available), `pending` while the server finds and fetches them, then `done` / `failed`."""

CookoutState = Literal["picking", "finished", "abandoned"]
"""The Cookout round's states (spec/server-chat/09-cookout.md §1): ten alternating picks
(`picking`), all ten made (`finished`, the chef stage), or `abandoned` (a newer Cookout started or
End game was pressed before turn 10)."""

CookoutConceptsState = Literal["none", "pending", "ready", "failed", "unavailable"]
"""Stage 1 (the three recipe concepts): `none` until the round finishes, `pending` while the cmd run
works, then `ready` / `failed`; `unavailable` when no AI runner is configured."""

CookoutImagesState = Literal["none", "pending", "done", "failed"]
"""The concept pictures' ComfyUI job: `none` until concepts are ready (or when pictures are not
available), `pending` while generating, then `done` / `failed` (partial success is kept)."""

CookoutRecipeState = Literal["pending", "banked", "failed", "unavailable"]
"""Stage 2 (one concept's full recipe, after "Bank this"): row absent = not requested."""


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
class WyrSummary:
    """What a `Message` carries about its would-you-rather round — the `DrawingSummary`
    precedent: enough for a client to notice the round exists or moved state/rev and
    fetch the (viewer-filtered) body with `GET /wyr/{seq}`. Never the answers."""

    state: WyrState
    rev: int


@dataclass(frozen=True, slots=True)
class AdventureSummary:
    """What a `Message` carries about its Adventure Time round — the `WyrSummary` precedent: enough
    for a client to notice the round exists or moved and fetch the body with
    `GET /adventure/{seq}`."""

    state: AdventureState
    pack: AdventurePackState
    rev: int


@dataclass(frozen=True, slots=True)
class CookoutSummary:
    """What a `Message` carries about its Cookout round — enough for a client to notice the round
    exists or moved and fetch the (personalised) body with `GET /cookout/{seq}`. Deliberately
    carries NO ingredient, option or recipe text (spec §1.3, §4.2): it is broadcast to everybody."""

    state: CookoutState
    blind: bool
    picked_count: int
    concepts: CookoutConceptsState
    banked_count: int
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
class WyrRoundRow:
    """One would-you-rather round, anchored to its message (`anchor_message_seq`).
    Player slots fill as votes arrive: the round's creator votes by sending the round
    (slot 1), the first OTHER voter takes slot 2. `choice`/`guess` are the game's
    private answers — served per-viewer by `wyr_view_json`, never via `message_json`,
    and never the other player's until the round is `revealed`."""

    anchor_message_seq: int
    question_id: str
    state: WyrState
    images: Literal["none", "pending", "done", "failed"]
    player1_key: str | None
    player1_name: str | None
    player1_email: str | None
    vote1: Literal["play", "skip"] | None
    choice1: Literal["a", "b"] | None
    guess1: Literal["a", "b"] | None
    reveal1: bool
    reveal_deadline: float | None
    player2_key: str | None
    player2_name: str | None
    player2_email: str | None
    vote2: Literal["play", "skip"] | None
    choice2: Literal["a", "b"] | None
    guess2: Literal["a", "b"] | None
    reveal2: bool
    rev: int
    created_at: float
    updated_at: float

    def summary(self) -> WyrSummary:
        return WyrSummary(state=self.state, rev=self.rev)


@dataclass(frozen=True, slots=True)
class AdventureSpin:
    """One committed spin (`{by, from, delta, durationMs, at}`): the dragger's consequence, stored
    once so every screen replays the same motion. `from_deg`/`delta_deg` are degrees of rotation
    about the spin's own axis; `at` is the server's clock when it was accepted."""

    by: str
    from_deg: float
    delta_deg: float
    duration_ms: float
    at: float

    def to_json(self) -> JsonObject:
        return {
            "by": self.by,
            "from": self.from_deg,
            "delta": self.delta_deg,
            "durationMs": self.duration_ms,
            "at": self.at,
        }


@dataclass(frozen=True, slots=True)
class AdventureLanding:
    """Where the second spin landed (spec §3.2). Every point is `[lng, lat]` in degrees (the d3-geo
    convention); `sea` is true when `point` was open water and `land` is the nearest land, and
    `centre` is the point the roulette camera zooms to."""

    point: tuple[float, float]
    sea: bool
    land: tuple[float, float]
    centre: tuple[float, float]
    land_unit: str

    def to_json(self) -> JsonObject:
        return {
            "point": list(self.point),
            "sea": self.sea,
            "land": list(self.land),
            "centre": list(self.centre),
            "landUnit": self.land_unit,
        }


@dataclass(frozen=True, slots=True)
class AdventureRoundRow:
    """One Adventure Time round, anchored to its message (`anchor_message_seq`, schema v20). The
    whole round is chat content (Inv 56): it is erased with its anchor message or a wipe."""

    anchor_message_seq: int
    state: AdventureState
    started_by: str
    spin_lng: AdventureSpin | None
    spin_lat: AdventureSpin | None
    landing: AdventureLanding | None
    country_candidates: tuple[str, ...] | None
    country_seed: int | None
    country_roulette_at: float | None
    country_id: str | None
    country_by: str | None
    dest_candidates: tuple[str, ...] | None
    dest_seed: int | None
    dest_roulette_at: float | None
    destination_id: str | None
    destination_by: str | None
    pack: AdventurePackState
    pack_run_id: str | None
    pack_json: str | None
    pack_error: str | None
    images: AdventureImagesState
    pictures_json: str | None
    """Which stored attachment (by ordinal on the anchor message) fills which picture slot, with its
    credit, source page and caption — JSON, written in the same transaction as the attachments."""
    images_started_at: float | None
    """When the current picture hunt began (epoch seconds, server clock); `None` before any."""
    images_tries: int
    """How many hunts have begun for this round (the first, then re-claims of a dead one)."""
    decided_by: str | None
    rev: int
    created_at: float
    updated_at: float

    def summary(self) -> AdventureSummary:
        return AdventureSummary(state=self.state, pack=self.pack, rev=self.rev)


@dataclass(frozen=True, slots=True)
class AdventureViewData:
    """Everything the `GET /adventure/{seq}` view reads from the store, in ONE transaction: the
    round, the ids out of play (only while it is still spinning), the shared `include_advised`
    preference and the round's picture attachments."""

    round: AdventureRoundRow
    excluded: frozenset[str]
    include_advised: bool
    attachments: tuple[AttachmentRow, ...]


@dataclass(frozen=True, slots=True)
class CookoutTurnRow:
    """One turn of a Cookout round (schema v21 `cookout_turns`): `offers` is every pair the turn
    showed, as immutable ingredient snapshots (`{id, name, category, emoji, blurb, family}`), the
    first dealt and one more per skip; `choice_id` is the picked ingredient once it is done."""

    turn: int
    player: int
    offers: tuple[tuple[dict[str, str], dict[str, str]], ...]
    choice_id: str | None
    skip_move_ids: tuple[str, ...]
    pick_move_id: str | None


@dataclass(frozen=True, slots=True)
class CookoutRecipeRow:
    """One concept's "Bank this" row (`cookout_recipes`); absent until requested."""

    concept_id: str
    state: CookoutRecipeState
    run_id: str | None
    recipe_json: str | None
    error: str | None
    requested_by: str
    bank_move_id: str | None
    started_at: float | None
    tries: int
    deadline_at: float | None
    banked_at: float | None


@dataclass(frozen=True, slots=True)
class CookoutRoundRow:
    """One Cookout round, anchored to its message (`anchor_message_seq`, schema v21). The whole
    round — turns, picks, concepts, recipes, pictures — is chat content (Inv 57): erased with its
    anchor message or a wipe."""

    anchor_message_seq: int
    state: CookoutState
    blind: bool
    started_by: str
    player1_key: str
    player1_name: str
    player1_email: str | None
    player2_key: str | None
    player2_name: str | None
    player2_email: str | None
    role_schedule: tuple[str, ...]
    concepts: CookoutConceptsState
    concepts_run_id: str | None
    concepts_json: str | None
    concepts_error: str | None
    concepts_started_at: float | None
    concepts_tries: int
    concepts_deadline_at: float | None
    images: CookoutImagesState
    pictures: dict[str, str]
    """Slot (`a`/`b`/`c`) -> the ordinary photo attachment id on the anchor message."""
    images_started_at: float | None
    images_tries: int
    images_deadline_at: float | None
    images_generation: int
    rev: int
    created_at: float
    updated_at: float


@dataclass(frozen=True, slots=True)
class CookoutViewData:
    """Everything `GET /cookout/{seq}` reads, in ONE transaction: the round, its turns in order,
    its recipe rows and the anchor's picture attachments."""

    round: CookoutRoundRow
    turns: tuple[CookoutTurnRow, ...]
    recipes: tuple[CookoutRecipeRow, ...]
    attachments: tuple[AttachmentRow, ...]


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
    view_tease: int = 0
    view_claim_id: str | None = None
    view_claimed_at: float | None = None
    view_claim_email: str | None = None
    canvas: int = 0
    """1 for a canvas message (a blank drawing surface, no text/attachments), else 0."""
    wyr: WyrSummary | None = None
    wyr_ref: int | None = None
    """The anchor seq of the game round (would-you-rather OR Adventure Time) this message was sent
    in the game chat of, else None — joined from `wyr_chat` at read time. The message itself stays
    in the main chat."""
    wyr_ref_kind: Literal["wyr", "adventure", "cookout"] | None = None
    """Which game `wyr_ref` points at, resolved at read time beside it (the anchor is present in
    `adv_rounds` -> "adventure", else "wyr"); None exactly when `wyr_ref` is None. A client paging
    history may not have the anchor message loaded, so it cannot tell by itself."""
    """The round summary when this message anchors a would-you-rather round, else
    None — joined from `wyr_rounds` at read time, exactly like `drawings`."""
    adventure: AdventureSummary | None = None
    """The round summary when this message anchors an Adventure Time round, else None — joined from
    `adv_rounds` at read time, exactly like `wyr`."""
    cookout: CookoutSummary | None = None
    """The round summary when this message anchors a Cookout round, else None — joined from
    `cookout_rounds` at read time, exactly like `adventure`. Carries no ingredient data."""


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
    `text` when `done` or when a previous transcript is preserved across a failed
    re-transcribe. A failed row carries no reason on the wire — the machine-readable
    `failure` code stays server-side."""
    if row is None:
        return None
    data: JsonObject = {"status": row.status}
    if row.text is not None:
        data["text"] = row.text
    elif row.status == "done":
        data["text"] = ""
    return data


def attachment_json(row: AttachmentRow, signer: MediaUrlSigner) -> JsonObject:
    """§5.9's `Attachment` wire shape. `urls` carries only READY renditions — a
    processing/failed attachment has nothing safe to link to yet (Inv 41: a token in
    a query string is the only auth a `<img>`/`<video>`/`<audio>` tag can carry, so
    it's minted here, per-response, never precomputed and stored)."""
    urls: JsonObject = {}
    if row.status == "ready":
        for rendition in row.renditions:
            urls[rendition] = signer.url_for(row.id, rendition)
    # Only an animated GIF keeps `image/gif` as its stored mime (processing turns a still
    # GIF into PNG), so this marks a photo whose `full` rendition moves — the bubble shows
    # `full` instead of the still `thumb` (decisions/00180).
    animated = row.status == "ready" and row.mime == "image/gif" and "full" in row.renditions
    return {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "width": row.width,
        "height": row.height,
        "durationS": row.duration_s,
        "peaks": list(row.peaks) if row.peaks is not None else None,
        "urls": urls,
        "animated": animated,
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


# TRANSITIONAL WIRE ALIAS — REMOVE after 2026-10-27 (decisions/00172). The feature's wire
# key was renamed spotlight -> tease, but a browser tab loaded BEFORE that deploy keeps
# running the old bundle (stale bundles survive deploys for days — decisions/00069), and an
# old bundle that finds no `spotlight` key silently shows the recipient the FULL photo the
# sender meant as a Tease. Emitting the old key beside the new one keeps stale tabs honouring
# the sender's intent until they reload. Never read this key in current code.
LEGACY_TEASE_WIRE_KEY = "spotlight"


def message_json(row: MessageRow, signer: MediaUrlSigner) -> JsonObject:
    """§5.9's `Message` wire shape."""
    view_once: dict[str, JsonValue] | None = (
        None
        if row.view_once_s is None
        else {
            "durationS": None if row.view_once_s == 0 else row.view_once_s,
            "tease": bool(row.view_tease),
            LEGACY_TEASE_WIRE_KEY: bool(row.view_tease),
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
        "canvas": bool(row.canvas),
        "drawings": [{"id": d.id, "rev": d.rev} for d in row.drawings],
        "wyr": ({"state": row.wyr.state, "rev": row.wyr.rev} if row.wyr is not None else None),
        "wyrRef": row.wyr_ref,
        "wyrRefKind": (row.wyr_ref_kind or "wyr") if row.wyr_ref is not None else None,
        "adventure": (
            {"state": row.adventure.state, "pack": row.adventure.pack, "rev": row.adventure.rev}
            if row.adventure is not None
            else None
        ),
        "cookout": (
            {
                "state": row.cookout.state,
                "blind": row.cookout.blind,
                "pickedCount": row.cookout.picked_count,
                "concepts": row.cookout.concepts,
                "bankedCount": row.cookout.banked_count,
                "rev": row.cookout.rev,
            }
            if row.cookout is not None
            else None
        ),
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
