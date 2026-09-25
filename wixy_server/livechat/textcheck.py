"""Text checks shared by every place a request body's text reaches the store."""

from __future__ import annotations


def has_unpaired_surrogate(text: str) -> bool:
    """A lone UTF-16 surrogate (U+D800-U+DFFF) is a valid Python `str` code point but has no
    UTF-8 encoding, so it crashes a SQLite bind (or `json.dumps`) with an uncaught
    `UnicodeEncodeError` — a bare 500 — the instant it reaches one. A normal client can never
    type one, but `json.loads` happily decodes a `\\uXXXX` escape for one out of any request
    body, so the check has to run before the value goes anywhere near the store (reviewer
    H1: reproduced live against both `POST /messages` and `PUT .../reactions`; audit F5: the
    same gap in a device-grant label, found only after cmd had already verified the PIN)."""
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in text)
