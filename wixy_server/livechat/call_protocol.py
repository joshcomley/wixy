"""Ephemeral live-call wire contract. No media enters the persistent chat store."""

from __future__ import annotations

import struct
from typing import Annotated, Literal, TypedDict
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, TypeAdapter

RATE = 24_000
SAMPLES = 480
HEADER = struct.Struct("!BBH16sIQII8s")
FRAME_BYTES = HEADER.size + SAMPLES * 2
LEASE_S = 0.3
PROTOCOL = "wixy-call-v1"


class WebSocketOptions(TypedDict):
    ws: Literal["websockets"]
    ws_max_size: int
    ws_max_queue: int
    ws_per_message_deflate: bool
    timeout_graceful_shutdown: int


SERVER_OPTIONS: WebSocketOptions = {
    "ws": "websockets",
    "ws_max_size": 4096,
    "ws_max_queue": 4,
    "ws_per_message_deflate": False,
    "timeout_graceful_shutdown": 2,
}


class Control(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Authenticate(Control):
    type: Literal["auth"]
    v: Literal[1]
    token: str = Field(max_length=2048)
    label: str = Field(min_length=1, max_length=32)


class Invite(Control):
    type: Literal["invite"]
    requestId: str = Field(min_length=1, max_length=64)
    targetConnectionId: str = Field(min_length=32, max_length=32)


class CallAction(Control):
    type: Literal["accept", "decline", "ready", "failed", "end"]
    callId: str = Field(min_length=32, max_length=32)


class Mute(Control):
    type: Literal["mute"]
    callId: str = Field(min_length=32, max_length=32)
    muted: StrictBool


class Lease(Control):
    type: Literal["lease"]
    callId: str = Field(min_length=32, max_length=32)
    lease: StrictInt = Field(ge=1, le=0xFFFFFFFF)


class Ack(Control):
    type: Literal["ack"]
    callId: str = Field(min_length=32, max_length=32)
    sequence: StrictInt = Field(ge=0, le=0xFFFFFFFF)


class Pong(Control):
    type: Literal["pong"]


Command = Invite | CallAction | Mute | Lease | Ack | Pong
COMMAND: TypeAdapter[Command] = TypeAdapter(Annotated[Command, Field(discriminator="type")])


def unpack_frame(data: bytes) -> tuple[str, int, int, int]:
    if len(data) != FRAME_BYTES:
        raise ValueError("frame size")
    version, kind, reserved, epoch, seq, sample, capture, playout, padding = HEADER.unpack_from(
        data
    )
    if (version, kind, reserved, playout, padding) != (1, 1, 0, 0, bytes(8)):
        raise ValueError("frame header")
    return UUID(bytes=epoch).hex, seq, sample, capture


def forward_frame(data: bytes, lease: int) -> bytes:
    frame = bytearray(data)
    struct.pack_into("!I", frame, 36, lease)
    return bytes(frame)
