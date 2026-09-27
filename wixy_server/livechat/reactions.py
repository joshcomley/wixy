"""Reaction emojis on Server chat messages (spec/server-chat/04-reactions.md).

The allowlist defines the static reaction set. The browser keeps the same list in
`admin-ui/src/server/reactions.ts`; `test_livechat_reactions.py` parses that file and
fails if the two drift. Reactions also allow variants (e.g. skin tones, heart colors)
and emojis chosen from the full emoji selection.
"""

from __future__ import annotations

import unicodedata

REACTION_EMOJIS: tuple[str, ...] = (
    "\U0001f44d",  # thumbs up
    "❤️",  # red heart, with the variation selector
    "\U0001f602",  # face with tears of joy
    "\U0001f62e",  # face with open mouth
    "\U0001f622",  # crying face
    "\U0001f64f",  # folded hands
    "\U0001f970",  # care (smiling face with hearts)
    "\U0001f389",  # celebrate (party popper)
)

_EMOJI_ORDER = {emoji: index for index, emoji in enumerate(REACTION_EMOJIS)}


def _is_emoji_codepoint(cp: int) -> bool:
    return (
        0x1F000 <= cp <= 0x1FAFF  # Modern emojis (Emoticons, Pictographs, etc.)
        or 0x2600 <= cp <= 0x27BF  # Misc symbols, Dingbats (❤️, ⚡, ☕, etc.)
        or 0x2300 <= cp <= 0x23FF  # Misc technical (⏰, ⏳)
        or 0x2B50 <= cp <= 0x2B55  # Stars (⭐)
        or cp == 0x200D  # ZWJ
        or 0xFE0E <= cp <= 0xFE0F  # Variation selectors
        or 0x1F3FB <= cp <= 0x1F3FF  # Fitzpatrick skin tones
    )


def is_allowed_reaction(emoji: str) -> bool:
    if not emoji or len(emoji) > 32:
        return False
    if emoji in _EMOJI_ORDER:
        return True
    if any(c.isspace() for c in emoji):
        return False
    if any(c.isascii() and (c.isalnum() or c in "<>{}\"';:/\\|`~") for c in emoji):
        return False
    return all(_is_emoji_codepoint(ord(c)) for c in emoji)


def reaction_order(emoji: str) -> int:
    """Position in the allowlist; anything unknown sorts after every known emoji."""
    return _EMOJI_ORDER.get(emoji, len(REACTION_EMOJIS))


def reactor_key(sender: str) -> str:
    """The identity a reaction is keyed on: the trimmed sender name, Unicode-normalized and
    case-folded.

    Same folding as push self-exclusion (`push.py`), so "mine" means the same thing for a
    message, a push and a reaction. `casefold()` rather than SQLite's `NOCASE`, which only
    folds ASCII letters. NFC normalization first (reviewer M1) means an NFC- and an
    NFD-encoded form of the same accented name — visually and semantically identical, but
    different code-point sequences — are the same reactor; without it, a name typed on a
    platform that composes accents differently would silently split into two people.
    """
    return unicodedata.normalize("NFC", sender.strip()).casefold()
