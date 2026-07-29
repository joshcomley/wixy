"""The site-assistant preamble contract: how it's composed into a conversation's
first message, and how it's stripped back out before the owner ever sees it.

spec/06 §1 prepends a site-scoped preamble to the create call's prompt
("`<PREAMBLE>\\n\\n---\\n\\n<user's first message>`"). That makes it part of the
conversation's **first user message** as far as cmd (and the standalone worker) is
concerned — which is correct for the model, but it is plumbing, not something the
site owner wrote, so the chat panel must never render it (decisions/00093).

Compose and strip therefore have to agree exactly, and they live here **together**
for that reason: the separator used to join is the same one used to split. It was
previously an inline literal duplicated across `ai/backend.py` and
`worker/app.py`, and a third copy in the stripping code would have been one more
place to drift out of sync — the same duplicated-contract failure mode that caused
the 502 in decisions/00092.

Deliberately dependency-free (stdlib only, no `wixy_server` imports) so both the
main server and the standalone worker process can import it — the worker otherwise
avoids main-process modules (see `worker/app.py`'s own note).
"""

from __future__ import annotations

from pathlib import Path

SEPARATOR = "\n\n---\n\n"
"""Joins the preamble to the owner's own first message, and splits them apart
again. A markdown thematic break, so the model reads it as a section boundary.

Safe as a split token because `templates/chat_preamble.md` contains no `---`
line of its own — `test_preamble.py` asserts that, so adding one to the template
fails the suite rather than silently making the first message unstrippable."""

PREAMBLE_PATH = Path(__file__).parent / "templates" / "chat_preamble.md"

PREAMBLE_TEXT = PREAMBLE_PATH.read_text(encoding="utf-8").strip()
"""Read once at import (the template ships with the code and never changes at
runtime). `.strip()`ed because that is the exact form that gets composed into the
prompt — stripping here and composing the stripped form is what lets
`strip_preamble` match on it byte-for-byte."""


def compose_prompt(preamble: str, first_message: str | None) -> str:
    """The create call's prompt (spec/06 §1). With no opening message the prompt
    is the preamble alone — a conversation the owner opened without typing
    anything yet."""
    return preamble if not first_message else f"{preamble}{SEPARATOR}{first_message}"


def strip_preamble(text: str) -> str | None:
    """The owner-visible remainder of a first message, or `None` if there is
    nothing of theirs in it.

    `None` means "don't render this message at all" — the whole text was
    preamble, i.e. they opened a conversation without an opening message. The
    alternative (rendering an empty bubble) would look like they'd sent a blank
    message.

    Matched by prefix rather than by message index: index conventions belong to
    whichever backend produced the transcript, whereas the preamble is a ~1.4 KB
    exact string this server itself composed, so a prefix match identifies it
    without depending on cmd's (or the worker's) numbering. A later message that
    merely *quotes* the preamble is left alone, since it wouldn't lead with the
    whole thing.

    Also handles a backend that truncated the message mid-preamble (cmd's
    `truncated` flag): the visible text is then a *prefix of* the preamble rather
    than the reverse, and it is still entirely plumbing, so it's dropped too. The
    owner's own words aren't lost in that case — they're also the conversation
    title (`routes_chat._title_from_first_message`).
    """
    if not text.startswith(PREAMBLE_TEXT):
        # Truncated mid-preamble: everything present is preamble.
        stripped = text.rstrip().rstrip("…").rstrip()
        if stripped and PREAMBLE_TEXT.startswith(stripped):
            return None
        return text
    remainder = text[len(PREAMBLE_TEXT) :]
    if remainder.startswith(SEPARATOR):
        remainder = remainder[len(SEPARATOR) :]
    return remainder if remainder.strip() else None
