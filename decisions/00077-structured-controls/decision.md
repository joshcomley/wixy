# `data-wx-control` routes text bindings to structured controls (opening hours, price list)

## The ask (operator, 2026-07-21)

"Custom controls for opening hours and the price list… when she taps on the
price list, it should bring up a custom control that makes it very easy to edit
a price list. And the same with the opening hours. She can still put her own
text in there still, just like she can now."

## Decisions

**Declarative trigger, zero engine hardcoding.** The site template marks a
binding `data-wx-control="opening-hours"` or `data-wx-control="price"`; the
attribute flows through the build untouched (unknown `data-wx-*` pass through
by construction — verified) and the overlay reads it straight off the clicked
element. No builder/bindings-map/protocol change, no engine knowledge of ca's
key names. Rejected: key-name conventions (`.price` suffix) — magic and
unextensible; bindings-map metadata — a whole extra channel for nothing the
DOM doesn't already carry.

**Opening-hours is a WHOLE-LIST sheet.** Clicking any value inside an
`@hours` list opens 7 rows (day, open/closed toggle, from/to time pickers,
per-row "custom text" toggle). Commit emits ONE op for the list key (the
existing collection rule) and reflects the flip into the preview DOM
immediately (`applyHoursToDom` — both the open and closed variant spans get
the new text and the right `data-wx-hidden`, eye toggles re-attached).
"10:00 – 19:00" parses as times (em/en dash, hyphen tolerant); anything else
("By phone enquiry") opens that row in free-text mode — the parse never
traps her in a structure that doesn't fit.

**Price is a row editor for ONE price text.** Entries parse on the middle
dot (`·`), label/amount split on the em-dash; unparseable text
("Complimentary") opens in free-text mode with an explicit "edit as rows /
plain text" toggle that re-parses live. Serialize is the house style:
`Label — £Amount` joined by nbsp·nbsp (byte-matched to the existing corpus).

**Both keep the escape hatch the operator demanded** — free text is always
one toggle away, and the underlying values remain ordinary text content
(nothing structural changes in storage).

**The ca templates were annotated in a separate site-repo PR**
(cottage-aesthetics-preview #18): hours value spans on contact+index,
`.price` on treatment cards/rx items and the index teaser cards. Fixture
(mini-site) got the same structures + a new e2e spec covering both controls
through publish.

## What to watch for

- Publish-mode builds drop the falsy `data-wx-if` variant per day, so
  published HTML carries one control attribute per day while the preview
  carries two — expected, not a diff bug.
- The price serializer normalizes separators (single spaces around `—`,
  nbsp around `·`) — first commit of an untouched-but-reformatted price
  shows a diff hunk in the review drawer; cosmetic, one-time.
- `readListValue` demotes text fields, so the hours sheet seeds from
  markdown source — a value containing literal `**` would display as `**`
  in the sheet (correct round-trip).
