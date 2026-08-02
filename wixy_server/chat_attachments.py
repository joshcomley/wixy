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
import re
from dataclasses import dataclass

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


# ---------------------------------------------------------------------------
# The ``Attachments:`` footer (decisions/00110)
# ---------------------------------------------------------------------------
#
# cmd's own send route appends a trailing footer to the user's prompt text when
# a send with attachments resolves to a DRIVER/DISPATCH method (its
# `engine/chats/method_drivers.py:build_attachment_footer` — the interactive
# TUI has no per-message image content block, so the agent's Read tool ingests
# each referenced path instead)::
#
#     ...user prose...
#
#     Attachments:
#     @C:\Users\josh\.claude\cmd-uploads\<id>\converted.webp (800x600)
#
# That footer is part of the message text itself, so it comes straight back
# out of cmd's decoded-messages endpoint — and used to render in the owner's
# chat as a wall of raw machine paths (the operator's 2026-08-02 report). cmd's
# OWN web UI parses the same footer back out for inline previews (cmd
# `src/ts/render/attachment-mentions.ts`); this section mirrors that module's
# contract exactly — same footer shape, same strictness, same stripping — so
# wixy and cmd always agree on what an attachment is. The parser is
# deliberately strict on the `cmd-uploads` sentinel: an owner who literally
# types ``@C:\some\other\path`` never has their text rewritten — only paths
# cmd itself emitted are treated as attachments.


@dataclass(frozen=True, slots=True)
class ChatAttachmentRef:
    """One image attached to a chat message, referenced by cmd's upload id —
    the bytes are fetched through wixy's own proxy route
    (`GET /api/admin/chat/uploads/{upload_id}/bytes`), never by exposing cmd's
    localhost surface to the browser. `name` is the trailing filename segment
    (`converted.webp` for an image post-Pillow); `width`/`height` are the
    served image's dimensions when known (the footer's `(WxH)` suffix), else
    None — a ref from wixy's own send log carries no dims."""

    upload_id: str
    name: str | None = None
    width: int | None = None
    height: int | None = None


_FOOTER_RE = re.compile(r"\n*Attachments:\n(?:@[^\n]+\n?)+\s*$")
"""cmd's own `FOOTER_RE` verbatim — a trailing block of one or more `@...`
lines headed by `Attachments:`. Mirrors attachment-mentions.ts exactly."""

_MENTION_LINE_RE = re.compile(r"^@(.+?)$", re.MULTILINE)
"""cmd's own `MENTION_LINE_RE` verbatim."""

_UPLOAD_PATH_RE = re.compile(
    r"[\\/]cmd-uploads[\\/]([A-Za-z0-9_-]+)[\\/]([^\\/\s]+)(?:\s+\((\d+)x(\d+)\))?$"
)
"""cmd's own `CMD_UPLOADS_PATH_RE`, extended to also CAPTURE the `(WxH)` dims
it originally only excluded from the filename (group 2). The filename class
stops at whitespace exactly as cmd's does, so `converted.webp (800x600)`
parses as name `converted.webp` + dims — never as a filename containing a
space. Windows and POSIX separators both supported, as cmd's."""


def extract_attachment_footer(text: str) -> tuple[str, list[ChatAttachmentRef]]:
    """Split a user message's text into (visible prose, attachment refs).

    No recognisable footer → `(text, [])`, byte-identical input. A footer is
    stripped from the prose regardless of whether its lines parse as
    cmd-uploads paths (cmd's own behavior: the footer region is removed whole;
    only sentinel-matching lines become refs)."""
    footer_match = _FOOTER_RE.search(text)
    if footer_match is None:
        return text, []
    stripped = text[: footer_match.start()].rstrip()

    refs: list[ChatAttachmentRef] = []
    for mention in _MENTION_LINE_RE.finditer(footer_match.group(0)):
        path = mention.group(1).strip()
        path_match = _UPLOAD_PATH_RE.search(path)
        if path_match is None:
            continue
        width_raw, height_raw = path_match.group(3), path_match.group(4)
        refs.append(
            ChatAttachmentRef(
                upload_id=path_match.group(1),
                name=path_match.group(2),
                width=int(width_raw) if width_raw is not None else None,
                height=int(height_raw) if height_raw is not None else None,
            )
        )
    return stripped, refs
