"""decisions/00103: `wixy_server.chat_attachments.validate_attachment` — the
guard in front of forwarding raw bytes to cmd's own `POST /api/uploads`, NOT a
re-implementation of `media.py`'s compression pipeline (cmd does that server-
side; see the module's own docstring)."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from wixy_server.chat_attachments import (
    AttachmentError,
    ChatAttachmentRef,
    extract_attachment_footer,
    validate_attachment,
)


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


class TestExtractAttachmentFooter:
    """decisions/00108: `extract_attachment_footer` — the exact mirror of cmd's
    own `src/ts/render/attachment-mentions.ts` (the parser cmd's own chat UI
    uses to turn the driver-send `Attachments:` footer back into previews).
    The cases below are cmd's own documented contract: the footer shape, the
    `(WxH)` dims suffix, the cmd-uploads path sentinel's strictness, and the
    whole-footer strip."""

    def test_no_footer_returns_the_input_unchanged(self) -> None:
        text = "just a normal message\nwith two lines"
        assert extract_attachment_footer(text) == (text, [])

    def test_a_footer_mentioning_an_unrelated_path_is_not_an_attachment(self) -> None:
        # Strict on the cmd-uploads sentinel, exactly like cmd: an owner who
        # literally ends a message this way must not have their own path
        # treated as an attachment. The footer region is still stripped
        # (cmd's own behavior — parity, not a bug).
        text = "look at this\n\nAttachments:\n@C:\\some\\other\\path.png"
        stripped, refs = extract_attachment_footer(text)
        assert stripped == "look at this"
        assert refs == []

    def test_single_image_with_dims(self) -> None:
        text = (
            "what do you see?\n\nAttachments:\n"
            "@C:\\Users\\josh\\.claude\\cmd-uploads\\abc123\\converted.webp (800x600)"
        )
        stripped, refs = extract_attachment_footer(text)
        assert stripped == "what do you see?"
        assert refs == [
            ChatAttachmentRef(upload_id="abc123", name="converted.webp", width=800, height=600)
        ]

    def test_posix_separators_parse_the_same(self) -> None:
        text = (
            "describe it\n\nAttachments:\n"
            "@/home/josh/.claude/cmd-uploads/def456/converted.webp (1024x768)"
        )
        stripped, refs = extract_attachment_footer(text)
        assert stripped == "describe it"
        assert refs == [
            ChatAttachmentRef(upload_id="def456", name="converted.webp", width=1024, height=768)
        ]

    def test_an_entry_without_dims_gets_none_dims(self) -> None:
        text = "see this\n\nAttachments:\n@C:\\u\\cmd-uploads\\aaa\\original__note.png"
        stripped, refs = extract_attachment_footer(text)
        assert stripped == "see this"
        assert refs == [ChatAttachmentRef(upload_id="aaa", name="original__note.png")]

    def test_multiple_entries_parse_in_source_order(self) -> None:
        text = (
            "two photos\n\nAttachments:\n"
            "@C:\\u\\cmd-uploads\\one\\converted.webp (100x200)\n"
            "@C:\\u\\cmd-uploads\\two\\converted.webp (300x400)"
        )
        stripped, refs = extract_attachment_footer(text)
        assert stripped == "two photos"
        assert [r.upload_id for r in refs] == ["one", "two"]
        assert refs[1].width == 300

    def test_the_dims_suffix_is_not_gathered_into_the_filename(self) -> None:
        # cmd's own regression note: without the whitespace exclusion the
        # filename becomes `converted.webp (1920x1080)` and downstream
        # equality checks silently fail — pinned here too.
        text = "x\n\nAttachments:\n@C:\\u\\cmd-uploads\\abc\\converted.webp (1920x1080)"
        _, refs = extract_attachment_footer(text)
        assert refs[0].name == "converted.webp"

    def test_an_image_only_message_strips_to_empty_prose(self) -> None:
        text = "\n\nAttachments:\n@C:\\u\\cmd-uploads\\abc\\converted.webp (10x10)"
        stripped, refs = extract_attachment_footer(text)
        assert stripped == ""
        assert len(refs) == 1

    def test_a_footer_not_at_the_end_is_left_alone(self) -> None:
        # Only a TRAILING footer is an attachment block (cmd's `$`-anchored
        # regex) — an "Attachments:" section mid-message is prose.
        text = "a\n\nAttachments:\n@C:\\u\\cmd-uploads\\abc\\converted.webp (1x1)\n\nthen more text"
        assert extract_attachment_footer(text) == (text, [])
