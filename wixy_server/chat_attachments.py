"""Chat image attachments (spec/06-ai-chat.md, decisions/00103) — a thin validation
guard in front of `cmdchat.CmdChatClient.upload_attachment`, deliberately NOT a
compression pipeline of its own. cmd's own `POST /api/uploads` already does the real
work server-side (resize to a 1568px longest edge, re-encode as WEBP q85) — the exact
"auto-compress like cmd" behavior this feature asks for comes from cmd itself, not a
second copy of `wixy_server/media.py`'s Pillow logic re-implemented here for a
completely different consumer (a chat vision turn, not a published web page).

This module only checks what must be true BEFORE bytes are worth sending to cmd at
all: a real, readable image, an accepted MIME type, under cmd's own per-attachment
cap — so a bad upload gets a clear, fast 422 from wixy itself rather than a slower
round-trip 413/400 from cmd.
"""

from __future__ import annotations

import io

from PIL import Image

_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
"""Matches cmd's own `POST /api/uploads` per-attachment cap exactly (cmd
`engine/cmd_uploads.py`) — validating against the SAME number here means a rejection
is immediate and wixy's own 422, not a round-trip to cmd for its 413 instead."""

_ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
"""cmd's own accepted `kind="image"` MIME set (`POST /api/uploads`'s contract) — a
type outside this set would be accepted by wixy but rejected by cmd, so validating
against the identical set here surfaces the error at the point of upload, not send."""


class AttachmentError(Exception):
    """A rejected chat-image attachment (oversized, wrong type, unreadable)."""


def validate_attachment(data: bytes, content_type: str) -> None:
    if len(data) > _MAX_UPLOAD_BYTES:
        raise AttachmentError(f"image exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit")
    if content_type not in _ALLOWED_CONTENT_TYPES:
        raise AttachmentError(f"unsupported content type '{content_type}'")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise AttachmentError(f"not a readable image: {exc}") from None
