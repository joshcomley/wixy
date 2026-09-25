"""The reaction allowlist and reactor identity (spec/server-chat/04-reactions.md)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from wixy_server.livechat.reactions import (
    REACTION_EMOJIS,
    is_allowed_reaction,
    reaction_order,
    reactor_key,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_CONSTANTS = _REPO_ROOT / "admin-ui" / "src" / "server" / "reactions.ts"


class TestAllowlist:
    def test_is_exactly_the_six_quick_reactions_as_code_point_sequences(self) -> None:
        assert REACTION_EMOJIS == (
            "\U0001f44d",  # thumbs up: U+1F44D
            "❤️",  # red heart: U+2764 U+FE0F
            "\U0001f602",  # face with tears of joy: U+1F602
            "\U0001f62e",  # face with open mouth: U+1F62E
            "\U0001f622",  # crying face: U+1F622
            "\U0001f64f",  # folded hands: U+1F64F
        )

    def test_the_heart_carries_its_variation_selector(self) -> None:
        assert [hex(ord(c)) for c in REACTION_EMOJIS[1]] == ["0x2764", "0xfe0f"]

    def test_entries_are_unique(self) -> None:
        assert len(set(REACTION_EMOJIS)) == len(REACTION_EMOJIS)

    @pytest.mark.parametrize("emoji", REACTION_EMOJIS)
    def test_every_entry_is_allowed(self, emoji: str) -> None:
        assert is_allowed_reaction(emoji)

    @pytest.mark.parametrize(
        "value",
        [
            "",
            " ",
            "❤",  # the heart without its variation selector
            "❤️️",
            "\U0001f44d️",
            "\U0001f44d\U0001f3fd",  # thumbs up with a skin-tone modifier
            "\U0001f44e",
            "\U0001f44d\U0001f44d",
            "\U0001f44d ",
            "thumbs_up",
            "１",  # a full-width digit, which NFKC would fold to "1"
        ],
    )
    def test_anything_else_is_refused_with_no_normalisation(self, value: str) -> None:
        assert not is_allowed_reaction(value)

    def test_order_follows_the_list_and_unknowns_sort_last(self) -> None:
        assert [reaction_order(e) for e in REACTION_EMOJIS] == list(range(len(REACTION_EMOJIS)))
        assert reaction_order("\U0001f44e") == len(REACTION_EMOJIS)


class TestReactorKey:
    def test_trims_and_case_folds(self) -> None:
        assert reactor_key("  Purdy ") == "purdy"
        assert reactor_key("PURDY") == reactor_key("purdy")

    def test_folds_beyond_ascii_like_push_self_exclusion(self) -> None:
        assert reactor_key("Émilie") == reactor_key("éMILIE")
        assert reactor_key("Straße") == reactor_key("STRASSE")

    def test_different_names_stay_different(self) -> None:
        assert reactor_key("Josh") != reactor_key("Purdy")

    def test_nfc_and_nfd_forms_of_the_same_name_are_the_same_reactor(self) -> None:
        """Reviewer M1: an accented name typed (or auto-composed) as precomposed NFC
        ("é" — a single code point) versus decomposed NFD ("e" + a combining acute accent
        — two code points) looks and reads identically but was, before NFC normalization, two
        different `sender_key` values — silently splitting one reactor into two."""
        nfc = "Émilie"  # "Émilie" as a single precomposed code point
        nfd = "Émilie"  # "Émilie" as "E" + a combining acute accent (U+0301)
        assert nfc != nfd  # the raw strings really do differ
        assert reactor_key(nfc) == reactor_key(nfd)


class TestClientListMatchesServerList:
    """`admin-ui/src/server/reactions.ts` is the browser's copy of the allowlist. It has to
    say exactly what the server says, code point for code point (Architect ruling, item 2)."""

    @staticmethod
    def _client_list() -> list[str]:
        source = _TS_CONSTANTS.read_text(encoding="utf-8")
        match = re.search(r"export const REACTION_EMOJIS = \[(.*?)\] as const;", source, re.DOTALL)
        assert match is not None, "REACTION_EMOJIS declaration not found in reactions.ts"
        return re.findall(r'"([^"]*)"', match.group(1))

    def test_the_two_lists_are_identical_in_content_and_order(self) -> None:
        assert self._client_list() == list(REACTION_EMOJIS)

    def test_the_client_heart_has_its_variation_selector(self) -> None:
        assert "❤️" in self._client_list()

    def test_the_client_labels_cover_every_emoji(self) -> None:
        source = _TS_CONSTANTS.read_text(encoding="utf-8")
        labelled = re.findall(r'^\s+"([^"]+)": "[^"]+",$', source, re.MULTILINE)
        assert labelled == list(REACTION_EMOJIS)
