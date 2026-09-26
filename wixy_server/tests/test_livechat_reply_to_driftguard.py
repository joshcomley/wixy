"""Round 2 ruling item 10 (spec/server-chat/04-round2-rulings.md) §(3)'s
REQUIRED drift guard: `reply_to_json` (this file, Python) and
`replyToFromMessage` (`admin-ui/tests/server/replyTo.test.ts`, TypeScript) are
asserted against the SAME shared JSON fixture
(`spec/server-chat/fixtures/reply-to-cases.json`), so the server's read-time
quote builder and the client's optimistic-preview builder can never silently
drift apart."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wixy_server.livechat.models import AttachmentRow, MessageRow, reply_to_json

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "spec"
    / "server-chat"
    / "fixtures"
    / "reply-to-cases.json"
)


def _load_cases() -> list[dict[str, Any]]:
    data = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
    cases = data["cases"]
    assert isinstance(cases, list)
    return list(cases)


class _FakeSigner:
    def url_for(self, attachment_id: str, rendition: str) -> str:
        return f"https://example.invalid/media/{attachment_id}/{rendition}"


def _attachment_row_from_case(index: int, case_attachment: dict[str, Any]) -> AttachmentRow:
    kind = case_attachment["kind"]
    status = case_attachment["status"]
    renditions: tuple[str, ...] = ()
    # Mirrors the real processing pipeline's guarantee (docs/ai/livechat.md §8):
    # a `ready` photo always has `thumb`, a `ready` video always has `poster`;
    # voice never carries either.
    if status == "ready":
        if kind == "photo":
            renditions = ("full", "thumb")
        elif kind == "video":
            renditions = ("play", "poster")
    return AttachmentRow(
        id=f"attachment-{index}",
        kind=kind,
        status=status,
        message_seq=1,
        ordinal=index,
        mime=None,
        width=None,
        height=None,
        duration_s=case_attachment["durationS"],
        peaks=None,
        renditions=renditions,
        bytes_on_disk=0,
        failure=None,
        lease_owner=None,
        lease_expires_at=None,
        created_at=0.0,
        updated_at=0.0,
    )


def _target_row_from_case(case_target: dict[str, Any]) -> MessageRow:
    attachments = tuple(
        _attachment_row_from_case(i, a) for i, a in enumerate(case_target["attachments"])
    )
    view_once_s = 5 if case_target.get("viewOnce") else None
    return MessageRow(
        seq=1,
        client_id="fixture-client-id",
        sender=case_target["sender"],
        device_id="fixture-device-id",
        by_email=None,
        text=case_target["text"],
        created_at=0.0,
        attachments=attachments,
        view_once_s=view_once_s,
    )


_CASES = _load_cases()


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_reply_to_json_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    target_row = _target_row_from_case(case["target"])
    wire = reply_to_json(target_row, _FakeSigner())
    assert wire is not None
    expected = case["expected"]

    assert wire["sender"] == expected["sender"]
    assert wire["text"] == expected["text"]
    assert wire["truncated"] == expected["truncated"]

    expected_media = expected["media"]
    if expected_media is None:
        assert wire["media"] is None
        return
    media = wire["media"]
    assert media is not None
    assert isinstance(media, dict)
    assert media["kind"] == expected_media["kind"]
    assert media["count"] == expected_media["count"]
    assert media["durationS"] == expected_media["durationS"]
    # The fixture describes PRESENCE, never a literal URL — the server mints a
    # fresh HMAC-signed one per response (§(3)); only the client's stand-in for
    # "the server already signed this" is comparable across languages.
    assert (media["thumbUrl"] is not None) == expected_media["thumbUrlPresent"]
    if "viewOnce" in expected_media:
        assert media.get("viewOnce") == expected_media["viewOnce"]


def test_fixture_has_at_least_the_required_case_shapes() -> None:
    """A guard against the fixture itself losing coverage over time — §(3)
    requires: text under/at/over 300 code points (incl. an emoji astride the
    boundary), attachment-only messages (single/multiple-same-kind/mixed),
    an attachment that is processing vs ready, and a voice note's duration."""
    names = {case["name"] for case in _CASES}
    required_substrings = [
        "text-under-300",
        "text-exactly-300",
        "emoji-astride-boundary",
        "single",
        "multiple",
        "mixed",
        "processing",
        "voice-note-duration",
        "view-once",
    ]
    for substring in required_substrings:
        assert any(substring in name for name in names), f"fixture is missing a {substring!r} case"

    boundary_case = next(c for c in _CASES if "emoji-astride-boundary" in c["name"])
    source_text = boundary_case["target"]["text"]
    expected_text = boundary_case["expected"]["text"]
    assert len(source_text) > 300
    assert len(expected_text) == 300
    assert boundary_case["expected"]["truncated"] is True
