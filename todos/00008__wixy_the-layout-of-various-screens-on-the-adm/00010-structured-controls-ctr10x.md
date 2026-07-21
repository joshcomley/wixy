# 00010 — Structured controls: opening hours + price list

**Status: design decided, not started. PR-D (+ a SITE REPO PR for template attributes).**

Operator ask: tapping the opening hours or the price list opens a dedicated control
(structured rows) instead of a plain text box; free text stays possible ("she can
still put her own text in, just like now").

## Binding facts (from prod ca repo, read-only)

- Hours: `_global.hours` = `[{day, value, closed}×7]`, bound TWICE per item
  (`<span class="closed" data-wx-if=".closed" data-wx=".value">` + the `!.closed`
  twin) in pages/contact.html + pages/index.html (`data-wx-list="@hours"`).
- Prices: treatments page `sections[].cards[]` {meta,title,price,body,course,book}
  + `rx.items[]` {title,price,body}; index page `treatments.cards`. `.price` is a
  free-text leaf ("Complimentary", "Full Face — £330 &nbsp;·&nbsp; Three Areas — £220").

## Design (decided)

- Declarative trigger: `data-wx-control="opening-hours"` / `data-wx-control="price"`
  attributes in the SITE templates (cottage-aesthetics-preview repo — SEPARATE PR
  there). data-wx-* attrs already flow into built/preview HTML; builder needs no
  change (verify validate() doesn't reject unknown data-wx-* first!).
  Overlay reads `el.getAttribute("data-wx-control")` at click time → routes to the
  control instead of the composer. NO protocol/bindings-map change.
- Opening-hours control: 7 rows (day label fixed from item), open/closed toggle,
  from/to time selects producing `HH:MM – HH:MM`, plus per-row "custom text" mode
  (free text, e.g. "By phone enquiry"). Edits the WHOLE @hours array → one op
  (emitItemScoped path). Closed row → closed:true (value preserved).
- Price control: rows of {label, amount}; parse current text on " — £…" / "·"
  separators; unparseable → free-text mode (banner "editing as plain text").
  Commit re-serializes (`Label — £N` joined by ` · `).
- Site repo: https://github.com/joshcomley/cottage-aesthetics-preview — clone to a
  worktree under D:\Servers\Cmd\Storage\clones\, add attributes to
  pages/contact.html + index.html (hours spans) + treatments.html + index.html
  (.price elements), PR + merge; reaches prod as upstream commits (rides through
  the next publish).
- RED vitest: parsers/serializers pure logic (hours parse/serialize, price
  parse/serialize incl. unparseable fallback), control DOM smoke.

## Files

editor/src/controls/{hoursControl.ts,priceControl.ts} (new), overlay.ts
openPopoverFor routing, editor/tests/controls.test.ts, site repo templates.
