"""decisions/00103: `wixy_server.chat_attachments.validate_attachment` — the
guard in front of forwarding raw bytes to cmd's own `POST /api/uploads`, NOT a
re-implementation of `media.py`'s compression pipeline (cmd does that server-
side; see the module's own docstring)."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from wixy_server.chat_attachments import AttachmentError, validate_attachment


def _make_png_bytes(size: tuple[int, int] = (10, 10)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "red").save(buf, format="PNG")
    return buf.getvalue()


class TestValidateAttachment:
    def test_accepts_a_real_png(self) -> None:
        validate_attachment(_make_png_bytes(), "image/png")  # does not raise

    def test_accepts_every_type_cmd_itself_accepts(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (10, 10), "blue").save(buf, format="JPEG")
        validate_attachment(buf.getvalue(), "image/jpeg")

        buf = io.BytesIO()
        Image.new("RGB", (10, 10), "green").save(buf, format="GIF")
        validate_attachment(buf.getvalue(), "image/gif")

        buf = io.BytesIO()
        Image.new("RGB", (10, 10), "yellow").save(buf, format="WEBP")
        validate_attachment(buf.getvalue(), "image/webp")

    def test_rejects_a_file_over_cmd_own_5mb_cap(self) -> None:
        oversized = b"x" * (5 * 1024 * 1024 + 1)
        with pytest.raises(AttachmentError, match="5MB limit"):
            validate_attachment(oversized, "image/png")

    def test_rejects_an_unsupported_content_type(self) -> None:
        with pytest.raises(AttachmentError, match="unsupported content type"):
            validate_attachment(_make_png_bytes(), "application/pdf")

    def test_rejects_svg_even_though_the_bytes_might_be_readable_as_text(self) -> None:
        # SVG is deliberately not in cmd's own accepted kind="image" set —
        # same XSS-surface reasoning as media.py's own SVG rejection
        # (spec/02 §9), enforced here purely via the content-type allowlist.
        with pytest.raises(AttachmentError, match="unsupported content type"):
            validate_attachment(b"<svg></svg>", "image/svg+xml")

    def test_rejects_unreadable_bytes_claiming_to_be_an_image(self) -> None:
        with pytest.raises(AttachmentError, match="not a readable image"):
            validate_attachment(b"not actually an image", "image/png")
