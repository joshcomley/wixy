"""Grid thumbnails for media sent before every picture and video had one (workspace 00046).

Photos have always been given a `thumb` rendition; videos only a 960px `poster`. The Server
chat gallery shows a screenful of thumbnails at once, so every ready photo and video must have
a small one. New media gets it from the media queue (`processing.process_photo` /
`process_video`); this module catches up the media already in the store, once at start-up and
again on every restart (idempotent — when nothing is missing it costs one indexed query).

Pure Pillow, no ffmpeg: the thumbnail is made from a rendition `processing.py` already wrote
(a video's `poster.jpg`, a photo's `full.*`), through the same `processing.make_thumbnail` the
queue uses, so a backfilled thumbnail is byte-for-byte what a fresh upload would have got.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from wixy_server.livechat import processing
from wixy_server.livechat.models import AttachmentRow
from wixy_server.livechat.store import LiveChatStore
from wixy_server.storage import ProjectPaths

logger = logging.getLogger(__name__)

# What each kind's thumbnail is cut from, best source first.
_SOURCES: dict[str, tuple[str, ...]] = {
    "video": ("poster.jpg",),
    "photo": ("full.png", "full.jpg", "full.gif"),
}


def _source_for(att: AttachmentRow, media_dir: Path) -> Path | None:
    for name in _SOURCES.get(att.kind, ()):
        candidate = media_dir / name
        if candidate.is_file():
            return candidate
    return None


def backfill_thumbnails(*, store: LiveChatStore, paths: ProjectPaths) -> int:
    """Give every kept, ready photo/video without a `thumb` one. Returns how many were made.
    A single unreadable file is logged and skipped — it must never stop the rest — and is
    simply tried again on the next start."""
    made = 0
    for att in store.thumbless_attachments():
        media_dir = paths.server_attachment_media_dir(att.id)
        source = _source_for(att, media_dir)
        if source is None:
            logger.warning("server-chat thumbnails: no source file for %s (%s)", att.id, att.kind)
            continue
        try:
            thumb_path = processing.make_thumbnail(source, output_dir=media_dir)
            thumb_bytes = thumb_path.stat().st_size
        except processing.MediaProcessingError, OSError:
            logger.warning("server-chat thumbnails: could not thumbnail %s", att.id, exc_info=True)
            continue
        if store.add_thumb_rendition(att=att, thumb_bytes=thumb_bytes, now=time.time()):
            made += 1
        else:
            # The row changed or vanished while the file was being written (went view-once,
            # deleted): the thumbnail has no home, so it must not linger on disk.
            thumb_path.unlink(missing_ok=True)
    if made:
        logger.info("server-chat thumbnails: backfilled %d grid thumbnail(s)", made)
    return made
