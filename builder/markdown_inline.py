"""Markdown-inline rendering for text bindings (decisions/00075).

The small, deliberately hand-rolled inline-Markdown subset text bindings support:
`**bold**` → `<strong>`, `*italic*` → `<em>`, `[label](url)` → `<a>`, newlines →
`<br>`. Source may ALSO carry legacy rich-lite HTML — well-formed allowlist tags
(`a`/`em`/`strong`/`br`/`span`, lowercase) pass through verbatim; everything else
is text and gets escaped. Entities (`&nbsp;`, `&#163;`, …) are preserved; a bare
`&` becomes `&amp;`.

This module is ONE HALF of a hand-synced pair: `editor/src/markdownText.ts` must
produce byte-identical output for every input (Inv 20), enforced by both suites
loading `builder/tests/fixtures/markdown-inline.json`. Change one side and the
fixture goes red on the other.

Not a full Markdown implementation, by design: no nesting (`**a *b* c**` is not
special), no block constructs, no emphasis inside link labels (links are
processed first). Output feeds `sanitize_rich_lite` at build (belt), which
remains the authoritative allowlist enforcer; the renderer itself only ever
EMITS `strong`/`em`/`a[href]`/`<br>`.
"""

from __future__ import annotations

import re

# Well-formed lowercase allowlist tags pass through verbatim (the content corpus
# is nh3-normalized lowercase; uppercase tags are treated as text and escaped).
_TAG_RE = re.compile(r"</?(?:strong|em|br|span|a)(?:\s[^<>]*?)?/?>")

# A bare `&` — one NOT starting a valid entity — is escaped.
_BARE_AMP_RE = re.compile(r"&(?!(?:#\d+|#x[0-9a-fA-F]+|\w+);)")

# [label](url) — links are processed BEFORE emphasis, so labels are literal text
# (no emphasis inside them). The url may not contain whitespace or a double quote
# (it is emitted into a double-quoted attribute; the source's `&` is already in
# `&amp;` form by this step, which is the correct attribute form).
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s\"]+)\)")
_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")
_ALLOWED_SCHEMES = frozenset({"http", "https", "mailto", "tel"})

_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC_RE = re.compile(r"\*([^*]+)\*")

# Placeholder delimiters for protected legacy tags: private-use-area chars,
# never valid content, and deliberately written as escapes so both halves of the
# pair use byte-identical markers.
_OPEN = ""
_CLOSE = ""


def _escape_text(text: str) -> str:
    return _BARE_AMP_RE.sub("&amp;", text).replace("<", "&lt;").replace(">", "&gt;")


def _link_sub(match: re.Match[str]) -> str:
    label, url = match.group(1), match.group(2)
    scheme = _SCHEME_RE.match(url)
    if scheme is not None and scheme.group(1).lower() not in _ALLOWED_SCHEMES:
        return match.group(0)  # unsafe scheme — render the source literally
    # nh3's default link_rel adds rel="noopener noreferrer" to every <a> at
    # sanitize time; emitting it here keeps the editor's preview byte-identical
    # to the build's output for markdown-authored links.
    return f'<a href="{url}" rel="noopener noreferrer">{label}</a>'


def render_markdown_inline(source: str) -> str:
    """Render one text-binding source string to its rich-lite HTML form."""
    text = source.replace("\r\n", "\n").strip("\n")

    # 1. Protect legacy allowlist tags behind placeholders so the escape and
    #    markdown steps can't touch them.
    protected: list[str] = []

    def _stash(match: re.Match[str]) -> str:
        protected.append(match.group(0))
        return f"{_OPEN}{len(protected) - 1}{_CLOSE}"

    text = _TAG_RE.sub(_stash, text)

    # 2. Escape the remaining (plain-text) content.
    text = _escape_text(text)

    # 3. Markdown transforms: links, then bold, then italic (order matters —
    #    `**` must be consumed before any single-`*` pass).
    text = _LINK_RE.sub(_link_sub, text)
    text = _BOLD_RE.sub(r"<strong>\1</strong>", text)
    text = _ITALIC_RE.sub(r"<em>\1</em>", text)

    # 4. Newlines, then restore the protected tags.
    text = text.replace("\n", "<br>")
    for index, tag in enumerate(protected):
        text = text.replace(f"{_OPEN}{index}{_CLOSE}", tag)
    return text
