# Text bindings are markdown-source, edited through a bottom-anchored composer

## The asks (operator, 2026-07-21)

1. The inline text popover is too small for long text — replace it with a
   cmd-chat-style box: anchored to the bottom, grows as you type (cap ~5 lines /
   ~20% viewport), with a functions row and a maximize mode for detailed editing.
2. Text blocks should support Markdown: "she puts asterisks around something and
   it makes it italic".

## Decisions

**One editing surface.** The composer (`editor/src/composer.ts`) replaces BOTH
text popovers (plain input/textarea AND the rich-lite contenteditable + its
Range wrap helpers — deleted). The ca corpus is plain text with exactly two
legacy `<strong>` uses and `<br>` addresses, so one markdown-native surface
covers everything; dual popover modes would be permanent complexity for a case
that doesn't occur.

**Text values are markdown SOURCE in storage.** Subset: `**bold**`, `*italic*`,
`[label](url)` (http/https/mailto/tel/relative only — unsafe schemes render as
literal text), `\n` → `<br>`. No nesting, no emphasis inside link labels
(links process first), no block constructs. Build pipeline: sanitize FIRST
(preserves the pre-markdown "injected markup is removed" behavior), then
render. Legacy allowlist tags in source pass through verbatim (protected behind
PUA placeholders during the escape/markdown steps); entities are preserved.

**Byte-parity, Inv 20-style.** `builder/markdown_inline.py` ≡
`editor/src/markdownText.ts`, hand-ported twins locked by ONE shared fixture
(`builder/tests/fixtures/markdown-inline.json`, 23 cases) loaded by both
pytest and vitest. Markdown links emit `rel="noopener noreferrer"` because nh3's
default `link_rel` adds it at sanitize time — emitting it in the renderer keeps
the preview byte-identical to the build.

**Storage stays source-canonical.** The composer's live preview writes RENDERED
html into the element on every keystroke; item-scoped commits re-read siblings
from the DOM — so `readScalarValue` DEMOTES (rendered html → markdown) to stop
sibling fields oscillating `**x**` ↔ `<strong>x</strong>` in the store. Composer
seeds demote too (`demoteHtmlToMarkdown`), which also normalizes legacy
rich-lite content to source form on first touch. Demote shows users DECODED
text (`R&D`, not `R&amp;D`); the write-time sanitize (decisions/00074) restores
canonical entities at storage.

**Composer UX contract.** Bottom sheet inside the overlay document (no protocol
change), dark on every page theme (reads as chrome). Enter = newline (long text
is the norm — accidental commits were the bigger risk), Ctrl+Enter or ✓ commits,
Esc cancels (restores the exact pre-edit DOM). B/I/link buttons wrap the
selection in markers (link pre-selects the placeholder URL). Maximize takes
80vh. `setDevice` gained an optional `scale` (protocol, both copies) — the
composer counter-scales so it stays legible in squished viewport-simulation
modes; absent scale = 1.

**Rejected alternatives.** A composer OUTSIDE the iframe in the shell (new
protocol surface for zero user-visible gain at scale 1, the common case);
contenteditable WYSIWYG (what the rich-lite popover was — markup drift and
selection bugs for no gain over source+live-preview); a third-party markdown
library (repo convention: hand-rolled for well-scoped subsets, zero runtime
deps).

## What to watch for

- The fixture is the contract — add cases THERE, never ad-hoc to one side.
- Emphasis can span a protected legacy tag (`*a<strong>b</strong>c*` renders) —
  deliberate, fixture-documented.
- `render` is a fixed point over already-rendered output (idempotence test on
  both sides) — protect it or rebuilds drift.
- The overlay preview renders without sanitize (as before); a reload always
  reconverges to the server render.
