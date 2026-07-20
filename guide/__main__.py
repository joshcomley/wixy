"""`python -m guide [--out DIR]` — builds the guide (see `guide/build.py`'s
own docstring for what "build" means here). Kept separate from `build.py`
itself (mirrors `builder/__main__.py` + `builder/cli.py`'s own split) so
running this module never re-imports `guide.build` under two different
names (`guide.build` via the package, `__main__` via direct execution) —
a real `RuntimeWarning: found in sys.modules ... prior to execution` hit
when `build.py` doubled as both library and CLI entrypoint.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from guide.build import DEFAULT_OUT, build


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the independence-phase HTML guide.")
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help="Output directory (default: wixy_server/static/guide, what the running admin serves)",
    )
    args = parser.parse_args()
    written = build(args.out)
    print(f"Built {len(written)} chapters into {args.out}")


if __name__ == "__main__":
    main()
