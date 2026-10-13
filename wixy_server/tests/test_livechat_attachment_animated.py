"""`attachment_json`'s `animated` flag (decisions/00180): true exactly for a ready photo
kept as an animated GIF (`image/gif` + a `full` rendition on the wire), so the thread
bubble can show the moving `full` instead of the still `thumb`."""

from __future__ import annotations

from wixy_server.livechat.models import (
    AttachmentKind,
    AttachmentRow,
    AttachmentStatus,
    attachment_json,
)


class _FakeSigner:
    def url_for(self, attachment_id: str, rendition: str) -> str:
        return f"https://example.invalid/media/{attachment_id}/{rendition}"


def _row(
    *,
    mime: str | None,
    renditions: tuple[str, ...],
    status: AttachmentStatus = "ready",
    kind: AttachmentKind = "photo",
) -> AttachmentRow:
    return AttachmentRow(
        id="a" * 32,
        kind=kind,
        status=status,
        message_seq=1,
        ordinal=0,
        mime=mime,
        width=640,
        height=468,
        duration_s=None,
        peaks=None,
        renditions=renditions,
        bytes_on_disk=1,
        failure=None,
        lease_owner=None,
        lease_expires_at=None,
        created_at=0.0,
        updated_at=0.0,
    )


def test_ready_animated_gif_is_animated() -> None:
    data = attachment_json(_row(mime="image/gif", renditions=("full", "thumb")), _FakeSigner())
    assert data["animated"] is True
    assert "full" in data["urls"]  # type: ignore[operator]


def test_still_photo_is_not_animated() -> None:
    for mime in ("image/jpeg", "image/png", None):
        data = attachment_json(_row(mime=mime, renditions=("full", "thumb")), _FakeSigner())
        assert data["animated"] is False


def test_processing_gif_is_not_animated() -> None:
    data = attachment_json(
        _row(mime="image/gif", renditions=(), status="processing"), _FakeSigner()
    )
    assert data["animated"] is False
    assert data["urls"] == {}


def test_view_once_gif_without_renditions_is_not_animated() -> None:
    # A view-once attachment carries no renditions on the wire (Inv 52): the flag must not
    # reveal anything about it either.
    data = attachment_json(_row(mime="image/gif", renditions=()), _FakeSigner())
    assert data["animated"] is False
    assert data["urls"] == {}
