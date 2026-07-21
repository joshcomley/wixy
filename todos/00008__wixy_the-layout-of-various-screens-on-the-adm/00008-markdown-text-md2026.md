# 00008 — Markdown in text bindings (builder ↔ editor parity)

**Status: design decided, not started. PR-B with 00007.**

Operator ask: "she can put asterisks around something and it makes it italic".

## Design (decided)

- Subset: `**bold**` → `<strong>`, `*italic*` → `<em>`, `[label](url)` → `<a>`,
  `\n` → `<br>`. No underscores, no nesting guarantees, no block markdown.
- Pipeline at build: value → markdown render → `sanitize_rich_lite` (unchanged,
  belt) → insert. Sanitize stays the authoritative safety net (href schemes).
- Legacy HTML in source survives: tokenize well-formed allowlist tags
  (`<strong> <em> <br> <span…> <a…>` + closers) into placeholders FIRST, escape
  the remaining text (`&` except valid entities like `&nbsp;`, `<`, `>`), apply
  markdown transforms, restore placeholders. Content corpus audit: zero `*`,
  zero `[`, only 2 `<strong>` + several `<br>` + `&nbsp;` — zero-render-drift
  for existing content.
- Parity (Inv 20 pattern): `builder/markdown_inline.py` ≡
  `editor/src/markdownText.ts` hand-ported twins + SHARED fixture JSON
  (e.g. builder/tests/fixtures/markdown-inline.json) asserted byte-identical
  from BOTH pytest and vitest.
- Preview lane: `applyValueToElement` text sets innerHTML = TS render (raw
  innerHTML today is equally unsanitized; a reload always reconverges to the
  server render — document in the decisions entry).
- Composer seeds demote rendered HTML → markdown (see 00007).
- Newline audit before landing: staged card0 body has a trailing `\n`; decide
  trim rule (plan: strip leading/trailing newlines at render; internal \n→<br>).
- decisions entry + spec/02 §5 + docs/ai update in the same PR (doc contract).
