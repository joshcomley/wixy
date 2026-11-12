"""The live-voice listener socket's wire contract (spec/server-chat/07-live-voice-notes.md §6.2).

Audio is the call's own 24 kHz mono s16le, 480 samples (20 ms) to a frame, in the call's 1008-byte
binary frame (`call_protocol.HEADER`) with `byte 1 = 2` (live voice). Control messages are strict
JSON: unknown fields are rejected. Nothing here touches the database or a socket.
"""

from __future__ import annotations

from typing import Annotated, Final, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, TypeAdapter

from wixy_server.livechat.call_protocol import HEADER, RATE, SAMPLES

PROTOCOL: Final = "wixy-live-voice-v1"
KIND_LIVE_VOICE: Final = 2
"""Byte 1 of a frame: 1 is a call frame, 2 a live-voice frame."""
FRAME_PCM_BYTES: Final = SAMPLES * 2
MAX_CREDIT_FRAMES: Final = 500
"""One `credit` message grants 1..500 frames (spec §6.2)."""
MAX_OUTSTANDING_CREDIT: Final = 1000
"""A cap on the credit a stream may hold at once, however many `credit` messages arrive."""

_ATTACHMENT_ID = Field(pattern=r"^[0-9a-f]{32}$")


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Watch(Command):
    type: Literal["watch"]
    attachmentId: str = _ATTACHMENT_ID


class Unwatch(Command):
    type: Literal["unwatch"]
    attachmentId: str = _ATTACHMENT_ID


class Play(Command):
    type: Literal["play"]
    attachmentId: str = _ATTACHMENT_ID
    start: Literal["start", "live"] | Annotated[StrictInt, Field(ge=0, le=2**53)] = Field(
        alias="from"
    )


class Stop(Command):
    type: Literal["stop"]
    attachmentId: str = _ATTACHMENT_ID


class Credit(Command):
    type: Literal["credit"]
    attachmentId: str = _ATTACHMENT_ID
    frames: StrictInt = Field(ge=1, le=MAX_CREDIT_FRAMES)


class Pong(Command):
    type: Literal["pong"]


ClientCommand = Watch | Unwatch | Play | Stop | Credit | Pong
COMMAND: TypeAdapter[ClientCommand] = TypeAdapter(
    Annotated[ClientCommand, Field(discriminator="type")]
)

ErrorCode = Literal["not_found", "forbidden", "not_live", "too_many_listeners", "bad_request"]


def pack_frame(att_id: str, *, seq: int, sample: int, pcm: bytes) -> bytes:
    """One 1008-byte live-voice frame: the call header (version 1, kind 2, reserved 0, the
    attachment id's 16 bytes, the per-`play` sequence, the absolute sample index, zero lease and
    playout, zero padding) then the 480 s16le samples."""
    return (
        HEADER.pack(1, KIND_LIVE_VOICE, 0, UUID(hex=att_id).bytes, seq, sample, 0, 0, bytes(8))
        + pcm
    )


__all__ = [
    "COMMAND",
    "FRAME_PCM_BYTES",
    "KIND_LIVE_VOICE",
    "MAX_CREDIT_FRAMES",
    "MAX_OUTSTANDING_CREDIT",
    "PROTOCOL",
    "RATE",
    "SAMPLES",
    "ClientCommand",
    "Credit",
    "ErrorCode",
    "Play",
    "Pong",
    "Stop",
    "Unwatch",
    "Watch",
    "pack_frame",
]
