"""The preamble compose/strip contract (`wixy_server.preamble`, decisions/00093).

These two halves MUST stay exact inverses: `compose_prompt` builds the create
call's first user message, `strip_preamble` takes it back apart so the chat panel
renders only what the site owner actually wrote. A drift between them re-leaks the
internal prompt into a non-developer's chat, which is the bug this module exists
to prevent.
"""

from __future__ import annotations

from wixy_server.preamble import (
    PREAMBLE_TEXT,
    SEPARATOR,
    compose_prompt,
    strip_preamble,
)


class TestSeparatorAssumption:
    def test_template_contains_no_thematic_break(self) -> None:
        """`SEPARATOR` is only a safe split token while the preamble template has
        no `---` line of its own. This guards the assumption its docstring makes:
        adding one to `templates/chat_preamble.md` fails here rather than silently
        making a first message unstrippable."""
        assert SEPARATOR not in PREAMBLE_TEXT
        assert not any(line.strip() == "---" for line in PREAMBLE_TEXT.splitlines())

    def test_preamble_is_stripped_of_surrounding_whitespace(self) -> None:
        # The composed form is what gets prefix-matched, so PREAMBLE_TEXT must be
        # byte-identical to what lands in the prompt.
        assert PREAMBLE_TEXT == PREAMBLE_TEXT.strip()
        assert PREAMBLE_TEXT != ""


class TestRoundTrip:
    def test_strip_recovers_exactly_the_owners_first_message(self) -> None:
        first = "Please put a link to FAQ in my menu right at the end"
        assert strip_preamble(compose_prompt(PREAMBLE_TEXT, first)) == first

    def test_multiline_first_message_survives_intact(self) -> None:
        first = "Line one\n\nLine two\n- a bullet\n"
        assert strip_preamble(compose_prompt(PREAMBLE_TEXT, first)) == first

    def test_first_message_containing_a_thematic_break_survives(self) -> None:
        """Only the FIRST separator splits, so the owner's own `---` is safe —
        a naive `split("---")` would have truncated their message here."""
        first = f"Change the header{SEPARATOR}and also the footer"
        assert strip_preamble(compose_prompt(PREAMBLE_TEXT, first)) == first


class TestNothingOwnerVisible:
    def test_preamble_alone_strips_to_none(self) -> None:
        """A conversation opened with no opening message: the whole first message
        is plumbing, so there is nothing to render (`None`), as opposed to an
        empty bubble that would look like the owner sent a blank message."""
        assert strip_preamble(compose_prompt(PREAMBLE_TEXT, None)) is None

    def test_empty_first_message_strips_to_none(self) -> None:
        assert strip_preamble(compose_prompt(PREAMBLE_TEXT, "")) is None

    def test_whitespace_only_first_message_strips_to_none(self) -> None:
        assert strip_preamble(f"{PREAMBLE_TEXT}{SEPARATOR}   \n  ") is None

    def test_truncated_mid_preamble_strips_to_none(self) -> None:
        """A backend that truncated the message mid-preamble leaves a PREFIX of
        the preamble, not the whole thing — still entirely plumbing, so it must
        not render (their own words survive as the conversation title)."""
        assert strip_preamble(PREAMBLE_TEXT[:400]) is None
        assert strip_preamble(PREAMBLE_TEXT[:400] + "…") is None


class TestOrdinaryMessagesUntouched:
    def test_a_normal_message_passes_through_unchanged(self) -> None:
        text = "Make the heading bigger please"
        assert strip_preamble(text) == text

    def test_a_message_merely_quoting_the_preamble_is_untouched(self) -> None:
        """Only a message LEADING with the whole preamble is plumbing. One that
        quotes a fragment mid-sentence is the owner talking and stays intact."""
        text = f"why does it say {PREAMBLE_TEXT[:80]} at the top?"
        assert strip_preamble(text) == text
