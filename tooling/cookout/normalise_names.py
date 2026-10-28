#!/usr/bin/env python3
"""Normalise the Cookout source lists: sentence-case names and aliases (proper nouns keep their
capitals) and blurbs without a trailing full stop. Idempotent; ids are unaffected because they
are derived case-insensitively from the name. Run, then `build_bank.py`."""

from __future__ import annotations

from build_bank import SRC

PROPER_NOUNS = frozenset(
    {
        "Atlantic", "BBQ", "Bigod", "Bresse", "Brie", "Meaux", "Cara", "Casar", "Chavignol",
        "Cheddar", "Daniele", "San", "Delicious", "Derby", "Dory", "Edward", "King", "Fenni",
        "Fribourgeois", "Genovese", "George's", "Gloucester", "Gouda", "Guerande", "Grigio",
        "Sauvignon", "Blanc", "Noir", "Hand", "Hanout", "Henry", "Iberico", "Jack", "Kiev",
        "Kyiv", "Lancashire", "Leicester", "Lorraine", "Mowbray", "Mull", "Milano", "Moine",
        "Mont", "Northern", "Padano", "Parma", "Pearmain", "Pippin", "Provence", "Reaper",
        "Romano", "Russet", "Russian", "Marzano", "Sardo", "Savoie", "Scotch", "Serrano",
        "Sichuan", "Smith", "Stilton", "Suisse", "Toscano", "Touraine", "Wensleydale", "Yarg",
        "York", "Yorkshire", "Ximenez", "Salut", "Island", "Paradise", "Royal", "Forest", "Krim", "Prince", "Wonder", "Piper",
        "Javelin", "Majesty", "Gold", "Noor", "Lady", "Bishop", "Duke", "Orange", "Grey",
    }
)  # fmt: skip

# Names whose capitals the per-word rule cannot tell from an ordinary noun ("orange", "grey").
PHRASES = {
    "cox's orange pippin": "Cox's Orange Pippin",
    "earl grey tea": "Earl Grey tea",
    "cara cara orange": "Cara Cara orange",
    "celtic grey salt": "Celtic grey salt",
    "grey mullet": "Grey mullet",
    "black forest ham": "Black Forest ham",
    "black krim tomato": "Black Krim tomato",
    "crown prince squash": "Crown Prince squash",
    "golden wonder potato": "Golden Wonder potato",
    "maris piper potato": "Maris Piper potato",
    "pentland javelin potato": "Pentland Javelin potato",
    "purple majesty potato": "Purple Majesty potato",
    "red duke of york potato": "Red Duke of York potato",
    "yukon gold potato": "Yukon Gold potato",
    "deglet noor date": "Deglet Noor date",
    "pink lady apple": "Pink Lady apple",
    "stinking bishop": "Stinking Bishop",
}


def _word(word: str, keep: frozenset[str]) -> str:
    if word in keep or word.isupper():
        return word
    return "-".join(p if p in keep else p.lower() for p in word.split("-"))


def sentence_case(text: str, keep: frozenset[str] = PROPER_NOUNS) -> str:
    fixed = PHRASES.get(text.casefold())
    if fixed is not None:
        return fixed
    words = text.split(" ")
    return " ".join([words[0], *(_word(w, keep) for w in words[1:])])


def normalise_line(line: str) -> str:
    if not line.strip() or line.lstrip().startswith("#"):
        return line
    name, aliases, role, family, rarity, blurb = (p.strip() for p in line.split("|"))
    alias_list = [sentence_case(a.strip()) for a in aliases.split(";") if a.strip()]
    blurb = blurb.rstrip(".").rstrip()
    return " | ".join([sentence_case(name), "; ".join(alias_list), role, family, rarity, blurb])


def main() -> None:
    for path in sorted(SRC.glob("*.txt")):
        lines = path.read_text(encoding="utf-8").splitlines()
        path.write_text("\n".join(normalise_line(x) for x in lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
