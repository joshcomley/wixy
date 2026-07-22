# Q&A full-screen structured control

## Symptom / request

Operator request (2026-07-22, verbatim): "The Q&A section needs a dedicated
editor tool like the opening hours, but should be a full screen editor."

The site's FAQ page (`faq.html` in the site repo) binds `faq.items` as a list
of `{question, answer}` pairs. Editing a pair meant the plain text composer,
one field at a time, with no overview of the whole list — the same gap the
opening-hours control (decisions/00077) closed for `@hours`.

## What was decided

**A third structured control, `data-wx-control="qa"`, editing the WHOLE list
as rows in a full-screen surface.** The attribute goes on the `.question` and
`.answer` text elements in the site template (clicking either opens the
editor), following the hours control's "attribute on the text elements,
control resolves the enclosing `data-wx-list`" pattern exactly.

- **Full-screen, not a bottom sheet** (the operator's explicit ask, and the
  right shape regardless: a FAQ list is long-form content — the ca site has 8
  pairs with paragraph answers, which outgrows a sheet capped at 50vh fast).
  The surface reuses the composer's dark-shell language (`wx-composer
  wx-control-sheet` + a new `wx-control-fullscreen` class): title bar with ✓/✕
  at top, scrollable body of cards — one per pair, each a question input +
  answer textarea (rows=4, vertically resizable) + remove button, then a
  "+ Add question" button at the end.
- **The item shape is the contract**: `{question, answer}`, exactly like the
  hours control's `{day, value, closed}`. Commit emits ONE whole-array op
  targeting the outermost list key (spec/02's collection rule), with rows in
  display order. Pairs left blank in BOTH fields are dropped on commit (the
  price control's blank-row rule) so an accidentally added empty row never
  becomes an empty FAQ entry on the site.
- **Values are markdown source** — rows seed from `readListValue` (which
  demotes rendered HTML back to source, decisions/00075) and the commit writes
  source to the store; the immediate DOM reflect renders via
  `renderMarkdownInline`, identical to a composer commit. Links/formatting in
  answers (the real site has `[Book Now](#)`) round-trip.
- **DOM reflect is positional overwrite + trim/clone** (`applyQaToDom`): items
  are structurally identical, so after a middle removal each surviving item
  displays its new position's values; excess items are trimmed off the end and
  additions cloned from the first item's shape (the item toolbar's add does
  the same, decisions/00017). A committed-empty list removes all items from
  the preview; the op stores `[]` and a reload reconverges.
- **A new cover-mode visual-viewport pin** (`pinCoverToVisualViewport` in
  `visualPin.ts`): the bottom-sheet pin (decisions/00084) re-anchors
  bottom/left/width, which is meaningless for an `inset: 0` surface. The cover
  pin re-anchors top/left/width/height to the VISUAL viewport on every
  resize/scroll, so the full-screen editor still exactly covers what's visible
  when iOS opens the keyboard (layout viewport doesn't shrink there) or the
  user pinch-zoom pans. Same release-on-close contract as the sheet pin.

## Why not the alternatives

- **A maximized bottom sheet (the composer's 80vh maximize pattern,
  decisions/00079)**: the ask was explicitly a dedicated full-screen tool, and
  80vh still isn't the whole screen — the cards would scroll unnecessarily on
  desktop.
- **Shell-side (admin-ui) surface instead of overlay-side**: every other
  editor surface lives in the overlay inside the preview document; keeping the
  Q&A editor there preserves the one-architecture rule (op emission, list
  reading, DOM reflect all already exist overlay-side) and needs no new
  postMessage contract.
- **Reordering inside the control**: deliberately omitted — the existing list
  item toolbar already reorders (↑/↓) on the page; the control is for editing
  content, adding, and removing.

## What to watch for

- The site repo template must carry `data-wx-control="qa"` on the `.question`
  and `.answer` elements or clicking falls through to the plain composer (the
  ca `faq.html` gets this in its own PR).
- `readListValue` is a best-effort reconstruction (its own doc comment) — the
  same fidelity gap note applies here as to every whole-array read.
- Emptying the list entirely stores `[]`; the section then has no items to
  click (recoverable via the AI chat or by re-adding through the draft JSON —
  same constraint as deleting every item with the item toolbar).
