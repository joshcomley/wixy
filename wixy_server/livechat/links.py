"""Web-link detection for the chat's "Links" view.

The rule is the one the thread already uses to turn text into clickable links
(`admin-ui/src/server/linkify.ts`): an `http://` or `https://` run. A message "has a link" exactly
when the thread would draw a link in it, so the filtered view never disagrees with the bubbles.
"""

from __future__ import annotations

import re

_URL_RE = re.compile(r"\bhttps?://[^\s<>\"']+", re.IGNORECASE)


def text_has_link(text: str | None) -> bool:
    """True when `text` contains at least one `http(s)://` link."""
    return bool(text) and _URL_RE.search(text or "") is not None
