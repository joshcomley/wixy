"""Reaction emojis on Server chat messages (spec/server-chat/04-reactions.md).

The allowlist is the one place the accepted emoji are spelled out. Each entry is an EXACT
code-point sequence, compared as a plain string with no normalisation: the heart carries
its variation selector (U+2764 U+FE0F), so a bare U+2764 is rejected. The browser keeps
the same list in `admin-ui/src/server/reactions.ts`; `test_livechat_reactions.py` parses
that file and fails if the two drift.
"""

from __future__ import annotations

REACTION_EMOJIS: tuple[str, ...] = (
    "\U0001f44d",  # thumbs up
    "❤️",  # red heart, with the variation selector
    "\U0001f602",  # face with tears of joy
    "\U0001f62e",  # face with open mouth
    "\U0001f622",  # crying face
    "\U0001f64f",  # folded hands
)

_EMOJI_ORDER = {emoji: index for index, emoji in enumerate(REACTION_EMOJIS)}


def is_allowed_reaction(emoji: str) -> bool:
    return emoji in _EMOJI_ORDER


def reaction_order(emoji: str) -> int:
    """Position in the allowlist; anything unknown sorts after every known emoji."""
    return _EMOJI_ORDER.get(emoji, len(REACTION_EMOJIS))


def reactor_key(sender: str) -> str:
    """The identity a reaction is keyed on: the trimmed sender name, case-folded.

    Same folding as push self-exclusion (`push.py`), so "mine" means the same thing for a
    message, a push and a reaction. `casefold()` rather than SQLite's `NOCASE`, which only
    folds ASCII letters.
    """
    return sender.strip().casefold()
