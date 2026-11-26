"""Regenerate the public short-code pin table after a destination bank update.

    python -m wixy_server.adventure_public.pin_codes          # append the missing destinations
    python -m wixy_server.adventure_public.pin_codes --check  # exit 1 if any is unpinned

`wixy_server/adventure_public/codes_pinned.json` maps every destination id in the shipped bank to
the short code its public link uses (`https://<host>/d/<code>`). Links are bookmarked, so a code
must never change: this command only ever APPENDS the destinations the table does not know yet
(each newcomer gets its 6-character code, lengthened by `codes.assign_codes` if that clashes with
a pinned code) and never rewrites an existing entry. Run it whenever the bank gains a destination
and commit the result; the test suite fails until you do
(`test_every_shipped_destination_is_pinned_to_the_code_it_has_today`).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from wixy_server.adventure_public.codes import PINNED_CODES_PATH, assign_codes, load_pinned_codes
from wixy_server.livechat.adventure_bank import AdventureBank, load_bank


def pin_missing(bank: AdventureBank, pinned: Mapping[str, str]) -> dict[str, str]:
    """`pinned` plus a code for every destination of `bank` it does not hold. Existing entries are
    returned exactly as they are."""
    ids = [d.id for unit in bank.units.values() for d in unit.destinations]
    codes = assign_codes(ids, pinned=pinned)
    table = dict(pinned)
    for dest_id in ids:
        if dest_id not in pinned:
            table[dest_id] = codes[dest_id]
    return table


def render(table: Mapping[str, str]) -> str:
    """The table as the file holds it: one `"id": "code"` per line, ids sorted."""
    return json.dumps(dict(sorted(table.items())), indent=1, ensure_ascii=True) + "\n"


def main(argv: Sequence[str] | None = None, *, bank: AdventureBank | None = None) -> int:
    parser = argparse.ArgumentParser(description="Append the unpinned destinations' short codes.")
    parser.add_argument("--check", action="store_true", help="change nothing; exit 1 if unpinned")
    parser.add_argument("--table", type=Path, default=PINNED_CODES_PATH, help="the pin table file")
    args = parser.parse_args(argv)
    pinned = load_pinned_codes(args.table)
    table = pin_missing(bank if bank is not None else load_bank(), pinned)
    added = len(table) - len(pinned)
    print(f"{added} destination(s) added to {args.table.name} ({len(table)} pinned in all)")
    if args.check:
        return 1 if added else 0
    if added:
        args.table.write_text(render(table), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
