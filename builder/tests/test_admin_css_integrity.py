"""Static integrity scan of `admin-ui/src/style.css` (decisions/00081).

An orphaned `border: none; display: block; }` fragment once sat between two
rules. esbuild faithfully bundled it, and per CSS error recovery the browser
then parsed `.wx-drawer{...}` as the BLOCK of an invalid-selector rule and
dropped it — the entire drawer lost positioning and background, which is what
made the Review & publish view render as overlapping text (2026-07-21). No
rendering test catches this class (jsdom never applies CSS), so the source is
scanned directly: brace depth must never go negative and must return to zero,
and no rule prelude may contain `;` (legal CSS selectors never do —
declarations do).
"""

from __future__ import annotations

from pathlib import Path

CSS_PATH = Path(__file__).resolve().parents[2] / "admin-ui" / "src" / "style.css"


def _strip_comments_and_strings(css: str) -> str:
    """Comments and string contents replaced by spaces (offsets preserved) so a
    `;` or brace inside them can't trip the scan."""
    out: list[str] = []
    i = 0
    while i < len(css):
        if css.startswith("/*", i):
            end = css.find("*/", i + 2)
            stop = len(css) if end == -1 else end + 2
            out.append(" " * (stop - i))
            i = stop
            continue
        ch = css[i]
        if ch in ("'", '"'):
            j = i + 1
            while j < len(css) and css[j] != ch:
                if css[j] == "\\":
                    j += 1
                j += 1
            stop = min(j + 1, len(css))
            out.append(" " * (stop - i))
            i = stop
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def test_brace_depth_never_goes_negative_and_returns_to_zero() -> None:
    css = _strip_comments_and_strings(CSS_PATH.read_text(encoding="utf-8"))
    depth = 0
    for ch in css:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        assert depth >= 0, "more closing than opening braces (orphaned fragment?)"
    assert depth == 0, "unbalanced braces at end of file"


def test_every_rule_prelude_is_a_selector() -> None:
    css = _strip_comments_and_strings(CSS_PATH.read_text(encoding="utf-8"))
    prelude_start = 0
    for i, ch in enumerate(css):
        if ch == "{":
            prelude = css[prelude_start:i].strip()
            assert ";" not in prelude, (
                f"rule at offset {prelude_start} has a declaration-like prelude "
                f"(orphaned fragment?): {prelude[:60]!r}"
            )
        elif ch == "}":
            prelude_start = i + 1
