"""Finding words in chat text for the chat's Search screen (decisions/00208).

Pure text work, no storage and no I/O: fold text so that a phone's typing still matches
(`Cafe` finds `Café`, `don't` finds `don’t`), test a message against the words typed, and cut the
short excerpt a result shows, with the matched words marked.

There is deliberately no search index. An index would be a second copy of every message, which
every delete and wipe path (and an older process during a blue/green overlap) would then have to
erase as well (Inv 46). The store scans the live rows instead, measured at a few tens of
milliseconds for this chat's real size.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from functools import lru_cache

MAX_QUERY_CHARS = 200
MAX_QUERY_WORDS = 12
SNIPPET_CHARS = 140
SNIPPET_LEAD_CHARS = 40
MAX_MATCH_STRINGS = 12

# Phones type these for the plain characters on a keyboard, so a typed `don't` has to find a
# stored `don’t` and the other way round.
_PUNCTUATION_FOLDS = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "ʼ": "'",
        "“": '"',
        "”": '"',
    }
)


@lru_cache(maxsize=4096)
def _fold_char(char: str) -> str:
    """One original character's folded form; empty for a character that folds to nothing (an
    accent, an emoji's colour selector)."""
    decomposed = unicodedata.normalize("NFKD", char)
    kept = "".join(c for c in decomposed if not unicodedata.combining(c) and c != "️")
    return kept.translate(_PUNCTUATION_FOLDS).casefold()


def fold(text: str) -> str:
    """The form text is compared in. Case, accents and curly punctuation never matter."""
    if text.isascii():
        return text.lower()
    return "".join(_fold_char(char) for char in text)


def query_words(query: str) -> tuple[str, ...]:
    """The distinct folded words of what was typed, longest first so an excerpt prefers the most
    telling one. Empty when nothing searchable was typed."""
    words = dict.fromkeys(fold(query).split())
    return tuple(sorted(words, key=len, reverse=True)[:MAX_QUERY_WORDS])


def matches_all(folded_text: str, words: tuple[str, ...]) -> bool:
    """Every word appears somewhere, in any order. A word matches inside a longer one: `din`
    finds `dinner`."""
    return all(word in folded_text for word in words)


@dataclass(frozen=True, slots=True)
class SnippetPart:
    text: str
    match: bool


@dataclass(frozen=True, slots=True)
class Excerpt:
    parts: tuple[SnippetPart, ...]
    # The matched words exactly as written in the message, so the screen can find them in the
    # bubble it jumps to without knowing how to fold.
    matched: tuple[str, ...]


def _fold_with_origin(text: str) -> tuple[str, list[int]]:
    """The folded text, and for each of its characters the index of the original one it came from."""
    if text.isascii():
        return text.lower(), list(range(len(text)))
    pieces: list[str] = []
    origin: list[int] = []
    for index, char in enumerate(text):
        piece = _fold_char(char)
        pieces.append(piece)
        origin.extend([index] * len(piece))
    return "".join(pieces), origin


def _match_ranges(text: str, words: tuple[str, ...]) -> list[tuple[int, int]]:
    """Every occurrence of every word as sorted, merged ranges of the ORIGINAL text. A range's end
    runs up to the next folded character, so an accent stored as its own character stays with its
    letter."""
    folded, origin = _fold_with_origin(text)
    ranges: list[tuple[int, int]] = []
    for word in words:
        start = folded.find(word)
        while start != -1:
            end = start + len(word)
            ranges.append((origin[start], origin[end] if end < len(origin) else len(text)))
            start = folded.find(word, end)
    ranges.sort()
    merged: list[tuple[int, int]] = []
    for start, end in ranges:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def excerpt(text: str, words: tuple[str, ...]) -> Excerpt:
    """A short window of `text` starting a little before its first match, split into marked and
    plain parts. An ellipsis stands for anything cut off at either end."""
    ranges = _match_ranges(text, words)
    first = ranges[0][0] if ranges else 0
    start = 0
    if first > SNIPPET_LEAD_CHARS:
        start = first - SNIPPET_LEAD_CHARS
        # Start on a word boundary when one is close, so the excerpt doesn't open mid-word.
        space = text.find(" ", start, first)
        if space != -1:
            start = space + 1
    end = min(len(text), start + SNIPPET_CHARS)

    parts: list[SnippetPart] = []
    if start > 0:
        parts.append(SnippetPart("…", False))
    cursor = start
    for range_start, range_end in ranges:
        if range_start >= end:
            break
        if range_start > cursor:
            parts.append(SnippetPart(text[cursor:range_start], False))
        cursor = min(range_end, end)
        parts.append(SnippetPart(text[range_start:cursor], True))
    if cursor < end:
        parts.append(SnippetPart(text[cursor:end], False))
    if end < len(text):
        parts.append(SnippetPart("…", False))

    matched = dict.fromkeys(text[range_start:range_end] for range_start, range_end in ranges)
    return Excerpt(tuple(parts), tuple(matched)[:MAX_MATCH_STRINGS])
